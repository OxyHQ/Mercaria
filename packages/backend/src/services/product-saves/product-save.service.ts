/**
 * Canonical product saves — the buyer's own surface (#80).
 *
 * ## Idempotence is structural, and that is the whole of acceptance 5
 *
 * "Save toggles are idempotent under repeated taps and network retries." Every
 * write here is a single statement whose outcome does not depend on a prior
 * read: the insert is `ON CONFLICT DO NOTHING` on `(oxy_user_id,
 * canonical_product_id)`, the delete reports whether a row went, and the counter
 * is DERIVED rather than adjusted. A read-then-write would satisfy the words and
 * fail the two cases that actually happen — a double tap and a retry after a
 * timeout the client never saw the response of — which is exactly the drift the
 * favorites counter was ported to Postgres to close.
 *
 * ## The counter is rebuilt, never moved
 *
 * `rebuildProductSaveAggregate` runs a `count(*)` and stores it, in the same
 * transaction as the save. Two concurrent saves therefore serialise on the
 * aggregate row and both counts are right, where a `+1` would need the insert's
 * own outcome to be correct AND the increment to reach the row. #76's
 * `review_aggregates` made the same choice for the same reason.
 *
 * ## A save is never created on a tombstone
 *
 * The product is resolved through `merged_into_id` FIRST (ADR 0002 D16's one
 * hop), so a client holding a pre-merge id saves the surviving product rather
 * than a dead one — and a merged product can never accumulate saves that the
 * saved-items read would then have to hide.
 */

import { eq } from 'drizzle-orm';
import type {
  ConditionGroup,
  ProductSave,
  ProductSaveSourceContext,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants } from '../../db/schema/merchants.js';
import {
  clearProductSaveAmbiguity,
  countAmbiguousProductSaves,
  deleteProductSave,
  deleteProductSavesForOxyUser,
  findProductSave,
  insertProductSave,
  updateProductSavePreferences,
  type ProductSaveRow,
} from '../../db/productSaves/productSaveRepository.js';
import { rebuildProductSaveAggregate } from '../../db/productSaves/productSaveAggregateRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { readBestOfferForProduct } from './best-offer.js';

/** What a buyer supplies when saving a product. */
export interface SaveProductInput {
  readonly oxyUserId: string;
  readonly canonicalProductId: string;
  readonly sourceContext: ProductSaveSourceContext;
  readonly preferredCanonicalVariantId?: string | null;
  readonly preferredConditionGroup?: ConditionGroup | null;
  readonly preferredMerchantId?: string | null;
}

/**
 * Resolve a canonical product id through at most one merge hop, and refuse a
 * product that does not exist.
 *
 * ONE hop is exact rather than optimistic: ADR 0002 D16 flattens redirect
 * chains at merge time, so a tombstone always points at a LIVE entity. A loop
 * would be defending against a state the merge phase makes unrepresentable, and
 * silently following two hops would hide it if that ever stopped being true.
 */
async function resolveLiveCanonicalProductId(
  canonicalProductId: string,
  db: DatabaseOrTransaction,
): Promise<string> {
  const rows = await db
    .select({ id: canonicalProducts.id, mergedIntoId: canonicalProducts.mergedIntoId })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, canonicalProductId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('That product does not exist.');
  if (!row.mergedIntoId) return row.id;

  const target = await db
    .select({ id: canonicalProducts.id, mergedIntoId: canonicalProducts.mergedIntoId })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, row.mergedIntoId))
    .limit(1);
  const resolved = target[0];
  if (!resolved || resolved.mergedIntoId) {
    // A tombstone pointing at another tombstone means the flattening the merge
    // performs did not happen. Refusing is the honest answer — saving onto
    // either row would attach a person's interest to an identity the graph
    // itself cannot resolve.
    throw conflict(
      'That product is being reorganised and cannot be saved right now. Please try again shortly.',
    );
  }
  return resolved.id;
}

/**
 * Refuse a preference that does not belong to the product being saved.
 *
 * A variant of a DIFFERENT product would satisfy the foreign key and produce a
 * save whose "preferred configuration" can never match an offer — a silently
 * empty saved-product page rather than an error, which is the failure a
 * validation like this exists to convert into a refusal.
 */
