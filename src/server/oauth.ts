import { Router } from 'express';
import { upsertAccount } from './accounts.ts';
import { audit } from './audit.ts';
import { channelMode, config } from './config.ts';
import { GOOGLE_SCOPES } from './connectors/gmail.ts';
import { fetchJson } from './connectors/http.ts';
import { MS_SCOPES } from './connectors/outlook.ts';
import { randomId, sign, verify } from './crypto.ts';
import { syncOne } from './sync.ts';

/**
 * Per-channel OAuth "connect" flows for Gmail and Outlook. Each successful
 * callback creates or updates one account; refresh tokens are stored encrypted.
 */
export const oauth = Router();

const STATE_TTL_MS = 10 * 60_000;
const redirect = (p: 'google' | 'microsoft') => `${config.appUrl}/connect/${p}/callback`;
const state = (p: string) => sign({ p, n: randomId(), exp: Date.now() + STATE_TTL_MS });
const checkState = (raw: unknown, p: string) => {
  const s = verify<{ p: string; exp: number }>(String(raw ?? ''));
  return !!s && s.p === p && s.exp > Date.now();
};

export const connectable = () => ({
  google: channelMode('gmail') === 'real' && !!config.google.clientId,
  microsoft: channelMode('outlook') === 'real' && !!config.microsoft.clientId,
});

const fail = (res: import('express').Response, msg: string) =>
  res.status(400).send(`<p style="font-family:system-ui">Connect failed: ${msg.replace(/</g, '&lt;')}</p><p><a href="/#/settings">Back</a></p>`);

oauth.get('/connect/google', (_req, res) => {
  if (!connectable().google) return void fail(res, 'set GMAIL_MODE=real (or MOCK_MODE=false) and GOOGLE_CLIENT_ID in .env');
  const q = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirect('google'),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: state('google'),
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
});

oauth.get('/connect/google/callback', async (req, res) => {
  try {
    if (!checkState(req.query.state, 'google')) return void fail(res, 'state expired or invalid, try again');
    if (req.query.error) return void fail(res, String(req.query.error));
    const t = await fetchJson<{ access_token: string; refresh_token?: string; expires_in: number; id_token?: string }>(
      'gmail',
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code ?? ''),
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirect('google'),
          grant_type: 'authorization_code',
        }),
      },
    );
    if (!t.refresh_token) return void fail(res, 'Google returned no refresh token; remove the app at myaccount.google.com/permissions and retry');
    const profile = await fetchJson<{ emailAddress: string }>('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    const id = upsertAccount({
      channel: 'gmail',
      label: `Gmail · ${profile.emailAddress}`,
      address: profile.emailAddress,
      mode: 'real',
      credentials: { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 },
      rateLimit: config.defaultRateLimitPerHour,
    });
    audit(`user:${config.operatorName}`, 'account.connected', `Connected Gmail ${profile.emailAddress}`, { type: 'account', id });
    void syncOne(id);
    res.redirect('/#/health');
  } catch (err) {
    fail(res, (err as Error).message);
  }
});

oauth.get('/connect/microsoft', (_req, res) => {
  if (!connectable().microsoft) return void fail(res, 'set OUTLOOK_MODE=real (or MOCK_MODE=false) and MS_CLIENT_ID in .env');
  const q = new URLSearchParams({
    client_id: config.microsoft.clientId,
    redirect_uri: redirect('microsoft'),
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPES,
    state: state('microsoft'),
  });
  res.redirect(`https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize?${q}`);
});

oauth.get('/connect/microsoft/callback', async (req, res) => {
  try {
    if (!checkState(req.query.state, 'microsoft')) return void fail(res, 'state expired or invalid, try again');
    if (req.query.error) return void fail(res, String(req.query.error_description ?? req.query.error));
    const t = await fetchJson<{ access_token: string; refresh_token: string; expires_in: number }>(
      'outlook',
      `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code ?? ''),
          client_id: config.microsoft.clientId,
          client_secret: config.microsoft.clientSecret,
          redirect_uri: redirect('microsoft'),
          grant_type: 'authorization_code',
          scope: MS_SCOPES,
        }),
      },
    );
    const me = await fetchJson<{ mail?: string; userPrincipalName: string }>('outlook', 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    const address = me.mail ?? me.userPrincipalName;
    const id = upsertAccount({
      channel: 'outlook',
      label: `Outlook · ${address}`,
      address,
      mode: 'real',
      credentials: { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 },
      rateLimit: config.defaultRateLimitPerHour,
    });
    audit(`user:${config.operatorName}`, 'account.connected', `Connected Outlook ${address}`, { type: 'account', id });
    void syncOne(id);
    res.redirect('/#/health');
  } catch (err) {
    fail(res, (err as Error).message);
  }
});
