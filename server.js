'use strict';
const express = require('express');
const path    = require('path');
const {
  getClients, getTrash,
  createClient, updateClient, updateNotes,
  softDelete, restoreClient, restoreAll, permDelete, emptyTrash,
  getTeam, addMember, editMember, removeMember,
  getTeamTrash, restoreTeamMember, permDeleteTeamMember, emptyTeamTrash,
  getCustomPlans, addCustomPlan, updateCustomPlan, deleteCustomPlan, importData,
  saveContract, getContract, deleteContract,
  createSessionDB, getSessionDB, deleteSessionDB,
  findUserByUsername, verifyPassword, getUsers, createUser, updateUser, deleteUser,
} = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '512kb' }));
app.use(express.static(__dirname));

// ─── CORS ────────────────────────────────────────────────────────────────────
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ─── Auth middleware (MongoDB sessions — serverless-safe) ─────────────────────
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  getSessionDB(token)
    .then(session => {
      if (!session) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
      req.user = { username: session.username, role: session.role };
      next();
    })
    .catch(() => res.status(500).json({ error: 'خطأ في التحقق من الجلسة' }));
}

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  getSessionDB(token)
    .then(session => {
      if (!session) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
      if (session.role !== 'admin') return res.status(403).json({ error: 'هذه الميزة للمشرف فقط' });
      req.user = { username: session.username, role: session.role };
      next();
    })
    .catch(() => res.status(500).json({ error: 'خطأ في التحقق من الجلسة' }));
}

// ─── Login rate limiter ───────────────────────────────────────────────────────
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - entry.first > 15 * 60 * 1000) { entry.count = 0; entry.first = now; }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > 10) return res.status(429).json({ ok: false, error: 'Too many attempts, try again later' });
  next();
}

// ─── Input helpers ────────────────────────────────────────────────────────────
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

// ─── Helper ───────────────────────────────────────────────────────────────────
function clean(c) {
  if (!c) return null;
  const { deleted, deletedAt, ...rest } = c;
  if (deletedAt) rest._deletedAt = deletedAt;
  return rest;
}

// ─── Serve HTML ───────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'crm.html')));

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  try {
    const { username = '', password = '' } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string')
      return res.status(400).json({ ok: false, error: 'Invalid input' });
    const u = username.trim().toLowerCase().slice(0, 100);
    const p = password.slice(0, 200);
    const account = await findUserByUsername(u);
    if (!account || !verifyPassword(p, account.passwordHash))
      return res.status(401).json({ ok: false, error: 'بيانات الدخول غير صحيحة' });
    const token = await createSessionDB(account.username, account.role);
    res.json({ ok: true, role: account.role, username: account.username, token });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  await deleteSessionDB(token);
  res.json({ ok: true });
});

