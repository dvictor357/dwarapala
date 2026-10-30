import { getAccount } from './accounts.ts';
import { audit } from './audit.ts';
import { connectorFor } from './connectors/registry.ts';
import { all, nowIso, one, run } from './db.ts';
import { getThread, replyTarget, type MessageRow } from './inbox.ts';
import { notifyPending } from './notify.ts';
import { checkSend } from './safety.ts';

export type ApprovalStatus = 'draft' | 'pending' | 'sending' | 'sent' | 'rejected' | 'failed';

export type ApprovalRow = {
  id: number;
  thread_id: number;
  account_id: number;
  recipient: string;
  in_reply_to_message_id: number | null;
  original_body: string | null;
  draft_body: string;
  final_body: string | null;
  status: ApprovalStatus;
  requested_by: string;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  error: string | null;
  remote_draft_id: string | null;
  remote_message_id: string | null;
  created_at: string;
};

export type ApprovalView = ApprovalRow & {
  channel: string;
  account_label: string;
  subject: string;
};

const VIEW = `
  SELECT p.*, a.channel, a.label AS account_label, t.subject
    FROM approvals p JOIN accounts a ON a.id = p.account_id JOIN threads t ON t.id = p.thread_id`;

export class ApprovalError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function listApprovals(status?: ApprovalStatus | 'history'): ApprovalView[] {
  if (status === 'history') {
    return all<ApprovalView>(`${VIEW} WHERE p.status NOT IN ('draft','pending') ORDER BY COALESCE(p.decided_at, p.created_at) DESC LIMIT 200`);
  }
  if (status) return all<ApprovalView>(`${VIEW} WHERE p.status = ? ORDER BY p.created_at DESC LIMIT 200`, status);
  return all<ApprovalView>(`${VIEW} ORDER BY p.created_at DESC LIMIT 200`);
}

export const getApproval = (id: number): ApprovalView | undefined => one<ApprovalView>(`${VIEW} WHERE p.id = ?`, id);

/**
 * Creates a reply draft for a thread. The recipient is always derived from the
 * thread (the latest inbound sender), never taken from the caller, so a model
 * cannot be talked into redirecting a reply to an arbitrary address.
 */
