/**
 * `catalog_consistency_findings` — the two-way sweep's durable output (#60 job
 * behaviour 6, acceptance 6).
 *
 * `payment_discrepancies`, ported, and the port keeps its two defining
 * properties:
 *
 * - **A finding CONVERGES rather than accumulating.** `openFinding` is an upsert
 *   on the partial unique `(kind, subject_key) WHERE resolved_at IS NULL`, so a
 *   sweep running hourly against an unfixed problem moves `last_seen_at` and
 *   writes nothing else.
 * - **A finding RESOLVES by being re-examined and found consistent**, never by
 *   being deleted. {@link resolveFindingsForSubject} is what a page calls for
 *   every subject it examined and found in agreement, which is why "how long was
 *   this broken" stays answerable after the fix.
 *
 * The sweep repairs NOTHING, so this repository has no repair operation and no
 * writer of anything but findings — see the schema docblock for why (three of
 * the four kinds can legitimately mean a jury restricted a listing, and "fixing"
 * that would be re-listing it).
 */

import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  CatalogBackfillSubjectKind,
  CatalogConsistencyFindingKind,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  CATALOG_BACKFILL_MAX_TEXT_LENGTH,
  catalogConsistencyFindings,
} from '../schema/backfill.js';

export type CatalogConsistencyFindingRow = typeof catalogConsistencyFindings.$inferSelect;

export interface OpenFindingInput {
  readonly kind: CatalogConsistencyFindingKind;
  readonly subjectKind: CatalogBackfillSubjectKind;
  readonly subjectKey: string;
  readonly detail?: string | null;
  readonly runId?: string | null;
  readonly now?: Date;
}

/**
 * Record that a subject and its offers disagree, or refresh the record that
 * already says so.
 *
 * `first_seen_at` is written only by the INSERT branch and is never touched by
 * the update, so "since when" survives every subsequent pass — the one fact a
 * `DO UPDATE` that reset it would silently destroy.
 */
export async function openConsistencyFinding(
  input: OpenFindingInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .insert(catalogConsistencyFindings)
    .values({
      kind: input.kind,
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      detail: input.detail?.slice(0, CATALOG_BACKFILL_MAX_TEXT_LENGTH) ?? null,
      lastRunId: input.runId ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [catalogConsistencyFindings.kind, catalogConsistencyFindings.subjectKey],
      // The arbiter index is PARTIAL, so the predicate is repeated here or
      // Postgres refuses to infer it (#104's `carts` lesson).
      targetWhere: sql`${catalogConsistencyFindings.resolvedAt} is null`,
      set: {
        lastSeenAt: now,
        detail: input.detail?.slice(0, CATALOG_BACKFILL_MAX_TEXT_LENGTH) ?? null,
        lastRunId: input.runId ?? null,
      },
    });
}

/**
 * Close every open finding about one subject, because this pass examined it and
 * found it consistent.
 *
 * Scoped to the KINDS the caller actually checked: a forward pass that verified
 * "this variant has an offer" has said nothing about the reverse-direction kinds,
 * and resolving those would report a problem fixed that nobody looked at.
 *
 * @returns how many were closed.
 */
export async function resolveConsistencyFindings(
  input: {
    subjectKey: string;
    kinds: readonly CatalogConsistencyFindingKind[];
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (input.kinds.length === 0) return 0;
  const rows = await db
    .update(catalogConsistencyFindings)
    .set({ resolvedAt: input.now ?? new Date() })
    .where(
      and(
        eq(catalogConsistencyFindings.subjectKey, input.subjectKey),
        inArray(catalogConsistencyFindings.kind, [...input.kinds]),
        isNull(catalogConsistencyFindings.resolvedAt),
      ),
    )
    .returning({ id: catalogConsistencyFindings.id });
  return rows.length;
}

/** Open findings, newest sighting first. */
export async function listOpenConsistencyFindings(
  options: { kind?: CatalogConsistencyFindingKind; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogConsistencyFindingRow[]> {
  return db
    .select()
    .from(catalogConsistencyFindings)
    .where(
      options.kind === undefined
        ? isNull(catalogConsistencyFindings.resolvedAt)
        : and(
            isNull(catalogConsistencyFindings.resolvedAt),
            eq(catalogConsistencyFindings.kind, options.kind),
          ),
    )
    .orderBy(desc(catalogConsistencyFindings.lastSeenAt))
    .limit(Math.min(500, Math.max(1, options.limit)));
}

/** How many are open, by kind — the "orphaned offers" half of the metrics. */
export async function countOpenConsistencyFindings(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ kind: CatalogConsistencyFindingKind; open: number }[]> {
  return db
    .select({ kind: catalogConsistencyFindings.kind, open: count() })
    .from(catalogConsistencyFindings)
    .where(isNull(catalogConsistencyFindings.resolvedAt))
    .groupBy(catalogConsistencyFindings.kind);
}
