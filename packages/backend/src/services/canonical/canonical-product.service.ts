/**
 * The canonical product write, matching and read surface (#56).
 *
 * INTERNAL services plus the public read projection. The identity rules and
 * where each is enforced:
 *
 * - **A source fact never overwrites the canonical name.** A differing source
 *   title becomes an ALIAS citing its record and a review conflict — which is
 *   the mechanical form of "a merchant title cannot create an accidental global
 *   identity" (#56 acceptance 2): a seller's words reach the alias table and the
 *   source record, and never the canonical `name`.
 * - **A lower-confidence source never replaces a stronger one's value**
 *   (ADR 0002 D19 semantics: NULL confidence is deterministic/human and outranks
 *   every number), and an operator-PINNED field is not source-writable at all.
 * - **Every applied field records its provenance** in `canonical_field_provenance`
 *   in the SAME transaction as the write, so #56 acceptance 4 is structural:
 *   there is no code path that writes a source-supplied field without the record
 *   and the provenance row committing beside it.
 * - **A merge preserves redirects and references**: the loser becomes a
 *   tombstone whose row is never deleted, its children are repointed, each hop
 *   is appended to `canonical_product_redirects`, and chain flattening keeps
 *   resolution one hop.
 *
 * `catalog_revisions` (#59) is the operator audit ledger this domain will also
 * write to; until it lands, the durable audit of a merge is the tombstone, the
 * repointed children and the redirect history.
 */

import { isUniqueViolation } from '@oxyhq/db';
import type {
  CanonicalAlias,
  CanonicalAttributeAssignment,
  CanonicalImage,
  CanonicalProduct,
  FieldProvenance,
  IdentifierScheme,
  PaginatedResponse,
  SourceFreshness,
  SourceLinkMethod,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countProductsForFamily,
  findCanonicalProductById,
  findCanonicalProductBySlug,
  findCanonicalProductIdsByNormalizedAlias,
  findCanonicalProductIdsBySourceRecordIds,
  findCanonicalProductsByIds,
  findCanonicalProductsByNormalizedName,
  insertCanonicalProduct,
  insertCanonicalProductAlias,
  insertCanonicalProductRedirect,
  insertCanonicalProductSourceLink,
  listCanonicalProductAliases,
  listCanonicalProductRedirects,
  listCanonicalProductSourceLinks,
  listCanonicalProductsPage,
  listProductsForBrand,
  markCanonicalProductMerged,
  repointCanonicalProductAliases,
  repointCanonicalProductSourceLinks,
  retargetProductTombstones,
  searchCanonicalProductsByNameSimilarity,
  findProductTombstonesPointingAt,
  updateCanonicalProduct as updateProductRow,
  type CanonicalProductRow,
} from '../../db/canonical/canonicalProductRepository.js';
import {
  findProductFamilyById,
  refreshFamilyProductCount,
} from '../../db/canonical/productFamilyRepository.js';
import {
  countVariantsForProduct,
  findCanonicalVariantById,
} from '../../db/canonical/canonicalVariantRepository.js';
import {
  insertCanonicalImage,
  listAttributeValues,
  listCanonicalImages,
  listFieldProvenance,
  recordFieldProvenance,
} from '../../db/canonical/attributeRepository.js';
import {
  listIdentifiersForProduct,
  repointProductIdentifiers,
} from '../../db/canonical/productIdentifierRepository.js';
import {
  findCatalogSourceById,
  findSourceRecordsByIds,
  listSourceRecordsForObject,
  recordSourceObservation,
} from '../../db/canonical/provenanceRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { rehomeReviewsForProductMerge } from '../reviews/review-migration.service.js';
import { rebuildScopedAggregate } from '../reviews/review-aggregate.service.js';
import { log } from '../../lib/logger.js';
import { contentHashOf, type JsonValue } from './content-hash.js';
import { normalizeAliasLookup, normalizeEntityName, slugFromName } from './normalization.js';
import { normalizeAttributeKey } from './variant-signature.js';
import { ensureDefaultVariant, listVariantOptions } from './canonical-variant.service.js';
import { isPubliclyVisibleIdentifier } from './product-identifier.service.js';
import { resolveIdentifier } from './product-identifier.service.js';

/** How many redirect hops resolution tolerates before calling the data corrupt. */
const MAX_MERGE_HOPS = 10;

/** Trigram scores below this are noise, not candidates. On pg_trgm's 0–1 scale. */
const MIN_SIMILARITY = 0.3;

/** Follow `merged_into_id` to the live row. One hop by invariant; bounded anyway. */
async function resolveProductRow(
  db: DatabaseOrTransaction,
  row: CanonicalProductRow,
): Promise<CanonicalProductRow> {
  let current = row;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    if (current.status !== 'merged' || !current.mergedIntoId) return current;
    const next = await findCanonicalProductById(db, current.mergedIntoId);
    if (!next) {
      throw new Error(
        `Canonical product ${current.id} redirects to missing product ${current.mergedIntoId}.`,
      );
    }
    current = next;
  }
  throw new Error(`Canonical product merge chain exceeds ${MAX_MERGE_HOPS} hops from ${row.id}.`);
}

