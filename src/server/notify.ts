import nodemailer from 'nodemailer';
import type { ApprovalView } from './approvals.ts';
import { audit } from './audit.ts';
import { config } from './config.ts';
import { randomId, sign, verify } from './crypto.ts';
import { run } from './db.ts';

export type LinkAction = 'approve' | 'reject';
export type LinkPayload = { a: number; act: LinkAction; c: string; n: string; exp: number };

const LINK_TTL_MS = 24 * 3600_000;

export function approvalLink(approvalId: number, act: LinkAction, via: string): string {
  const payload: LinkPayload = { a: approvalId, act, c: via, n: randomId(), exp: Date.now() + LINK_TTL_MS };
  return `${config.appUrl}/a/${sign(payload)}`;
}

export function readLink(token: string): LinkPayload | null {
  const p = verify<LinkPayload>(token);
  if (!p || typeof p.a !== 'number' || !['approve', 'reject'].includes(p.act)) return null;
  if (Date.now() > p.exp) return null;
  return p;
}

const clip = (s: string | null, n: number) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);

function summary(a: ApprovalView) {
  return {
    title: `Approve reply on ${a.account_label}?`,
    lines: [
      `To: ${a.recipient}`,
      `Thread: ${a.subject}`,
      `Requested by: ${a.requested_by}`,
      '',
      `They wrote: ${clip(a.original_body, 280)}`,
      '',
      `Draft: ${clip(a.draft_body, 600)}`,
    ],
  };
}

async function telegram(a: ApprovalView): Promise<void> {
  const { title, lines } = summary(a);
  const approve = approvalLink(a.id, 'approve', 'telegram');
  const reject = approvalLink(a.id, 'reject', 'telegram');
  const res = await fetch(`https://api.telegram.org/bot${config.notify.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.notify.telegramChatId,
      text: [title, '', ...lines].join('\n'),
      // URL buttons open a confirm page; the send itself needs a POST from that page.
      reply_markup: { inline_keyboard: [[{ text: '✅ Review & approve', url: approve }, { text: '❌ Reject', url: reject }]] },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage ${res.status}: ${clip(await res.text(), 200)}`);
}

async function email(a: ApprovalView): Promise<void> {
  const { title, lines } = summary(a);
  const approve = approvalLink(a.id, 'approve', 'email');
  const reject = approvalLink(a.id, 'reject', 'email');
  const transport = nodemailer.createTransport(config.notify.smtpUrl);
  await transport.sendMail({
    from: config.notify.emailFrom,
    to: config.notify.emailTo,
    subject: title,
    text: [...lines, '', `Approve: ${approve}`, `Reject: ${reject}`].join('\n'),
  });
}

/**
 * Tells the human a draft is waiting. Real channels are used when configured;
 * otherwise the message lands in the local outbox (visible in Settings) with
 * working links, so the link flow is demoable without Telegram or SMTP.
 */
export async function notifyPending(a: ApprovalView): Promise<void> {
  const targets: { channel: string; send: () => Promise<void> }[] = [];
  if (config.notify.telegramToken && config.notify.telegramChatId) targets.push({ channel: 'telegram', send: () => telegram(a) });
  if (config.notify.smtpUrl && config.notify.emailTo) targets.push({ channel: 'email', send: () => email(a) });

  if (!targets.length) {
    const { title, lines } = summary(a);
    run(
      'INSERT INTO notifications (approval_id, channel, delivered, payload) VALUES (?, ?, 0, ?)',
      a.id,
      'outbox',
      JSON.stringify({ title, lines, approve: approvalLink(a.id, 'approve', 'outbox'), reject: approvalLink(a.id, 'reject', 'outbox') }),
    );
    return;
  }

  for (const t of targets) {
    try {
      await t.send();
      run('INSERT INTO notifications (approval_id, channel, delivered, payload) VALUES (?, ?, 1, ?)', a.id, t.channel, '{}');
      audit('system', 'notify.sent', `Approval request sent via ${t.channel}`, { type: 'approval', id: a.id });
    } catch (err) {
      // A failed notification never blocks the queue; the item is still in the web UI.
      run(
        'INSERT INTO notifications (approval_id, channel, delivered, payload) VALUES (?, ?, 0, ?)',
        a.id,
        t.channel,
        JSON.stringify({ error: (err as Error).message }),
      );
      console.error(`[notify:${t.channel}]`, (err as Error).message);
    }
  }
}
