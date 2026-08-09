/**
 * The benchmark's {@link MatchCandidateSource}: the fixture catalogue, in memory.
 *
 * It exists so the labelled dataset measures the SAME `evaluateMatch` production
 * runs, at a speed that keeps the measurement in CI on every push. A benchmark
 * that needed a seeded Postgres would run in minutes, would be skipped locally,
 * and would become the kind of gate people disable — which is precisely how a
 * recorded precision threshold quietly stops being one.
 *
 * ## It reuses the REAL identifier validator
 *
 * `normalizeIdentifier` is imported, not reimplemented, so a case asserting a
 * mistyped GTIN is refused here for exactly the reason it is refused in
 * production. A hand-rolled lookup would make the benchmark measure the
 * benchmark's own validator, which is the most reassuring possible way to
 * measure nothing.
 *
 * ## What it deliberately simplifies, and why that is honest
 *
 * Retrieval here is a token-overlap scan of eleven products rather than the
 * trigram/`search_tokens` union `PostgresCandidateSource` issues. Retrieval
 * decides which candidates are SEEN; scoring and the policy decide what happens
 * to them, and those are shared byte for byte. So the measured precision is a
 * property of the rules — which is the number a category gate needs — while
 * recall against a real catalogue's index behaviour is measured separately, by
 * `matching-writes.realdb.test.ts` running the production source end to end.
 * Stating that split is part of reporting the number honestly.
 */

import { IDENTIFIER_SCHEME_REGISTRY, type IdentifierGrain } from '@mercaria/shared-types';
import { normalizeEntityName } from '../../canonical/normalization.js';
import { normalizeIdentifier } from '../../canonical/identifiers.js';
import type {
  BlockedTargets,
  CandidateProduct,
  CandidateRetrievalQuery,
  CandidateVariant,
  ExistingAttachment,
  IdentifierResolution,
  MatchCandidateSource,
  ResolvedSubjectIdentifier,
} from '../candidate-source.js';
import { detectRelation } from '../relation-detection.js';
import type { MatchSubject } from '../subject.js';
import { titleTokens } from '../text-similarity.js';
import type { FixtureProduct, FixtureVariant } from './dataset.js';

/** How the in-memory catalogue is assembled. */
export interface InMemoryCatalogue {
  readonly products: readonly FixtureProduct[];
  readonly variants: readonly FixtureVariant[];
  /** Variant id → the MPNs it owns. */
  readonly mpns: Readonly<Record<string, readonly string[]>>;
  /** Subject key → the targets an operator has rejected. */
  readonly blocks?: Readonly<Record<string, readonly string[]>>;
  /**
   * Whether a category may match AUTOMATICALLY.
   *
   * Defaults to TRUE for every category, and that default is load-bearing rather
   * than lazy: a benchmark exists to answer "what WOULD automatic matching do
   * here", which is the question a gate decision needs answered BEFORE the gate
   * is opened. Running it with the gate closed would measure the identifier
   * stages alone and report a precision that says nothing about the stages the
   * gate actually governs — and would make the gate unopenable by construction,
   * since opening it requires a benchmark that requires it open.
   */
  readonly categoryAutomatic?: (categoryKey: string | null) => boolean;
}

export class InMemoryCandidateSource implements MatchCandidateSource {
  private readonly products: Map<string, CandidateProduct>;
  private readonly variantsByProduct: Map<string, CandidateVariant[]>;
  private readonly variantsById: Map<string, CandidateVariant>;
  /** Canonical GTIN-14 → the variant that owns it. One owner, as the index enforces. */
  private readonly gtinOwners: Map<string, string>;
  /** Normalized MPN → every variant asserting it. Collisions are LEGITIMATE. */
  private readonly mpnOwners: Map<string, string[]>;
  private readonly productTokens: Map<string, string[]>;
  private readonly blocks: Readonly<Record<string, readonly string[]>>;
  private readonly categoryAutomatic: (categoryKey: string | null) => boolean;

  constructor(catalogue: InMemoryCatalogue) {
    this.products = new Map(
      catalogue.products.map((product) => [
        product.productId,
        {
          productId: product.productId,
          name: product.name,
          normalizedName: normalizeEntityName(product.name),
          aliases: (product.aliases ?? []).map(normalizeEntityName),
          brandId: product.brandNames.length > 0 ? `brand-${product.productId}` : null,
          brandNames: product.brandNames.map(normalizeEntityName),
          categoryKey: product.categoryKey,
          modelCode: product.modelCode,
          variantDefiningAttributeKeys: product.axes,
          relation: detectRelation({ title: product.name }).relation,
        } satisfies CandidateProduct,
      ]),
    );

    this.variantsByProduct = new Map();
    this.variantsById = new Map();
    this.gtinOwners = new Map();
    this.mpnOwners = new Map();

    for (const variant of catalogue.variants) {
      const hydrated: CandidateVariant = {
        variantId: variant.variantId,
        productId: variant.productId,
        name: variant.name,
        signature: variant.variantId,
        isDefault: Object.keys(variant.attributes).length === 0,
        attributes: new Map(Object.entries(variant.attributes)),
        gtins: variant.gtins ?? [],
        hasBundleComponents: variant.hasBundleComponents === true,
      };
      this.variantsById.set(variant.variantId, hydrated);
      const bucket = this.variantsByProduct.get(variant.productId) ?? [];
      bucket.push(hydrated);
      this.variantsByProduct.set(variant.productId, bucket);
      for (const gtin of hydrated.gtins) this.gtinOwners.set(gtin, variant.variantId);
    }

    for (const [variantId, mpns] of Object.entries(catalogue.mpns)) {
      for (const mpn of mpns) {
        const key = mpn.trim().toUpperCase();
        const owners = this.mpnOwners.get(key) ?? [];
        owners.push(variantId);
        this.mpnOwners.set(key, owners);
      }
    }

    this.productTokens = new Map(
      [...this.products.values()].map((product) => [
        product.productId,
        titleTokens(
          `${product.name} ${(this.variantsByProduct.get(product.productId) ?? [])
            .map((variant) => variant.name ?? '')
            .join(' ')}`,
        ),
      ]),
    );

    this.blocks = catalogue.blocks ?? {};
    this.categoryAutomatic = catalogue.categoryAutomatic ?? ((): boolean => true);
  }

