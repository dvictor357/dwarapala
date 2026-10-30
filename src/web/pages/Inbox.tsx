import { useEffect, useMemo, useState } from 'react';
import { ago, api, displayName, useData, type Approval, type Channel, type Message, type Overview, type Thread } from '../api.ts';
import { ChannelBadge, Chip, Empty, channelName, useToast } from '../ui.tsx';

type Filters = { account?: number; channel?: Channel; unread: boolean; high: boolean; status: 'open' | 'done' | 'all'; q: string };

export function InboxPage({ pulse, overview, threadArg }: { pulse: number; overview: Overview; threadArg: string | null }) {
  const [f, setF] = useState<Filters>({ unread: false, high: false, status: 'open', q: '' });
  const [q, setQ] = useState('');
  const selected = threadArg ? Number(threadArg) : null;

  // Debounce search typing.
  useEffect(() => {
    const t = setTimeout(() => setF((x) => ({ ...x, q })), 200);
    return () => clearTimeout(t);
  }, [q]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (f.account) p.set('account', String(f.account));
    if (f.channel) p.set('channel', f.channel);
    if (f.unread) p.set('unread', '1');
    if (f.high) p.set('priority', 'high');
    if (f.status !== 'all') p.set('status', f.status);
    if (f.q) p.set('q', f.q);
    return p.toString();
  }, [f]);

  const { data: threads } = useData<Thread[]>(`/threads?${qs}`, [pulse]);
  const { data: allThreads } = useData<Thread[]>('/threads?status=open', [pulse]);
  const unreadBy = (pred: (t: Thread) => boolean) => allThreads?.filter((t) => t.unread && pred(t)).length ?? 0;
  const channels = [...new Set(overview.accounts.map((a) => a.channel))];

  return (
    <div className="inbox">
      <aside className="filters">
        <button className={`filter ${!f.account && !f.channel ? 'on' : ''}`} onClick={() => setF({ ...f, account: undefined, channel: undefined })}>
          <span className="all-dot">∗</span> All accounts <span className="count">{unreadBy(() => true) || ''}</span>
        </button>
        <h4>Channels</h4>
        {channels.map((c) => (
          <button key={c} className={`filter ${f.channel === c ? 'on' : ''}`} onClick={() => setF({ ...f, channel: c, account: undefined })}>
            <ChannelBadge channel={c} size="sm" /> {channelName(c)} <span className="count">{unreadBy((t) => t.channel === c) || ''}</span>
          </button>
        ))}
        <h4>Accounts</h4>
        {overview.accounts.map((a) => (
          <button key={a.id} className={`filter ${f.account === a.id ? 'on' : ''}`} onClick={() => setF({ ...f, account: a.id, channel: undefined })}>
            <ChannelBadge channel={a.channel} size="sm" />
            <span className="filter-label">{a.label}</span>
            <span className="count">{unreadBy((t) => t.account_id === a.id) || ''}</span>
          </button>
        ))}
        <h4>Show</h4>
        <label className="check">
          <input type="checkbox" checked={f.unread} onChange={(e) => setF({ ...f, unread: e.target.checked })} /> Unread only
        </label>
        <label className="check">
          <input type="checkbox" checked={f.high} onChange={(e) => setF({ ...f, high: e.target.checked })} /> High priority
        </label>
        <div className="seg">
          {(['open', 'done', 'all'] as const).map((s) => (
            <button key={s} className={f.status === s ? 'on' : ''} onClick={() => setF({ ...f, status: s })}>
              {s}
            </button>
          ))}
        </div>
      </aside>

      <div className="list">
        <div className="search">
          <input placeholder="Search all accounts…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {threads?.length === 0 && <Empty>No threads match.</Empty>}
        {threads?.map((t) => (
          <a key={t.id} href={`#/inbox/${t.id}`} className={`row ${t.unread ? 'unread' : ''} ${selected === t.id ? 'sel' : ''}`}>
            <ChannelBadge channel={t.channel} />
            <div className="row-body">
              <div className="row-top">
                <span className="row-from">{displayName(t.last_sender)}</span>
                <span className="row-time">{ago(t.last_message_at)}</span>
              </div>
              <div className="row-subject">{t.subject}</div>
              <div className="row-snippet">{t.snippet}</div>
              <div className="row-meta">
                <span className="muted">{t.account_label}</span>
                {t.priority === 'high' && <Chip tone="high">high</Chip>}
                {t.tags.includes('suspicious') && <Chip tone="danger">suspicious</Chip>}
                {t.pending_approvals > 0 && <Chip tone="pending">{t.pending_approvals} awaiting approval</Chip>}
                {t.assignee && <Chip>{t.assignee}</Chip>}
              </div>
            </div>
          </a>
        ))}
      </div>

      <div className="detail">
        {selected ? <ThreadView id={selected} pulse={pulse} team={overview.team} /> : <Empty>Select a conversation.</Empty>}
      </div>
    </div>
  );
}

