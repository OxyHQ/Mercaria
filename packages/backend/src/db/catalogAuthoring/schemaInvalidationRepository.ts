/**
 * The transactional cache register (#367 step 5, ADR 0007 D10).
 *
 * ONE table, two operations: bump a subject's revision inside somebody's
 * transaction, and read the revisions a composition depends on. There is no
 * dispatcher and no listener, deliberately — see the schema file's header for
 * why a revision read INTO the cache key beats an outbox with a delivery window.
 *
 * ## `bumpAuthoringSchemaInvalidation` is the seam other domains call
 *
 * It takes a transaction handle and returns nothing. A writer that changes a
 * controlled value set, a localization or a category calls it in the SAME
 * transaction as the change, so a cache entry composed before the commit is
 * unreachable the instant it lands, in every task at once.
 *
 * Today the authoring domain is its only caller, and that is stated rather than
 * hidden: the composition additionally never memoizes anything that is not
 * frozen by somebody else's trigger, so an un-bumped subject cannot produce a
 * stale answer — it can only produce a slower one. Closing the seam is one call
 * per writer, in that writer's own file.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuthoringInvalidationSubject } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { catalogAuthoringSchemaInvalidations } from '../schema/catalogAuthoring.js';

export type CatalogAuthoringInvalidationRow =
  typeof catalogAuthoringSchemaInvalidations.$inferSelect;

/** One thing a composition depends on. */
export interface AuthoringInvalidationRef {
  readonly subject: AuthoringInvalidationSubject;
  readonly subjectId: string;
}

/**
 * Bump one subject's revision, creating the register row if this is its first.
 *
 * `ON CONFLICT DO UPDATE` referencing the EXISTING row (`revision + 1`), never
 * `excluded.revision` — which would write the literal 1 the insert proposed and
 * silently reset a counter that had reached 40. The `offer_outboxes` enqueue
 * makes the same choice for the same reason.
 */
export async function bumpAuthoringSchemaInvalidation(
  db: DatabaseOrTransaction,
  ref: AuthoringInvalidationRef,
): Promise<void> {
  await db
    .insert(catalogAuthoringSchemaInvalidations)
    .values({ subject: ref.subject, subjectId: ref.subjectId, revision: 1 })
    .onConflictDoUpdate({
      target: [
        catalogAuthoringSchemaInvalidations.subject,
        catalogAuthoringSchemaInvalidations.subjectId,
      ],
      set: { revision: sql`${catalogAuthoringSchemaInvalidations.revision} + 1` },
    });
}

/**
 * The revisions of the subjects a composition is about to read.
 *
 * ONE statement whatever the subject count. A subject with no row has never been
 * invalidated, and the caller reads that as revision 0 — an ABSENT register row
 * and a revision of 1 are different states, and conflating them would make the
 * first bump invisible to every entry composed before it.
 */
export async function readAuthoringSchemaRevisions(
  db: DatabaseOrTransaction,
  refs: readonly AuthoringInvalidationRef[],
): Promise<Map<string, number>> {
  const revisions = new Map<string, number>();
  if (refs.length === 0) return revisions;

  const subjects = [...new Set(refs.map((ref) => ref.subject))];
  const subjectIds = [...new Set(refs.map((ref) => ref.subjectId))];

  // Narrowed on BOTH columns rather than on the id alone: two subjects can name
  // the same row (a category is both a `category` subject and, through its
  // localizations, a `localization` one), and reading the cross product would
  // put another subject's revision into this one's key.
  const rows = await db
    .select()
    .from(catalogAuthoringSchemaInvalidations)
    .where(
      and(
        inArray(catalogAuthoringSchemaInvalidations.subject, subjects),
        inArray(catalogAuthoringSchemaInvalidations.subjectId, subjectIds),
      ),
    );

  const wanted = new Set(refs.map((ref) => invalidationKey(ref)));
  for (const row of rows) {
    const key = invalidationKey({ subject: row.subject, subjectId: row.subjectId });
    if (!wanted.has(key)) continue;
    revisions.set(key, row.revision);
  }
  return revisions;
}

/** The stable string a revision map is keyed by. */
export function invalidationKey(ref: AuthoringInvalidationRef): string {
  return `${ref.subject}:${ref.subjectId}`;
}

/** One subject's revision — the operator read, and nothing composes from it. */
export async function findAuthoringSchemaRevision(
  db: DatabaseOrTransaction,
  ref: AuthoringInvalidationRef,
): Promise<CatalogAuthoringInvalidationRow | null> {
  const rows = await db
    .select()
    .from(catalogAuthoringSchemaInvalidations)
    .where(
      and(
        eq(catalogAuthoringSchemaInvalidations.subject, ref.subject),
        eq(catalogAuthoringSchemaInvalidations.subjectId, ref.subjectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
