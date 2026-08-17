/**
 * The ONE seam through which a backfill stage may change anything outside its
 * own report tables (#60 job behaviour 3).
 *
 * ## Why this exists rather than an `if (mode === 'dry_run')` in every stage
 *
 * "A dry run writes nothing" is a property of every code path in the domain, and
 * a property of every code path is exactly what a conditional cannot give you:
 * one stage that forgets the check makes the claim false everywhere, silently,
 * and the symptom is a canonical product minted during what an operator believed
 * was a rehearsal.
 *
 * So the stages do not have the repositories. They have a
 * {@link CanonicalGraphWriter}, and there are two implementations:
 * {@link applyGraphWriter} calls the real services, {@link dryRunGraphWriter}
 * returns the same shapes having called nothing. The choice is made ONCE, in
 * {@link createGraphWriter}, and a stage physically cannot reach past it —
 * `backfill-isolation.test.ts` fails the build if a stage module imports a
 * canonical, merchant, matching or offer WRITE module directly.
 *
 * This is the `cartOwnerForActor` and `addressBookOwnerForActor` device applied
 * to a whole domain: make the wrong thing unreachable rather than forbidden.
 *
 * ## What a dry-run writer returns, and why it is not `null`
 *
 * Every operation answers with what it WOULD have produced, using a synthetic id
 * prefixed `dry-run:`. A stage therefore takes the same branch it would take for
 * real — which is the whole point of a rehearsal — while nothing downstream can
 * mistake the value for a row: the id is not a uuid, so a foreign key would
 * refuse it, and the report row's `canonical_product_id` columns are left NULL
 * for dry-run mints because the writer reports `persisted: false`.
 *
 * ## The one thing the APPLY writer also refuses
 *
 * `CANONICAL_WRITE_PUBLICATION_ENABLED` off downgrades an apply run to the
 * dry-run writer, at this one place. That is #60 feature flag 1 — canonical-write
 * publication — and it is a lever over the WRITES rather than over the loop, so
 * a run started while it is off still produces a complete report and simply
 * changes nothing.
 */

import type { NativeListingLinkMethod, CatalogBackfillMode } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { insertNativeListingLink } from '../../db/offers/nativeListingLinkRepository.js';
import { createMerchant } from '../commerce-graph/merchant.service.js';
import { linkNativeStore } from '../commerce-graph/native-store-link.service.js';
import { createCanonicalProduct } from '../canonical/canonical-product.service.js';
import { createVariant } from '../canonical/canonical-variant.service.js';
import { assignIdentifier } from '../canonical/product-identifier.service.js';
import { requestNativeOfferSync } from '../offers/native-offer.service.js';
import { requestNativeVariantMatch } from '../matching/match.service.js';
import type { IdentifierScheme, NativeStoreLinkMethod } from '@mercaria/shared-types';

/** The result shape every write operation shares. */
export interface GraphWriteResult {
  /** The row's id, or a `dry-run:` sentinel when nothing was written. */
  readonly id: string;
  /** `false` for every dry-run operation, and for a converged no-op. */
  readonly persisted: boolean;
}

/**
 * What asserting an identifier did, as the backfill needs to distinguish it.
 *
 * The identifier service's four outcomes, plus `not_written` for the dry-run
 * writer — kept SEPARATE from `assigned` so a rehearsal's report cannot be read
 * as evidence that a GTIN was successfully claimed.
 */
export type IdentifierAssignmentOutcome =
  | 'assigned'
  | 'unchanged'
  | 'disputed'
  | 'invalid'
  | 'not_written';

/** A dry-run id, recognisable at a glance and refused by any foreign key. */
export function dryRunId(what: string): string {
  return `dry-run:${what}`;
}

/** Is this id a dry-run sentinel rather than a real row? */
export function isDryRunId(id: string): boolean {
  return id.startsWith('dry-run:');
}

/**
 * Everything a backfill stage is permitted to change outside its own tables.
 *
 * Deliberately narrow, and deliberately without a general escape hatch: there is
 * no `runInTransaction`, no `db` handle and no "apply this arbitrary write". A
 * stage that needs a new capability adds a NAMED method here, which is a
 * reviewable decision about what the migration may do.
 */
export interface CanonicalGraphWriter {
  readonly mode: CatalogBackfillMode;
  /** `false` when this writer changes nothing, whatever the run's mode says. */
  readonly writes: boolean;

  /** Mint a canonical merchant for a native store. */
  createMerchantForStore(input: {
    name: string;
    storeHandle: string;
    actorOxyUserId: string;
  }): Promise<GraphWriteResult>;

