'use strict';
const express = require('express');
const path    = require('path');
const {
  getClients, getTrash,
  createClient, updateClient, updateNotes, upgradeClient, undoLastUpgrade,
  pauseClient, resumeClient, ensureResumed, ensureEnded,
  addAudit, getAudit,
  getEmailTemplates, saveEmailTemplate, logEmail, emailSentSet, getEmailLog,
  softDelete, restoreClient, restoreAll, permDelete, emptyTrash,
  getTeam, addMember, editMember, removeMember,
  getTeamTrash, restoreTeamMember, permDeleteTeamMember, emptyTeamTrash,
  getCustomPlans, addCustomPlan, updateCustomPlan, deleteCustomPlan, importData,
  addContract, getContractById, deleteContractById,
  addNoteFile, getNoteFileById, deleteNoteFileById,
  updateCsmNotes, updateUpsellNotes, getCsmOptions, addCsmOption, deleteCsmOption, ensureFollowStart,
  getUpsellServices, addUpsellService, updateUpsellService, deleteUpsellService, updateUpsells,
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
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    || (req.query && req.query.t ? String(req.query.t).trim() : '');   // ?t= allows inline <img>/file view
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

// Generic role gate: allow only the listed roles.
function requireRoles(...roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    getSessionDB(token)
      .then(session => {
        if (!session) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
        if (!roles.includes(session.role)) return res.status(403).json({ error: 'صلاحية غير كافية' });
        req.user = { username: session.username, role: session.role };
        next();
      })
      .catch(() => res.status(500).json({ error: 'خطأ في التحقق من الجلسة' }));
  };
}
// CSM follow-up endpoints: admin + both CSM roles (in-app and phone).
const requireCsmOrAdmin       = requireRoles('admin', 'csm', 'csm_phone');
// Upgrade + audit log: admin + phone-CSM.
const requireCsmPhoneOrAdmin  = requireRoles('admin', 'csm_phone');

