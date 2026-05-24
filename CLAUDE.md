# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```powershell
npm install
npm start          # node server.js   → http://localhost:3000
npm run dev        # nodemon for autoreload
```

There is no test suite, linter, or build step configured. `PORT` env var overrides the default 3000.

## Two parallel codebases — only one runs

This directory contains two independent implementations of the same CRM. Be explicit about which you're touching:

1. **Node/Express app (root)** — the live, running system. Single-process Express server backed by a JSON file. This is what `npm start` boots.
2. **`secure_backend/`** — a separate Django reference/blueprint. It has its own `requirements.txt` and `manage.py`, uses Postgres + Redis + Channels, and is **not** wired into the Node app. Treat it as a parallel design artifact unless the user explicitly asks about Django/security work.

Default to the Node app unless the request clearly concerns Django, Postgres, RBAC, or WAF concerns.

## Node app architecture

Three files do everything:

- [server.js](server.js) — Express routes. Thin HTTP layer; every handler is a one-liner that calls into `db.js`. Serves [crm.html](crm.html) at `/`.
- [db.js](db.js) — In-memory store + JSON persistence. **Every mutation calls `save()` synchronously**, which rewrites the entire `crm-data.json` file (~160KB). There is no transaction layer, no concurrency control, no migrations.
- [crm.html](crm.html) — Single-page Arabic/RTL UI (~160KB, all inline CSS+JS). Calls the REST API via a small `api()` helper. No build step, no framework — vanilla JS + Chart.js from CDN.

### State model

`store` in [db.js:8-14](db.js#L8-L14) holds: `clients` (active + soft-deleted in the same array, distinguished by `deleted` flag), `closers`, `setters`, `custom_plans`, and `_nextId` (auto-increment starting at 1000; seed IDs 1–223 are reserved).

Soft delete pattern: `softDelete` flips `deleted: true` + sets `deletedAt`. `getClients()` filters out deleted; `getTrash()` returns only deleted. Permanent deletion is a separate call.

### Seed data

On first boot (no `crm-data.json` present, or empty `clients` array), [db.js:380-391](db.js#L380-L391) seeds from inline arrays `SEED_CLIENTS`, `SEED_CLOSERS`, `SEED_SETTERS`. The `mkC()` helper at [db.js:136](db.js#L136) converts the compact tuple format into full client objects. To reseed, delete `crm-data.json` and restart.

### API surface

All endpoints under `/api/*` return JSON. Client IDs are numeric, parsed with `+req.params.id`. The `clean()` helper in [server.js:21](server.js#L21) strips the internal `deleted`/`deletedAt` fields and exposes `_deletedAt` on trash responses only.

Team endpoints take `closers` or `setters` as a path segment (`/api/team/closers`, `/api/team/setters`). Name fields in URLs are URL-encoded — handlers `decodeURIComponent` them.

### Notable conventions

- All user-facing strings, names, and notes are Arabic. The HTML is `dir="rtl"`.
- The `clients[]` array is mutated in place; `unshift` is used so new clients appear first.
- `crm-data.json` is the source of truth at rest — it's checked into the working directory and contains real customer PII (names, phones, emails). Treat with care.

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
