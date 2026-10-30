import { all, run } from './db.ts';

export type AuditAction =
  | 'seed'
  | 'account.connected'
  | 'account.updated'
  | 'sync.error'
  | 'tool.called'
  | 'draft.created'
  | 'draft.edited'
  | 'approval.approved'
  | 'approval.rejected'
  | 'send.succeeded'
  | 'send.failed'
  | 'send.blocked'
  | 'thread.updated'
  | 'rule.applied'
  | 'rule.updated'
  | 'killswitch.on'
  | 'killswitch.off'
  | 'notify.sent'
  | 'link.rejected';

export type AuditRow = {
  id: number;
  actor: string;
  action: AuditAction;
  target_type: string | null;
  target_id: string | null;
  detail: string;
  created_at: string;
};

/** Actors are free text with a prefix: "user:", "mcp:<client>", "rule:<name>", "link:telegram", "system". */
export function audit(
  actor: string,
  action: AuditAction,
  detail: string,
  target?: { type: string; id: string | number },
): void {
  run(
    'INSERT INTO audit_log (actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)',
    actor,
    action,
    target?.type ?? null,
    target ? String(target.id) : null,
    detail,
  );
}

export function listAudit(opts: { limit?: number; targetType?: string; targetId?: string } = {}): AuditRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.targetType) {
    where.push('target_type = ?');
    params.push(opts.targetType);
  }
  if (opts.targetId) {
    where.push('target_id = ?');
    params.push(opts.targetId);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return all<AuditRow>(sql, ...params, Math.min(opts.limit ?? 200, 1000));
}
