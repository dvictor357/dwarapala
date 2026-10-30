import { upsertAccount } from './accounts.ts';
import { channelMode, config } from './config.ts';

/**
 * Accounts configured purely through .env (no OAuth dance): Yahoo, Discord bot,
 * WhatsApp Business. Credentials are encrypted on the way into the DB.
 */
export function ensureEnvAccounts(): void {
  const rateLimit = config.defaultRateLimitPerHour;

  if (channelMode('yahoo') === 'real' && config.yahoo.email && config.yahoo.appPassword) {
    upsertAccount({
      channel: 'yahoo',
      label: `Yahoo · ${config.yahoo.email}`,
      address: config.yahoo.email,
      mode: 'real',
      credentials: { email: config.yahoo.email, app_password: config.yahoo.appPassword },
      rateLimit,
    });
  }

  if (channelMode('discord') === 'real' && config.discord.botToken) {
    upsertAccount({
      channel: 'discord',
      label: 'Discord bot',
      address: `bot · ${config.discord.channelIds.length} channel(s)`,
      mode: 'real',
      credentials: { bot_token: config.discord.botToken, channel_ids: config.discord.channelIds },
      rateLimit,
    });
  }

  if (channelMode('whatsapp') === 'real' && config.whatsapp.token && config.whatsapp.phoneNumberId) {
    upsertAccount({
      channel: 'whatsapp',
      label: 'WhatsApp Business',
      address: `phone id ${config.whatsapp.phoneNumberId}`,
      mode: 'real',
      credentials: { token: config.whatsapp.token, phone_number_id: config.whatsapp.phoneNumberId },
      rateLimit,
    });
  }
}
