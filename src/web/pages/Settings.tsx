import { useState } from 'react';
import { ago, api, useData, type Account, type Overview } from '../api.ts';
import { ChannelBadge, Chip, Empty, useToast } from '../ui.tsx';

type Rule = { id: number; name: string; enabled: boolean; conditions: Record<string, unknown>; actions: { type: string; value?: string }[] };
type Notification = {
  id: number;
  approval_id: number;
  channel: string;
  delivered: number;
  created_at: string;
  payload: { title?: string; lines?: string[]; approve?: string; reject?: string; error?: string };
};
type McpInfo = {
  httpUrl: string;
  sseUrl: string;
  tokenRequired: boolean;
  claudeDesktop: unknown;
  claudeDesktopRemote: unknown;
  claudeCode: string;
};

export function SettingsPage({ pulse, overview, reloadOverview }: { pulse: number; overview: Overview; reloadOverview: () => void }) {
  const toast = useToast();
  const { data: rules, reload: reloadRules } = useData<Rule[]>('/rules', [pulse]);
  const { data: notes } = useData<Notification[]>('/notifications', [pulse]);
  const { data: mcp } = useData<McpInfo>('/mcp-info');

  const kill = async (on: boolean) => {
    try {
      await api('/settings', { method: 'PATCH', body: { killSwitch: on } });
      reloadOverview();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const toggleRule = async (r: Rule) => {
    await api(`/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } });
    reloadRules();
  };

  return (
    <div className="narrow settings">
      <h1>Settings & safety</h1>

      <section className={`card killcard ${overview.killSwitch ? 'on' : ''}`}>
        <div>
          <h3>Global kill switch</h3>
          <p className="muted">Blocks every outgoing send, from every account, immediately. Drafts keep queueing so nothing is lost.</p>
          {overview.killSwitchFromEnv && <p className="small">Forced on by SEND_KILL_SWITCH in .env.</p>}
        </div>
        <button className={`btn ${overview.killSwitch ? 'primary' : 'danger'}`} onClick={() => kill(!overview.killSwitch)} disabled={overview.killSwitchFromEnv}>
          {overview.killSwitch ? 'Resume sending' : 'Stop all sending'}
        </button>
      </section>

      <section className="card">
        <h3>Per-account limits & allowlists</h3>
        <p className="muted small">
          Allowlist entries are an exact address, phone number or handle, or <code>@domain.com</code> for a whole domain.
        </p>
        {overview.accounts.map((a) => (
          <AccountSafety key={a.id} a={a} onSaved={reloadOverview} />
        ))}
      </section>

      <section className="card">
        <h3>Automation rules</h3>
        <p className="muted small">Run on every new inbound message. There is no "send" action: the strongest a rule can do is queue a draft for approval.</p>
        {rules?.map((r) => (
          <div key={r.id} className="rule">
            <label className="switch">
              <input type="checkbox" checked={r.enabled} onChange={() => toggleRule(r)} />
              <span />
            </label>
            <div>
              <strong>{r.name}</strong>
              <div className="muted small">
                when {describeConditions(r.conditions)} → {r.actions.map((x) => x.type.replace('_', ' ') + (x.value ? ` "${x.value}"` : '')).join(', ')}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>Notification outbox</h3>
        <p className="muted small">
          With <code>TELEGRAM_BOT_TOKEN</code> or <code>NOTIFY_SMTP_URL</code> set, approval requests go to Telegram / email. Otherwise they land
          here with the same signed links. Links open a confirm page; only its button sends.
        </p>
        {!notes?.length && <Empty>No notifications yet.</Empty>}
        {notes?.slice(0, 8).map((n) => (
          <div key={n.id} className="note-row">
            <div>
              <Chip>{n.channel}</Chip> <strong>{n.payload.title ?? `Approval #${n.approval_id}`}</strong>{' '}
              <span className="muted small">{ago(n.created_at)}</span>
              {n.payload.error && <div className="small danger-text">{n.payload.error}</div>}
            </div>
            {n.payload.approve && (
              <div className="note-links">
                <a href={n.payload.approve} target="_blank" rel="noreferrer">
                  Approve link ↗
                </a>
                <a href={n.payload.reject} target="_blank" rel="noreferrer">
                  Reject link ↗
                </a>
              </div>
            )}
          </div>
        ))}
      </section>

      {mcp && (
        <section className="card">
          <h3>Connect Claude (MCP)</h3>
          <p className="small">
            Streamable HTTP: <code>{mcp.httpUrl}</code> · legacy SSE: <code>{mcp.sseUrl}</code> {mcp.tokenRequired && <Chip tone="ok">token required</Chip>}
          </p>
          <label>Claude Desktop (stdio) — claude_desktop_config.json</label>
          <pre>{JSON.stringify(mcp.claudeDesktop, null, 2)}</pre>
          <label>Claude Code</label>
          <pre>{mcp.claudeCode}</pre>
        </section>
      )}
    </div>
  );
}

function describeConditions(c: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(c.channels)) parts.push(`channel is ${c.channels.join(' or ')}`);
  if (Array.isArray(c.anyKeywords)) parts.push(`message mentions ${c.anyKeywords.map((k) => `"${k}"`).join(', ')}`);
  return parts.join(' and ') || 'any message';
}

function AccountSafety({ a, onSaved }: { a: Account; onSaved: () => void }) {
  const [limit, setLimit] = useState(String(a.rate_limit_per_hour));
  const [list, setList] = useState(a.allowlist.join('\n'));
  const [enabled, setEnabled] = useState(a.allowlist_enabled);
  const toast = useToast();
  const dirty = limit !== String(a.rate_limit_per_hour) || list !== a.allowlist.join('\n') || enabled !== a.allowlist_enabled;

  const save = async () => {
    try {
      await api(`/accounts/${a.id}`, {
        method: 'PATCH',
        body: { rate_limit_per_hour: Number(limit), allowlist_enabled: enabled, allowlist: list.split('\n').map((s) => s.trim()).filter(Boolean) },
      });
      toast(`Saved ${a.label}`);
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  return (
    <div className="acct-safety">
      <div className="acct-name">
        <ChannelBadge channel={a.channel} size="sm" /> <strong>{a.label}</strong>
        <span className="muted small">{a.address}</span>
      </div>
      <label className="inline">
        Max sends / hour <input type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Only send to allowlisted recipients
      </label>
      {enabled && <textarea rows={2} value={list} onChange={(e) => setList(e.target.value)} placeholder={'@client.com\n+15550142'} />}
      {dirty && (
        <button className="btn primary small" onClick={save}>
          Save
        </button>
      )}
    </div>
  );
}
