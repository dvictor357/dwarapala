import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'inbox.db'));

// WAL lets the stdio MCP process and the web process share the file safely.
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id                   INTEGER PRIMARY KEY,
  channel              TEXT NOT NULL,
  label                TEXT NOT NULL,
  address              TEXT NOT NULL,
  mode                 TEXT NOT NULL DEFAULT 'mock',
  credentials_enc      TEXT,
  rate_limit_per_hour  INTEGER NOT NULL DEFAULT 20,
  allowlist_enabled    INTEGER NOT NULL DEFAULT 0,
  allowlist            TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, address)
);

CREATE TABLE IF NOT EXISTS team (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS threads (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  participants     TEXT NOT NULL DEFAULT '[]',
  last_message_at  TEXT NOT NULL,
  unread           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  assignee         TEXT,
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  tags             TEXT NOT NULL DEFAULT '[]',
  UNIQUE (account_id, remote_id)
);
CREATE INDEX IF NOT EXISTS threads_recent_idx ON threads (last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  remote_id   TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender      TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  body        TEXT NOT NULL,
  sent_at     TEXT NOT NULL,
  UNIQUE (thread_id, remote_id)
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, sent_at);

CREATE TABLE IF NOT EXISTS approvals (
  id                      INTEGER PRIMARY KEY,
  thread_id               INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient               TEXT NOT NULL,
  in_reply_to_message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  original_body           TEXT,
  draft_body              TEXT NOT NULL,
  final_body              TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','sending','sent','rejected','failed')),
  requested_by            TEXT NOT NULL,
  note                    TEXT,
  decided_by              TEXT,
  decided_at              TEXT,
  error                   TEXT,
  remote_draft_id         TEXT,
  remote_message_id       TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS health (
  account_id       INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'unknown',
  last_sync_at     TEXT,
  last_ok_at       TEXT,
  last_error       TEXT,
  last_error_at    TEXT,
  last_latency_ms  INTEGER,
  sync_count       INTEGER NOT NULL DEFAULT 0,
  error_count      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS health_events (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  level       TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY,
  approval_id  INTEGER REFERENCES approvals(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  delivered    INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS used_links (
  nonce    TEXT PRIMARY KEY,
  used_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  conditions  TEXT NOT NULL DEFAULT '{}',
  actions     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`);

export type SQLParam = SQLInputValue;
type Params = SQLParam[];

export const all = <T>(sql: string, ...params: Params): T[] => db.prepare(sql).all(...params) as T[];
export const one = <T>(sql: string, ...params: Params): T | undefined => db.prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: Params) => db.prepare(sql).run(...params);

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();

export function getSetting(key: string): string | null {
  return one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
