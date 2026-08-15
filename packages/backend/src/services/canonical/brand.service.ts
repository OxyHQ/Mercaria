/**
 * The brand write, matching and read surface (#53).
 *
 * INTERNAL services only — create, update, source-upsert, candidate search,
 * reverse lookup, merge, and the public-DTO projection. No HTTP route mounts
 * any of this yet; the read surfaces (#70–#73) and the review tooling (#59)
 * arrive with their own issues against these seams.
 *
 * ## The identity rules, and where each is enforced
 *
 * - **A matching name never merges** (#53 rule 1): this file cannot merge at
 *   all — candidate search and alias resolution only RETURN candidates, and
 *   #56's direct `mergeBrands` was retired with the rest of the pre-#59 merges
 *   (#36 completion criterion 4). A merge is a curation JOB
 *   (`POST /internal/commerce-graph/merge-jobs`), which names both ids, an
 *   actor, an impact estimate and a conflict decision per collision.
 * - **Canonical data is never overwritten by a lower-confidence source**
 *   (rule 5): {@link applyBrandSourceObservation} compares the incoming
 *   observation's confidence (NULL = deterministic/human = highest, ADR 0002
 *   D19) against the strongest ACTIVE link already supporting the brand, and a
 *   weaker source's differing value becomes a CONFLICT entry, not a write.
 * - **Source aliases survive canonical selection** (rule 4): a source name that
 *   differs from the canonical one is minted as an alias citing its record —
 *   the canonical `name` is never source-overwritten at all; a name conflict is
 *   review input (rule 6).
 * - **Merges create redirects and retain source mappings** (rule 7): the loser
 *   becomes a tombstone (`status='merged'`, `mergedIntoId`), its slug is never
 *   reused, every source link is repointed (superseded where the winner already
 *   actively links the same record — never deleted), and chain flattening keeps
 *   resolution one hop (ADR 0002 D12/D16).
 *
 * The `catalog_revisions` ledger entry a merge/correction owes belongs to #59,
 * which owns that table; until it lands, the durable audit of a merge is the
 * tombstone, the repointed links and the minted `former_name` alias.
 */

import { isUniqueViolation } from '@oxyhq/db';
import type {
  AliasResolution,
  Brand,
  CanonicalAlias,
  PaginatedResponse,
  SourceFreshness,
  SourceLinkMethod,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findBrandById,
  findBrandBySlug,
  findBrandIdsByNormalizedAlias,
  findBrandIdsBySourceRecordIds,
  findBrandsByIds,
  findBrandsByNormalizedName,
  insertBrand,
  insertBrandAlias,
  insertBrandSourceLink,
  listBrandAliases,
  listBrandsPage,
  listBrandSourceLinks,
  searchBrandsByNameSimilarity,
  updateBrand as updateBrandRow,
  type BrandRow,
} from '../../db/canonical/brandRepository.js';
import {
  findCatalogSourceById,
  findSourceRecordsByIds,
  listSourceRecordsForObject,
  recordSourceObservation,
} from '../../db/canonical/provenanceRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { contentHashOf, type JsonValue } from './content-hash.js';
import {
  normalizeAliasLookup,
  normalizeDomain,
  normalizeEntityName,
  slugFromName,
} from './normalization.js';

/** How many redirect hops resolution tolerates before calling the data corrupt.
 * The flatten-on-write invariant makes every chain one hop; this bound exists so
 * corruption surfaces as an error rather than an infinite loop. */
const MAX_MERGE_HOPS = 10;

/** Trigram scores below this are noise, not candidates. On pg_trgm's 0–1 scale. */
const MIN_SIMILARITY = 0.3;

/**
 * Follow `mergedIntoId` to the live row. One hop by invariant; bounded anyway.
 */
async function resolveBrandRow(db: DatabaseOrTransaction, row: BrandRow): Promise<BrandRow> {
  let current = row;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    if (current.status !== 'merged' || !current.mergedIntoId) return current;
    const next = await findBrandById(db, current.mergedIntoId);
    if (!next) throw new Error(`Brand ${current.id} redirects to missing brand ${current.mergedIntoId}.`);
    current = next;
  }
  throw new Error(`Brand merge chain exceeds ${MAX_MERGE_HOPS} hops from ${row.id}.`);
}

