import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { json, Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.ts';
import { buildMcpServer } from './tools.ts';

export const mcpRouter = Router();

/** Optional bearer token (MCP_HTTP_TOKEN). Make and mcp-remote can both send an Authorization header. */
function auth(req: Request, res: Response, next: NextFunction) {
  if (!config.mcpHttpToken) return next();
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const given = Buffer.from(header || String(req.query.token ?? ''));
  const want = Buffer.from(config.mcpHttpToken);
  if (given.length === want.length && timingSafeEqual(given, want)) return next();
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: missing or wrong MCP token' }, id: null });
}

// Streamable HTTP with sessions, so each session keeps the client's name from the
// initialize handshake for the audit log. All data state lives in SQLite.
type Session = { transport: StreamableHTTPServerTransport; lastSeen: number };
const sessions = new Map<string, Session>();
const SESSION_IDLE_MS = 30 * 60_000;

setInterval(() => {
  for (const [id, s] of sessions) {
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(id);
      void s.transport.close();
    }
  }
}, 60_000).unref();

const rpcError = (res: Response, status: number, message: string) =>
  void res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

mcpRouter.post('/mcp', auth, json({ limit: '1mb' }), async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  try {
    if (typeof sid === 'string') {
      const s = sessions.get(sid);
      if (!s) return rpcError(res, 404, 'Session not found or expired; re-initialize');
      s.lastSeen = Date.now();
      return void (await s.transport.handleRequest(req, res, req.body));
    }
    if (!isInitializeRequest(req.body)) return rpcError(res, 400, 'Missing mcp-session-id header (send initialize first)');

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void sessions.set(id, { transport, lastSeen: Date.now() }),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await buildMcpServer('http').connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp:http]', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

// GET opens the server-to-client stream, DELETE ends a session.
const existing = async (req: Request, res: Response) => {
  const s = sessions.get(String(req.headers['mcp-session-id'] ?? ''));
  if (!s) return rpcError(res, 404, 'Session not found or expired');
  s.lastSeen = Date.now();
  await s.transport.handleRequest(req, res);
};
mcpRouter.get('/mcp', auth, existing);
mcpRouter.delete('/mcp', auth, existing);

// Legacy HTTP+SSE transport for clients that have not moved to Streamable HTTP.
const sseSessions = new Map<string, SSEServerTransport>();

mcpRouter.get('/sse', auth, async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  sseSessions.set(transport.sessionId, transport);
  res.on('close', () => sseSessions.delete(transport.sessionId));
  await buildMcpServer('sse').connect(transport);
});

mcpRouter.post('/messages', auth, json({ limit: '1mb' }), async (req, res) => {
  const transport = sseSessions.get(String(req.query.sessionId ?? ''));
  if (!transport) return void res.status(404).json({ error: 'Unknown or expired SSE session' });
  await transport.handlePostMessage(req, res, req.body);
});
