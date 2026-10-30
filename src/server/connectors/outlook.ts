import { credentials, type AccountRow } from '../accounts.ts';
import { config } from '../config.ts';
import { fetchJson, OAuthSession, type OAuthCreds } from './http.ts';
import { ConnectorError, type Connector, type DraftInput, type RemoteMessage, type RemoteThread, type SendInput } from './types.ts';

/** Outlook.com / Hotmail / Microsoft 365 through Microsoft Graph. Threads are Graph conversationIds. */
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MS_SCOPES = 'offline_access User.Read Mail.ReadWrite Mail.Send';

type Addr = { emailAddress: { name?: string; address: string } };
type GMsg = {
  id: string;
  conversationId: string;
  subject: string;
  from?: Addr;
  toRecipients?: Addr[];
  receivedDateTime: string;
  isRead: boolean;
  body?: { content: string };
  bodyPreview?: string;
};

const fmt = (a?: Addr) => (a ? (a.emailAddress.name ? `${a.emailAddress.name} <${a.emailAddress.address}>` : a.emailAddress.address) : '');

export class OutlookConnector implements Connector {
  readonly channel = 'outlook' as const;
  readonly mode = 'real' as const;
  private session: OAuthSession;

  constructor(private account: AccountRow) {
    const creds = credentials<OAuthCreds>(account);
    if (!creds?.refresh_token) throw new ConnectorError('outlook', 'no refresh token stored; connect the account from Settings');
    const { tenant, clientId, clientSecret } = config.microsoft;
    this.session = new OAuthSession('outlook', account.id, creds, `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, clientId, clientSecret, MS_SCOPES);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return fetchJson<T>('outlook', `${GRAPH}${path}`, {
      ...init,
      headers: await this.session.headers({ 'Content-Type': 'application/json', Prefer: 'outlook.body-content-type="text"' }),
    });
  }

  async listThreads(opts: { limit?: number } = {}): Promise<RemoteThread[]> {
    const r = await this.call<{ value: GMsg[] }>(
      `/me/mailFolders/inbox/messages?$top=${Math.min(opts.limit ?? 50, 100)}&$select=id,conversationId,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc`,
    );
    const byConv = new Map<string, RemoteThread>();
    for (const m of r.value) {
      const t = byConv.get(m.conversationId);
      if (!t) {
        byConv.set(m.conversationId, {
          remoteId: m.conversationId,
          subject: m.subject || '(no subject)',
          participants: [fmt(m.from)],
          lastMessageAt: m.receivedDateTime,
          unread: !m.isRead,
        });
      } else {
        t.unread ||= !m.isRead;
        if (!t.participants.includes(fmt(m.from))) t.participants.push(fmt(m.from));
      }
    }
    return [...byConv.values()];
  }

  async getThread(remoteId: string) {
    const filter = encodeURIComponent(`conversationId eq '${remoteId.replace(/'/g, "''")}'`);
    const r = await this.call<{ value: GMsg[] }>(
      `/me/messages?$filter=${filter}&$top=50&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,body`,
    );
    const msgs = r.value.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
    if (!msgs.length) throw new ConnectorError('outlook', `conversation ${remoteId} not found`);
    const me = this.account.address.toLowerCase();
    const messages: RemoteMessage[] = msgs.map((m) => ({
      remoteId: m.id,
      direction: m.from?.emailAddress.address.toLowerCase() === me ? 'out' : 'in',
      sender: fmt(m.from),
      recipient: (m.toRecipients ?? []).map(fmt).join(', '),
      body: m.body?.content?.trim() || m.bodyPreview || '',
      sentAt: m.receivedDateTime,
    }));
    return {
      remoteId,
      subject: msgs[0].subject || '(no subject)',
      participants: [...new Set(messages.filter((m) => m.direction === 'in').map((m) => m.sender))],
      lastMessageAt: messages[messages.length - 1].sentAt,
      unread: msgs.some((m) => !m.isRead),
      messages,
    };
  }

  async createDraft(input: DraftInput) {
    if (!input.inReplyToRemoteId) return { remoteDraftId: null };
    const d = await this.call<{ id: string }>(`/me/messages/${input.inReplyToRemoteId}/createReply`, { method: 'POST', body: JSON.stringify({}) });
    await this.call(`/me/messages/${d.id}`, { method: 'PATCH', body: JSON.stringify({ body: { contentType: 'Text', content: input.body } }) });
    return { remoteDraftId: d.id };
  }

  async send(input: SendInput) {
    let draftId = input.remoteDraftId;
    if (!draftId) draftId = (await this.createDraft(input)).remoteDraftId;
    if (!draftId) throw new ConnectorError('outlook', 'cannot reply: no message to reply to');
    // The approved text may differ from the draft, so overwrite it right before sending.
    await this.call(`/me/messages/${draftId}`, { method: 'PATCH', body: JSON.stringify({ body: { contentType: 'Text', content: input.body } }) });
    await this.call(`/me/messages/${draftId}/send`, { method: 'POST' });
    return { remoteMessageId: draftId };
  }

  async health() {
    const me = await this.call<{ mail?: string; userPrincipalName: string }>('/me?$select=mail,userPrincipalName');
    return { ok: true, detail: me.mail ?? me.userPrincipalName };
  }
}