export interface CreateCanonicalProductInput {
  /** The canonical MODEL name — "iPhone 16 Pro", never a seller's listing title. */
  name: string;
  /** Defaults to `slugFromName(name)`. A collision is a conflict, never suffixed. */
  slug?: string;
  description?: string;
  brandId?: string;
  familyId?: string;
  categoryId?: string;
  releasedAt?: Date;
  modelYear?: number;
  modelCode?: string;
  /**
   * The option axes this product's variants vary along. EMPTY means the product
   * has no meaningful configurations, and it gets exactly one default variant.
   */
  variantDefiningAttributeKeys?: string[];
  searchTokens?: string[];
  aliases?: { alias: string; kind: CanonicalAlias['kind']; language?: string }[];
  status?: CanonicalProductRow['status'];
  actorOxyUserId?: string;
}

/**
 * Mint a canonical product.
 *
 * The canonical name always gets its own `name_variant` alias row, so alias
 * resolution has ONE lookup space — a product is findable by every name it has
 * ever carried, its canonical one included. A product with no declared axes gets
 * its default variant here, which is where D13's ≥1 invariant is actually held:
 * creation mints product and variant in one transaction.
 */
export async function createCanonicalProduct(
  input: CreateCanonicalProductInput,
): Promise<CanonicalProductRow> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw validationError('createCanonicalProduct: name must be a non-empty string.');
  }
  const normalizedName = normalizeEntityName(name);
  if (normalizedName.length === 0) {
    throw validationError(`createCanonicalProduct: name '${name}' has no normalizable content.`);
  }
  const slug = input.slug ?? slugFromName(name);
  if (!slug) {
    throw validationError(`createCanonicalProduct: cannot derive a slug from '${name}'.`);
  }
  const axes = [...new Set((input.variantDefiningAttributeKeys ?? []).map(normalizeAttributeKey))];
  if (axes.some((axis) => axis.length === 0)) {
    throw validationError('createCanonicalProduct: an option axis cannot be empty.');
  }

  let productId: string;
  try {
    productId = await getDb().transaction(async (tx) => {
      if (input.familyId !== undefined) {
        const family = await findProductFamilyById(tx, input.familyId);
        if (!family) throw notFound(`Product family ${input.familyId} does not exist.`);
      }
      const product = await insertCanonicalProduct(tx, {
        slug,
        name,
        normalizedName,
        description: input.description ?? null,
        brandId: input.brandId ?? null,
        familyId: input.familyId ?? null,
        categoryId: input.categoryId ?? null,
        releasedAt: input.releasedAt ?? null,
        modelYear: input.modelYear ?? null,
        modelCode: input.modelCode ?? null,
        variantDefiningAttributeKeys: axes,
        searchTokens: input.searchTokens ?? [],
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      await insertCanonicalProductAlias(tx, {
        productId: product.id,
        alias: name,
        kind: 'name_variant',
        ...(input.actorOxyUserId === undefined
          ? {}
          : { createdByOxyUserId: input.actorOxyUserId }),
      });
      for (const alias of input.aliases ?? []) {
        await insertCanonicalProductAlias(tx, {
          productId: product.id,
          alias: alias.alias,
          kind: alias.kind,
          ...(alias.language === undefined ? {} : { language: alias.language }),
          ...(input.actorOxyUserId === undefined
            ? {}
            : { createdByOxyUserId: input.actorOxyUserId }),
        });
      }
      if (input.familyId !== undefined) {
        await refreshFamilyProductCount(
          tx,
          input.familyId,
          await countProductsForFamily(tx, input.familyId),
        );
      }
      return product.id;
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error, 'canonical_products_slug_key')) {
      throw conflict(`A canonical product with slug '${slug}' already exists.`);
    }
    throw error;
  }

  // The default variant is minted in its own transaction, through the variant
  // service, so the ≥1 invariant is held by ONE writer rather than by two
  // implementations of the same rule that can drift.
  if (axes.length === 0) await ensureDefaultVariant(productId);

  const created = await findCanonicalProductById(getDb(), productId);
  if (!created) throw new Error(`Canonical product ${productId} vanished after creation.`);
  return created;
}

export interface UpdateCanonicalProductInput {
  name?: string;
  description?: string;
  brandId?: string;
  familyId?: string;
  categoryId?: string;
  releasedAt?: Date;
  discontinuedAt?: Date;
  modelYear?: number;
  modelCode?: string;
  searchTokens?: string[];
  /** `merged` is refused — a merge is {@link mergeCanonicalProducts}, never a field write. */
  status?: Exclude<CanonicalProductRow['status'], 'merged'>;
  actorOxyUserId: string;
}

/**
 * An OPERATOR update. Every field it touches is PINNED (`pinned_fields`, the
 * `listings.overriddenFields` precedent) so ingestion respects the correction on
 * every subsequent apply — and a rename keeps the old name reachable as a
 * `former_name` alias.
 */
export async function updateCanonicalProduct(
  productId: string,
  input: UpdateCanonicalProductInput,
): Promise<CanonicalProductRow> {
  return getDb().transaction(async (tx) => {
    const product = await findCanonicalProductById(tx, productId);
    if (!product) throw notFound(`Canonical product ${productId} does not exist.`);
    if (product.status === 'merged') {
      throw conflict(
        `Canonical product ${productId} is merged into ${String(product.mergedIntoId)}; update the winner.`,
      );
    }

    const patch: Parameters<typeof updateProductRow>[2] = {};
    const pinned = new Set(product.pinnedFields);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) throw validationError('updateCanonicalProduct: name must be non-empty.');
      const normalizedName = normalizeEntityName(name);
      if (normalizedName.length === 0) {
        throw validationError(`updateCanonicalProduct: name '${name}' has no normalizable content.`);
      }
      if (name !== product.name) {
        patch.name = name;
        patch.normalizedName = normalizedName;
        pinned.add('name');
        await insertCanonicalProductAlias(tx, {
          productId,
          alias: product.name,
          kind: 'former_name',
          createdByOxyUserId: input.actorOxyUserId,
        });
        await insertCanonicalProductAlias(tx, {
          productId,
          alias: name,
          kind: 'name_variant',
          createdByOxyUserId: input.actorOxyUserId,
        });
      }
    }

    const previousFamilyId = product.familyId;
    const scalarUpdates: [keyof UpdateCanonicalProductInput, string][] = [
      ['description', 'description'],
      ['brandId', 'brandId'],
      ['familyId', 'familyId'],
      ['categoryId', 'categoryId'],
      ['releasedAt', 'releasedAt'],
      ['discontinuedAt', 'discontinuedAt'],
      ['modelYear', 'modelYear'],
      ['modelCode', 'modelCode'],
      ['searchTokens', 'searchTokens'],
    ];
    for (const [inputKey, field] of scalarUpdates) {
      const value = input[inputKey];
      if (value === undefined) continue;
      Object.assign(patch, { [field]: value });
      pinned.add(field);
    }
    if (input.status !== undefined) patch.status = input.status;

    patch.pinnedFields = [...pinned].sort();
    patch.lastReviewedAt = new Date();
    const updated = await updateProductRow(tx, productId, patch);
    if (!updated) throw notFound(`Canonical product ${productId} does not exist.`);

    for (const familyId of new Set(
      [previousFamilyId, updated.familyId].filter((id): id is string => id !== null),
    )) {
      await refreshFamilyProductCount(tx, familyId, await countProductsForFamily(tx, familyId));
    }
    return updated;
  });
}