export interface CreateBrandInput {
  name: string;
  /** Defaults to `slugFromName(name)`. A collision is a conflict, never auto-suffixed. */
  slug?: string;
  description?: string;
  websiteUrl?: string;
  /** Domain observations; normalized, invalid entries refused. */
  observedDomains?: string[];
  logoFileId?: string;
  /** Additional aliases to mint beside the canonical name's own. */
  aliases?: { alias: string; kind: CanonicalAlias['kind']; language?: string }[];
  actorOxyUserId?: string;
}

/**
 * Mint a brand. The canonical name always gets its own `name_variant` alias
 * row, so alias resolution has ONE lookup space — an entity is findable by
 * every name it has ever carried, its canonical one included.
 */
export async function createBrand(input: CreateBrandInput): Promise<BrandRow> {
  const name = input.name.trim();
  if (name.length === 0) throw validationError('createBrand: name must be a non-empty string.');
  const normalizedName = normalizeEntityName(name);
  if (normalizedName.length === 0) {
    throw validationError(`createBrand: name '${name}' has no normalizable content.`);
  }
  const slug = input.slug ?? slugFromName(name);
  if (!slug) throw validationError(`createBrand: cannot derive a slug from '${name}'.`);

  const observedDomains = normalizeDomainSet(input.observedDomains ?? []);

  try {
    return await getDb().transaction(async (tx) => {
      const brand = await insertBrand(tx, {
        slug,
        name,
        normalizedName,
        description: input.description ?? null,
        websiteUrl: input.websiteUrl ?? null,
        observedDomains,
        logoFileId: input.logoFileId ?? null,
      });
      await insertBrandAlias(tx, {
        brandId: brand.id,
        alias: name,
        kind: 'name_variant',
        ...(input.actorOxyUserId === undefined ? {} : { createdByOxyUserId: input.actorOxyUserId }),
      });
      for (const alias of input.aliases ?? []) {
        await insertBrandAlias(tx, {
          brandId: brand.id,
          alias: alias.alias,
          kind: alias.kind,
          ...(alias.language === undefined ? {} : { language: alias.language }),
          ...(input.actorOxyUserId === undefined
            ? {}
            : { createdByOxyUserId: input.actorOxyUserId }),
        });
      }
      return brand;
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error, 'brands_slug_key')) {
      throw conflict(`A brand with slug '${slug}' already exists.`);
    }
    throw error;
  }
}

export interface UpdateBrandInput {
  name?: string;
  description?: string;
  websiteUrl?: string;
  logoFileId?: string;
  /** `merged` is refused — a merge is a #59 curation job, never a field write. */
  status?: 'active' | 'inactive' | 'suppressed';
  actorOxyUserId: string;
}

/**
 * An OPERATOR update. Every field it touches is PINNED (`pinnedFields`, the
 * `listings.overriddenFields` precedent) so ingestion respects the correction
 * on every subsequent apply — and a rename keeps the old name reachable as a
 * `former_name` alias (ADR 0002 D12: history is pointers, not lost names).
 */
