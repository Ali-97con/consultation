'use strict';
const { Pool } = require('pg');
const crypto   = require('crypto');

// ─── Connection (pooled, cached for serverless) ───────────────────────────────
// Use the Supabase **Transaction pooler** connection string (port 6543) in
// production/serverless. DATABASE_URL must be set or the app throws on first query.
let pool = null;
function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Supabase requires TLS
    max: 3,
    idleTimeoutMillis: 30000,
  });
  return pool;
}
const q = (text, params) => getPool().query(text, params);
const j = (v) => JSON.stringify(v);

// ─── Schema (idempotent — self-heals if the SQL-editor step was skipped) ──────
let schemaPromise = null;
async function ensureSchema() {
  await q(`
    create table if not exists clients (
      id         integer primary key,
      data       jsonb   not null,
      deleted    boolean not null default false,
      deleted_at timestamptz
    );
    create index if not exists clients_deleted_idx on clients(deleted);
    create sequence if not exists clients_id_seq start with 1000;

    create table if not exists team_members (
      id         bigserial primary key,
      type       text    not null,          -- 'closers' | 'setters'
      name       text    not null,
      deleted    boolean not null default false,
      deleted_at timestamptz
    );

    create table if not exists custom_plans (
      name  text primary key,
      price jsonb
    );

    create table if not exists users (
      username      text primary key,
      password_hash text not null,
      role          text not null default 'coach',
      created_at    text
    );

    create table if not exists sessions (
      token      text primary key,
      username   text        not null,
      role       text        not null,
      expires_at timestamptz not null
    );
    create index if not exists sessions_expires_idx on sessions(expires_at);
  `);
}
function schemaReady() { if (!schemaPromise) schemaPromise = ensureSchema(); return schemaPromise; }

// ─── Sessions (DB-backed, serverless-safe) ────────────────────────────────────
async function createSessionDB(username, role) {
  await schemaReady();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await q('insert into sessions(token, username, role, expires_at) values($1,$2,$3,$4)',
    [token, username, role, expiresAt]);
  return token;
}
async function getSessionDB(token) {
  if (!token) return null;
  await schemaReady();
  const { rows } = await q(
    'select username, role from sessions where token = $1 and expires_at > now()', [token]);
  return rows[0] || null;
}
async function deleteSessionDB(token) {
  if (!token) return;
  await schemaReady();
  await q('delete from sessions where token = $1', [token]);
}

