import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { api } from './api.ts';
import { anyRealChannel, config, EXAMPLE_ENCRYPTION_KEY, ROOT } from './config.ts';
import { ensureEnvAccounts } from './bootstrap.ts';
import { whatsappWebhook } from './connectors/whatsapp.ts';
import { links } from './links.ts';
import { oauth } from './oauth.ts';
import { mcpRouter } from './mcp/http.ts';
import { handleInbound } from './rules.ts';
import { isSeeded, seed } from './seed.ts';
import { onInbound, startMockReplay, startSyncLoop, syncAll } from './sync.ts';

if (config.encryptionKey === EXAMPLE_ENCRYPTION_KEY) {
  if (anyRealChannel()) {
    console.error('Refusing to store real credentials with the example ENCRYPTION_KEY. Set a long random value in .env.');
    process.exit(1);
  }
  console.warn('[warn] Using the example ENCRYPTION_KEY. Fine for mock mode, change it before connecting real accounts.');
}

const app = express();
app.disable('x-powered-by');

/**
 * Local-first app with no login, so two cheap guards:
 * - Host allowlist stops DNS-rebinding pages from reaching the API or MCP endpoint.
 * - Mutating /api calls need a custom header, which a cross-site form or fetch
 *   cannot send without a CORS preflight this server never answers.
 */
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', new URL(config.appUrl).hostname]);
// Webhooks arrive from the provider through a tunnel (APP_URL); they verify their own signatures.
const hostExempt = (path: string) => path.startsWith('/webhooks/');
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!allowedHosts.has(host) && !hostExempt(req.path)) return void res.status(403).send(`Host "${host}" not allowed. Set APP_URL to serve on another hostname.`);
  next();
});
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-one-inbox'] !== '1') return void res.status(403).json({ error: 'Missing X-One-Inbox header' });
  next();
});

app.use('/api', express.json({ limit: '256kb' }), api);
app.use(mcpRouter);
app.use(links);
app.use(oauth);
app.use(whatsappWebhook);
app.get('/healthz', (_req, res) => void res.json({ ok: true }));

const webDist = path.join(ROOT, 'dist', 'web');
if (config.production && existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/(api|mcp|sse|messages|a)\b).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { port: config.port + 1 } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'Internal error. See server logs.' });
});

ensureEnvAccounts();
if (!isSeeded()) {
  console.log('First run: seeding demo data…');
  await seed();
} else {
  await syncAll();
}
onInbound(handleInbound);
startSyncLoop();
startMockReplay();

app.listen(config.port, config.host, () => {
  console.log(`\n  One Inbox for Agents  →  ${config.appUrl}`);
  console.log(`  MCP (Streamable HTTP) →  ${config.appUrl}/mcp   ·  legacy SSE → ${config.appUrl}/sse`);
  console.log(`  Mode: ${config.mockMode ? 'MOCK (no credentials needed)' : 'REAL'}  ·  run "npm run mcp:config" for MCP client config snippets\n`);
});