  /** Join a merchant to a native store with a verified, attributable link. */
  linkMerchantToStore(input: {
    merchantId: string;
    storeId: string;
    method: NativeStoreLinkMethod;
    note: string;
    actorOxyUserId: string;
    reason: string;
  }): Promise<GraphWriteResult>;

  /** Mint a DRAFT canonical product. Never `active` — see the stage. */
  createDraftProduct(input: {
    name: string;
    categoryId: string | null;
    variantDefiningAttributeKeys: readonly string[];
    actorOxyUserId: string;
  }): Promise<GraphWriteResult>;

  /** Mint (or converge on) one canonical variant of that product. */
  createProductVariant(input: {
    productId: string;
    name: string | null;
    options: readonly { key: string; value: string; position?: number }[];
    actorOxyUserId: string;
  }): Promise<GraphWriteResult>;

  /**
   * Assert an identifier on a canonical variant.
   *
   * The result carries the identifier service's own OUTCOME, because the
   * difference between `assigned` and `disputed` is the difference between a
   * backfilled barcode and a collision that must reach #59 — and a boolean
   * `persisted` cannot say which.
   */
  assignVariantIdentifier(input: {
    variantId: string;
    scheme: IdentifierScheme;
    rawValue: string;
    sourceRecordId?: string;
  }): Promise<GraphWriteResult & { readonly outcome: IdentifierAssignmentOutcome }>;

  /** Attach a native variant to a canonical variant (#57's own repository). */
  attachNativeVariant(input: {
    productVariantId: string;
    listingId: string;
    canonicalVariantId: string;
    method: NativeListingLinkMethod;
    matchRule: string;
  }): Promise<GraphWriteResult>;

  /** Ask #58's matcher for a verdict on one native variant. */
  requestVariantMatch(productVariantId: string): Promise<GraphWriteResult>;

  /** Ask #57's converger to materialize one listing's native offers. */
  requestOfferConvergence(listingId: string): Promise<GraphWriteResult>;
}

/** The writer that changes nothing. Every method reports what it would do. */
export const dryRunGraphWriter: CanonicalGraphWriter = {
  mode: 'dry_run',
  writes: false,
  createMerchantForStore: (input) =>
    Promise.resolve({ id: dryRunId(`merchant:${input.storeHandle}`), persisted: false }),
  linkMerchantToStore: (input) =>
    Promise.resolve({ id: dryRunId(`native-store-link:${input.storeId}`), persisted: false }),
  createDraftProduct: (input) =>
    Promise.resolve({ id: dryRunId(`canonical-product:${input.name}`), persisted: false }),
  createProductVariant: (input) =>
    Promise.resolve({
      id: dryRunId(`canonical-variant:${input.productId}:${input.name ?? 'default'}`),
      persisted: false,
    }),
  assignVariantIdentifier: (input) =>
    Promise.resolve({
      id: dryRunId(`identifier:${input.scheme}:${input.rawValue}`),
      persisted: false,
      outcome: 'not_written',
    }),
  attachNativeVariant: (input) =>
    Promise.resolve({
      id: dryRunId(`native-listing-link:${input.productVariantId}`),
      persisted: false,
    }),
  requestVariantMatch: (productVariantId) =>
    Promise.resolve({ id: dryRunId(`match:${productVariantId}`), persisted: false }),
  requestOfferConvergence: (listingId) =>
    Promise.resolve({ id: dryRunId(`offer-sync:${listingId}`), persisted: false }),
};

/**
 * The writer that actually changes the graph.
 *
 * Every method is a thin call into the domain that OWNS the write — this file
 * creates no row itself and holds no SQL. That is what keeps ADR 0002 D25(a)'s
 * ownership intact while giving the backfill one reviewable surface: the
 * merchant service still decides what a merchant is, #57's repository still
 * decides what an attachment is, and the migration decides only when to ask.
 */
