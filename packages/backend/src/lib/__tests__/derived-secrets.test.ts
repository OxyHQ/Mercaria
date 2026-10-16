/**
 * The one root and every key derived from it (`lib/derived-secrets.ts`).
 *
 * What is pinned here is what a deployment relies on without ever seeing it:
 * that a key is the same on every task and every restart, that no two purposes
 * share key bytes (the pairs that MUST differ most of all), that each consumer
 * gets the shape it validates, that a malformed or short root is refused rather
 * than stretched, and that production refuses to start without one while every
 * other environment falls back to the public development root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_ROOT_SECRET,
  deriveKeyBytes,
  derivedSecret,
  MIN_ROOT_SECRET_BYTES,
  parseRootSecret,
  resolveRootSecret,
  ROOT_SECRET_ENV,
  SECRET_PURPOSES,
  type SecretPurpose,
} from '../derived-secrets.js';

const PURPOSES = Object.keys(SECRET_PURPOSES) as SecretPurpose[];
const ROOT_A = Buffer.alloc(32, 0xa1);
const ROOT_B = Buffer.alloc(32, 0xb2);

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ROOT_SECRET_ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ROOT_SECRET_ENV];
  else process.env[ROOT_SECRET_ENV] = saved;
});

describe('derivation', () => {
  it('is deterministic for one root and one purpose', () => {
    for (const purpose of PURPOSES) {
      expect(deriveKeyBytes(ROOT_A, purpose).equals(deriveKeyBytes(ROOT_A, purpose))).toBe(true);
    }
  });

  it('gives every purpose its own 32-byte key, distinct from the root', () => {
    const keys = PURPOSES.map((purpose) => deriveKeyBytes(ROOT_A, purpose).toString('hex'));
    expect(new Set(keys).size).toBe(PURPOSES.length);
    for (const key of keys) {
      expect(key).toHaveLength(64);
      expect(key).not.toBe(ROOT_A.toString('hex'));
    }
  });

  it('keeps the pairs that MUST differ apart', () => {
    // A public link token's key must never sign a state carrier (ADR 0005), and
    // the guest lookup path must hold a key that cannot decrypt (ADR 0003 D12).
    const pairs: [SecretPurpose, SecretPurpose][] = [
      ['referral-link-token', 'referral-state'],
      ['guest-pii-encryption', 'guest-email-hash'],
      ['guest-pii-encryption', 'feed-import-auth-encryption'],
      ['referral-link-token', 'outbound-token'],
    ];
    for (const [a, b] of pairs) {
      expect(deriveKeyBytes(ROOT_A, a).equals(deriveKeyBytes(ROOT_A, b)), `${a} = ${b}`).toBe(
        false,
      );
    }
  });

  it('changes every key when the root changes', () => {
    for (const purpose of PURPOSES) {
      expect(deriveKeyBytes(ROOT_A, purpose).equals(deriveKeyBytes(ROOT_B, purpose))).toBe(false);
    }
  });
});

describe('the shape each consumer takes', () => {
  it('hands hex purposes 64 lower-case hex characters and byte purposes 32 bytes', () => {
    process.env[ROOT_SECRET_ENV] = ROOT_A.toString('hex');
    for (const purpose of PURPOSES) {
      const value: unknown = derivedSecret(purpose);
      if (SECRET_PURPOSES[purpose] === 'hex') {
        expect(value).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(Buffer.isBuffer(value)).toBe(true);
        expect((value as Buffer).length).toBe(32);
      }
    }
  });

  it('is the HKDF output of the configured root, in either shape', () => {
    process.env[ROOT_SECRET_ENV] = ROOT_A.toString('hex');
    expect(derivedSecret('referral-state')).toBe(
      deriveKeyBytes(ROOT_A, 'referral-state').toString('hex'),
    );
    expect(
      derivedSecret('guest-pii-encryption').equals(deriveKeyBytes(ROOT_A, 'guest-pii-encryption')),
    ).toBe(true);
  });

  it('follows a change of the root rather than serving a stale cached key', () => {
    process.env[ROOT_SECRET_ENV] = ROOT_A.toString('hex');
    const before = derivedSecret('outbound-token');
    process.env[ROOT_SECRET_ENV] = ROOT_B.toString('hex');
    expect(derivedSecret('outbound-token')).not.toBe(before);
  });

  it('hands out a copy, so a caller cannot corrupt the cached key', () => {
    process.env[ROOT_SECRET_ENV] = ROOT_A.toString('hex');
    derivedSecret('feed-import-auth-encryption').fill(0);
    expect(
      derivedSecret('feed-import-auth-encryption').equals(
        deriveKeyBytes(ROOT_A, 'feed-import-auth-encryption'),
      ),
    ).toBe(true);
  });
});

describe('parsing the root', () => {
  it('accepts 64+ hex characters (`openssl rand -hex 32`)', () => {
    expect(parseRootSecret(ROOT_A.toString('hex')).equals(ROOT_A)).toBe(true);
    expect(parseRootSecret(` ${ROOT_A.toString('hex').toUpperCase()} `).equals(ROOT_A)).toBe(true);
    const longer = Buffer.alloc(48, 7);
    expect(parseRootSecret(longer.toString('hex')).equals(longer)).toBe(true);
  });

  it('accepts base64 and base64url that decode to 32+ bytes', () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 7 + 250));
    expect(parseRootSecret(bytes.toString('base64')).equals(bytes)).toBe(true);
    expect(parseRootSecret(bytes.toString('base64url')).equals(bytes)).toBe(true);
  });

  it('refuses a root shorter than 256 bits, in any encoding', () => {
    const short = Buffer.alloc(MIN_ROOT_SECRET_BYTES - 1, 1);
    expect(() => parseRootSecret(short.toString('hex'))).toThrow(ROOT_SECRET_ENV);
    expect(() => parseRootSecret(short.toString('base64'))).toThrow(ROOT_SECRET_ENV);
    expect(() => parseRootSecret('change-me')).toThrow(ROOT_SECRET_ENV);
  });

  it('refuses a value that is neither hex nor base64', () => {
    expect(() => parseRootSecret(`${'a'.repeat(63)}!`)).toThrow(/openssl rand -hex 32/);
  });
});

describe('resolving the root', () => {
  it('uses the configured root wherever it is set', () => {
    const resolved = resolveRootSecret({
      NODE_ENV: 'production',
      [ROOT_SECRET_ENV]: ROOT_A.toString('hex'),
    });
    expect(resolved.source).toBe('environment');
    expect(resolved.root.equals(ROOT_A)).toBe(true);
  });

  it('REFUSES production without a root, naming the variable', () => {
    expect(() => resolveRootSecret({ NODE_ENV: 'production' })).toThrow(
      new RegExp(`${ROOT_SECRET_ENV} is not set`),
    );
    expect(() => resolveRootSecret({ NODE_ENV: 'production', [ROOT_SECRET_ENV]: '  ' })).toThrow(
      new RegExp(`${ROOT_SECRET_ENV} is not set`),
    );
  });

  it('falls back to the public development root everywhere else', () => {
    for (const NODE_ENV of ['test', 'development', undefined]) {
      const resolved = resolveRootSecret({ NODE_ENV });
      expect(resolved.source).toBe('development');
      expect(resolved.root.equals(DEVELOPMENT_ROOT_SECRET)).toBe(true);
    }
  });

  it('refuses a MALFORMED root even outside production', () => {
    // A typo must not silently become the public development root.
    expect(() => resolveRootSecret({ NODE_ENV: 'test', [ROOT_SECRET_ENV]: 'short' })).toThrow(
      ROOT_SECRET_ENV,
    );
  });

  it('derives working keys with no configuration at all', () => {
    delete process.env[ROOT_SECRET_ENV];
    expect(derivedSecret('referral-link-token')).toBe(
      deriveKeyBytes(DEVELOPMENT_ROOT_SECRET, 'referral-link-token').toString('hex'),
    );
  });
});
