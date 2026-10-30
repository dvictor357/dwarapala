# One Inbox for Claude — Plan

A demo of a unified multi-account inbox (Gmail, Outlook, Yahoo, Discord bot,
WhatsApp Business) exposed to Claude through an MCP server. Claude can read,
search, summarize and draft, but **cannot send**: every outgoing message lands in
a human approval queue first.

Portfolio piece, not production. Goal: fresh clone, `cp .env.example .env`, one
command, full flow works with zero credentials (mock mode).

## 1. What I studied in the reference project

The reference is a Next.js + Postgres shared inbox for one messaging channel
family, with Meta OAuth, agents/assignment, AI workflows and an audit log. I read
its schema, inbox, workflow runner, AI provider and crypto modules for patterns
only. Nothing is copied; everything here is rewritten for a different problem.

### Reused conceptually

| Idea in the reference | Slimmed version here |
| --- | --- |
| `channels -> conversations -> messages`, one messages table with `direction` | `accounts -> threads -> messages`, same single-table idea, `direction in/out` |
| Conversation status + assignee + unread count | `threads.status` (open/done), `assignee`, `unread` flag |
| Workflow = trigger + list of steps stored as JSON, runs never send twice | `rules` = trigger (inbound message) + conditions + actions as JSON. The only "reply" action creates a **pending draft**, never a send |
| AI provider resolver with fallback, AI output never auto-sent | Swappable `LlmProvider` (fake / Anthropic / OpenAI-compatible), deterministic fake in mock mode |
| AES-256-GCM envelope encryption with a self-describing `enc:v1:` prefix | Same scheme, own implementation, for connector credentials |
| Flat append-only audit log with denormalised actor | `audit_log(actor, action, target, detail, created_at)` |
| Realtime fan-out so the UI refreshes | A "pulse" endpoint (max audit/message id) polled by the UI, which works across the web process **and** the stdio MCP process sharing one SQLite file |

### Dropped

- Multi-tenancy (companies), RBAC roles, invites, MFA, billing, teams, reports.
- Facebook Login / Meta embedded signup. Replaced by per-channel connectors.
- Broadcasts, templates, contacts/segments, custom fields, ads attribution.
- Visual workflow graph editor, waits, branching, AI agent loops.
- Postgres LISTEN/NOTIFY bus, migrations folder (one schema file instead).

## 2. Architecture

```
            Claude Desktop / Claude Code            Make scenario
                 | stdio                         | HTTP (Streamable) or SSE
                 v                               v
        +-------------------+          +---------------------------+
        | mcp/stdio.ts      |          | Express app (one process) |
        | (same tools)      |          |  /mcp  /sse  /messages     |
        +---------+---------+          |  /api/*  (REST for UI)     |
                  |                    |  /a/:token (approve links) |
                  |                    |  /webhooks/whatsapp        |
                  |                    |  React UI (Vite)           |
                  |                    +-------------+-------------+
                  |                                  |
                  v                                  v
        +--------------------------------------------------------+
        | core: inbox, approvals, safety, audit, ai, rules, sync |
        +---------------------------+----------------------------+
                                    |                     \
                                    v                      v
                           SQLite (node:sqlite)     Connector registry
                                                    gmail | outlook | yahoo
                                                    discord | whatsapp
                                                    each: mock or real
```

- **Runtime**: Node 24, TypeScript via `tsx`, Express 5, React + Vite (served by
  Express in middleware mode in dev, as static files in Docker). One process,
  one port (3000).
- **DB**: SQLite through Node's built-in `node:sqlite`. No native build step,
  WAL mode so the stdio MCP process and the web process can share the file.
- **MCP**: `@modelcontextprotocol/sdk`. One `buildServer()` registers all tools;
  three transports mount it: stdio, Streamable HTTP (`/mcp`), legacy SSE
  (`/sse` + `/messages`) for older clients. Optional bearer token.

### Connector interface

