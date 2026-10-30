import { useState } from 'react';
import { ago, api, useData, type Approval, type AuditRow } from '../api.ts';
import { ActorChip, ChannelBadge, Chip, Empty, useToast } from '../ui.tsx';

const STATUS_TONE: Record<Approval['status'], string> = {
  draft: 'plain',
  pending: 'pending',
  sending: 'pending',
  sent: 'ok',
  rejected: 'danger',
  failed: 'danger',
};

export function ApprovalsPage({ pulse, initialTab }: { pulse: number; initialTab: 'pending' | 'history' }) {
  const [tab, setTab] = useState<'pending' | 'history'>(initialTab);
  const { data, reload } = useData<Approval[]>(`/approvals?status=${tab}`, [pulse, tab]);

  return (
    <div className="narrow">
      <div className="page-head">
        <div>
          <h1>Approval queue</h1>
          <p className="muted">
            Every outgoing message lands here first, whether it came from Claude, a rule, or you. Nothing is sent until someone approves it.
          </p>
        </div>
        <div className="seg">
          <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>
            Pending
          </button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
            History
          </button>
        </div>
      </div>
      {data?.length === 0 && <Empty>{tab === 'pending' ? 'Nothing waiting. Ask Claude to draft a reply.' : 'No decisions yet.'}</Empty>}
      {data?.map((a) => <ApprovalCard key={a.id} a={a} onChange={reload} />)}
    </div>
  );
}

function ApprovalCard({ a, onChange }: { a: Approval; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(a.draft_body);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const toast = useToast();

  const act = async (path: string, payload: unknown, ok: string) => {
    setBusy(true);
    try {
      const r = await api<Approval>(`/approvals/${a.id}/${path}`, { method: 'POST', body: payload });
      if (r.status === 'failed') toast(`Send failed: ${r.error}`, 'err');
      else toast(ok);
      onChange();
    } catch (e) {
      toast((e as Error).message, 'err');
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const fromClaude = a.requested_by.startsWith('mcp:');

  return (
    <article className={`card approval ${a.status}`}>
      <header className="approval-head">
        <ChannelBadge channel={a.channel} />
        <div className="approval-meta">
          <div>
            <strong>{a.account_label}</strong> → {a.recipient}
          </div>
          <div className="muted small">
            {a.subject} · {ago(a.created_at)}
          </div>
        </div>
        <div className="approval-tags">
          <ActorChip actor={a.requested_by} />
          <Chip tone={STATUS_TONE[a.status]}>{a.status}</Chip>
        </div>
      </header>

      <div className="compare">
        <div>
          <label>They wrote</label>
          <div className="box quote">{a.original_body}</div>
        </div>
        <div>
          <label>
            {a.status === 'sent' ? 'Sent' : editing ? 'Edit reply' : fromClaude ? "Claude's draft" : 'Draft'}
            {a.final_body && a.final_body !== a.draft_body && <span className="edited"> · edited before sending</span>}
          </label>
          {editing ? (
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} autoFocus />
          ) : (
            <div className="box draft">{a.final_body ?? a.draft_body}</div>
          )}
        </div>
      </div>

      {a.note && <div className="muted small note">Note: {a.note}</div>}
      {a.error && <div className={`banner ${a.status === 'rejected' ? 'plain' : 'danger'} small`}>{a.status === 'rejected' ? `Reason: ${a.error}` : a.error}</div>}

      {a.status === 'pending' && !rejecting && (
        <div className="actions">
          {editing ? (
            <>
              <button className="btn ghost" onClick={() => (setEditing(false), setBody(a.draft_body))} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => act('approve', { body }, 'Edited and sent')} disabled={busy || !body.trim()}>
                Approve edited & send
              </button>
            </>
          ) : (
            <>
              <button className="btn danger-ghost" onClick={() => setRejecting(true)} disabled={busy}>
                Reject
              </button>
              <button className="btn ghost" onClick={() => setEditing(true)} disabled={busy}>
                Edit
              </button>
              <button className="btn primary" onClick={() => act('approve', {}, 'Approved and sent')} disabled={busy}>
                Approve & send
              </button>
            </>
          )}
        </div>
      )}
      {rejecting && (
        <div className="actions">
          <input className="reason" placeholder="Reason (optional, goes to the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <button className="btn ghost" onClick={() => setRejecting(false)}>
            Cancel
          </button>
          <button className="btn danger" onClick={() => act('reject', { reason }, 'Rejected. Nothing was sent.')} disabled={busy}>
            Reject draft
          </button>
        </div>
      )}
      {a.status === 'failed' && (
        <div className="actions">
          <button className="btn ghost" onClick={() => act('retry', {}, 'Back in the queue')}>
            Return to queue
          </button>
        </div>
      )}
      {a.status !== 'pending' && (
        <div className="decided muted small">
          {a.decided_by && (
            <>
              Decided by <ActorChip actor={a.decided_by} /> {ago(a.decided_at)}
            </>
          )}
          <button className="link" onClick={() => setShowAudit(!showAudit)}>
            {showAudit ? 'Hide' : 'Show'} audit trail
          </button>
        </div>
      )}
      {showAudit && <ApprovalAudit id={a.id} />}
    </article>
  );
}

function ApprovalAudit({ id }: { id: number }) {
  const { data } = useData<{ audit: AuditRow[] }>(`/approvals/${id}`);
  return (
    <ol className="mini-audit">
      {data?.audit
        .slice()
        .reverse()
        .map((r) => (
          <li key={r.id}>
            <span className="muted small">{new Date(r.created_at).toLocaleTimeString()}</span> <ActorChip actor={r.actor} /> <code>{r.action}</code>{' '}
            {r.detail}
          </li>
        ))}
    </ol>
  );
}
