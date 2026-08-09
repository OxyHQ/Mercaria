/**
 * Stage 4 — an unmatched STORE listing mints a DRAFT canonical product, one
 * canonical variant per native variant, and the attachments between them
 * (ADR 0002 D23 phase 1, clauses 4–5; #60 acceptance 1 and 3).
 *
 * This is the stage #58 deliberately stopped short of. Its matcher records
 * `create_new` and goes no further, because "the matcher never mints a canonical
 * product" is a test that fails the build there — minting is a MIGRATION
 * decision about how much of a seller's catalogue deserves a canonical identity,
 * not a matching decision. This stage is where that decision is made and where
 * it is written down.
 *
 * ## The four rules that decide what happens to a listing
 *
 * 1. **A P2P listing is left alone.** `unmatched` / `p2p_left_unattached`, and
 *    that is a successful outcome, not a gap: D23 clause 7 and #60 acceptance 3
 *    both say an unmatched P2P listing keeps operating exactly as it does today,
 *    and minting a canonical product from one person's used-phone ad would put a
 *    guess at the top of a product page. #58's matcher and #59's review attach
 *    them over time, one at a time, with evidence.
 * 2. **A listing whose variants are all attached is `unchanged`.** The stage
 *    reads `native_listing_links`, so it converges whether the attachment came
 *    from the matcher, from an operator, or from a previous run of this stage.
 * 3. **A listing whose matcher verdict is `manual_review` goes to review**, not
 *    to a mint. Minting a new canonical product for a variant the matcher
 *    thought might be an existing one is the FALSE-MERGE failure inverted: a
 *    duplicate product page, which is discovered by a customer comparing two
 *    listings of one phone that do not appear on the same page.
 * 4. **A listing with no matcher verdict yet WAITS.** `skipped` /
 *    `awaiting_match_decision`, because D23 orders identifier matching before
 *    creation for a reason: minting first guarantees a duplicate for every
 *    listing whose barcode would have resolved. If the counter stays high, the
 *    matcher's dispatcher is not draining — which is a visible operational fact
 *    rather than a silent one.
 *
 * ## Idempotency is read off this domain's OWN ledger
 *
 * A mint is several statements across three services, each opening its own
 * transaction, so a crash can leave a product with only some of its variants. A
 * naive re-run would then fail on the product's slug and never converge.
 *
 * The report row is the fix: a previous record for this listing under this
 * mapping version and mode carries the canonical product it minted, so a re-run
 * REUSES it and converges the rest. That is the issue's "idempotent by listing,
 * variant and mapping version" holding literally — the mapping version is in the
 * key, so bumping it deliberately mints afresh instead of silently reusing a
 * product built under different rules.
 *
 * ## What the attachment claims
 *
 * `method: 'backfill'`, `confidence: null`, `match_rule` carrying the mapping
 * version. The attachment is certain by construction because this stage created
 * BOTH ends of it — see `NativeListingLinkMethod`'s own doc comment for why that
 * is its own member rather than `connector_declared`.
 */

import { and, asc, eq, gt, type SQL } from 'drizzle-orm';
import type { IdentifierScheme } from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import { listings, listingOptions, productVariants } from '../../../db/schema/catalog.js';
import { findVariantOptionValues } from '../../../db/catalog/variantRepository.js';
import { findActiveLinksForListing } from '../../../db/offers/nativeListingLinkRepository.js';
import { findLatestDecisionForVariant } from '../../../db/matching/matchDecisionRepository.js';
import { findCanonicalProductById } from '../../../db/canonical/canonicalProductRepository.js';
import { findBackfillRecord } from '../../../db/backfill/backfillRecordRepository.js';
import { normalizeIdentifier } from '../../canonical/identifiers.js';
import { cohortListingPredicate } from '../cohort.js';
import { isDryRunId } from '../graph-writer.js';
import { backfillSubjectKey, CATALOG_BACKFILL_RULE_ID } from '../mapping-version.js';
import {
  examineAll,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';

/** The listing facts this stage decides on. */
interface ListingRow {
  readonly id: string;
  readonly ownerType: string;
  readonly title: string;
  readonly categoryId: string | null;
}

/**
 * The identifier schemes a native `barcode` may carry.
 *
 * GTIN family only, and in this order: `normalizeIdentifier` validates the check
 * digit, so the first scheme that ACCEPTS the string is the one the seller
 * actually typed. ISBNs are in the family (an ISBN-13 is an EAN) and are covered
 * by `ean`/`isbn13` normalizing to the same canonical GTIN-14.
 *
 * MPN and `brand_model` are deliberately absent: both are brand-scoped, this
 * stage mints products with NO brand (a vendor string is a candidate, never a
 * brand), and an unscoped part number identifies nothing — `assignIdentifier`
 * refuses one outright.
 */
const BARCODE_SCHEMES: readonly IdentifierScheme[] = ['ean', 'upc', 'gtin14', 'gtin8', 'isbn13'];

export async function runProvisionalProductsPage(
  context: StageContext,
): Promise<StagePageResult> {
  const db = getDb();
  const cohort = cohortListingPredicate(context.cohort);
  const keyset: SQL | undefined =
    context.cursor === null ? undefined : gt(listings.id, context.cursor);
  const predicate =
    cohort === undefined ? keyset : keyset === undefined ? cohort : and(cohort, keyset);

  const rows: ListingRow[] = await db
    .select({
      id: listings.id,
      ownerType: listings.ownerType,
      title: listings.title,
      categoryId: listings.categoryId,
    })
    .from(listings)
    .where(predicate)
    .orderBy(asc(listings.id))
    .limit(context.limit);

  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'listing', listingId: row.id }),
    (row) => decideListing(context, row),
  );

  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}

