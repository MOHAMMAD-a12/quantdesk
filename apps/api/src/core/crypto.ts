/**
 * Cryptographic helpers.
 *
 * AES-256-GCM for reversible secrets (provider API keys that must be sent
 * upstream), SHA-256 for one-way lookups (refresh tokens, API keys), and
 * timing-safe comparison where a secret is compared to user input.
 *
 * Passwords are hashed with bcrypt in `modules/auth` — not here — because they
 * are never decrypted and have different tuning concerns.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

/**
 * Encrypt a UTF-8 string.
 *
 * Output layout: `base64(iv || authTag || ciphertext)`. The IV is random per
 * call — reusing a nonce with GCM is catastrophic, so it is never derived.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, config.auth.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/**
 * Decrypt a value produced by {@link encrypt}.
 *
 * Throws if the auth tag does not verify — that means the ciphertext was
 * tampered with or the key changed, and returning garbage would be worse.
 */
export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('Ciphertext too short to be valid');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, config.auth.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Decrypt, returning null instead of throwing. For non-critical reads. */
export function tryDecrypt(payload: string): string | null {
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

/** SHA-256 hex digest. Used for token lookups where the plaintext is high-entropy. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** URL-safe random token. 32 bytes ≈ 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Generate a programmatic API key.
 *
 * Only the hash and the display prefix are persisted; the full key is shown to
 * the user exactly once.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `qd_${randomToken(24)}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

/**
 * Constant-time string comparison.
 *
 * Length is compared first via hashing, so this does not leak length either —
 * both inputs are reduced to fixed-width digests before the compare.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Mask a secret for display, e.g. `sk-ab…9f2c`. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