```ts
interface Connector {
  listThreads(opts: { since?: Date; limit?: number }): Promise<RemoteThread[]>;
  getThread(remoteId: string): Promise<RemoteThread & { messages: RemoteMessage[] }>;
  createDraft(input: DraftInput): Promise<{ remoteDraftId: string | null }>;
  send(input: SendInput): Promise<{ remoteMessageId: string }>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

- `MOCK_MODE=true` (default) or a per-channel override (`GMAIL_MODE=real`) picks
  the implementation. Mock connectors read a seeded fixture, replay scripted
  inbound events on a timer, and "send" by appending to the thread.
- Real connectors: Gmail API (Google OAuth), Microsoft Graph (Microsoft OAuth),
  Yahoo IMAP/SMTP with an app password, Discord **bot** REST API, WhatsApp
  Business Cloud API (+ inbound webhook). No personal-account automation for
  Discord or WhatsApp.

### Send path (the only one)

```
draft_reply / UI "draft" / rule action
        -> approvals.status = pending   (+ notify: Telegram / email / outbox)
human approve (UI or signed link, link opens a confirm page, POST performs)
        -> safety: kill switch -> allowlist -> per-account rate limit
        -> connector.send()  -> status sent | failed (error kept, retryable)
        -> audit_log row at every step
```

There is no other code path that calls `connector.send()`.

## 3. Data model (SQLite)

```
accounts       id, channel, label, address, mode, credentials_enc,
               rate_limit_per_hour, allowlist_enabled, allowlist(json), created_at
threads        id, account_id, remote_id, subject, participants(json),
               last_message_at, unread, status(open|done), assignee,
               priority(high|normal|low), tags(json)
messages       id, thread_id, remote_id, direction(in|out), sender, recipient,
               body, sent_at
approvals      id, thread_id, account_id, recipient, in_reply_to_message_id,
               original_body, draft_body, final_body, status
               (pending|sent|rejected|failed), requested_by, decided_by,
               decided_at, error, remote_message_id, created_at
audit_log      id, actor, action, target_type, target_id, detail, created_at
health         account_id, status, last_sync_at, last_error, last_error_at,
               last_latency_ms, sync_count, error_count
health_events  id, account_id, level, message, created_at
notifications  id, approval_id, channel(telegram|email|outbox), payload(json), created_at
rules          id, name, enabled, conditions(json), actions(json)
settings       key, value   (kill_switch, digest cache ...)
team           id, name     (assignees)
```

## 4. Safety design

- Approval gate: no MCP send tool; `request_send` only queues.
- Approve links are HMAC-signed, single-use, expiring, and need a POST from a
  confirm page (link previewers cannot approve by fetching a URL).
- Kill switch (UI toggle + `SEND_KILL_SWITCH=1` env override) blocks all sends.
- Per-account rate limit (sent in the last hour) and optional recipient
  allowlist (exact address or `@domain`).
- Credentials encrypted at rest (AES-256-GCM, key from `ENCRYPTION_KEY`).
- Message bodies returned to Claude are marked as untrusted content. The seed
  includes a prompt-injection email to show that the worst case is a draft a
  human rejects.
- Full audit log of every read-by-tool, draft, decision, send and block.

## 5. Milestones (one commit each)

1. Scaffold + PLAN.md.
2. Core: schema, crypto, audit, seed fixtures, connector interface, mock
   connectors, sync + mock event replay.
3. Approval queue, safety checks, notifications (Telegram / email / outbox),
   REST API, signed approve links.
4. MCP server: tools, stdio + Streamable HTTP + SSE, verified with an SDK client.
5. AI helpers (digest, suggested replies, priority tags) + rules engine.
6. Web UI: inbox, approvals, audit, health, digest, settings.
7. Real-mode connectors (Gmail, Graph, IMAP/SMTP, Discord bot, WhatsApp Cloud).
8. Docker, README (mermaid diagram, channel setup, MCP config, Make, safety,
   3-minute demo script), screenshots.
