-- Supabase / Postgres schema for the AH97 CRM.
-- Optional: the app self-creates these on first boot (see ensureSchema in db.js),
-- but you can paste this into the Supabase SQL Editor to create them up front.

create table if not exists clients (
  id         integer primary key,
  data       jsonb   not null,          -- the full client object
  deleted    boolean not null default false,
  deleted_at timestamptz
);
create index if not exists clients_deleted_idx on clients(deleted);

-- New client ids come from here; seed ids are 1..223, so this starts at 1000.
create sequence if not exists clients_id_seq start with 1000;

create table if not exists team_members (
  id         bigserial primary key,
  type       text    not null,          -- 'closers' | 'setters'
  name       text    not null,
  deleted    boolean not null default false,   -- deleted = true → it's in the team trash
  deleted_at timestamptz
);

create table if not exists custom_plans (
  name  text primary key,
  price jsonb
);

create table if not exists users (
  username      text primary key,       -- lowercased
  password_hash text not null,          -- pbkdf2  salt:hash
  role          text not null default 'coach',  -- 'admin' | 'coach'
  created_at    text
);

create table if not exists sessions (
  token      text primary key,
  username   text        not null,
  role       text        not null,
  expires_at timestamptz not null
);
create index if not exists sessions_expires_idx on sessions(expires_at);
