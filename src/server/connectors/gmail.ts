import { credentials, type AccountRow } from '../accounts.ts';
import { config } from '../config.ts';
import { emailOf, fetchJson, OAuthSession, rfc822, type OAuthCreds } from './http.ts';
import { ConnectorError, type Connector, type DraftInput, type RemoteMessage, type RemoteThread, type SendInput } from './types.ts';

/** Gmail API with a Google OAuth refresh token (scope gmail.modify: read, draft, send). */
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GOOGLE_SCOPES = 'openid email https://www.googleapis.com/auth/gmail.modify';

type Header = { name: string; value: string };
type Part = { mimeType: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
type GMessage = { id: string; threadId: string; labelIds?: string[]; internalDate: string; snippet: string; payload: Part & { headers: Header[] } };

const header = (m: GMessage, name: string) => m.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const b64 = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

function plainText(p: Part): string {
  if (p.mimeType === 'text/plain' && p.body?.data) return b64(p.body.data);
  for (const child of p.parts ?? []) {
    const t = plainText(child);
    if (t) return t;
  }
  // HTML-only mail: strip tags as a fallback.
  if (p.mimeType === 'text/html' && p.body?.data) return b64(p.body.data).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

export class GmailConnector implements Connector {
  readonly channel = 'gmail' as const;
  readonly mode = 'real' as const;
  private session: OAuthSession;

  constructor(private account: AccountRow) {
    const creds = credentials<OAuthCreds>(account);
    if (!creds?.refresh_token) throw new ConnectorError('gmail', 'no refresh token stored; connect the account from Settings');
    this.session = new OAuthSession('gmail', account.id, creds, 'https://oauth2.googleapis.com/token', config.google.clientId, config.google.clientSecret);
  }

  private async get<T>(path: string): Promise<T> {
    return fetchJson<T>('gmail', `${API}${path}`, { headers: await this.session.headers() });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return fetchJson<T>('gmail', `${API}${path}`, {
      method: 'POST',
      headers: await this.session.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
  }

  async listThreads(opts: { limit?: number } = {}): Promise<RemoteThread[]> {
    const list = await this.get<{ threads?: { id: string }[] }>(`/threads?maxResults=${Math.min(opts.limit ?? 25, 50)}&q=in:inbox`);
    const out: RemoteThread[] = [];
    for (const { id } of list.threads ?? []) {
      const t = await this.get<{ messages: GMessage[] }>(`/threads/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`);
      const last = t.messages[t.messages.length - 1];
      out.push({
        remoteId: id,
        subject: header(t.messages[0], 'Subject') || '(no subject)',
        participants: [...new Set(t.messages.map((m) => header(m, 'From')).filter((f) => !f.includes(this.account.address)))],
        lastMessageAt: new Date(Number(last.internalDate)).toISOString(),
        unread: t.messages.some((m) => m.labelIds?.includes('UNREAD')),
      });
    }
    return out;
  }

  async getThread(remoteId: string) {
    const t = await this.get<{ messages: GMessage[] }>(`/threads/${remoteId}?format=full`);
    const messages: RemoteMessage[] = t.messages.map((m) => ({
      remoteId: m.id,
      direction: m.labelIds?.includes('SENT') ? 'out' : 'in',
      sender: header(m, 'From'),
      recipient: header(m, 'To'),
      body: plainText(m.payload) || m.snippet,
      sentAt: new Date(Number(m.internalDate)).toISOString(),
    }));
    const last = messages[messages.length - 1];
    return {
      remoteId,
      subject: header(t.messages[0], 'Subject') || '(no subject)',
      participants: [...new Set(messages.filter((m) => m.direction === 'in').map((m) => m.sender))],
      lastMessageAt: last.sentAt,
      unread: t.messages.some((m) => m.labelIds?.includes('UNREAD')),
      messages,
    };
  }

  private async raw(input: DraftInput): Promise<string> {
    const messageId = input.inReplyToRemoteId
      ? header(await this.get<GMessage>(`/messages/${input.inReplyToRemoteId}?format=metadata&metadataHeaders=Message-ID`), 'Message-ID')
      : null;
    return Buffer.from(rfc822({ to: emailOf(input.recipient), subject: input.subject, body: input.body, inReplyTo: messageId })).toString('base64url');
  }

  async createDraft(input: DraftInput) {
    const d = await this.post<{ id: string }>('/drafts', { message: { raw: await this.raw(input), threadId: input.threadRemoteId } });
    return { remoteDraftId: d.id };
  }

  async send(input: SendInput) {
    // Send the approved text as a fresh message (it may have been edited), then drop the stale draft.
    const sent = await this.post<{ id: string }>('/messages/send', { raw: await this.raw(input), threadId: input.threadRemoteId });
    if (input.remoteDraftId) {
      await fetchJson('gmail', `${API}/drafts/${input.remoteDraftId}`, { method: 'DELETE', headers: await this.session.headers() }).catch(() => {});
    }
    return { remoteMessageId: sent.id };
  }

  async health() {
    const p = await this.get<{ emailAddress: string; messagesTotal: number }>('/profile');
    return { ok: true, detail: `${p.emailAddress} · ${p.messagesTotal} messages` };
  }
}
