/**
 * Reads and writes for `organizations`, `organization_aliases` and
 * `organization_source_links`.
 *
 * The DELIBERATE mirror of `brandRepository.ts` — same conventions (`db` first,
 * convergence inserts, the merge CAS), same reasoning, per-entity tables per
 * ADR 0002 D16 so every row keeps a REAL foreign key. Read that file's
 * docblocks for the why; this one only notes where organizations differ:
 * `verified_domains` (evidence-backed, versus a brand's observed ones) and no
 * derived counts.
 */

import { and, arrayContains, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { CanonicalAliasKind, SourceLinkMethod, SourceLinkStatus } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  organizationAliases,
  organizations,
  organizationSourceLinks,
} from '../schema/organizations.js';

/** An organization row as the services read it back. */
export type OrganizationRow = typeof organizations.$inferSelect;

/** An alias row as the services read it back. */
export type OrganizationAliasRow = typeof organizationAliases.$inferSelect;

/** A source-link row as the services read it back. */
export type OrganizationSourceLinkRow = typeof organizationSourceLinks.$inferSelect;

/** What the write service supplies to mint an organization. */
/**
 * #915: `nameFoldVersion` is REQUIRED here, though the column has a DEFAULT.
 *
 * The database default is load-bearing — the serving image writes none of these
 * columns and they are NOT NULL — but a default also makes `$inferInsert` mark
 * the field OPTIONAL, which is how a new writer folds a name and silently takes
 * version 1 while folding under 2. The requirement is re-imposed at the input
 * type instead. Reasoning in full: `canonicalProductRepository.ts`.
 */
export type InsertOrganizationInput = typeof organizations.$inferInsert &
  Required<Pick<typeof organizations.$inferInsert, 'nameFoldVersion'>>;

/** The columns an organization update may touch. Identity columns are absent. */
export type OrganizationPatch = Partial<
  Pick<
    OrganizationRow,
    | 'name'
    | 'normalizedName'
    // #915: patchable so a re-fold moves the value and its version together.
    | 'nameFoldVersion'
    | 'legalName'
    | 'websiteUrl'
    | 'verifiedDomains'
    | 'countryCode'
    | 'logoFileId'
    | 'logoSourceRecordId'
    | 'status'
    | 'lastSeenAt'
    | 'lastReviewedAt'
    | 'firstSeenAt'
    | 'pinnedFields'
  >
>;

export async function insertOrganization(
  db: DatabaseOrTransaction,
  values: InsertOrganizationInput,
): Promise<OrganizationRow> {
  const rows = await db.insert(organizations).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertOrganization returned no row.');
  return row;
}

export async function updateOrganization(
  db: DatabaseOrTransaction,
  id: string,
  patch: OrganizationPatch,
): Promise<OrganizationRow | undefined> {
  const rows = await db.update(organizations).set(patch).where(eq(organizations.id, id)).returning();
  return rows[0];
}

export async function findOrganizationById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<OrganizationRow | undefined> {
  const rows = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return rows[0];
}

export async function findOrganizationBySlug(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<OrganizationRow | undefined> {
  const rows = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return rows[0];
}

export async function findOrganizationsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<OrganizationRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(organizations).where(inArray(organizations.id, [...ids]));
}

/** Exact-normalization candidates — equality on the service-maintained column. */
export async function findOrganizationsByNormalizedName(
  db: DatabaseOrTransaction,
  normalizedName: string,
): Promise<OrganizationRow[]> {
  return db.select().from(organizations).where(eq(organizations.normalizedName, normalizedName));
}

/** A trigram candidate with pg_trgm's own similarity score. */
export interface OrganizationNameCandidate {
  organization: OrganizationRow;
  similarity: number;
}