async function assertPreferencesBelong(
  canonicalProductId: string,
  preferredCanonicalVariantId: string | null | undefined,
  preferredMerchantId: string | null | undefined,
  db: DatabaseOrTransaction,
): Promise<void> {
  if (preferredCanonicalVariantId) {
    const rows = await db
      .select({ productId: canonicalVariants.productId })
      .from(canonicalVariants)
      .where(eq(canonicalVariants.id, preferredCanonicalVariantId))
      .limit(1);
    const variant = rows[0];
    if (!variant) throw notFound('That configuration does not exist.');
    if (variant.productId !== canonicalProductId) {
      throw validationError(
        'That configuration belongs to a different product, so it could never match an offer of this one.',
      );
    }
  }
  if (preferredMerchantId) {
    const rows = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, preferredMerchantId))
      .limit(1);
    if (!rows[0]) throw notFound('That seller does not exist.');
  }
}

/**
 * Save a canonical product (#80 API rule 1), idempotently.
 *
 * The reference price is observed ONCE, when the row is created, and never on a
 * repeat: it is "what the best offer cost when you saved this", and re-observing
 * it on every tap would make "cheaper than when you saved it" answer about the
 * last tap instead. A product with no current offer is saved with no reference
 * price at all rather than with zero — the absence is the fact (#80 acceptance
 * 7's own case, one step earlier).
 */
export async function saveProduct(input: SaveProductInput): Promise<ProductSave> {
  const db = getDb();
  const canonicalProductId = await resolveLiveCanonicalProductId(input.canonicalProductId, db);
  await assertPreferencesBelong(
    canonicalProductId,
    input.preferredCanonicalVariantId,
    input.preferredMerchantId,
    db,
  );

  const existing = await findProductSave(input.oxyUserId, canonicalProductId, db);
  // Observed OUTSIDE the transaction and only when a row is genuinely about to
  // be created: it is a read of another domain's projection, and holding a write
  // transaction open across it would make every save wait on the offer read.
  const reference = existing ? undefined : await observeReferencePrice(canonicalProductId);

  const row = await db.transaction(async (tx) => {
    const { save } = await insertProductSave(
      {
        oxyUserId: input.oxyUserId,
        canonicalProductId,
        sourceContext: input.sourceContext,
        preferredCanonicalVariantId: input.preferredCanonicalVariantId ?? null,
        preferredConditionGroup: input.preferredConditionGroup ?? null,
        preferredMerchantId: input.preferredMerchantId ?? null,
        referencePriceAmount: reference?.amount ?? null,
        referencePriceCurrency: reference?.currency ?? null,
        referencePriceObservedAt: reference ? reference.observedAt : null,
      },
      tx,
    );
    await rebuildProductSaveAggregate(canonicalProductId, tx);
    return save;
  });

  return toProductSaveDTO(row);
}

/** The best offer's price right now, or nothing when there is no offer to read. */
async function observeReferencePrice(
  canonicalProductId: string,
): Promise<{ amount: number; currency: string; observedAt: Date } | undefined> {
  try {
    const best = await readBestOfferForProduct(canonicalProductId);
    if (best.state !== 'available' || !best.price) return undefined;
    return { amount: best.price.amount, currency: best.price.currency, observedAt: new Date() };
  } catch (err) {
    // A save must never fail because the comparison surface is unavailable. The
    // cost of the absence is one save that cannot report a price change, which
    // is exactly what `no_reference_price` says.
    log.general.warn(
      { err, canonicalProductId },
      '[ProductSaves] could not observe a reference price; the save is created without one',
    );
    return undefined;
  }
}

/** Un-save a product (#80 API rule 1), idempotently. */
export async function unsaveProduct(
  oxyUserId: string,
  canonicalProductId: string,
): Promise<{ saved: false }> {
  const db = getDb();
  await db.transaction(async (tx) => {
    if (await deleteProductSave(oxyUserId, canonicalProductId, tx)) {
      await rebuildProductSaveAggregate(canonicalProductId, tx);
    }
  });
  return { saved: false };
}

/** Change a save's preferred variant, condition segment or seller (#80 API rule 5). */
export async function updateSavePreferences(
  oxyUserId: string,
  canonicalProductId: string,
  preferences: {
    readonly preferredCanonicalVariantId?: string | null;
    readonly preferredConditionGroup?: ConditionGroup | null;
    readonly preferredMerchantId?: string | null;
  },
): Promise<ProductSave> {
  const db = getDb();
  await assertPreferencesBelong(
    canonicalProductId,
    preferences.preferredCanonicalVariantId,
    preferences.preferredMerchantId,
    db,
  );
  const updated = await updateProductSavePreferences(
    oxyUserId,
    canonicalProductId,
    preferences,
    db,
  );
  if (!updated) throw notFound('You have not saved that product.');
  return toProductSaveDTO(updated);
}

