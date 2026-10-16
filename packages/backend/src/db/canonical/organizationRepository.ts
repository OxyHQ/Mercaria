/** Commerce company references and historical evidence; Oxy owns identity. */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { SourceLinkMethod, SourceLinkStatus } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { organizations, organizationSourceLinks } from '../schema/organizations.js';

/** An organization row as the services read it back. */
export type OrganizationRow = typeof organizations.$inferSelect;

/** A source-link row as the services read it back. */
export type OrganizationSourceLinkRow = typeof organizationSourceLinks.$inferSelect;

export type InsertOrganizationInput = typeof organizations.$inferInsert;
/** Only Mercaria relationship lifecycle metadata is writable here. */
export type OrganizationPatch = Partial<
  Pick<OrganizationRow, 'status' | 'lastSeenAt' | 'lastReviewedAt' | 'firstSeenAt' | 'pinnedFields'>
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
  const rows = await db
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, id))
    .returning();
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
  return db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, [...ids]));
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
    .orderBy(asc(organizations.id))
    .offset(offset)
    .limit(limit);
  const counted = await db.select({ count: sql<number>`count(*)::int` }).from(organizations);
  return { rows, total: counted[0]?.count ?? 0 };
}
