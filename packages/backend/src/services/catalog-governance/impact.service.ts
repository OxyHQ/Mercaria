/**
 * Impact counts, measured BEFORE a move, merge or deprecation
 * (#367 Workstream 12).
 *
 * One `count(*)` per relation `impact-plan.ts` declares, run against the real
 * index, with the plan's disposition carried beside each number so the report
 * says what will happen to the rows and not only how many there are.
 *
 * ## The vacuity floor is the ROW COUNT and never the sum
 *
 * Twenty relations counted, all zero, is a legitimate and useful answer: it
 * means nothing points at this category and the change is free. Zero relations
 * counted is a different fact entirely, and the two produce the same total. So
 * the floor asserted here — and again in `insertChangeRequest`, and again by
 * the `impact_relations_counted >= impact_relations_declared` CHECK — is the
 * number of MEASUREMENTS, which a read that never ran cannot fake.
 *
 * The reason this needs saying three times is that the failure is silent and
 * arrives late. `0 = 0 + 0 + 0` satisfied a sum check and told an operator a
 * job was finished; the same arithmetic here would tell them a merge was safe.
 *
 * ## A refusal is a measurement too
 *
 * `measureImpact` never throws on a database failure and never returns a
 * partial report as if it were whole. A relation whose count fails takes the
 * WHOLE report to `unmeasured` with a reason, because eighteen counts out of
 * twenty is the shape that reads as a small change. An `unmeasured` plan can be
 * recorded — an operator should be able to see what was attempted — and
 * `catalog_governance_change_requests_unmeasured_not_applied_check` makes it
 * unable to execute.
 */

import { count, inArray } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type {
  CatalogGovernanceCountedSubjectKind,
  CatalogGovernanceImpactCount,
  CatalogGovernanceImpactReport,
  CatalogGovernanceSubjectKind,
} from '@mercaria/shared-types';
import { CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  GOVERNED_REFERENCE_PLAN,
  declaredRelationCount,
  referenceColumnName,
  referenceTableName,
  rewirePathsMissing,
  type GovernedReference,
} from './impact-plan.js';
import { countedSubjectIds, type ImpactSubjects } from './impact-subjects.js';

/**
 * Whether a subject kind is one the plan counts.
 *
 * The type predicate is load-bearing, and MEASURED to be so under this
 * package's own compiler settings rather than assumed: replacing
 * `kind is CatalogGovernanceCountedSubjectKind` with a plain `boolean` return
 * fails `tsc` with three `TS2345`s, at the `declaredRelationCount` and
 * `rewirePathsMissing` calls that take the narrower union.
 *
 * The part worth knowing is WHERE it does not fail. `GOVERNED_REFERENCE_PLAN[kind]`
 * — indexing a `Record` over the narrow union with the WIDE one — raises
 * nothing: `packages/backend` compiles with `strict: false` and no
 * `noUncheckedIndexedAccess`, so that expression is typed as a present value
 * and is `undefined` at run time. The guard is what stops an uncountable
 * subject kind reaching it; the two helper calls beside it are what make
 * removing the guard a build failure rather than a silent one.
 */
export function isCountedSubjectKind(
  kind: CatalogGovernanceSubjectKind,
): kind is CatalogGovernanceCountedSubjectKind {
  return (CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS as readonly string[]).includes(kind);
}

/**
 * One relation's row count, over every version this change disturbs.
 *
 * `IN` and not `=`, because a PUBLICATION touches two versions — the one being
 * published and the incumbent the same transaction deprecates. A row points at
 * exactly one definition id, so the union counts each row once and there is no
 * double count to correct for. `impact-subjects.ts` carries why the set is the
 * right subject and why the counts cannot be split per version.
 */
async function countReference(
  db: DatabaseOrTransaction,
  reference: GovernedReference,
  subjectIds: readonly string[],
): Promise<number> {
  const table = reference.column.table as unknown as PgTable;
  const [row] = await db
    .select({ total: count() })
    .from(table)
    .where(inArray(reference.column, [...subjectIds]));
  return Number(row?.total ?? 0);
}

/**
 * Measure everything the change to this subject disturbs.
 *
 * Counts run sequentially rather than through `Promise.all`. Twenty concurrent
 * aggregate reads on one pooled connection are pipelined by postgres.js onto
 * that connection anyway, so the concurrency buys nothing measurable and costs
 * the ability to name which relation failed.
 *
 * The report's `subjectId` is the CHANGE's subject — what the request row
 * stores and what `reportFromStoredRows` rebuilds from — while the counts
 * cover `countedSubjectIds(subjects)`. The two agree for every action but the
 * two publications, and for those the difference is recorded on the
 * `change_requested` audit event rather than in a report field that could not
 * survive a re-read. See `impact-subjects.ts`.
 */
