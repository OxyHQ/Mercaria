/**
 * The organization write, matching and read surface (#53).
 *
 * The deliberate mirror of `brand.service.ts` — same transaction shapes, same
 * identity rules, same public-DTO discipline; read that file's header for the
 * shared reasoning. What differs here is exactly what differs between the two
 * entities (ADR 0002 D1):
 *
 * - **Domains are a VERIFIED claim, not an observation.** A source observation
 *   asserting a domain NEVER lands in `verified_domains` — a domain match is
 *   evidence, not ownership proof (#53 identity rule 2). It is recorded in the
 *   observation's payload and surfaced as a `domain_requires_verification`
 *   conflict for the review path; {@link addVerifiedOrganizationDomain} is the
 *   one writer, and it demands an actor because verification is a decision
 *   somebody made (the deterministic #83 domain-control flow will be its
 *   caller, alongside operators).
 * - `legalName` and `countryCode` exist here and not on brands — a mark has no
 *   legal register entry.
 */

import { isUniqueViolation } from '@oxyhq/db';
import type {
  AliasResolution,
  CanonicalAlias,
  Organization,
  PaginatedResponse,
  SourceFreshness,
  SourceLinkMethod,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findOrganizationById,
  findOrganizationBySlug,
  findOrganizationIdsByNormalizedAlias,
  findOrganizationIdsBySourceRecordIds,
  findOrganizationsByIds,
  findOrganizationsByNormalizedName,
  findOrganizationsByVerifiedDomain,
  insertOrganization,
  insertOrganizationAlias,
  insertOrganizationSourceLink,
  listOrganizationAliases,
  listOrganizationsPage,
  listOrganizationSourceLinks,
  searchOrganizationsByNameSimilarity,
  updateOrganization as updateOrganizationRow,
  type OrganizationRow,
} from '../../db/canonical/organizationRepository.js';
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

/** See `brand.service.ts` — corruption bound on the flattened redirect chain. */
const MAX_MERGE_HOPS = 10;

/** Trigram scores below this are noise, not candidates. */
const MIN_SIMILARITY = 0.3;

async function resolveOrganizationRow(
  db: DatabaseOrTransaction,
  row: OrganizationRow,
): Promise<OrganizationRow> {
  let current = row;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    if (current.status !== 'merged' || !current.mergedIntoId) return current;
    const next = await findOrganizationById(db, current.mergedIntoId);
    if (!next) {
      throw new Error(
        `Organization ${current.id} redirects to missing organization ${current.mergedIntoId}.`,
      );
    }
    current = next;
  }
  throw new Error(`Organization merge chain exceeds ${MAX_MERGE_HOPS} hops from ${row.id}.`);
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  legalName?: string;
  websiteUrl?: string;
  /** ISO 3166-1 alpha-2; normalized to upper case, shape-checked. */
  countryCode?: string;
  logoFileId?: string;
  aliases?: { alias: string; kind: CanonicalAlias['kind']; language?: string }[];
  actorOxyUserId?: string;
}

/** Mint an organization; the canonical name gets its own alias row (see brands). */
export async function createOrganization(input: CreateOrganizationInput): Promise<OrganizationRow> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw validationError('createOrganization: name must be a non-empty string.');
  }
  const normalizedName = normalizeEntityName(name);
  if (normalizedName.length === 0) {
    throw validationError(`createOrganization: name '${name}' has no normalizable content.`);
  }
  const slug = input.slug ?? slugFromName(name);
  if (!slug) throw validationError(`createOrganization: cannot derive a slug from '${name}'.`);
  const countryCode = input.countryCode?.trim().toUpperCase();
  if (countryCode !== undefined && !/^[A-Z]{2}$/.test(countryCode)) {
    throw validationError(`createOrganization: '${countryCode}' is not an ISO 3166-1 alpha-2 code.`);
  }

  try {
    return await getDb().transaction(async (tx) => {
      const organization = await insertOrganization(tx, {
        slug,
        name,
        normalizedName,
        legalName: input.legalName ?? null,
        websiteUrl: input.websiteUrl ?? null,
        countryCode: countryCode ?? null,
        logoFileId: input.logoFileId ?? null,
      });
      await insertOrganizationAlias(tx, {
        organizationId: organization.id,
        alias: name,
        kind: 'name_variant',
        ...(input.actorOxyUserId === undefined ? {} : { createdByOxyUserId: input.actorOxyUserId }),
      });
      if (input.legalName && normalizeAliasLookup(input.legalName) !== normalizeAliasLookup(name)) {
        await insertOrganizationAlias(tx, {
          organizationId: organization.id,
          alias: input.legalName,
          kind: 'name_variant',
          ...(input.actorOxyUserId === undefined
            ? {}
            : { createdByOxyUserId: input.actorOxyUserId }),
        });
      }
      for (const alias of input.aliases ?? []) {
        await insertOrganizationAlias(tx, {
          organizationId: organization.id,
          alias: alias.alias,
          kind: alias.kind,
          ...(alias.language === undefined ? {} : { language: alias.language }),
          ...(input.actorOxyUserId === undefined
            ? {}
            : { createdByOxyUserId: input.actorOxyUserId }),
        });
      }
      return organization;
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error, 'organizations_slug_key')) {
      throw conflict(`An organization with slug '${slug}' already exists.`);
    }
    throw error;
  }
}

