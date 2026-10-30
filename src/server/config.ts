import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, independent of cwd: Claude Desktop launches the stdio server from "/". */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Load .env without a dependency. Real environment variables win over the file.
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export type Channel = 'gmail' | 'outlook' | 'yahoo' | 'discord' | 'whatsapp';
export const CHANNELS: Channel[] = ['gmail', 'outlook', 'yahoo', 'discord', 'whatsapp'];

export const CHANNEL_LABELS: Record<Channel, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook / Hotmail',
  yahoo: 'Yahoo Mail',
  discord: 'Discord (bot)',
  whatsapp: 'WhatsApp Business',
};

const env = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;
const flag = (key: string, fallback: boolean): boolean => {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

export const EXAMPLE_ENCRYPTION_KEY = 'dev-only-change-me-0123456789abcdef0123456789';

const port = Number(env('PORT', '3000'));

export const config = {
  port,
  appUrl: env('APP_URL', `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data')),
  host: env('HOST', '127.0.0.1'),
  production: process.env.NODE_ENV === 'production',

  mockMode: flag('MOCK_MODE', true),
  mockReplay: flag('MOCK_REPLAY', true),
  syncIntervalSeconds: Number(env('SYNC_INTERVAL_SECONDS', '30')),

  encryptionKey: env('ENCRYPTION_KEY', EXAMPLE_ENCRYPTION_KEY),
  linkSecret: env('LINK_SIGNING_SECRET', env('ENCRYPTION_KEY', EXAMPLE_ENCRYPTION_KEY)),
  envKillSwitch: flag('SEND_KILL_SWITCH', false),
  defaultRateLimitPerHour: Number(env('DEFAULT_RATE_LIMIT_PER_HOUR', '20')),

  mcpHttpToken: env('MCP_HTTP_TOKEN'),
  operatorName: env('OPERATOR_NAME', 'you@web-ui'),

  llm: {
    provider: env('LLM_PROVIDER', 'fake') as 'fake' | 'anthropic' | 'openai',
    anthropicKey: env('ANTHROPIC_API_KEY'),
    anthropicModel: env('ANTHROPIC_MODEL', 'claude-haiku-5-5'),
    openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiKey: env('OPENAI_API_KEY'),
    openaiModel: env('OPENAI_MODEL', 'gpt-4o-mini'),
  },

  notify: {
    telegramToken: env('TELEGRAM_BOT_TOKEN'),
    telegramChatId: env('TELEGRAM_CHAT_ID'),
    smtpUrl: env('NOTIFY_SMTP_URL'),
    emailTo: env('NOTIFY_EMAIL_TO'),
    emailFrom: env('NOTIFY_EMAIL_FROM', 'Dwarapala <no-reply@localhost>'),
  },

  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
  },
  microsoft: {
    clientId: env('MS_CLIENT_ID'),
    clientSecret: env('MS_CLIENT_SECRET'),
    tenant: env('MS_TENANT', 'common'),
  },
  yahoo: {
    email: env('YAHOO_EMAIL'),
    appPassword: env('YAHOO_APP_PASSWORD'),
  },
  discord: {
    botToken: env('DISCORD_BOT_TOKEN'),
    channelIds: env('DISCORD_CHANNEL_IDS').split(',').map((s) => s.trim()).filter(Boolean),
  },
  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    appSecret: env('WHATSAPP_APP_SECRET'),
  },
};

/** A channel runs real only when MOCK_MODE is off or its own <CHANNEL>_MODE=real. */
export function channelMode(channel: Channel): 'mock' | 'real' {
  const own = env(`${channel.toUpperCase()}_MODE`).toLowerCase();
  if (own === 'real' || own === 'mock') return own;
  return config.mockMode ? 'mock' : 'real';
}

export const anyRealChannel = (): boolean => CHANNELS.some((c) => channelMode(c) === 'real');
