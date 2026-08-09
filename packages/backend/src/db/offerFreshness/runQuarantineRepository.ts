/**
 * Reads and writes for `catalog_source_run_quarantines` (#68 anomaly 2, 4, 5).
 *
 * ## A quarantine is opened once per (run, kind) and never deleted
 *
 * `ON CONFLICT DO UPDATE` on the run/kind unique so a run whose second page
 * trips the same detector converges on one finding rather than a row per page.
 * There is no delete anywhere in this module and no UPDATE that clears the
 * finding: resolving one ADDS the verdict, the actor and the date beside it,
 * because "we published this after all" and "the feed came back into range" are
 * the two facts an incident review needs and both are destroyed by an UPDATE
 * that tidies the row away.
 *
 * ## Releasing is a decision and correcting is an observation
 *
 * `catalog_source_run_quarantines_actor_shape_check` makes the actor MANDATORY
 * on a release and FORBIDDEN on a correction, so the two cannot be told apart
 * by a note somebody wrote. That is #68 anomaly 4 — "require an explicit
 * release or a corrected run" — held at the row rather than in the service.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { CatalogSourceAnomalyKind, SourceAnomalyFinding } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  OFFER_FRESHNESS_MAX_TEXT_LENGTH,
  catalogSourceRunQuarantines,
} from '../schema/offerFreshness.js';

export type CatalogSourceRunQuarantineRow = typeof catalogSourceRunQuarantines.$inferSelect;

/** Open (or converge on) one finding against one run. */
export async function openRunQuarantine(
  db: DatabaseOrTransaction,
  input: {
    runId: string;
    sourceId: string;
    finding: SourceAnomalyFinding;
    heldObjects: number;
    now: Date;
  },
): Promise<CatalogSourceRunQuarantineRow> {
  const rows = await db
    .insert(catalogSourceRunQuarantines)
    .values({
      runId: input.runId,
      sourceId: input.sourceId,
      kind: input.finding.kind,
      observedValue: input.finding.observed,
      baselineValue: input.finding.baseline,
      detail: input.finding.detail.slice(0, OFFER_FRESHNESS_MAX_TEXT_LENGTH),
      heldObjects: input.heldObjects,
    })
    .onConflictDoUpdate({
      target: [catalogSourceRunQuarantines.runId, catalogSourceRunQuarantines.kind],
      set: {
        // The newest statistic wins — a later page's distribution is the more
        // complete measurement of the same pass.
        observedValue: sql`excluded.observed_value`,
        baselineValue: sql`excluded.baseline_value`,
        detail: sql`excluded.detail`,
        // Held objects ACCUMULATE across pages: each page holds its own, and the
        // number an operator needs is how many this finding has kept out
        // altogether, not how many the last page contributed.
        heldObjects: sql`${catalogSourceRunQuarantines.heldObjects} + excluded.held_objects`,
        updatedAt: input.now,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error(`catalog_source_run_quarantines insert for ${input.runId} returned nothing.`);
  return row;
}

/** Every OPEN finding for one source — the quarantine board. */
export async function listOpenRunQuarantines(
  db: DatabaseOrTransaction = getDb(),
  input: { sourceId: string; limit: number },
): Promise<CatalogSourceRunQuarantineRow[]> {
  return db
    .select()
    .from(catalogSourceRunQuarantines)
    .where(
      and(
        eq(catalogSourceRunQuarantines.sourceId, input.sourceId),
        isNull(catalogSourceRunQuarantines.resolution),
      ),
    )
    .orderBy(desc(catalogSourceRunQuarantines.createdAt))
    .limit(input.limit);
}

/** How many findings are still OPEN for one source — the board's headline. */
export async function countOpenRunQuarantines(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(catalogSourceRunQuarantines)
    .where(
      and(
        eq(catalogSourceRunQuarantines.sourceId, sourceId),
        isNull(catalogSourceRunQuarantines.resolution),
      ),
    );
  return rows[0]?.total ?? 0;
}

/** Whether this run has any finding still open — the publication gate's read. */
export async function runHasOpenQuarantine(
  db: DatabaseOrTransaction,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: catalogSourceRunQuarantines.id })
    .from(catalogSourceRunQuarantines)
    .where(
      and(
        eq(catalogSourceRunQuarantines.runId, runId),
        isNull(catalogSourceRunQuarantines.resolution),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Which anomaly kinds this source has been quarantined for, and how often. */
export async function countQuarantinesByKind(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<Partial<Record<CatalogSourceAnomalyKind, number>>> {
  const rows = await db
    .select({
      kind: catalogSourceRunQuarantines.kind,
      total: sql<number>`count(*)::int`,
    })
    .from(catalogSourceRunQuarantines)
    .where(eq(catalogSourceRunQuarantines.sourceId, sourceId))
    .groupBy(catalogSourceRunQuarantines.kind);

  const counts: Partial<Record<CatalogSourceAnomalyKind, number>> = {};
  for (const row of rows) counts[row.kind] = row.total;
  return counts;
}

/**
 * An operator publishes a quarantined run's output, on the record.
 *
 * A CAS on `resolution is null`, so two operators clicking at once produce one
 * release and the loser is told nothing changed — rather than a second row
 * claiming a different person released it.
 */
export async function releaseRunQuarantine(
  db: DatabaseOrTransaction,
  input: { id: string; actorOxyUserId: string; note: string | null; now: Date },
): Promise<CatalogSourceRunQuarantineRow | undefined> {
  const rows = await db
    .update(catalogSourceRunQuarantines)
    .set({
      resolution: 'released',
      resolvedAt: input.now,
      resolvedByOxyUserId: input.actorOxyUserId,
      resolutionNote: input.note === null ? null : input.note.slice(0, OFFER_FRESHNESS_MAX_TEXT_LENGTH),
      updatedAt: input.now,
    })
    .where(
      and(eq(catalogSourceRunQuarantines.id, input.id), isNull(catalogSourceRunQuarantines.resolution)),
    )
    .returning();
  return rows[0];
}

/**
 * A later run published a distribution the detectors accept — the OTHER way a
 * quarantine ends (#68 anomaly 4).
 *
 * Scoped to one source and one kind, because a feed whose currency came back
 * has not thereby answered a mass-disappearance finding. It names no actor, and
 * the CHECK is what makes that structural rather than an omission: a correction
 * attributed to a person would be indistinguishable from a release afterwards,
 * and a release is somebody taking responsibility for publishing something the
 * detectors did not believe.
 */
export async function correctRunQuarantines(
  db: DatabaseOrTransaction,
  input: { sourceId: string; kind: CatalogSourceAnomalyKind; note: string; now: Date },
): Promise<number> {
  const rows = await db
    .update(catalogSourceRunQuarantines)
    .set({
      resolution: 'corrected',
      resolvedAt: input.now,
      resolutionNote: input.note.slice(0, OFFER_FRESHNESS_MAX_TEXT_LENGTH),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(catalogSourceRunQuarantines.sourceId, input.sourceId),
        eq(catalogSourceRunQuarantines.kind, input.kind),
        isNull(catalogSourceRunQuarantines.resolution),
      ),
    )
    .returning({ id: catalogSourceRunQuarantines.id });
  return rows.length;
}
