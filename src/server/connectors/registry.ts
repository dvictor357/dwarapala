import type { AccountRow } from '../accounts.ts';
import { DiscordConnector } from './discord.ts';
import { GmailConnector } from './gmail.ts';
import { MockConnector } from './mock.ts';
import { OutlookConnector } from './outlook.ts';
import type { Connector } from './types.ts';
import { WhatsAppConnector } from './whatsapp.ts';
import { YahooConnector } from './yahoo.ts';

const cache = new Map<string, Connector>();

/** One connector instance per account, rebuilt when the account's mode or credentials change. */
export function connectorFor(account: AccountRow): Connector {
  const key = `${account.id}:${account.mode}:${account.credentials_enc ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let c: Connector;
  if (account.mode === 'mock') {
    c = new MockConnector(account.channel, account.id, account.address);
  } else {
    const Real = { gmail: GmailConnector, outlook: OutlookConnector, yahoo: YahooConnector, discord: DiscordConnector, whatsapp: WhatsAppConnector }[account.channel];
    c = new Real(account);
  }
  cache.set(key, c);
  return c;
}
