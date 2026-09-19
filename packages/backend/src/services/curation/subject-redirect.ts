/**
 * Which review-queue SUBJECTS have been merged away, and what they became
 * (#893, epic #367 line 340).
 *
 * ## The gap this fills, and the one it deliberately does not
 *
 * `catalog_review_items.subject_id` is a bare polymorphic reference and
 * `POLYMORPHIC_ENTITY_REFERENCES` records it as `untouched` for a good reason:
 * a review item is the QUESTION somebody was asked about two specific rows, and
 * rehoming either side would silently change the question after the fact. That
 * decision stands. What it leaves behind is measurable and was measured: a merge
 * completes with the item still `open`, still naming the loser, and **nothing in
 * the operator surface says so** — the queue serves `subject_id` and an operator
 * has no way to tell a live entity from a tombstone.
 *
 * So this ANNOTATES and never moves. An item about an entity that has since been
 * merged keeps its subject; the reader is told what that subject became, and the
 * decision — dismiss it, re-raise it against the winner, or act on it as it
 * stands — stays with the person. Following the tombstone in the STORED column
 * would take that decision away; hiding the item would break the house rule that
 * evidence stays readable during the incident that produced it.
 *
 * ## One hop, and that is a property of the merge rather than a simplification
 *
 * `requestMerge` REFUSES a tombstone as the winner ("refuses to merge INTO a
 * tombstone, so resolution stays one hop" — `curation-writes.realdb.test.ts`),
 * so `merged_into_id` always names a live row and there is no chain to walk. A
 * loop here would be dead code pretending to handle a state the merge makes
 * unreachable.
 *
 * ## The predicate is the POINTER, not the status
 *
 * `merged_into_id IS NOT NULL` rather than `status = 'merged'`. Both are true of
 * exactly the same rows — every one of the seven tables carries a CHECK making
 * the pointer present exactly when the status is `merged` — and the pointer is
 * the one this read actually needs: it names what the caller will render, so
 * there is no state in which the predicate admits a row with nothing to point
 * at. Filtering on the status and then reading the pointer would be two
 * representations of one fact, which is the shape that disagrees.
 *
 * ## Only a MERGEABLE subject can have a tombstone
 *
 * `CURATION_SUBJECT_TYPES` is thirteen values and six of them are not entities
 * at all — an identifier assertion, a match decision, an observation. Those have
 * no `status`/`merged_into_id` pair to read, so they are skipped rather than
 * queried, and `isMergeableEntityType` is the ONE test for that: a second list
 * of "types with tombstones" would be a second answer to a question
 * `CURATED_ENTITIES` already answers.
 */

import { inArray, and, isNotNull } from 'drizzle-orm';
import {
  isMergeableEntityType,
  type CurationSubjectType,
  type MergeableEntityType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { CURATED_ENTITIES } from './entity-registry.js';

/** One subject that is now a tombstone, and the entity it was merged into. */
export interface CurationSubjectRedirect {
  readonly type: CurationSubjectType;
  readonly id: string;
  /** Always a LIVE entity — see the file header on why there is no chain. */
  readonly mergedIntoId: string;
}

/** The map key. A `(type, id)` pair, because ids are unique per table and not across them. */
export function subjectRedirectKey(type: CurationSubjectType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Of these subjects, which name a merged-away entity.
 *
 * ONE statement per distinct MERGEABLE type present in the input — never one per
 * subject, because the queue read that consumes this is a page of fifty items
 * with two subjects each and a per-row lookup would be a hundred round trips for
 * an annotation.
 *
 * A type with no tombstoned subject contributes nothing, and a subject that is
 * live is simply absent from the map: the caller renders `null`, which is the
 * ordinary case and must not be confused with "not checked". That distinction is
 * the caller's to keep — this function is only ever called for every subject on
 * the page, never for a subset.
 */
export async function findMergedSubjects(
  subjects: readonly { readonly type: CurationSubjectType; readonly id: string }[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, CurationSubjectRedirect>> {
  const byType = new Map<MergeableEntityType, Set<string>>();
  for (const subject of subjects) {
    if (!isMergeableEntityType(subject.type)) continue;
    const ids = byType.get(subject.type) ?? new Set<string>();
    ids.add(subject.id);
    byType.set(subject.type, ids);
  }

  const found = new Map<string, CurationSubjectRedirect>();
  for (const [type, ids] of byType) {
    const definition = CURATED_ENTITIES[type];
    const rows = await db
      .select({
        id: definition.idColumn,
        mergedIntoId: definition.mergedIntoColumn,
      })
      .from(definition.table)
      .where(and(inArray(definition.idColumn, [...ids]), isNotNull(definition.mergedIntoColumn)));
    for (const row of rows) {
      const id = row.id as unknown as string;
      const mergedIntoId = row.mergedIntoId as unknown as string | null;
      // A TYPE NARROWING, not a second predicate, and worth saying so plainly:
      // the `where` above already excludes every null, so this branch is
      // unreachable and a mutation removing either one does not change the
      // answer. It is here because the compiler cannot see a SQL predicate and
      // the backend compiles with `strict: false`, so without it a `null` would
      // flow into a field typed `string` and render as the literal "null" on an
      // operator surface rather than failing.
      if (mergedIntoId === null) continue;
      found.set(subjectRedirectKey(type, id), { type, id, mergedIntoId });
    }
  }
  return found;
}
