/**
 * Reads and writes for `catalog_source_configs` (#62).
 *
 * `db` is the FIRST parameter everywhere, the payment-domain convention: every
 * write here has a caller that must be atomic with something else — a status
 * change commits with the rights projection it implies, a run's outcome commits
 * with the health it produced.
 *
 * ## The claim is a lease with an owner check
 *
 * `claimDueSources` is `SELECT … FOR UPDATE SKIP LOCKED` inside the `UPDATE`,
 * the moderation-outbox shape: N tasks share the work without handing each
 * other a source, and a dead task's expired lease is reclaimable rather than
 * stranding a feed. Every release carries the owner, so a task whose lease
 * expired cannot finish work another task now owns.
 */

import { and, asc, eq, gt, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { CatalogSourceHealthState, CatalogSourceStatus } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { CATALOG_SOURCE_MAX_TEXT_LENGTH, catalogSourceConfigs } from '../schema/ingestion.js';
import { catalogSources } from '../schema/provenance.js';

export type CatalogSourceConfigRow = typeof catalogSourceConfigs.$inferSelect;

/** A config joined to the registry row it configures — what every runner needs. */
export interface IngestionSourceRow {
  readonly config: CatalogSourceConfigRow;
  readonly sourceName: string;
  readonly sourceKind: string;
}

export interface UpsertCatalogSourceConfigInput {
  sourceId: string;
  provider: string;
  sourceAccountRef?: string | null;
  merchantId?: string | null;
  storefrontId?: string | null;
  territories?: readonly string[];
  credentialRef?: string | null;
  fetchCadenceSeconds?: number | null;
  freshnessTtlSeconds?: number;
  rateLimitPerMinute?: number | null;
  rateLimitConcurrency?: number | null;
  rateLimitMinIntervalMs?: number | null;
  pageSize?: number;
}

/**
 * Register or update the ingestion configuration of one source.
 *
 * Converges on `UNIQUE(source_id)`. It deliberately does NOT touch `status`,
 * `health_state` or any lease column: editing a feed's page size must not
 * silently activate a paused source or clear an incident's health record, and
 * an upsert that wrote every column would do exactly that.
 */
export async function upsertCatalogSourceConfig(
  db: DatabaseOrTransaction,
  input: UpsertCatalogSourceConfigInput,
): Promise<CatalogSourceConfigRow> {
  const values = {
    sourceId: input.sourceId,
    provider: input.provider,
    sourceAccountRef: input.sourceAccountRef ?? null,
    merchantId: input.merchantId ?? null,
    storefrontId: input.storefrontId ?? null,
    territories: [...(input.territories ?? [])],
    credentialRef: input.credentialRef ?? null,
    fetchCadenceSeconds: input.fetchCadenceSeconds ?? null,
    rateLimitPerMinute: input.rateLimitPerMinute ?? null,
    rateLimitConcurrency: input.rateLimitConcurrency ?? null,
    rateLimitMinIntervalMs: input.rateLimitMinIntervalMs ?? null,
    ...(input.freshnessTtlSeconds === undefined
      ? {}
      : { freshnessTtlSeconds: input.freshnessTtlSeconds }),
    ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
  };

  const rows = await db
    .insert(catalogSourceConfigs)
    .values(values)
    .onConflictDoUpdate({ target: catalogSourceConfigs.sourceId, set: values })
    .returning();
  const row = rows[0];
  if (!row) throw new Error(`catalog_source_configs upsert for ${input.sourceId} returned nothing.`);
  return row;
}

export async function findCatalogSourceConfig(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<CatalogSourceConfigRow | undefined> {
  const rows = await db
    .select()
    .from(catalogSourceConfigs)
    .where(eq(catalogSourceConfigs.sourceId, sourceId))
    .limit(1);
  return rows[0];
}

/** One ingesting source with its registry row, by source id. */
export async function findIngestionSource(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<IngestionSourceRow | undefined> {
  const rows = await db
    .select({
      config: catalogSourceConfigs,
      sourceName: catalogSources.name,
      sourceKind: catalogSources.kind,
    })
    .from(catalogSourceConfigs)
    .innerJoin(catalogSources, eq(catalogSources.id, catalogSourceConfigs.sourceId))
    .where(eq(catalogSourceConfigs.sourceId, sourceId))
    .limit(1);
  return rows[0];
}

/** Every configured source, newest first — the operator list. */
export async function listIngestionSources(
  db: DatabaseOrTransaction = getDb(),
  limit = 100,
): Promise<IngestionSourceRow[]> {
  return db
    .select({
      config: catalogSourceConfigs,
      sourceName: catalogSources.name,
      sourceKind: catalogSources.kind,
    })
    .from(catalogSourceConfigs)
    .innerJoin(catalogSources, eq(catalogSources.id, catalogSourceConfigs.sourceId))
    .orderBy(asc(catalogSources.name))
    .limit(limit);
}

/**
 * Move a source's lifecycle, attributably.
 *
 * The actor is REQUIRED for every status but `failed`, which a run writes, and
 * the CHECK enforces it — this signature makes it a `tsc` error instead of a
 * constraint violation at the end of a long transaction.
 */
export async function setCatalogSourceStatus(
  db: DatabaseOrTransaction,
  input: {
    sourceId: string;
    status: CatalogSourceStatus;
    actorOxyUserId: string | null;
    reason: string | null;
    now: Date;
  },
): Promise<CatalogSourceConfigRow | undefined> {
  const rows = await db
    .update(catalogSourceConfigs)
    .set({
      status: input.status,
      statusChangedByOxyUserId: input.actorOxyUserId,
      statusChangedAt: input.actorOxyUserId === null ? null : input.now,
      statusReason: input.reason === null ? null : input.reason.slice(0, CATALOG_SOURCE_MAX_TEXT_LENGTH),
    })
    .where(eq(catalogSourceConfigs.sourceId, input.sourceId))
    .returning();
  return rows[0];
}

/**
 * Record how a run went.
 *
 * `consecutiveFailures` is reset by a success and incremented otherwise, in
 * SQL rather than by reading and writing back: two tasks finishing runs for one
 * source would otherwise each write their own idea of the count and lose one.
 */
export async function recordSourceHealth(
  db: DatabaseOrTransaction,
  input: {
    sourceId: string;
    healthState: CatalogSourceHealthState;
    status: CatalogSourceStatus;
    succeeded: boolean;
    fetchDurationMs: number;
    rateLimitHits: number;
    error: string | null;
    nextRunAt: Date;
    now: Date;
  },
): Promise<void> {
  await db
    .update(catalogSourceConfigs)
    .set({
      healthState: input.healthState,
      healthChangedAt: input.now,
      status: input.status,
      lastAttemptAt: input.now,
      ...(input.succeeded ? { lastSuccessAt: input.now } : {}),
      consecutiveFailures: input.succeeded
        ? 0
        : sql`${catalogSourceConfigs.consecutiveFailures} + 1`,
      lastFetchDurationMs: input.fetchDurationMs,
      lastRateLimitHits: input.rateLimitHits,
      lastError: input.error === null ? null : input.error.slice(0, CATALOG_SOURCE_MAX_TEXT_LENGTH),
      nextRunAt: input.nextRunAt,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(eq(catalogSourceConfigs.sourceId, input.sourceId));
}

/**
 * Atomically claim sources whose next run is due.
 *
 * Two branches, as in every Mercaria worker: work that is DUE and unleased, and
 * work whose lease has EXPIRED. `lease_until <= now` is NULL for a row that was
 * never leased, and a `WHERE` rejects only FALSE, so the reclaim branch excludes
 * never-leased rows by the comparison itself.
 *
 * Only `active` and `failed` sources are claimable — `paused` and `revoked` are
 * somebody's decision and `draft` has no reviewed policy, so a claim on any of
 * them would be work the rights derivation is about to refuse anyway.
 */
export async function claimDueSources(
  db: DatabaseOrTransaction,
  options: { leaseOwner: string; batchSize: number; leaseMs: number; now: Date },
): Promise<CatalogSourceConfigRow[]> {
  const leaseUntil = new Date(options.now.getTime() + options.leaseMs);
  const claimable = sql`${catalogSourceConfigs.status} in ('active', 'failed')`;
  const due = or(
    and(
      sql`${catalogSourceConfigs.leaseOwner} is null`,
      or(
        sql`${catalogSourceConfigs.nextRunAt} is null`,
        lte(catalogSourceConfigs.nextRunAt, options.now),
      ),
    ),
    and(isNotNull(catalogSourceConfigs.leaseOwner), lte(catalogSourceConfigs.leaseUntil, options.now)),
  );

  return db
    .update(catalogSourceConfigs)
    .set({ leaseOwner: options.leaseOwner, leaseUntil })
    .where(
      sql`${catalogSourceConfigs.id} in (
        select ${catalogSourceConfigs.id} from ${catalogSourceConfigs}
        where ${claimable} and ${due}
        order by ${asc(catalogSourceConfigs.nextRunAt)}
        limit ${Math.max(1, options.batchSize)}
        for update skip locked
      )`,
    )
    .returning();
}

/** Release a lease this task still owns, without changing health. */
export async function releaseSourceLease(
  db: DatabaseOrTransaction,
  input: { sourceId: string; leaseOwner: string; nextRunAt: Date; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(catalogSourceConfigs)
    .set({ leaseOwner: null, leaseUntil: null, nextRunAt: input.nextRunAt })
    .where(
      and(
        eq(catalogSourceConfigs.sourceId, input.sourceId),
        eq(catalogSourceConfigs.leaseOwner, input.leaseOwner),
        gt(catalogSourceConfigs.leaseUntil, input.now),
      ),
    )
    .returning({ id: catalogSourceConfigs.id });
  return rows.length === 1;
}

/**
 * Project the three coarse rights onto the registry row.
 *
 * The ONLY writer of those columns for a configured source, and the deferred
 * constraint trigger is what makes that true rather than conventional: any
 * commit leaving them out of step with `resolveSourceRights` is refused, so a
 * second writer would announce itself immediately instead of drifting.
 */
export async function projectSourceRights(
  db: DatabaseOrTransaction,
  input: {
    sourceId: string;
    mayDisplay: boolean;
    mayStore: boolean;
    attributionRequired: boolean;
  },
): Promise<void> {
  await db
    .update(catalogSources)
    .set({
      mayDisplay: input.mayDisplay,
      mayStore: input.mayStore,
      attributionRequired: input.attributionRequired,
    })
    .where(eq(catalogSources.id, input.sourceId));
}