// Write an audit entry; never blocks or fails the request.
function audit(req, action, entity, entityId, summary, details) {
  try {
    addAudit({
      username: req.user && req.user.username, role: req.user && req.user.role,
      action, entity, entityId, summary, details,
    }).catch(() => {});
  } catch (_) { /* ignore */ }
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
    status:50, closer:100, setter:100, channel:20, sex:10, regDate:30, birthDate:30, contractEnd:30, csmStart:30, contactedAt:40, lastPayDate:30, notes:undefined,
    payments:undefined,
    p1:undefined, p2:undefined, p3:undefined, p4:undefined,
    p1d:30, p2d:30, p3d:30, p4d:30,
    customTotal:undefined, discountType:50, discountValue:undefined, discountAmount:undefined,
    callsDone:undefined, callsTotal:undefined, calls:undefined, ci:undefined,
    upsellProspect:undefined, upsellContactedAt:50, upsellAlertOff:undefined, upsellSnoozeUntil:30 };
  for (const [k, maxLen] of Object.entries(fields)) {
    if (b[k] !== undefined) {
      if (k === 'notes') { out.notes = b.notes; continue; }
      if (k === 'payments') {
        // Array of installments [{amt,date}]; cap length and coerce each entry.
        if (Array.isArray(b.payments)) {
          out.payments = b.payments.slice(0, 60).map(p => ({
            amt: Number(p && p.amt) || 0,
            date: str((p && p.date) || '', 30) || '',
          }));
        }
        continue;
      }
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
app.get('/', (_req, res) => {
  // Always serve fresh HTML (avoid stale cached UI after a deploy)
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'crm.html'));
});

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
    audit(req, 'client.create', 'client', client.id, `إضافة عميل «${client.name || client.id}»`, { plan: client.plan });
    res.status(201).json(clean(client));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const patch = sanitizeClientBody(req.body);
    const updated = await updateClient(+req.params.id, patch);
    audit(req, 'client.update', 'client', +req.params.id,
      `تعديل بيانات «${(updated && updated.name) || req.params.id}»`, { fields: Object.keys(patch) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id/notes', requireAuth, async (req, res) => {
  try {
    const notes = (req.body.notes || []).map(n => {
      const o = { ...n, txt: str(n.txt, 5000), author: str(n.author, 100), date: str(n.date, 50) };
      if (Array.isArray(n.files)) o.files = n.files.slice(0, 20).map(f => ({ id: Number(f && f.id) || 0, name: str(f && f.name, 200) || '', mime: str(f && f.mime, 100) || '' }));
      return o;
    });
    await updateNotes(+req.params.id, notes);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CSM (customer success) follow-up notes + option lists ────────────────────
app.put('/api/clients/:id/csm-notes', requireCsmOrAdmin, async (req, res) => {
  try {
    const notes = (req.body.notes || []).slice(0, 1000).map(n => ({
      id:        n.id,
      date:      str(n.date, 30),
      condition: str(n.condition, 80),
      follow:    Array.isArray(n.follow) ? n.follow.slice(0, 30).map(f => str(f, 80)) : [],
      text:      str(n.text, 5000),
      author:    str(n.author, 100),
      createdAt: str(n.createdAt, 40),
    }));
    await updateCsmNotes(+req.params.id, notes);
    audit(req, 'csm.note', 'client', +req.params.id, 'تحديث متابعة نجاح العملاء', { count: notes.length });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Upsell follow-up log (admin + csm + sales) — dedicated to the sales workspace ──
app.put('/api/clients/:id/upsell-notes', requireCsmOrAdmin, async (req, res) => {
  try {
    const notes = (req.body.notes || []).slice(0, 1000).map(n => ({
      id:        n.id,
      date:      str(n.date, 30),
      state:     str(n.state, 80),
      intent:    Array.isArray(n.intent) ? n.intent.slice(0, 30).map(f => str(f, 80)) : [],
      text:      str(n.text, 5000),
      nextDate:  str(n.nextDate, 30),
      author:    str(n.author, 100),
      createdAt: str(n.createdAt, 40),
    }));
    await updateUpsellNotes(+req.params.id, notes);
    audit(req, 'client.upsell.follow', 'client', +req.params.id, 'متابعة أبسيل', { count: notes.length });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Plan upgrade (admin + phone-CSM): changes plan + contract total, logs it ──
app.post('/api/clients/:id/upgrade', requireCsmPhoneOrAdmin, async (req, res) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    const plan = str(b.plan, 100);
    if (!plan) return res.status(400).json({ error: 'الباقة الجديدة مطلوبة' });
    const newTotal = Math.max(0, Number(b.newTotal) || 0);
    const rec = {
      from: str(b.from, 100) || '', to: plan,
      oldPrice: Number(b.oldPrice) || 0, newPrice: Number(b.newPrice) || 0,
      diff: Number(b.diff) || 0, discount: Number(b.discount) || 0, discountPct: Number(b.discountPct) || 0,
      increment: Number(b.increment) || 0, payMode: str(b.payMode, 20) || '',
      newTotal, date: str(b.date, 30) || new Date().toISOString().slice(0, 10),
      by: req.user.username,
    };
    const payments = Array.isArray(b.payments)
      ? b.payments.slice(0, 60).map(p => ({ amt: Number(p && p.amt) || 0, date: str((p && p.date) || '', 30) || '' }))
      : undefined;
    const contractEnd = str(b.contractEnd, 30) || undefined;
    if (contractEnd) rec.contractEnd = contractEnd;
    const updated = await upgradeClient(id, plan, newTotal, rec, payments, contractEnd);
    if (!updated) return res.status(404).json({ error: 'العميل غير موجود' });
    audit(req, 'client.upgrade', 'client', id,
      `ترقية باقة «${updated.name || id}»: ${rec.from} → ${rec.to}`, rec);
    res.json({ ok: true, client: clean(updated) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Contract pause / resume (admin + both CSM roles) ─────────────────────────
app.post('/api/clients/:id/pause', requireCsmOrAdmin, async (req, res) => {
  try {
    const today = str(req.body.date, 30) || new Date().toISOString().slice(0, 10);
    const mode = req.body.mode === 'fixed' ? 'fixed' : 'open';
    const days = Math.max(0, Math.min(400, Math.round(Number(req.body.days) || 0)));
    const r = await pauseClient(+req.params.id, { mode, days, date: today });
    if (!r) return res.status(404).json({ error: 'العميل غير موجود' });
    if (!r.already) audit(req, 'client.pause', 'client', +req.params.id,
      `إيقاف مؤقت للعقد «${r.client.name || req.params.id}»${mode === 'fixed' ? ` (${days} يوم حتى ${r.client.pauseUntil})` : ' (مفتوح)'}`, { start: today, mode, days });
    res.json({ ok: true, client: clean(r.client) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Maintenance: auto-resume finished fixed pauses + auto-mark ended contracts (admin, on load)
app.post('/api/maintenance/run', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const resumed = await ensureResumed(today);
    const ended = await ensureEnded(today);
    res.json({ ok: true, resumed, ended });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clients/:id/resume', requireCsmOrAdmin, async (req, res) => {
  try {
    const today = str(req.body.date, 30) || new Date().toISOString().slice(0, 10);
    const r = await resumeClient(+req.params.id, today);
    if (!r) return res.status(404).json({ error: 'العميل غير موجود' });
    if (!r.notPaused) audit(req, 'client.resume', 'client', +req.params.id,
      `استئناف العقد «${r.client.name || req.params.id}» (+${r.days} يوم → ${r.client.contractEnd || '—'})`, { days: r.days });
    res.json({ ok: true, client: clean(r.client), days: r.days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Undo the most recent upgrade (admin + phone-CSM)
app.post('/api/clients/:id/upgrade/undo', requireCsmPhoneOrAdmin, async (req, res) => {
  try {
    const r = await undoLastUpgrade(+req.params.id);
    if (!r) return res.status(404).json({ error: 'لا توجد ترقية لإلغائها' });
    audit(req, 'client.upgrade.undo', 'client', +req.params.id,
      `إلغاء ترقية «${r.client.name || req.params.id}»: عودة إلى ${r.client.plan}`, r.rec);
    res.json({ ok: true, client: clean(r.client) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Audit log (admin + phone-CSM) ────────────────────────────────────────────
app.get('/api/audit', requireCsmPhoneOrAdmin, async (req, res) => {
  try {
    const { action, entity, username, limit } = req.query || {};
    res.json(await getAudit({
      action: str(action, 80), entity: str(entity, 40),
      username: str(username, 100), limit: +limit || 300,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/csm/options', requireCsmOrAdmin, async (_req, res) => {
  try { res.json(await getCsmOptions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Weekly-session emails (Brevo) — admin only ───────────────────────────────
function renderTpl(str, vars) {
  return String(str || '').replace(/\{\{\s*(الاسم|التاريخ|الرابط|الغاء|العنوان)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}
// Plain-text version from HTML — multipart (HTML + text) is a strong deliverability signal.
function htmlToText(html) {
  return String(html || '')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => `${txt.replace(/<[^>]+>/g, '').trim()} ( ${href} )`)
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Wrap the template body in a valid, complete HTML document (fixes "HTML errors" spam deductions).
function wrapEmailHtml(inner) {
  if (/<html[\s>]/i.test(inner)) return inner;
  return '<!DOCTYPE html><html dir="rtl" lang="ar"><head>'
    + '<meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>الجلسة الأسبوعية</title></head>'
    + '<body style="margin:0;padding:16px;background:#ffffff">' + inner + '</body></html>';
}
async function sendBrevoEmail({ to, toName, subject, html }) {
  const key = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!key) throw new Error('BREVO_API_KEY غير مضبوط في الخادم');
  if (!senderEmail) throw new Error('BREVO_SENDER_EMAIL غير مضبوط في الخادم');
  const sender = { name: process.env.BREVO_SENDER_NAME || 'AH97', email: senderEmail };
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      sender, to: [{ email: to, name: toName || undefined }], subject,
      htmlContent: wrapEmailHtml(html), textContent: htmlToText(html),   // full-document HTML + plain text
      headers: { 'List-Unsubscribe': `<mailto:${senderEmail}?subject=unsubscribe>` },
    }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Brevo ${r.status}: ${t.slice(0, 200)}`); }
  return r.json().catch(() => ({}));
}
function unsubLink() {
  const e = process.env.BREVO_SENDER_EMAIL || '';
  return `mailto:${e}?subject=${encodeURIComponent('إلغاء الاشتراك')}`;
}

app.get('/api/sessions/templates', requireAdmin, async (_req, res) => {
  try { res.json(await getEmailTemplates()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/sessions/templates/:key', requireAdmin, async (req, res) => {
  try {
    const key = ['reminder', 'register'].includes(req.params.key) ? req.params.key : null;
    if (!key) return res.status(400).json({ error: 'نوع القالب غير صحيح' });
    await saveEmailTemplate(key, str(req.body.subject, 300), str(req.body.html, 50000));
    audit(req, 'session.template', 'email', key, `تعديل قالب البريد (${key})`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sessions/log', requireAdmin, async (req, res) => {
  try { res.json(await getEmailLog(str(req.query.weekKey, 30))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Send a single test email to a chosen address
app.post('/api/sessions/test', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const key = ['reminder', 'register'].includes(b.campaign) ? b.campaign : 'reminder';
    const to = str(b.to, 200);
    if (!to || !/@/.test(to)) return res.status(400).json({ error: 'بريد الاختبار غير صحيح' });
    const tpls = await getEmailTemplates();
    const tpl = tpls[key] || {};
    const vars = { 'الاسم': 'عميلنا العزيز', 'التاريخ': str(b.date, 120) || '—', 'الرابط': str(b.link, 500) || '#', 'العنوان': str(b.title, 300) || '—', 'الغاء': unsubLink() };
    await sendBrevoEmail({ to, toName: 'Test', subject: renderTpl(tpl.subject, vars), html: renderTpl(tpl.html, vars) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Send one batch of recipients for a campaign (frontend chunks the full list). Dedup per session+campaign.
app.post('/api/sessions/send', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const key = ['reminder', 'register'].includes(b.campaign) ? b.campaign : null;
    if (!key) return res.status(400).json({ error: 'الحملة غير صحيحة' });
    const weekKey = str(b.weekKey, 30) || str(b.date, 30) || new Date().toISOString().slice(0, 10);
    const date = str(b.date, 120) || '';
    const link = str(b.link, 500) || '';
    const title = str(b.title, 300) || '';
    if (key === 'register' && !link) return res.status(400).json({ error: 'رابط التسجيل مطلوب' });
    const recipients = Array.isArray(b.recipients) ? b.recipients.slice(0, 60) : [];
    const tpls = await getEmailTemplates();
    const tpl = tpls[key] || {};
    const already = await emailSentSet(key, weekKey);
    let sent = 0, failed = 0, skipped = 0;
    for (const rcp of recipients) {
      const to = str(rcp && rcp.email, 200);
      if (!to || !/@/.test(to)) { skipped++; continue; }
      if (already.has(to.toLowerCase())) { skipped++; continue; }   // already emailed this session+campaign
      const vars = { 'الاسم': str(rcp.name, 200) || 'عميلنا العزيز', 'التاريخ': date || '—', 'الرابط': link || '#', 'العنوان': title || '—', 'الغاء': unsubLink() };
      try {
        await sendBrevoEmail({ to, toName: str(rcp.name, 200), subject: renderTpl(tpl.subject, vars), html: renderTpl(tpl.html, vars) });
        await logEmail({ campaign: key, weekKey, clientId: rcp.clientId, toEmail: to, status: 'sent' });
        sent++;
      } catch (err) {
        await logEmail({ campaign: key, weekKey, clientId: rcp.clientId, toEmail: to, status: 'failed', error: String(err.message || err).slice(0, 300) });
        failed++;
      }
    }
    audit(req, 'session.send', 'email', weekKey, `إرسال بريد (${key === 'reminder' ? 'تذكير' : 'تسجيل'}) — نجح ${sent} · فشل ${failed}`, { campaign: key, sent, failed, skipped });
    res.json({ ok: true, sent, failed, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Upsell services (list) + per-client upsell purchases ─────────────────────
app.get('/api/upsell-services', requireAuth, async (_req, res) => {
  try { res.json(await getUpsellServices()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/upsell-services', requireAdmin, async (req, res) => {
  try {
    const name = str(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'اسم الخدمة مطلوب' });
    if (!await addUpsellService(name, Number(req.body.price) || 0)) return res.status(409).json({ error: 'الخدمة موجودة مسبقاً' });
    audit(req, 'upsell.service.create', 'upsell', name, `إضافة خدمة Upsell «${name}»`, { price: Number(req.body.price) || 0 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/upsell-services/:name', requireAdmin, async (req, res) => {
  try {
    const ok = await updateUpsellService(decodeURIComponent(req.params.name),
      req.body.newName ? str(req.body.newName, 120) : undefined, Number(req.body.price) || 0);
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/upsell-services/:name', requireAdmin, async (req, res) => {
  try { await deleteUpsellService(decodeURIComponent(req.params.name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Record upsell purchases on a client (admin + both CSM roles)
app.put('/api/clients/:id/upsells', requireCsmOrAdmin, async (req, res) => {
  try {
    const upsells = (req.body.upsells || []).slice(0, 500).map(u => ({
      id: u.id, date: str(u.date, 30), type: str(u.type, 120),
      price: Number(u.price) || 0, author: str(u.author, 100), createdAt: str(u.createdAt, 40),
    }));
    await updateUpsells(+req.params.id, upsells);
    audit(req, 'client.upsell', 'client', +req.params.id, 'تسجيل بيع خدمة (Upsell)', { count: upsells.length });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const CSM_OPT_KINDS = ['condition', 'follow', 'phone_condition', 'phone_follow'];
app.post('/api/csm/options', requireCsmOrAdmin, async (req, res) => {
  try {
    const kind = CSM_OPT_KINDS.includes(req.body.kind) ? req.body.kind : 'condition';
    const label = str(req.body.label, 80);
    if (!label) return res.status(400).json({ error: 'القيمة مطلوبة' });
    await addCsmOption(kind, label);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/csm/ensure-follow-start', requireAdmin, async (_req, res) => {
  try { res.json({ ok: true, updated: await ensureFollowStart() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/csm/options/:kind/:label', requireCsmOrAdmin, async (req, res) => {
  try {
    const kind = CSM_OPT_KINDS.includes(req.params.kind) ? req.params.kind : 'condition';
    await deleteCsmOption(kind, decodeURIComponent(req.params.label));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  try { await softDelete(+req.params.id); audit(req, 'client.delete', 'client', +req.params.id, `نقل عميل #${req.params.id} إلى المهملات`); res.json({ ok: true }); }
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
    audit(req, 'plan.update', 'plan', decodeURIComponent(req.params.name), `تعديل الباقة «${decodeURIComponent(req.params.name)}»`, { newName, price });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plans/:name', requireAdmin, async (req, res) => {
  try { await deleteCustomPlan(decodeURIComponent(req.params.name)); audit(req, 'plan.delete', 'plan', decodeURIComponent(req.params.name), `حذف الباقة «${decodeURIComponent(req.params.name)}»`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Client contract (PDF) ────────────────────────────────────────────────────
// Upload a file for a client (appends — many files allowed per client)
app.post('/api/clients/:id/contract',
  requireAdmin,
  express.raw({ type: () => true, limit: '8mb' }),
  async (req, res) => {
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0)
        return res.status(400).json({ error: 'ملف غير صالح' });
      const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (mime !== 'application/pdf' && !mime.startsWith('image/'))
        return res.status(415).json({ error: 'نوع الملف غير مدعوم — PDF أو صورة فقط' });
      const filename = str(req.query.name, 200) || 'file';
      const cid = await addContract(+req.params.id, filename, mime, buf);
      res.json({ ok: true, id: cid, filename });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

// Download a single file by its contract id
app.get('/api/contracts/:cid', requireAuth, async (req, res) => {
  try {
    const c = await getContractById(+req.params.cid);
    if (!c) return res.status(404).json({ error: 'لا يوجد ملف' });
    res.setHeader('Content-Type', c.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.send(c.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contracts/:cid', requireAdmin, async (req, res) => {
  try { const ok = await deleteContractById(+req.params.cid); res.json({ ok }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Note attachments (images / PDF) ──────────────────────────────────────────
app.post('/api/clients/:id/notes/:noteId/files',
  requireAuth,
  express.raw({ type: () => true, limit: '8mb' }),
  async (req, res) => {
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'ملف غير صالح' });
      const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (mime !== 'application/pdf' && !mime.startsWith('image/')) return res.status(415).json({ error: 'نوع الملف غير مدعوم — صورة أو PDF فقط' });
      const filename = str(req.query.name, 200) || 'file';
      const fid = await addNoteFile(+req.params.id, +req.params.noteId, filename, mime, buf);
      res.json({ ok: true, id: fid, name: filename, mime });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

app.get('/api/note-files/:fid', requireAuth, async (req, res) => {
  try {
    const f = await getNoteFileById(+req.params.fid);
    if (!f) return res.status(404).json({ error: 'لا يوجد ملف' });
    res.setHeader('Content-Type', f.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.send(f.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/note-files/:fid', requireAuth, async (req, res) => {
  try { const ok = await deleteNoteFileById(+req.params.fid); res.json({ ok }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Internal AI assistant (admin) — full-context Q&A over the client base ─────
const Anthropic = require('@anthropic-ai/sdk');
let _anthropic = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
const DEFAULT_PLAN_PRICES = { 'CORE':2500,'CORE+':3000,'CORE 2500':2500,'CORE 3000':3000,'PREMIUM':4000,'PREMIUM 4000':4000,'PREMIUM 4299':4299,'PREMIUM 5000':5000,'INNER CIRCLE':7000,'INNER':7000 };
function _sumPayments(c) {
  if (Array.isArray(c.payments)) return c.payments.reduce((s,p)=>s+(Number(p && p.amt)||0),0);
  return (Number(c.p1)||0)+(Number(c.p2)||0)+(Number(c.p3)||0)+(Number(c.p4)||0);
}
function _clip(s, n) { s = String(s==null?'':s).replace(/\s+/g,' ').trim(); return s.length>n ? s.slice(0,n)+'…' : s; }
// Build a compact Arabic snapshot of all clients for the model (structured + truncated notes).
function _planTotal(c, planPrices){ return ((c.customTotal!=null ? Number(c.customTotal) : (planPrices[c.plan]||0)) || 0); }
function _latestUpsellNote(c){ const ns=c.upsellNotes||[]; if(!ns.length) return null; return ns.slice().sort((a,b)=>String(b.date||b.createdAt||'').localeCompare(String(a.date||a.createdAt||'')))[0]; }
// Derived upsell mark (mirrors the front-end logic) so the assistant can answer upsell questions.
function _upsellMark(c){
  const l=_latestUpsellNote(c); if(!l) return '—';
  const it=l.intent||[], st=l.state||'';
  if(st==='بيع' || it.includes('تمت الترقية')) return 'تم البيع';
  if(it.includes('مهتم') || it.includes('يريد ترقية') || st==='إحتياج') return 'جاهز';
  if(it.includes('قيد التفكير') || st==='تحدي او هدف قادم' || st==='نتيجة محصلة' || st==='طلب معاودة الاتصال' || st==='موعد مجدول') return 'يحتاج وقت';
  if(it.includes('لا يملك ميزانية حالياً') || st==='غير مهتم حاليا' || st==='غير مهتم حالياً') return 'بارد';
  if(it.includes('غير مهتم')) return 'غير مهتم';
  return '—';
}
function _contractStateAr(c){
  if(!c || c.status==='lead' || c.status==='refunded') return c.status||'—';
  if(c.pausedAt) return 'نشط(موقوف)';
  const today=new Date().toISOString().slice(0,10);
  return (c.contractEnd && c.contractEnd < today) ? 'منتهي' : 'نشط';
}
function _upsellLastActivity(c){
  const ds=[];
  (c.upsellNotes||[]).forEach(n=>{ if(n && n.date) ds.push(String(n.date).slice(0,10)); else if(n && n.createdAt) ds.push(String(n.createdAt).slice(0,10)); });
  if(c.upsellContactedAt) ds.push(String(c.upsellContactedAt).slice(0,10));
  ds.sort(); return ds.length ? ds[ds.length-1] : '';
}
// Stale upsell follow-up (mirrors the front-end "متابعات متأخرة" alert: ≥7 days since last activity, no future callback).
function _upsellStale(c){
  if(!c || c.status==='lead' || c.status==='refunded' || c.upsellAlertOff) return false;
  const mark=_upsellMark(c); if(mark==='تم البيع' || mark==='غير مهتم') return false;
  const engaged = !!c.upsellContactedAt || (c.upsellNotes||[]).length>0;
  if(!engaged) return false;
  const today=new Date().toISOString().slice(0,10);
  if(c.upsellSnoozeUntil && String(c.upsellSnoozeUntil) > today) return false;
  const l=_latestUpsellNote(c); const nd=l && l.nextDate;
  if(nd && String(nd) > today) return false;          // future callback planned
  const la=_upsellLastActivity(c); if(!la) return false;
  const d=Math.floor((Date.now()-new Date(la).getTime())/86400000);
  return !isNaN(d) && d>=7;
}
// Dense CSV-like snapshot (legend once, values per row) to minimise tokens.
// Notes are included ONLY in detailed mode (they are large and expensive).
function buildClientSnapshot(clients, planPrices, withNotes) {
  const header = 'الأعمدة: id | الاسم | الباقة | الإجمالي$ | مدفوع$ | متبقٍ$ | القناة | المغلق | المسوّق | الحالة | العقد(نشط/منتهي) | التسجيل | نهاية_العقد | الميلاد | مكالمات_مستخدم/كلي | مبيعات_سابقة | أبسيل_الوضع | محتمل | تم_التواصل_أبسيل | موعد_رجوع | آخر_نشاط_أبسيل | متابعة_متأخرة | الهاتف | البريد';
  const rows = clients.map(c => {
    const total = _planTotal(c, planPrices), paid = _sumPayments(c), rem = Math.max(0, total - paid);
    const sales = (c.upgrades||[]).length + (c.upsells||[]).length;
    const nx = (_latestUpsellNote(c)||{}).nextDate || '—';
    return [c.id, c.name||'—', c.plan||'—', total, paid, rem, c.channel||'—', c.closer||'—', c.setter||'—',
      c.status||'—', _contractStateAr(c), c.regDate||'—', c.contractEnd||'—', c.birthDate||'—', `${c.callsDone||0}/${c.callsTotal||0}`,
      sales, _upsellMark(c), (c.upsellProspect?'نعم':'—'), (c.upsellContactedAt?'نعم':'—'), nx,
      (_upsellLastActivity(c)||'—'), (_upsellStale(c)?'نعم':'—'), c.phone||'—', c.email||'—'].join(' | ');
  });
  let out = header + '\n' + rows.join('\n');
  if (withNotes) {
    const blocks = [];
    for (const c of clients) {
      const notes = (c.notes||[]).map(n=>n && n.txt).filter(Boolean).join(' ⏎ ');
      const csm = (c.csmNotes||[]).map(n=>[n.condition,(n.follow||[]).join('/'),n.text].filter(Boolean).join(': ')).filter(Boolean).join(' ⏎ ');
      const ups = (c.upsellNotes||[]).map(n=>[n.state,(n.intent||[]).join('/'),n.text].filter(Boolean).join(': ')).filter(Boolean).join(' ⏎ ');
      const parts = [];
      if (notes) parts.push('ملاحظات: ' + _clip(notes, 600));
      if (csm)   parts.push('CSM: ' + _clip(csm, 400));
      if (ups)   parts.push('أبسيل: ' + _clip(ups, 250));
      if (parts.length) blocks.push(`#${c.id} ${c.name||''} — ` + parts.join(' | '));
    }
    if (blocks.length) out += '\n\n=== ملاحظات العملاء ===\n' + blocks.join('\n');
  }
  if (out.length > 600000) out = out.slice(0, 600000) + '\n…(تم الاقتصاص)';
  return out;
}
app.post('/api/assistant', requireAdmin, async (req, res) => {
  try {
    const client = getAnthropic();
    if (!client) return res.status(503).json({ error: 'المساعد غير مُفعّل — أضِف ANTHROPIC_API_KEY في إعدادات الخادم (Vercel).' });
    const question = str(req.body && req.body.question, 2000);
    if (!question) return res.status(400).json({ error: 'السؤال مطلوب' });
    // Conversation history (optional) — last few turns only, text only.
    const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-8)
      .filter(m => m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string')
      .map(m => ({ role: m.role, content: str(m.content, 4000) })) : [];

    const detailed = !!(req.body && req.body.detailed);
    const clients = await getClients();
    const custom = await getCustomPlans().catch(()=>[]);
    const planPrices = Object.assign({}, DEFAULT_PLAN_PRICES);
    (custom||[]).forEach(p => { if (p && p.name) planPrices[p.name] = Number(p.price)||0; });
    const dataset = buildClientSnapshot(clients, planPrices, detailed);

    const instructions =
`أنت المساعد الداخلي لنظام إدارة عملاء شركة "علي الحامد للإستشارات" (AH97).
- أجب بالفرنسية (المستخدم يتحدث الفرنسية)، لكن أسماء العملاء وبياناتهم بالعربية فاذكرها كما هي.
- اعتمد حصراً على قاعدة العملاء المرفقة أدناه. لا تخترع معلومات؛ إن لم تكن المعلومة موجودة قل ذلك بوضوح.
- للأسئلة الإحصائية (عدّ/تصفية/مجاميع) احسب بدقة من البيانات المرفقة، واذكر القائمة المعنية عند الحاجة.
- شرح حقول الأبسيل: «العقد» = نشط أو منتهي (العملاء المنتهون هم جمهور الأبسيل الأساسي). «أبسيل_الوضع» = جاهز (مهتم بالشراء) / يحتاج وقت / بارد / غير مهتم / تم البيع / — (لا متابعة). «محتمل» = عميل نشط حُدِّد كفرصة أبسيل أثناء متابعة CSM. «تم_التواصل_أبسيل» = نعم إذا تم الاتصال به للأبسيل. «موعد_رجوع» = تاريخ معاودة الاتصال المحدَّد. «آخر_نشاط_أبسيل» = تاريخ آخر اتصال/متابعة أبسيل. «متابعة_متأخرة» = نعم إذا مرّ ≥ 7 أيام على آخر نشاط دون متابعة جديدة (= relance en retard). «مبيعات_سابقة» = عدد الترقيات + الخدمات المُباعة.
- البيانات أعلاه كاملة وموثوقة ومحسوبة مسبقاً؛ عندما يُطلب عدد أو قائمة، امسح كل الصفوف وأعطِ رقماً نهائياً محدَّداً بثقة. لا تَطلب من المستخدم التحقق يدوياً ولا تقل إنك قد تخطئ؛ إن لم يكن الحقل موجوداً فعلاً حينها فقط وضّح ذلك.
- المبالغ بالدولار ($). كن دقيقاً ومختصراً. يمكنك استخدام تنسيق بسيط (قوائم).${detailed ? '' : `
- ملاحظة: نصوص الملاحظات غير مرفقة في هذا الوضع (للاقتصاد). إذا سُئلت عن محتوى ملاحظات العملاء، اطلب تفعيل وضع «البحث في الملاحظات».`}
- أنت للقراءة فقط: لا يمكنك تعديل أي بيانات، فقط الإجابة والتحليل.`;

    const msg = await client.messages.stream({
      model: 'claude-haiku-5-5',
      max_tokens: 4096,
      thinking: { type: 'disabled' },   // Q&A over provided data — no extended thinking (avoids empty answers / saves tokens)
      system: [
        { type: 'text', text: instructions },
        { type: 'text', text: `قاعدة العملاء (${clients.length} عميل):\n\n${dataset}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [
        ...history,
        { role: 'user', content: `(تاريخ اليوم: ${new Date().toISOString().slice(0,10)})\n\n${question}` },
      ],
    }).finalMessage();

    const answer = (msg.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    if (!answer) {
      console.warn('assistant empty answer; stop_reason =', msg.stop_reason);
      return res.json({ answer: 'تعذّر توليد إجابة — حاول إعادة صياغة السؤال.', usage: msg.usage });
    }
    res.json({ answer, usage: msg.usage });
  } catch (e) {
    console.error('assistant error:', e && e.message);
    res.status(500).json({ error: 'فشل المساعد: ' + (e && e.message || 'خطأ') });
  }
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
    if (!['admin', 'coach', 'csm', 'csm_phone'].includes(role)) return res.status(400).json({ error: 'الدور غير صحيح' });
    const ok = await createUser(str(username, 50), str(password, 200), role);
    if (!ok) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
    audit(req, 'user.create', 'user', str(username, 50), `إنشاء مستخدم «${username}» (${role})`);
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:username', requireAdmin, async (req, res) => {
  try {
    const { password, role } = req.body || {};
    if (role && !['admin', 'coach', 'csm', 'csm_phone'].includes(role)) return res.status(400).json({ error: 'الدور غير صحيح' });
    const ok = await updateUser(req.params.username, {
      password: password ? str(password, 200) : undefined,
      role,
    });
    audit(req, 'user.update', 'user', req.params.username, `تعديل مستخدم «${req.params.username}»`, { role, passwordChanged: !!password });
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:username', requireAdmin, async (req, res) => {
  try {
    if (req.user.username === req.params.username.toLowerCase())
      return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
    const ok = await deleteUser(req.params.username);
    audit(req, 'user.delete', 'user', req.params.username, `حذف مستخدم «${req.params.username}»`);
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
