/**
 * A feed's stored credential, and how it reaches the request (#63 §"Feed
 * configuration" 3, security 5).
 *
 * AES-256-GCM under `FEED_IMPORT_AUTH_ENCRYPTION_KEY`, in the ONE
 * self-describing, key-id-prefixed string `lib/guest-pii.ts` established — so a
 * key rotation is re-encryption on read rather than a flag day, and the
 * anonymization of a configuration is a single `SET … = NULL` rather than a
 * consistency rule across three columns.
 *
 * ## A separate key from every other secret in this backend
 *
 * `CONNECTOR_ENCRYPTION_KEY` protects a store's platform access token and
 * `GUEST_PII_ENCRYPTION_KEY` protects a buyer's contact. Sharing one would mean
 * a compromise of the feed importer's key — the least privileged of the three,
 * held by a component that talks to arbitrary merchant-supplied hosts — reads a
 * buyer's email and a merchant's Shopify token. Three keys, three blast radii.
 *
 * ## The key is validated on FIRST USE, never at import
 *
 * `connector-crypto.ts`'s posture, for its reason: a deployment with the feed
 * importer off must still boot. `config`'s half-configuration rule has already
 * refused to enable the feature without the key, so what remains is that an
 * unset key THROWS here rather than silently storing a credential in the clear.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FeedAuthKind } from '@mercaria/shared-types';
import { config } from '../../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const HEX_KEY_PATTERN = new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`);

/** The key id every ciphertext carries, so rotation is lazy re-encryption. */
const CURRENT_KEY_ID = 'v1';

function resolveKey(): Buffer {
  const raw = config.feedImport.authEncryptionKey.trim();
  if (raw === '') {
    throw new Error(
      'FEED_IMPORT_AUTH_ENCRYPTION_KEY is not set. A feed credential cannot be stored without ' +
        'it. Generate a 32-byte key with `openssl rand -hex 32`.',
    );
  }
  if (!HEX_KEY_PATTERN.test(raw)) {
    throw new Error('FEED_IMPORT_AUTH_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return Buffer.from(raw, 'hex');
}

/** Encrypt a feed credential for storage. `v1:<iv>:<tag>:<ciphertext>`, base64url. */
export function encryptFeedCredential(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, resolveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CURRENT_KEY_ID,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt a stored feed credential.
 *
 * A tampered value fails the GCM tag check and throws, which is the point of an
 * authenticated cipher: a credential that decrypts to something OTHER than what
 * was stored would be presented to a merchant's host, and the resulting 401
 * would be reported as an auth failure against a credential that is in fact
 * fine.
 */
export function decryptFeedCredential(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== CURRENT_KEY_ID) {
    throw new Error('A stored feed credential is not in the expected envelope format.');
  }
  const iv = Buffer.from(parts[1] ?? '', 'base64url');
  const tag = Buffer.from(parts[2] ?? '', 'base64url');
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
  const decipher = createDecipheriv(ALGORITHM, resolveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** How one fetch is authenticated, resolved from the row. */
export interface FeedAuthorization {
  readonly kind: FeedAuthKind;
  readonly secret: string | null;
  readonly paramName: string | null;
}

/** A URL and headers with the credential applied. */
export interface AuthorizedFeedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Apply a credential to one request.
 *
 * `query_param` is supported because real networks require it, and it is the
 * reason `redactFeedUrl` exists: the composed URL is a credential from this
 * point on and never reaches a log line, a report or a projection. The
 * `exhaustive` switch means a new auth kind is a `tsc` error here rather than a
 * value that silently fetches unauthenticated.
 */
export function authorizeFeedRequest(
  url: string,
  authorization: FeedAuthorization,
): AuthorizedFeedRequest {
  const kind = authorization.kind;
  const secret = authorization.secret;
  const headers: Record<string, string> = {
    accept: 'text/csv, text/plain, application/xml, text/xml, application/json, */*;q=0.1',
    'accept-encoding': 'identity',
  };

  switch (kind) {
    case 'none':
      return { url, headers };
    case 'basic':
      if (secret === null) return { url, headers };
      return {
        url,
        headers: { ...headers, authorization: `Basic ${Buffer.from(secret).toString('base64')}` },
      };
    case 'bearer':
      if (secret === null) return { url, headers };
      return { url, headers: { ...headers, authorization: `Bearer ${secret}` } };
    case 'header': {
      const name = authorization.paramName;
      if (secret === null || name === null) return { url, headers };
      return { url, headers: { ...headers, [name.toLowerCase()]: secret } };
    }
    case 'query_param': {
      const name = authorization.paramName;
      if (secret === null || name === null) return { url, headers };
      const parsed = new URL(url);
      parsed.searchParams.set(name, secret);
      return { url: parsed.toString(), headers };
    }
  }
}
