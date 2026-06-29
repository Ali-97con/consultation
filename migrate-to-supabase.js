'use strict';
// One-time migration: copy live data from MongoDB → Supabase (Postgres).
// Preserves clients, team, plans, trash, the id counter, AND user password hashes
// (so existing logins keep working). Does NOT touch sessions — users just re-login.
//
// Usage (PowerShell):
//   $env:MONGODB_URI="mongodb+srv://...";
//   $env:DATABASE_URL="postgresql://postgres.<ref>:<password>@<host>:6543/postgres";
//   node migrate-to-supabase.js
//
// Safe to re-run: it truncates and reloads the CRM tables each time.

const mongoose = require('mongoose');
const { Pool }  = require('pg');

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_URL = process.env.DATABASE_URL;
if (!MONGODB_URI || !DATABASE_URL) {
  console.error('❌ Set both MONGODB_URI and DATABASE_URL in the environment first.');
  process.exit(1);
}

// strict:false → read whatever shape Mongo holds. Collections: stores, users.
const Store = mongoose.model('Store', new mongoose.Schema({}, { strict: false }));
const User  = mongoose.model('User',  new mongoose.Schema({}, { strict: false }));

async function run() {
  console.log('🔌 Connecting to MongoDB…');
  await mongoose.connect(MONGODB_URI);
  const store = await Store.findOne({}).lean();
  const users = await User.find({}).lean();
  if (!store) { console.error('❌ No Store document found in MongoDB — nothing to migrate.'); process.exit(1); }
  await mongoose.disconnect();
  console.log(`📂 Mongo: ${ (store.clients || []).length } clients, ${ users.length } users`);

  // db.importData uses its own pooled connection (reads DATABASE_URL) and ensures the schema.
  const db = require('./db');
  console.log('⬆️  Importing clients / team / plans into Postgres…');
  await db.importData({
    clients:      store.clients      || [],
    closers:      store.closers      || [],
    setters:      store.setters      || [],
    custom_plans: store.custom_plans || [],
    team_trash:   store.team_trash   || [],
    _nextId:      store._nextId      || 1000,
  });

  // Users (with their existing password hashes) — schema already created above.
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let n = 0;
  for (const u of users) {
    if (!u.username || !u.passwordHash) continue;
    await pool.query(
      `insert into users(username, password_hash, role, created_at)
       values($1,$2,$3,$4)
       on conflict (username) do update set password_hash = excluded.password_hash, role = excluded.role`,
      [String(u.username).toLowerCase().trim(), u.passwordHash, u.role || 'coach', u.createdAt || new Date().toISOString()]);
    n++;
  }
  await pool.end();

  console.log(`✅ Migrated ${ (store.clients || []).length } clients and ${n} users to Supabase.`);
  process.exit(0);
}

run().catch(e => { console.error('❌', e); process.exit(1); });
