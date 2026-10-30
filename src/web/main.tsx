import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, usePulse, useData, type Overview } from './api.ts';
import { ToastHost, useToast } from './ui.tsx';
import { InboxPage } from './pages/Inbox.tsx';
import { ApprovalsPage } from './pages/Approvals.tsx';
import { AuditPage } from './pages/Audit.tsx';
import { HealthPage } from './pages/Health.tsx';
import { DigestPage } from './pages/Digest.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import './styles.css';

const ROUTES = [
  { id: 'inbox', label: 'Inbox', icon: '✉' },
  { id: 'approvals', label: 'Approvals', icon: '✓' },
  { id: 'digest', label: 'Digest', icon: '☀' },
  { id: 'audit', label: 'Audit log', icon: '≡' },
  { id: 'health', label: 'Health', icon: '♥' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
] as const;
type Route = (typeof ROUTES)[number]['id'];

function useHashRoute(): [Route, string | null] {
  const read = () => {
    const [r, arg] = location.hash.replace(/^#\/?/, '').split('/');
    return [(ROUTES.some((x) => x.id === r) ? r : 'inbox') as Route, arg ?? null] as [Route, string | null];
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const on = () => setState(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return state;
}

function App() {
  const [route, arg] = useHashRoute();
  const pulse = usePulse();
  const { data: ov, reload } = useData<Overview>('/overview', [pulse]);
  const toast = useToast();

  const simulate = async () => {
    try {
      const r = await api<{ subject: string }>('/simulate', { method: 'POST' });
      toast(`New inbound: ${r.subject}`);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const toggleKill = async () => {
    if (!ov) return;
    try {
      await api('/settings', { method: 'PATCH', body: { killSwitch: !ov.killSwitch } });
      reload();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <div>
            <strong>One Inbox</strong>
            <small>for Claude</small>
          </div>
        </div>
        {ROUTES.map((r) => (
          <a key={r.id} href={`#/${r.id}`} className={`nav ${route === r.id ? 'active' : ''}`}>
            <span className="nav-icon">{r.icon}</span>
            {r.label}
            {r.id === 'approvals' && !!ov?.counts.pending && <span className="badge">{ov.counts.pending}</span>}
            {r.id === 'inbox' && !!ov?.counts.unread && <span className="badge soft">{ov.counts.unread}</span>}
          </a>
        ))}
        <div className="rail-foot">
          <div className={`mode ${ov?.mockMode ? 'mock' : 'real'}`}>{ov?.mockMode ? 'Mock mode' : 'Real mode'}</div>
          <div className="muted small">LLM: {ov?.llm ?? '…'}</div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="gate-note">
            <span className="lock">🔒</span> Claude can read and draft. <strong>Only you can send.</strong>
          </div>
          <div className="top-actions">
            {ov?.mockMode && (
              <button className="btn ghost" onClick={simulate} title="Push a new inbound message through a mock connector">
                + Simulate inbound
              </button>
            )}
            <button
              className={`kill ${ov?.killSwitch ? 'on' : ''}`}
              onClick={toggleKill}
              disabled={ov?.killSwitchFromEnv}
              title={ov?.killSwitchFromEnv ? 'Forced on by SEND_KILL_SWITCH in .env' : 'Blocks every outgoing send'}
            >
              <span className="kill-dot" /> {ov?.killSwitch ? 'Sending paused' : 'Sending live'}
            </button>
          </div>
        </header>
        {ov?.killSwitch && <div className="banner danger">Kill switch is on. Approvals are blocked until you turn it off.</div>}

        <section className="page">
          {route === 'inbox' && ov && <InboxPage pulse={pulse} overview={ov} threadArg={arg} />}
          {route === 'approvals' && <ApprovalsPage pulse={pulse} />}
          {route === 'digest' && <DigestPage pulse={pulse} />}
          {route === 'audit' && <AuditPage pulse={pulse} />}
          {route === 'health' && <HealthPage pulse={pulse} />}
          {route === 'settings' && ov && <SettingsPage pulse={pulse} overview={ov} reloadOverview={reload} />}
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ToastHost>
    <App />
  </ToastHost>,
);
