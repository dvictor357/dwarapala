import { getAccount, listAccounts, type AccountRow } from './accounts.ts';
import { audit } from './audit.ts';
import { config } from './config.ts';
import { pushInbound } from './connectors/mock.ts';
import { REPLAY_EVENTS, SIMULATED_INBOUND } from './connectors/fixtures.ts';
import { connectorFor } from './connectors/registry.ts';
import { randomId } from './crypto.ts';
import { nowIso, one, run, tx } from './db.ts';

export type InboundEvent = { threadId: number; messageId: number; accountId: number };
type InboundListener = (evts: InboundEvent[]) => Promise<void> | void;

const listeners: InboundListener[] = [];
/** Rules and AI tagging subscribe here; sync itself knows nothing about them. */
export const onInbound = (fn: InboundListener) => listeners.push(fn);

const running = new Set<number>();

/**
 * Pulls threads from one account's connector into SQLite.
 * Messages are insert-or-ignore on (thread, remote_id), so re-syncing is idempotent.
 */
export async function syncAccount(account: AccountRow, opts: { initial?: boolean } = {}): Promise<number> {
  if (running.has(account.id)) return 0;
  running.add(account.id);
  const started = Date.now();
  const fresh: InboundEvent[] = [];
  try {
    const connector = connectorFor(account);
    const threads = await connector.listThreads({ limit: 50 });

    for (const t of threads) {
      const local = one<{ id: number; last_message_at: string }>(
        'SELECT id, last_message_at FROM threads WHERE account_id = ? AND remote_id = ?',
        account.id,
        t.remoteId,
      );
      if (local && local.last_message_at >= t.lastMessageAt) continue;

      const full = await connector.getThread(t.remoteId);
      tx(() => {
        run(
          `INSERT INTO threads (account_id, remote_id, subject, participants, last_message_at, unread)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, remote_id) DO UPDATE SET
             subject = excluded.subject, participants = excluded.participants,
             last_message_at = excluded.last_message_at,
             unread = MAX(threads.unread, excluded.unread),
             status = CASE WHEN excluded.unread = 1 THEN 'open' ELSE threads.status END`,
          account.id,
          full.remoteId,
          full.subject,
          JSON.stringify(full.participants),
          full.lastMessageAt,
          full.unread ? 1 : 0,
        );
        const threadId = one<{ id: number }>(
          'SELECT id FROM threads WHERE account_id = ? AND remote_id = ?',
          account.id,
          full.remoteId,
        )!.id;
        for (const m of full.messages) {
          const res = run(
            `INSERT OR IGNORE INTO messages (thread_id, remote_id, direction, sender, recipient, body, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            threadId,
            m.remoteId,
            m.direction,
            m.sender,
            m.recipient,
            m.body,
            m.sentAt,
          );
          if (res.changes && m.direction === 'in') {
            fresh.push({ threadId, messageId: Number(res.lastInsertRowid), accountId: account.id });
          }
        }
      });
    }

    const prev = one<{ status: string }>('SELECT status FROM health WHERE account_id = ?', account.id);
    run(
      `UPDATE health SET status = 'connected', last_sync_at = ?, last_ok_at = ?, last_latency_ms = ?,
         sync_count = sync_count + 1 WHERE account_id = ?`,
      nowIso(),
      nowIso(),
      Date.now() - started,
      account.id,
    );
    if (prev?.status === 'error') {
      run(`INSERT INTO health_events (account_id, level, message) VALUES (?, 'info', 'Recovered: sync succeeded')`, account.id);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      `UPDATE health SET status = 'error', last_sync_at = ?, last_error = ?, last_error_at = ?,
         last_latency_ms = ?, error_count = error_count + 1 WHERE account_id = ?`,
      nowIso(),
      message,
      nowIso(),
      Date.now() - started,
      account.id,
    );
    run(`INSERT INTO health_events (account_id, level, message) VALUES (?, 'error', ?)`, account.id, message);
    audit('system', 'sync.error', `${account.label}: ${message}`, { type: 'account', id: account.id });
    console.error(`[sync] ${account.label}:`, message);
  } finally {
    running.delete(account.id);
  }

  // Seeded history should not fire "new message" automation as if it just arrived.
  if (fresh.length && !opts.initial) {
    for (const fn of listeners) {
      try {
        await fn(fresh);
      } catch (err) {
        console.error('[sync] inbound listener failed', err);
      }
    }
  }
  return fresh.length;
}

export async function syncAll(opts: { initial?: boolean } = {}): Promise<number> {
  const counts = await Promise.all(listAccounts().map((a) => syncAccount(a, opts)));
  return counts.reduce((a, b) => a + b, 0);
}

export function startSyncLoop(): void {
  setInterval(() => void syncAll(), config.syncIntervalSeconds * 1000).unref();
}

async function deliverToMock(accountAddress: string, payload: Parameters<typeof pushInbound>[0]) {
  if (!pushInbound(payload)) return;
  const account = listAccounts().find((a) => a.address === accountAddress && a.mode === 'mock');
  if (account) await syncAccount(account);
}

/** Scripted inbound messages that trickle in after startup during a demo. */
export function startMockReplay(): void {
  if (!config.mockReplay) return;
  for (const evt of REPLAY_EVENTS) {
    setTimeout(() => void deliverToMock(evt.accountAddress, evt), evt.afterSeconds * 1000).unref();
  }
}

let simIndex = 0;
export async function simulateInbound(): Promise<string> {
  const pick = SIMULATED_INBOUND[simIndex++ % SIMULATED_INBOUND.length];
  const id = randomId(5);
  await deliverToMock(pick.accountAddress, {
    ...pick,
    threadId: `sim-${id}`,
    message: { ...pick.message, id: `sim-${id}-a` },
  });
  return pick.subject;
}

export async function syncOne(accountId: number): Promise<void> {
  const a = getAccount(accountId);
  if (a) await syncAccount(a);
}
