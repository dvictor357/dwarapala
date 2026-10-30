import path from 'node:path';
import { config, ROOT } from '../config.ts';

/** Connection details shown in Settings and printed by `npm run mcp:config`. */
export function mcpInfo() {
  const root = ROOT;
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const stdioEntry = path.join(root, 'src', 'server', 'mcp', 'stdio.ts');
  const headers = config.mcpHttpToken ? { Authorization: 'Bearer <MCP_HTTP_TOKEN>' } : undefined;

  return {
    httpUrl: `${config.appUrl}/mcp`,
    sseUrl: `${config.appUrl}/sse`,
    tokenRequired: !!config.mcpHttpToken,
    claudeDesktop: {
      mcpServers: {
        'one-inbox': {
          command: process.execPath,
          args: ['--no-warnings=ExperimentalWarning', tsxCli, stdioEntry],
          env: { DATA_DIR: config.dataDir },
        },
      },
    },
    claudeDesktopRemote: {
      mcpServers: {
        'one-inbox': {
          command: 'npx',
          args: ['-y', 'mcp-remote', `${config.appUrl}/mcp`, ...(config.mcpHttpToken ? ['--header', 'Authorization:Bearer ${MCP_HTTP_TOKEN}'] : [])],
          ...(config.mcpHttpToken ? { env: { MCP_HTTP_TOKEN: '<your token>' } } : {}),
        },
      },
    },
    claudeCode: `claude mcp add --transport http one-inbox ${config.appUrl}/mcp${config.mcpHttpToken ? ' --header "Authorization: Bearer <MCP_HTTP_TOKEN>"' : ''}`,
    make: { url: `${config.appUrl}/mcp`, headers },
  };
}
