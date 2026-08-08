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
 * store-scoped mutation filters by `{ id, storeId }` so a member of one store
 * can never touch another store's keys.
 *
 * ## Ported to Postgres — the security model got structural help
 *
 * `hash` is a PROTECTED column now (`db/protectedColumns.ts`), so the row type
 * every read here returns has no such property at all: {@link toDto} could not
 * serialize the digest even if someone added a line trying to. The ONE path that
 * needs it names it explicitly — `findVerificationCandidates` — which is the
 * greppable opt-in, and it hands back candidates rather than a verdict, so the
 * accept decision stays where it belongs, in the constant-time compare below.
 *
 * `UNIQUE(hash)` would make verification a single indexed equality and that is
 * deliberately NOT what this does: the narrowing is on the public `prefix`, and
 * the decision is `verifySecret`. Nothing here ever compares a digest with `!==`.
 *
 * Two Mongo idioms translated rather than transcribed: `revokedAt: { $exists:
 * false }` is `revoked_at IS NULL` (equivalent only because revocation is the
 * sole writer of that column and always writes a real `Date` — a `''` would be a
 * VALUE and read as revoked), and the revoke's filter-plus-update is ONE
 * conditional UPDATE, so two concurrent revokes produce exactly one winner.
 */

import crypto from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import type {
  ChannelApiKey as ChannelApiKeyDTO,
  ChannelApiKeyScope,
  GenerateChannelApiKeyInput,
  GenerateChannelApiKeyResult,
} from '@mercaria/shared-types';
import { CHANNEL_API_KEY_SCOPES } from '@mercaria/shared-types';
import {
  findActiveChannelApiKeys,
  findVerificationCandidates,
  insertChannelApiKey,
  revokeChannelApiKey,
  touchChannelApiKeyLastUsed,
  type ChannelApiKeyRow,
} from '../db/connectors/channelApiKeyRepository.js';
import { findConnection } from '../db/connectors/connectionRepository.js';
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

/** True when a stored scope string is one this build knows about. */
function isKnownScope(scope: string): scope is ChannelApiKeyScope {
  return (CHANNEL_API_KEY_SCOPES as readonly string[]).includes(scope);
}

/**
 * Map a key row to its credential-free metadata DTO.
 *
 * The row type carries no `hash` — it is read through `publicColumns` — so this
 * cannot leak the digest by omission or by a later edit.
 *
 * `scopes` is filtered rather than asserted: the column is `text[]` with an
 * element CHECK, which constrains the DATABASE but tells TypeScript nothing, and
 * a row written by an older build could carry a scope this one has since
 * removed. Dropping an unknown scope is the fail-closed direction — the
 * alternative is handing a caller a scope string the authorization code will not
 * recognise.
 */
function toDto(row: ChannelApiKeyRow): ChannelApiKeyDTO {
  const dto: ChannelApiKeyDTO = {
    id: row.id,
    storeId: row.storeId,
    prefix: row.prefix,
    label: row.label,
    scopes: row.scopes.filter(isKnownScope),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.connectionId) {
    dto.connectionId = row.connectionId;
  }
  if (row.lastUsedAt) {
    dto.lastUsedAt = row.lastUsedAt.toISOString();
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
    // Store-scoped: a connection of another store resolves to `null`, which is
    // the same 404 a missing one gets — so the response cannot be used to probe
    // which store owns an id.
    const conn = await findConnection(storeId, connectionId);
    if (!conn) {
      throw notFound('Connection not found');
    }
    if (conn.mode !== 'push_in') {
      throw validationError('A channel key can only be bound to a push-in connection');
    }
  }

  const raw = KEY_PREFIX + crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');

  // `scopes` is written explicitly, and now it HAS to be: the column's DDL
  // default is the empty array, where Mongoose defaulted it to the full set.
  const row = await insertChannelApiKey({
    storeId,
    ...(connectionId !== undefined ? { connectionId } : {}),
    hash: hashKey(raw),
    prefix: raw.slice(0, DISPLAY_PREFIX_LENGTH),
    label,
    scopes: [...CHANNEL_API_KEY_SCOPES],
    createdBy: oxyUserId,
  });

  return { key: raw, apiKey: toDto(row) };
}

/** List a store's ACTIVE (non-revoked) keys, newest first. Metadata only. */
export async function listKeys(storeId: string): Promise<ChannelApiKeyDTO[]> {
  const rows = await findActiveChannelApiKeys(storeId);
  return rows.map(toDto);
}

/**
 * Revoke a store's key by id. Store-scoped (`{ id, storeId }`) so a cross-store
 * revoke can never match. Idempotent-safe: a missing/foreign/already-revoked key
 * yields a 404 rather than silently succeeding.
 *
 * The row is KEPT — revocation stamps `revoked_at` and nothing in this service
 * deletes a key, so who minted what and when it was last used survives the key.
 */
export async function revokeKey(storeId: string, keyId: string): Promise<ChannelApiKeyDTO> {
  const row = await revokeChannelApiKey(storeId, keyId);
  if (!row) {
    throw notFound('Channel API key not found');
  }
  return toDto(row);
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

  // The narrowing is on the PUBLIC prefix; `UNIQUE(hash)` would make a single
  // indexed equality lookup work and is deliberately not used, because that makes
  // the database's index the accept decision. The decision is the constant-time
  // compare below, over the full digest.
  const candidates = await findVerificationCandidates(prefix);

  for (const candidate of candidates) {
    if (verifySecret(candidateHash, candidate.hash)) {
      await touchChannelApiKeyLastUsed(candidate.id);
      const resolved: VerifiedChannelKey = {
        keyId: candidate.id,
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
