import type { Channel } from '../config.ts';

export type RemoteMessage = {
  remoteId: string;
  direction: 'in' | 'out';
  sender: string;
  recipient: string;
  body: string;
  sentAt: string; // ISO
};

export type RemoteThread = {
  remoteId: string;
  subject: string;
  participants: string[];
  lastMessageAt: string; // ISO
  unread: boolean;
};

export type RemoteThreadWithMessages = RemoteThread & { messages: RemoteMessage[] };

export type DraftInput = {
  threadRemoteId: string;
  recipient: string;
  subject: string;
  body: string;
  inReplyToRemoteId?: string | null;
};

export type SendInput = DraftInput & { remoteDraftId?: string | null };

/**
 * The one interface every channel implements, mock or real.
 * Only approvals.ts may call send(); nothing exposed to MCP clients reaches it directly.
 */
export interface Connector {
  readonly channel: Channel;
  readonly mode: 'mock' | 'real';
  listThreads(opts?: { limit?: number }): Promise<RemoteThread[]>;
  getThread(remoteId: string): Promise<RemoteThreadWithMessages>;
  createDraft(input: DraftInput): Promise<{ remoteDraftId: string | null }>;
  send(input: SendInput): Promise<{ remoteMessageId: string }>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class ConnectorError extends Error {
  constructor(
    public channel: Channel,
    message: string,
    public retryable = false,
  ) {
    super(`[${channel}] ${message}`);
  }
}