async function decideListing(
  context: StageContext,
  listing: ListingRow,
): Promise<SubjectVerdict> {
  if (listing.ownerType !== 'store') {
    // Rule 1. A successful outcome, and the normal one for the P2P half of the
    // marketplace.
    return { reasonCode: 'p2p_left_unattached', detail: `owner type ${listing.ownerType}` };
  }

  const db = getDb();
  const variants = await db
    .select({ id: productVariants.id, title: productVariants.title, barcode: productVariants.barcode })
    .from(productVariants)
    .where(eq(productVariants.listingId, listing.id))
    .orderBy(asc(productVariants.position), asc(productVariants.id));

  if (variants.length === 0) {
    return { reasonCode: 'awaiting_match_decision', detail: 'listing has no variants' };
  }

  const links = await findActiveLinksForListing(db, listing.id);
  const attached = new Map(links.map((link) => [link.productVariantId, link.canonicalVariantId]));
  const unattached = variants.filter((variant) => !attached.has(variant.id));

  if (unattached.length === 0) {
    /**
     * Rule 2 — whether the matcher, an operator or a previous run attached them.
     *
     * The canonical ids are deliberately left off the record. A listing's
     * variants may legitimately attach to variants of DIFFERENT canonical
     * products (a store selling a phone and its case under one listing is
     * unusual but representable), so there is no single pair to record, and
     * `catalog_backfill_records_canonical_shape_check` refuses a variant without
     * its product for exactly the reason a half-answer here would be worse than
     * none: a reviewer would read the first link as the whole story.
     */
    return {
      reasonCode: 'attachment_exists',
      detail: `${String(links.length)} active attachment(s)`,
    };
  }

  // Rules 3 and 4, in the order the ADR puts them: the matcher's verdict decides
  // whether minting is permitted at all.
  for (const variant of unattached) {
    const decision = await findLatestDecisionForVariant(db, variant.id);
    if (decision === undefined) {
      return {
        reasonCode: 'awaiting_match_decision',
        detail: `variant ${variant.id} has no match decision yet`,
      };
    }
    if (decision.outcome === 'manual_review') {
      return {
        reasonCode: 'blocked_by_decision',
        detail: `variant ${variant.id}: ${decision.outcome}; blockers ${decision.blockers.join(', ')}`,
      };
    }
    if (decision.outcome === 'automatic_match') {
      // The matcher decided this belongs to an existing canonical variant and
      // its own transaction writes the attachment. Seeing one here means the
      // decision landed between the link read above and now, or that the
      // attachment was revoked afterwards; either way minting a NEW product for
      // it would be the duplicate rule 3 exists to prevent.
      return {
        reasonCode: 'awaiting_match_decision',
        detail: `variant ${variant.id} has an automatic match awaiting attachment`,
      };
    }
  }

  return mintProvisionalProduct(context, listing, variants, attached);
}

/** Every option AXIS the listing declares, normalized to keys. */
async function optionAxesFor(listingId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ name: listingOptions.name })
    .from(listingOptions)
    .where(eq(listingOptions.listingId, listingId))
    .orderBy(asc(listingOptions.position));
  return rows.map((row) => row.name);
}

/**
 * The canonical product a previous run of this stage minted for this listing, if
 * it still exists.
 *
 * Reads the report row, and then CHECKS the product is still there: a record
 * naming a product an operator has since merged or suppressed must not send the
 * stage attaching to a row that has moved on. A missing product means minting
 * again, which converges because the slug is derived from the listing title and
 * the previous product would still hold it — so the mint fails loudly and lands
 * in the run's `failed` count rather than silently producing a second one.
 */
async function previousProductFor(
  context: StageContext,
  listingId: string,
): Promise<string | undefined> {
  const record = await findBackfillRecord({
    mappingVersion: context.mappingVersion,
    mode: context.mode,
    stage: context.stage,
    subjectKey: backfillSubjectKey({ kind: 'listing', listingId }),
  });
  const productId = record?.canonicalProductId ?? undefined;
  if (productId === undefined) return undefined;
  const product = await findCanonicalProductById(getDb(), productId);
  return product === undefined ? undefined : product.id;
}