export interface UpdateOrganizationInput {
  name?: string;
  legalName?: string;
  websiteUrl?: string;
  countryCode?: string;
  logoFileId?: string;
  status?: 'active' | 'inactive' | 'suppressed';
  actorOxyUserId: string;
}

/** Operator update — pins what it touches; a rename keeps the old name as an alias. */
export async function updateOrganization(
  organizationId: string,
  input: UpdateOrganizationInput,
): Promise<OrganizationRow> {
  return getDb().transaction(async (tx) => {
    const organization = await findOrganizationById(tx, organizationId);
    if (!organization) throw notFound(`Organization ${organizationId} does not exist.`);
    if (organization.status === 'merged') {
      throw conflict(
        `Organization ${organizationId} is merged into ${String(organization.mergedIntoId)}; update the winner.`,
      );
    }

    const patch: Parameters<typeof updateOrganizationRow>[2] = {};
    const pinned = new Set(organization.pinnedFields);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) throw validationError('updateOrganization: name must be non-empty.');
      const normalizedName = normalizeEntityName(name);
      if (normalizedName.length === 0) {
        throw validationError(`updateOrganization: name '${name}' has no normalizable content.`);
      }
      if (name !== organization.name) {
        patch.name = name;
        patch.normalizedName = normalizedName;
        pinned.add('name');
        await insertOrganizationAlias(tx, {
          organizationId,
          alias: organization.name,
          kind: 'former_name',
          createdByOxyUserId: input.actorOxyUserId,
        });
        await insertOrganizationAlias(tx, {
          organizationId,
          alias: name,
          kind: 'name_variant',
          createdByOxyUserId: input.actorOxyUserId,
        });
      }
    }
    if (input.legalName !== undefined) {
      patch.legalName = input.legalName;
      pinned.add('legalName');
    }
    if (input.websiteUrl !== undefined) {
      patch.websiteUrl = input.websiteUrl;
      pinned.add('websiteUrl');
    }
    if (input.countryCode !== undefined) {
      const countryCode = input.countryCode.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(countryCode)) {
        throw validationError(
          `updateOrganization: '${countryCode}' is not an ISO 3166-1 alpha-2 code.`,
        );
      }
      patch.countryCode = countryCode;
      pinned.add('countryCode');
    }
    if (input.logoFileId !== undefined) {
      patch.logoFileId = input.logoFileId;
      patch.logoSourceRecordId = null;
      pinned.add('logoFileId');
    }
    if (input.status !== undefined) patch.status = input.status;

    patch.pinnedFields = [...pinned].sort();
    patch.lastReviewedAt = new Date();
    const updated = await updateOrganizationRow(tx, organizationId, patch);
    if (!updated) throw notFound(`Organization ${organizationId} does not exist.`);
    return updated;
  });
}

/** One field an observation could not apply, and why it is review input. */
export interface OrganizationSourceFieldConflict {
  field: string;
  reason:
    | 'pinned'
    | 'lower_confidence'
    | 'conflicting_name'
    | 'invalid_domain'
    | 'domain_requires_verification';
  sourceValue: string;
}

export interface ApplyOrganizationSourceObservationInput {
  organizationId: string;
  sourceId: string;
  externalId: string;
  observedAt: Date;
  staleAt?: Date;
  method: SourceLinkMethod;
  matchRule: string;
  confidence?: number;
  decidedByOxyUserId?: string;
  fields: {
    name?: string;
    legalName?: string;
    websiteUrl?: string;
    logoFileId?: string;
    /** Observed domains — recorded and routed to review, NEVER auto-verified. */
    domains?: string[];
  };
}