/** See `searchBrandsByNameSimilarity` — same operator, same reasoning. */
export async function searchOrganizationsByNameSimilarity(
  db: DatabaseOrTransaction,
  normalizedName: string,
  limit: number,
): Promise<OrganizationNameCandidate[]> {
  const score = sql<number>`similarity(${organizations.normalizedName}, ${normalizedName})`;
  const rows = await db
    .select({ organization: organizations, similarity: score })
    .from(organizations)
    .where(sql`${organizations.normalizedName} % ${normalizedName}`)
    .orderBy(desc(score))
    .limit(limit);
  return rows;
}

/** Organizations whose VERIFIED domain set contains this domain. */
export async function findOrganizationsByVerifiedDomain(
  db: DatabaseOrTransaction,
  domain: string,
): Promise<OrganizationRow[]> {
  return db
    .select()
    .from(organizations)
    .where(arrayContains(organizations.verifiedDomains, [domain]));
}

export interface InsertOrganizationAliasInput {
  organizationId: string;
  alias: string;
  kind: CanonicalAliasKind;
  language?: string;
  sourceRecordId?: string;
  createdByOxyUserId?: string;
}

/** See `insertBrandAlias` — converges on `(organization_id, normalized_alias)`. */
export async function insertOrganizationAlias(
  db: DatabaseOrTransaction,
  input: InsertOrganizationAliasInput,
): Promise<OrganizationAliasRow | undefined> {
  const rows = await db
    .insert(organizationAliases)
    .values({
      organizationId: input.organizationId,
      alias: input.alias,
      kind: input.kind,
      language: input.language ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [organizationAliases.organizationId, organizationAliases.normalizedAlias],
    })
    .returning();
  return rows[0];
}

export async function listOrganizationAliases(
  db: DatabaseOrTransaction,
  organizationId: string,
): Promise<OrganizationAliasRow[]> {
  return db
    .select()
    .from(organizationAliases)
    .where(eq(organizationAliases.organizationId, organizationId))
    .orderBy(asc(organizationAliases.createdAt), asc(organizationAliases.id));
}

/** Distinct organization ids any alias with this normalization points at. */
export async function findOrganizationIdsByNormalizedAlias(
  db: DatabaseOrTransaction,
  normalizedAlias: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ organizationId: organizationAliases.organizationId })
    .from(organizationAliases)
    .where(eq(organizationAliases.normalizedAlias, normalizedAlias));
  return rows.map((row) => row.organizationId);
}

export interface InsertOrganizationSourceLinkInput {
  organizationId: string;
  sourceRecordId: string;
  method: SourceLinkMethod;
  matchRule: string;
  confidence?: number;
  status?: SourceLinkStatus;
  decidedByOxyUserId?: string;
}

/** See `insertBrandSourceLink` — converges on the ACTIVE partial unique. */
export async function insertOrganizationSourceLink(
  db: DatabaseOrTransaction,
  input: InsertOrganizationSourceLinkInput,
): Promise<OrganizationSourceLinkRow | undefined> {
  const rows = await db
    .insert(organizationSourceLinks)
    .values({
      organizationId: input.organizationId,
      sourceRecordId: input.sourceRecordId,
      method: input.method,
      matchRule: input.matchRule,
      confidence: input.confidence ?? null,
      status: input.status ?? 'active',
      decidedByOxyUserId: input.decidedByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [organizationSourceLinks.organizationId, organizationSourceLinks.sourceRecordId],
      where: sql`${organizationSourceLinks.status} = 'active'`,
    })
    .returning();
  return rows[0];
}

export async function listOrganizationSourceLinks(
  db: DatabaseOrTransaction,
  organizationId: string,
  status?: SourceLinkStatus,
): Promise<OrganizationSourceLinkRow[]> {
  const condition = status
    ? and(
        eq(organizationSourceLinks.organizationId, organizationId),
        eq(organizationSourceLinks.status, status),
      )
    : eq(organizationSourceLinks.organizationId, organizationId);
  return db
    .select()
    .from(organizationSourceLinks)
    .where(condition)
    .orderBy(asc(organizationSourceLinks.createdAt), asc(organizationSourceLinks.id));
}

