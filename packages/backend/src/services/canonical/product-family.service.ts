/**
 * Product families: the brand's LINE that groups comparable products (#56
 * family rules 1–7, ADR 0002 D2/D13/D16).
 *
 * ## Nothing here creates a family from a source
 *
 * There is deliberately no `applyFamilySourceObservation` that MINTS one. #56
 * states it plainly — "a family must not be created merely because two source
 * titles share a word" — and the mechanical form of that rule is that the only
 * way a family comes into existence is {@link createProductFamily}, called with
 * an explicit name by an operator or by a backfill that decided to. Source
 * observations attach to a family that already exists
 * ({@link applyFamilySourceObservation}) and can never conjure one.
 *
 * `searchProductFamilyCandidates` exists for the same reason as its brand
 * counterpart: it RETURNS candidates and writes nothing at all. A name match is
 * evidence for review, never an identity.
 */

import { isUniqueViolation } from '@oxyhq/db';
import type {
  CanonicalAlias,
  PaginatedResponse,
  ProductFamily,
  SourceFreshness,
  SourceLinkMethod,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findProductFamiliesByIds,
  findProductFamiliesByNormalizedName,
  findProductFamilyById,
  findProductFamilyBySlug,
  findProductFamilyIdsByNormalizedAlias,
  insertProductFamily,
  insertProductFamilyAlias,
  insertProductFamilySourceLink,
  listProductFamiliesPage,
  listProductFamilyAliases,
  listProductFamilySourceLinks,
  searchProductFamiliesByNameSimilarity,
  updateProductFamily as updateFamilyRow,
  type ProductFamilyRow,
} from '../../db/canonical/productFamilyRepository.js';
import {
} from '../../db/canonical/canonicalProductRepository.js';
import { recordFieldProvenance } from '../../db/canonical/attributeRepository.js';
import {
  findCatalogSourceById,
  findSourceRecordsByIds,
  recordSourceObservation,
} from '../../db/canonical/provenanceRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { contentHashOf, type JsonValue } from './content-hash.js';
import { normalizeAliasLookup, normalizeEntityName, slugFromName } from './normalization.js';

const MAX_MERGE_HOPS = 10;
const MIN_SIMILARITY = 0.3;

async function resolveFamilyRow(
  db: DatabaseOrTransaction,
  row: ProductFamilyRow,
): Promise<ProductFamilyRow> {
  let current = row;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    if (current.status !== 'merged' || !current.mergedIntoId) return current;
    const next = await findProductFamilyById(db, current.mergedIntoId);
    if (!next) {
      throw new Error(
        `Product family ${current.id} redirects to missing family ${current.mergedIntoId}.`,
      );
    }
    current = next;
  }
  throw new Error(`Product family merge chain exceeds ${MAX_MERGE_HOPS} hops from ${row.id}.`);
}

export interface CreateProductFamilyInput {
  name: string;
  slug?: string;
  description?: string;
  /** The brand this line is marketed under. Absent for a generic line. */
  brandId?: string;
  categoryId?: string;
  aliases?: { alias: string; kind: CanonicalAlias['kind']; language?: string }[];
  actorOxyUserId?: string;
}

