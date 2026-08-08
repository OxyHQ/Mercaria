/**
 * `channel_api_keys` — the long-lived, store-scoped ingest credential an
 * external client (the Mercaria WooCommerce plugin) presents instead of a
 * short-lived Oxy access token.
 *
 * ## `hash` is protected, and it is protected even though it is irreversible
 *
 * The plaintext key is never stored: only its sha256 hex digest and the
 * non-secret display `prefix`. The digest is registered in
 * `db/protectedColumns.ts` anyway, because handing it to a client hands them an
 * OFFLINE oracle to test guessed keys against — no rate limit, no log line. Every
 * read here therefore goes through `publicColumns`, and
 * {@link findVerificationCandidates} is the ONE path that names `hash`
 * explicitly, which is the greppable opt-in the registry asks for.
 *
 * ## Verification is a coarse lookup plus a constant-time decision
 *
 * `UNIQUE(hash)` would make a single equality lookup correct and it is
 * deliberately NOT how a key is verified. An indexed equality on the secret's
 * stored form is a comparison whose timing and whose very success depend on the
 * secret; the narrowing is done on the PUBLIC `prefix` instead (its own index),
 * and the accept/reject decision is made by the caller with `verifySecret` from
 * `@oxyhq/core/server` over the full digest. This module returns candidates and
 * makes no decision at all — which is why it cannot be the place a `!==` creeps
 * back in.
 *
 * ## A key is revoked, never deleted
 *
 * {@link revokeChannelApiKey} stamps `revoked_at` and returns the row; the audit
 * trail of who minted what, and when it was last used, outlives the key. There is
 * deliberately no delete function in this module, and the guard on that update is
 * `revoked_at IS NULL`, so a second revoke reports "nothing to revoke" rather
 * than silently re-stamping a new timestamp over the original one.
 *
 * ## `revoked_at IS NULL` is the exact port of Mongo's `$exists: false`
 *
 * Both spellings mean the same set here only because revocation is the sole
 * writer of that column and always writes a real `Date`. A field Mongo left
 * ABSENT is NULL in Postgres, never `''` — the empty string is a value and would
 * read as revoked-at-the-epoch, which is why nothing in this module ever writes
 * one.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { channelApiKeys } from '../schema/connectors.js';

/** Every column of `channel_api_keys` a caller may see — the digest withheld. */
const PUBLIC_KEY_COLUMNS = publicColumns(channelApiKeys, PROTECTED_COLUMNS);

/** One row of `channel_api_keys`, without the stored digest. */
export type ChannelApiKeyRow = SelectedRow<typeof PUBLIC_KEY_COLUMNS>;

/**
 * A candidate for constant-time verification: the digest, plus the identity a
 * successful compare resolves to. Nothing else — a candidate set is built from
 * a public prefix an attacker can supply, so it carries no more than the
 * decision needs.
 */
export interface ChannelApiKeyCandidate {
  id: string;
  storeId: string;
  connectionId: string | null;
  hash: string;
}

/** The columns a caller may set when minting a key. */
export interface NewChannelApiKey {
  storeId: string;
  connectionId?: string;
  /** sha256 hex digest of the plaintext — the only stored form of the secret. */
  hash: string;
  /** The non-secret leading characters, for display and the coarse lookup. */
  prefix: string;
  label: string;
  scopes: string[];
  createdBy: string;
}

/**
 * Mint a key.
 *
 * `scopes` is required of the caller rather than defaulted here: the column's own
 * DDL default is the EMPTY array (Mongoose defaulted it to the full scope set),
 * so the caller's explicit write is the only thing that gives a key any authority
 * at all. A caller that forgot it would mint a key that authenticates and
 * authorizes nothing — which is the fail-closed direction, and still worth
 * stating so nobody "fixes" it by adding a default back.
 *
 * @throws A unique violation (SQLSTATE 23505) on `channel_api_keys_hash_key` if
 *   the digest is already stored. Not caught: two distinct plaintexts colliding
 *   on sha256 is not a case to recover from, and the same plaintext being minted
 *   twice means the generator repeated itself.
 */
export async function insertChannelApiKey(
  values: NewChannelApiKey,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelApiKeyRow> {
  const [row] = await db
    .insert(channelApiKeys)
    .values({
      storeId: values.storeId,
      ...(values.connectionId !== undefined ? { connectionId: values.connectionId } : {}),
      hash: values.hash,
      prefix: values.prefix,
      label: values.label,
      scopes: [...values.scopes],
      createdBy: values.createdBy,
    })
    .returning(PUBLIC_KEY_COLUMNS);
  return row;
}

/** A store's ACTIVE (non-revoked) keys, newest first. Metadata only. */
export async function findActiveChannelApiKeys(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelApiKeyRow[]> {
  return db
    .select(PUBLIC_KEY_COLUMNS)
    .from(channelApiKeys)
    .where(and(eq(channelApiKeys.storeId, storeId), isNull(channelApiKeys.revokedAt)))
    .orderBy(desc(channelApiKeys.createdAt), desc(channelApiKeys.id));
}

/**
 * Revoke a store's key.
 *
 * Store-scoped, so a cross-store revoke matches nothing and yields `null`, which
 * the caller turns into a 404 — the same answer a missing key gets, so the
 * response cannot be used to probe which store owns an id.
 *
 * @returns The revoked row, or `null` when there was nothing active to revoke
 *   (missing, foreign, or already revoked). The `revoked_at IS NULL` guard and
 *   the update are ONE statement, so two concurrent revokes produce exactly one
 *   winner and one `null` rather than two rows both claiming to have done it.
 */
export async function revokeChannelApiKey(
  storeId: string,
  keyId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelApiKeyRow | null> {
  const [row] = await db
    .update(channelApiKeys)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(channelApiKeys.id, keyId),
        eq(channelApiKeys.storeId, storeId),
        isNull(channelApiKeys.revokedAt),
      ),
    )
    .returning(PUBLIC_KEY_COLUMNS);
  return row ?? null;
}

/**
 * The ACTIVE keys sharing a display prefix — the candidate set the caller
 * constant-time compares against.
 *
 * The ONE protected read in this module: it names `hash` in its select object,
 * which is the opt-in that keeps every place the digest is read findable by
 * grepping for it. Deliberately NOT scoped by store — a presented key names no
 * store; resolving which store it belongs to is the whole point.
 */
export async function findVerificationCandidates(
  prefix: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ChannelApiKeyCandidate[]> {
  return db
    .select({
      id: channelApiKeys.id,
      storeId: channelApiKeys.storeId,
      connectionId: channelApiKeys.connectionId,
      hash: channelApiKeys.hash,
    })
    .from(channelApiKeys)
    .where(and(eq(channelApiKeys.prefix, prefix), isNull(channelApiKeys.revokedAt)));
}

/** Stamp a key as used — the write a successful verification makes. */
export async function touchChannelApiKeyLastUsed(
  keyId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(channelApiKeys)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(channelApiKeys.id, keyId));
}
