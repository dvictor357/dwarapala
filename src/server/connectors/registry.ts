import type { AccountRow } from '../accounts.ts';
import { MockConnector } from './mock.ts';
import { ConnectorError, type Connector } from './types.ts';

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
    throw new ConnectorError(account.channel, 'real mode not available yet');
  }
  cache.set(key, c);
  return c;
}