/** One field the observation could not apply, and the reason it is review input. */
export interface ProductFieldConflict {
  field: string;
  reason: 'pinned' | 'lower_confidence' | 'conflicting_name';
  /** The value the source asserted, for the reviewer. */
  sourceValue: string;
}

export interface ApplyProductSourceObservationInput {
  productId: string;
  sourceId: string;
  /** The source's own id for the observed object. */
  externalId: string;
  observedAt: Date;
  staleAt?: Date;
  method: SourceLinkMethod;
  /** The explainable rule id that matched this observation to this product. */
  matchRule: string;
  /** 0–1; omit for a deterministic or human decision (treated as strongest). */
  confidence?: number;
  decidedByOxyUserId?: string;
  /** What the source asserted about the product. */
  fields: {
    /** A source TITLE. Never written to `name` — it becomes an alias. */
    name?: string;
    description?: string;
    releasedAt?: Date;
    modelYear?: number;
    modelCode?: string;
  };
  /** Images the source supplied, each traced to this observation. */
  images?: { fileId?: string; sourceUrl?: string; alt?: string; locale?: string }[];
  /** Identifiers the source asserted, applied through the identifier service. */
  identifiers?: { scheme: IdentifierScheme; rawValue: string }[];
}

export interface ApplyProductSourceObservationResult {
  product: CanonicalProductRow;
  sourceRecordId: string;
  /** `false` when identical content had already been observed. */
  newObservation: boolean;
  /** Field names actually written, each with a provenance row beside it. */
  applied: string[];
  /** What was NOT applied, and why — the review path's input. */
  conflicts: ProductFieldConflict[];
  /** Images attached by this observation. */
  imagesAdded: number;
}

/**
 * The source-upsert: record the observation, link it, apply what the rules allow
 * — ONE transaction (ADR 0002 D22), so a crash cannot leave applied fields with
 * no provenance behind them.
 *
 * A repeat of identical content converges: the record insert no-ops on its
 * content hash, the link insert no-ops on its active partial unique, the image
 * inserts no-op on their reference uniques, and the field application re-derives
 * the same values.
 */