export interface ApplyOrganizationSourceObservationResult {
  organization: OrganizationRow;
  sourceRecordId: string;
  newObservation: boolean;
  applied: string[];
  conflicts: OrganizationSourceFieldConflict[];
}

/**
 * The source-upsert — see `applyBrandSourceObservation` for the shared shape.
 * The organization-specific rule: EVERY observed domain becomes a
 * `domain_requires_verification` conflict; the payload keeps the assertion so
 * the review/verification path (#83, #59) has its evidence, and
 * `verified_domains` is untouched.
 */
export async function applyOrganizationSourceObservation(
  input: ApplyOrganizationSourceObservationInput,
): Promise<ApplyOrganizationSourceObservationResult> {
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw validationError('applyOrganizationSourceObservation: confidence must be within [0, 1].');
  }
  return getDb().transaction(async (tx) => {
    const loaded = await findOrganizationById(tx, input.organizationId);
    if (!loaded) throw notFound(`Organization ${input.organizationId} does not exist.`);
    const organization = await resolveOrganizationRow(tx, loaded);

    const source = await findCatalogSourceById(tx, input.sourceId);
    if (!source) throw notFound(`Catalog source ${input.sourceId} does not exist.`);

    const domainInput = input.fields.domains ?? [];
    const conflicts: OrganizationSourceFieldConflict[] = [];
    for (const raw of domainInput) {
      const domain = normalizeDomain(raw);
      conflicts.push(
        domain === null
          ? { field: 'domains', reason: 'invalid_domain', sourceValue: raw }
          : { field: 'domains', reason: 'domain_requires_verification', sourceValue: domain },
      );
    }

    const payload: JsonValue = {
      ...(input.fields.name === undefined ? {} : { name: input.fields.name }),
      ...(input.fields.legalName === undefined ? {} : { legalName: input.fields.legalName }),
      ...(input.fields.websiteUrl === undefined ? {} : { websiteUrl: input.fields.websiteUrl }),
      ...(input.fields.logoFileId === undefined ? {} : { logoFileId: input.fields.logoFileId }),
      ...(domainInput.length === 0 ? {} : { domains: [...domainInput].sort() }),
    };

    const { record, inserted } = await recordSourceObservation(tx, {
      sourceId: input.sourceId,
      // `external_type` is the ADR 0002 D19 closed set, which has no
      // `organization` member: sources describe the objects THEY expose, and an
      // observed commercial actor is a `merchant` in every source's own terms.
      // Which canonical entity the observation supports is the LINK's decision.
      externalType: 'merchant',
      externalId: input.externalId,
      observedAt: input.observedAt,
      ...(input.staleAt === undefined ? {} : { staleAt: input.staleAt }),
      contentHash: contentHashOf(payload),
      ...(source.mayStore ? { payload } : {}),
    });

    const activeLinks = await listOrganizationSourceLinks(tx, organization.id, 'active');
    const existingStrength = activeLinks
      .filter((link) => link.sourceRecordId !== record.id)
      .reduce((max, link) => Math.max(max, link.confidence ?? 1), 0);

    await insertOrganizationSourceLink(tx, {
      organizationId: organization.id,
      sourceRecordId: record.id,
      method: input.method,
      matchRule: input.matchRule,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.decidedByOxyUserId === undefined
        ? {}
        : { decidedByOxyUserId: input.decidedByOxyUserId }),
    });

    const incomingStrength = input.confidence ?? 1;
    const pinned = new Set(organization.pinnedFields);
    const applied: string[] = [];
    const patch: Parameters<typeof updateOrganizationRow>[2] = {};

    if (input.fields.name !== undefined) {
      const sourceName = input.fields.name.trim();
      if (
        sourceName.length > 0 &&
        normalizeAliasLookup(sourceName) !== normalizeAliasLookup(organization.name)
      ) {
        await insertOrganizationAlias(tx, {
          organizationId: organization.id,
          alias: sourceName,
          kind: 'name_variant',
          sourceRecordId: record.id,
        });
        conflicts.push({ field: 'name', reason: 'conflicting_name', sourceValue: sourceName });
      }
    }

    const scalarFields: {
      field: 'legalName' | 'websiteUrl' | 'logoFileId';
      value: string | undefined;
      current: string | null;
    }[] = [
      { field: 'legalName', value: input.fields.legalName, current: organization.legalName },
      { field: 'websiteUrl', value: input.fields.websiteUrl, current: organization.websiteUrl },
      { field: 'logoFileId', value: input.fields.logoFileId, current: organization.logoFileId },
    ];
    for (const { field, value, current } of scalarFields) {
      if (value === undefined || value === current) continue;
      if (pinned.has(field)) {
        conflicts.push({ field, reason: 'pinned', sourceValue: value });
        continue;
      }
      if (current !== null && incomingStrength < existingStrength) {
        conflicts.push({ field, reason: 'lower_confidence', sourceValue: value });
        continue;
      }
      patch[field] = value;
      if (field === 'logoFileId') patch.logoSourceRecordId = record.id;
      applied.push(field);
    }

    patch.lastSeenAt =
      organization.lastSeenAt && organization.lastSeenAt > input.observedAt
        ? organization.lastSeenAt
        : input.observedAt;
    if (input.observedAt < organization.firstSeenAt) patch.firstSeenAt = input.observedAt;

    const updated = await updateOrganizationRow(tx, organization.id, patch);
    if (!updated) throw new Error(`Organization ${organization.id} vanished mid-transaction.`);

    return {
      organization: updated,
      sourceRecordId: record.id,
      newObservation: inserted,
      applied,
      conflicts,
    };
  });
}

