/**
 * Sealing and unsealing a fulfilment artifact (#1016 Workstream 19, ADR 0011 D10).
 *
 * This is the ONE module in the repository that handles third-party bearer secret
 * material in clear, and it handles it for as long as one function call takes.
 * Everything else — the repository, the orchestrator, the library, the support
 * view — sees ciphertext or a four-character hint.
 *
 * ## Envelope encryption, and why the key REFERENCE is stored beside it
 *
 * AES-256-GCM with a random 96-bit IV per artifact, and the row records WHICH key
 * sealed it as a path into the approved secret store — never the key. Three
 * things follow, and each is a requirement the epic states:
 *
 *  - a database dump opens nothing (W19 requirement 1);
 *  - a key rotation is possible at all, because every row says which key it needs
 *    (W19 requirement 2 — key management is separate from DB access);
 *  - a backup carries ciphertext, so it needs the protection of a backup rather
 *    than the protection of a vault (W19 requirement 8).
 *
 * GCM rather than CBC because an artifact that decrypts to plausible garbage
 * after tampering is a key a support agent would read out to a customer. The tag
 * makes that a thrown error instead.
 *
 * ## The resolver is a SEAM, and it fails closed
 *
 * `SealingKeyResolver` is how a key reference becomes bytes. The default reads
 * the process environment, which is how this deployment carries its keys today;
 * a resolver that reaches SSM or KMS drops in without touching a call site. What
 * neither may do is invent a key: an unresolvable reference THROWS, so an
 * unsealed artifact cannot be written by a deployment that was never configured.
 *
 * ## `maskedHint` is the last four characters, and that is deliberate
 *
 * Not the first four. A key's leading characters are frequently a product or
 * region prefix shared by every key of a batch, so a leading hint distinguishes
 * nothing; a trailing one is what a customer reads off their screen when support
 * asks. Four characters cannot reconstruct a key (ADR 0011 D10).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** The one algorithm this module writes. The column records it per artifact. */
export const SEAL_ALGORITHM = 'aes-256-gcm.v1';

/** How a key reference becomes key bytes. Never inline, never a default key. */
export interface SealingKeyResolver {
  /** 32 bytes for AES-256. THROWS when the reference cannot be resolved. */
  resolve(keyReference: string): Promise<Buffer>;
}

/** A sealed artifact, as the repository stores it. No plaintext anywhere. */
export interface SealedArtifact {
  readonly sealedSecret: string;
  readonly keyReference: string;
  readonly sealAlgorithm: string;
  readonly plaintextSha256: string;
  readonly maskedHint: string;
}

/**
 * The key reference's shape, matching the column's own CHECK.
 *
 * A path, not a value. The CHECK on `digital_fulfilment_artifacts.key_reference`
 * is the same one `supplier_accounts.credential_reference` carries, so a pasted
 * key fails the write — and validating it HERE as well means the failure happens
 * before anything is encrypted with something that is not a key.
 */
const KEY_REFERENCE_SHAPE = /^\/[A-Za-z0-9/_.-]+$/;

/**
 * Resolve a key from the process environment.
 *
 * `/oxy/mercaria/digital-retail/seal/live` becomes
 * `DIGITAL_RETAIL_SEAL_KEY_LIVE` — the last path segment, upper-cased. The
 * mapping is mechanical so an operator can read a row and know which variable to
 * set, and it is NARROW: only references under this domain's own prefix resolve,
 * so a reference pointing anywhere else fails rather than reaching for a
 * plausibly-named variable.
 */
export function environmentKeyResolver(
  env: NodeJS.ProcessEnv = process.env,
): SealingKeyResolver {
  const PREFIX = '/oxy/mercaria/digital-retail/seal/';
  return {
    async resolve(keyReference: string): Promise<Buffer> {
      if (!keyReference.startsWith(PREFIX)) {
        throw new Error(
          `digital-retail sealing key reference must live under ${PREFIX}; received ${keyReference}`,
        );
      }
      const name = keyReference.slice(PREFIX.length).replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
      const value = env[`DIGITAL_RETAIL_SEAL_KEY_${name}`];
      if (!value) {
        throw new Error(
          `no sealing key configured for ${keyReference} ` +
            `(expected DIGITAL_RETAIL_SEAL_KEY_${name})`,
        );
      }
      const key = Buffer.from(value, 'base64');
      if (key.length !== 32) {
        throw new Error(
          `sealing key ${keyReference} must be 32 bytes base64-encoded, received ${key.length}`,
        );
      }
      return key;
    },
  };
}

/** The tail of a secret, bounded to four characters. Never its head. */
export function maskedHintFor(plaintext: string): string {
  const trimmed = plaintext.trim();
  return trimmed.slice(Math.max(0, trimmed.length - 4));
}

/**
 * Seal one artifact.
 *
 * The plaintext is never returned, never logged and never stored — and the
 * digest beside it is of the plaintext, so support can match a customer's key
 * against what was sold without anybody reading either.
 */
export async function sealArtifactSecret(
  plaintext: string,
  keyReference: string,
  resolver: SealingKeyResolver,
): Promise<SealedArtifact> {
  if (plaintext.trim().length === 0) {
    throw new Error('an artifact secret cannot be empty: seal nothing, store nothing');
  }
  if (!KEY_REFERENCE_SHAPE.test(keyReference) || keyReference.length > 512) {
    throw new Error(
      `"${keyReference}" is not a secret-store path; a raw key must never be passed here`,
    );
  }
  const key = await resolver.resolve(keyReference);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    sealedSecret: [
      'v1',
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':'),
    keyReference,
    sealAlgorithm: SEAL_ALGORITHM,
    plaintextSha256: createHash('sha256').update(plaintext, 'utf8').digest('hex'),
    maskedHint: maskedHintFor(plaintext),
  };
}

/**
 * Unseal one artifact.
 *
 * Throws on a tampered ciphertext rather than returning garbage — the reason for
 * GCM. The ONE caller is the reveal path, which has already authorized the buyer
 * and which records the reveal in the same transaction.
 */
export async function unsealArtifactSecret(
  sealedSecret: string,
  keyReference: string,
  resolver: SealingKeyResolver,
): Promise<string> {
  const parts = sealedSecret.split(':');
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (parts.length !== 4 || version !== 'v1' || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('sealed artifact is not in the v1 envelope format');
  }
  const key = await resolver.resolve(keyReference);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Whether a candidate secret is the one that was sold, without revealing either.
 *
 * The support question — *"is the key you are holding the key we sold you"* —
 * answered from the stored digest. Constant-time, because an early-exit compare
 * over a digest leaks it one byte at a time to anyone who can call this enough.
 */
export function artifactDigestMatches(candidatePlaintext: string, storedSha256: string): boolean {
  const candidate = createHash('sha256').update(candidatePlaintext, 'utf8').digest();
  let stored: Buffer;
  try {
    stored = Buffer.from(storedSha256, 'hex');
  } catch {
    return false;
  }
  if (stored.length !== candidate.length) return false;
  return timingSafeEqual(candidate, stored);
}