/** One save, for the buyer who owns it. */
export async function getProductSave(
  oxyUserId: string,
  canonicalProductId: string,
): Promise<ProductSave | undefined> {
  const row = await findProductSave(oxyUserId, canonicalProductId);
  return row ? toProductSaveDTO(row) : undefined;
}

/** How many of this buyer's saves are waiting on them to answer a split. */
export async function countSavesAwaitingResolution(oxyUserId: string): Promise<number> {
  return countAmbiguousProductSaves(oxyUserId);
}

/**
 * Erase every save belonging to one Oxy account (#80 privacy rule 5).
 *
 * "Remove or anonymize according to ecosystem policy" resolves to REMOVE here,
 * and that is a property of the schema rather than a choice made in this
 * function: a save row holds an Oxy account id, a product id and preferences,
 * and no name, handle, email, avatar or contact detail — so there is nothing to
 * anonymize and no second table to sweep. Listing favorites are NOT touched:
 * they belong to the same person and are erased by the same operator act, but
 * `favorites` is not this domain's table to delete from, and pretending
 * otherwise would put two erasure paths in two domains.
 *
 * The counters of every affected product are rebuilt afterwards, outside the
 * deleting transaction — an erasure that left every one of them overstated
 * would leak the SIZE of what was erased, which is the one thing a privacy
 * action must not do.
 */
export async function eraseProductSavesForOxyUser(
  oxyUserId: string,
): Promise<{ deleted: number; countersRebuilt: number }> {
  const db = getDb();
  const { deleted, canonicalProductIds } = await deleteProductSavesForOxyUser(oxyUserId, db);
  let countersRebuilt = 0;
  for (const canonicalProductId of canonicalProductIds) {
    await rebuildProductSaveAggregate(canonicalProductId, db);
    countersRebuilt += 1;
  }
  return { deleted, countersRebuilt };
}

/** Clear one save's split ambiguity without moving it. See `split-resolution`. */
export async function acknowledgeSplitWithoutMoving(saveId: string): Promise<boolean> {
  return clearProductSaveAmbiguity(saveId);
}

/**
 * Row → DTO.
 *
 * `resolution` is a discriminated union rather than two nullable fields, so a
 * client cannot render "ambiguous" without also having the job id that names
 * the two candidates — which is the difference between a prompt a buyer can
 * answer and a warning they cannot.
 *
 * `splitTargetByJobId` is the second candidate, batched by the caller. It is a
 * parameter rather than a lookup inside this function because a saved-list page
 * would otherwise issue one query per ambiguous row; absent, the ambiguity is
 * still reported with its source and job — an honest partial answer, never a
 * fabricated target.
 */
export function toProductSaveDTO(
  row: ProductSaveRow,
  splitTargetByJobId?: ReadonlyMap<string, string>,
): ProductSave {
  const splitTarget =
    row.ambiguousSplitJobId !== null
      ? splitTargetByJobId?.get(row.ambiguousSplitJobId)
      : undefined;
  return {
    id: row.id,
    canonicalProductId: row.canonicalProductId,
    ...(row.preferredCanonicalVariantId
      ? { preferredCanonicalVariantId: row.preferredCanonicalVariantId }
      : {}),
    ...(row.preferredConditionGroup
      ? { preferredConditionGroup: row.preferredConditionGroup }
      : {}),
    ...(row.preferredMerchantId ? { preferredMerchantId: row.preferredMerchantId } : {}),
    sourceContext: row.sourceContext,
    visibility: row.visibility,
    resolution:
      row.resolutionState === 'ambiguous_after_split' && row.ambiguousSplitJobId
        ? {
            state: 'ambiguous_after_split',
            splitJobId: row.ambiguousSplitJobId,
            sourceCanonicalProductId: row.canonicalProductId,
            ...(splitTarget ? { targetCanonicalProductId: splitTarget } : {}),
          }
        : { state: 'resolved' },
    ...(row.referencePriceAmount !== null &&
    row.referencePriceCurrency !== null &&
    row.referencePriceObservedAt !== null
      ? {
          referencePrice: {
            amount: row.referencePriceAmount,
            currency: row.referencePriceCurrency,
            observedAt: row.referencePriceObservedAt.toISOString(),
          },
        }
      : {}),
    ...(row.migrationVersion ? { migrationVersion: row.migrationVersion } : {}),
    savedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
