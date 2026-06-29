# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```powershell
npm install
npm start          # node server.js   → http://localhost:3000
npm run dev        # nodemon for autoreload
```

There is no test suite, linter, or build step. `PORT` overrides the default 3000.

**Required env var:** `DATABASE_URL` — Supabase Postgres connection string (use the **Transaction pooler**, port 6543, for serverless). The app connects on the first query and throws without it. There is no local fallback store. Optional seed-account vars (used only on first boot of an empty `users` collection): `LOGIN_USER`/`LOGIN_PASS` (admin), `COACH1_USER`/`COACH1_PASS`, `COACH2_USER`/`COACH2_PASS`. `MIGRATE_SECRET` gates the `/api/migrate-import` endpoint.

## Two parallel codebases — only one runs

This directory contains two independent implementations of the same CRM. Be explicit about which you're touching:

1. **Node/Express app (root)** — the live, running system. Express server backed by **Supabase / Postgres** via the `pg` driver. This is what `npm start` boots and what deploys to Vercel.
2. **`secure_backend/`** — a separate Django reference/blueprint. Own `requirements.txt` + `manage.py`, uses Postgres + Redis + Channels, and is **not** wired into the Node app. Treat it as a parallel design artifact unless the user explicitly asks about Django/security work.

Default to the Node app unless the request clearly concerns Django, Postgres, RBAC, or WAF concerns.

## Node app architecture

Two files do the backend work; the front-end is several standalone HTML pages.

- [server.js](server.js) — Express routes + auth/CORS/rate-limit middleware. Thin HTTP layer; each handler is `async` and calls into `db.js`. Serves [crm.html](crm.html) at `/`.
- [db.js](db.js) — All Postgres access via the `pg` pool. Defines the schema (`ensureSchema`), the seed data, and the exported data-access functions. **No JSON file is read or written at runtime.**
- Front-end pages (served statically by `express.static(__dirname)`): [crm.html](crm.html) (main SPA, ~260KB, all inline CSS+JS, Arabic/RTL, Chart.js from CDN), [login.html](login.html), [dashboard.html](dashboard.html), [splash.html](splash.html). No build step, no framework.

### Persistence model (Postgres, serverless-safe)

The `pg` Pool is **cached across invocations** (`getPool` in [db.js](db.js)) so a warm Vercel lambda reuses connections; use the Supabase **Transaction pooler** (port 6543) so many lambdas share a small server-side pool. Five tables (one row per entity — no single-document blob):

- **`clients`** — `id int pk`, `data jsonb` (the full client object), `deleted bool`, `deleted_at`. Reads pull `data`; mutations are per-row, so they are concurrency-safe (the old positional-array hazard is gone). `id` for new clients comes from the `clients_id_seq` sequence (starts at 1000; seed ids are 1–223).
- **`team_members`** — `type` (`'closers'`/`'setters'`), `name`, `deleted`/`deleted_at`. Active members have `deleted=false`; the team trash is the `deleted=true` rows.
- **`custom_plans`** — `name pk`, `price jsonb`.
- **`users`** — `username pk` (lowercased), `password_hash`, `role` (`admin`|`coach`), `created_at`.
- **`sessions`** — `token pk`, `username`, `role`, `expires_at`. `getSessionDB` filters `expires_at > now()`; there is no TTL job, so expired rows linger until overwritten (harmless — they never validate). In the DB rather than memory so serverless instances share auth state.

Client objects keep their `notes` array inside `data`; `updateClient` strips `notes` so only the dedicated notes endpoint writes them. JSONB params are always `JSON.stringify`'d before binding (so arrays aren't mistaken for Postgres arrays).

### Lazy init / seeding

Memoized promises guard one-time setup. `schemaReady()` runs `ensureSchema` (idempotent `CREATE TABLE IF NOT EXISTS …`, so the app self-heals even if `schema.sql` was never run). `ready()`/`ensureInit()` seeds clients + team from inline `SEED_CLIENTS`/`SEED_CLOSERS`/`SEED_SETTERS` **only when the `clients` table is empty**; `usersReady()`/`ensureUsers()` seeds the three default accounts only when `users` is empty. `mkC()` expands the compact tuple format. To reseed clients, `TRUNCATE clients` (and `team_members`) and restart.

### Auth

- Passwords: PBKDF2-SHA256, 100k iterations, per-password salt, stored as `salt:hash`; verified with `timingSafeEqual` ([db.js:48-63](db.js#L48-L63)).
- Login (`POST /api/auth/login`) returns a token; the front-end stores it in `sessionStorage` (`ah97_token`, `ah97_role`, `ah97_user`, `ah97_authed`) and sends it as `Authorization: Bearer <token>`. The `api()` helper in [crm.html](crm.html) attaches it automatically.
- Route guards: `requireAuth` (any valid session) and `requireAdmin` (role `admin` only) in [server.js:40-61](server.js#L40-L61). **Coaches are read-mostly:** GET endpoints use `requireAuth`; create/edit/delete of clients, team, plans, and users use `requireAdmin`. The only writes a coach can do are `PUT /api/clients/:id` and `PUT /api/clients/:id/notes`.
- `loginRateLimit` is an in-memory `Map` (per-IP, 10 tries / 15 min). It is **per-lambda and resets on cold start** — best-effort, not a real limiter in serverless.

### API surface

All endpoints under `/api/*` return JSON; every handler is wrapped in try/catch returning `{ error }` with a 500. Client IDs are numeric (`+req.params.id`). `clean()` ([server.js:101](server.js#L101)) strips internal `deleted`/`deletedAt` and exposes `_deletedAt` on trash responses. Team endpoints take `closers`/`setters` as a path segment; names in URLs are `decodeURIComponent`'d. `sanitizeClientBody` ([server.js:81](server.js#L81)) whitelists + length-caps incoming client fields, and `updateClient` deliberately **never** writes `notes` (notes go only through the dedicated notes endpoint).

Soft delete: `softDelete` sets `deleted:true` + `deletedAt`; `getClients` filters deleted out, `getTrash` returns only deleted. Permanent delete (`permDelete`/`emptyTrash`) `$pull`s them. Team members get a parallel trash (`team_trash`).

### Migration

The data lives in **Supabase**. `importData()` (used by `POST /api/migrate-import`, guarded by `MIGRATE_SECRET`) `TRUNCATE`s and reloads `clients`/`team_members`/`custom_plans` and resets the id sequence — it leaves `users`/`sessions` intact. [migrate-to-supabase.js](migrate-to-supabase.js) (`npm run migrate:supabase`) is the one-time MongoDB→Postgres script: it reads the old Mongo `Store` doc + users (needs both `MONGODB_URI` and `DATABASE_URL`) and preserves password hashes so logins keep working. The legacy [migrate.js](migrate.js) (JSON→Mongo) and `crm-data.json` are gitignored leftovers; `crm-data.json` still holds **real customer PII** if present.

### Deployment

Vercel serverless ([vercel.json](vercel.json)): all routes → `server.js`; `includeFiles` bundles the HTML/asset files. Security headers (CSP, HSTS, X-Frame-Options, etc.) are set in `vercel.json` for prod; CORS is handled in `server.js` against an allowlist (`consultation-lake.vercel.app` + localhost). `module.exports = app` lets Vercel import the Express app.

### Conventions

- All user-facing strings, names, notes are **Arabic**; HTML is `dir="rtl"`. API error messages are Arabic too.
- New clients are inserted at array position 0 (`$position: 0`) so they appear first.
- Roles are exactly `admin` and `coach` — validate against this set when touching user endpoints.

## secure_backend (Django, not running)

Django 4.2 project under [secure_backend/](secure_backend/) modeled as a hardened version of the same CRM. Key entry points if asked to work on it:

- Settings: [secure_backend/secure_crm/settings.py](secure_backend/secure_crm/settings.py) — postgres, Redis channels, CSP, custom user model, 2FA, encryption key from env.
- Custom middleware order matters: WAF → RateLimit → standard Django → SecurityHeaders → ActivityLog → CSP. See [secure_backend/secure_crm/settings.py:45-64](secure_backend/secure_crm/settings.py#L45-L64).
- WAF regex patterns: [secure_backend/waf/middleware.py](secure_backend/waf/middleware.py).
- RBAC roles `owner > co_owner > editor > viewer`, enforced via decorators in [secure_backend/rbac/decorators.py](secure_backend/rbac/decorators.py).
- Custom User model uses email login + UUID PK + AES-256-encrypted phone field: [secure_backend/accounts/models.py](secure_backend/accounts/models.py).
- Run commands (requires Postgres + Redis + a populated `.env` per `.env.example`):
  ```
  pip install -r secure_backend/requirements.txt
  python secure_backend/manage.py migrate
  python secure_backend/manage.py runserver
  python secure_backend/manage.py backup_db                 # pg_dump → backups/files
  python secure_backend/manage.py expire_pending_accounts   # cron candidate
  ```