// ─── Clients ──────────────────────────────────────────────────────────────────
app.get('/api/clients', requireAuth, async (_req, res) => {
  try { res.json((await getClients()).map(clean)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  try {
    const client = await createClient(sanitizeClientBody(req.body));
    res.status(201).json(clean(client));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', requireAuth, async (req, res) => {
  try { await updateClient(+req.params.id, sanitizeClientBody(req.body)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id/notes', requireAuth, async (req, res) => {
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

app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  try { await softDelete(+req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Trash ────────────────────────────────────────────────────────────────────
app.get('/api/trash', requireAdmin, async (_req, res) => {
  try { res.json((await getTrash()).map(clean)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/restore', requireAdmin, async (req, res) => {
  try { await restoreClient(+req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trash/restore-all', requireAdmin, async (_req, res) => {
  try { await restoreAll(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/trash/:id', requireAdmin, async (req, res) => {
  try { await permDelete(+req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/trash', requireAdmin, async (_req, res) => {
  try { await emptyTrash(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Team ─────────────────────────────────────────────────────────────────────
app.get('/api/team', requireAuth, async (_req, res) => {
  try { res.json(await getTeam()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/closers', requireAdmin, async (req, res) => {
  try {
    if (!await addMember('closers', str(req.body.name, 100)))
      return res.status(409).json({ error: 'الاسم موجود مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/closers/:old', requireAdmin, async (req, res) => {
  try { await editMember('closers', decodeURIComponent(req.params.old), str(req.body.name, 100)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/closers/:name', requireAdmin, async (req, res) => {
  try { await removeMember('closers', decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/setters', requireAdmin, async (req, res) => {
  try {
    if (!await addMember('setters', str(req.body.name, 100)))
      return res.status(409).json({ error: 'الاسم موجود مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/setters/:old', requireAdmin, async (req, res) => {
  try { await editMember('setters', decodeURIComponent(req.params.old), str(req.body.name, 100)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/setters/:name', requireAdmin, async (req, res) => {
  try { await removeMember('setters', decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Team Trash ───────────────────────────────────────────────────────────────
app.get('/api/team/trash', requireAdmin, async (_req, res) => {
  try { res.json(await getTeamTrash()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/trash/restore', requireAdmin, async (req, res) => {
  try { await restoreTeamMember(req.body.type, req.body.name); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/trash/:type/:name', requireAdmin, async (req, res) => {
  try { await permDeleteTeamMember(req.params.type, decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/trash', requireAdmin, async (_req, res) => {
  try { await emptyTeamTrash(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Custom Plans ─────────────────────────────────────────────────────────────
app.get('/api/plans', requireAuth, async (_req, res) => {
  try { res.json(await getCustomPlans()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans', requireAdmin, async (req, res) => {
  try {
    if (!await addCustomPlan(str(req.body.name, 100), req.body.price))
      return res.status(409).json({ error: 'الباقة موجودة مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/plans/:name', requireAdmin, async (req, res) => {
  try {
    const { newName, price } = req.body || {};
    const ok = await updateCustomPlan(decodeURIComponent(req.params.name),
      newName ? str(newName, 100) : undefined, price);
    if (!ok) return res.status(409).json({ error: 'اسم الباقة موجود مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plans/:name', requireAdmin, async (req, res) => {
  try { await deleteCustomPlan(decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Client contract (PDF) ────────────────────────────────────────────────────
app.post('/api/clients/:id/contract',
  requireAdmin,
  express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '8mb' }),
  async (req, res) => {
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0)
        return res.status(400).json({ error: 'ملف غير صالح' });
      const filename = str(req.query.name, 200) || 'contract.pdf';
      await saveContract(+req.params.id, filename, 'application/pdf', buf);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

app.get('/api/clients/:id/contract', requireAuth, async (req, res) => {
  try {
    const c = await getContract(+req.params.id);
    if (!c) return res.status(404).json({ error: 'لا يوجد عقد' });
    res.setHeader('Content-Type', c.mime || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract-${+req.params.id}.pdf"`);
    res.send(c.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/contract', requireAdmin, async (req, res) => {
  try { const ok = await deleteContract(+req.params.id); res.json({ ok }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Users management (admin only) ───────────────────────────────────────────
app.get('/api/users', requireAdmin, async (_req, res) => {
  try { res.json(await getUsers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    if (!['admin', 'coach'].includes(role)) return res.status(400).json({ error: 'الدور غير صحيح' });
    const ok = await createUser(str(username, 50), str(password, 200), role);
    if (!ok) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:username', requireAdmin, async (req, res) => {
  try {
    const { password, role } = req.body || {};
    if (role && !['admin', 'coach'].includes(role)) return res.status(400).json({ error: 'الدور غير صحيح' });
    const ok = await updateUser(req.params.username, {
      password: password ? str(password, 200) : undefined,
      role,
    });
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:username', requireAdmin, async (req, res) => {
  try {
    if (req.user.username === req.params.username.toLowerCase())
      return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
    const ok = await deleteUser(req.params.username);
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Migration endpoint ───────────────────────────────────────────────────────
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
