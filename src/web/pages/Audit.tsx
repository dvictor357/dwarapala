import { useState } from 'react';
import { useData, type AuditRow } from '../api.ts';
import { ActorChip, Empty } from '../ui.tsx';

const KINDS = ['all', 'mcp', 'user', 'rule', 'link', 'system'] as const;

export function AuditPage({ pulse }: { pulse: number }) {
  const { data } = useData<AuditRow[]>('/audit', [pulse]);
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all');
  const [hideReads, setHideReads] = useState(false);

  const rows = (data ?? []).filter(
    (r) => (kind === 'all' || r.actor.startsWith(kind + ':') || (kind === 'system' && r.actor === 'system')) && !(hideReads && r.action === 'tool.called'),
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted">Append-only record of who did what, when: every tool call from your agent, every draft, decision, send and block.</p>
        </div>
        <div className="audit-filters">
          <div className="seg">
            {KINDS.map((k) => (
              <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === 'mcp' ? 'Agent (MCP)' : k}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={hideReads} onChange={(e) => setHideReads(e.target.checked)} /> Hide read-only tool calls
          </label>
        </div>
      </div>
      {rows.length === 0 && <Empty>No entries.</Empty>}
      <table className="audit">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`act-${r.action.split('.')[0]} ${r.action}`}>
              <td className="nowrap muted small">{new Date(r.created_at).toLocaleString()}</td>
              <td>
                <ActorChip actor={r.actor} />
              </td>
              <td>
                <code>{r.action}</code>
              </td>
              <td>
                {r.detail}
                {r.target_type === 'approval' && <span className="muted small"> · approval #{r.target_id}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