export async function updateBrand(brandId: string, input: UpdateBrandInput): Promise<BrandRow> {
  return getDb().transaction(async (tx) => {
    const brand = await findBrandById(tx, brandId);
    if (!brand) throw notFound(`Brand ${brandId} does not exist.`);
    if (brand.status === 'merged') {
      throw conflict(`Brand ${brandId} is merged into ${String(brand.mergedIntoId)}; update the winner.`);
    }

    const patch: Parameters<typeof updateBrandRow>[2] = {};
    const pinned = new Set(brand.pinnedFields);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) throw validationError('updateBrand: name must be non-empty.');
      const normalizedName = normalizeEntityName(name);
      if (normalizedName.length === 0) {
        throw validationError(`updateBrand: name '${name}' has no normalizable content.`);
      }
      if (name !== brand.name) {
        patch.name = name;
        patch.normalizedName = normalizedName;
        pinned.add('name');
        await insertBrandAlias(tx, {
          brandId,
          alias: brand.name,
          kind: 'former_name',
          createdByOxyUserId: input.actorOxyUserId,
        });
        await insertBrandAlias(tx, {
          brandId,
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
    if (input.websiteUrl !== undefined) {
      patch.websiteUrl = input.websiteUrl;
      pinned.add('websiteUrl');
    }
    if (input.logoFileId !== undefined) {
      patch.logoFileId = input.logoFileId;
      patch.logoSourceRecordId = null;
      pinned.add('logoFileId');
    }
    if (input.status !== undefined) patch.status = input.status;

    patch.pinnedFields = [...pinned].sort();
    patch.lastReviewedAt = new Date();
    const updated = await updateBrandRow(tx, brandId, patch);
    if (!updated) throw notFound(`Brand ${brandId} does not exist.`);
    return updated;
  });
}

/** One field the observation could not apply, and the reason it is review input. */
export interface SourceFieldConflict {
  field: string;
  reason: 'pinned' | 'lower_confidence' | 'conflicting_name' | 'invalid_domain';
  /** The value the source asserted, for the reviewer. */
  sourceValue: string;
}

export interface ApplyBrandSourceObservationInput {
  brandId: string;
  sourceId: string;
  /** The source's own id for the observed object. */
  externalId: string;
  observedAt: Date;
  staleAt?: Date;
  method: SourceLinkMethod;
  /** The explainable rule id that matched this observation to this brand. */
  matchRule: string;
  /** 0–1; omit for a deterministic or human decision (treated as strongest). */
  confidence?: number;
  decidedByOxyUserId?: string;
  /** What the source asserted about the brand. */
  fields: {
    name?: string;
    description?: string;
    websiteUrl?: string;
    logoFileId?: string;
    domains?: string[];
  };
}

export interface ApplyBrandSourceObservationResult {
  brand: BrandRow;
  sourceRecordId: string;
  /** `false` when identical content had already been observed. */
  newObservation: boolean;
  /** Field names actually written. */
  applied: string[];
  /** What was NOT applied, and why — the review path's input (#53 rule 6). */
  conflicts: SourceFieldConflict[];
}

/**
 * The source-upsert: record the observation, link it, apply what the rules
 * allow — ONE transaction (ADR 0002 D22), so a crash cannot leave applied
 * fields with no provenance behind them. That transactional pairing is what
 * makes acceptance criterion 2 ("every imported field traces to a source
 * record") structural: there is no code path that writes a source-supplied
 * field without its record and link committing beside it.
 *
 * A repeat of identical content converges: the record insert no-ops on its
 * content hash, the link insert no-ops on its active partial unique, and the
 * field application re-derives the same values.
 */
export async function applyBrandSourceObservation(
  input: ApplyBrandSourceObservationInput,
): Promise<ApplyBrandSourceObservationResult> {
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw validationError('applyBrandSourceObservation: confidence must be within [0, 1].');
  }
  return getDb().transaction(async (tx) => {
    const loaded = await findBrandById(tx, input.brandId);
    if (!loaded) throw notFound(`Brand ${input.brandId} does not exist.`);
    // A late observation for a tombstone belongs to its winner — mappings moved
    // in the merge, and new ones follow them.
    const brand = await resolveBrandRow(tx, loaded);

    const source = await findCatalogSourceById(tx, input.sourceId);
    if (!source) throw notFound(`Catalog source ${input.sourceId} does not exist.`);

    const domainInput = input.fields.domains ?? [];
    const conflicts: SourceFieldConflict[] = [];
    const validDomains: string[] = [];
    for (const raw of domainInput) {
      const domain = normalizeDomain(raw);
      if (domain === null) conflicts.push({ field: 'domains', reason: 'invalid_domain', sourceValue: raw });
      else validDomains.push(domain);
    }

    const payload: JsonValue = {
      ...(input.fields.name === undefined ? {} : { name: input.fields.name }),
      ...(input.fields.description === undefined ? {} : { description: input.fields.description }),
      ...(input.fields.websiteUrl === undefined ? {} : { websiteUrl: input.fields.websiteUrl }),
      ...(input.fields.logoFileId === undefined ? {} : { logoFileId: input.fields.logoFileId }),
      ...(domainInput.length === 0 ? {} : { domains: [...domainInput].sort() }),
    };

    const { record, inserted } = await recordSourceObservation(tx, {
      sourceId: input.sourceId,
      externalType: 'brand',
      externalId: input.externalId,
      observedAt: input.observedAt,
      ...(input.staleAt === undefined ? {} : { staleAt: input.staleAt }),
      contentHash: contentHashOf(payload),
      // Storage is a RIGHT of the source, not a given (ADR 0002 D19).
      ...(source.mayStore ? { payload } : {}),
    });

    // The strongest support the brand already has, BEFORE this link joins it —
    // what "lower-confidence" is measured against. NULL confidence means a
    // deterministic or human decision and outranks every number.
    const activeLinks = await listBrandSourceLinks(tx, brand.id, 'active');
    const existingStrength = activeLinks
      .filter((link) => link.sourceRecordId !== record.id)
      .reduce((max, link) => Math.max(max, link.confidence ?? 1), 0);

    await insertBrandSourceLink(tx, {
      brandId: brand.id,
      sourceRecordId: record.id,
      method: input.method,
      matchRule: input.matchRule,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.decidedByOxyUserId === undefined
        ? {}
        : { decidedByOxyUserId: input.decidedByOxyUserId }),
    });

    const incomingStrength = input.confidence ?? 1;
    const pinned = new Set(brand.pinnedFields);
    const applied: string[] = [];
    const patch: Parameters<typeof updateBrandRow>[2] = {};

    // The canonical name is NEVER source-overwritten: a differing source name
    // becomes an alias (kept forever, rule 4) plus a review conflict (rule 6).
    if (input.fields.name !== undefined) {
      const sourceName = input.fields.name.trim();
      if (sourceName.length > 0 && normalizeAliasLookup(sourceName) !== normalizeAliasLookup(brand.name)) {
        await insertBrandAlias(tx, {
          brandId: brand.id,
          alias: sourceName,
          kind: 'name_variant',
          sourceRecordId: record.id,
        });
        conflicts.push({ field: 'name', reason: 'conflicting_name', sourceValue: sourceName });
      }
    }

    const scalarFields: {
      field: 'description' | 'websiteUrl' | 'logoFileId';
      value: string | undefined;
      current: string | null;
    }[] = [
      { field: 'description', value: input.fields.description, current: brand.description },
      { field: 'websiteUrl', value: input.fields.websiteUrl, current: brand.websiteUrl },
      { field: 'logoFileId', value: input.fields.logoFileId, current: brand.logoFileId },
    ];
    for (const { field, value, current } of scalarFields) {
      if (value === undefined || value === current) continue;
      if (pinned.has(field)) {
        conflicts.push({ field, reason: 'pinned', sourceValue: value });
        continue;
      }
      // Filling absence is not overwriting; replacing a value needs at least
      // the strength of what put it there (#53 rule 5).
      if (current !== null && incomingStrength < existingStrength) {
        conflicts.push({ field, reason: 'lower_confidence', sourceValue: value });
        continue;
      }
      patch[field] = value;
      if (field === 'logoFileId') patch.logoSourceRecordId = record.id;
      applied.push(field);
    }

    // Domain OBSERVATIONS accumulate — a union, never a replacement, and never
    // ownership proof (#53 brand rule 5).
    const newDomains = validDomains.filter((domain) => !brand.observedDomains.includes(domain));
    if (newDomains.length > 0) {
      patch.observedDomains = [...brand.observedDomains, ...newDomains].sort();
      applied.push('observedDomains');
    }

    patch.lastSeenAt =
      brand.lastSeenAt && brand.lastSeenAt > input.observedAt ? brand.lastSeenAt : input.observedAt;
    if (input.observedAt < brand.firstSeenAt) patch.firstSeenAt = input.observedAt;

    const updated = await updateBrandRow(tx, brand.id, patch);
    if (!updated) throw new Error(`Brand ${brand.id} vanished mid-transaction.`);

    return {
      brand: updated,
      sourceRecordId: record.id,
      newObservation: inserted,
      applied,
      conflicts,
    };
  });
}

