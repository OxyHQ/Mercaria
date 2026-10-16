/**
 * Every INTERNAL key this backend uses, derived from ONE root secret.
 *
 * `MERCARIA_SECRET_KEY` is the only secret the operator provisions for keys
 * Mercaria both mints and verifies itself — HMAC keys for signed tokens and
 * state carriers, keys for keyed digests, and the AES keys for data only
 * Mercaria encrypts. Each one is `HKDF-SHA256(root, salt, info)` with a
 * purpose label of its own (`mercaria:<purpose>:v1`), so:
 *
 *  - **Domain separation.** Two purposes never share key bytes, and knowing one
 *    derived key tells you nothing about another or about the root. The pairs
 *    that MUST differ — the public referral link token and the private state
 *    carrier, the guest contact cipher key and its lookup-hash key — differ by
 *    construction, not by an operator remembering to generate two values.
 *  - **One rotation point.** There is one value to provision, back up and
 *    audit, instead of eleven that drift between environments.
 *  - **A feature never adds env.** A new feature that needs a key adds a member
 *    to {@link SECRET_PURPOSES} and is ON the moment it ships, instead of
 *    staying dark behind a flag until somebody provisions a variable.
 *
 * ## What is deliberately NOT derived here
 *
 * External credentials (a provider issued them; Mercaria cannot derive what
 * Stripe expects), keys protecting data already at rest under a key of their
 * own (`CONNECTOR_ENCRYPTION_KEY`), `*_PREVIOUS` rotation variables, references
 * to keys held elsewhere, and tokens a client presents. Re-keying any of those
 * would be a migration, not a refactor.
 *
 * ## Rotating the root rotates EVERYTHING
 *
 * That is the cost of one root, and it is why the root is not routinely
 * rotated: published referral links and in-flight state carriers stop
 * verifying, guest contact and feed credentials encrypted under the old
 * derived keys become unreadable, and every keyed digest (email lookups, abuse
 * and recovery counters, pickup collection codes, preflight fingerprints) stops
 * matching what is stored. `docs/deploy.md` "Runtime secrets" lists each.
 *
 * ## Production requires the root; everywhere else has a fixed dev root
 *
 * `config/index.ts` resolves the root at load, so a production task without it
 * refuses to start exactly as one without `DATABASE_URL` does. Outside
 * production an unset root falls back to {@link DEVELOPMENT_ROOT_SECRET} — a
 * PUBLIC constant, logged once at first use — so development, tests and CI
 * need no secret configuration at all.
 */

import { hkdfSync } from 'node:crypto';
import { log } from './logger.js';

/** The environment variable holding the root. */
export const ROOT_SECRET_ENV = 'MERCARIA_SECRET_KEY';

/** The shortest root accepted: 256 bits. */
export const MIN_ROOT_SECRET_BYTES = 32;

/** Every derived key is 256 bits. */
const DERIVED_KEY_BYTES = 32;

/**
 * The fixed HKDF salt. Fixed rather than random because derivation must be
 * deterministic across tasks and restarts; the root carries the entropy.
 */
const HKDF_SALT = Buffer.from('mercaria:derived-secrets:v1', 'utf8');

/**
 * The root used when `MERCARIA_SECRET_KEY` is unset OUTSIDE production.
 *
 * Public, in source control, and therefore worthless as a secret — which is
 * the point: nothing signed or encrypted under it means anything, and a
 * production task never reaches it.
 */
export const DEVELOPMENT_ROOT_SECRET = Buffer.from(
  'mercaria development root secret: public, never used in production',
  'utf8',
);

/**
 * The CLOSED set of purposes, each with the shape its consumer takes.
 *
 * `bytes` is a raw 32-byte key (AES-256-GCM keys, and HMAC keys the consumer
 * used as decoded bytes); `hex` is the same 32 bytes as 64 lower-case hex
 * characters, for consumers that hand a string key to `createHmac`.
 *
 * Changing a purpose's label or shape changes its key — the same consequence
 * as rotating the root for that one purpose.
 */
export const SECRET_PURPOSES = {
  'referral-link-token': 'hex',
  'referral-state': 'hex',
  'outbound-token': 'hex',
  'connector-oauth-state': 'hex',
  'stripe-onboarding-state': 'hex',
  'guest-pii-encryption': 'bytes',
  'guest-email-hash': 'hex',
  'guest-abuse-subject-hash': 'hex',
  'pickup-collection-code': 'hex',
  'supplier-preflight-fingerprint': 'bytes',
  'feed-import-auth-encryption': 'bytes',
} as const satisfies Record<string, 'bytes' | 'hex'>;

/** A purpose a key can be derived for. */
export type SecretPurpose = keyof typeof SECRET_PURPOSES;

interface SecretShapes {
  bytes: Buffer;
  hex: string;
}

