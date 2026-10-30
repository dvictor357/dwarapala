import { Router, type NextFunction, type Request, type Response } from 'express';
import { getAccount, listAccounts, toPublic } from './accounts.ts';
import { digest, suggestReply } from './ai.ts';
import { ApprovalError, approve, createDraft, getApproval, listApprovals, reject, retry, type ApprovalStatus } from './approvals.ts';
import { audit, listAudit } from './audit.ts';
import { CHANNEL_LABELS, CHANNELS, config } from './config.ts';
import { all, getSetting, one, parseJson, run, setSetting } from './db.ts';
import { counts, getThread, listThreads, markRead, updateThread } from './inbox.ts';
import { llm } from './llm.ts';
import { listRules, setRuleEnabled } from './rules.ts';
import { killSwitchOn, setKillSwitch } from './safety.ts';
import { simulateInbound, syncAll, syncOne } from './sync.ts';
import { mcpInfo } from './mcp/info.ts';
import { connectable } from './oauth.ts';

export const api = Router();
const ACTOR = `user:${config.operatorName}`;

type Handler = (req: Request, res: Response) => unknown;
/** Express 5 forwards rejected promises; this also maps domain errors to their status. */
const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (err instanceof ApprovalError) return void res.status(err.status).json({ error: err.message });
    next(err);
  }
};

const int = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

api.get('/overview', h(() => ({
  counts: counts(),
  killSwitch: killSwitchOn(),
  killSwitchFromEnv: config.envKillSwitch,
  mockMode: config.mockMode,
  connectable: connectable(),
  llm: llm.name,
  channels: CHANNELS.map((c) => ({ id: c, label: CHANNEL_LABELS[c] })),
  accounts: listAccounts().map(toPublic),
  team: all<{ name: string }>('SELECT name FROM team ORDER BY id').map((t) => t.name),
})));

api.get('/pulse', h(() =>
  one(
    `SELECT (SELECT COALESCE(MAX(id),0) FROM audit_log) AS audit,
            (SELECT COALESCE(MAX(id),0) FROM messages) AS messages,
            (SELECT COUNT(*) FROM approvals WHERE status = 'pending') AS pending`,
  ),
));

api.patch('/accounts/:id', h((req) => {
  const id = int(req.params.id);
  const a = id && getAccount(id);
  if (!a) throw new ApprovalError('Account not found', 404);
  const { rate_limit_per_hour, allowlist_enabled, allowlist } = req.body ?? {};
  const changes: string[] = [];
  if (rate_limit_per_hour !== undefined) {
    const n = Number(rate_limit_per_hour);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new ApprovalError('rate_limit_per_hour must be 0–10000');
    run('UPDATE accounts SET rate_limit_per_hour = ? WHERE id = ?', n, a.id);
    changes.push(`rate limit ${n}/h`);
  }
  if (allowlist_enabled !== undefined) {
    run('UPDATE accounts SET allowlist_enabled = ? WHERE id = ?', allowlist_enabled ? 1 : 0, a.id);
    changes.push(`allowlist ${allowlist_enabled ? 'on' : 'off'}`);
  }
  if (allowlist !== undefined) {
    if (!Array.isArray(allowlist) || allowlist.some((x) => typeof x !== 'string')) throw new ApprovalError('allowlist must be a list of strings');
    const clean = [...new Set(allowlist.map((x: string) => x.trim()).filter(Boolean))].slice(0, 500);
    run('UPDATE accounts SET allowlist = ? WHERE id = ?', JSON.stringify(clean), a.id);
    changes.push(`allowlist ${clean.length} entries`);
  }
  if (changes.length) audit(ACTOR, 'account.updated', `${a.label}: ${changes.join(', ')}`, { type: 'account', id: a.id });
  return toPublic(getAccount(a.id)!);
}));

api.get('/threads', h((req) =>
  listThreads({
    accountId: int(req.query.account),
    channel: oneOf(req.query.channel, CHANNELS),
    unread: req.query.unread === '1',
    status: oneOf(req.query.status, ['open', 'done'] as const),
    priority: oneOf(req.query.priority, ['high', 'normal', 'low'] as const),
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : undefined,
  }),
));

api.get('/threads/:id', h((req) => {
  const t = getThread(int(req.params.id) ?? 0);
  if (!t) throw new ApprovalError('Thread not found', 404);
  return { ...t, approvals: all('SELECT * FROM approvals WHERE thread_id = ? ORDER BY id DESC', t.id) };
}));

api.post('/threads/:id/read', h((req) => {
  markRead(int(req.params.id) ?? 0);
  return { ok: true };
}));

