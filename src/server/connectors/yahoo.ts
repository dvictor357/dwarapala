import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { credentials, type AccountRow } from '../accounts.ts';
import { emailOf } from './http.ts';
import { ConnectorError, type Connector, type DraftInput, type RemoteMessage, type RemoteThread, type SendInput } from './types.ts';

/**
 * Yahoo Mail over IMAP (read) and SMTP (send) with an app password.
 * IMAP has no portable thread id, so messages are grouped by normalised
 * subject + counterpart address, and message ids are the Message-ID header.
 */
type Creds = { email: string; app_password: string };

const IMAP = { host: 'imap.mail.yahoo.com', port: 993, secure: true };
const SMTP = { host: 'smtp.mail.yahoo.com', port: 465, secure: true };

const baseSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, '').trim() || '(no subject)';
const threadKey = (subject: string, counterpart: string) =>
  createHash('sha1').update(`${baseSubject(subject).toLowerCase()}|${emailOf(counterpart).toLowerCase()}`).digest('hex').slice(0, 16);

type Parsed = { key: string; subject: string; msg: RemoteMessage; seen: boolean };

export class YahooConnector implements Connector {
  readonly channel = 'yahoo' as const;
  readonly mode = 'real' as const;
  private creds: Creds;

  constructor(private account: AccountRow) {
    const c = credentials<Creds>(account);
    if (!c?.app_password) throw new ConnectorError('yahoo', 'no app password stored (YAHOO_EMAIL / YAHOO_APP_PASSWORD)');
    this.creds = c;
  }

  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({ ...IMAP, auth: { user: this.creds.email, pass: this.creds.app_password }, logger: false, socketTimeout: 20_000 });
    try {
      await client.connect();
    } catch (err) {
      throw new ConnectorError('yahoo', `IMAP login failed: ${(err as Error).message}`, true);
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /** Last N inbox messages, parsed. Small N keeps a sync cheap. */
  private async recent(limit = 40): Promise<Parsed[]> {
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const total = typeof client.mailbox === 'object' ? client.mailbox.exists : 0;
        if (!total) return [];
        const out: Parsed[] = [];
        for await (const m of client.fetch(`${Math.max(1, total - limit + 1)}:*`, { source: true, flags: true, internalDate: true })) {
          if (!m.source) continue;
          const p = await simpleParser(m.source);
          const from = p.from?.text ?? '';
          const subject = p.subject ?? '(no subject)';
          out.push({
            key: threadKey(subject, from),
            subject: baseSubject(subject),
            seen: m.flags?.has('\\Seen') ?? false,
            msg: {
              remoteId: p.messageId ?? `uid-${m.uid}`,
              direction: emailOf(from).toLowerCase() === this.creds.email.toLowerCase() ? 'out' : 'in',
              sender: from,
              recipient: Array.isArray(p.to) ? p.to.map((a) => a.text).join(', ') : (p.to?.text ?? ''),
              body: (p.text ?? '').trim(),
              sentAt: (p.date ?? new Date(m.internalDate ?? Date.now())).toISOString(),
            },
          });
        }
        return out;
      } finally {
        lock.release();
      }
    });
  }

  async listThreads(): Promise<RemoteThread[]> {
    const byKey = new Map<string, RemoteThread>();
    for (const p of await this.recent()) {
      const t = byKey.get(p.key);
      if (!t) {
        byKey.set(p.key, { remoteId: p.key, subject: p.subject, participants: [p.msg.sender], lastMessageAt: p.msg.sentAt, unread: !p.seen });
      } else {
        if (p.msg.sentAt > t.lastMessageAt) t.lastMessageAt = p.msg.sentAt;
        t.unread ||= !p.seen;
      }
    }
    return [...byKey.values()];
  }

  async getThread(remoteId: string) {
    const parts = (await this.recent()).filter((p) => p.key === remoteId).sort((a, b) => a.msg.sentAt.localeCompare(b.msg.sentAt));
    if (!parts.length) throw new ConnectorError('yahoo', `thread ${remoteId} is no longer in the recent inbox window`);
    return {
      remoteId,
      subject: parts[0].subject,
      participants: [...new Set(parts.map((p) => p.msg.sender))],
      lastMessageAt: parts[parts.length - 1].msg.sentAt,
      unread: parts.some((p) => !p.seen),
      messages: parts.map((p) => p.msg),
    };
  }

  async createDraft(_input: DraftInput) {
    return { remoteDraftId: null }; // drafts live in the approval queue only
  }

  async send(input: SendInput) {
    const transport = nodemailer.createTransport({ ...SMTP, auth: { user: this.creds.email, pass: this.creds.app_password } });
    const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;
    const reply = input.inReplyToRemoteId?.startsWith('<') ? input.inReplyToRemoteId : undefined;
    try {
      const info = await transport.sendMail({
        from: this.creds.email,
        to: emailOf(input.recipient),
        subject,
        text: input.body,
        ...(reply ? { inReplyTo: reply, references: [reply] } : {}),
      });
      return { remoteMessageId: info.messageId };
    } catch (err) {
      throw new ConnectorError('yahoo', `SMTP send failed: ${(err as Error).message}`, true);
    }
  }

  async health() {
    await this.withImap(async () => undefined);
    return { ok: true, detail: `IMAP login ok for ${this.creds.email}` };
  }
}
