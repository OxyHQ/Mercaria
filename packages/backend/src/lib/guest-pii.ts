/**
 * Guest contact PII at rest — encryption, keyed hashing and redaction
 * (ADR 0003 D12, #105).
 *
 * Three operations on one email address, each with a DIFFERENT key and a
 * different reason, and the separation is the design rather than an accident of
 * implementation:
 *
 *  - **`encryptGuestPii`** — AES-256-GCM under the guest-contact key.
 *    This is the only form that can be turned back into the address the buyer
 *    typed, which is what a transactional mail has to be sent to. It is a
 *    self-describing string, key-id prefixed, so rotation is re-encryption at
 *    read rather than a flag day.
 *  - **`guestEmailHash`** — HMAC-SHA-256 under the SEPARATE email-hash
 *    key. KEYED, unlike this codebase's token hashes, and
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
 * ## Both keys are derived, under DIFFERENT purposes
 *
 * `lib/derived-secrets.ts` derives each from `MERCARIA_SECRET_KEY` with its own
 * HKDF label, so they are always present and never equal — the lookup path
 * holds a key that cannot decrypt, by construction.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { derivedSecret } from './derived-secrets.js';

/** AES-256-GCM: authenticated encryption, so tampering is a decrypt failure. */
const ALGORITHM = 'aes-256-gcm';
/** 96-bit nonce — the GCM-recommended size. */
const IV_BYTES = 12;

/**
 * The key id every ciphertext carries.
 *
 * ADR 0003 D4 asks for it explicitly, and the reason is operational: with the
 * id inside the value, a key rotation re-encrypts lazily on read (decrypt under
 * the id the row names, re-encrypt under the current one) instead of requiring
 * every row to be rewritten before the new key can be used anywhere.
 */
const CURRENT_KEY_ID = 'v1';

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
  const key = derivedSecret('guest-pii-encryption');
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
  const key = derivedSecret('guest-pii-encryption');
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
  const key = Buffer.from(derivedSecret('guest-email-hash'), 'hex');
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
