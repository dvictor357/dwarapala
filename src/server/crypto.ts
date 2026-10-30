import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

/**
 * AES-256-GCM for connector credentials at rest.
 * Stored format: enc:v1:<iv>:<tag>:<ciphertext>, all base64url.
 * GCM means a tampered value fails to decrypt instead of returning garbage.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer {
  if (config.encryptionKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters (see .env.example)');
  }
  return createHash('sha256').update(config.encryptionKey).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join(':');
}

export function decrypt(stored: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error('Refusing to read an unencrypted credential');
  const [iv, tag, body] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export const encryptJson = (value: unknown): string => encrypt(JSON.stringify(value));
export const decryptJson = <T>(stored: string): T => JSON.parse(decrypt(stored)) as T;

/** Compact signed tokens for approve/reject links: <payload>.<hmac>, both base64url. */
export function sign(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', config.linkSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify<T>(token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', config.linkSecret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export const randomId = (bytes = 9): string => randomBytes(bytes).toString('base64url');