/** Distinct organization ids actively linked to any of these observation rows. */
export async function findOrganizationIdsBySourceRecordIds(
  db: DatabaseOrTransaction,
  sourceRecordIds: readonly string[],
): Promise<string[]> {
  if (sourceRecordIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ organizationId: organizationSourceLinks.organizationId })
    .from(organizationSourceLinks)
    .where(
      and(
        inArray(organizationSourceLinks.sourceRecordId, [...sourceRecordIds]),
        eq(organizationSourceLinks.status, 'active'),
      ),
    );
  return rows.map((row) => row.organizationId);
}

/** See `repointBrandAliases` — same collision rule, same one legitimate delete. */
export async function repointOrganizationAliases(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerAliases = await db
    .select({ normalizedAlias: organizationAliases.normalizedAlias })
    .from(organizationAliases)
    .where(eq(organizationAliases.organizationId, winnerId));
  const taken = winnerAliases.map((row) => row.normalizedAlias);

  if (taken.length > 0) {
    await db
      .delete(organizationAliases)
      .where(
        and(
          eq(organizationAliases.organizationId, loserId),
          inArray(organizationAliases.normalizedAlias, taken),
        ),
      );
  }
  await db
    .update(organizationAliases)
    .set({ organizationId: winnerId })
    .where(eq(organizationAliases.organizationId, loserId));
}

/** See `repointBrandSourceLinks` — every mapping retained, none deleted. */
export async function repointOrganizationSourceLinks(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<void> {
  const winnerActive = await db
    .select({ sourceRecordId: organizationSourceLinks.sourceRecordId })
    .from(organizationSourceLinks)
    .where(
      and(
        eq(organizationSourceLinks.organizationId, winnerId),
        eq(organizationSourceLinks.status, 'active'),
      ),
    );
  const covered = winnerActive.map((row) => row.sourceRecordId);

  if (covered.length > 0) {
    await db
      .update(organizationSourceLinks)
      .set({ organizationId: winnerId, status: 'superseded' })
      .where(
        and(
          eq(organizationSourceLinks.organizationId, loserId),
          eq(organizationSourceLinks.status, 'active'),
          inArray(organizationSourceLinks.sourceRecordId, covered),
        ),
      );
  }
  await db
    .update(organizationSourceLinks)
    .set({ organizationId: winnerId })
    .where(eq(organizationSourceLinks.organizationId, loserId));
}

/** See `markBrandMerged` — the merge CAS, one statement. */
export async function markOrganizationMerged(
  db: DatabaseOrTransaction,
  loserId: string,
  winnerId: string,
): Promise<OrganizationRow | undefined> {
  const rows = await db
    .update(organizations)
    .set({ status: 'merged', mergedIntoId: winnerId })
    .where(and(eq(organizations.id, loserId), ne(organizations.status, 'merged')))
    .returning();
  return rows[0];
}

/** See `retargetBrandTombstones` — chain flattening on write. */
export async function retargetOrganizationTombstones(
  db: DatabaseOrTransaction,
  fromId: string,
  toId: string,
): Promise<void> {
  await db
    .update(organizations)
    .set({ mergedIntoId: toId })
    .where(eq(organizations.mergedIntoId, fromId));
}

/** One page of organizations plus the total, for the paginated list seam. */
export async function listOrganizationsPage(
  db: DatabaseOrTransaction,
  offset: number,
  limit: number,
): Promise<{ rows: OrganizationRow[]; total: number }> {
  const rows = await db
    .select()
    .from(organizations)
    .orderBy(asc(organizations.name), asc(organizations.id))
    .offset(offset)
    .limit(limit);
  const counted = await db.select({ count: sql<number>`count(*)::int` }).from(organizations);
  return { rows, total: counted[0]?.count ?? 0 };
}
