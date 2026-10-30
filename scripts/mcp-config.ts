// Prints ready-to-paste MCP client config with this machine's absolute paths.
import { mcpInfo } from '../src/server/mcp/info.ts';

const info = mcpInfo();
console.log('Claude Desktop (stdio, recommended) — add to claude_desktop_config.json:\n');
console.log(JSON.stringify(info.claudeDesktop, null, 2));
console.log('\nClaude Desktop via the running web server (needs `npm run dev`):\n');
console.log(JSON.stringify(info.claudeDesktopRemote, null, 2));
console.log('\nClaude Code:\n');
console.log('  ' + info.claudeCode);
console.log(`\nAny Streamable HTTP MCP client (Cursor, VS Code, n8n, custom agents): URL ${info.httpUrl}${info.tokenRequired ? ', header Authorization: Bearer <MCP_HTTP_TOKEN>' : ''}`);
console.log(`\nMake (MCP client module): URL ${info.make.url}${info.tokenRequired ? ', header Authorization: Bearer <MCP_HTTP_TOKEN>' : ''}`);
console.log(`Legacy SSE clients: ${info.sseUrl}`);
