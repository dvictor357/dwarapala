import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Channel } from './api.ts';

const CHANNEL_META: Record<Channel, { letter: string; name: string }> = {
  gmail: { letter: 'G', name: 'Gmail' },
  outlook: { letter: 'O', name: 'Outlook' },
  yahoo: { letter: 'Y', name: 'Yahoo' },
  discord: { letter: 'D', name: 'Discord' },
  whatsapp: { letter: 'W', name: 'WhatsApp' },
};

export function ChannelBadge({ channel, size = 'md' }: { channel: Channel; size?: 'sm' | 'md' }) {
  const m = CHANNEL_META[channel];
  return (
    <span className={`chan chan-${channel} chan-${size}`} title={m.name} aria-label={m.name}>
      {m.letter}
    </span>
  );
}

export const channelName = (c: Channel) => CHANNEL_META[c].name;

export function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: string }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function ActorChip({ actor }: { actor: string }) {
  const kind = actor.split(':')[0];
  const tone = { mcp: 'claude', user: 'user', rule: 'rule', link: 'link', system: 'plain' }[kind] ?? 'plain';
  return <Chip tone={tone}>{actor}</Chip>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

type Toast = { id: number; text: string; tone: 'ok' | 'err' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