export async function applyProductSourceObservation(
  input: ApplyProductSourceObservationInput,
): Promise<ApplyProductSourceObservationResult> {
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw validationError('applyProductSourceObservation: confidence must be within [0, 1].');
  }

  return getDb().transaction(async (tx) => {
    const loaded = await findCanonicalProductById(tx, input.productId);
    if (!loaded) throw notFound(`Canonical product ${input.productId} does not exist.`);
    // A late observation for a tombstone belongs to its winner — mappings moved
    // in the merge, and new ones follow them.
    const product = await resolveProductRow(tx, loaded);

    const source = await findCatalogSourceById(tx, input.sourceId);
    if (!source) throw notFound(`Catalog source ${input.sourceId} does not exist.`);

    const payload: JsonValue = {
      ...(input.fields.name === undefined ? {} : { name: input.fields.name }),
      ...(input.fields.description === undefined
        ? {}
        : { description: input.fields.description }),
      ...(input.fields.releasedAt === undefined
        ? {}
        : { releasedAt: input.fields.releasedAt.toISOString() }),
      ...(input.fields.modelYear === undefined ? {} : { modelYear: input.fields.modelYear }),
      ...(input.fields.modelCode === undefined ? {} : { modelCode: input.fields.modelCode }),
      ...((input.images ?? []).length === 0
        ? {}
        : {
            images: (input.images ?? [])
              .map((image) => image.fileId ?? image.sourceUrl ?? '')
              .sort(),
          }),
      ...((input.identifiers ?? []).length === 0
        ? {}
        : {
            identifiers: (input.identifiers ?? [])
              .map((identifier) => `${identifier.scheme}:${identifier.rawValue}`)
              .sort(),
          }),
    };

    const { record, inserted } = await recordSourceObservation(tx, {
      sourceId: input.sourceId,
      externalType: 'product',
      externalId: input.externalId,
      observedAt: input.observedAt,
      ...(input.staleAt === undefined ? {} : { staleAt: input.staleAt }),
      contentHash: contentHashOf(payload),
      // Storage is a RIGHT of the source, not a given (ADR 0002 D19).
      ...(source.mayStore ? { payload } : {}),
    });

    // The strongest support the product already has, BEFORE this link joins it.
    const activeLinks = await listCanonicalProductSourceLinks(tx, product.id, 'active');
    const existingStrength = activeLinks
      .filter((link) => link.sourceRecordId !== record.id)
      .reduce((max, link) => Math.max(max, link.confidence ?? 1), 0);

    await insertCanonicalProductSourceLink(tx, {
      productId: product.id,
      sourceRecordId: record.id,
      method: input.method,
      matchRule: input.matchRule,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.decidedByOxyUserId === undefined
        ? {}
        : { decidedByOxyUserId: input.decidedByOxyUserId }),
    });

    const incomingStrength = input.confidence ?? 1;
    const pinned = new Set(product.pinnedFields);
    const applied: string[] = [];
    const conflicts: ProductFieldConflict[] = [];
    const patch: Parameters<typeof updateProductRow>[2] = {};

    // A source TITLE is never the canonical name. A seller's or a feed's words
    // become an alias plus a review conflict, so no import can rename a product.
    if (input.fields.name !== undefined) {
      const sourceName = input.fields.name.trim();
      if (
        sourceName.length > 0 &&
        normalizeAliasLookup(sourceName) !== normalizeAliasLookup(product.name)
      ) {
        await insertCanonicalProductAlias(tx, {
          productId: product.id,
          alias: sourceName,
          kind: 'name_variant',
          sourceRecordId: record.id,
        });
        conflicts.push({ field: 'name', reason: 'conflicting_name', sourceValue: sourceName });
      }
    }

    const scalarFields: {
      field: 'description' | 'modelCode';
      value: string | undefined;
      current: string | null;
    }[] = [
      { field: 'description', value: input.fields.description, current: product.description },
      { field: 'modelCode', value: input.fields.modelCode, current: product.modelCode },
    ];
    for (const { field, value, current } of scalarFields) {
      if (value === undefined || value === current) continue;
      if (pinned.has(field)) {
        conflicts.push({ field, reason: 'pinned', sourceValue: value });
        continue;
      }
      // Filling absence is not overwriting; replacing a value needs at least the
      // strength of what put it there.
      if (current !== null && incomingStrength < existingStrength) {
        conflicts.push({ field, reason: 'lower_confidence', sourceValue: value });
        continue;
      }
      Object.assign(patch, { [field]: value });
      applied.push(field);
    }

    if (input.fields.modelYear !== undefined && input.fields.modelYear !== product.modelYear) {
      if (pinned.has('modelYear')) {
        conflicts.push({
          field: 'modelYear',
          reason: 'pinned',
          sourceValue: String(input.fields.modelYear),
        });
      } else if (product.modelYear !== null && incomingStrength < existingStrength) {
        conflicts.push({
          field: 'modelYear',
          reason: 'lower_confidence',
          sourceValue: String(input.fields.modelYear),
        });
      } else {
        patch.modelYear = input.fields.modelYear;
        applied.push('modelYear');
      }
    }

    if (input.fields.releasedAt !== undefined) {
      const current = product.releasedAt;
      const differs = current === null || current.getTime() !== input.fields.releasedAt.getTime();
      if (differs) {
        if (pinned.has('releasedAt')) {
          conflicts.push({
            field: 'releasedAt',
            reason: 'pinned',
            sourceValue: input.fields.releasedAt.toISOString(),
          });
        } else if (current !== null && incomingStrength < existingStrength) {
          conflicts.push({
            field: 'releasedAt',
            reason: 'lower_confidence',
            sourceValue: input.fields.releasedAt.toISOString(),
          });
        } else {
          patch.releasedAt = input.fields.releasedAt;
          applied.push('releasedAt');
        }
      }
    }

    patch.lastSeenAt =
      product.lastSeenAt && product.lastSeenAt > input.observedAt
        ? product.lastSeenAt
        : input.observedAt;
    if (input.observedAt < product.firstSeenAt) patch.firstSeenAt = input.observedAt;

    const updated = await updateProductRow(tx, product.id, patch);
    if (!updated) throw new Error(`Canonical product ${product.id} vanished mid-transaction.`);

    // Every applied field records WHERE it came from, in this same transaction.
    // That pairing is what makes acceptance criterion 4 structural.
    for (const field of applied) {
      await recordFieldProvenance(tx, {
        grain: { kind: 'product', id: product.id },
        field,
        sourceRecordId: record.id,
        method: input.method,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.decidedByOxyUserId === undefined
          ? {}
          : { decidedByOxyUserId: input.decidedByOxyUserId }),
        selectedAt: input.observedAt,
      });
    }

    let imagesAdded = 0;
    for (const [index, image] of (input.images ?? []).entries()) {
      if (image.fileId === undefined && image.sourceUrl === undefined) {
        throw validationError('A canonical image needs either a fileId or a sourceUrl.');
      }
      const row = await insertCanonicalImage(tx, {
        grain: { kind: 'product', id: product.id },
        sourceRecordId: record.id,
        ...(image.fileId === undefined ? {} : { fileId: image.fileId }),
        ...(image.sourceUrl === undefined ? {} : { sourceUrl: image.sourceUrl }),
        ...(image.alt === undefined ? {} : { alt: image.alt }),
        ...(image.locale === undefined ? {} : { locale: image.locale }),
        position: index,
      });
      if (row) imagesAdded += 1;
    }

    return {
      product: updated,
      sourceRecordId: record.id,
      newObservation: inserted,
      applied,
      conflicts,
      imagesAdded,
    };
  });
}