export async function createProductFamily(
  input: CreateProductFamilyInput,
): Promise<ProductFamilyRow> {
  const name = input.name.trim();
  if (name.length === 0) throw validationError('createProductFamily: name must be non-empty.');
  const normalizedName = normalizeEntityName(name);
  if (normalizedName.length === 0) {
    throw validationError(`createProductFamily: name '${name}' has no normalizable content.`);
  }
  const slug = input.slug ?? slugFromName(name);
  if (!slug) throw validationError(`createProductFamily: cannot derive a slug from '${name}'.`);

  try {
    return await getDb().transaction(async (tx) => {
      const family = await insertProductFamily(tx, {
        slug,
        name,
        normalizedName,
        description: input.description ?? null,
        brandId: input.brandId ?? null,
        categoryId: input.categoryId ?? null,
      });
      await insertProductFamilyAlias(tx, {
        familyId: family.id,
        alias: name,
        kind: 'name_variant',
        ...(input.actorOxyUserId === undefined
          ? {}
          : { createdByOxyUserId: input.actorOxyUserId }),
      });
      for (const alias of input.aliases ?? []) {
        await insertProductFamilyAlias(tx, {
          familyId: family.id,
          alias: alias.alias,
          kind: alias.kind,
          ...(alias.language === undefined ? {} : { language: alias.language }),
          ...(input.actorOxyUserId === undefined
            ? {}
            : { createdByOxyUserId: input.actorOxyUserId }),
        });
      }
      return family;
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error, 'canonical_product_families_slug_key')) {
      throw conflict(`A product family with slug '${slug}' already exists.`);
    }
    throw error;
  }
}

export interface UpdateProductFamilyInput {
  name?: string;
  description?: string;
  brandId?: string;
  categoryId?: string;
  status?: Exclude<ProductFamilyRow['status'], 'merged'>;
  actorOxyUserId: string;
}

/** An OPERATOR update; every touched field is PINNED against source re-application. */
export async function updateProductFamily(
  familyId: string,
  input: UpdateProductFamilyInput,
): Promise<ProductFamilyRow> {
  return getDb().transaction(async (tx) => {
    const family = await findProductFamilyById(tx, familyId);
    if (!family) throw notFound(`Product family ${familyId} does not exist.`);
    if (family.status === 'merged') {
      throw conflict(
        `Product family ${familyId} is merged into ${String(family.mergedIntoId)}; update the winner.`,
      );
    }

    const patch: Parameters<typeof updateFamilyRow>[2] = {};
    const pinned = new Set(family.pinnedFields);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) throw validationError('updateProductFamily: name must be non-empty.');
      const normalizedName = normalizeEntityName(name);
      if (normalizedName.length === 0) {
        throw validationError(`updateProductFamily: name '${name}' has no normalizable content.`);
      }
      if (name !== family.name) {
        patch.name = name;
        patch.normalizedName = normalizedName;
        pinned.add('name');
        await insertProductFamilyAlias(tx, {
          familyId,
          alias: family.name,
          kind: 'former_name',
          createdByOxyUserId: input.actorOxyUserId,
        });
        await insertProductFamilyAlias(tx, {
          familyId,
          alias: name,
          kind: 'name_variant',
          createdByOxyUserId: input.actorOxyUserId,
        });
      }
    }
    if (input.description !== undefined) {
      patch.description = input.description;
      pinned.add('description');
    }
    if (input.brandId !== undefined) {
      patch.brandId = input.brandId;
      pinned.add('brandId');
    }
    if (input.categoryId !== undefined) {
      patch.categoryId = input.categoryId;
      pinned.add('categoryId');
    }
    if (input.status !== undefined) patch.status = input.status;

    patch.pinnedFields = [...pinned].sort();
    patch.lastReviewedAt = new Date();
    const updated = await updateFamilyRow(tx, familyId, patch);
    if (!updated) throw notFound(`Product family ${familyId} does not exist.`);
    return updated;
  });
}

export interface ApplyFamilySourceObservationInput {
  familyId: string;
  sourceId: string;
  externalId: string;
  observedAt: Date;
  staleAt?: Date;
  method: SourceLinkMethod;
  matchRule: string;
  confidence?: number;
  decidedByOxyUserId?: string;
  fields: { name?: string; description?: string };
}

export interface ApplyFamilySourceObservationResult {
  family: ProductFamilyRow;
  sourceRecordId: string;
  newObservation: boolean;
  applied: string[];
  conflicts: { field: string; reason: 'pinned' | 'lower_confidence' | 'conflicting_name' }[];
}

/**
 * Attach one source observation to an EXISTING family.
 *
 * There is no branch here that creates a family, deliberately (see the module
 * header). A source that names a line Mercaria does not have is a candidate for
 * review, not a row.
 */