export async function createDraft(input: {
  threadId: number;
  body: string;
  requestedBy: string;
  note?: string;
  queue: boolean;
}): Promise<ApprovalView> {
  const body = input.body.trim();
  if (!body) throw new ApprovalError('Draft body is empty');
  if (body.length > 10_000) throw new ApprovalError('Draft body is longer than 10,000 characters');

  const thread = getThread(input.threadId);
  if (!thread) throw new ApprovalError(`Thread ${input.threadId} not found`, 404);
  const account = getAccount(thread.account_id)!;
  const target: MessageRow | undefined = replyTarget(thread.id);
  if (!target) throw new ApprovalError('Thread has no inbound message to reply to');

  let remoteDraftId: string | null = null;
  let draftNote = input.note ?? null;
  try {
    ({ remoteDraftId } = await connectorFor(account).createDraft({
      threadRemoteId: (one<{ remote_id: string }>('SELECT remote_id FROM threads WHERE id = ?', thread.id))!.remote_id,
      recipient: target.sender,
      subject: thread.subject,
      body,
      inReplyToRemoteId: target.remote_id,
    }));
  } catch (err) {
    // A provider-side draft is a convenience; the local draft is what the gate uses.
    draftNote = [draftNote, `Provider draft not created: ${(err as Error).message}`].filter(Boolean).join(' · ');
  }

  const res = run(
    `INSERT INTO approvals (thread_id, account_id, recipient, in_reply_to_message_id, original_body, draft_body,
                            status, requested_by, note, remote_draft_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    thread.id,
    account.id,
    target.sender,
    target.id,
    target.body,
    body,
    input.queue ? 'pending' : 'draft',
    input.requestedBy,
    draftNote,
    remoteDraftId,
  );
  const id = Number(res.lastInsertRowid);
  audit(
    input.requestedBy,
    'draft.created',
    `${input.queue ? 'Queued for approval' : 'Saved draft'}: reply to ${target.sender} on ${account.label}`,
    { type: 'approval', id },
  );
  const view = getApproval(id)!;
  if (input.queue) await notifyPending(view);
  return view;
}

/** Moves a saved draft into the approval queue. Optionally replaces its text first. */
export async function requestSend(id: number, actor: string, body?: string): Promise<ApprovalView> {
  const a = getApproval(id);
  if (!a) throw new ApprovalError(`Draft ${id} not found`, 404);
  if (a.status !== 'draft') throw new ApprovalError(`Draft ${id} is ${a.status}, not a draft`, 409);
  if (body !== undefined && body.trim() && body.trim() !== a.draft_body) {
    run('UPDATE approvals SET draft_body = ? WHERE id = ?', body.trim(), id);
  }
  run("UPDATE approvals SET status = 'pending' WHERE id = ? AND status = 'draft'", id);
  audit(actor, 'draft.queued', `Queued for approval: reply to ${a.recipient} on ${a.account_label}`, { type: 'approval', id });
  const view = getApproval(id)!;
  await notifyPending(view);
  return view;
}

/**
 * The only place in the codebase that calls connector.send().
 * Safety checks run first; a blocked send stays pending so the human can fix the
 * cause (lift the kill switch, edit the allowlist) and approve again.
 */
export async function approve(id: number, actor: string, editedBody?: string): Promise<ApprovalView> {
  const a = getApproval(id);
  if (!a) throw new ApprovalError(`Approval ${id} not found`, 404);
  if (a.status !== 'pending') throw new ApprovalError(`Approval ${id} is already ${a.status}`, 409);

  const finalBody = editedBody?.trim() || a.draft_body;
  const account = getAccount(a.account_id)!;

  const verdict = checkSend(account, a.recipient);
  if (!verdict.ok) {
    run('UPDATE approvals SET error = ? WHERE id = ?', `Blocked: ${verdict.reason}`, id);
    audit(actor, 'send.blocked', verdict.reason, { type: 'approval', id });
    throw new ApprovalError(verdict.reason, 423);
  }

  // Claim the row so a double click, or the UI and a Telegram link at once, cannot send twice.
  const claim = run(
    "UPDATE approvals SET status = 'sending', final_body = ?, decided_by = ?, decided_at = ?, error = NULL WHERE id = ? AND status = 'pending'",
    finalBody,
    actor,
    nowIso(),
    id,
  );
  if (!claim.changes) throw new ApprovalError(`Approval ${id} was decided by someone else`, 409);

  if (finalBody !== a.draft_body) {
    audit(actor, 'draft.edited', `Edited before sending (${a.draft_body.length} → ${finalBody.length} chars)`, { type: 'approval', id });
  }
  audit(actor, 'approval.approved', `Approved reply to ${a.recipient} on ${a.account_label}`, { type: 'approval', id });

  const thread = one<{ remote_id: string; subject: string }>('SELECT remote_id, subject FROM threads WHERE id = ?', a.thread_id)!;
  const inReplyTo = a.in_reply_to_message_id
    ? one<{ remote_id: string }>('SELECT remote_id FROM messages WHERE id = ?', a.in_reply_to_message_id)?.remote_id
    : null;

  try {
    const { remoteMessageId } = await connectorFor(account).send({
      threadRemoteId: thread.remote_id,
      recipient: a.recipient,
      subject: thread.subject,
      body: finalBody,
      inReplyToRemoteId: inReplyTo,
      remoteDraftId: a.remote_draft_id,
    });
    const at = nowIso();
    run("UPDATE approvals SET status = 'sent', remote_message_id = ? WHERE id = ?", remoteMessageId, id);
    run(
      `INSERT OR IGNORE INTO messages (thread_id, remote_id, direction, sender, recipient, body, sent_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?)`,
      a.thread_id,
      remoteMessageId,
      account.address,
      a.recipient,
      finalBody,
      at,
    );
    run('UPDATE threads SET last_message_at = ?, unread = 0 WHERE id = ?', at, a.thread_id);
    audit('system', 'send.succeeded', `Sent via ${account.label} (${account.mode}) → ${a.recipient}`, { type: 'approval', id });
  } catch (err) {
    const message = (err as Error).message;
    run("UPDATE approvals SET status = 'failed', error = ? WHERE id = ?", message, id);
    audit('system', 'send.failed', message, { type: 'approval', id });
  }
  return getApproval(id)!;
}

export function reject(id: number, actor: string, reason?: string): ApprovalView {
  const res = run(
    "UPDATE approvals SET status = 'rejected', decided_by = ?, decided_at = ?, error = ? WHERE id = ? AND status IN ('pending','draft')",
    actor,
    nowIso(),
    reason?.trim() || null,
    id,
  );
  const a = getApproval(id);
  if (!a) throw new ApprovalError(`Approval ${id} not found`, 404);
  if (!res.changes) throw new ApprovalError(`Approval ${id} is already ${a.status}`, 409);
  audit(actor, 'approval.rejected', `Rejected reply to ${a.recipient}${reason ? ` — "${reason}"` : ''}`, { type: 'approval', id });
  return a;
}

/** A failed send goes back to pending; it still needs a fresh approval. */
export function retry(id: number, actor: string): ApprovalView {
  const res = run("UPDATE approvals SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ? AND status = 'failed'", id);
  if (!res.changes) throw new ApprovalError(`Approval ${id} is not failed`, 409);
  audit(actor, 'draft.queued', 'Failed send returned to the queue', { type: 'approval', id });
  return getApproval(id)!;
}