/** The live product an id or slug resolves to — a tombstone answers with its winner. */
export async function resolveCanonicalProduct(
  idOrSlug: string,
): Promise<CanonicalProductRow | undefined> {
  const db = getDb();
  const row =
    (await findCanonicalProductById(db, idOrSlug)) ?? (await findCanonicalProductBySlug(db, idOrSlug));
  if (!row) return undefined;
  return resolveProductRow(db, row);
}

/**
 * Reverse lookup by name/alias: ONE canonical id or an explicit ambiguity.
 *
 * Never a silent first-match: two products legitimately sharing an alias is
 * information the caller needs, and picking one would be the accidental identity
 * this domain exists to prevent.
 */
export async function resolveCanonicalProductByAlias(
  name: string,
): Promise<{ kind: 'resolved'; id: string } | { kind: 'ambiguous'; candidateIds: string[] } | { kind: 'none' }> {
  const lookup = normalizeAliasLookup(name);
  if (lookup.length === 0) return { kind: 'none' };
  const db = getDb();

  const ids = await findCanonicalProductIdsByNormalizedAlias(db, lookup);
  const rows = await findCanonicalProductsByIds(db, ids);
  const finalIds = new Set<string>();
  for (const row of rows) finalIds.add((await resolveProductRow(db, row)).id);

  if (finalIds.size === 0) return { kind: 'none' };
  if (finalIds.size === 1) {
    const [id] = finalIds;
    if (id === undefined) return { kind: 'none' };
    return { kind: 'resolved', id };
  }
  return { kind: 'ambiguous', candidateIds: [...finalIds].sort() };
}

/**
 * Reverse lookup from a source's own id: which products do observations of this
 * external object support?
 *
 * This is where a marketplace id (ASIN and friends) and a merchant's own product
 * id are answerable WITHOUT any of them being a `product_identifiers` row: the
 * source record holds the foreign key space, the link table holds the decision.
 */
export async function findCanonicalProductIdsBySourceObject(
  sourceId: string,
  externalId: string,
): Promise<string[]> {
  const db = getDb();
  const records = await listSourceRecordsForObject(db, sourceId, 'product', externalId);
  const ids = await findCanonicalProductIdsBySourceRecordIds(
    db,
    records.map((record) => record.id),
  );
  const finalIds = new Set<string>();
  for (const row of await findCanonicalProductsByIds(db, ids)) {
    finalIds.add((await resolveProductRow(db, row)).id);
  }
  return [...finalIds].sort();
}

/**
 * Lookup by identifier — the deterministic path, and the one that answers
 * `conflict` rather than picking an owner.
 */
export async function findCanonicalProductByIdentifier(
  scheme: IdentifierScheme,
  rawValue: string,
): Promise<{ productId: string } | { conflictOwnerId: string; disputedIds: string[] } | undefined> {
  const resolution = await resolveIdentifier(scheme, rawValue);
  const db = getDb();
  switch (resolution.kind) {
    case 'resolved': {
      if (resolution.grain === 'product') {
        const product = await findCanonicalProductById(db, resolution.id);
        if (!product) return undefined;
        return { productId: (await resolveProductRow(db, product)).id };
      }
      const productId = await productIdOfVariant(db, resolution.id);
      return productId === undefined ? undefined : { productId };
    }
    case 'conflict':
      return { conflictOwnerId: resolution.ownerId, disputedIds: resolution.disputedIds };
    case 'invalid':
    case 'none':
      return undefined;
  }
}

/**
 * The product a variant belongs to, resolved through any merge.
 *
 * A GTIN identifies a VARIANT (ADR 0002 D14), so a lookup by GTIN that wants a
 * product has to walk up — and the walk goes through the variant's own product
 * pointer rather than through the identifier row, which never names a product
 * when it names a variant.
 */
async function productIdOfVariant(
  db: DatabaseOrTransaction,
  variantId: string,
): Promise<string | undefined> {
  const variant = await findCanonicalVariantById(db, variantId);
  if (!variant) return undefined;
  const product = await findCanonicalProductById(db, variant.productId);
  if (!product) return undefined;
  return (await resolveProductRow(db, product)).id;
}

/** One candidate a search produced — evidence for review, never a merge. */
export interface CanonicalProductCandidate {
  productId: string;
  slug: string;
  name: string;
  status: CanonicalProductRow['status'];
  /** 1 for an exact normalized match; pg_trgm similarity otherwise. */
  score: number;
  matchedVia: 'normalized_name' | 'alias' | 'name_similarity';
}

/**
 * Candidate generation. Returns candidates and NOTHING else happens: no merge,
 * no link, no write. A matching name is evidence for review, never an identity.
 */
