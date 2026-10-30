import type { Channel } from './config.ts';
import { all, one, parseJson, run, type SQLParam } from './db.ts';

export type ThreadSummary = {
  id: number;
  account_id: number;
  account_label: string;
  account_address: string;
  channel: Channel;
  subject: string;
  participants: string[];
  last_message_at: string;
  unread: boolean;
  status: 'open' | 'done';
  assignee: string | null;
  priority: 'high' | 'normal' | 'low';
  tags: string[];
  snippet: string;
  last_sender: string;
  pending_approvals: number;
};

export type MessageRow = {
  id: number;
  thread_id: number;
  remote_id: string;
  direction: 'in' | 'out';
  sender: string;
  recipient: string;
  body: string;
  sent_at: string;
};

type RawThread = Omit<ThreadSummary, 'participants' | 'tags' | 'unread'> & {
  participants: string;
  tags: string;
  unread: number;
};

const inflate = (r: RawThread): ThreadSummary => ({
  ...r,
  participants: parseJson<string[]>(r.participants, []),
  tags: parseJson<string[]>(r.tags, []),
  unread: !!r.unread,
});

const BASE = `
  SELECT t.id, t.account_id, a.label AS account_label, a.address AS account_address, a.channel,
         t.subject, t.participants, t.last_message_at, t.unread, t.status, t.assignee, t.priority, t.tags,
         (SELECT substr(body, 1, 160) FROM messages m WHERE m.thread_id = t.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS snippet,
         (SELECT CASE WHEN direction = 'out' THEN 'You' ELSE sender END FROM messages m
           WHERE m.thread_id = t.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS last_sender,
         (SELECT COUNT(*) FROM approvals p WHERE p.thread_id = t.id AND p.status = 'pending') AS pending_approvals
    FROM threads t JOIN accounts a ON a.id = t.account_id`;

export type ThreadFilter = {
  accountId?: number;
  channel?: Channel;
  unread?: boolean;
  status?: 'open' | 'done';
  priority?: 'high' | 'normal' | 'low';
  q?: string;
  limit?: number;
};

export function listThreads(f: ThreadFilter = {}): ThreadSummary[] {
  const where: string[] = [];
  const params: SQLParam[] = [];
  if (f.accountId) {
    where.push('t.account_id = ?');
    params.push(f.accountId);
  }
  if (f.channel) {
    where.push('a.channel = ?');
    params.push(f.channel);
  }
  if (f.unread) where.push('t.unread = 1');
  if (f.status) {
    where.push('t.status = ?');
    params.push(f.status);
  }
  if (f.priority) {
    where.push('t.priority = ?');
    params.push(f.priority);
  }
  if (f.q?.trim()) {
    // LIKE is plenty for a demo-sized inbox; escape the wildcards so "50%" means 50%.
    const like = `%${f.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push(
      `(t.subject LIKE ? ESCAPE '\\' OR t.participants LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND (m.body LIKE ? ESCAPE '\\' OR m.sender LIKE ? ESCAPE '\\')))`,
    );
    params.push(like, like, like, like);
  }
  const sql = `${BASE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.last_message_at DESC LIMIT ?`;
  return all<RawThread>(sql, ...params, Math.min(f.limit ?? 100, 500)).map(inflate);
}

export function getThread(id: number): (ThreadSummary & { messages: MessageRow[] }) | null {
  const t = one<RawThread>(`${BASE} WHERE t.id = ?`, id);
  if (!t) return null;
  const messages = all<MessageRow>('SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at, id', id);
  return { ...inflate(t), messages };
}

export type MessageHit = MessageRow & { subject: string; channel: Channel; account_label: string };

export function searchMessages(q: string, opts: { accountId?: number; channel?: Channel; limit?: number } = {}): MessageHit[] {
  const like = `%${q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const where = [`(m.body LIKE ? ESCAPE '\\' OR m.sender LIKE ? ESCAPE '\\' OR t.subject LIKE ? ESCAPE '\\')`];
  const params: SQLParam[] = [like, like, like];
  if (opts.accountId) {
    where.push('a.id = ?');
    params.push(opts.accountId);
  }
  if (opts.channel) {
    where.push('a.channel = ?');
    params.push(opts.channel);
  }
  return all<MessageHit>(
    `SELECT m.*, t.subject, a.channel, a.label AS account_label
       FROM messages m JOIN threads t ON t.id = m.thread_id JOIN accounts a ON a.id = t.account_id
      WHERE ${where.join(' AND ')} ORDER BY m.sent_at DESC LIMIT ?`,
    ...params,
    Math.min(opts.limit ?? 20, 100),
  );
}

export const markRead = (id: number) => run('UPDATE threads SET unread = 0 WHERE id = ?', id);

export function updateThread(
  id: number,
  patch: Partial<{ status: 'open' | 'done'; assignee: string | null; priority: 'high' | 'normal' | 'low'; tags: string[]; unread: boolean }>,
): void {
  const sets: string[] = [];
  const params: SQLParam[] = [];
  if (patch.status) (sets.push('status = ?'), params.push(patch.status));
  if (patch.assignee !== undefined) (sets.push('assignee = ?'), params.push(patch.assignee));
  if (patch.priority) (sets.push('priority = ?'), params.push(patch.priority));
  if (patch.tags) (sets.push('tags = ?'), params.push(JSON.stringify([...new Set(patch.tags)])));
  if (patch.unread !== undefined) (sets.push('unread = ?'), params.push(patch.unread ? 1 : 0));
  if (!sets.length) return;
  run(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
}

/** The person a reply should go to: the sender of the latest inbound message. */
export function replyTarget(threadId: number): MessageRow | undefined {
  return one<MessageRow>(
    "SELECT * FROM messages WHERE thread_id = ? AND direction = 'in' ORDER BY sent_at DESC, id DESC LIMIT 1",
    threadId,
  );
}

export function counts() {
  return one<{ unread: number; open: number; pending: number }>(
    `SELECT (SELECT COUNT(*) FROM threads WHERE unread = 1) AS unread,
            (SELECT COUNT(*) FROM threads WHERE status = 'open') AS open,
            (SELECT COUNT(*) FROM approvals WHERE status = 'pending') AS pending`,
  )!;
}
