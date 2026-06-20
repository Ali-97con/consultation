'use strict';
const express = require('express');
const path    = require('path');
const {
  getClients, getTrash,
  createClient, updateClient, updateNotes,
  softDelete, restoreClient, restoreAll, permDelete, emptyTrash,
  getTeam, addMember, editMember, removeMember,
  getTeamTrash, restoreTeamMember, permDeleteTeamMember, emptyTeamTrash,
  getCustomPlans, addCustomPlan, importData
} = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Body limit (reduced from 10mb to 512kb for normal use) ──────────────────
app.use(express.json({ limit: '512kb' }));
app.use(express.static(__dirname));

// ─── CORS — restrict to own origin only ──────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://consultation-lake.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ─── Simple in-process rate limiter for login ─────────────────────────────────
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - entry.first > 15 * 60 * 1000) { entry.count = 0; entry.first = now; }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > 10) return res.status(429).json({ ok: false, error: 'Too many attempts, try again later' });
  next();
}

// ─── Input sanitiser ─────────────────────────────────────────────────────────
function str(v, max = 500) {
  if (v === undefined || v === null) return undefined;
  return String(v).slice(0, max);
}
function sanitizeClientBody(body) {
  const b = body || {};
  const out = {};
  const fields = { name:200, phone:50, email:200, plan:100, paymentType:50, payMethod:50,
    status:50, closer:100, setter:100, regDate:30, lastPayDate:30, notes:undefined,
    p1:undefined, p2:undefined, p3:undefined, p4:undefined,
    p1d:30, p2d:30, p3d:30, p4d:30,
    customTotal:undefined, discountType:50, discountValue:undefined, discountAmount:undefined,
    callsDone:undefined, callsTotal:undefined, calls:undefined, ci:undefined };
  for (const [k, maxLen] of Object.entries(fields)) {
    if (b[k] !== undefined) {
      if (k === 'notes') { out.notes = b.notes; continue; }
      if (maxLen === undefined) { out[k] = b[k]; continue; }
      out[k] = str(b[k], maxLen);
    }
  }
  return out;
}

// ─── Serve HTML ───────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'crm.html')));

// ─── Auth ─────────────────────────────────────────────────────────────────────
const ACCOUNTS = [
  { username: process.env.LOGIN_USER  || 'admin',  password: process.env.LOGIN_PASS  || 'password', role: 'admin'  },
  { username: process.env.COACH1_USER || 'coach1', password: process.env.COACH1_PASS || 'abusharbi', role: 'coach' },
  { username: process.env.COACH2_USER || 'coach2', password: process.env.COACH2_PASS || 'taha',      role: 'coach' },
];

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string')
    return res.status(400).json({ ok: false, error: 'Invalid input' });
  const u = username.trim().slice(0, 100);
  const p = password.slice(0, 200);
  const account = ACCOUNTS.find(a => safeEq(u, a.username) && safeEq(p, a.password));
  if (!account) return res.status(401).json({ ok: false, error: 'بيانات الدخول غير صحيحة' });
  res.json({ ok: true, role: account.role, username: account.username });
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function clean(c) {
  if (!c) return null;
  const { deleted, deletedAt, ...rest } = c;
  if (deletedAt) rest._deletedAt = deletedAt;
  return rest;
}

// ─── Clients ──────────────────────────────────────────────────────────────────
app.get('/api/clients', async (_req, res) => {
  try { res.json((await getClients()).map(clean)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', async (req, res) => {
  try {
    const client = await createClient(sanitizeClientBody(req.body));
    res.status(201).json(clean(client));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try { await updateClient(+req.params.id, sanitizeClientBody(req.body)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id/notes', async (req, res) => {
  try {
    const notes = (req.body.notes || []).map(n => ({
      ...n,
      txt: str(n.txt, 5000),
      author: str(n.author, 100),
      date: str(n.date, 50),
    }));
    await updateNotes(+req.params.id, notes);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  try { await softDelete(+req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Trash ────────────────────────────────────────────────────────────────────
app.get('/api/trash', async (_req, res) => {
  try { res.json((await getTrash()).map(clean)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/restore', async (req, res) => {
  try { await restoreClient(+req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trash/restore-all', async (_req, res) => {
  try { await restoreAll(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/trash/:id', async (req, res) => {
  try { await permDelete(+req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/trash', async (_req, res) => {
  try { await emptyTrash(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Team ─────────────────────────────────────────────────────────────────────
app.get('/api/team', async (_req, res) => {
  try { res.json(await getTeam()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/closers', async (req, res) => {
  try {
    if (!await addMember('closers', str(req.body.name, 100)))
      return res.status(409).json({ error: 'الاسم موجود مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/closers/:old', async (req, res) => {
  try { await editMember('closers', decodeURIComponent(req.params.old), str(req.body.name, 100)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/closers/:name', async (req, res) => {
  try { await removeMember('closers', decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/setters', async (req, res) => {
  try {
    if (!await addMember('setters', str(req.body.name, 100)))
      return res.status(409).json({ error: 'الاسم موجود مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/setters/:old', async (req, res) => {
  try { await editMember('setters', decodeURIComponent(req.params.old), str(req.body.name, 100)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/setters/:name', async (req, res) => {
  try { await removeMember('setters', decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Team Trash ───────────────────────────────────────────────────────────────
app.get('/api/team/trash', async (_req, res) => {
  try { res.json(await getTeamTrash()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/trash/restore', async (req, res) => {
  try { await restoreTeamMember(req.body.type, req.body.name); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/trash/:type/:name', async (req, res) => {
  try { await permDeleteTeamMember(req.params.type, decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/trash', async (_req, res) => {
  try { await emptyTeamTrash(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Custom Plans ─────────────────────────────────────────────────────────────
app.get('/api/plans', async (_req, res) => {
  try { res.json(await getCustomPlans()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans', async (req, res) => {
  try {
    if (!await addCustomPlan(str(req.body.name, 100), req.body.price))
      return res.status(409).json({ error: 'الباقة موجودة مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Migration endpoint (protected — requires MIGRATE_SECRET env var) ─────────
app.post('/api/migrate-import', async (req, res) => {
  const migrateSecret = process.env.MIGRATE_SECRET;
  if (!migrateSecret) return res.status(403).json({ error: 'forbidden' });
  const { secret, data } = req.body || {};
  if (!secret || secret !== migrateSecret) return res.status(403).json({ error: 'forbidden' });
  try { await importData(data); res.json({ ok: true, clients: data.clients.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ AH97 CRM Server running at: http://localhost:${PORT}\n`);
});

module.exports = app;