export async function searchCanonicalProductCandidates(
  name: string,
  limit = 10,
): Promise<CanonicalProductCandidate[]> {
  const normalized = normalizeEntityName(name);
  if (normalized.length === 0) return [];
  const db = getDb();

  const byId = new Map<string, CanonicalProductCandidate>();
  const offer = async (
    row: CanonicalProductRow,
    score: number,
    matchedVia: CanonicalProductCandidate['matchedVia'],
  ): Promise<void> => {
    const resolved = await resolveProductRow(db, row);
    const existing = byId.get(resolved.id);
    if (existing && existing.score >= score) return;
    byId.set(resolved.id, {
      productId: resolved.id,
      slug: resolved.slug,
      name: resolved.name,
      status: resolved.status,
      score,
      matchedVia,
    });
  };

  for (const row of await findCanonicalProductsByNormalizedName(db, normalized)) {
    await offer(row, 1, 'normalized_name');
  }
  const aliasIds = await findCanonicalProductIdsByNormalizedAlias(db, normalizeAliasLookup(name));
  for (const row of await findCanonicalProductsByIds(db, aliasIds)) {
    await offer(row, 1, 'alias');
  }
  for (const { product, similarity } of await searchCanonicalProductsByNameSimilarity(
    db,
    normalized,
    limit,
  )) {
    if (similarity < MIN_SIMILARITY) continue;
    await offer(product, similarity, 'name_similarity');
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface MergeCanonicalProductsInput {
  winnerId: string;
  loserId: string;
  actorOxyUserId: string;
  note?: string;
}

export interface MergeCanonicalProductsResult {
  /** `false` when the loser was already merged — the idempotent re-run. */
  merged: boolean;
  winnerId: string;
  loserId: string;
  /** Redirect rows appended by this merge, the flattened hops included. */
  redirectsRecorded: number;
  /** Product reviews moved onto the winner (#76 migration rule 4). */
  reviewsRehomed: number;
  /**
   * Reviews left on the tombstone because their author already reviewed the
   * winner. A merge must not delete one of a buyer's two genuine reviews, so
   * these wait for an explicit operator assignment (#76 migration rule 5).
   */
  reviewsNeedingAssignment: string[];
}

/**
 * The operator merge (ADR 0002 D16), one transaction.
 *
 * The redirect HISTORY is the part `merged_into_id` cannot provide: flattening
 * overwrites that column, so without an appended row the intermediate hop is
 * lost. Each retargeted tombstone therefore gets its own `flatten` row beside
 * the merge's own.
 */
export async function mergeCanonicalProducts(
  input: MergeCanonicalProductsInput,
): Promise<MergeCanonicalProductsResult> {
  if (input.winnerId === input.loserId) {
    throw validationError('mergeCanonicalProducts: a product cannot be merged into itself.');
  }
  if (input.actorOxyUserId.trim().length === 0) {
    throw validationError('mergeCanonicalProducts: an actor is required.');
  }

  const result = await getDb().transaction(async (tx) => {
    const loser = await findCanonicalProductById(tx, input.loserId);
    if (!loser) throw notFound(`Canonical product ${input.loserId} does not exist.`);
    const winnerRow = await findCanonicalProductById(tx, input.winnerId);
    if (!winnerRow) throw notFound(`Canonical product ${input.winnerId} does not exist.`);

    if (loser.status === 'merged') {
      return {
        merged: false,
        winnerId: loser.mergedIntoId ?? input.winnerId,
        loserId: loser.id,
        redirectsRecorded: 0,
        reviewsRehomed: 0,
        reviewsNeedingAssignment: [],
      };
    }
    const winner = await resolveProductRow(tx, winnerRow);
    if (winner.id === loser.id) {
      throw validationError(
        'mergeCanonicalProducts: the winner resolves to the loser — refusing a cycle.',
      );
    }

    // The CAS comes FIRST: a concurrent duplicate merge loses here and walks
    // away having written nothing at all.
    const stamped = await markCanonicalProductMerged(tx, loser.id, winner.id);
    if (!stamped) {
      return {
        merged: false,
        winnerId: winner.id,
        loserId: loser.id,
        redirectsRecorded: 0,
        reviewsRehomed: 0,
        reviewsNeedingAssignment: [],
      };
    }

    // Capture the tombstones BEFORE flattening overwrites their pointers.
    const affected = await findProductTombstonesPointingAt(tx, loser.id);

    await repointCanonicalProductAliases(tx, loser.id, winner.id);
    await repointCanonicalProductSourceLinks(tx, loser.id, winner.id);
    await repointProductIdentifiers(tx, loser.id, winner.id);
    await retargetProductTombstones(tx, loser.id, winner.id);

    let redirectsRecorded = 0;
    const merge = await insertCanonicalProductRedirect(tx, {
      fromId: loser.id,
      toId: winner.id,
      reason: 'merge',
      actorOxyUserId: input.actorOxyUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    if (merge) redirectsRecorded += 1;
    for (const tombstone of affected) {
      if (tombstone.id === winner.id) continue;
      const flattened = await insertCanonicalProductRedirect(tx, {
        fromId: tombstone.id,
        toId: winner.id,
        reason: 'flatten',
        actorOxyUserId: input.actorOxyUserId,
      });
      if (flattened) redirectsRecorded += 1;
    }

    await insertCanonicalProductAlias(tx, {
      productId: winner.id,
      alias: loser.name,
      kind: 'former_name',
      createdByOxyUserId: input.actorOxyUserId,
    });

    const lastSeenAt =
      loser.lastSeenAt && (!winner.lastSeenAt || loser.lastSeenAt > winner.lastSeenAt)
        ? loser.lastSeenAt
        : winner.lastSeenAt;
    await updateProductRow(tx, winner.id, {
      firstSeenAt: loser.firstSeenAt < winner.firstSeenAt ? loser.firstSeenAt : winner.firstSeenAt,
      lastSeenAt,
      lastReviewedAt: new Date(),
      variantCount: await countVariantsForProduct(tx, winner.id),
    });
    for (const familyId of new Set(
      [loser.familyId, winner.familyId].filter((id): id is string => id !== null),
    )) {
      await refreshFamilyProductCount(tx, familyId, await countProductsForFamily(tx, familyId));
    }

    /**
     * #76 migration rule 4: a product merge rehomes the loser's PRODUCT reviews
     * onto the winner and rebuilds the aggregates.
     *
     * Inside this transaction, so a failed merge leaves every review exactly
     * where it was — and BEFORE the commit, so the append-only migration rows
     * that record where each review came from cannot end up on the other side of
     * a rollback from the move they describe. The aggregates are rebuilt after
     * the commit (below): a rebuild inside would derive from rows nobody else
     * can see yet.
     */
    const rehome = await rehomeReviewsForProductMerge(tx, loser.id, winner.id);
    if (rehome.collisions.length > 0) {
      // A buyer who legitimately reviewed BOTH products keeps both. The loser's
      // tombstone still resolves through `merged_into_id`, so nothing is lost;
      // which of the two survives on the winner is an operator decision (#76
      // migration rule 5's split assignment, used in the other direction).
      log.general.info(
        { winnerId: winner.id, loserId: loser.id, collisions: rehome.collisions.length },
        'Product merge left duplicate-author reviews on the tombstone for explicit assignment',
      );
    }

    return {
      merged: true,
      winnerId: winner.id,
      loserId: loser.id,
      redirectsRecorded,
      reviewsRehomed: rehome.rehomed,
      reviewsNeedingAssignment: rehome.collisions,
    };
  });

  if (result.merged) {
    // Outside the transaction, and both of them: the loser's aggregate must go
    // to zero and the winner's must absorb what moved. Idempotent, so the sweep
    // re-deriving them later changes nothing.
    for (const productId of [result.loserId, result.winnerId]) {
      try {
        await rebuildScopedAggregate('product', productId);
      } catch (err) {
        log.general.warn(
          { err, productId },
          'Aggregate rebuild after a product merge failed (the sweep will re-derive it)',
        );
      }
    }
  }

  return result;
}

/** Every redirect hop recorded from a product id — the history a merge preserves. */
export async function listProductRedirectHistory(
  productId: string,
): Promise<{ toId: string; reason: string; createdAt: string }[]> {
  const rows = await listCanonicalProductRedirects(getDb(), productId);
  return rows.map((row) => ({
    toId: row.toId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Every live product of one brand — the reverse lookup #72's brand page reads. */
export async function listCanonicalProductsForBrand(
  brandId: string,
  limit = 50,
): Promise<CanonicalProductRow[]> {
  return listProductsForBrand(getDb(), brandId, Math.min(200, Math.max(1, limit)));
}

/** Build the safe freshness projection from the entity's active links. */
async function productFreshness(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<SourceFreshness | undefined> {
  const links = await listCanonicalProductSourceLinks(db, productId, 'active');
  const records = await findSourceRecordsByIds(
    db,
    links.map((link) => link.sourceRecordId),
  );
  const latest = records.reduce<(typeof records)[number] | undefined>(
    (best, record) => (!best || record.observedAt > best.observedAt ? record : best),
    undefined,
  );
  if (!latest) return undefined;
  const source = await findCatalogSourceById(db, latest.sourceId);
  if (!source) return undefined;
  return {
    sourceKind: source.kind,
    observedAt: latest.observedAt.toISOString(),
    ...(latest.staleAt ? { staleAt: latest.staleAt.toISOString() } : {}),
  };
}

/** The freshness of ONE source record, for an image's own provenance. */
async function recordFreshness(
  db: DatabaseOrTransaction,
  sourceRecordId: string,
): Promise<SourceFreshness | undefined> {
  const records = await findSourceRecordsByIds(db, [sourceRecordId]);
  const record = records[0];
  if (!record) return undefined;
  const source = await findCatalogSourceById(db, record.sourceId);
  if (!source) return undefined;
  return {
    sourceKind: source.kind,
    observedAt: record.observedAt.toISOString(),
    ...(record.staleAt ? { staleAt: record.staleAt.toISOString() } : {}),
  };
}

/**
 * The public read projection: verified facts, safe source freshness, and the
 * provenance of every selected field.
 *
 * Internal state — link confidences, match rules, pinned fields, source ids — is
 * structurally absent from the return type. Field provenance appears because
 * #56 acceptance 4 asks for traceability, and it carries the source KIND and
 * observation time, never the source record's id.
 */
export async function getPublicCanonicalProduct(
  idOrSlug: string,
): Promise<CanonicalProduct | undefined> {
  const db = getDb();
  const row =
    (await findCanonicalProductById(db, idOrSlug)) ?? (await findCanonicalProductBySlug(db, idOrSlug));
  if (!row) return undefined;
  return toPublicCanonicalProduct(db, await resolveProductRow(db, row));
}

/** Offset-paginated product list — the pagination seam #70–#73 read through. */
export async function listPublicCanonicalProducts(
  page = 1,
  limit = 20,
): Promise<PaginatedResponse<CanonicalProduct>> {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const db = getDb();
  const { rows, total } = await listCanonicalProductsPage(db, (safePage - 1) * safeLimit, safeLimit);
  const data: CanonicalProduct[] = [];
  for (const row of rows) data.push(await toPublicCanonicalProduct(db, row));
  const pages = Math.max(1, Math.ceil(total / safeLimit));
  return {
    data,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages,
      hasNextPage: safePage < pages,
      hasPreviousPage: safePage > 1,
    },
  };
}

async function toPublicCanonicalProduct(
  db: DatabaseOrTransaction,
  row: CanonicalProductRow,
): Promise<CanonicalProduct> {
  const aliases = await listCanonicalProductAliases(db, row.id);
  const freshness = await productFreshness(db, row.id);
  const imageRows = await listCanonicalImages(db, { kind: 'product', id: row.id });
  const attributeRows = await listAttributeValues(db, { kind: 'product', id: row.id });
  const identifierRows = await listIdentifiersForProduct(db, row.id);
  const provenanceRows = await listFieldProvenance(db, { kind: 'product', id: row.id });

  const images: CanonicalImage[] = [];
  for (const image of imageRows) {
    if (image.status !== 'active') continue;
    images.push({
      id: image.id,
      ...(image.fileId === null ? {} : { fileId: image.fileId }),
      ...(image.sourceUrl === null ? {} : { sourceUrl: image.sourceUrl }),
      ...(image.alt === null ? {} : { alt: image.alt }),
      ...(image.locale === null ? {} : { locale: image.locale }),
      position: image.position,
      status: image.status,
      ...(await recordFreshness(db, image.sourceRecordId).then((value) =>
        value === undefined ? {} : { freshness: value },
      )),
    });
  }

  const attributes: CanonicalAttributeAssignment[] = attributeRows.map((attribute) => ({
    key: attribute.attributeKey,
    definitionVersion: attribute.definitionVersion ?? 0,
    displayValue: attribute.sourceDisplayValue,
    ...(attribute.normalizedText === null ? {} : { normalizedText: attribute.normalizedText }),
    ...(attribute.normalizedNumber === null
      ? {}
      : { normalizedNumber: attribute.normalizedNumber }),
    ...(attribute.normalizedNumberMax === null
      ? {}
      : { normalizedNumberMax: attribute.normalizedNumberMax }),
    ...(attribute.normalizedUnit === null ? {} : { normalizedUnit: attribute.normalizedUnit }),
    ...(attribute.normalizedBoolean === null
      ? {}
      : { normalizedBoolean: attribute.normalizedBoolean }),
    ...(attribute.normalizedDate === null
      ? {}
      : { normalizedDate: attribute.normalizedDate.toISOString() }),
    ...(attribute.componentAxis === null ? {} : { componentAxis: attribute.componentAxis }),
    position: attribute.position,
    normalizationState: attribute.normalizationState,
    selectionState: attribute.selectionState,
  }));

  const fieldProvenance: FieldProvenance[] = [];
  for (const provenance of provenanceRows) {
    fieldProvenance.push({
      field: provenance.field,
      method: provenance.method,
      ...(provenance.confidence === null ? {} : { confidence: provenance.confidence }),
      selectedAt: provenance.selectedAt.toISOString(),
      ...(await recordFreshness(db, provenance.sourceRecordId).then((value) =>
        value === undefined ? {} : { freshness: value },
      )),
    });
  }

  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.brandId === null ? {} : { brandId: row.brandId }),
    ...(row.familyId === null ? {} : { familyId: row.familyId }),
    ...(row.categoryId === null ? {} : { categoryId: row.categoryId }),
    ...(row.releasedAt === null ? {} : { releasedAt: row.releasedAt.toISOString() }),
    ...(row.discontinuedAt === null ? {} : { discontinuedAt: row.discontinuedAt.toISOString() }),
    ...(row.modelYear === null ? {} : { modelYear: row.modelYear }),
    ...(row.modelCode === null ? {} : { modelCode: row.modelCode }),
    aliases: aliases.map((alias) => ({
      alias: alias.alias,
      kind: alias.kind,
      ...(alias.language === null ? {} : { language: alias.language }),
    })),
    searchTokens: row.searchTokens,
    variantDefiningAttributeKeys: row.variantDefiningAttributeKeys,
    images,
    attributes,
    identifiers: identifierRows
      .filter((identifier) => isPubliclyVisibleIdentifier(identifier.status))
      .map((identifier) => ({
        id: identifier.id,
        scheme: identifier.scheme,
        rawValue: identifier.rawValue,
        normalizedValue: identifier.normalizedValue,
        ...(identifier.canonicalScheme === null
          ? {}
          : { canonicalScheme: identifier.canonicalScheme }),
        ...(identifier.canonicalValue === null ? {} : { canonicalValue: identifier.canonicalValue }),
        status: identifier.status,
        grain: 'product' as const,
      })),
    fieldProvenance,
    rating: row.rating,
    ratingCount: row.ratingCount,
    variantCount: row.variantCount,
    ...(row.mergedIntoId === null ? {} : { mergedIntoId: row.mergedIntoId }),
    firstSeenAt: row.firstSeenAt.toISOString(),
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt.toISOString() }),
    ...(freshness === undefined ? {} : { freshness }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The options a variant carries, for a caller assembling a product page. */
export async function getVariantOptionAssignments(
  variantId: string,
): Promise<{ key: string; displayValue: string; normalizedValue: string; position: number }[]> {
  const rows = await listVariantOptions(variantId);
  return rows.map((row) => ({
    key: row.attributeKey,
    displayValue: row.displayValue,
    normalizedValue: row.normalizedValue,
    position: row.position,
  }));
}