export async function measureImpact(
  subjectKind: CatalogGovernanceSubjectKind,
  subjects: ImpactSubjects,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogGovernanceImpactReport> {
  const subjectId = subjects.subjectId;
  const countedIds = countedSubjectIds(subjects);

  if (!isCountedSubjectKind(subjectKind)) {
    // A snapshot restore and a vertical package apply are planned by DIFFING
    // against what is stored, not by counting inbound references — there is no
    // FK pointing at either. Reporting zero relations here would be a report
    // saying the change touches nothing.
    return {
      subjectKind,
      subjectId,
      coverage: 'unmeasured',
      relationsDeclared: 0,
      relationsCounted: 0,
      counts: [],
      total: 0,
      rewirePathsMissing: [],
      unmeasuredReason: `${subjectKind} has no inbound references to count; its plan is a diff against the stored document.`,
    };
  }

  const references = GOVERNED_REFERENCE_PLAN[subjectKind];
  const declared = declaredRelationCount(subjectKind);
  const counts: CatalogGovernanceImpactCount[] = [];

  for (const reference of references) {
    let rowCount: number;
    try {
      rowCount = await countReference(db, reference, countedIds);
    } catch (error) {
      const key = `${referenceTableName(reference)}.${referenceColumnName(reference)}`;
      log.general.error(
        { subjectKind, subjectId, reference: key, err: error },
        'catalog governance impact count failed',
      );
      // The whole report, not this relation. Eighteen of twenty is the shape
      // that reads as a small change, and an operator has no way to see the
      // difference between a relation that counted zero and one that failed.
      return {
        subjectKind,
        subjectId,
        coverage: 'unmeasured',
        relationsDeclared: declared,
        relationsCounted: 0,
        counts: [],
        total: 0,
        rewirePathsMissing: [],
        unmeasuredReason: `Counting ${key} failed, so this report would have been ${String(
          counts.length,
        )} of ${String(declared)} relations. A partial count reads as a small change.`,
      };
    }

    counts.push({
      referenceTable: referenceTableName(reference),
      referenceColumn: referenceColumnName(reference),
      disposition: reference.disposition,
      rowCount,
    });
  }

  return {
    subjectKind,
    subjectId,
    coverage: 'measured',
    relationsDeclared: declared,
    relationsCounted: counts.length,
    counts,
    total: counts.reduce((sum, entry) => sum + entry.rowCount, 0),
    rewirePathsMissing: rewirePathsMissing(subjectKind),
  };
}

/**
 * How many of the counted rows nothing will rewire.
 *
 * Reported beside the total rather than folded into it: "1,240 affected" and
 * "1,240 affected, none of them rewired" are the same number and opposite
 * decisions.
 */
export function unrewiredRowCount(report: CatalogGovernanceImpactReport): number {
  return report.counts
    .filter((entry) => entry.disposition === 'rewire_path_missing')
    .reduce((sum, entry) => sum + entry.rowCount, 0);
}

/**
 * The threshold above which a change needs a second pair of eyes.
 *
 * A code constant and not an environment variable, for the reason
 * `CURATION_LARGE_MERGE_IMPACT_THRESHOLD` is one: it is a policy about when a
 * catalogue change is large, and a deployment able to set it to a million would
 * be a deployment able to switch four-eyes off without saying so — while
 * `CATALOG_FOUR_EYES_REQUIRED` says so in one place, which is the lever the
 * epic names.
 */
export const GOVERNANCE_HIGH_IMPACT_THRESHOLD = 50;

/**
 * Whether this change needs two people.
 *
 * Reads `CATALOG_FOUR_EYES_REQUIRED` — the flag #55 and #59 already read, and
 * deliberately not a second one. The result is SNAPSHOTTED onto the request at
 * plan time by `change-request.service.ts`: the threshold and the flag both
 * move, and a request whose approval requirement changed after somebody
 * approved it would either strand a legitimate change or let an unapproved one
 * through. `catalog_merge_jobs` reached the same place for the same reason.
 *
 * An UNMEASURED report needs a second approval whatever the total says, because
 * "we could not measure it" is not evidence that it is small. It cannot be
 * applied at all, so the approval is what an operator has to obtain before
 * re-planning — but recording it as low-impact would put an unmeasurable change
 * in the same bucket as a free one.
 */
export function requiresSecondApproval(
  report: CatalogGovernanceImpactReport,
  fourEyesRequired: boolean,
): boolean {
  if (!fourEyesRequired) return false;
  if (report.coverage === 'unmeasured') return true;
  return report.total >= GOVERNANCE_HIGH_IMPACT_THRESHOLD;
}

/** Rebuild a report from its stored rows, for a read of a request planned earlier. */
export function reportFromStoredRows(
  subjectKind: CatalogGovernanceSubjectKind,
  subjectId: string,
  coverage: 'measured' | 'unmeasured',
  relationsDeclared: number,
  counts: readonly CatalogGovernanceImpactCount[],
  unmeasuredReason: string | null,
): CatalogGovernanceImpactReport {
  return {
    subjectKind,
    subjectId,
    coverage,
    relationsDeclared,
    relationsCounted: counts.length,
    counts,
    total: counts.reduce((sum, entry) => sum + entry.rowCount, 0),
    rewirePathsMissing: isCountedSubjectKind(subjectKind) ? rewirePathsMissing(subjectKind) : [],
    unmeasuredReason: unmeasuredReason ?? undefined,
  };
}
