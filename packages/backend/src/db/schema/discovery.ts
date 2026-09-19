/**
 * Discovery — `discovery_signals` and `discovery_sweep_cursors`.
 *
 * Two of the five discovery signals cannot be answered from a durable column.
 * `best-selling` is a sum over `order_items`; `most-viewed` is a count over
 * `analytics_events`, whose rows are swept by retention. Counted at request
 * time, a view count would SHRINK on its own as rows expire, with nothing on
 * the page to explain it — so it is written down, before the rows it came from
 * expire, which is the same argument `services/analytics/rollup.ts` makes for
 * its own numbers (data-lifecycle rule 2).
 *
 * ## Only counts. No score, and no rating
 *
 * There is no `score` column. Each shelf orders by ONE column and its title
 * names that column, which is how the reference behaves and what makes two
 * shelves disagreeing readable rather than mysterious. A composite weight would
 * be a ranking nobody can review.
 *
 * `rating` and `review_count` are NOT copied here. `review_aggregates` is "the
 * ONE authority for a scoped rating" and `listings.rating` is already its
 * projection; a third copy is a third place to disagree.
 *
 * ## One row per ANCESTOR
 *
 * `listings.category_id` is a leaf, but shelves are written at every depth
 * ("Bestsellers in Beauty"). The sweep writes a subject once per category on
 * its ancestor chain, so a shelf at any depth is one indexed read instead of a
 * recursive walk joined to a count — and a parent's figure IS its subtree's by
 * construction, rather than by a second query agreeing with the first.
 *
 * The root scope is `''`. Not NULL, for the reason `analytics_rollups` states
 * for the same convention: Postgres treats NULLs as distinct, so a NULLable
 * dimension breaks the bucket unique and lets a row exist that belongs to no
 * scope at all.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  DISCOVERY_SUBJECT_TYPES,
  DISCOVERY_WINDOWS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';

/** A counted subject, in one scope, over one window. Replaced whole per run. */
export const discoverySignals = pgTable(
  'discovery_signals',
  {
    id: generatedId(),
    subjectType: text({ enum: asEnumValues(DISCOVERY_SUBJECT_TYPES) }).notNull(),
    /** A listing id or a store id — polymorphic, so no foreign key. */
    subjectId: text().notNull(),
    /** An ancestor of the subject's category, or `''` for the root scope. */
    categoryId: text().notNull(),
    window: text({ enum: asEnumValues(DISCOVERY_WINDOWS) }).notNull(),
    unitsSold: integer().notNull().default(0),
    orderCount: integer().notNull().default(0),
    viewCount: integer().notNull().default(0),
    /** When the run that wrote this row started. */
    computedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('discovery_signals_subject_type_check', t.subjectType, DISCOVERY_SUBJECT_TYPES),
    checkOneOf('discovery_signals_window_check', t.window, DISCOVERY_WINDOWS),
    // A negative count is not a small number, it is a broken sum.
    check(
      'discovery_signals_counts_check',
      sql`${t.unitsSold} >= 0 and ${t.orderCount} >= 0 and ${t.viewCount} >= 0`,
    ),
    uniqueIndex('discovery_signals_subject_scope_key').on(
      t.subjectType,
      t.subjectId,
      t.categoryId,
      t.window,
    ),
    // One index per shelf, because each shelf sorts by one column.
    index('discovery_signals_units_sold_idx').on(t.categoryId, t.window, t.unitsSold),
    index('discovery_signals_view_count_idx').on(t.categoryId, t.window, t.viewCount),
  ],
);

/**
 * The sweep's lease. One row per job, `analytics_rollup_cursors`' shape.
 *
 * No `last_completed_date`: the window is ROLLING, so a run recomputes the
 * whole of it rather than advancing a day. There is nothing to resume.
 */
export const discoverySweepCursors = pgTable(
  'discovery_sweep_cursors',
  {
    /** The job name. Caller-supplied, so there is exactly one row per job. */
    id: text().primaryKey(),
    leaseOwner: text(),
    leaseExpiresAt: timestamptz(),
    lastRunAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'discovery_sweep_cursors_lease_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseExpiresAt}) in (0, 2)`,
    ),
  ],
);

/** A row of {@link discoverySignals}, as drizzle returns it. */
export type DiscoverySignalRow = typeof discoverySignals.$inferSelect;

/** A row of {@link discoverySweepCursors}. */
export type DiscoverySweepCursorRow = typeof discoverySweepCursors.$inferSelect;
