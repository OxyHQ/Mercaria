/**
 * Connector credential encryption at rest (AES-256-GCM).
 *
 * External-platform credentials (OAuth tokens, API keys/secrets) are stored ONLY
 * as an encrypted `{ ciphertext, iv, tag }` blob — never in plaintext. This
 * helper is the single chokepoint for that encryption. It uses Node's standard
 * `crypto` (no home-rolled primitives): a random 96-bit IV per message and the
 * GCM authentication tag, which makes tampering with the stored blob a decryption
 * failure rather than a silent corruption.
 *
 * The 32-byte key comes from `CONNECTOR_ENCRYPTION_KEY` (a 64-char hex string,
 * `openssl rand -hex 32`). The key is validated on FIRST USE — never at import —
 * so the process still boots (and unrelated code paths run) when the key is
 * absent; only an actual encrypt/decrypt fails, with a clear, actionable error.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM: 256-bit key, GCM mode (authenticated encryption). */
const ALGORITHM = 'aes-256-gcm';
/** Required key length in bytes (256 bits). */
const KEY_BYTES = 32;
/** IV length in bytes — 96 bits is the GCM-recommended nonce size. */
const IV_BYTES = 12;
/** Environment variable holding the hex-encoded key. */
const ENV_VAR = 'CONNECTOR_ENCRYPTION_KEY';
/** A valid key is exactly `KEY_BYTES` bytes ⇔ `KEY_BYTES * 2` hex characters. */
const HEX_KEY_PATTERN = new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`);

/**
 * An encrypted secret at rest: all three parts base64-encoded. `iv` is the random
 * nonce and `tag` the GCM authentication tag; both are required to decrypt, and a
 * mismatch on either makes decryption throw.
 */
export interface EncryptedSecret {
  /** Base64 AES-256-GCM ciphertext. */
  ciphertext: string;
  /** Base64 96-bit initialization vector (nonce). */
  iv: string;
  /** Base64 128-bit GCM authentication tag. */
  tag: string;
}

/**
 * Resolve and validate the encryption key from the environment. Throws a clear
 * error when the variable is missing or malformed. Called on every encrypt/
 * decrypt (cheap: a regex + a 32-byte hex decode), keeping the helper stateless
 * so a changed/unset key is observed immediately and is trivial to test.
 */
function resolveKey(): Buffer {
  const raw = process.env[ENV_VAR];
  if (!raw || raw.trim() === '') {
    throw new Error(
      `${ENV_VAR} is not set. Generate a 32-byte key with \`openssl rand -hex 32\` and set it in the environment.`,
    );
  }
  const trimmed = raw.trim();
  // The single length/format gate: exactly KEY_BYTES bytes of hex.
  if (!HEX_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      `${ENV_VAR} must be a 64-character hex string (32 bytes). Generate one with \`openssl rand -hex 32\`.`,
    );
  }
  return Buffer.from(trimmed, 'hex');
}

/**
 * Encrypt a UTF-8 plaintext secret. Returns the base64 `{ ciphertext, iv, tag }`
 * blob to persist. A fresh random IV is generated per call, so encrypting the
 * same plaintext twice yields different ciphertexts.
 */
export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt a stored `{ ciphertext, iv, tag }` blob back to its UTF-8 plaintext.
 * Throws if the key is wrong or the blob has been tampered with (GCM tag
 * verification fails) — decryption is fail-closed, never returning corrupt data.
 */
export function decryptSecret(blob: EncryptedSecret): string {
  const key = resolveKey();
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
