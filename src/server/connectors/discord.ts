import { credentials, type AccountRow } from '../accounts.ts';
import { fetchJson } from './http.ts';
import { ConnectorError, type Connector, type DraftInput, type RemoteMessage, type RemoteThread, type SendInput } from './types.ts';

/**
 * An official Discord BOT, reading and replying only in the channels/DMs listed
 * in DISCORD_CHANNEL_IDS that the bot has been added to. Never a user token:
 * automating a personal account ("self-bot") breaks Discord's Terms of Service.
 * Each channel is one thread. Reading message text in servers needs the
 * Message Content privileged intent enabled for the bot.
 */
const API = 'https://discord.com/api/v10';
const MAX_LEN = 2000;

type Creds = { bot_token: string; channel_ids: string[] };
type DMessage = { id: string; content: string; timestamp: string; author: { id: string; username: string; global_name?: string | null; bot?: boolean } };
type DChannel = { id: string; name?: string; type: number; recipients?: { username: string }[] };

export class DiscordConnector implements Connector {
  readonly channel = 'discord' as const;
  readonly mode = 'real' as const;
  private creds: Creds;
  private botId: string | null = null;

  constructor(account: AccountRow) {
    const c = credentials<Creds>(account);
    if (!c?.bot_token) throw new ConnectorError('discord', 'no bot token stored (DISCORD_BOT_TOKEN)');
    this.creds = c;
  }

  private get<T>(path: string): Promise<T> {
    return fetchJson<T>('discord', `${API}${path}`, { headers: { Authorization: `Bot ${this.creds.bot_token}` } });
  }

  private async me(): Promise<string> {
    if (!this.botId) {
      const u = await this.get<{ id: string; bot?: boolean }>('/users/@me');
      if (!u.bot) throw new ConnectorError('discord', 'token is not a bot account; refusing to run as a user (self-bots violate Discord ToS)');
      this.botId = u.id;
    }
    return this.botId;
  }

  private name = (c: DChannel) => (c.name ? `#${c.name}` : `DM · ${c.recipients?.map((r) => r.username).join(', ') ?? c.id}`);
  private who = (m: DMessage) => m.author.global_name || m.author.username;

  async listThreads(): Promise<RemoteThread[]> {
    const botId = await this.me();
    const out: RemoteThread[] = [];
    for (const id of this.creds.channel_ids) {
      const [ch, last] = await Promise.all([this.get<DChannel>(`/channels/${id}`), this.get<DMessage[]>(`/channels/${id}/messages?limit=1`)]);
      if (!last.length) continue;
      out.push({
        remoteId: id,
        subject: this.name(ch),
        participants: [],
        lastMessageAt: last[0].timestamp,
        unread: last[0].author.id !== botId,
      });
    }
    return out;
  }

  async getThread(remoteId: string) {
    const botId = await this.me();
    const [ch, msgs] = await Promise.all([this.get<DChannel>(`/channels/${remoteId}`), this.get<DMessage[]>(`/channels/${remoteId}/messages?limit=50`)]);
    const ordered = msgs.reverse().filter((m) => m.content);
    const messages: RemoteMessage[] = ordered.map((m) => ({
      remoteId: m.id,
      direction: m.author.id === botId ? 'out' : 'in',
      sender: this.who(m),
      recipient: this.name(ch),
      body: m.content,
      sentAt: m.timestamp,
    }));
    const last = ordered[ordered.length - 1];
    return {
      remoteId,
      subject: this.name(ch),
      participants: [...new Set(messages.filter((m) => m.direction === 'in').map((m) => m.sender))],
      lastMessageAt: last?.timestamp ?? new Date().toISOString(),
      unread: !!last && last.author.id !== botId,
      messages,
    };
  }

  async createDraft(_input: DraftInput) {
    return { remoteDraftId: null };
  }

  async send(input: SendInput) {
    if (input.body.length > MAX_LEN) throw new ConnectorError('discord', `message is ${input.body.length} characters; Discord allows ${MAX_LEN}`);
    const m = await fetchJson<{ id: string }>('discord', `${API}/channels/${input.threadRemoteId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${this.creds.bot_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: input.body,
        // Reply to the message we answered, and never ping @everyone/roles from an approved draft.
        ...(input.inReplyToRemoteId ? { message_reference: { message_id: input.inReplyToRemoteId, fail_if_not_exists: false } } : {}),
        allowed_mentions: { parse: ['users'] },
      }),
    });
    return { remoteMessageId: m.id };
  }

  async health() {
    await this.me();
    return { ok: true, detail: `bot ok · watching ${this.creds.channel_ids.length} channel(s)` };
  }
}
