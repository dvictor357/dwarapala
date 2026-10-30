/**
 * End-to-end check of the demo flow against a running server (npm run dev):
 * MCP over Streamable HTTP and stdio, the approval gate, safety checks, approve links.
 * Usage: npm run smoke   (APP_URL defaults to http://localhost:3000)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(cond: unknown, label: string) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

async function rest<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-One-Inbox': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

// Tool results are an optional untrusted-content note followed by JSON.
const parse = (r: any) => {
  const text: string = r.content[0].text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text.slice(text.search(/^[[{]/m)));
};

async function main() {
  const http = new Client({ name: 'smoke-test', version: '1.0.0' });
  const headers: Record<string, string> = process.env.MCP_HTTP_TOKEN ? { Authorization: `Bearer ${process.env.MCP_HTTP_TOKEN}` } : {};
  await http.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers } }));

  const tools = (await http.listTools()).tools.map((t) => t.name).sort();
  check(
    JSON.stringify(tools) === JSON.stringify(['draft_reply', 'get_thread', 'list_accounts', 'request_send', 'search_messages', 'summarize_inbox']),
    `HTTP: six tools, no send tool (${tools.join(', ')})`,
  );

  const accounts = parse(await http.callTool({ name: 'list_accounts', arguments: {} }));
  check(accounts.length >= 5, `list_accounts returns ${accounts.length} accounts`);

  const summary = parse(await http.callTool({ name: 'summarize_inbox', arguments: { unread_only: false } }));
  check(summary.threads.length > 0, `summarize_inbox: ${summary.headline}`);

  const yahoo = summary.threads.find((t: any) => t.channel === 'yahoo');
  const discord = summary.threads.find((t: any) => t.channel === 'discord');
  check(yahoo && discord, 'found the Yahoo and Discord threads');

  const thread = parse(await http.callTool({ name: 'get_thread', arguments: { thread_id: yahoo.thread_id } }));
  check(thread.messages.length > 0, `get_thread #${yahoo.thread_id}: ${thread.subject}`);

  const hits = parse(await http.callTool({ name: 'search_messages', arguments: { query: 'invoice' } }));
  check(hits.length > 0, `search_messages "invoice": ${hits.length} hits`);

  const draft = parse(await http.callTool({ name: 'draft_reply', arguments: { thread_id: yahoo.thread_id } }));
  check(draft.status === 'draft', `draft_reply saved draft #${draft.draft_id} (not queued yet)`);

  const queued = parse(await http.callTool({ name: 'request_send', arguments: { draft_id: draft.draft_id } }));
  check(queued.status === 'pending', `request_send → approval #${queued.approval_id} pending`);

  // stdio transport, same tools, separate process sharing the SQLite file.
  const stdio = new Client({ name: 'smoke-stdio', version: '1.0.0' });
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/server/mcp/stdio.ts')],
      stderr: 'ignore',
    }),
  );
  const viaStdio = parse(
    await stdio.callTool({
      name: 'request_send',
      arguments: { thread_id: discord.thread_id, body: 'Hey! Happy to look at both logos tonight.' },
    }),
  );
  check(viaStdio.status === 'pending', `stdio: request_send → approval #${viaStdio.approval_id} pending`);

  const phish = summary.threads.find((t: any) => t.tags.includes('suspicious'));
  if (phish) {
    const r: any = await http.callTool({ name: 'draft_reply', arguments: { thread_id: phish.thread_id } });
    check(r.isError, 'suggested reply refused for the prompt-injection email');
  }
  await stdio.close();
  await http.close();

  // Kill switch blocks, item stays pending.
  await rest('PATCH', '/api/settings', { killSwitch: true });
  const blocked = await rest('POST', `/api/approvals/${queued.approval_id}/approve`, {});
  check(blocked.status === 423, `kill switch blocks approve (${blocked.data?.error})`);
  await rest('PATCH', '/api/settings', { killSwitch: false });

  // Allowlist blocks a recipient that is not listed.
  const yahooAcct = accounts.find((a: any) => a.channel === 'yahoo');
  await rest('PATCH', `/api/accounts/${yahooAcct.account_id}`, { allowlist_enabled: true, allowlist: ['@someone-else.example'] });
  const notListed = await rest('POST', `/api/approvals/${queued.approval_id}/approve`, {});
  check(notListed.status === 423, `allowlist blocks approve (${notListed.data?.error})`);
  await rest('PATCH', `/api/accounts/${yahooAcct.account_id}`, { allowlist: ['@weiss-pottery.example'] });

  // Edit then approve.
  const edited = 'Hi Hannah,\n\nYes, I would love to help with the workshop site. Could we do a quick call on Thursday?\n\nBest,\nAlex';
  const sent = await rest('POST', `/api/approvals/${queued.approval_id}/approve`, { body: edited });
  check(sent.data?.status === 'sent', `edited + approved → ${sent.data?.status}`);
  const after = await rest('GET', `/api/threads/${yahoo.thread_id}`);
  check(after.data.messages.at(-1)?.body === edited, 'sent reply appears in the thread');
  await rest('PATCH', `/api/accounts/${yahooAcct.account_id}`, { allowlist_enabled: false });

  const again = await rest('POST', `/api/approvals/${queued.approval_id}/approve`, {});
  check(again.status === 409, 'second approve is refused (no double send)');

  // Reject the Discord one.
  const rejected = await rest('POST', `/api/approvals/${viaStdio.approval_id}/reject`, { reason: 'I will answer in voice chat' });
  check(rejected.data?.status === 'rejected', 'Discord draft rejected');

  // Approve link: GET is a harmless confirm page, POST sends, reuse refused.
  const mcp2 = new Client({ name: 'smoke-links', version: '1.0.0' });
  await mcp2.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers } }));
  const wa = summary.threads.find((t: any) => t.channel === 'whatsapp');
  const q2 = parse(await mcp2.callTool({ name: 'request_send', arguments: { thread_id: wa.thread_id, body: 'Shipped today! Tracking coming shortly.' } }));
  await mcp2.close();
  const outbox = await rest('GET', '/api/notifications');
  const n = outbox.data.find((x: any) => x.approval_id === q2.approval_id);
  check(n?.payload?.approve, 'notification with approve link in the outbox');
  const link = n.payload.approve as string;
  const get = await fetch(link);
  const stillPending = await rest('GET', `/api/approvals/${q2.approval_id}`);
  check(get.ok && stillPending.data.status === 'pending', 'GET on link only shows a confirm page');
  const post = await fetch(link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  const viaLink = await rest('GET', `/api/approvals/${q2.approval_id}`);
  check(post.ok && viaLink.data.status === 'sent', `POST on link approves and sends (${viaLink.data.decided_by})`);
  const reuse = await fetch(link, { method: 'POST' });
  check(reuse.status === 409, 'link cannot be reused');

  const csrf = await fetch(`${BASE}/api/approvals/1/approve`, { method: 'POST' });
  check(csrf.status === 403, 'API mutation without X-One-Inbox header is refused');

  const audit = await rest('GET', '/api/audit');
  const actions = new Set(audit.data.map((a: any) => a.action));
  for (const a of ['tool.called', 'draft.created', 'draft.queued', 'draft.edited', 'approval.approved', 'send.succeeded', 'approval.rejected', 'send.blocked']) {
    check(actions.has(a), `audit log has ${a}`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
