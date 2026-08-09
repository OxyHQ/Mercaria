/**
 * Reads and writes for `catalog_source_freshness_policies` (#68 §"Freshness
 * model", §"Anomaly protection").
 *
 * `catalogSourcePolicyRepository`'s arrangement, and deliberately so: a
 * freshness version and a rights version are the same KIND of thing — a
 * reviewed decision about one source, frozen once published, superseded rather
 * than edited. Publishing is supersede-then-insert against the one-active
 * partial unique, in the caller's transaction, with the version number read
 * from the source's own maximum so it is monotonic PER SOURCE and readable as
 * "the third freshness agreement we have had with this feed".
 *
 * Two reviewers publishing at the same instant compute the same number and the
 * loser is refused by `catalog_source_freshness_policies_version_key`. That is
 * the correct answer rather than an inconvenience: two policies silently
 * interleaved into one chain would leave nobody able to say which terms an
 * offer was ingested under.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { CatalogRefreshMode } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  OFFER_FRESHNESS_MAX_TEXT_LENGTH,
  catalogSourceFreshnessPolicies,
} from '../schema/offerFreshness.js';

export type CatalogSourceFreshnessPolicyRow = typeof catalogSourceFreshnessPolicies.$inferSelect;

/** Everything a reviewer decides when they publish a freshness version. */
export interface PublishFreshnessPolicyInput {
  sourceId: string;
  expectedRefreshIntervalSeconds: number;
  warningAfterSeconds: number;
  expiryAfterSeconds: number;
  outageGraceSeconds: number;
  retireOnSourceUnavailable: boolean;
  permittedRefreshModes: readonly CatalogRefreshMode[];
  anomalyMinimumSampleSize: number;
  anomalyZeroPriceShareBps: number;
  anomalyPriceScaleFactor: number;
  anomalyDisappearanceShareBps: number;
  reviewNote: string | null;
  reviewedByOxyUserId: string;
  now: Date;
}

/** The ACTIVE freshness version of one source, or `undefined`. */
export async function findActiveFreshnessPolicy(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<CatalogSourceFreshnessPolicyRow | undefined> {
  const rows = await db
    .select()
    .from(catalogSourceFreshnessPolicies)
    .where(
      and(
        eq(catalogSourceFreshnessPolicies.sourceId, sourceId),
        eq(catalogSourceFreshnessPolicies.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * The ACTIVE freshness versions of several sources, in ONE query.
 *
 * A comparison page carries offers from many sources, and resolving each one's
 * policy separately would make a twenty-offer read twenty round trips — the
 * `buildOfferProjectionContext` rule, which gathers every live fact per PAGE.
 */
export async function findActiveFreshnessPolicies(
  db: DatabaseOrTransaction,
  sourceIds: readonly string[],
): Promise<CatalogSourceFreshnessPolicyRow[]> {
  if (sourceIds.length === 0) return [];
  const rows = await db
    .select()
    .from(catalogSourceFreshnessPolicies)
    .where(eq(catalogSourceFreshnessPolicies.status, 'active'));
  const wanted = new Set(sourceIds);
  return rows.filter((row) => wanted.has(row.sourceId));
}

/** Every freshness version of one source, newest first — the audit read. */
export async function listFreshnessPolicies(
  db: DatabaseOrTransaction = getDb(),
  sourceId: string,
  limit = 50,
): Promise<CatalogSourceFreshnessPolicyRow[]> {
  return db
    .select()
    .from(catalogSourceFreshnessPolicies)
    .where(eq(catalogSourceFreshnessPolicies.sourceId, sourceId))
    .orderBy(desc(catalogSourceFreshnessPolicies.version))
    .limit(limit);
}

/**
 * Publish and ACTIVATE a new freshness version, superseding whatever was
 * active.
 *
 * The superseded row SURVIVES with its reviewer, its date and its numbers, so
 * "how long were we permitted to cache this feed in March" stays answerable.
 * That is not bookkeeping: these durations encode contractual obligations, and
 * an UPDATE that overwrote them would destroy the only record of what Mercaria
 * had agreed to.
 */
export async function publishFreshnessPolicy(
  db: DatabaseOrTransaction,
  input: PublishFreshnessPolicyInput,
): Promise<CatalogSourceFreshnessPolicyRow> {
  const previous = await db
    .select({ version: catalogSourceFreshnessPolicies.version })
    .from(catalogSourceFreshnessPolicies)
    .where(eq(catalogSourceFreshnessPolicies.sourceId, input.sourceId))
    .orderBy(desc(catalogSourceFreshnessPolicies.version))
    .limit(1);

  const version = (previous[0]?.version ?? 0) + 1;

  const superseded = await db
    .update(catalogSourceFreshnessPolicies)
    .set({ status: 'superseded', supersededAt: input.now })
    .where(
      and(
        eq(catalogSourceFreshnessPolicies.sourceId, input.sourceId),
        eq(catalogSourceFreshnessPolicies.status, 'active'),
      ),
    )
    .returning({ version: catalogSourceFreshnessPolicies.version });

  const rows = await db
    .insert(catalogSourceFreshnessPolicies)
    .values({
      sourceId: input.sourceId,
      version,
      status: 'active',
      expectedRefreshIntervalSeconds: input.expectedRefreshIntervalSeconds,
      warningAfterSeconds: input.warningAfterSeconds,
      expiryAfterSeconds: input.expiryAfterSeconds,
      outageGraceSeconds: input.outageGraceSeconds,
      retireOnSourceUnavailable: input.retireOnSourceUnavailable,
      permittedRefreshModes: [...input.permittedRefreshModes],
      anomalyMinimumSampleSize: input.anomalyMinimumSampleSize,
      anomalyZeroPriceShareBps: input.anomalyZeroPriceShareBps,
      anomalyPriceScaleFactor: input.anomalyPriceScaleFactor,
      anomalyDisappearanceShareBps: input.anomalyDisappearanceShareBps,
      reviewNote:
        input.reviewNote === null
          ? null
          : input.reviewNote.slice(0, OFFER_FRESHNESS_MAX_TEXT_LENGTH),
      reviewedAt: input.now,
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      activatedAt: input.now,
      supersedesVersion: superseded[0]?.version ?? null,
    })
    .returning();

  const row = rows[0];
  if (!row) {
    throw new Error(
      `catalog_source_freshness_policies insert for ${input.sourceId} returned nothing.`,
    );
  }
  return row;
}