export interface AddVerifiedDomainInput {
  organizationId: string;
  domain: string;
  /** Who decided the verification — an operator or the #83 verifier. Mandatory. */
  actorOxyUserId: string;
}

/**
 * The ONE writer of `verified_domains`. Callers hold the evidence; this
 * function holds the invariant that nothing else — no observation, no
 * heuristic — can ever write the column.
 */
export async function addVerifiedOrganizationDomain(
  input: AddVerifiedDomainInput,
): Promise<OrganizationRow> {
  const domain = normalizeDomain(input.domain);
  if (domain === null) {
    throw validationError(`'${input.domain}' is not a recognisable domain.`);
  }
  if (input.actorOxyUserId.trim().length === 0) {
    throw validationError('addVerifiedOrganizationDomain: an actor is required.');
  }
  return getDb().transaction(async (tx) => {
    const organization = await findOrganizationById(tx, input.organizationId);
    if (!organization) throw notFound(`Organization ${input.organizationId} does not exist.`);
    if (organization.status === 'merged') {
      throw conflict(`Organization ${input.organizationId} is merged; verify on the winner.`);
    }
    if (organization.verifiedDomains.includes(domain)) return organization;
    const updated = await updateOrganizationRow(tx, organization.id, {
      verifiedDomains: [...organization.verifiedDomains, domain].sort(),
      lastReviewedAt: new Date(),
    });
    if (!updated) throw notFound(`Organization ${input.organizationId} does not exist.`);
    return updated;
  });
}

