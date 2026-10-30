import { ago, api, useData, type Channel } from '../api.ts';
import { ChannelBadge, Chip, useToast } from '../ui.tsx';

type HealthRow = {
  account_id: number;
  label: string;
  channel: Channel;
  address: string;
  mode: 'mock' | 'real';
  status: 'connected' | 'error' | 'unknown';
  last_sync_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_latency_ms: number | null;
  sync_count: number;
  error_count: number;
  has_credentials: boolean;
  outage: string | null;
  sent_last_hour: number;
  events: { id: number; level: 'info' | 'warn' | 'error'; message: string; created_at: string }[];
};

type Account = { id: number; rate_limit_per_hour: number };

export function HealthPage({ pulse }: { pulse: number }) {
  const { data, reload } = useData<HealthRow[]>('/health', [pulse]);
  const { data: ov } = useData<{ accounts: Account[] }>('/overview', [pulse]);
  const toast = useToast();

  const outage = async (id: number, on: boolean) => {
    try {
      await api(`/health/${id}/outage`, { method: 'POST', body: { on } });
      toast(on ? 'Outage simulated; watch the status flip' : 'Recovered');
      reload();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const syncNow = async () => {
    await api('/sync', { method: 'POST' });
    reload();
  };

  const errors = data?.filter((h) => h.status === 'error').length ?? 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Connector health</h1>
          <p className="muted">
            {errors ? `${errors} connector${errors > 1 ? 's' : ''} need attention.` : 'All connectors healthy.'} This is what monthly upkeep
            watches.
          </p>
        </div>
        <button className="btn ghost" onClick={syncNow}>
          ↻ Sync all now
        </button>
      </div>

      <div className="health-grid">
        {data?.map((h) => {
          const limit = ov?.accounts.find((a) => a.id === h.account_id)?.rate_limit_per_hour ?? 0;
          const pct = limit ? Math.min(100, (h.sent_last_hour / limit) * 100) : 0;
          return (
            <article key={h.account_id} className={`card health ${h.status}`}>
              <header>
                <ChannelBadge channel={h.channel} />
                <div>
                  <strong>{h.label}</strong>
                  <div className="muted small">{h.address}</div>
                </div>
                <span className={`status-dot ${h.status}`} title={h.status} />
              </header>
              <dl>
                <dt>Status</dt>
                <dd>
                  <Chip tone={h.status === 'connected' ? 'ok' : h.status === 'error' ? 'danger' : 'plain'}>{h.status}</Chip>{' '}
                  <Chip>{h.mode}</Chip>
                </dd>
                <dt>Last sync</dt>
                <dd>
                  {ago(h.last_sync_at)} {h.last_latency_ms != null && <span className="muted">· {h.last_latency_ms} ms</span>}
                </dd>
                <dt>Syncs / errors</dt>
                <dd>
                  {h.sync_count} / {h.error_count}
                </dd>
                <dt>Credentials</dt>
                <dd>{h.has_credentials ? <Chip tone="ok">AES-256-GCM encrypted</Chip> : <Chip tone="danger">missing</Chip>}</dd>
                <dt>Sends this hour</dt>
                <dd>
                  <div className="meter" title={`${h.sent_last_hour} of ${limit}`}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <span className="muted small">
                    {h.sent_last_hour} / {limit}
                  </span>
                </dd>
              </dl>
              {h.last_error && (
                <div className={`banner ${h.status === 'error' ? 'danger' : 'plain'} small`}>
                  Last error {ago(h.last_error_at)}: {h.last_error}
                </div>
              )}
              <ul className="events">
                {h.events.map((e) => (
                  <li key={e.id} className={e.level}>
                    <span className="muted small">{ago(e.created_at)}</span> {e.message}
                  </li>
                ))}
              </ul>
              {h.mode === 'mock' && (
                <div className="actions">
                  {h.outage ? (
                    <button className="btn ghost" onClick={() => outage(h.account_id, false)}>
                      Recover
                    </button>
                  ) : (
                    <button className="btn ghost small" onClick={() => outage(h.account_id, true)}>
                      Simulate outage
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="card upkeep">
        <h3>What gets monitored (the monthly upkeep story)</h3>
        <ul>
          <li>
            <b>Sync health</b> per connector: last successful sync, latency, error count and history, with recovery detection.
          </li>
          <li>
            <b>Credential lifecycle</b>: Google/Microsoft refresh tokens can be revoked or expire; Yahoo app passwords get rotated; the WhatsApp
            system-user token and Discord bot token can be reset. A failing sync surfaces here first.
          </li>
          <li>
            <b>Provider changes</b>: Graph/Gmail API versions, WhatsApp Cloud API versions, Discord gateway intents.
          </li>
          <li>
            <b>Send volume</b> vs the per-account rate limit, and blocked sends in the audit log (kill switch, allowlist, limits).
          </li>
          <li>
            <b>Approval queue age</b>: drafts nobody decided on, and failed sends to retry.
          </li>
        </ul>
      </div>
    </div>
  );
}
