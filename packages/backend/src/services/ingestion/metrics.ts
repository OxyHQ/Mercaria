/**
 * OBSERVABILITY — the ten measurements issue #62 §"Observability" asks for, per
 * source, plus the trace that opens from one external object.
 *
 * ## Counted from the EVIDENCE beside the counter, wherever both exist
 *
 * `#60`'s `scannedFromRecords` device: a run row carries counters its own pages
 * wrote, and `catalog_source_rejections` carries a row per refusal. Reporting
 * both and saying whether they AGREE is what makes a broken page visible — a
 * page that swallowed a record leaves the two disagreeing, where either number
 * alone reads as a clean run.
 *
 * ## The trace opens from an EXTERNAL OBJECT and nothing else
 *
 * No merchant handle, no URL, no seller. This surface is behind an operator
 * allow-list, so the restriction is not about authorisation — it is about the
 * question the surface can be ASKED. "Show me everything this source ever saw
 * about this object" is a debugging question; "show me every source that
 * mentions this merchant" is a different capability that nobody has needed and
 * that would want its own justification.
 */

import type { CatalogSourceRightsVerdict } from '@mercaria/shared-types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countSourceObjectsByState,
  countStaleSourceObjects,
  findSourceObject,
} from '../../db/ingestion/catalogSourceObjectRepository.js';
import { listSourceRuns } from '../../db/ingestion/catalogSourceRunRepository.js';
import {
  listSourceRejections,
  summarizeSourceRejections,
} from '../../db/ingestion/catalogSourceRejectionRepository.js';
import { catalogSourceRejections } from '../../db/schema/ingestion.js';
import { sourceRecords } from '../../db/schema/provenance.js';
import { matchDecisions } from '../../db/schema/matching.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { registeredCatalogSourceProviders } from './registry.js';
import { resolveIngestionSource } from './source.service.js';

/** Everything issue §"Observability" names, for one source. */
export interface SourceMetrics {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly provider: string;
  readonly status: string;
  readonly healthState: string;
  readonly rights: CatalogSourceRightsVerdict;
  readonly policyVersion: number | null;
  /** Whether this deployment ships an adapter for the provider at all. */
  readonly adapterRegistered: boolean;

  /** 1 — fetch count and latency, across the runs in the window. */
  readonly fetchCount: number;
  readonly fetchDurationMs: number;
  /** 2 — the intake partition, summed. */
  readonly fetched: number;
  readonly stored: number;
  readonly unchanged: number;
  readonly rejected: number;
  readonly quarantined: number;
  /** 3 — the match rate, over records that reached the matcher. */
  readonly matched: number;
  readonly matchRate: number | null;
  /** 4 — the review backlog, from the objects themselves. */
  readonly reviewBacklog: number;
  /** 5 — offer freshness. */
  readonly offersCurrent: number;
  readonly offersStale: number;
  readonly offersRetired: number;
  /** 6 — error class and rate, from the residual. */
  readonly rejectionsByReason: Readonly<Record<string, number>>;
  /** 7 — rate-limit pressure. */
  readonly rateLimitHits: number;
  /** 9 — payload/schema version drift. */
  readonly normalizationVersions: Readonly<Record<string, number>>;

  /**
   * The vacuity cross-check: rejections COUNTED from their own rows, beside the
   * runs' own counter, and whether the two agree.
   */
  readonly rejectedFromRecords: number;
  readonly countsAgree: boolean;
}