/**
 * Reverse lookup by name/alias: ONE canonical id or an explicit ambiguity
 * (#53 acceptance 3). The lookup space is the alias tables' generated
 * normalization; redirects are followed so a tombstone's name resolves to its
 * winner.
 */
export async function resolveBrandAlias(name: string): Promise<AliasResolution> {
  const lookup = normalizeAliasLookup(name);
  if (lookup.length === 0) return { kind: 'none' };
  const db = getDb();

  const ids = await findBrandIdsByNormalizedAlias(db, lookup);
  const rows = await findBrandsByIds(db, ids);
  const finalIds = new Set<string>();
  for (const row of rows) {
    finalIds.add((await resolveBrandRow(db, row)).id);
  }

  if (finalIds.size === 0) return { kind: 'none' };
  if (finalIds.size === 1) {
    const [id] = finalIds;
    if (id === undefined) return { kind: 'none' };
    return { kind: 'resolved', id };
  }
  return { kind: 'ambiguous', candidateIds: [...finalIds].sort() };
}

/** One candidate a search produced — evidence for review, never a merge. */
export interface BrandCandidate {
  brandId: string;
  slug: string;
  name: string;
  status: BrandRow['status'];
  /** 1 for an exact normalized match; pg_trgm similarity otherwise. */
  score: number;
  matchedVia: 'normalized_name' | 'alias' | 'name_similarity';
}

