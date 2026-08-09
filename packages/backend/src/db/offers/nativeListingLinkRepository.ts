/**
 * `native_listing_links` — the attachment of one native `product_variants` row
 * to one canonical variant (ADR 0002 D6, table owned by #57 per D25(a)).
 *
 * Reads and writes only. WHO decides an attachment — #58's matcher, #59's
 * review tooling, #60's backfill — is deliberately not here: this module knows
 * how to store a decision and how to supersede one, and nothing about how to
 * make one. `offer-isolation.test.ts` fails the build if that changes.
 *
 * Superseding is TWO statements in the caller's transaction rather than an
 * `ON CONFLICT` upsert, because the old row must survive as history with its own
 * method, rule and confidence intact — an upsert would rewrite the record of how
 * the previous attachment was decided.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';
import { nativeListingLinks } from '../schema/offers.js';

export type NativeListingLinkRow = typeof nativeListingLinks.$inferSelect;
export type InsertNativeListingLinkInput = typeof nativeListingLinks.$inferInsert;

export async function insertNativeListingLink(
  db: DatabaseOrTransaction,
  values: InsertNativeListingLinkInput,
): Promise<NativeListingLinkRow> {
  const rows = await db.insert(nativeListingLinks).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertNativeListingLink returned no row.');
  return row;
}

/** The ACTIVE attachment of one native variant, if it has one. */
export async function findActiveLinkForVariant(
  db: DatabaseOrTransaction,
  productVariantId: string,
): Promise<NativeListingLinkRow | undefined> {
  const rows = await db
    .select()
    .from(nativeListingLinks)
    .where(
      and(
        eq(nativeListingLinks.productVariantId, productVariantId),
        eq(nativeListingLinks.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Every ACTIVE attachment under one listing — what the converger reads. */
export async function findActiveLinksForListing(
  db: DatabaseOrTransaction,
  listingId: string,
): Promise<NativeListingLinkRow[]> {
  return db
    .select()
    .from(nativeListingLinks)
    .where(
      and(eq(nativeListingLinks.listingId, listingId), eq(nativeListingLinks.status, 'active')),
    )
    .orderBy(asc(nativeListingLinks.createdAt), asc(nativeListingLinks.id));
}

/** The ACTIVE attachments of several native variants, in one round trip. */
export async function findActiveLinksForVariants(
  db: DatabaseOrTransaction,
  productVariantIds: readonly string[],
): Promise<NativeListingLinkRow[]> {
  if (productVariantIds.length === 0) return [];
  return db
    .select()
    .from(nativeListingLinks)
    .where(
      and(
        inArray(nativeListingLinks.productVariantId, [...productVariantIds]),
        eq(nativeListingLinks.status, 'active'),
      ),
    );
}

/**
 * Close an attachment because a NEW one takes its place.
 *
 * A one-statement CAS on `status = 'active'`, so a concurrent second attempt to
 * supersede the same link loses and writes nothing — which is what lets a
 * caller insert the replacement immediately afterwards without racing the
 * `native_listing_links_active_variant_key` unique against itself.
 */
export async function supersedeNativeListingLink(
  db: DatabaseOrTransaction,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(nativeListingLinks)
    .set({ status: 'superseded' })
    .where(and(eq(nativeListingLinks.id, id), eq(nativeListingLinks.status, 'active')))
    .returning({ id: nativeListingLinks.id });
  return rows.length === 1;
}

/**
 * Withdraw an attachment.
 *
 * Distinct from superseding: nothing replaces it, and the actor and reason are
 * NOT NULL by CHECK on a `revoked` row — an unattributable withdrawal of a
 * catalogue attachment is not one anybody can audit.
 */
export async function revokeNativeListingLink(
  db: DatabaseOrTransaction,
  input: { id: string; revokedByOxyUserId: string; reason: string; now?: Date },
): Promise<boolean> {
  const rows = await db
    .update(nativeListingLinks)
    .set({
      status: 'revoked',
      revokedAt: input.now ?? new Date(),
      revokedByOxyUserId: input.revokedByOxyUserId,
      revokeReason: input.reason,
    })
    .where(and(eq(nativeListingLinks.id, input.id), eq(nativeListingLinks.status, 'active')))
    .returning({ id: nativeListingLinks.id });
  return rows.length === 1;
}
