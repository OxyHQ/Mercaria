/**
 * The production {@link MatchCandidateSource}: the canonical catalogue, read
 * through the repositories that own it.
 *
 * Nothing here decides anything. It hydrates the shapes `pipeline.ts` scores and
 * it composes reads that already exist — `resolveIdentifier` for the identifier
 * stages, the trigram and alias lookups #56 built for candidate generation, the
 * `native_listing_links` reader #57 built for attachments. A second
 * normalization, a second identifier validator or a second alias lookup living
 * here would be a copy that drifts from the one the write path uses, and the two
 * disagreeing is how a matcher stops matching things it already attached.
 *
 * ## Retrieval is BOUNDED by the policy, twice
 *
 * `maxCandidates` bounds every query, and the trigram/token queries are ordered
 * so the bound cuts the weakest candidates rather than an arbitrary page. An
 * unbounded retrieval on a pathological title (a seller who pasted a
 * specification sheet) is a sequential scan of the canonical catalogue on a
 * queue worker, which is how one bad listing stops matching for everything else.
 */

import { and, desc, inArray, ne, sql } from 'drizzle-orm';
import { normalizeAliasLookup, normalizeEntityName } from '../canonical/normalization.js';
import {
  findCanonicalProductIdsByNormalizedAlias,
  findCanonicalProductsByIds,
  findCanonicalProductsByNormalizedName,
  listCanonicalProductAliasesForProducts,
  searchCanonicalProductsByNameSimilarity,
} from '../../db/canonical/canonicalProductRepository.js';
import {
  findBundleVariantIds,
  findCanonicalVariantsByIds,
  listVariantAttributesForVariants,
  listVariantsForProducts,
} from '../../db/canonical/canonicalVariantRepository.js';
import {
  findBrandsByIds,
  listBrandAliasesForBrands,
} from '../../db/canonical/brandRepository.js';
import { findCanonicalValuesForVariants } from '../../db/canonical/productIdentifierRepository.js';
import { resolveIdentifier } from '../canonical/product-identifier.service.js';
import { normalizeIdentifier } from '../canonical/identifiers.js';
import { findActiveLinkForVariant } from '../../db/offers/nativeListingLinkRepository.js';
import { listOpenBlocksForSubject } from '../../db/matching/matchBlockedPairRepository.js';
import { isCategoryGateOpen } from '../../db/matching/matchPolicyRepository.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { categories } from '../../db/schema/catalog.js';
import { IDENTIFIER_SCHEME_REGISTRY } from '@mercaria/shared-types';
import type {
  BlockedTargets,
  CandidateProduct,
  CandidateRetrievalQuery,
  CandidateVariant,
  ExistingAttachment,
  MatchCandidateSource,
  ResolvedSubjectIdentifier,
} from './candidate-source.js';
import { detectRelation } from './relation-detection.js';
import type { MatchSubject } from './subject.js';

/**
 * The catalogue statuses a candidate may hold.
 *
 * A `merged` row is a tombstone and a `suppressed` one was withdrawn; attaching
 * to either would point an offer at a row the catalogue has retired. `draft` IS
 * eligible — an unreviewed provisional product is exactly the thing a source
 * observation should attach to rather than duplicate.
 */
const MATCHABLE_STATUSES = ['draft', 'active', 'discontinued'] as const;

export class PostgresCandidateSource implements MatchCandidateSource {
  private readonly db: DatabaseOrTransaction;

  constructor(db: DatabaseOrTransaction = getDb()) {
    this.db = db;
  }

  async findExistingAttachment(subject: MatchSubject): Promise<ExistingAttachment | null> {
    // Only the native side has an attachment to reuse. A source observation's
    // link lives on `canonical_*_source_links` and points at the OBSERVATION,
    // which is new on every content change — so reusing it would be reusing a
    // link to a row nobody is matching.
    if (subject.kind !== 'native_variant' || subject.productVariantId === undefined) return null;
    const link = await findActiveLinkForVariant(this.db, subject.productVariantId);
    if (!link) return null;
    const variants = await findCanonicalVariantsByIds(this.db, [link.canonicalVariantId]);
    const variant = variants[0];
    if (!variant) return null;
    return {
      canonicalVariantId: variant.id,
      canonicalProductId: variant.productId,
    };
  }

  async resolveSubjectIdentifiers(
    subject: MatchSubject,
  ): Promise<readonly ResolvedSubjectIdentifier[]> {
    const resolved: ResolvedSubjectIdentifier[] = [];
    for (const asserted of subject.identifiers) {
      const normalization = normalizeIdentifier(asserted.scheme, asserted.rawValue);
      const definition = IDENTIFIER_SCHEME_REGISTRY[asserted.scheme];
      if (normalization.kind === 'invalid') {
        // A mistyped GTIN is evidence somebody typed it wrong, never evidence
        // the product is something else. It is recorded as invalid and reaches
        // no stage — `readIdentifiers` drops it before any conflict is derived.
        resolved.push({
          label: `${asserted.scheme}:${asserted.rawValue}`,
          globallyUnique: definition.globallyUnique,
          requiresBrandScope: definition.requiresBrandScope,
          resolution: { kind: 'invalid', reason: normalization.reason },
        });
        continue;
      }
      const identifier = normalization.identifier;
      const label =
        identifier.canonicalScheme === undefined
          ? `${identifier.scheme}:${identifier.normalizedValue}`
          : `${identifier.canonicalScheme}:${identifier.canonicalValue ?? ''}`;
      resolved.push({
        label,
        globallyUnique: definition.globallyUnique,
        requiresBrandScope: identifier.requiresBrandScope,
        resolution: await resolveIdentifier(asserted.scheme, asserted.rawValue),
      });
    }
    return resolved;
  }