/**
 * Candidate generation (#53 identity rule 3): exact normalized-name matches,
 * exact alias matches, then trigram similarity — original display names
 * untouched throughout. Returns candidates and NOTHING else happens: no merge,
 * no link, no write (acceptance 1 is pinned on exactly this property).
 */
export async function searchBrandCandidates(name: string, limit = 10): Promise<BrandCandidate[]> {
  const normalized = normalizeEntityName(name);
  if (normalized.length === 0) return [];
  const db = getDb();

  const byId = new Map<string, BrandCandidate>();
  const offer = async (row: BrandRow, score: number, matchedVia: BrandCandidate['matchedVia']) => {
    const resolved = await resolveBrandRow(db, row);
    const existing = byId.get(resolved.id);
    if (existing && existing.score >= score) return;
    byId.set(resolved.id, {
      brandId: resolved.id,
      slug: resolved.slug,
      name: resolved.name,
      status: resolved.status,
      score,
      matchedVia,
    });
  };

  for (const row of await findBrandsByNormalizedName(db, normalized)) {
    await offer(row, 1, 'normalized_name');
  }
  const aliasIds = await findBrandIdsByNormalizedAlias(db, normalizeAliasLookup(name));
  for (const row of await findBrandsByIds(db, aliasIds)) {
    await offer(row, 1, 'alias');
  }
  for (const { brand, similarity } of await searchBrandsByNameSimilarity(db, normalized, limit)) {
    if (similarity < MIN_SIMILARITY) continue;
    await offer(brand, similarity, 'name_similarity');
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Reverse lookup from a source's own id: which brands do observations of this
 * external object support? Walks every observation of the object, so a link
 * made against an older revision still resolves.
 */
export async function findBrandIdsBySourceObject(
  sourceId: string,
  externalId: string,
): Promise<string[]> {
  const db = getDb();
  const records = await listSourceRecordsForObject(db, sourceId, 'brand', externalId);
  const ids = await findBrandIdsBySourceRecordIds(
    db,
    records.map((record) => record.id),
  );
  const finalIds = new Set<string>();
  for (const row of await findBrandsByIds(db, ids)) {
    finalIds.add((await resolveBrandRow(db, row)).id);
  }
  return [...finalIds].sort();
}

/** Build the safe freshness projection from the entity's active links. */
async function brandFreshness(
  db: DatabaseOrTransaction,
  brandId: string,
): Promise<SourceFreshness | undefined> {
  const links = await listBrandSourceLinks(db, brandId, 'active');
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

/**
 * The public read projection: verified facts plus safe source freshness (#53
 * API rule 2). Internal state — link confidences, match rules, pinned fields,
 * source ids — is structurally absent from the return type.
 */
export async function getPublicBrand(idOrSlug: string): Promise<Brand | undefined> {
  const db = getDb();
  const row = (await findBrandById(db, idOrSlug)) ?? (await findBrandBySlug(db, idOrSlug));
  if (!row) return undefined;
  return toPublicBrand(db, row);
}

/** Offset-paginated brand list — the pagination seam #70–#73 read through. */
export async function listPublicBrands(page = 1, limit = 20): Promise<PaginatedResponse<Brand>> {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const db = getDb();
  const { rows, total } = await listBrandsPage(db, (safePage - 1) * safeLimit, safeLimit);
  const data: Brand[] = [];
  for (const row of rows) data.push(await toPublicBrand(db, row));
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

async function toPublicBrand(db: DatabaseOrTransaction, row: BrandRow): Promise<Brand> {
  const aliases = await listBrandAliases(db, row.id);
  const freshness = await brandFreshness(db, row.id);
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.websiteUrl === null ? {} : { websiteUrl: row.websiteUrl }),
    observedDomains: row.observedDomains,
    ...(row.logoFileId === null ? {} : { logoFileId: row.logoFileId }),
    aliases: aliases.map((alias) => ({
      alias: alias.alias,
      kind: alias.kind,
      ...(alias.language === null ? {} : { language: alias.language }),
    })),
    ...(row.mergedIntoId === null ? {} : { mergedIntoId: row.mergedIntoId }),
    productCount: row.productCount,
    activeOfferCount: row.activeOfferCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt.toISOString() }),
    ...(freshness === undefined ? {} : { freshness }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeDomainSet(domains: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    if (domain === null) throw validationError(`'${raw}' is not a recognisable domain.`);
    normalized.add(domain);
  }
  return [...normalized].sort();
}
