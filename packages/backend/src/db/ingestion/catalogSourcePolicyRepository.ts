/**
 * Reads and writes for `catalog_source_policies` (#62 §"Rights and controlled
 * extraction", source definition 6 and 10).
 *
 * ## Activation is supersede-then-insert, in the caller's transaction
 *
 * `catalog_source_policies_active_key` is a partial unique on `status =
 * 'active'`, so the old version must leave that predicate before the new one
 * enters it. Two statements rather than an upsert, deliberately and for #58's
 * stated reason one domain over: the old version has to SURVIVE with its
 * reviewer, its date and its terms intact — that is the audit history issue
 * acceptance 6 protects, and an upsert would overwrite exactly it.
 *
 * The CAS on `status = 'active'` makes the pair safe against a concurrent
 * second activation: the loser supersedes nothing, and its insert is then
 * refused by the unique rather than quietly producing two active versions.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { CatalogSourceExtractionMode } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { CATALOG_SOURCE_MAX_TEXT_LENGTH, catalogSourcePolicies } from '../schema/ingestion.js';

export type CatalogSourcePolicyRow = typeof catalogSourcePolicies.$inferSelect;

/** Everything a reviewer decides when they publish a version. */
export interface PublishSourcePolicyInput {
  sourceId: string;
  mayDisplay: boolean;
  mayStore: boolean;
  mayCache: boolean;
  cacheTtlSeconds: number | null;
  mayDisplayPrice: boolean;
  mayDisplayMedia: boolean;
  mayLinkOut: boolean;
  mayAppendAffiliateParams: boolean;
  mayIndex: boolean;
  mayRefreshAutomatically: boolean;
  extractionMode: CatalogSourceExtractionMode;
  extractionMaxRequestsPerDay: number | null;
  extractionUserAgent: string | null;
  attributionRequired: boolean;
  termsVersion: string | null;
  termsUrl: string | null;
  reviewNote: string | null;
  reviewedByOxyUserId: string;
  now: Date;
}

/** The ACTIVE version of one source's rights, or `undefined`. */
export async function findActiveSourcePolicy(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<CatalogSourcePolicyRow | undefined> {
  const rows = await db
    .select()
    .from(catalogSourcePolicies)
    .where(
      and(eq(catalogSourcePolicies.sourceId, sourceId), eq(catalogSourcePolicies.status, 'active')),
    )
    .limit(1);
  return rows[0];
}

/** One version by number — what `source_records.policy_version` resolves through. */
export async function findSourcePolicyVersion(
  db: DatabaseOrTransaction,
  sourceId: string,
  version: number,
): Promise<CatalogSourcePolicyRow | undefined> {
  const rows = await db
    .select()
    .from(catalogSourcePolicies)
    .where(
      and(
        eq(catalogSourcePolicies.sourceId, sourceId),
        eq(catalogSourcePolicies.version, version),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Every version of one source's rights, newest first — the audit read. */
export async function listSourcePolicies(
  db: DatabaseOrTransaction = getDb(),
  sourceId: string,
  limit = 50,
): Promise<CatalogSourcePolicyRow[]> {
  return db
    .select()
    .from(catalogSourcePolicies)
    .where(eq(catalogSourcePolicies.sourceId, sourceId))
    .orderBy(desc(catalogSourcePolicies.version))
    .limit(limit);
}

/**
 * Publish and ACTIVATE a new version, superseding whatever was active.
 *
 * Must run inside the caller's transaction: the rights projection onto
 * `catalog_sources` commits with it, and the deferred constraint trigger checks
 * the pair at COMMIT. Splitting them across two transactions would leave a
 * window in which the registry advertises rights the policy has withdrawn.
 *
 * The version number is read from the source's own maximum rather than a
 * sequence, so it is monotonic PER SOURCE and readable as "the third rights
 * agreement we have had with this feed". A concurrent second publish computes
 * the same number and is refused by `catalog_source_policies_version_key`,
 * which is the correct answer: two reviewers publishing simultaneously must not
 * silently interleave into one chain.
 */
export async function publishSourcePolicy(
  db: DatabaseOrTransaction,
  input: PublishSourcePolicyInput,
): Promise<CatalogSourcePolicyRow> {
  const previous = await db
    .select({ version: catalogSourcePolicies.version, status: catalogSourcePolicies.status })
    .from(catalogSourcePolicies)
    .where(eq(catalogSourcePolicies.sourceId, input.sourceId))
    .orderBy(desc(catalogSourcePolicies.version))
    .limit(1);

  const previousVersion = previous[0]?.version ?? 0;
  const version = previousVersion + 1;

  const superseded = await db
    .update(catalogSourcePolicies)
    .set({ status: 'superseded', supersededAt: input.now })
    .where(
      and(
        eq(catalogSourcePolicies.sourceId, input.sourceId),
        eq(catalogSourcePolicies.status, 'active'),
      ),
    )
    .returning({ version: catalogSourcePolicies.version });

  const rows = await db
    .insert(catalogSourcePolicies)
    .values({
      sourceId: input.sourceId,
      version,
      status: 'active',
      mayDisplay: input.mayDisplay,
      mayStore: input.mayStore,
      mayCache: input.mayCache,
      cacheTtlSeconds: input.cacheTtlSeconds,
      mayDisplayPrice: input.mayDisplayPrice,
      mayDisplayMedia: input.mayDisplayMedia,
      mayLinkOut: input.mayLinkOut,
      mayAppendAffiliateParams: input.mayAppendAffiliateParams,
      mayIndex: input.mayIndex,
      mayRefreshAutomatically: input.mayRefreshAutomatically,
      extractionMode: input.extractionMode,
      extractionMaxRequestsPerDay: input.extractionMaxRequestsPerDay,
      extractionUserAgent: input.extractionUserAgent,
      attributionRequired: input.attributionRequired,
      termsVersion: input.termsVersion,
      termsUrl: input.termsUrl,
      reviewNote:
        input.reviewNote === null ? null : input.reviewNote.slice(0, CATALOG_SOURCE_MAX_TEXT_LENGTH),
      reviewedAt: input.now,
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      activatedAt: input.now,
      supersedesVersion: superseded[0]?.version ?? null,
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error(`catalog_source_policies insert for ${input.sourceId} returned nothing.`);
  return row;
}