/** The value type {@link derivedSecret} returns for `P`. */
export type DerivedSecret<P extends SecretPurpose> = SecretShapes[(typeof SECRET_PURPOSES)[P]];

const HEX_ROOT = /^[0-9a-fA-F]+$/;
const BASE64_ROOT = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decode a root value.
 *
 * Hex first (at least 64 characters, even length — `openssl rand -hex 32`),
 * otherwise base64 or base64url decoding to at least 32 bytes. A value that is
 * neither, or is shorter, is REFUSED rather than stretched: HKDF does not add
 * entropy, so a short root makes every derived key exactly as guessable.
 *
 * @throws When the value is malformed or shorter than 256 bits.
 */
export function parseRootSecret(raw: string): Buffer {
  const value = raw.trim();
  if (HEX_ROOT.test(value)) {
    // A value made only of hex digits IS hex, never base64: otherwise a short
    // hex root would decode as base64 into more bytes than it carries entropy.
    if (value.length % 2 === 0 && value.length >= MIN_ROOT_SECRET_BYTES * 2) {
      return Buffer.from(value, 'hex');
    }
  } else if (BASE64_ROOT.test(value)) {
    const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length >= MIN_ROOT_SECRET_BYTES) return decoded;
  }
  throw new Error(
    `${ROOT_SECRET_ENV} must be at least ${String(MIN_ROOT_SECRET_BYTES)} bytes, given as hex ` +
      '(64+ characters) or base64/base64url. Generate one with `openssl rand -hex 32`.',
  );
}

/** Where the root came from — the only fact about it safe to expose. */
export type RootSecretSource = 'environment' | 'development';

let developmentRootLogged = false;

/**
 * Say ONCE per process that keys come from the public development root.
 *
 * Logged at the first derivation rather than when `config` resolves the root,
 * so importing config stays silent, and skipped under `NODE_ENV=test`, where
 * the development root is the expected state of every run.
 */
function noteDevelopmentRoot(): void {
  if (developmentRootLogged || process.env.NODE_ENV === 'test') return;
  developmentRootLogged = true;
  log.general.warn(
    `[Secrets] ${ROOT_SECRET_ENV} is unset; deriving internal keys from the public ` +
      'DEVELOPMENT root. Nothing signed or encrypted here is secret.',
  );
}

/**
 * The root and its source, from `env`. Pure: it reads only `env` and logs
 * nothing.
 *
 * @throws In production when the root is unset, and anywhere when it is set
 *   but malformed — a typo must not silently become the public dev root.
 */
export function resolveRootSecret(env: NodeJS.ProcessEnv = process.env): {
  root: Buffer;
  source: RootSecretSource;
} {
  const raw = env[ROOT_SECRET_ENV]?.trim() ?? '';
  if (raw !== '') return { root: parseRootSecret(raw), source: 'environment' };

  if (env.NODE_ENV === 'production') {
    throw new Error(
      `${ROOT_SECRET_ENV} is not set. Every internal signing, hashing and encryption key ` +
        'Mercaria uses is derived from it, so a production task without it can neither ' +
        'verify a token nor read guest contact data. Generate one with `openssl rand -hex 32` ' +
        'and provision it as a secret; see docs/deploy.md "Runtime secrets".',
    );
  }
  return { root: DEVELOPMENT_ROOT_SECRET, source: 'development' };
}

/** The raw 32-byte key for `purpose` under `root`. Pure; exported for tests. */
export function deriveKeyBytes(root: Buffer, purpose: SecretPurpose): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      root,
      HKDF_SALT,
      Buffer.from(`mercaria:${purpose}:v1`, 'utf8'),
      DERIVED_KEY_BYTES,
    ),
  );
}

/** Cache keyed on the raw root value, so a test that changes the env is honoured. */
let cache: { raw: string | undefined; keys: Map<SecretPurpose, Buffer> } | undefined;

/**
 * The derived key for `purpose`, in the shape its consumer takes.
 *
 * Read from `process.env` at use rather than captured at import, like every
 * other key consumer in this backend; the production refusal still happens at
 * boot because `config/index.ts` resolves the root at load.
 */
export function derivedSecret<P extends SecretPurpose>(purpose: P): DerivedSecret<P> {
  const raw = process.env[ROOT_SECRET_ENV];
  if (cache === undefined || cache.raw !== raw) cache = { raw, keys: new Map() };
  let key = cache.keys.get(purpose);
  if (key === undefined) {
    const { root, source } = resolveRootSecret();
    if (source === 'development') noteDevelopmentRoot();
    key = deriveKeyBytes(root, purpose);
    cache.keys.set(purpose, key);
  }
  // A fresh copy, so no caller can mutate the cached key in place.
  const shape: 'bytes' | 'hex' = SECRET_PURPOSES[purpose];
  return (shape === 'hex' ? key.toString('hex') : Buffer.from(key)) as DerivedSecret<P>;
}
