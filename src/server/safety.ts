import type { AccountRow } from './accounts.ts';
import { audit } from './audit.ts';
import { config } from './config.ts';
import { getSetting, one, parseJson, setSetting } from './db.ts';

export function killSwitchOn(): boolean {
  return config.envKillSwitch || getSetting('kill_switch') === 'on';
}

export function setKillSwitch(on: boolean, actor: string): void {
  setSetting('kill_switch', on ? 'on' : 'off');
  audit(actor, on ? 'killswitch.on' : 'killswitch.off', on ? 'All outgoing sends blocked' : 'Outgoing sends re-enabled');
}

/**
 * Reduces a display recipient to the comparable part:
 *   "Hannah <hannah@x.example>" -> "hannah@x.example"
 *   "Maria (+1 555 0142)"       -> "+15550142"
 *   "pixelpete"                 -> "pixelpete"
 */
export function normalizeRecipient(raw: string): string {
  const email = raw.match(/<([^>]+)>/)?.[1] ?? raw.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
  if (email) return email.toLowerCase();
  const phone = raw.match(/\+?[\d\s()-]{7,}/)?.[0];
  if (phone) return phone.replace(/[^\d+]/g, '');
  return raw.trim().toLowerCase();
}

/** Allowlist entries: exact address/number/handle, or "@domain.com" for a whole domain. */
export function allowlisted(entries: string[], recipient: string): boolean {
  const r = normalizeRecipient(recipient);
  return entries.some((e) => {
    const entry = e.trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith('@')) return r.endsWith(entry);
    return normalizeRecipient(entry) === r;
  });
}

export type SafetyVerdict = { ok: true } | { ok: false; reason: string };

/** Every send passes through here, in this order, right before the connector is called. */
export function checkSend(account: AccountRow, recipient: string): SafetyVerdict {
  if (killSwitchOn()) {
    return { ok: false, reason: config.envKillSwitch ? 'Kill switch is on (SEND_KILL_SWITCH in .env)' : 'Kill switch is on' };
  }
  if (account.allowlist_enabled) {
    const entries = parseJson<string[]>(account.allowlist, []);
    if (!allowlisted(entries, recipient)) {
      return { ok: false, reason: `Recipient ${normalizeRecipient(recipient)} is not on the ${account.label} allowlist` };
    }
  }
  const sentLastHour = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM approvals
      WHERE account_id = ? AND status IN ('sent','sending')
        AND decided_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')`,
    account.id,
  )!.n;
  if (sentLastHour >= account.rate_limit_per_hour) {
    return { ok: false, reason: `Rate limit reached for ${account.label} (${account.rate_limit_per_hour}/hour)` };
  }
  return { ok: true };
}
