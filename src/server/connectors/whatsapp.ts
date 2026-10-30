import { createHmac, timingSafeEqual } from 'node:crypto';
import { json, Router } from 'express';
import { credentials, listAccounts, type AccountRow } from '../accounts.ts';
import { config } from '../config.ts';
import { emitInbound, ingestThread } from '../sync.ts';
import { fetchJson } from './http.ts';
import { ConnectorError, type Connector, type DraftInput, type SendInput } from './types.ts';

/**
 * WhatsApp Business Cloud API on a business number. Inbound arrives by webhook
 * (push), so listThreads() only checks reachability. A personal WhatsApp account
 * is never automated: unofficial clients get numbers banned.
 *
 * Note: free-form text replies are only allowed within 24h of the customer's last
 * message. Outside that window the API rejects the send and the approval shows
 * the error; a template message would be needed (out of scope for this demo).
 */
const VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
type Creds = { token: string; phone_number_id: string };

export class WhatsAppConnector implements Connector {
  readonly channel = 'whatsapp' as const;
  readonly mode = 'real' as const;
  private creds: Creds;

  constructor(account: AccountRow) {
    const c = credentials<Creds>(account);
    if (!c?.token || !c.phone_number_id) throw new ConnectorError('whatsapp', 'WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing');
    this.creds = c;
  }

  private url = (path: string) => `https://graph.facebook.com/${VERSION}/${path}`;
  private auth = () => ({ Authorization: `Bearer ${this.creds.token}` });

  async listThreads() {
    await this.health(); // push-based: a sync is a reachability check
    return [];
  }

  async getThread(remoteId: string): Promise<never> {
    throw new ConnectorError('whatsapp', `threads arrive by webhook; ${remoteId} cannot be fetched`);
  }

  async createDraft(_input: DraftInput) {
    return { remoteDraftId: null };
  }

  async send(input: SendInput) {
    const r = await fetchJson<{ messages: { id: string }[] }>('whatsapp', this.url(`${this.creds.phone_number_id}/messages`), {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: input.threadRemoteId, // the customer's wa_id
        type: 'text',
        text: { body: input.body, preview_url: false },
        ...(input.inReplyToRemoteId?.startsWith('wamid.') ? { context: { message_id: input.inReplyToRemoteId } } : {}),
      }),
    });
    return { remoteMessageId: r.messages[0].id };
  }

  async health() {
    const p = await fetchJson<{ display_phone_number: string; verified_name: string }>(
      'whatsapp',
      this.url(`${this.creds.phone_number_id}?fields=display_phone_number,verified_name`),
      { headers: this.auth() },
    );
    return { ok: true, detail: `${p.verified_name} · ${p.display_phone_number}` };
  }
}

/** Webhook: GET verifies the subscription, POST delivers messages (signed with the app secret). */
export const whatsappWebhook = Router();

whatsappWebhook.get('/webhooks/whatsapp', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && req.query['hub.verify_token'] === config.whatsapp.verifyToken;
  if (!ok) return void res.sendStatus(403);
  res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
});

type WaPayload = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id: string; display_phone_number: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: { id: string; from: string; timestamp: string; type: string; text?: { body: string } }[];
      };
    }[];
  }[];
};

whatsappWebhook.post('/webhooks/whatsapp', json({ verify: (req, _res, buf) => ((req as unknown as { raw: Buffer }).raw = buf) }), async (req, res) => {
  const raw = (req as unknown as { raw?: Buffer }).raw ?? Buffer.alloc(0);
  if (!config.whatsapp.appSecret) return void res.status(503).send('WHATSAPP_APP_SECRET not set');
  const sig = String(req.headers['x-hub-signature-256'] ?? '').replace(/^sha256=/, '');
  const want = createHmac('sha256', config.whatsapp.appSecret).update(raw).digest();
  const given = Buffer.from(sig, 'hex');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return void res.sendStatus(401);

  // Acknowledge fast; Meta retries slow webhooks.
  res.sendStatus(200);

  const body = req.body as WaPayload;
  for (const change of body.entry?.flatMap((e) => e.changes ?? []) ?? []) {
    const v = change.value;
    if (!v?.messages?.length || !v.metadata) continue;
    const account = listAccounts().find(
      (a) => a.channel === 'whatsapp' && a.mode === 'real' && credentials<Creds>(a)?.phone_number_id === v.metadata!.phone_number_id,
    );
    if (!account) continue;
    for (const m of v.messages) {
      const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? m.from;
      const sender = `${name} (+${m.from})`;
      const sentAt = new Date(Number(m.timestamp) * 1000).toISOString();
      const fresh = ingestThread(account.id, {
        remoteId: m.from,
        subject: name,
        participants: [sender],
        lastMessageAt: sentAt,
        unread: true,
        messages: [
          {
            remoteId: m.id,
            direction: 'in',
            sender,
            recipient: v.metadata.display_phone_number,
            body: m.type === 'text' ? (m.text?.body ?? '') : `[${m.type} message — open WhatsApp to view]`,
            sentAt,
          },
        ],
      });
      await emitInbound(fresh);
    }
  }
});