export function applyGraphWriter(tx?: DatabaseOrTransaction): CanonicalGraphWriter {
  return {
    mode: 'apply',
    writes: true,

    async createMerchantForStore(input) {
      const merchant = await createMerchant({
        name: input.name,
        merchantType: 'retailer',
        createdByOxyUserId: input.actorOxyUserId,
        aliases: [{ alias: input.storeHandle, kind: 'name_variant' }],
      });
      return { id: merchant.id, persisted: true };
    },

    async linkMerchantToStore(input) {
      const link = await linkNativeStore({
        merchantId: input.merchantId,
        storeId: input.storeId,
        method: input.method,
        note: input.note,
        actorOxyUserId: input.actorOxyUserId,
        reason: input.reason,
      });
      return { id: link.id, persisted: true };
    },

    async createDraftProduct(input) {
      const product = await createCanonicalProduct({
        name: input.name,
        // DRAFT, always. ADR 0002 D23 phase 1 calls these provisional: a guess
        // minted from one seller's listing title is not a live product page, and
        // `draft` is the status `CanonicalCatalogStatus` defines for exactly
        // this. Promotion to `active` is #59's review, never a migration's.
        status: 'draft',
        ...(input.categoryId === null ? {} : { categoryId: input.categoryId }),
        variantDefiningAttributeKeys: [...input.variantDefiningAttributeKeys],
        actorOxyUserId: input.actorOxyUserId,
      });
      return { id: product.id, persisted: true };
    },

    async createProductVariant(input) {
      const result = await createVariant({
        productId: input.productId,
        options: input.options.map((option) => ({
          key: option.key,
          value: option.value,
          ...(option.position === undefined ? {} : { position: option.position }),
        })),
        ...(input.name === null ? {} : { name: input.name }),
        status: 'draft',
        actorOxyUserId: input.actorOxyUserId,
      });
      return { id: result.variant.id, persisted: result.created };
    },

    async assignVariantIdentifier(input) {
      const assigned = await assignIdentifier({
        target: { kind: 'variant', id: input.variantId },
        scheme: input.scheme,
        rawValue: input.rawValue,
        ...(input.sourceRecordId === undefined ? {} : { sourceRecordId: input.sourceRecordId }),
      });
      if (assigned.outcome === 'invalid') {
        // A mistyped barcode is evidence somebody typed it wrong, never evidence
        // the product is something else (#58's rule, one domain over). Nothing is
        // stored and the stage reports it rather than guessing a correction.
        return { id: dryRunId(`identifier-invalid:${input.rawValue}`), persisted: false, outcome: 'invalid' };
      }
      return {
        id: assigned.identifier.id,
        persisted: assigned.outcome === 'assigned' || assigned.outcome === 'disputed',
        outcome: assigned.outcome,
      };
    },

    async attachNativeVariant(input) {
      const link = await insertNativeListingLink(tx ?? getDb(), {
        productVariantId: input.productVariantId,
        listingId: input.listingId,
        canonicalVariantId: input.canonicalVariantId,
        method: input.method,
        matchRule: input.matchRule,
        confidence: null,
        sourceRecordId: null,
      });
      return { id: link.id, persisted: true };
    },

    /**
     * `tx ?? getDb()`, like `attachNativeVariant` above, and the coalesce is
     * load-bearing rather than defensive: this writer's `tx` is OPTIONAL, so a
     * stage running outside a transaction has none to hand over.
     *
     * #584 made both handles required, which does NOT produce a compile error
     * here — the backend compiles `strict: false`, so without `strictNullChecks`
     * an `undefined` satisfies a required parameter silently. Passing the bare
     * `tx` therefore type-checked and then threw inside the enqueue, where both
     * wrappers swallow by design: the run reported success and materialized no
     * offers at all. Measured — `backfill.realdb.test.ts` acceptance 1 went from
     * two native offers to zero.
     *
     * So a caller holding an OPTIONAL handle states the fallback here, where the
     * optionality is known. That is the same decision the required parameter is
     * for; what it must not be is a default hidden in the callee.
     */
    async requestVariantMatch(productVariantId) {
      await requestNativeVariantMatch({ productVariantId, trigger: 'bulk_sweep' }, tx ?? getDb());
      return { id: productVariantId, persisted: true };
    },

    async requestOfferConvergence(listingId) {
      await requestNativeOfferSync(listingId, tx ?? getDb());
      return { id: listingId, persisted: true };
    },
  };
}

/**
 * The ONE place the writer is chosen.
 *
 * `apply` plus the publication lever ON is the only combination that returns a
 * writing writer; every other combination returns the dry-run one, including an
 * apply run started while the lever is off. The run still produces its complete
 * report, which is what makes the lever a rollback rather than an outage — and
 * the stage that ran cannot tell the difference, which is what makes the
 * guarantee hold for stages nobody has written yet.
 */
export function createGraphWriter(
  mode: CatalogBackfillMode,
  tx?: DatabaseOrTransaction,
): CanonicalGraphWriter {
  if (mode !== 'apply') return dryRunGraphWriter;
  if (!config.canonicalRollout.writePublicationEnabled) return dryRunGraphWriter;
  return applyGraphWriter(tx);
}