async function mintProvisionalProduct(
  context: StageContext,
  listing: ListingRow,
  variants: readonly { id: string; title: string; barcode: string | null }[],
  attached: ReadonlyMap<string, string>,
): Promise<SubjectVerdict> {
  const reused = await previousProductFor(context, listing.id);
  const product =
    reused === undefined
      ? await context.writer.createDraftProduct({
          // The listing TITLE, verbatim. It is a seller's words and this product
          // is `draft` precisely because of that — #56's rule that a source
          // title never becomes a canonical name applies to IMPORTS onto an
          // existing product, and this is a mint whose entire content is one
          // seller's listing, which is what `draft` records.
          name: listing.title,
          categoryId: listing.categoryId,
          variantDefiningAttributeKeys: await optionAxesFor(listing.id),
          actorOxyUserId: context.actorOxyUserId,
        })
      : { id: reused, persisted: false };

  let attachedCount = 0;
  let disputedIdentifiers = 0;
  let firstCanonicalVariantId: string | undefined;

  // ONE query for every variant's options rather than one per variant: this
  // stage's page is bounded by listings, and a listing with a hundred variants
  // would otherwise be a hundred round trips inside one record's examination.
  const optionsByVariant = await findVariantOptionValues(variants.map((variant) => variant.id));

  for (const variant of variants) {
    if (attached.has(variant.id)) continue;

    const options = optionsByVariant.get(variant.id) ?? [];
    const canonicalVariant = await context.writer.createProductVariant({
      productId: product.id,
      name: variant.title,
      options: options.map((option, index) => ({
        key: option.name,
        value: option.value,
        position: option.position === 0 ? index : option.position,
      })),
      actorOxyUserId: context.actorOxyUserId,
    });
    firstCanonicalVariantId ??= canonicalVariant.id;

    if (variant.barcode !== null && variant.barcode.trim() !== '') {
      const outcome = await assignBarcode(context, canonicalVariant.id, variant.barcode);
      if (outcome === 'disputed') disputedIdentifiers += 1;
    }

    await context.writer.attachNativeVariant({
      productVariantId: variant.id,
      listingId: listing.id,
      canonicalVariantId: canonicalVariant.id,
      method: 'backfill',
      matchRule: `${CATALOG_BACKFILL_RULE_ID}:provisional_mint`,
    });
    attachedCount += 1;
  }

  // The listing's native offers are owed a convergence now that its variants
  // have canonical identities. Requested here rather than left to the
  // `native_offers` stage so a cohort run of THIS stage alone still produces
  // offers — the two stages overlap deliberately, and the queue coalesces.
  await context.writer.requestOfferConvergence(listing.id);

  const canonicalIds =
    product.persisted || reused !== undefined
      ? {
          canonicalProductId: isDryRunId(product.id) ? undefined : product.id,
          canonicalVariantId:
            firstCanonicalVariantId !== undefined && !isDryRunId(firstCanonicalVariantId)
              ? firstCanonicalVariantId
              : undefined,
        }
      : {};

  if (disputedIdentifiers > 0) {
    /**
     * A barcode this listing carries is actively owned by a DIFFERENT canonical
     * variant. `assignIdentifier` has already stored the assertion `disputed`
     * and moved nothing — the newcomer never steals an identifier (ADR 0002
     * D14) — so the product exists, the variants are attached, and the dispute
     * is #59's to settle. Reporting it as `review_required` rather than as a
     * successful mint is what puts it in front of somebody.
     */
    return {
      reasonCode: 'identifier_disputed',
      detail: `${String(disputedIdentifiers)} disputed identifier(s); product ${product.id}, ${String(attachedCount)} variant(s) attached`,
      ...canonicalIds,
    };
  }

  return {
    reasonCode: 'provisional_product_minted',
    detail: `product ${product.id}; ${String(attachedCount)} variant(s) attached${reused === undefined ? '' : ' (reused from a previous run)'}`,
    ...canonicalIds,
  };
}

/**
 * Assign the native `barcode` as a canonical identifier, if it is one.
 *
 * The scheme is DISCOVERED by validation rather than declared: a native variant
 * has one `barcode` column and no field saying which scheme it is, so the first
 * GTIN-family scheme whose check digit accepts the string is what the seller
 * typed. A string no scheme accepts is silently not an identifier — a mistyped
 * barcode is evidence somebody typed it wrong, never evidence about the product,
 * and inventing a correction is the invention this whole graph refuses.
 */
async function assignBarcode(
  context: StageContext,
  canonicalVariantId: string,
  barcode: string,
): Promise<'assigned' | 'unchanged' | 'disputed' | 'invalid' | 'not_written'> {
  const trimmed = barcode.trim();
  const scheme = BARCODE_SCHEMES.find(
    (candidate) => normalizeIdentifier(candidate, trimmed).kind !== 'invalid',
  );
  if (scheme === undefined) return 'invalid';

  const result = await context.writer.assignVariantIdentifier({
    variantId: canonicalVariantId,
    scheme,
    rawValue: trimmed,
  });
  return result.outcome;
}