type ThreadDetail = Thread & { messages: Message[]; approvals: Approval[] };

function ThreadView({ id, pulse, team }: { id: number; pulse: number; team: string[] }) {
  const { data: t, reload } = useData<ThreadDetail>(`/threads/${id}`, [pulse]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    setDraft('');
    setWarning(null);
    void api(`/threads/${id}/read`, { method: 'POST' }).catch(() => {});
  }, [id]);

  if (!t) return <Empty>Loading…</Empty>;

  const patch = async (body: Record<string, unknown>) => {
    await api(`/threads/${id}`, { method: 'PATCH', body });
    reload();
  };

  const suggest = async () => {
    setBusy(true);
    try {
      const s = await api<{ body: string | null; warning?: string; provider: string }>(`/threads/${id}/suggest`, { method: 'POST' });
      setWarning(s.warning ?? null);
      if (s.body) setDraft(s.body);
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const queue = async () => {
    setBusy(true);
    try {
      await api(`/threads/${id}/drafts`, { method: 'POST', body: { body: draft } });
      setDraft('');
      toast('Draft added to the approval queue');
      reload();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const pending = t.approvals.filter((a) => a.status === 'pending');

  return (
    <div className="thread">
      <div className="thread-head">
        <div className="thread-title">
          <ChannelBadge channel={t.channel} />
          <div>
            <h2>{t.subject}</h2>
            <div className="muted small">
              {t.account_label} · {t.participants.join(', ')}
            </div>
          </div>
        </div>
        <div className="thread-controls">
          <select value={t.assignee ?? ''} onChange={(e) => patch({ assignee: e.target.value || null })} aria-label="Assignee">
            <option value="">Unassigned</option>
            {team.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <select value={t.priority} onChange={(e) => patch({ priority: e.target.value })} aria-label="Priority">
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
          <button className="btn ghost" onClick={() => patch({ status: t.status === 'open' ? 'done' : 'open' })}>
            {t.status === 'open' ? 'Mark done' : 'Reopen'}
          </button>
        </div>
      </div>
      {t.tags.length > 0 && (
        <div className="tags">
          {t.tags.map((tag) => (
            <Chip key={tag} tone={tag === 'suspicious' ? 'danger' : 'plain'}>
              {tag}
            </Chip>
          ))}
        </div>
      )}
      {t.tags.includes('suspicious') && (
        <div className="banner danger">
          This message looks like phishing and contains instructions aimed at AI assistants. Even if an assistant obeyed it, the worst it could do
          is create a draft that you would see here and reject.
        </div>
      )}

      <div className="messages">
        {t.messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div className="msg-head">
              <strong>{m.direction === 'out' ? 'You' : displayName(m.sender)}</strong>
              <span className="muted small">{new Date(m.sent_at).toLocaleString()}</span>
            </div>
            <div className="msg-body">{m.body}</div>
          </div>
        ))}
      </div>

      {pending.length > 0 && (
        <a href="#/approvals" className="banner pending">
          {pending.length} draft{pending.length > 1 ? 's' : ''} for this thread waiting for your approval →
        </a>
      )}

      <div className="composer">
        {warning && <div className="banner danger small">{warning}</div>}
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a reply, or ask for a suggestion…" rows={5} />
        <div className="composer-actions">
          <button className="btn ghost" onClick={suggest} disabled={busy}>
            ✨ Suggest reply
          </button>
          <span className="muted small">Replies go to the approval queue first, from you or from Claude.</span>
          <button className="btn primary" onClick={queue} disabled={busy || !draft.trim()}>
            Send for approval
          </button>
        </div>
      </div>
    </div>
  );
}
