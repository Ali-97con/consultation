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

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

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

app.post('/api/auth/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const u = String(username).trim();
  const p = String(password);
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
    const client = await createClient(req.body);
    res.status(201).json(clean(client));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try { await updateClient(+req.params.id, req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id/notes', async (req, res) => {
  try { await updateNotes(+req.params.id, req.body.notes || []); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    if (!await addMember('closers', req.body.name))
      return res.status(409).json({ error: 'الاسم موجود مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/closers/:old', async (req, res) => {
  try { await editMember('closers', decodeURIComponent(req.params.old), req.body.name); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/team/closers/:name', async (req, res) => {
  try { await removeMember('closers', decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/setters', async (req, res) => {
  try {
    if (!await addMember('setters', req.body.name))
      return res.status(409).json({ error: 'الاسم موجود مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/team/setters/:old', async (req, res) => {
  try { await editMember('setters', decodeURIComponent(req.params.old), req.body.name); res.json({ ok: true }); }
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
    if (!await addCustomPlan(req.body.name, req.body.price))
      return res.status(409).json({ error: 'الباقة موجودة مسبقاً' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Migration endpoint (one-time use) ───────────────────────────────────────
app.post('/api/migrate-import', async (req, res) => {
  const { secret, data } = req.body || {};
  if (secret !== process.env.MIGRATE_SECRET) return res.status(403).json({ error: 'forbidden' });
  try { await importData(data); res.json({ ok: true, clients: data.clients.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ AH97 CRM Server running at: http://localhost:${PORT}\n`);
});

module.exports = app;