/** Reverse lookup by name/alias — see `resolveBrandAlias`. */
export async function resolveOrganizationAlias(name: string): Promise<AliasResolution> {
  const lookup = normalizeAliasLookup(name);
  if (lookup.length === 0) return { kind: 'none' };
  const db = getDb();

  const ids = await findOrganizationIdsByNormalizedAlias(db, lookup);
  const rows = await findOrganizationsByIds(db, ids);
  const finalIds = new Set<string>();
  for (const row of rows) {
    finalIds.add((await resolveOrganizationRow(db, row)).id);
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
export interface OrganizationCandidate {
  organizationId: string;
  slug: string;
  name: string;
  status: OrganizationRow['status'];
  score: number;
  matchedVia: 'normalized_name' | 'alias' | 'name_similarity';
}

/** Candidate generation — see `searchBrandCandidates`; returns, never acts. */
export async function searchOrganizationCandidates(
  name: string,
  limit = 10,
): Promise<OrganizationCandidate[]> {
  const normalized = normalizeEntityName(name);
  if (normalized.length === 0) return [];
  const db = getDb();

  const byId = new Map<string, OrganizationCandidate>();
  const offer = async (
    row: OrganizationRow,
    score: number,
    matchedVia: OrganizationCandidate['matchedVia'],
  ) => {
    const resolved = await resolveOrganizationRow(db, row);
    const existing = byId.get(resolved.id);
    if (existing && existing.score >= score) return;
    byId.set(resolved.id, {
      organizationId: resolved.id,
      slug: resolved.slug,
      name: resolved.name,
      status: resolved.status,
      score,
      matchedVia,
    });
  };

  for (const row of await findOrganizationsByNormalizedName(db, normalized)) {
    await offer(row, 1, 'normalized_name');
  }
  const aliasIds = await findOrganizationIdsByNormalizedAlias(db, normalizeAliasLookup(name));
  for (const row of await findOrganizationsByIds(db, aliasIds)) {
    await offer(row, 1, 'alias');
  }
  for (const { organization, similarity } of await searchOrganizationsByNameSimilarity(
    db,
    normalized,
    limit,
  )) {
    if (similarity < MIN_SIMILARITY) continue;
    await offer(organization, similarity, 'name_similarity');
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Reverse lookup from a VERIFIED domain (#53 API rule 3). Redirects followed;
 * more than one organization legitimately verifying one domain (a parent and
 * its subsidiary) comes back as the full set for the caller to present.
 */
export async function findOrganizationIdsByVerifiedDomain(domain: string): Promise<string[]> {
  const normalized = normalizeDomain(domain);
  if (normalized === null) return [];
  const db = getDb();
  const rows = await findOrganizationsByVerifiedDomain(db, normalized);
  const finalIds = new Set<string>();
  for (const row of rows) {
    finalIds.add((await resolveOrganizationRow(db, row)).id);
  }
  return [...finalIds].sort();
}

/** Reverse lookup from a source's own id — see `findBrandIdsBySourceObject`. */
export async function findOrganizationIdsBySourceObject(
  sourceId: string,
  externalId: string,
): Promise<string[]> {
  const db = getDb();
  const records = await listSourceRecordsForObject(db, sourceId, 'merchant', externalId);
  const ids = await findOrganizationIdsBySourceRecordIds(
    db,
    records.map((record) => record.id),
  );
  const finalIds = new Set<string>();
  for (const row of await findOrganizationsByIds(db, ids)) {
    finalIds.add((await resolveOrganizationRow(db, row)).id);
  }
  return [...finalIds].sort();
}

async function organizationFreshness(
  db: DatabaseOrTransaction,
  organizationId: string,
): Promise<SourceFreshness | undefined> {
  const links = await listOrganizationSourceLinks(db, organizationId, 'active');
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

/** The public read projection — verified facts plus safe freshness only. */
export async function getPublicOrganization(idOrSlug: string): Promise<Organization | undefined> {
  const db = getDb();
  const row =
    (await findOrganizationById(db, idOrSlug)) ?? (await findOrganizationBySlug(db, idOrSlug));
  if (!row) return undefined;
  return toPublicOrganization(db, row);
}

/** Offset-paginated organization list — the pagination seam. */
export async function listPublicOrganizations(
  page = 1,
  limit = 20,
): Promise<PaginatedResponse<Organization>> {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const db = getDb();
  const { rows, total } = await listOrganizationsPage(db, (safePage - 1) * safeLimit, safeLimit);
  const data: Organization[] = [];
  for (const row of rows) data.push(await toPublicOrganization(db, row));
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

async function toPublicOrganization(
  db: DatabaseOrTransaction,
  row: OrganizationRow,
): Promise<Organization> {
  const aliases = await listOrganizationAliases(db, row.id);
  const freshness = await organizationFreshness(db, row.id);
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    name: row.name,
    ...(row.legalName === null ? {} : { legalName: row.legalName }),
    ...(row.websiteUrl === null ? {} : { websiteUrl: row.websiteUrl }),
    verifiedDomains: row.verifiedDomains,
    ...(row.countryCode === null ? {} : { countryCode: row.countryCode }),
    ...(row.logoFileId === null ? {} : { logoFileId: row.logoFileId }),
    aliases: aliases.map((alias) => ({
      alias: alias.alias,
      kind: alias.kind,
      ...(alias.language === null ? {} : { language: alias.language }),
    })),
    ...(row.mergedIntoId === null ? {} : { mergedIntoId: row.mergedIntoId }),
    firstSeenAt: row.firstSeenAt.toISOString(),
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt.toISOString() }),
    ...(freshness === undefined ? {} : { freshness }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
