import { upsertAccount } from './accounts.ts';
import { tagAllThreads } from './ai.ts';
import { audit } from './audit.ts';
import { channelMode, config } from './config.ts';
import { FIXTURE_ACCOUNTS } from './connectors/fixtures.ts';
import { randomId } from './crypto.ts';
import { db, getSetting, one, run, setSetting } from './db.ts';
import { syncAll } from './sync.ts';

export const TEAM = ['You', 'Sam (VA)', 'Claude'];

export const DEFAULT_RULES = [
  {
    name: 'Urgent words → high priority',
    enabled: 1,
    conditions: { anyKeywords: ['urgent', 'asap', 'by friday', 'today', 'deadline'] },
    actions: [{ type: 'set_priority', value: 'high' }],
  },
  {
    name: 'WhatsApp → assign Sam + suggest reply',
    enabled: 1,
    conditions: { channels: ['whatsapp'] },
    actions: [
      { type: 'assign', value: 'Sam (VA)' },
      { type: 'suggest_reply' },
    ],
  },
  {
    name: 'Newsletters → low priority',
    enabled: 1,
    conditions: { anyKeywords: ['unsubscribe', 'newsletter'] },
    actions: [
      { type: 'set_priority', value: 'low' },
      { type: 'add_tag', value: 'newsletter' },
    ],
  },
];

/** Wipes the demo state and rebuilds it. Real (connected) accounts are kept; their mail is re-synced. */
export async function seed(): Promise<void> {
  db.exec(`
    DELETE FROM notifications; DELETE FROM approvals; DELETE FROM messages; DELETE FROM threads;
    DELETE FROM health_events; DELETE FROM audit_log;
    DELETE FROM health WHERE account_id IN (SELECT id FROM accounts WHERE mode = 'mock');
    DELETE FROM accounts WHERE mode = 'mock';
    DELETE FROM rules; DELETE FROM team; DELETE FROM settings; DELETE FROM used_links;
  `);

  for (const name of TEAM) run('INSERT INTO team (name) VALUES (?)', name);
  for (const r of DEFAULT_RULES) {
    run(
      'INSERT INTO rules (name, enabled, conditions, actions) VALUES (?, ?, ?, ?)',
      r.name,
      r.enabled,
      JSON.stringify(r.conditions),
      JSON.stringify(r.actions),
    );
  }

  for (const fx of FIXTURE_ACCOUNTS) {
    if (channelMode(fx.channel) !== 'mock') continue;
    // A fake token, encrypted exactly like a real one, so the at-rest format is visible in the DB.
    const id = upsertAccount({
      channel: fx.channel,
      label: fx.label,
      address: fx.address,
      mode: 'mock',
      credentials: { access_token: `mock-${randomId(12)}` },
      rateLimit: config.defaultRateLimitPerHour,
    });
    audit('system', 'account.connected', `${fx.label} connected (mock)`, { type: 'account', id });
  }

  // A small health history so the status page has a story: Yahoo had an IMAP blip yesterday.
  const yahoo = one<{ id: number }>("SELECT id FROM accounts WHERE channel = 'yahoo'");
  if (yahoo) {
    const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    run(
      `INSERT INTO health_events (account_id, level, message, created_at) VALUES
        (?, 'warn', 'IMAP login slow (4.2s), retried', ?),
        (?, 'error', 'IMAP connection timed out after 15s', ?),
        (?, 'info', 'Recovered: sync succeeded', ?)`,
      yahoo.id, at(27), yahoo.id, at(26.9), yahoo.id, at(26.5),
    );
    run('UPDATE health SET error_count = 1, last_error = ?, last_error_at = ? WHERE account_id = ?', 'IMAP connection timed out after 15s', at(26.9), yahoo.id);
  }

  setSetting('seeded', '1');
  audit('system', 'seed', 'Demo data seeded');
  await syncAll({ initial: true });
  await tagAllThreads();
}

export const isSeeded = (): boolean => getSetting('seeded') === '1';