  async retrieveByNormalizedName(input: {
    normalizedName: string;
    limit: number;
  }): Promise<readonly string[]> {
    if (input.normalizedName.length === 0) return [];
    const byName = await findCanonicalProductsByNormalizedName(this.db, input.normalizedName);
    const byAlias = await findCanonicalProductIdsByNormalizedAlias(
      this.db,
      normalizeAliasLookup(input.normalizedName),
    );
    const ids = new Set<string>();
    for (const product of byName) {
      if ((MATCHABLE_STATUSES as readonly string[]).includes(product.status)) ids.add(product.id);
    }
    for (const id of byAlias) ids.add(id);
    return [...ids].slice(0, input.limit);
  }

  /**
   * Category-aware title retrieval (#58 stage 5).
   *
   * Two complementary reads, unioned and bounded:
   *
   * - **Trigram similarity** on `canonical_products.normalized_name`, which is
   *   what #56 built the `gin_trgm_ops` index for. It finds near-spellings and
   *   word-order differences a token query misses.
   * - **Discriminating-token containment** against `search_tokens`, which finds
   *   the product whose name shares a MODEL NUMBER with the subject even when
   *   the rest of the title is a seller's marketing prose — the case trigram
   *   similarity handles worst, because the prose dominates the string.
   *
   * A known category NARROWS the token half. It deliberately does NOT narrow
   * the trigram half: a candidate in the wrong category is scored, blocked with
   * `category_mismatch`, and stored as a rejected candidate an operator can see
   * — which is a better answer than being silently absent from the trace, and it
   * is also how a mis-categorised canonical product gets noticed at all. An
   * unknown category degrades to a wider search, never to no search.
   */
  async retrieveByTitle(query: CandidateRetrievalQuery): Promise<readonly string[]> {
    const ids = new Set<string>();

    const trigram = await searchCanonicalProductsByNameSimilarity(
      this.db,
      normalizeEntityName(query.normalizedTitle),
      query.limit,
    );
    for (const row of trigram) {
      if (!(MATCHABLE_STATUSES as readonly string[]).includes(row.product.status)) continue;
      ids.add(row.product.id);
    }

    if (query.discriminatingTokens.length > 0 && ids.size < query.limit) {
      const tokens = [...query.discriminatingTokens];
      const categoryPredicate =
        query.categoryKey === null
          ? undefined
          : sql`${canonicalProducts.categoryId} in (
              select ${categories.id} from ${categories} where ${categories.slug} = ${query.categoryKey}
            )`;
      const rows = await this.db
        .select({ id: canonicalProducts.id })
        .from(canonicalProducts)
        .where(
          and(
            /**
             * `sql.param` and an explicit cast, never a bare array.
             *
             * A bare JS array interpolated into a `sql` template is bound as ONE
             * scalar, and Postgres then parses its first element as an array
             * literal — `malformed array literal: "<first token>"`, at RUNTIME,
             * on a branch `tsc` cannot see (`~/Oxy/AGENTS.md` §Drizzle `sql`
             * templates). `sql.param` binds the whole array as one parameter,
             * and the cast gives it the wire type `&&` needs.
             *
             * This branch is only reached when a subject has discriminating
             * tokens AND the trigram half returned fewer candidates than the
             * limit, which is why the in-memory benchmark never exercised it —
             * that source shares the pipeline's scoring and simplifies exactly
             * this retrieval. Found by `backfill.realdb.test.ts`.
             */
            sql`${canonicalProducts.searchTokens} && ${sql.param(tokens)}::text[]`,
            ne(canonicalProducts.status, 'merged'),
            ne(canonicalProducts.status, 'suppressed'),
            ...(categoryPredicate === undefined ? [] : [categoryPredicate]),
          ),
        )
        .orderBy(desc(canonicalProducts.createdAt))
        .limit(query.limit);
      for (const row of rows) ids.add(row.id);
    }

    return [...ids].slice(0, query.limit);
  }

