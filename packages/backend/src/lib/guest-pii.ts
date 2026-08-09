/**
 * Guest contact PII at rest — encryption, keyed hashing and redaction
 * (ADR 0003 D12, #105).
 *
 * Three operations on one email address, each with a DIFFERENT key and a
 * different reason, and the separation is the design rather than an accident of
 * implementation:
 *
 *  - **`encryptGuestPii`** — AES-256-GCM under `GUEST_PII_ENCRYPTION_KEY`.
 *    This is the only form that can be turned back into the address the buyer
 *    typed, which is what a transactional mail has to be sent to. It is a
 *    self-describing string, key-id prefixed, so rotation is re-encryption at
 *    read rather than a flag day.
 *  - **`guestEmailHash`** — HMAC-SHA-256 under the SEPARATE
 *    `GUEST_EMAIL_HASH_KEY`. KEYED, unlike this codebase's token hashes, and
 *    for the opposite entropy reason: a 256-bit random token needs no key
 *    because it cannot be guessed, while an email address has dictionary-scale
 *    entropy and a plain SHA-256 column would be offline-reversible the day the
 *    table leaked. Two keys, because the lookup path must be able to hash
 *    without ever being able to decrypt.
 *  - **`redactEmail`** — `j***@example.com`, the ONLY form a support surface
 *    ever renders (ADR 0003 T15).
 *
 * ## What no caller may do with the hash
 *
 * `email_hash` has exactly two permitted uses (D12): routing a magic-link
 * request to its checkouts (#108) and abuse velocity counting. It is never an
 * authorization input (I2/I4), never a join key to an Oxy account (I6), and
 * never leaves the backend — #105 stores it and reads it back for neither
 * purpose yet, which is precisely why the projection this domain exposes has no
 * field for it (`guest-checkout.service.ts`).
 *
 * ## The keys are validated on FIRST USE, never at import
 *
 * The `connector-crypto.ts` posture, for the same reason: a deployment with
 * guest commerce switched off must still boot, and `config`'s
 * half-configuration rule has already refused to enable the feature without
 * both keys. What must never happen is a SILENT fallback — an unset key throws
 * here rather than storing a guest's address in the clear.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

/** AES-256-GCM: authenticated encryption, so tampering is a decrypt failure. */
const ALGORITHM = 'aes-256-gcm';
/** 256-bit key. */
const KEY_BYTES = 32;
/** 96-bit nonce — the GCM-recommended size. */
const IV_BYTES = 12;
/** A valid key is exactly `KEY_BYTES` bytes ⇔ `KEY_BYTES * 2` hex characters. */
const HEX_KEY_PATTERN = new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`);

/**
 * The key id every ciphertext carries.
 *
 * ADR 0003 D4 asks for it explicitly, and the reason is operational: with the
 * id inside the value, a key rotation re-encrypts lazily on read (decrypt under
 * the id the row names, re-encrypt under the current one) instead of requiring
 * every row to be rewritten before the new key can be used anywhere.
 */
const CURRENT_KEY_ID = 'v1';

/** Resolve and validate a hex key from config, or throw a directive error. */
function resolveKey(value: string, name: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${name} is not set. Guest contact cannot be stored without it. ` +
        'Generate a 32-byte key with `openssl rand -hex 32`.',
    );
  }
  if (!HEX_KEY_PATTERN.test(trimmed)) {
    throw new Error(`${name} must be a 64-character hex string (32 bytes).`);
  }
  return Buffer.from(trimmed, 'hex');
}

/**
 * Encrypt a guest contact value for storage.
 *
 * Returns ONE self-describing string — `v1:<iv>:<tag>:<ciphertext>`, all three
 * parts base64url — rather than three columns. A single column is what makes
 * the anonymization transition of ADR 0003 D15 a single `SET … = NULL`, and
 * what lets the D4 immutability trigger express "the contact may change only to
 * NULL" as a condition on one value instead of a consistency rule across three.
 *
 * A fresh random IV per call, so the same address encrypted twice yields
 * different ciphertext — which is also why the ciphertext is useless as a
 * lookup key and the HMAC exists.
 */
export function encryptGuestPii(plaintext: string): string {
  const key = resolveKey(config.guest.piiEncryptionKey, 'GUEST_PII_ENCRYPTION_KEY');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    CURRENT_KEY_ID,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt a stored guest contact value.
 *
 * Used by the transactional-mail path (#108) and by the named, audited operator
 * decrypt (ADR 0003 T15). It is exported from here rather than from the service
 * so that "who can read a guest's email" is a question answered by grepping ONE
 * function name.
 */
export function decryptGuestPii(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new Error('Stored guest contact is not a recognised ciphertext.');
  }
  const [keyId, iv, tag, ciphertext] = parts;
  if (keyId !== CURRENT_KEY_ID) {
    // Named rather than swallowed: an unknown key id means the row was written
    // under a key this build does not have, and guessing would produce garbage
    // that reads as a valid address.
    throw new Error(`Stored guest contact uses unknown key id "${keyId}".`);
  }
  const key = resolveKey(config.guest.piiEncryptionKey, 'GUEST_PII_ENCRYPTION_KEY');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The keyed lookup hash of an ALREADY-NORMALIZED email (D12).
 *
 * Takes the normalized form and does not normalize itself, deliberately: the
 * normalization rule is a policy decision that lives in one place
 * (`services/checkout/contact.ts`), and a hash function that quietly applied its
 * own would be a second, drifting copy of it — with the failure mode that two
 * call sites produce two different hashes for one inbox.
 */
export function guestEmailHash(normalizedEmail: string): string {
  const key = resolveKey(config.guest.emailHashKey, 'GUEST_EMAIL_HASH_KEY');
  return createHmac('sha256', key).update(normalizedEmail, 'utf8').digest('hex');
}

/**
 * The support-surface display form: `j***@example.com` (ADR 0003 T15).
 *
 * The domain survives whole because it is what makes a redacted address useful
 * to a support agent ("the confirmation went to a gmail address, not their work
 * one") without identifying the person. The local part keeps exactly its first
 * character — a length-proportional mask would leak the length, which for short
 * local parts is close to leaking the address.
 *
 * Never throws on a malformed input: it is a DISPLAY function, and the caller
 * has already validated. An address with no `@` is masked whole.
 */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * The display form of a phone number: the last two digits only.
 *
 * Same reasoning as {@link redactEmail} — enough for a support agent to confirm
 * a number a caller reads out, not enough to dial or to correlate.
 */
export function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 2 ? '***' : `***${digits.slice(-2)}`;
}
