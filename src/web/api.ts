import { useCallback, useEffect, useRef, useState } from 'react';

export type Channel = 'gmail' | 'outlook' | 'yahoo' | 'discord' | 'whatsapp';

export type Account = {
  id: number;
  channel: Channel;
  label: string;
  address: string;
  mode: 'mock' | 'real';
  rate_limit_per_hour: number;
  allowlist: string[];
  allowlist_enabled: boolean;
  credentials: 'encrypted' | 'none';
};

export type Thread = {
  id: number;
  account_id: number;
  account_label: string;
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

export type Message = { id: number; direction: 'in' | 'out'; sender: string; recipient: string; body: string; sent_at: string };

export type Approval = {
  id: number;
  thread_id: number;
  account_id: number;
  channel: Channel;
  account_label: string;
  subject: string;
  recipient: string;
  original_body: string | null;
  draft_body: string;
  final_body: string | null;
  status: 'draft' | 'pending' | 'sending' | 'sent' | 'rejected' | 'failed';
  requested_by: string;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  error: string | null;
  created_at: string;
};

export type AuditRow = { id: number; actor: string; action: string; target_type: string | null; target_id: string | null; detail: string; created_at: string };

export type Overview = {
  counts: { unread: number; open: number; pending: number };
  killSwitch: boolean;
  killSwitchFromEnv: boolean;
  mockMode: boolean;
  llm: string;
  accounts: Account[];
  team: string[];
};

export class ApiError extends Error {}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-One-Inbox': '1' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * Bumps whenever anything changes server-side. The stdio MCP process writes to the
 * same SQLite file, so polling a cheap "pulse" catches its writes too.
 */
export function usePulse(intervalMs = 2500): number {
  const [version, setVersion] = useState(0);
  const last = useRef('');
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const p = await api<Record<string, number>>('/pulse');
        const key = JSON.stringify(p);
        if (alive && key !== last.current) {
          last.current = key;
          setVersion((v) => v + 1);
        }
      } catch {
        /* server restarting; try again next tick */
      }
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return version;
}

/** Fetches on mount and whenever `deps` change. */
export function useData<T>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, reload };
}

export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const displayName = (sender: string) => sender.replace(/<.*>/, '').replace(/\(.*\)/, '').trim() || sender;
