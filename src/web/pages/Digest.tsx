import { useState } from 'react';
import { ago, api, displayName, useData, type Channel } from '../api.ts';
import { ChannelBadge, Chip, Empty, useToast } from '../ui.tsx';

type Digest = {
  generatedAt: string;
  provider: string;
  headline: string;
  counts: { unread: number; high: number; suspicious: number; pendingApprovals: number };
  items: { threadId: number; account: string; channel: Channel; from: string; subject: string; gist: string; priority: string; tags: string[]; unread: boolean }[];
  narrative: string;
};

export function DigestPage({ pulse }: { pulse: number }) {
  const { data, reload } = useData<Digest>('/digest', [pulse]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const refresh = async () => {
    setBusy(true);
    try {
      await api('/digest?refresh=1');
      reload();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Empty>Building digest…</Empty>;

  return (
    <div className="narrow">
      <div className="page-head">
        <div>
          <h1>Daily digest</h1>
          <p className="muted">
            Across every account. Generated {ago(data.generatedAt)} by {data.provider}.
          </p>
        </div>
        <button className="btn ghost" onClick={refresh} disabled={busy}>
          ↻ Regenerate
        </button>
      </div>

      <div className="tiles">
        <div className="tile">
          <b>{data.counts.unread}</b>
          <span>unread</span>
        </div>
        <div className="tile high">
          <b>{data.counts.high}</b>
          <span>need attention</span>
        </div>
        <div className="tile danger">
          <b>{data.counts.suspicious}</b>
          <span>suspicious</span>
        </div>
        <a className="tile pending" href="#/approvals">
          <b>{data.counts.pendingApprovals}</b>
          <span>awaiting approval</span>
        </a>
      </div>

      <div className="card narrative">
        <h3>{data.headline}</h3>
        <p>{data.narrative}</p>
      </div>

      <div className="card">
        {data.items.map((i) => (
          <a key={i.threadId} className="digest-item" href={`#/inbox/${i.threadId}`}>
            <ChannelBadge channel={i.channel} size="sm" />
            <div>
              <div>
                <strong>{displayName(i.from)}</strong> <span className="muted">· {i.account}</span>
                {i.priority === 'high' && <Chip tone="high">high</Chip>}
                {i.tags.includes('suspicious') && <Chip tone="danger">suspicious</Chip>}
              </div>
              <div className="small">{i.subject}</div>
              <div className="muted small">{i.gist}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
