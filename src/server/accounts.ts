import type { Channel } from './config.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { all, one, parseJson, run } from './db.ts';

export type AccountRow = {
  id: number;
  channel: Channel;
  label: string;
  address: string;
  mode: 'mock' | 'real';
  credentials_enc: string | null;
  rate_limit_per_hour: number;
  allowlist_enabled: number;
  allowlist: string;
  created_at: string;
};

/** What leaves the server. Credentials never do, only whether they exist and are encrypted. */
export type PublicAccount = Omit<AccountRow, 'credentials_enc' | 'allowlist' | 'allowlist_enabled'> & {
  allowlist: string[];
  allowlist_enabled: boolean;
  credentials: 'encrypted' | 'none';
};

export function toPublic(a: AccountRow): PublicAccount {
  const { credentials_enc, allowlist, allowlist_enabled, ...rest } = a;
  return {
    ...rest,
    allowlist: parseJson<string[]>(allowlist, []),
    allowlist_enabled: !!allowlist_enabled,
    credentials: credentials_enc ? 'encrypted' : 'none',
  };
}

export const listAccounts = (): AccountRow[] => all<AccountRow>('SELECT * FROM accounts ORDER BY id');
export const getAccount = (id: number): AccountRow | undefined => one<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);

export function credentials<T>(a: AccountRow): T | null {
  return a.credentials_enc ? decryptJson<T>(a.credentials_enc) : null;
}

export function saveCredentials(id: number, creds: unknown): void {
  run('UPDATE accounts SET credentials_enc = ? WHERE id = ?', encryptJson(creds), id);
}

export function upsertAccount(input: {
  channel: Channel;
  label: string;
  address: string;
  mode: 'mock' | 'real';
  credentials?: unknown;
  rateLimit: number;
}): number {
  const enc = input.credentials === undefined ? null : encryptJson(input.credentials);
  run(
    `INSERT INTO accounts (channel, label, address, mode, credentials_enc, rate_limit_per_hour)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, address) DO UPDATE SET
       label = excluded.label, mode = excluded.mode,
       credentials_enc = COALESCE(excluded.credentials_enc, accounts.credentials_enc)`,
    input.channel,
    input.label,
    input.address,
    input.mode,
    enc,
    input.rateLimit,
  );
  const row = one<{ id: number }>('SELECT id FROM accounts WHERE channel = ? AND address = ?', input.channel, input.address)!;
  run('INSERT OR IGNORE INTO health (account_id) VALUES (?)', row.id);
  return row.id;
}
