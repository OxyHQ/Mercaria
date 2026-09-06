/**
 * `discovery_signals` — the WRITE side. Its only caller is the sweep.
 *
 * Split from the read repository because they share no statement and sit on
 * different paths: this one runs on a timer and rewrites whole scopes, the
 * reader runs on every request and reads one indexed slice.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { DiscoverySubjectType, DiscoveryWindow } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { discoverySignals } from '../schema/discovery.js';

/** One counted subject in one scope. The window and timestamp are per run. */
export interface DiscoverySignalInput {
  subjectType: DiscoverySubjectType;
  subjectId: string;
  categoryId: string;
  unitsSold: number;
  orderCount: number;
  viewCount: number;
}

export interface ReplaceWindowInput {
  window: DiscoveryWindow;
  /**
   * The scopes this call OWNS. Every existing row in these scopes is removed
   * and replaced by `rows`; every other scope is untouched.
   *
   * Explicit rather than derived from `rows`, because a scope whose subjects
   * have all gone must end up EMPTY, and a scope derived from an empty input
   * is no scope at all.
   */
  scopeCategoryIds: string[];
  rows: DiscoverySignalInput[];
  computedAt: Date;
}

/**
 * Replace the given scopes' rows for one window, atomically.
 *
 * DELETE + INSERT in one transaction rather than an upsert plus a cleanup:
 * Postgres MVCC makes the pair invisible to readers until it commits, so no
 * request ever sees a half-written window, and a subject that stopped selling
 * disappears instead of keeping last month's figure forever.
 *
 * @returns how many rows were inserted.
 */
export async function replaceWindow(input: ReplaceWindowInput): Promise<number> {
  const db = getDb();
  if (input.scopeCategoryIds.length === 0) {
    return 0;
  }

  return db.transaction(async (tx) => {
    await tx
      .delete(discoverySignals)
      .where(
        and(
          eq(discoverySignals.window, input.window),
          inArray(discoverySignals.categoryId, input.scopeCategoryIds),
        ),
      );

    if (input.rows.length === 0) {
      return 0;
    }

    const inserted = await tx
      .insert(discoverySignals)
      .values(
        input.rows.map((row) => ({
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          categoryId: row.categoryId,
          window: input.window,
          unitsSold: row.unitsSold,
          orderCount: row.orderCount,
          viewCount: row.viewCount,
          computedAt: input.computedAt,
        })),
      )
      .returning({ id: discoverySignals.id });

    return inserted.length;
  });
}
