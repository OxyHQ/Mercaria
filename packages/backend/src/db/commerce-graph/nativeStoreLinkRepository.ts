/**
 * Reads and writes for `native_store_links` — the verified, reversible 1:1
 * join between a canonical merchant and a native `stores` row (ADR 0002 D4).
 *
 * The two paired partial uniques (`…_store_id_active_key`,
 * `…_merchant_id_active_key`) are the cardinality authority; this repository
 * only interprets them. {@link insertNativeStoreLink} uses a bare
 * `onConflictDoNothing()` — no target — because EITHER index may be the one
 * that fires and `ON CONFLICT` can name only one arbiter: an empty RETURNING
 * set means "some active link already holds one side", and the SERVICE then
 * reads both sides to say which. Two concurrent link attempts therefore
 * produce exactly one active link and one clean refusal, never a duplicate
 * and never an unhandled 23505.
 */

import { and, eq } from 'drizzle-orm';
import type { NativeStoreLinkMethod } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { nativeStoreLinks } from '../schema/merchants.js';

/** A link row as the services read it back. */
export type NativeStoreLinkRow = typeof nativeStoreLinks.$inferSelect;

/** What a verified link creation supplies. Every field is mandatory but the note. */
export interface CreateNativeStoreLinkInput {
  merchantId: string;
  storeId: string;
  verificationMethod: NativeStoreLinkMethod;
  verificationNote?: string;
  verifiedByOxyUserId: string;
  verifiedAt: Date;
}

/**
 * Claim an active link, or return `undefined` when either side already has
 * one. The row IS the audit record — method, actor and time are NOT NULL in
 * the schema, so an unverifiable link is unrepresentable, not just refused.
 */
export async function insertNativeStoreLink(
  db: DatabaseOrTransaction,
  input: CreateNativeStoreLinkInput,
): Promise<NativeStoreLinkRow | undefined> {
  const [row] = await db
    .insert(nativeStoreLinks)
    .values({
      merchantId: input.merchantId,
      storeId: input.storeId,
      verificationMethod: input.verificationMethod,
      verificationNote: input.verificationNote ?? null,
      verifiedByOxyUserId: input.verifiedByOxyUserId,
      verifiedAt: input.verifiedAt,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function findNativeStoreLinkById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<NativeStoreLinkRow | undefined> {
  const [row] = await db.select().from(nativeStoreLinks).where(eq(nativeStoreLinks.id, id));
  return row;
}

/** The active link a store resolves through, if any. At most one by construction. */
export async function findActiveLinkByStore(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<NativeStoreLinkRow | undefined> {
  const [row] = await db
    .select()
    .from(nativeStoreLinks)
    .where(and(eq(nativeStoreLinks.storeId, storeId), eq(nativeStoreLinks.status, 'active')));
  return row;
}

/** The active link a merchant resolves through, if any. At most one by construction. */
export async function findActiveLinkByMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<NativeStoreLinkRow | undefined> {
  const [row] = await db
    .select()
    .from(nativeStoreLinks)
    .where(
      and(eq(nativeStoreLinks.merchantId, merchantId), eq(nativeStoreLinks.status, 'active')),
    );
  return row;
}

/** Full link history for a store, revoked rows included — the audit read. */
export async function listLinksByStore(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<NativeStoreLinkRow[]> {
  return db.select().from(nativeStoreLinks).where(eq(nativeStoreLinks.storeId, storeId));
}

/**
 * Revoke an active link — a single-statement CAS (`WHERE id AND status =
 * 'active'`), so two concurrent revocations produce exactly one winner and
 * the loser learns from the empty RETURNING set rather than double-stamping
 * the audit fields.
 */
export async function revokeNativeStoreLink(
  db: DatabaseOrTransaction,
  input: { linkId: string; revokedByOxyUserId: string; revokedAt: Date; reason: string },
): Promise<NativeStoreLinkRow | undefined> {
  const [row] = await db
    .update(nativeStoreLinks)
    .set({
      status: 'revoked',
      revokedAt: input.revokedAt,
      revokedByOxyUserId: input.revokedByOxyUserId,
      revokeReason: input.reason,
    })
    .where(and(eq(nativeStoreLinks.id, input.linkId), eq(nativeStoreLinks.status, 'active')))
    .returning();
  return row;
}
