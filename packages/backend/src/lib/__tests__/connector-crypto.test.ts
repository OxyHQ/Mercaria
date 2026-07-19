/**
 * Unit tests for `connector-crypto` — AES-256-GCM encryption of external-platform
 * credentials at rest.
 *
 * These run without any DB or network: they set a deterministic key in the
 * environment, exercise the encrypt→decrypt round-trip, and assert the
 * fail-closed properties — a fresh IV per call, tampering with the tag or
 * ciphertext throws (GCM authentication), a wrong key cannot decrypt, and a
 * missing/malformed key throws a clear, actionable error at first use.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../connector-crypto.js';

const ENV_VAR = 'CONNECTOR_ENCRYPTION_KEY';
/** A valid 64-char hex key (32 bytes). */
const VALID_KEY = 'a'.repeat(64);
/** A different valid key, for the wrong-key decryption test. */
const OTHER_KEY = 'b'.repeat(64);

const SECRET = 'shpat_super-secret-oauth-token-1234567890';

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[ENV_VAR];
  process.env[ENV_VAR] = VALID_KEY;
});

afterEach(() => {
  if (savedKey === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = savedKey;
  }
});

describe('encryptSecret / decryptSecret round-trip', () => {
  it('decrypts back to the original plaintext', () => {
    const blob = encryptSecret(SECRET);
    expect(decryptSecret(blob)).toBe(SECRET);
  });

  it('produces base64 parts and never embeds the plaintext', () => {
    const blob = encryptSecret(SECRET);
    expect(blob.ciphertext).toEqual(expect.any(String));
    expect(blob.iv).toEqual(expect.any(String));
    expect(blob.tag).toEqual(expect.any(String));
    // The stored ciphertext must not leak any recognizable slice of the secret.
    expect(blob.ciphertext).not.toContain('shpat');
  });

  it('uses a fresh IV per call, so identical plaintext yields distinct ciphertext', () => {
    const a = encryptSecret(SECRET);
    const b = encryptSecret(SECRET);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // …yet both decrypt back to the same plaintext.
    expect(decryptSecret(a)).toBe(SECRET);
    expect(decryptSecret(b)).toBe(SECRET);
  });

  it('round-trips an empty string', () => {
    const blob = encryptSecret('');
    expect(decryptSecret(blob)).toBe('');
  });
});

describe('tamper detection (GCM authentication)', () => {
  it('throws when the auth tag is tampered with', () => {
    const blob = encryptSecret(SECRET);
    const tag = Buffer.from(blob.tag, 'base64');
    tag[0] ^= 0xff;
    const tampered: EncryptedSecret = { ...blob, tag: tag.toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('throws when the ciphertext is tampered with', () => {
    const blob = encryptSecret(SECRET);
    const ciphertext = Buffer.from(blob.ciphertext, 'base64');
    ciphertext[0] ^= 0xff;
    const tampered: EncryptedSecret = { ...blob, ciphertext: ciphertext.toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const blob = encryptSecret(SECRET);
    process.env[ENV_VAR] = OTHER_KEY;
    expect(() => decryptSecret(blob)).toThrow();
  });
});

describe('key validation (fail-closed at first use)', () => {
  it('throws a clear error when the key is missing', () => {
    delete process.env[ENV_VAR];
    expect(() => encryptSecret(SECRET)).toThrow(/CONNECTOR_ENCRYPTION_KEY is not set/);
  });

  it('throws when the key is not hex', () => {
    process.env[ENV_VAR] = 'z'.repeat(64);
    expect(() => encryptSecret(SECRET)).toThrow(/64-character hex string/);
  });

  it('throws when the key is the wrong length', () => {
    process.env[ENV_VAR] = 'abcd';
    expect(() => encryptSecret(SECRET)).toThrow(/64-character hex string/);
  });
});