/** One source's measurements over its most recent runs. */
export async function readSourceMetrics(
  sourceId: string,
  options: { runWindow?: number; now?: Date } = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<SourceMetrics> {
  const now = options.now ?? new Date();
  const resolved = await resolveIngestionSource(sourceId, db);
  if (!resolved) throw notFound('Source is not configured for ingestion');

  const runs = await listSourceRuns(db, sourceId, options.runWindow ?? 25);
  const totals = runs.reduce(
    (accumulator, run) => ({
      fetchCount: accumulator.fetchCount + run.fetchCount,
      fetchDurationMs: accumulator.fetchDurationMs + run.fetchDurationMs,
      fetched: accumulator.fetched + run.fetched,
      stored: accumulator.stored + run.stored,
      unchanged: accumulator.unchanged + run.unchanged,
      rejected: accumulator.rejected + run.rejected,
      quarantined: accumulator.quarantined + run.quarantined,
      matched: accumulator.matched + run.matched,
      offersRetired: accumulator.offersRetired + run.offersRetired,
      rateLimitHits: accumulator.rateLimitHits + run.rateLimitHits,
    }),
    {
      fetchCount: 0,
      fetchDurationMs: 0,
      fetched: 0,
      stored: 0,
      unchanged: 0,
      rejected: 0,
      quarantined: 0,
      matched: 0,
      offersRetired: 0,
      rateLimitHits: 0,
    },
  );

  const byState = await countSourceObjectsByState(db, sourceId);
  const offersStale = await countStaleSourceObjects(db, sourceId, now);
  const rejectionsByReason = await summarizeSourceRejections(db, sourceId);
  const rejectedFromRecords = Object.values(rejectionsByReason).reduce(
    (total, count) => total + count,
    0,
  );

  const versionRows = await db
    .select({
      version: sourceRecords.normalizationVersion,
      total: sql<number>`count(*)::int`,
    })
    .from(sourceRecords)
    .where(eq(sourceRecords.sourceId, sourceId))
    .groupBy(sourceRecords.normalizationVersion);
  const normalizationVersions: Record<string, number> = {};
  for (const row of versionRows) {
    normalizationVersions[row.version === null ? 'unversioned' : String(row.version)] = row.total;
  }

  return {
    sourceId,
    sourceName: resolved.source.sourceName,
    provider: resolved.source.config.provider,
    status: resolved.source.config.status,
    healthState: resolved.source.config.healthState,
    rights: resolved.rights,
    policyVersion: resolved.policy?.version ?? null,
    adapterRegistered: registeredCatalogSourceProviders().includes(
      resolved.source.config.provider,
    ),
    ...totals,
    matchRate: totals.stored === 0 ? null : totals.matched / totals.stored,
    reviewBacklog: byState.review_required ?? 0,
    offersCurrent: byState.offer_current ?? 0,
    offersStale,
    rejectionsByReason,
    normalizationVersions,
    rejectedFromRecords,
    /**
     * The rejections table is SWEPT at thirty days and the runs are not, so the
     * two agree only while every run in the window is younger than the
     * retention. `>=` rather than `===` is therefore the honest comparison: the
     * counter may legitimately exceed the surviving evidence, and the direction
     * that indicates a swallowed record — MORE evidence than the counter
     * admits — is the one this catches.
     */
    countsAgree: totals.rejected >= rejectedFromRecords,
  };
}

/** Everything one source ever recorded about one external object. */
export interface SourceObjectTrace {
  readonly sourceId: string;
  readonly externalType: string;
  readonly externalId: string;
  readonly state: string;
  readonly firstObservedAt: string;
  readonly lastSeenAt: string;
  readonly staleAt: string;
  readonly observationCount: number;
  readonly quarantineReason: string | null;
  readonly offerId: string | null;
  readonly matchDecision: {
    readonly id: string;
    readonly outcome: string;
    readonly decidedStage: string;
    readonly confidence: number | null;
    readonly matchedCanonicalProductId: string | null;
    readonly matchedCanonicalVariantId: string | null;
  } | null;
  readonly observations: readonly {
    readonly id: string;
    readonly observedAt: string;
    readonly sourceUpdatedAt: string | null;
    readonly contentHash: string;
    readonly rawPayloadDigest: string | null;
    readonly normalizationVersion: number | null;
    readonly policyVersion: number | null;
    readonly payloadStored: boolean;
  }[];
  readonly rejections: readonly {
    readonly reasonCode: string;
    readonly detail: string | null;
    readonly createdAt: string;
  }[];
}

/**
 * Trace one external object.
 *
 * The observations are the append-only chain (#57's price history), the
 * decision is the pointer this domain keeps rather than a copy, and the
 * rejections are the residual for that object. `payloadStored` is a BOOLEAN
 * rather than the payload: an operator needs to know whether the `store` right
 * was in force, and serving the stored content back through a debugging surface
 * is a second distribution channel for data whose retention this domain
 * deliberately bounds.
 */
export async function traceSourceObject(
  input: { sourceId: string; externalType: string; externalId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<SourceObjectTrace> {
  const object = await findSourceObject(
    db,
    input.sourceId,
    // The column CHECK is what validates the value; the cast here reflects that
    // the route's own schema has already narrowed it to the tuple.
    input.externalType as Parameters<typeof findSourceObject>[2],
    input.externalId,
  );
  if (!object) throw notFound('No such source object');

  const observations = await db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.sourceId, input.sourceId),
        eq(sourceRecords.externalType, object.externalType),
        eq(sourceRecords.externalId, object.externalId),
      ),
    )
    .orderBy(desc(sourceRecords.observedAt))
    .limit(50);

  const decisionRows =
    object.lastMatchDecisionId === null
      ? []
      : await db
          .select()
          .from(matchDecisions)
          .where(eq(matchDecisions.id, object.lastMatchDecisionId))
          .limit(1);
  const decision = decisionRows[0];

  const rejections = await listSourceRejections(db, {
    sourceId: input.sourceId,
    limit: 25,
  });

  return {
    sourceId: object.sourceId,
    externalType: object.externalType,
    externalId: object.externalId,
    state: object.state,
    firstObservedAt: object.firstObservedAt.toISOString(),
    lastSeenAt: object.lastSeenAt.toISOString(),
    staleAt: object.staleAt.toISOString(),
    observationCount: object.observationCount,
    quarantineReason: object.quarantineReason,
    offerId: object.offerId,
    matchDecision:
      decision === undefined
        ? null
        : {
            id: decision.id,
            outcome: decision.outcome,
            decidedStage: decision.decidedStage,
            confidence: decision.confidence,
            matchedCanonicalProductId: decision.matchedCanonicalProductId,
            matchedCanonicalVariantId: decision.matchedCanonicalVariantId,
          },
    observations: observations.map((row) => ({
      id: row.id,
      observedAt: row.observedAt.toISOString(),
      sourceUpdatedAt: row.sourceUpdatedAt === null ? null : row.sourceUpdatedAt.toISOString(),
      contentHash: row.contentHash,
      rawPayloadDigest: row.rawPayloadDigest,
      normalizationVersion: row.normalizationVersion,
      policyVersion: row.policyVersion,
      payloadStored: row.payload !== null,
    })),
    rejections: rejections
      .filter((row) => row.externalId === object.externalId)
      .map((row) => ({
        reasonCode: row.reasonCode,
        detail: row.detail,
        createdAt: row.createdAt.toISOString(),
      })),
  };
}

/** The rejection residual for one source, as an operator reads it. */
export async function readSourceRejections(
  sourceId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  readonly {
    readonly reasonCode: string;
    readonly externalId: string | null;
    readonly detail: string | null;
    readonly createdAt: string;
  }[]
> {
  const rows = await db
    .select()
    .from(catalogSourceRejections)
    .where(eq(catalogSourceRejections.sourceId, sourceId))
    .orderBy(desc(catalogSourceRejections.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    reasonCode: row.reasonCode,
    externalId: row.externalId,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  }));
}