  findExistingAttachment(_subject: MatchSubject): Promise<ExistingAttachment | null> {
    // The benchmark measures the pipeline from a clean slate on every case; an
    // existing attachment would make stage 1 answer everything and measure
    // nothing.
    return Promise.resolve(null);
  }

  resolveSubjectIdentifiers(
    subject: MatchSubject,
  ): Promise<readonly ResolvedSubjectIdentifier[]> {
    const resolved: ResolvedSubjectIdentifier[] = [];
    for (const asserted of subject.identifiers) {
      const definition = IDENTIFIER_SCHEME_REGISTRY[asserted.scheme];
      const normalization = normalizeIdentifier(asserted.scheme, asserted.rawValue);
      if (normalization.kind === 'invalid') {
        resolved.push({
          label: `${asserted.scheme}:${asserted.rawValue}`,
          globallyUnique: definition.globallyUnique,
          requiresBrandScope: definition.requiresBrandScope,
          resolution: { kind: 'invalid', reason: normalization.reason },
        });
        continue;
      }
      const identifier = normalization.identifier;
      const grain: IdentifierGrain = identifier.grain;

      let resolution: IdentifierResolution = { kind: 'none' };
      if (identifier.canonicalValue !== undefined) {
        const owner = this.gtinOwners.get(identifier.canonicalValue);
        if (owner !== undefined) resolution = { kind: 'resolved', grain, id: owner };
      } else {
        const owners = this.mpnOwners.get(identifier.normalizedValue) ?? [];
        if (owners.length === 1 && owners[0] !== undefined) {
          resolution = { kind: 'resolved', grain, id: owners[0] };
        } else if (owners.length > 1) {
          const [ownerId, ...disputedIds] = [...owners].sort();
          if (ownerId !== undefined) {
            resolution = { kind: 'conflict', grain, ownerId, disputedIds };
          }
        }
      }

      resolved.push({
        label:
          identifier.canonicalScheme === undefined
            ? `${identifier.scheme}:${identifier.normalizedValue}`
            : `${identifier.canonicalScheme}:${identifier.canonicalValue ?? ''}`,
        globallyUnique: definition.globallyUnique,
        requiresBrandScope: identifier.requiresBrandScope,
        resolution,
      });
    }
    return Promise.resolve(resolved);
  }

  retrieveByNormalizedName(input: {
    normalizedName: string;
    limit: number;
  }): Promise<readonly string[]> {
    if (input.normalizedName.length === 0) return Promise.resolve([]);
    const ids: string[] = [];
    for (const product of this.products.values()) {
      if (
        product.normalizedName === input.normalizedName ||
        product.aliases.includes(input.normalizedName)
      ) {
        ids.push(product.productId);
      }
    }
    return Promise.resolve(ids.slice(0, input.limit));
  }

  /**
   * Token-overlap retrieval, ordered by overlap and bounded by the policy.
   *
   * A candidate with ZERO overlapping tokens is not retrieved at all, which is
   * what makes "no candidate found" a reachable outcome rather than a theoretical
   * one — and `create_new` is the recommendation a whole category of cases
   * depends on being reachable.
   */
  retrieveByTitle(query: CandidateRetrievalQuery): Promise<readonly string[]> {
    const subjectTokens = new Set(query.titleTokens);
    const scored: { productId: string; overlap: number }[] = [];
    for (const [productId, tokens] of this.productTokens) {
      let overlap = 0;
      for (const token of tokens) {
        if (subjectTokens.has(token)) overlap += 1;
      }
      if (overlap > 0) scored.push({ productId, overlap });
    }
    scored.sort((left, right) =>
      right.overlap === left.overlap
        ? left.productId.localeCompare(right.productId)
        : right.overlap - left.overlap,
    );
    return Promise.resolve(scored.slice(0, query.limit).map((entry) => entry.productId));
  }

  loadProducts(productIds: readonly string[]): Promise<readonly CandidateProduct[]> {
    const products: CandidateProduct[] = [];
    for (const id of productIds) {
      const product = this.products.get(id);
      if (product) products.push(product);
    }
    return Promise.resolve(products);
  }

  loadVariants(productIds: readonly string[]): Promise<readonly CandidateVariant[]> {
    return Promise.resolve(
      productIds.flatMap((id) => this.variantsByProduct.get(id) ?? []),
    );
  }

  loadVariantsByIds(variantIds: readonly string[]): Promise<readonly CandidateVariant[]> {
    const variants: CandidateVariant[] = [];
    for (const id of variantIds) {
      const variant = this.variantsById.get(id);
      if (variant) variants.push(variant);
    }
    return Promise.resolve(variants);
  }

  findOpenBlocks(subjectKey: string): Promise<BlockedTargets> {
    const targets = this.blocks[subjectKey] ?? [];
    const productIds = new Set<string>();
    const variantIds = new Set<string>();
    for (const target of targets) {
      if (this.variantsById.has(target)) variantIds.add(target);
      else productIds.add(target);
    }
    return Promise.resolve({ productIds, variantIds });
  }

  isCategoryAutomatic(input: { categoryKey: string | null }): Promise<boolean> {
    return Promise.resolve(this.categoryAutomatic(input.categoryKey));
  }
}