  async loadProducts(productIds: readonly string[]): Promise<readonly CandidateProduct[]> {
    if (productIds.length === 0) return [];
    const products = await findCanonicalProductsByIds(this.db, productIds);
    const live = products.filter((product) =>
      (MATCHABLE_STATUSES as readonly string[]).includes(product.status),
    );
    if (live.length === 0) return [];

    const ids = live.map((product) => product.id);
    const aliasRows = await listCanonicalProductAliasesForProducts(this.db, ids);
    const aliasesByProduct = new Map<string, string[]>();
    for (const alias of aliasRows) {
      const list = aliasesByProduct.get(alias.productId) ?? [];
      list.push(normalizeEntityName(alias.alias));
      aliasesByProduct.set(alias.productId, list);
    }

    const brandIds = [
      ...new Set(
        live.flatMap((product) => (product.brandId === null ? [] : [product.brandId])),
      ),
    ];
    const brandRows = await findBrandsByIds(this.db, brandIds);
    const brandAliasRows = await listBrandAliasesForBrands(this.db, brandIds);
    const brandNames = new Map<string, string[]>();
    for (const brand of brandRows) {
      brandNames.set(brand.id, [normalizeEntityName(brand.name)]);
    }
    for (const alias of brandAliasRows) {
      const list = brandNames.get(alias.brandId) ?? [];
      list.push(normalizeEntityName(alias.alias));
      brandNames.set(alias.brandId, list);
    }

    const categoryIds = [
      ...new Set(
        live.flatMap((product) => (product.categoryId === null ? [] : [product.categoryId])),
      ),
    ];
    const categoryRows =
      categoryIds.length === 0
        ? []
        : await this.db
            .select({ id: categories.id, slug: categories.slug })
            .from(categories)
            .where(inArray(categories.id, categoryIds));
    const categorySlugs = new Map(categoryRows.map((row) => [row.id, row.slug]));

    return live.map((product) => ({
      productId: product.id,
      name: product.name,
      normalizedName: product.normalizedName,
      aliases: aliasesByProduct.get(product.id) ?? [],
      brandId: product.brandId,
      brandNames: product.brandId === null ? [] : (brandNames.get(product.brandId) ?? []),
      categoryKey: product.categoryId === null ? null : (categorySlugs.get(product.categoryId) ?? null),
      modelCode: product.modelCode,
      variantDefiningAttributeKeys: product.variantDefiningAttributeKeys,
      // The canonical NAME classified by the same detector the subject uses, so
      // an "iPhone 15 case" product and an "iPhone 15 case" listing agree, and
      // neither matches the phone.
      relation: detectRelation({ title: product.name }).relation,
    }));
  }

  async loadVariants(productIds: readonly string[]): Promise<readonly CandidateVariant[]> {
    if (productIds.length === 0) return [];
    const variants = await listVariantsForProducts(this.db, productIds);
    return this.hydrateVariants(variants);
  }

  async loadVariantsByIds(variantIds: readonly string[]): Promise<readonly CandidateVariant[]> {
    if (variantIds.length === 0) return [];
    const variants = await findCanonicalVariantsByIds(this.db, variantIds);
    return this.hydrateVariants(variants);
  }

  private async hydrateVariants(
    variants: readonly (typeof canonicalVariants.$inferSelect)[],
  ): Promise<CandidateVariant[]> {
    const live = variants.filter((variant) =>
      (MATCHABLE_STATUSES as readonly string[]).includes(variant.status),
    );
    if (live.length === 0) return [];
    const ids = live.map((variant) => variant.id);

    const attributeRows = await listVariantAttributesForVariants(this.db, ids);
    const attributes = new Map<string, Map<string, string>>();
    for (const row of attributeRows) {
      const map = attributes.get(row.variantId) ?? new Map<string, string>();
      map.set(row.attributeKey, row.normalizedValue);
      attributes.set(row.variantId, map);
    }

    const gtinRows = await findCanonicalValuesForVariants(this.db, ids);
    const gtins = new Map<string, string[]>();
    for (const row of gtinRows) {
      const list = gtins.get(row.variantId) ?? [];
      list.push(row.canonicalValue);
      gtins.set(row.variantId, list);
    }

    const bundleIds = new Set(await findBundleVariantIds(this.db, ids));

    return live.map((variant) => ({
      variantId: variant.id,
      productId: variant.productId,
      name: variant.name,
      signature: variant.signature,
      isDefault: variant.isDefault,
      attributes: attributes.get(variant.id) ?? new Map<string, string>(),
      gtins: gtins.get(variant.id) ?? [],
      hasBundleComponents: bundleIds.has(variant.id),
    }));
  }

  async findOpenBlocks(subjectKey: string): Promise<BlockedTargets> {
    const rows = await listOpenBlocksForSubject(this.db, subjectKey);
    const productIds = new Set<string>();
    const variantIds = new Set<string>();
    for (const row of rows) {
      if (row.targetCanonicalProductId !== null) productIds.add(row.targetCanonicalProductId);
      if (row.targetCanonicalVariantId !== null) variantIds.add(row.targetCanonicalVariantId);
    }
    return { productIds, variantIds };
  }

  async isCategoryAutomatic(input: {
    policyVersionId: string;
    categoryKey: string | null;
  }): Promise<boolean> {
    return isCategoryGateOpen(this.db, input);
  }
}
