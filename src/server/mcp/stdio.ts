// stdio entry for local MCP clients (Claude Desktop, Claude Code, Cursor, VS Code, ...). stdout carries the protocol, so
// anything human-readable must go to stderr.
console.log = console.error;

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { buildMcpServer } = await import('./tools.ts');
const { isSeeded, seed } = await import('../seed.ts');

// Works even before the web app has ever run.
if (!isSeeded()) await seed();

const server = buildMcpServer('stdio');
await server.connect(new StdioServerTransport());
console.error('[one-inbox] MCP server ready on stdio');