export async function applyFamilySourceObservation(
  input: ApplyFamilySourceObservationInput,
): Promise<ApplyFamilySourceObservationResult> {
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw validationError('applyFamilySourceObservation: confidence must be within [0, 1].');
  }
  return getDb().transaction(async (tx) => {
    const loaded = await findProductFamilyById(tx, input.familyId);
    if (!loaded) throw notFound(`Product family ${input.familyId} does not exist.`);
    const family = await resolveFamilyRow(tx, loaded);

    const source = await findCatalogSourceById(tx, input.sourceId);
    if (!source) throw notFound(`Catalog source ${input.sourceId} does not exist.`);

    const payload: JsonValue = {
      ...(input.fields.name === undefined ? {} : { name: input.fields.name }),
      ...(input.fields.description === undefined
        ? {}
        : { description: input.fields.description }),
    };
    const { record, inserted } = await recordSourceObservation(tx, {
      sourceId: input.sourceId,
      externalType: 'product',
      externalId: input.externalId,
      observedAt: input.observedAt,
      ...(input.staleAt === undefined ? {} : { staleAt: input.staleAt }),
      contentHash: contentHashOf(payload),
      ...(source.mayStore ? { payload } : {}),
    });

    const activeLinks = await listProductFamilySourceLinks(tx, family.id, 'active');
    const existingStrength = activeLinks
      .filter((link) => link.sourceRecordId !== record.id)
      .reduce((max, link) => Math.max(max, link.confidence ?? 1), 0);

    await insertProductFamilySourceLink(tx, {
      familyId: family.id,
      sourceRecordId: record.id,
      method: input.method,
      matchRule: input.matchRule,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.decidedByOxyUserId === undefined
        ? {}
        : { decidedByOxyUserId: input.decidedByOxyUserId }),
    });

    const incomingStrength = input.confidence ?? 1;
    const pinned = new Set(family.pinnedFields);
    const applied: string[] = [];
    const conflicts: ApplyFamilySourceObservationResult['conflicts'] = [];
    const patch: Parameters<typeof updateFamilyRow>[2] = {};

    if (input.fields.name !== undefined) {
      const sourceName = input.fields.name.trim();
      if (
        sourceName.length > 0 &&
        normalizeAliasLookup(sourceName) !== normalizeAliasLookup(family.name)
      ) {
        await insertProductFamilyAlias(tx, {
          familyId: family.id,
          alias: sourceName,
          kind: 'name_variant',
          sourceRecordId: record.id,
        });
        conflicts.push({ field: 'name', reason: 'conflicting_name' });
      }
    }

    if (
      input.fields.description !== undefined &&
      input.fields.description !== family.description
    ) {
      if (pinned.has('description')) {
        conflicts.push({ field: 'description', reason: 'pinned' });
      } else if (family.description !== null && incomingStrength < existingStrength) {
        conflicts.push({ field: 'description', reason: 'lower_confidence' });
      } else {
        patch.description = input.fields.description;
        applied.push('description');
      }
    }

    patch.lastSeenAt =
      family.lastSeenAt && family.lastSeenAt > input.observedAt
        ? family.lastSeenAt
        : input.observedAt;
    if (input.observedAt < family.firstSeenAt) patch.firstSeenAt = input.observedAt;

    const updated = await updateFamilyRow(tx, family.id, patch);
    if (!updated) throw new Error(`Product family ${family.id} vanished mid-transaction.`);

    for (const field of applied) {
      await recordFieldProvenance(tx, {
        grain: { kind: 'family', id: family.id },
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

    return { family: updated, sourceRecordId: record.id, newObservation: inserted, applied, conflicts };
  });
}

/** One candidate a search produced — evidence for review, never a merge. */
export interface ProductFamilyCandidate {
  familyId: string;
  slug: string;
  name: string;
  brandId: string | null;
  score: number;
  matchedVia: 'normalized_name' | 'alias' | 'name_similarity';
}

/**
 * Candidate generation, optionally narrowed to a brand.
 *
 * The brand narrowing is the useful half in practice: "Galaxy" under Samsung is
 * a strong candidate; "Galaxy" across the whole catalogue is a word.
 */
export async function searchProductFamilyCandidates(
  name: string,
  options: { brandId?: string; limit?: number } = {},
): Promise<ProductFamilyCandidate[]> {
  const limit = options.limit ?? 10;
  const normalized = normalizeEntityName(name);
  if (normalized.length === 0) return [];
  const db = getDb();

  const byId = new Map<string, ProductFamilyCandidate>();
  const offer = async (
    row: ProductFamilyRow,
    score: number,
    matchedVia: ProductFamilyCandidate['matchedVia'],
  ): Promise<void> => {
    const resolved = await resolveFamilyRow(db, row);
    if (options.brandId !== undefined && resolved.brandId !== options.brandId) return;
    const existing = byId.get(resolved.id);
    if (existing && existing.score >= score) return;
    byId.set(resolved.id, {
      familyId: resolved.id,
      slug: resolved.slug,
      name: resolved.name,
      brandId: resolved.brandId,
      score,
      matchedVia,
    });
  };

  for (const row of await findProductFamiliesByNormalizedName(db, normalized)) {
    await offer(row, 1, 'normalized_name');
  }
  const aliasIds = await findProductFamilyIdsByNormalizedAlias(db, normalizeAliasLookup(name));
  for (const row of await findProductFamiliesByIds(db, aliasIds)) {
    await offer(row, 1, 'alias');
  }
  for (const { family, similarity } of await searchProductFamiliesByNameSimilarity(
    db,
    normalized,
    limit,
  )) {
    if (similarity < MIN_SIMILARITY) continue;
    await offer(family, similarity, 'name_similarity');
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

async function familyFreshness(
  db: DatabaseOrTransaction,
  familyId: string,
): Promise<SourceFreshness | undefined> {
  const links = await listProductFamilySourceLinks(db, familyId, 'active');
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

/** The live family an id or slug resolves to — a tombstone answers with its winner. */
export async function resolveProductFamily(
  idOrSlug: string,
): Promise<ProductFamilyRow | undefined> {
  const db = getDb();
  const row =
    (await findProductFamilyById(db, idOrSlug)) ?? (await findProductFamilyBySlug(db, idOrSlug));
  if (!row) return undefined;
  return resolveFamilyRow(db, row);
}

/** The public read projection: verified facts plus safe source freshness. */
export async function getPublicProductFamily(
  idOrSlug: string,
): Promise<ProductFamily | undefined> {
  const db = getDb();
  const row = await resolveProductFamily(idOrSlug);
  if (!row) return undefined;
  return toPublicProductFamily(db, row);
}

export async function listPublicProductFamilies(
  page = 1,
  limit = 20,
): Promise<PaginatedResponse<ProductFamily>> {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const db = getDb();
  const { rows, total } = await listProductFamiliesPage(db, (safePage - 1) * safeLimit, safeLimit);
  const data: ProductFamily[] = [];
  for (const row of rows) data.push(await toPublicProductFamily(db, row));
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

async function toPublicProductFamily(
  db: DatabaseOrTransaction,
  row: ProductFamilyRow,
): Promise<ProductFamily> {
  const aliases = await listProductFamilyAliases(db, row.id);
  const freshness = await familyFreshness(db, row.id);
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.brandId === null ? {} : { brandId: row.brandId }),
    ...(row.categoryId === null ? {} : { categoryId: row.categoryId }),
    aliases: aliases.map((alias) => ({
      alias: alias.alias,
      kind: alias.kind,
      ...(alias.language === null ? {} : { language: alias.language }),
    })),
    productCount: row.productCount,
    ...(row.mergedIntoId === null ? {} : { mergedIntoId: row.mergedIntoId }),
    firstSeenAt: row.firstSeenAt.toISOString(),
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt.toISOString() }),
    ...(freshness === undefined ? {} : { freshness }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