api.patch('/threads/:id', h((req) => {
  const id = int(req.params.id) ?? 0;
  const t = getThread(id);
  if (!t) throw new ApprovalError('Thread not found', 404);
  const b = req.body ?? {};
  const patch = {
    status: oneOf(b.status, ['open', 'done'] as const),
    priority: oneOf(b.priority, ['high', 'normal', 'low'] as const),
    assignee: b.assignee === null ? null : typeof b.assignee === 'string' ? b.assignee.slice(0, 80) : undefined,
    unread: typeof b.unread === 'boolean' ? b.unread : undefined,
  };
  updateThread(id, patch);
  const said = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} → ${v ?? 'nobody'}`);
  if (said.length) audit(ACTOR, 'thread.updated', `${t.subject}: ${said.join(', ')}`, { type: 'thread', id });
  return getThread(id);
}));

api.post('/threads/:id/suggest', h((req) => suggestReply(int(req.params.id) ?? 0)));

// Anyone composing in the UI goes through the same gate as the agent.
api.post('/threads/:id/drafts', h((req) =>
  createDraft({ threadId: int(req.params.id) ?? 0, body: String(req.body?.body ?? ''), requestedBy: ACTOR, queue: true }),
));

api.get('/approvals', h((req) => {
  const status = oneOf(req.query.status, ['draft', 'pending', 'sending', 'sent', 'rejected', 'failed', 'history'] as const);
  return listApprovals(status as ApprovalStatus | 'history' | undefined);
}));

api.get('/approvals/:id', h((req) => {
  const a = getApproval(int(req.params.id) ?? 0);
  if (!a) throw new ApprovalError('Approval not found', 404);
  return { ...a, audit: listAudit({ targetType: 'approval', targetId: String(a.id) }) };
}));

api.post('/approvals/:id/approve', h((req) =>
  approve(int(req.params.id) ?? 0, ACTOR, typeof req.body?.body === 'string' ? req.body.body : undefined),
));
api.post('/approvals/:id/reject', h((req) =>
  reject(int(req.params.id) ?? 0, ACTOR, typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined),
));
api.post('/approvals/:id/retry', h((req) => retry(int(req.params.id) ?? 0, ACTOR)));

api.get('/audit', h((req) => listAudit({ limit: int(req.query.limit) ?? 300 })));

api.get('/health', h(() => {
  const rows = all<Record<string, unknown> & { account_id: number }>(
    `SELECT h.*, a.label, a.channel, a.address, a.mode, a.credentials_enc IS NOT NULL AS has_credentials
       FROM health h JOIN accounts a ON a.id = h.account_id ORDER BY a.id`,
  );
  return rows.map((r) => ({
    ...r,
    has_credentials: !!r.has_credentials,
    outage: getSetting(`mock_outage:${r.account_id}`),
    events: all('SELECT * FROM health_events WHERE account_id = ? ORDER BY id DESC LIMIT 8', r.account_id),
    sent_last_hour: one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM approvals WHERE account_id = ? AND status = 'sent'
         AND decided_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')`,
      r.account_id,
    )!.n,
  }));
}));

// Demo control: make a mock connector fail so the Health page shows detection and recovery.
api.post('/health/:id/outage', h(async (req) => {
  const a = getAccount(int(req.params.id) ?? 0);
  if (!a || a.mode !== 'mock') throw new ApprovalError('Outage simulation is for mock accounts only');
  const key = `mock_outage:${a.id}`;
  if (req.body?.on) setSetting(key, req.body.message || `${a.channel === 'yahoo' ? 'IMAP' : 'API'} returned 503 Service Unavailable`);
  else run('DELETE FROM settings WHERE key = ?', key);
  await syncOne(a.id);
  return { ok: true };
}));

api.post('/sync', h(async () => ({ newMessages: await syncAll() })));
api.post('/simulate', h(async () => ({ subject: await simulateInbound() })));

api.get('/digest', h((req) => digest({ refresh: req.query.refresh === '1' })));

api.get('/settings', h(() => ({ killSwitch: killSwitchOn(), killSwitchFromEnv: config.envKillSwitch })));
api.patch('/settings', h((req) => {
  if (typeof req.body?.killSwitch === 'boolean') setKillSwitch(req.body.killSwitch, ACTOR);
  return { killSwitch: killSwitchOn(), killSwitchFromEnv: config.envKillSwitch };
}));

api.get('/rules', h(() => listRules()));
api.patch('/rules/:id', h((req) => {
  setRuleEnabled(int(req.params.id) ?? 0, !!req.body?.enabled, ACTOR);
  return listRules();
}));

api.get('/notifications', h(() =>
  all<{ payload: string }>('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').map((n) => ({ ...n, payload: parseJson(n.payload, {}) })),
));

api.get('/mcp-info', h(() => mcpInfo()));

