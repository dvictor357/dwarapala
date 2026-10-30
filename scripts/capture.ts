/**
 * Re-captures docs/screenshots/*.png and docs/demo.gif from a fresh mock-mode instance.
 * Seeds demo data into a throwaway DATA_DIR, starts the dev server, drives it with
 * Playwright (Chromium) and converts the recorded video with ffmpeg.
 * Usage: npm run capture   (needs ffmpeg on PATH and port 3000 free)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://localhost:3000';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const GIF = path.join(ROOT, 'docs', 'demo.gif');
const VIEWPORT = { width: 1440, height: 900 };
const WORK = mkdtempSync(path.join(tmpdir(), 'dwarapala-capture-'));

// Mock data only: a throwaway database, a random key (no example-key warning), no scripted
// inbound arriving mid-recording, no LLM or notification credentials from a local .env.
const ENV = {
  ...process.env,
  MOCK_MODE: 'true',
  MOCK_REPLAY: 'false',
  DATA_DIR: path.join(WORK, 'data'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  LINK_SIGNING_SECRET: '',
  MCP_HTTP_TOKEN: '',
  SEND_KILL_SWITCH: '0',
  LLM_PROVIDER: 'fake',
  OPERATOR_NAME: 'you@web-ui',
  TELEGRAM_BOT_TOKEN: '',
  NOTIFY_SMTP_URL: '',
  APP_URL: BASE,
  PORT: '3000',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function npm(script: string) {
  const r = spawnSync('npm', ['run', '--silent', script], { cwd: ROOT, env: ENV, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run ${script} exited with ${r.status}`);
}

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/healthz`)).ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await up()) throw new Error(`${BASE} is already serving. Stop the running dev server first so the capture uses fresh demo data.`);
  const server = spawn('npm', ['run', '--silent', 'dev'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    if (await up()) return server;
    if (server.exitCode !== null) break;
    await sleep(500);
  }
  stopServer(server);
  throw new Error(`Dev server did not come up on ${BASE}:\n${log}`);
}

function stopServer(server: ReturnType<typeof spawn>) {
  // npm spawns node as a child; kill the whole process group.
  try {
    if (server.pid) process.kill(-server.pid, 'SIGTERM');
  } catch {}
}

async function rest<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-One-Inbox': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// Tool results are an optional untrusted-content note followed by JSON.
const parse = (r: any) => {
  const text: string = r.content[0].text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text.slice(text.search(/^[[{]/m)));
};

/** An MCP client named like a generic agent, so the UI shows "mcp:agent (http)". */
async function agent() {
  const client = new Client({ name: 'agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const call = async (name: string, args: Record<string, unknown>) => parse(await client.callTool({ name, arguments: args }));
  return { call, close: () => client.close() };
}

/** Drafts a reply with the agent and queues it for approval. Returns the approval id. */
async function agentRequestsSend(threadId: number, note?: string): Promise<number> {
  const a = await agent();
  try {
    const draft = await a.call('draft_reply', { thread_id: threadId });
    const queued = await a.call('request_send', { draft_id: draft.draft_id, ...(note ? { note } : {}) });
    return queued.approval_id;
  } finally {
    await a.close();
  }
}

async function threads(): Promise<{ thread_id: number; channel: string; subject: string; tags: string[] }[]> {
  const a = await agent();
  try {
    return (await a.call('summarize_inbox', { unread_only: false })).threads;
  } finally {
    await a.close();
  }
}

async function settle(page: Page, ms = 600) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await sleep(ms);
}

async function recordDemo(browser: Browser, yahooThread: number) {
  const videoDir = path.join(WORK, 'video');
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: videoDir, size: VIEWPORT } });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(`${BASE}/#/inbox`);
  await page.locator('.list .row').first().waitFor();
  await settle(page, 300);
  const trimStart = (Date.now() - t0) / 1000;

  // 1. One inbox across channels.
  await sleep(1500);
  for (const name of ['Gmail', 'Discord', 'WhatsApp', 'All accounts']) {
    await page.locator('.filters .filter', { hasText: name }).first().click();
    await sleep(900);
  }
  await page.locator(`.list a[href="#/inbox/${yahooThread}"]`).click();
  await sleep(2200);

  // 2. The agent drafts a reply; it lands in Approvals, not in Hannah's inbox.
  await page.locator('nav a', { hasText: 'Approvals' }).click();
  await sleep(1200);
  await agentRequestsSend(yahooThread);
  await page.locator('.card.approval.pending').first().waitFor({ timeout: 10_000 });
  await sleep(2500);

  // 3. Edit, then approve.
  const card = page.locator('.card.approval.pending').first();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await sleep(600);
  const box = card.locator('textarea');
  await box.fill('');
  await box.pressSequentially('Hi Hannah,\n\nYes, I would love to help with the workshop site. Could we do a quick call on Thursday?\n\nBest,\nAlex', {
    delay: 18,
  });
  await sleep(900);
  await card.getByRole('button', { name: 'Approve edited & send' }).click();
  await sleep(2200);

  // 4. The reply shows as sent in the thread.
  await page.goto(`${BASE}/#/inbox/${yahooThread}`);
  await page.locator('.msg-row.out').last().waitFor({ timeout: 10_000 }).catch(() => {});
  await page.locator('.messages').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await sleep(3000);

  // 5. Every step is in the audit log.
  await page.locator('nav a', { hasText: 'Audit log' }).click();
  await settle(page, 3500);

  const video = page.video()!;
  await context.close();
  const webm = await video.path();

  const duration = (Date.now() - t0) / 1000 - trimStart;
  const palette = path.join(WORK, 'palette.png');
  const filters = 'fps=12,scale=1280:-1:flags=lanczos';
  const ff = (args: string[]) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg exited with ${r.status}`);
  };
  const trim = ['-ss', trimStart.toFixed(2), '-t', duration.toFixed(2), '-i', webm];
  ff([...trim, '-vf', `${filters},palettegen=max_colors=128:stats_mode=diff`, palette]);
  ff([...trim, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, GIF]);
  console.log(`demo.gif: ${duration.toFixed(1)}s, ${(statSync(GIF).size / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
  console.log('Seeding demo data…');
  npm('seed');
  console.log('Starting dev server (mock mode)…');
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const all = await threads();
    const pick = (channel: string, skip: number[] = []) => {
      const t = all.find((x) => x.channel === channel && !x.tags.includes('suspicious') && !skip.includes(x.thread_id));
      if (!t) throw new Error(`No ${channel} thread in the seed data`);
      return t.thread_id;
    };
    const yahoo = pick('yahoo');

    // The demo flow produces the approved + sent item.
    console.log('Recording demo…');
    await recordDemo(browser, yahoo);

    // Two more pending drafts and one rejected, so the queue, history and audit pages have content.
    const rejected = await agentRequestsSend(pick('discord'));
    await rest('POST', `/api/approvals/${rejected}/reject`, { reason: 'I will answer in voice chat' });
    await agentRequestsSend(pick('gmail'), 'Customer asked about the invoice split');
    await agentRequestsSend(pick('whatsapp'));

    console.log('Taking screenshots…');
    mkdirSync(SHOTS, { recursive: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const shots: [string, string][] = [
      ['1-inbox', `#/inbox/${yahoo}`],
      ['2-approvals', '#/approvals'],
      ['3-history', '#/approvals/history'],
      ['4-audit', '#/audit'],
      ['5-health', '#/health'],
      ['6-digest', '#/digest'],
      ['7-settings', '#/settings'],
    ];
    for (const [name, hash] of shots) {
      await page.goto(`${BASE}/${hash}`);
      await page.reload(); // hash-only navigation keeps component state; start each page fresh
      await settle(page, 900);
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
      console.log(`  ${name}.png`);
    }
    await context.close();
  } finally {
    await browser.close();
    stopServer(server);
    rmSync(WORK, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
