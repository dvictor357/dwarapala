import { saveCredentials } from '../accounts.ts';
import type { Channel } from '../config.ts';
import { ConnectorError } from './types.ts';

/** fetch + JSON with a timeout and an error that names the provider, status and its message. */
export async function fetchJson<T>(channel: Channel, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  } catch (err) {
    throw new ConnectorError(channel, `network error calling ${new URL(url).host}: ${(err as Error).message}`, true);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.error?.message ?? j.error_description ?? j.message ?? (typeof j.error === 'string' ? j.error : detail);
    } catch {
      /* not JSON, keep the raw text */
    }
    throw new ConnectorError(channel, `${new URL(url).host} returned ${res.status}: ${detail}`, res.status === 429 || res.status >= 500);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type OAuthCreds = { refresh_token: string; access_token?: string; expires_at?: number; email?: string };

/**
 * Keeps an OAuth access token fresh. The refreshed token is written back,
 * encrypted, so a restart does not force another refresh.
 */
export class OAuthSession {
  constructor(
    private channel: Channel,
    private accountId: number,
    private creds: OAuthCreds,
    private tokenUrl: string,
    private clientId: string,
    private clientSecret: string,
    private scope?: string,
  ) {}

  async token(): Promise<string> {
    if (this.creds.access_token && (this.creds.expires_at ?? 0) > Date.now() + 60_000) return this.creds.access_token;
    if (!this.clientId || !this.clientSecret) throw new ConnectorError(this.channel, 'OAuth client id/secret missing in .env');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.creds.refresh_token,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...(this.scope ? { scope: this.scope } : {}),
    });
    const t = await fetchJson<{ access_token: string; expires_in: number; refresh_token?: string }>(this.channel, this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).catch((err: ConnectorError) => {
      throw new ConnectorError(this.channel, `token refresh failed, reconnect the account (${err.message})`);
    });
    // Microsoft rotates refresh tokens; Google usually does not.
    this.creds = { ...this.creds, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, refresh_token: t.refresh_token ?? this.creds.refresh_token };
    saveCredentials(this.accountId, this.creds);
    return t.access_token;
  }

  async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}`, ...extra };
  }
}

export const emailOf = (raw: string): string => raw.match(/<([^>]+)>/)?.[1] ?? raw.trim();

/** Minimal RFC 5322 message for replies. Header values are stripped of CR/LF to prevent header injection. */
export function rfc822(input: { from?: string; to: string; subject: string; body: string; inReplyTo?: string | null }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;
  const headers = [
    ...(input.from ? [`From: ${clean(input.from)}`] : []),
    `To: ${clean(input.to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(clean(subject)).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    ...(input.inReplyTo ? [`In-Reply-To: ${clean(input.inReplyTo)}`, `References: ${clean(input.inReplyTo)}`] : []),
  ];
  return `${headers.join('\r\n')}\r\n\r\n${input.body.replace(/\r?\n/g, '\r\n')}`;
}