// ─── Password hashing (PBKDF2-SHA256) ─────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const parts = (stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  try {
    const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
    if (derived.length !== hash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ─── Users ────────────────────────────────────────────────────────────────────
let usersPromise = null;
async function ensureUsers() {
  await schemaReady();
  const { rows } = await q('select count(*)::int as n from users');
  if (rows[0].n === 0) {
    const defaults = [
      { username: (process.env.LOGIN_USER  || 'admin').toLowerCase().trim(),  password: process.env.LOGIN_PASS  || 'password',  role: 'admin' },
      { username: (process.env.COACH1_USER || 'coach1').toLowerCase().trim(), password: process.env.COACH1_PASS || 'abusharbi', role: 'coach' },
      { username: (process.env.COACH2_USER || 'coach2').toLowerCase().trim(), password: process.env.COACH2_PASS || 'taha',      role: 'coach' },
    ];
    for (const u of defaults) {
      await q('insert into users(username, password_hash, role, created_at) values($1,$2,$3,$4) on conflict (username) do nothing',
        [u.username, hashPassword(u.password), u.role, new Date().toISOString()]);
    }
    console.log('✅ Seeded initial users');
  }
}
function usersReady() { if (!usersPromise) usersPromise = ensureUsers(); return usersPromise; }

const findUserByUsername = async (username) => {
  await usersReady();
  const { rows } = await q(
    'select username, password_hash, role, created_at from users where username = $1',
    [String(username).toLowerCase().trim()]);
  if (!rows[0]) return null;
  return { username: rows[0].username, passwordHash: rows[0].password_hash, role: rows[0].role, createdAt: rows[0].created_at };
};

const getUsers = async () => {
  await usersReady();
  const { rows } = await q('select username, role, created_at from users order by created_at');
  return rows.map(r => ({ username: r.username, role: r.role, createdAt: r.created_at }));
};

const createUser = async (username, password, role) => {
  await usersReady();
  const u = String(username).toLowerCase().trim();
  const { rows } = await q('select 1 from users where username = $1', [u]);
  if (rows.length) return false;
  await q('insert into users(username, password_hash, role, created_at) values($1,$2,$3,$4)',
    [u, hashPassword(password), role, new Date().toISOString()]);
  return true;
};

const updateUser = async (username, { password, role }) => {
  await usersReady();
  const sets = [], vals = [];
  if (password) { vals.push(hashPassword(password)); sets.push(`password_hash = $${vals.length}`); }
  if (role)     { vals.push(role);                   sets.push(`role = $${vals.length}`); }
  if (!sets.length) return false;
  vals.push(String(username).toLowerCase().trim());
  const r = await q(`update users set ${sets.join(', ')} where username = $${vals.length}`, vals);
  return r.rowCount > 0;
};

const deleteUser = async (username) => {
  await usersReady();
  const r = await q('delete from users where username = $1', [String(username).toLowerCase().trim()]);
  return r.rowCount > 0;
};

// ─── Init / Seed (runs once if the clients table is empty) ────────────────────
let initPromise = null;
async function ensureInit() {
  await schemaReady();
  const { rows } = await q('select count(*)::int as n from clients');
  if (rows[0].n === 0) {
    await q(`insert into clients(id, data, deleted, deleted_at)
             select (c->>'id')::int, c, coalesce((c->>'deleted')::boolean, false), null
             from jsonb_array_elements($1::jsonb) c`, [j(SEED_CLIENTS.map(mkC))]);
    await q(`insert into team_members(type, name) select 'closers', n from unnest($1::text[]) n`, [SEED_CLOSERS]);
    await q(`insert into team_members(type, name) select 'setters', n from unnest($1::text[]) n`, [SEED_SETTERS]);
    await q(`select setval('clients_id_seq', 1000, false)`);
    console.log('✅ Seeded initial data');
  }
}
function ready() { if (!initPromise) initPromise = ensureInit(); return initPromise; }

// ─── Client helpers ───────────────────────────────────────────────────────────
const getClients = async () => {
  await ready();
  const { rows } = await q('select data from clients where deleted = false order by id');
  return rows.map(r => r.data);
};

const getTrash = async () => {
  await ready();
  const { rows } = await q('select data from clients where deleted = true order by deleted_at desc nulls last');
  return rows.map(r => r.data);
};

async function createClient(c) {
  await ready();
  const { rows } = await q(`select nextval('clients_id_seq') as id`);
  const id = Number(rows[0].id);
  const client = { ...c, id, deleted: false, deletedAt: null };
  await q('insert into clients(id, data, deleted, deleted_at) values($1,$2,false,null)', [id, j(client)]);
  return client;
}

async function updateClient(id, patch) {
  await ready();
  const { rows } = await q('select data from clients where id = $1', [id]);
  if (!rows.length) return null;
  const { notes, ...safePatch } = patch;          // never overwrite notes via this path
  const updated = { ...rows[0].data, ...safePatch, id };
  await q('update clients set data = $2 where id = $1', [id, j(updated)]);
  return updated;
}

async function updateNotes(id, notes) {
  await ready();
  const r = await q(`update clients set data = jsonb_set(data, '{notes}', $2::jsonb) where id = $1`,
    [id, j(notes)]);
  return r.rowCount > 0;
}

async function softDelete(id) {
  await ready();
  const { rows } = await q('select data from clients where id = $1 and deleted = false', [id]);
  if (!rows.length) return false;
  const deletedAt = new Date().toISOString();
  const data = { ...rows[0].data, deleted: true, deletedAt };
  await q('update clients set data = $2, deleted = true, deleted_at = $3 where id = $1', [id, j(data), deletedAt]);
  return true;
}

async function restoreClient(id) {
  await ready();
  const { rows } = await q('select data from clients where id = $1 and deleted = true', [id]);
  if (!rows.length) return false;
  const data = { ...rows[0].data, deleted: false, deletedAt: null };
  await q('update clients set data = $2, deleted = false, deleted_at = null where id = $1', [id, j(data)]);
  return true;
}

async function restoreAll() {
  await ready();
  await q(`update clients
           set deleted = false, deleted_at = null,
               data = jsonb_set(jsonb_set(data, '{deleted}', 'false'), '{deletedAt}', 'null')
           where deleted = true`);
}

async function permDelete(id) {
  await ready();
  await q('delete from clients where id = $1 and deleted = true', [id]);
  return true;
}

async function emptyTrash() {
  await ready();
  await q('delete from clients where deleted = true');
}

// ─── Team helpers ─────────────────────────────────────────────────────────────
const getTeam = async () => {
  await ready();
  const { rows } = await q('select type, name from team_members where deleted = false order by id');
  return {
    closers: rows.filter(r => r.type === 'closers').map(r => r.name),
    setters: rows.filter(r => r.type === 'setters').map(r => r.name),
  };
};

async function addMember(type, name) {
  await ready();
  const { rows } = await q('select 1 from team_members where type = $1 and name = $2 and deleted = false', [type, name]);
  if (rows.length) return false;
  await q('insert into team_members(type, name) values($1,$2)', [type, name]);
  return true;
}

async function editMember(type, oldName, newName) {
  await ready();
  const r = await q('update team_members set name = $3 where type = $1 and name = $2 and deleted = false', [type, oldName, newName]);
  return r.rowCount > 0;
}

async function removeMember(type, name) {
  await ready();
  const r = await q('update team_members set deleted = true, deleted_at = now() where type = $1 and name = $2 and deleted = false', [type, name]);
  return r.rowCount > 0;
}

const getTeamTrash = async () => {
  await ready();
  const { rows } = await q('select type, name, deleted_at from team_members where deleted = true order by deleted_at desc');
  return rows.map(r => ({ type: r.type, name: r.name, deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null }));
};

async function restoreTeamMember(type, name) {
  await ready();
  // mimic $addToSet: drop any active duplicate, then reactivate the trashed row
  await q('delete from team_members where type = $1 and name = $2 and deleted = false', [type, name]);
  await q('update team_members set deleted = false, deleted_at = null where type = $1 and name = $2 and deleted = true', [type, name]);
  return true;
}

async function permDeleteTeamMember(type, name) {
  await ready();
  await q('delete from team_members where type = $1 and name = $2 and deleted = true', [type, name]);
  return true;
}

async function emptyTeamTrash() {
  await ready();
  await q('delete from team_members where deleted = true');
}

// ─── Plan helpers ─────────────────────────────────────────────────────────────
const getCustomPlans = async () => {
  await ready();
  const { rows } = await q('select name, price from custom_plans order by name');
  return rows.map(r => ({ name: r.name, price: r.price }));
};

async function addCustomPlan(name, price) {
  await ready();
  const { rows } = await q('select 1 from custom_plans where name = $1', [name]);
  if (rows.length) return false;
  await q('insert into custom_plans(name, price) values($1, $2::jsonb)', [name, j(price ?? null)]);
  return true;
}

// ─── Bulk import (used by migration + /api/migrate-import) ─────────────────────
async function importData(data) {
  await schemaReady();
  await q('truncate clients, team_members, custom_plans');   // leaves users + sessions intact
  const clients = data.clients || [];
  if (clients.length) {
    await q(`insert into clients(id, data, deleted, deleted_at)
             select (c->>'id')::int, c, coalesce((c->>'deleted')::boolean, false),
                    nullif(c->>'deletedAt', '')::timestamptz
             from jsonb_array_elements($1::jsonb) c`, [j(clients)]);
  }
  if ((data.closers || []).length)
    await q(`insert into team_members(type, name) select 'closers', n from unnest($1::text[]) n`, [data.closers]);
  if ((data.setters || []).length)
    await q(`insert into team_members(type, name) select 'setters', n from unnest($1::text[]) n`, [data.setters]);
  if ((data.team_trash || []).length)
    await q(`insert into team_members(type, name, deleted, deleted_at)
             select t->>'type', t->>'name', true, nullif(t->>'deletedAt', '')::timestamptz
             from jsonb_array_elements($1::jsonb) t`, [j(data.team_trash)]);
  if ((data.custom_plans || []).length)
    await q(`insert into custom_plans(name, price)
             select p->>'name', p->'price'
             from jsonb_array_elements($1::jsonb) p on conflict (name) do nothing`, [j(data.custom_plans)]);
  await q(`select setval('clients_id_seq', $1, false)`, [data._nextId || 1000]);
  initPromise = null; // reset so the next request sees the imported data
}

// ─── Seed data ────────────────────────────────────────────────────────────────
function mkC([id, name, phone, email, plan, ct, pm, p1, p2, p3, p4, cls, str, rm, status]) {
  const pyrs = [p1, p2, p3, p4].filter(v => v > 0);
  const [pa, pb, pc, pd] = [pyrs[0]||0, pyrs[1]||0, pyrs[2]||0, pyrs[3]||0];
  const n  = pyrs.length || 1;
  const pt = ['دفعة واحدة', 'قسطين', '3 أقساط', '4 أقساط'][n - 1];
  const dt = v => v > 0 ? rm + '-15' : '';
  return {
    id, name, phone, email, status, plan,
    customTotal: ct || 0, discountType: 'none', discountValue: 0, discountAmount: 0,
    paymentType: pt, payMethod: pm || 'Zina',
    p1: pa, p1d: dt(pa), p2: pb, p2d: dt(pb), p3: pc, p3d: dt(pc), p4: pd, p4d: dt(pd),
    closer: cls, setter: str, regDate: rm + '-01', lastPayDate: pa > 0 ? rm + '-15' : '',
    notes: [], ci: (id - 1) % 10, deleted: false, deletedAt: null
  };
}

const SEED_CLOSERS = ['عبدالإله','غانم','يوسف','حميد','خليل','يونس','عبدرحمن','عمار','تحرير'];
const SEED_SETTERS = ['مصطفى','يوسف','يونس','غانم','حميد','خليل','عبدالإله','عبدرحمن','عمار','اسامة','سفيان','تحرير'];
const SEED_CLIENTS = [
[1,'Saleh','966 54 224 9620','salehmoosa@hotmail.com','CORE',2000,'Zina',1500,500,0,0,'يوسف','يوسف','2025-11','active'],
[2,'عزة النقبي','971 50 827 6778','','CORE',0,'تحويل بنكي',2500,0,0,0,'عبدالإله','عبدالإله','2025-11','active'],
[3,'ديمة','965 9983 9393','deemahaladsani@gmail.com','CORE',0,'تحويل بنكي',1500,500,500,0,'عبدالإله','عبدالإله','2025-11','active'],
[4,'Jonom','971 55 636 6551','uaeu2000j@gmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2025-11','active'],
[5,'Ahmed Nalouti','971 50 645 0774','a.nalouti@gmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2025-11','active'],
[6,'Basil','966 54 330 9361','basil.aljafar@gmail.com','CORE',0,'USDT',1000,1000,500,0,'عبدالإله','عبدالإله','2025-11','active'],
[7,'أسامه','33 6 69 30 57 39','ouss.rezgui@gmail.com','CORE',0,'PayPal',1500,1000,0,0,'عبدالإله','عبدالإله','2025-11','active'],
[8,'Maryam','971 50 522 8118','m.alhantoobi@yahoo.com','CORE',0,'تحويل بنكي',2500,0,0,0,'عبدالإله','عبدالإله','2025-11','active'],
[9,'محمد سعيد البدواوي','971 54 312 2123','pmwxi24@gmail.com','CORE',0,'Zina',1000,1000,500,0,'عبدالإله','عبدالإله','2025-11','active'],
[10,'Hessah Alkandari','965 9955 5884','purewitch87@gmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2025-11','active'],
[11,'شيخه','971 50 506 3680','ayoonalamal@hotmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2025-11','active'],
[12,'محمد','971 50 213 0217','al10ain2012@hotmail.com','CORE',0,'Zina',1000,700,800,0,'عبدالإله','عبدالإله','2025-11','active'],
[13,'Yahya','968 9722 0797','yahyaalzaabi98@gmail.com','CORE',0,'Zina',2527,0,0,0,'غانم','غانم','2025-11','active'],
[14,'أماني راشد','965 555 54255','amanilaw@yahoo.com','CORE',0,'تحويل بنكي',2500,0,0,0,'غانم','غانم','2025-11','active'],
[15,'حليمة و جاسم','971 50 883 3933','','CORE',0,'Zina',2500,0,0,0,'غانم','غانم','2025-11','active'],
[16,'Marwa','971 56 914 4448','marwaalbadi19@gmail.com','CORE',0,'Zina',2500,0,0,0,'غانم','غانم','2025-11','active'],
[17,'Linir Hasuna','972 50-900-1502','linir@hasuna-adv.com','CORE',0,'Zina',2528,0,0,0,'غانم','غانم','2025-11','active'],
[18,'Fatima Ficociello','966 54 981 0100','f.ficociello@gmail.com','CORE',0,'Zina',2528,0,0,0,'غانم','غانم','2025-11','active'],
[19,'راشد خميس','971 50 740 0472','','CORE',0,'Zina',2500,0,0,0,'غانم','غانم','2025-11','active'],
[20,'Riyad','972 50-474-4405','riyadshlata@gmail.com','CORE',0,'Zina',1500,1000,0,0,'غانم','غانم','2025-11','active'],
[21,'ايمان','966 50 041 2100','amooon0504@gmail.com','CORE',0,'Zina',2528,0,0,0,'غانم','غانم','2025-11','active'],
[22,'محي الدين عثمان','966 53 431 9808','dr.moom84@gmail.com','CORE',0,'Zina',500,0,0,0,'غانم','غانم','2025-11','active'],
[23,'Mohammed Alkhodari','968 9891 6303','hbk-2000-2001@hotmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2025-12','active'],
[24,'مأمون','971 55 261 4600','mamoun.radii@gmail.com','CORE',0,'Zina',2500,0,0,0,'غانم','غانم','2025-12','active'],
[25,'تركي البوسعيدي','968 9533 5454','turkialbusaidi96@outlook.com','CORE+',0,'Zina',1000,1000,500,0,'غانم','غانم','2025-12','active'],
[26,'Mohammed','968 7112 6097','u094022@gmail.com','CORE',0,'Zina',2500,0,0,0,'غانم','غانم','2025-12','active'],
[27,'هاجر حسين ابوكربل','974 5000 3355','h52664539@gmail.com','CORE',0,'Zina',2500,0,0,0,'غانم','غانم','2025-12','active'],
[28,'maher','49 1515 4661938','maherscheicho@gmail.com','CORE',0,'PayPal',500,1000,1000,0,'حميد','مصطفى','2025-12','active'],
[29,'Sara Almansoori','971 55 553 1055','saraalmansoori395@gmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2025-12','active'],
[30,'Muna Lingawi','971-5-694-18040','muna.lingawi@hotmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2025-12','active'],
[31,'مشعل ال علي','971-5-688-32866','mishal.uae@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'غانم','مصطفى','2025-12','active'],
[32,'نورا مهنا','966 50 770 1506','noramuhana@gmail.com','CORE+',0,'Zina',3000,0,0,0,'غانم','غانم','2025-12','active'],
[33,'Abdullah Alsamahi','971 58 333 3633','abbdduull050@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2025-12','active'],
[34,'Abdal razaq','31 6 18833431','almor.uk@outlook.com','CORE+',0,'Zina',500,500,700,800,'عبدالإله','مصطفى','2025-12','active'],
[35,'امنه المزروعي','971 50 307 0794','amna.almazrouei2020@hotmail.com','CORE+',0,'Zina',1500,1500,0,0,'غانم','غانم','2025-12','active'],
[36,'Tamadher','971 50 552 4449','tamadher.ali@gmail.com','CORE+',0,'Zina',1500,1500,0,0,'عبدالإله','مصطفى','2025-12','active'],
[37,'Abdurahman Alnahdi','971 50 248 8153','a.f.alnahdi@hotmail.com','CORE+',0,'تحويل بنكي',1361,400,400,816,'حميد','سفيان','2025-12','active'],
[38,'Ali Hamdan','971 50 733 1339','alireda.hamdan@hotmail.com','CORE+',0,'Zina',1000,1000,1000,0,'عبدالإله','مصطفى','2025-12','active'],
[39,'ساره الكندي','971 50 700 8072','alkendisara@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'غانم','مصطفى','2026-01','active'],
[40,'فيصل سرور خميس','971 50 433 5994','faisal.alz33abi@gmail.com','PREMIUM',5000,'Zina',4000,1000,0,0,'يوسف','يوسف','2026-01','active'],
[41,'Mohammed Hashim','971 50 572 9313','malanbari@gmail.com','INNER CIRCLE',0,'تحويل بنكي',7000,0,0,0,'يوسف','مصطفى','2026-01','active'],
[42,'ahmed alhebshi','971 55 422 4248','','CORE+',0,'Zina',1500,0,0,0,'يوسف','اسامة','2026-01','paused'],
[43,'Rania abubshait','971 50 289 4411','abubshaitr@gmail.com','INNER CIRCLE',0,'Zina',7000,0,0,0,'غانم','يونس','2026-01','active'],
[44,'الريم أحمد','971 56 818 9464','ralmutawa3007@gmail.com','INNER CIRCLE',0,'تحويل بنكي',3500,3500,0,0,'حميد','يونس','2026-01','active'],
[45,'شما الحمودي','971 56 855 3606','shamma.m.alhmoudi@gmail.com','INNER CIRCLE',0,'Zina',4000,3000,0,0,'عبدالإله','مصطفى','2026-01','active'],
[46,'نورة','971 50 118 2558','noura.1983.35@gmail.com','CORE+',0,'Zina',3000,0,0,0,'يوسف','مصطفى','2026-01','active'],
[47,'Muneerah','966 54 040 5122','mmm_44441@hotmail.com','CORE+',0,'Zina',1000,1000,0,0,'عبدالإله','مصطفى','2026-01','paused'],
[48,'Rehab','966 53 673 8837','taliiaa4321@hotmail.com','CORE',0,'Zina',1000,1000,500,0,'عبدالإله','مصطفى','2026-01','active'],
[49,'Maitha','971 52 229 1559','maitha.9525@gmail.com','CORE+',0,'Zina',3000,0,0,0,'يوسف','مصطفى','2026-01','active'],
[50,'mohammed el mallouki','31 6 20862085','melmallouki@gmail.com','CORE+',0,'Zina',1768,1264,0,0,'حميد','مصطفى','2026-01','active'],
[51,'Shaikha Salem','971 50 161 1693','ssoshaikha@gmail.com','CORE+',0,'تحويل بنكي',1000,1000,1000,0,'حميد','حميد','2026-01','churned'],
[52,'عبير الحامد','971 50 923 8886','abeeralhamed9238@gmail.com','CORE+',0,'Zina',1000,0,0,0,'يوسف','مصطفى','2026-01','active'],
[53,'Hamda Almahri','971 50 898 6099','hamda.almahri@hotmail.com','CORE+',0,'Zina',3000,0,0,0,'يوسف','يونس','2026-01','active'],
[54,'Shaikha Al shkeili','971 50 759 6099','','CORE+',0,'Zina',1000,1000,0,0,'حميد','مصطفى','2026-01','churned'],
[55,'Alreem','971 56 783 9797','alreemas998@gmail.com','INNER CIRCLE',0,'Zina',7000,0,0,0,'غانم','غانم','2026-01','active'],
[56,'Rabab Ahmed','973 3755 2695','rabab_aamh@yahoo.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','مصطفى','2026-01','active'],
[57,'حارث علي','971 56 119 9130','harethalialali@gmail.com','PREMIUM',5000,'Zina',1250,1250,2500,0,'غانم','مصطفى','2026-01','active'],
[58,'Karim','971 54 544 8195','destinotshirt@gmail.com','CORE+',0,'تحويل بنكي',1000,0,0,0,'غانم','مصطفى','2026-01','paused'],
[59,'Sayed Mohamed Baqer Adnan','973 3340 7786','sayedmohammedadnanbiz@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'عبدالإله','مصطفى','2026-01','active'],
[60,'Saeed Alketbi','971 50 888 3001','dark12821@outlook.com','CORE+',0,'Zina',1000,1000,1000,0,'حميد','حميد','2026-01','active'],
[61,'rawad sawaed','972 50-720-8893','rsawaed82@gmail.com','CORE+',0,'Zina',1000,1000,0,0,'حميد','مصطفى','2026-01','paused'],
[62,'عبدالله','971 58 195 2008','','INNER CIRCLE',0,'Zina',1750,1750,1750,1750,'غانم','يوسف','2026-01','active'],
[63,'أحمد مطر','972 59-890-6699','amattar56@gmail.com','CORE+',0,'PayPal',2000,0,0,0,'غانم','مصطفى','2026-01','active'],
[64,'Hamad','971 50 678 5222','hamaddamill@gmail.com','CORE+',0,'تحويل بنكي',2000,0,0,0,'يوسف','مصطفى','2026-01','active'],
[65,'محمد السليطي','974 5529 2926','sulaiti10@my.com','INNER CIRCLE',0,'Zina',1400,1400,0,0,'غانم','مصطفى','2026-01','paused'],
[66,'Muneera','971 50 791 5565','','CORE+',0,'تحويل بنكي',3000,0,0,0,'عبدالإله','مصطفى','2026-01','active'],
[67,'salman','971 50 969 3959','salman91saeed@gmail.com','INNER CIRCLE',0,'Zina',7000,0,0,0,'غانم','مصطفى','2026-01','active'],
[68,'Wafa Al Ali','971 50 165 5586','alali.wafa84@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'غانم','مصطفى','2026-01','active'],
[69,'Hanadi','1 908-922-6017','assadhanady@gmail.com','CORE+',2500,'تحويل بنكي',1000,1500,0,0,'عبدالإله','يوسف','2026-01','active'],
[70,'Ali Almajid','974 3330 4411','ali.almajid89@gmail.com','CORE+',0,'Zina',1050,900,1050,0,'حميد','حميد','2026-01','active'],
[71,'Mohammed Almarzooqi','971 50 932 9445','','CORE',0,'',0,0,0,0,'غانم','غانم','2026-01','lead'],
[72,'محمد المومني','962 7 7755 9614','mohammad.w.momani@gmail.com','CORE+',0,'Zina',500,500,0,0,'حميد','حميد','2026-01','active'],
[73,'Mohammed Bennis','212 648-407123','mohammed.bennis321@gmail.com','CORE+',0,'Zina',1000,500,1500,0,'حميد','حميد','2026-01','active'],
[74,'Zayed','971 54 462 5155','zay333m@gmail.com','CORE+',0,'Zina',1000,0,0,0,'حميد','حميد','2026-01','paused'],
[75,'Marwa Saidi','31 6 87339906','marwoua.saidi@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'حميد','مصطفى','2026-01','active'],
[76,'Mohamed_Elbane','1 (929) 553-4870','medlbane94@gmail.com','CORE+',0,'Stripe',1000,1000,1000,0,'غانم','اسامة','2026-01','active'],
[77,'سعود بن خادم','971 50 200 2255','sbk@ssquared.ae','CORE+',0,'Zina',1000,1000,1000,0,'عبدالإله','يونس','2026-01','active'],
[78,'mohamed elgaapry','31 6 48802958','mohamedelgapry1111@icloud.com','CORE+',0,'Stripe',3000,0,0,0,'خليل','خليل','2026-01','active'],
[79,'يوسف محمد سالم','971 50 771 1032','uaef7@hotmail.com','CORE+',0,'Zina',1000,1000,1000,0,'عبدالإله','خليل','2026-01','active'],
[80,'Aaesha Almansoori','971 50 177 1987','aisha.e.almansoori@hotmail.com','CORE+',0,'Zina',1000,1000,1000,0,'غانم','يونس','2026-01','active'],
[81,'Fatnassi Mohamed Taha','216 23 685 379','fatnassi.medtaha@hotmail.fr','CORE+',0,'Zina',1000,1000,1000,0,'حميد','يونس','2026-01','active'],
[82,'sultan','971 50 665 5642','fazzaa.s2@gmail.com','CORE+',0,'تحويل بنكي',1500,1500,0,0,'حميد','يونس','2026-01','active'],
[83,'Gamal','1 559-972-6663','ga3971998@gmail.com','CORE+',0,'Stripe',1000,0,0,0,'غانم','خليل','2026-01','churned'],
[84,'أمير','972 52-232-7451','abughribaamer@gmail.com','CORE+',0,'Zina',1000,0,0,0,'يوسف','يونس','2026-01','churned'],
[85,'Essa Alyassi','971 55 866 6097','1.3was000@gmail.com','PREMIUM',5000,'Zina',5000,0,0,0,'حميد','مصطفى','2026-02','active'],
[86,'Fares Alhuwait','971 56 109 4500','faresalhuwait@gmail.com','CORE+',0,'Zina',1250,1250,500,0,'غانم','خليل','2026-02','active'],
[87,'Afra Aldhaheri','971 55 832 2029','af.dhaheri@gmail.com','PREMIUM',5000,'Zina',5000,0,0,0,'عبدالإله','يونس','2026-02','active'],
[88,'may مي','971 50 433 3213','may.binhussain@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'عبدالإله','خليل','2026-02','active'],
[89,'موزة الكلباني','968 9988 9532','moza113said@gmail.com','PREMIUM',5000,'Zina',2500,2500,0,0,'حميد','يوسف','2026-02','active'],
[90,'راكان','7 916 067-77-67','rakan_deya@icloud.com','CORE+',0,'USDT',3000,0,0,0,'حميد','مصطفى','2026-02','active'],
[91,'Ahmed Sayed','973 3928 6434','tgm0q0@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','مصطفى','2026-02','active'],
[92,'Abdalla Alhammadi','971 50 151 0007','abdalla.aa7@gmail.com','CORE+',0,'Zina',700,300,1000,1000,'غانم','غانم','2026-02','active'],
[93,'Mohammed mahmoud','962 7 9695 1140','mohammedmahmoud.mm.2002@gmail.com','CORE',2000,'Zina',2000,0,0,0,'عبدالإله','خليل','2026-02','active'],
[94,'Rashed','971 58 991 9911','rasxid.7@gmail.com','CORE+',0,'Zina',3000,0,0,0,'يوسف','يونس','2026-02','active'],
[95,'Mariam Alketbi','971 50 337 7366','maryamuae2011@hotmail.com','CORE+',0,'Zina',1000,1000,0,0,'يوسف','يوسف','2026-02','active'],
[96,'عزان الشنفري','968 9855 0023','azzan3135@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','خليل','2026-02','active'],
[97,'Obaid Alnaqbi','971 50 611 8191','emarate2000@hotmail.com','CORE+',0,'Zina',3000,0,0,0,'غانم','مصطفى','2026-02','active'],
[98,'Samer hasan','90 552 564 30 27','samerhasan825@gmail.com','CORE+',0,'Zina',3000,0,0,0,'حميد','يونس','2026-02','active'],
[99,'سلطان الظاهري','971 50 246 8444','sultan.aldhahery@gmail.com','INNER CIRCLE',0,'Zina',1750,1750,0,0,'غانم','غانم','2026-02','active'],
[100,'Thamna Alameri','971 50 593 3774','thamna.balhalous@aam.gov.ae','CORE+',0,'Zina',2000,1000,0,0,'حميد','خليل','2026-02','active'],
[101,'Maryam ali','971 50 538 3355','alzaabi757@hotmail.com','CORE+',0,'Zina',1500,1500,0,0,'عبدالإله','مصطفى','2026-02','active'],
[102,'فوزية الجنيبي','971 50 643 2624','goldenfish66@hotmail.com','INNER CIRCLE',0,'Zina',7000,0,0,0,'يوسف','يونس','2026-02','active'],
[103,'Omar alhammadi','49 1512 1100055','grnnas@gmail.com','CORE+',0,'Zina',3000,0,0,0,'غانم','يونس','2026-02','active'],
[104,'خالد زمزم','44 7774 428306','zamzom.khaled@gmail.com','CORE+',0,'Zina',3000,0,0,0,'حميد','يونس','2026-02','active'],
[105,'Doaa Elsayed','974 5531 3648','doaa.elsayed111@gmail.com','CORE+',0,'Zina',1000,1000,0,0,'غانم','يونس','2026-02','active'],
[106,'Bashar Saeed','971 56 543 4768','bashar.saeed88@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','يونس','2026-02','paused'],
[107,'خليفه احمد','971 52 317 7794','khalifaalnuaimi1000@yahoo.com','CORE+',0,'Zina',3000,0,0,0,'غانم','يونس','2026-02','active'],
[108,'Haifa Almalki','974 6695 3977','haeefa.almalki@hotmail.com','INNER CIRCLE',0,'Zina',3000,2000,2000,0,'حميد','خليل','2026-02','active'],
[109,'عصام ابراهيم','971 50 641 1400','ealawar@gmail.com','CORE+',0,'Zina',1000,0,0,0,'يوسف','يونس','2026-02','active'],
[110,'بدر خالد العمودي','971 50 200 5551','bader.alamoudi@gmail.com','CORE',2000,'Zina',2000,0,0,0,'عبدالإله','يونس','2026-02','active'],
[111,'سلطان الجابري','971 56 845 9402','sultan3alain@gmai.com','CORE+',0,'Zina',1500,1500,0,0,'عبدالإله','يونس','2026-02','active'],
[112,'احمد الحوسني','971 50 320 2001','ahmed39653@gmail.com','INNER CIRCLE',0,'تحويل بنكي',7000,0,0,0,'عبدالإله','خليل','2026-02','active'],
[113,'معتز البلوشي','968 9505 0258','miizkhalid2016@gmail.com','CORE+',0,'Zina',3000,0,0,0,'حميد','يونس','2026-02','active'],
[114,'Hamdi','32 465 27 49 92','tarhounihamdi82@gmail.com','CORE+',0,'Zina',1500,0,0,0,'حميد','خليل','2026-02','churned'],
[115,'فاطمة عبدالله راشد','971 50 366 0880','f.sep82@gmail.com','CORE',2000,'Zina',2000,0,0,0,'عبدالإله','يونس','2026-02','active'],
[116,'Asmaa','965 506 20571','asm2ii1alsaho@gmail.com','CORE+',0,'Zina',2500,500,0,0,'عبدالإله','يونس','2026-02','active'],
[117,'aisha.a.alkhouri','971 50 244 4755','aisha.a.alkhouri@gmail.com','CORE+',0,'Zina',3000,0,0,0,'غانم','يونس','2026-02','active'],
[118,'Rana','971 50 446 5280','rsshihab1357@gmail.com','CORE+',0,'Zina',3000,0,0,0,'غانم','خليل','2026-02','active'],
[119,'Khalid Buhabil','971 55 340 6655','khalidbuhabil@gmail.com','CORE+',0,'Zina',3000,0,0,0,'غانم','يونس','2026-02','active'],
[120,'Mansour Almeer','971 50 311 6066','almeer.mansour@gmail.com','CORE+',0,'تحويل بنكي',1500,1500,0,0,'حميد','مصطفى','2026-02','active'],
[121,'يسري','971 50 555 3931','yusrialdajani@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','خليل','2026-03','active'],
[122,'Mohammed zaher Sawas','49 1575 9015194','dr.mohammed.zaher.sawas@outlook.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[123,'خالد المحرمي','971 50 339 9921','khalid94saeed@gmail.com','CORE+',0,'تحويل بنكي',3000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[124,'عبدالرحمن البلوشي','968 9901 3994','abdu21260@gmail.com','CORE+',0,'USDT',1500,0,0,0,'حميد','حميد','2026-03','active'],
[125,'ناصر بن عامر الجابري','968 9297 7222','njabri2@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'حميد','حميد','2026-03','active'],
[126,'Fatima saeed','971 56 432 7387','aad9392@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'عبدالإله','عبدالإله','2026-03','active'],
[127,'هاجر النهدي','971 50 111 6773','hjor1993@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[128,'Manal Alnuami','971 56 737 3297','malnuaimi.m99@gmail.com','CORE+',0,'تحويل بنكي',1500,1500,0,0,'حميد','حميد','2026-03','active'],
[129,'عبدالرحمن الاهدل','971 50 936 3434','ar.alahdali@gmail.com','CORE+',0,'تحويل بنكي',1500,1500,0,0,'حميد','حميد','2026-03','active'],
[130,'Menwah','971 58 283 9010','menwa154@gmail.com','CORE+',0,'Zina',1000,1000,1000,0,'خليل','خليل','2026-03','active'],
[131,'Mohamed Mohsen Al Amoodi','971 50 771 0072','mohamed.alamoodi@hotmail.com','CORE+',0,'Zina',3000,0,0,0,'خليل','خليل','2026-03','active'],
[132,'Masoud','971 50 762 3225','m-3d@live.com','CORE',1000,'Zina',1000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[133,'ياسر الحديثي','966 53 831 3637','yassersi.alleth@gmail.com','CORE+',0,'',1500,1500,0,0,'غانم','يونس','2026-03','active'],
[134,'روضه','971 54 231 2233','xsrsvr@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[135,'Hamda alfalasi','971 50 340 3413','ihamddda@gmail.com','INNER CIRCLE',0,'Zina',7000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[136,'مهدي','972 54-827-7482','talebmagdob123456@gmail.com','CORE',2000,'Zina',2000,0,0,0,'يونس','يونس','2026-03','active'],
[137,'باسل','965 6566 5598','basil-dashti@hotmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[138,'mohammed hormodi','44 7448 230746','','INNER CIRCLE',0,'Zina',7000,0,0,0,'يونس','يونس','2026-03','active'],
[139,'الحسن','971 50 106 5672','alhasanbusiness1996@gmail.com','CORE+',0,'تحويل بنكي',3000,0,0,0,'خليل','خليل','2026-03','active'],
[140,'عبدالعزيز','971 55 233 6663','azizalajjal1@gmail.com','CORE+',0,'Zina',1500,1500,0,0,'حميد','حميد','2026-03','active'],
[141,'Abdulla Hamad','971 50 997 7350','aalq01@hotmail.com','CORE+',0,'تحويل بنكي',1000,1000,0,0,'يونس','يونس','2026-03','active'],
[142,'عبدالمنعم','971 56 962 2005','abdulmonumali@yahoo.com','CORE',2000,'Zina',2000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[143,'خالد','971 56 699 3118','khaledsleiman.2007@gmail.com','CORE+',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2026-03','active'],
[144,'Asma Almoftah','974 5033 6605','asmaalmoftah@yahoo.com','INNER CIRCLE',0,'Zina',4629,2370,0,0,'يونس','يونس','2026-04','active'],
[145,'Ashwaq Alobidali','971 56 906 6668','ashwaq9066668@gmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[146,'Mouza','971 50 662 4422','findmexx@hotmail.com','PREMIUM',0,'Zina',4000,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[147,'shamaa alshowab','971 50 424 2652','s_alshowab@hotmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[148,'Saif alzaabi','971 50 612 5557','s.alzaabi5557@gmail.com','CORE',0,'Zina',2500,0,0,0,'يونس','يونس','2026-04','active'],
[149,'Sara Ahmed','971 50 174 8765','bntbathaqili98@gmail.com','CORE',0,'Zina',2500,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[150,'عبدالعزيز للبريكي','971 50 100 1057','azeez.albraiki@gmail.com','CORE',0,'',2500,0,0,0,'يونس','يونس','2026-04','active'],
[151,'عيسى العامري','971 56 688 0099','eaaalameri@gmail.com','CORE',0,'',2500,0,0,0,'حميد','حميد','2026-04','active'],
[152,'محمد تيسير','971 52 143 0292','mo.elias.ae.25@gmail.com','PREMIUM',0,'Zina',700,1300,0,0,'حميد','حميد','2026-04','active'],
[153,'عمران الحمادي','971 50 499 1993','ok_10-7@hotmail.com','PREMIUM',0,'Zina',4000,0,0,0,'غانم','مصطفى','2026-04','active'],
[154,'osama','966 56 891 5722','osamarezx@gmail.com','CORE',0,'Zina',2500,0,0,0,'خليل','خليل','2026-04','active'],
[155,'Mahra','971 50 976 6680','ma.khalid236@gmail.com','CORE',0,'Zina',1250,1250,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[156,'noof alkindi','971 50 393 2148','noofalkindi93@gmail.com','CORE',0,'Zina',2500,0,0,0,'يونس','يونس','2026-04','active'],
[157,'SAIF BAMAZRUA','966 50 818 8230','s.s.ba77@gmail.com','CORE',0,'Zina',1000,1500,0,0,'خليل','خليل','2026-04','active'],
[158,'Ahmed faisal almarzooki','971 50 980 5015','a.f.almarzooqi@hotmail.com','CORE',0,'تحويل بنكي',2500,0,0,0,'حميد','حميد','2026-04','active'],
[159,'ميرة الحمادي','971 50 419 1857','meera76340@gmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'حميد','حميد','2026-04','active'],
[160,'fatma Alahmed','971 54 377 6996','fatmma.alahmed@gmail.com','CORE',0,'Zina',1750,0,0,0,'يونس','يونس','2026-04','active'],
[161,'Hayam','971 50 992 8800','hayam.alhosani@gmail.com','PREMIUM',0,'Zina',4000,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[162,'Aisha almur','971 50 182 8888','aisha.almur@gmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'يونس','يونس','2026-04','active'],
[163,'Maha Almazrouei','971 50 626 6688','maha.almazrouei@gmail.com','INNER CIRCLE',0,'Zina',7000,0,0,0,'خليل','خليل','2026-04','active'],
[164,'Ayah Alshareif','971 56 666 0010','aya_alshareif@hotmail.com','PREMIUM',0,'Zina',2000,0,0,0,'غانم','غانم','2026-04','churned'],
[165,'حمدان','971 54 363 6336','h_7mdan@hotmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'يونس','يونس','2026-04','active'],
[166,'Shama','971 50 166 6105','shammh77@hotmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'يونس','يونس','2026-04','active'],
[167,'Adnan alrisi','968 9300 1010','adnan9.1990@gmail.com','PREMIUM',0,'Zina',2000,2000,0,0,'حميد','حميد','2026-04','active'],
[168,'Yusra N','966 54 405 5092','y.noorwali@gmail.com','INNER CIRCLE',0,'Zina',3000,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[169,'اسماء محمد','971 50 906 5213','asma.m.q@gmail.com','PREMIUM',0,'Zina',2000,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[170,'بسمه سعيد','971 50 959 5788','basmah-alzahmi@hotmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'يونس','يونس','2026-04','active'],
[171,'حسن عبدالله المرزوقي','971 50 534 2722','hasan84.almarzouqi@gmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'يونس','يونس','2026-04','active'],
[172,'سوسن','971 56 494 0400','sawsanalhebsi@gmail.com','CORE',0,'تحويل بنكي',1000,1500,0,0,'حميد','حميد','2026-04','active'],
[173,'منى صقر راشد','971 50 636 7888','basaair30000@gmail.com','PREMIUM',0,'Zina',4000,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[174,'سلطان أهلي','971 55 191 8788','weld_alahli11@icloud.com','PREMIUM',0,'تحويل بنكي',3000,0,0,0,'يونس','يونس','2026-04','active'],
[175,'نسيبه . العامري','971 56 562 4363','nsalem.alameri@gmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'خليل','خليل','2026-04','active'],
[176,'Ismail','971 52 443 0024','ismailabouzaher@gmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'غانم','غانم','2026-04','active'],
[177,'Shamma alameri','971 55 517 0470','201509473@uaeu.ac.ae','PREMIUM',0,'',1000,1000,0,0,'غانم','غانم','2026-04','active'],
[178,'Shamma Alketbi','971 55 333 6646','alketbi.sh@hotmail.com','PREMIUM',0,'Zina',2000,2000,0,0,'غانم','غانم','2026-04','active'],
[179,'Eman Alsuwaidi','971 50 784 2777','ehsalim@hotmail.com','CORE',0,'تحويل بنكي',1250,1250,0,0,'حميد','حميد','2026-04','active'],
[180,'Mahmoud','971 56 174 9511','mzaafarany@yahoo.com','PREMIUM',0,'Zina',2000,2000,0,0,'حميد','حميد','2026-04','active'],
[181,'Salem aldhanhani','971 50 301 0727','salem.saeed12@hotmail.com','PREMIUM',0,'تحويل بنكي',2000,2000,0,0,'حميد','حميد','2026-04','active'],
[182,'Yacoub Merzoug','1 540-293-3244','jacoub.daouda@gmail.com','PREMIUM',0,'',1000,700,0,0,'حميد','حميد','2026-04','active'],
[183,'Afraa','971 55 268 6869','missgoyard82@gmail.com','PREMIUM',0,'Zina',2000,2000,0,0,'غانم','غانم','2026-04','active'],
[184,'محمد سعيد اليحيائي','968 9952 5052','m.alyahyai919@gmail.com','PREMIUM',0,'Zina',1000,3000,0,0,'خليل','خليل','2026-04','active'],
[185,'مروة علي','971 52 105 3184','','PREMIUM',0,'Zina',1500,0,0,0,'خليل','خليل','2026-04','active'],
[186,'suood almaazmi','971 50 505 0651','almaazmi_23@outlook.com','PREMIUM',0,'',1900,2100,0,0,'يونس','يونس','2026-04','active'],
[187,'خالد القايدي','971 54 322 3998','k_alqaydi@hotmail.com','PREMIUM',0,'Zina',2500,1500,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[188,'نجود','971 50 494 9918','nujood@msn.com','PREMIUM',0,'Zina',2000,2000,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[189,'أم علي','971 50 446 3886','qtr_alnada@yahoo.com','PREMIUM',0,'Zina',1000,1000,0,0,'خليل','خليل','2026-04','active'],
[190,'حسين علي المالكي','974 5544 4085','almalki-h@outlook.com','INNER CIRCLE',0,'Zina',7000,0,0,0,'حميد','مصطفى','2026-04','active'],
[191,'كريم','972 50-753-6644','kamasri2006@gmail.com','CORE',1500,'PayPal',1500,0,0,0,'يونس','يونس','2026-04','active'],
[192,'عاصم يوسف عبدالله','971 50 110 9000','asimalzarooni@outlook.com','INNER CIRCLE',0,'Zina',2000,0,0,0,'خليل','خليل','2026-04','active'],
[193,'خليفة محمد الحمادي','971 56 833 3006','khalifa_4@outlook.sa','PREMIUM',0,'سلة',1000,0,0,0,'عبدالإله','عبدالإله','2026-04','active'],
[194,'ميثة العامري','971 55 154 8100','alamerimaitha4@gmail.com','CORE',0,'تحويل بنكي',1000,0,0,0,'حميد','تحرير','2026-04','active'],
[195,'خليفة خالد النقبي','971 50 210 2564','khalifa1998kk@gmail.com','INNER CIRCLE',0,'سلة',1500,1299,0,0,'عبدالإله','تحرير','2026-04','active'],
[196,'ماجد الحوسني','971 55 122 1733','majedalhosani97@gmail.com','PREMIUM',0,'سلة',4000,0,0,0,'غانم','غانم','2026-04','active'],
[197,'صالح','971 50 123 3222','saleh.o74@hotmail.com','INNER CIRCLE',0,'تحويل بنكي',7000,0,0,0,'حميد','حميد','2026-04','active'],
[198,'شيخة المعمري','971 55 150 5111','','PREMIUM',0,'سلة',4000,0,0,0,'عبدالإله','تحرير','2026-04','active'],
[199,'شما القبيسي','971 50 699 9640','shamma_alqubaisi@yahoo.com','CORE',0,'سلة',2500,0,0,0,'عبدالإله','تحرير','2026-04','active'],
[200,'فاخره','971 50 120 2085','fakhera.almammri@gmail.com','CORE',0,'سلة',1500,0,0,0,'يونس','يونس','2026-05','active'],
[201,'عبدالله الحوسني','971 50 790 1831','abdulla17191@icloud.com','PREMIUM',4299,'تحويل بنكي',1299,0,0,0,'يونس','يونس','2026-05','active'],
[202,'osama wael','972 59-256-8174','osamayuonis0@gmail.com','PREMIUM',0,'تحويل بنكي',4000,0,0,0,'خليل','خليل','2026-05','active'],
[203,'أحمد عبدالله محمد','971 50 989 3388','alhantoubi99@icloud.com','PREMIUM',4299,'سلة',4299,0,0,0,'حميد','حميد','2026-05','active'],
[204,'خليل حسين المرزوقي','971 56 727 2047','kh.shj.1995@gmail.com','CORE',0,'سلة',700,0,0,0,'عبدالإله','عبدالإله','2026-05','active'],
[205,'Wafa Alzaabi','971 50 995 5117','wafa.alzaabi@outlook.com','PREMIUM',4299,'تحويل بنكي',1000,0,0,0,'يونس','يونس','2026-05','active'],
[206,'محمد الأحمد','971 50 680 3330','emiratesboy911@gmail.com','PREMIUM',4299,'تحويل بنكي',4299,0,0,0,'عبدالإله','تحرير','2026-05','active'],
[207,'Nasser','971 52 730 7111','nasser.aljaberi@hotmail.com','CORE',0,'سلة',1000,0,0,0,'حميد','حميد','2026-05','active'],
[208,'علي رضواني','974 7755 6699','ali-775566@hotmail.com','INNER CIRCLE',0,'تحويل بنكي',7000,0,0,0,'يونس','يونس','2026-05','active'],
[209,'Ahmad Alkhoori','971 55 641 7100','ahmadkhouri@gmail.com','INNER CIRCLE',0,'تحويل بنكي',7000,0,0,0,'حميد','حميد','2026-05','active'],
[210,'فاطمة ال محمود','973 3606 0192','f.a.almahmood@gmail.com','PREMIUM',0,'Zina',1000,0,0,0,'عبدالإله','تحرير','2026-05','active'],
[211,'سلمان علي الحمادي','971 56 888 2806','salman.alhammadi90@gmail.com','CORE',0,'تحويل بنكي',625,0,0,0,'حميد','حميد','2026-05','active'],
[212,'Anas Alkendari','965 6510 1084','alkanderi540@gmail.com','PREMIUM',4299,'Zina',1433,0,0,0,'حميد','حميد','2026-05','active'],
[213,'سارة احمد المنصوري','974 3350 8666','saalmansouri@hotmail.com','PREMIUM',4299,'Zina',1750,0,0,0,'عبدالإله','تحرير','2026-05','active'],
[214,'ناصر سالم','971 50 300 0448','nalmazrouei@hotmail.com','PREMIUM',4299,'تحويل بنكي',1299,0,0,0,'خليل','خليل','2026-05','active'],
[215,'Ashwag Al-Malki','974 5564 8410','','PREMIUM',4299,'سلة',500,833,0,0,'عبدالإله','تحرير','2026-05','enrolled'],
[216,'نواف علي الحمادي','971 50 411 1312','nawafalshoka@gmail.com','PREMIUM',4299,'تحويل بنكي',2000,0,0,0,'عبدالإله','تحرير','2026-05','active'],
[217,'Ahmad','90 539 885 57 91','','PREMIUM',3750,'Stripe',700,0,0,0,'عبدالإله','تحرير','2026-05','enrolled'],
[218,'امل الحمادي','971 50 422 2151','','PREMIUM',4299,'Zina',500,0,0,0,'عبدالإله','تحرير','2026-05','enrolled'],
[219,'سلامه محسن المزروعي','971 50 388 8896','salamaalmzoruei@gmail.com','INNER CIRCLE',0,'تحويل بنكي',7000,0,0,0,'حميد','حميد','2026-05','active'],
[220,'رغد','971 50 166 0337','','PREMIUM',4299,'Zina',500,0,0,0,'عبدالإله','تحرير','2026-05','enrolled'],
[221,'مبارك المنصوري','966 55 528 6723','','PREMIUM',4299,'Zina',1000,0,0,0,'عبدالإله','عبدرحمن','2026-05','enrolled'],
[222,'عفراء سيف محمد الشيحي','971 50 686 7668','afra-alshehhi@hotmail.com','PREMIUM',4299,'تحويل بنكي',1500,0,0,0,'عمار','عمار','2026-05','active'],
[223,'عيسى عبيد الكندي','971 50 363 6565','','PREMIUM',4299,'تحويل بنكي',4299,0,0,0,'عبدالإله','عبدرحمن','2026-05','enrolled'],
];

module.exports = {
  // Clients
  getClients, getTrash, importData,
  createClient, updateClient, updateNotes,
  softDelete, restoreClient, restoreAll, permDelete, emptyTrash,
  // Team
  getTeam, addMember, editMember, removeMember,
  getTeamTrash, restoreTeamMember, permDeleteTeamMember, emptyTeamTrash,
  // Plans
  getCustomPlans, addCustomPlan,
  // Sessions (Postgres-backed, serverless-safe)
  createSessionDB, getSessionDB, deleteSessionDB,
  // Users (auth)
  findUserByUsername, verifyPassword, getUsers, createUser, updateUser, deleteUser,
};
