import type { Channel } from '../config.ts';
import { randomId } from '../crypto.ts';
import { getSetting } from '../db.ts';
import { FIXTURE_ACCOUNTS, type FixtureAccount, type FixtureMessage } from './fixtures.ts';
import {
  ConnectorError,
  type Connector,
  type DraftInput,
  type RemoteMessage,
  type RemoteThreadWithMessages,
  type SendInput,
} from './types.ts';

/**
 * Stands in for the provider's servers. Built from the fixtures when the process
 * starts, so timestamps are always "N minutes ago" relative to now. Sync reads
 * from here exactly as it would read from Gmail or Graph.
 */
const remote = new Map<string, Map<string, RemoteThreadWithMessages>>();
const loadedAt = Date.now();

const toRemote = (m: FixtureMessage, at: number): RemoteMessage => ({
  remoteId: m.id,
  direction: m.dir,
  sender: m.from,
  recipient: m.to,
  body: m.body,
  sentAt: new Date(at).toISOString(),
});

function load(account: FixtureAccount) {
  const threads = new Map<string, RemoteThreadWithMessages>();
  for (const t of account.threads) {
    const messages = t.messages.map((m) => toRemote(m, loadedAt - m.minutesAgo * 60_000));
    const counterpart = new Set(messages.map((m) => (m.direction === 'in' ? m.sender : m.recipient)));
    threads.set(t.id, {
      remoteId: t.id,
      subject: t.subject,
      participants: [...counterpart],
      lastMessageAt: messages[messages.length - 1].sentAt,
      unread: t.unread,
      messages,
    });
  }
  remote.set(account.address, threads);
}
FIXTURE_ACCOUNTS.forEach(load);

/** Used by the replay timer and the "Simulate inbound" button. */
export function pushInbound(input: {
  accountAddress: string;
  threadId: string;
  subject: string;
  message: { id: string; from: string; to: string; body: string };
}): boolean {
  const threads = remote.get(input.accountAddress);
  if (!threads) return false;
  const msg: RemoteMessage = {
    remoteId: input.message.id,
    direction: 'in',
    sender: input.message.from,
    recipient: input.message.to,
    body: input.message.body,
    sentAt: new Date().toISOString(),
  };
  const existing = threads.get(input.threadId);
  if (existing) {
    if (existing.messages.some((m) => m.remoteId === msg.remoteId)) return false;
    existing.messages.push(msg);
    existing.lastMessageAt = msg.sentAt;
    existing.unread = true;
  } else {
    threads.set(input.threadId, {
      remoteId: input.threadId,
      subject: input.subject,
      participants: [msg.sender],
      lastMessageAt: msg.sentAt,
      unread: true,
      messages: [msg],
    });
  }
  return true;
}

const latency = () => new Promise((r) => setTimeout(r, 80 + Math.random() * 220));

export class MockConnector implements Connector {
  readonly mode = 'mock' as const;

  constructor(
    readonly channel: Channel,
    private accountId: number,
    private address: string,
  ) {}

  private threads(): Map<string, RemoteThreadWithMessages> {
    // A flag in the DB lets the Health page demo an outage across both processes.
    const outage = getSetting(`mock_outage:${this.accountId}`);
    if (outage) throw new ConnectorError(this.channel, outage, true);
    let t = remote.get(this.address);
    if (!t) remote.set(this.address, (t = new Map()));
    return t;
  }

  async listThreads(opts: { limit?: number } = {}) {
    await latency();
    return [...this.threads().values()]
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, opts.limit ?? 50)
      .map(({ messages: _m, ...t }) => t);
  }

  async getThread(remoteId: string) {
    await latency();
    const t = this.threads().get(remoteId);
    if (!t) throw new ConnectorError(this.channel, `thread ${remoteId} not found`);
    return structuredClone(t);
  }

  async createDraft(_input: DraftInput) {
    return { remoteDraftId: `mock-draft-${randomId(6)}` };
  }

  async send(input: SendInput) {
    await latency();
    const t = this.threads().get(input.threadRemoteId);
    if (!t) throw new ConnectorError(this.channel, `thread ${input.threadRemoteId} not found`);
    const remoteId = `mock-sent-${randomId(6)}`;
    const sentAt = new Date().toISOString();
    t.messages.push({ remoteId, direction: 'out', sender: this.address, recipient: input.recipient, body: input.body, sentAt });
    t.lastMessageAt = sentAt;
    t.unread = false;
    return { remoteMessageId: remoteId };
  }

  async health() {
    const outage = getSetting(`mock_outage:${this.accountId}`);
    return outage ? { ok: false, detail: outage } : { ok: true, detail: 'mock connector (no credentials needed)' };
  }
}
