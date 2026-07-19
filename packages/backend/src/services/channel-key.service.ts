/**
 * Channel API key service — mint / list / revoke / verify the long-lived,
 * store-scoped keys an external ingest client (e.g. the Mercaria WooCommerce
 * plugin) uses instead of a short-lived Oxy access token.
 *
 * SECURITY MODEL
 * --------------
 * A key is a single opaque secret: `mck_` + 32 random bytes (hex). Only its
 * irreversible sha256 `hash` and a non-secret display `prefix` are persisted —
 * the plaintext is returned exactly ONCE at creation and is unrecoverable
 * afterward. Verification never trusts a database equality match as the auth
 * decision: it narrows candidates by the (public, low-entropy) prefix, then
 * makes the accept/reject call with a CONSTANT-TIME compare of the full sha256
 * hash (`verifySecret` from `@oxyhq/core/server`), so it leaks no timing signal
 * about the secret. Revocation stamps `revokedAt`; revoked keys never verify.
 *
 * All writes are mass-assignment-safe: inputs are destructured into explicit,
 * whitelisted fields — a request body is never spread into a document. Every
 * store-scoped mutation filters by `{ _id, storeId }` so a member of one store
 * can never touch another store's keys.
 */

import crypto from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import type {
  ChannelApiKey as ChannelApiKeyDTO,
  GenerateChannelApiKeyInput,
  GenerateChannelApiKeyResult,
} from '@mercaria/shared-types';
import { CHANNEL_API_KEY_SCOPES } from '@mercaria/shared-types';
import { ChannelApiKey, type IChannelApiKey } from '../models/channel-api-key.js';
import { Connection } from '../models/connection.js';
import { notFound, validationError } from '../lib/errors/error-codes.js';

/** Human-visible marker + namespace for every Mercaria channel key. */
const KEY_PREFIX = 'mck_';
/** Random secret length in bytes (→ 64 hex chars of entropy). */
const KEY_RANDOM_BYTES = 32;
/** Total plaintext length: `mck_` + 64 hex chars. */
const KEY_LENGTH = KEY_PREFIX.length + KEY_RANDOM_BYTES * 2;
/** Length of the stored display prefix: `mck_` + the first 8 hex chars. */
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 8;

/** The irreversible sha256 hex digest of a value — the stored form of a key. */
function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Resolved identity of a verified key, returned by `verifyKey`. */
export interface VerifiedChannelKey {
  keyId: string;
  storeId: string;
  connectionId?: string;
}

/** Map a key document to its credential-free metadata DTO. */
function toDto(doc: IChannelApiKey): ChannelApiKeyDTO {
  const dto: ChannelApiKeyDTO = {
    id: String(doc._id),
    storeId: doc.storeId,
    prefix: doc.prefix,
    label: doc.label,
    scopes: [...doc.scopes],
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.toISOString(),
  };
  if (doc.connectionId) {
    dto.connectionId = doc.connectionId;
  }
  if (doc.lastUsedAt) {
    dto.lastUsedAt = doc.lastUsedAt.toISOString();
  }
  return dto;
}

/**
 * Mint a new channel key for `storeId`. When `connectionId` is given it must
 * belong to the store AND be a `push_in` channel (binding a key to a pull
 * connection is meaningless — the key only authorizes ingestion). Returns the
 * plaintext key ONCE alongside the stored metadata.
 */
export async function generateKey(
  storeId: string,
  input: GenerateChannelApiKeyInput,
  oxyUserId: string,
): Promise<GenerateChannelApiKeyResult> {
  const label = input.label.trim();
  if (label.length === 0) {
    throw validationError('A label is required');
  }

  const { connectionId } = input;
  if (connectionId !== undefined) {
    const conn = await Connection.findOne({ _id: connectionId, storeId }).select('_id mode');
    if (!conn) {
      throw notFound('Connection not found');
    }
    if (conn.mode !== 'push_in') {
      throw validationError('A channel key can only be bound to a push-in connection');
    }
  }

  const raw = KEY_PREFIX + crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');

  const doc = await ChannelApiKey.create({
    storeId,
    ...(connectionId !== undefined ? { connectionId } : {}),
    hash: hashKey(raw),
    prefix: raw.slice(0, DISPLAY_PREFIX_LENGTH),
    label,
    scopes: [...CHANNEL_API_KEY_SCOPES],
    createdBy: oxyUserId,
  });

  return { key: raw, apiKey: toDto(doc) };
}

/** List a store's ACTIVE (non-revoked) keys, newest first. Metadata only. */
export async function listKeys(storeId: string): Promise<ChannelApiKeyDTO[]> {
  const docs = await ChannelApiKey.find({ storeId, revokedAt: { $exists: false } }).sort({
    createdAt: -1,
  });
  return docs.map(toDto);
}

/**
 * Revoke a store's key by id. Store-scoped (`{ _id, storeId }`) so a cross-store
 * revoke can never match. Idempotent-safe: a missing/foreign/already-revoked key
 * yields a 404 rather than silently succeeding.
 */
export async function revokeKey(storeId: string, keyId: string): Promise<ChannelApiKeyDTO> {
  const doc = await ChannelApiKey.findOneAndUpdate(
    { _id: keyId, storeId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
    { new: true },
  );
  if (!doc) {
    throw notFound('Channel API key not found');
  }
  return toDto(doc);
}

/**
 * Verify a presented plaintext key. Resolves the key's `{ storeId, connectionId? }`
 * when a NON-REVOKED key matches, or `null` otherwise (malformed, unknown, or
 * revoked). On a match `lastUsedAt` is refreshed. The accept decision is a
 * constant-time compare of the full sha256 hash — never a bare DB equality.
 */
export async function verifyKey(raw: string): Promise<VerifiedChannelKey | null> {
  if (typeof raw !== 'string' || !raw.startsWith(KEY_PREFIX) || raw.length !== KEY_LENGTH) {
    return null;
  }

  const prefix = raw.slice(0, DISPLAY_PREFIX_LENGTH);
  const candidateHash = hashKey(raw);

  const candidates = await ChannelApiKey.find({
    prefix,
    revokedAt: { $exists: false },
  }).select('_id storeId connectionId hash');

  for (const candidate of candidates) {
    if (verifySecret(candidateHash, candidate.hash)) {
      await ChannelApiKey.updateOne({ _id: candidate._id }, { $set: { lastUsedAt: new Date() } });
      const resolved: VerifiedChannelKey = {
        keyId: String(candidate._id),
        storeId: candidate.storeId,
      };
      if (candidate.connectionId) {
        resolved.connectionId = candidate.connectionId;
      }
      return resolved;
    }
  }

  return null;
}
