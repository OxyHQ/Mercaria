/**
 * Stage 2 — `listings.vendor` strings become brand CANDIDATES (ADR 0002 D23
 * phase 1, second clause).
 *
 * The extraction itself is #53's `extractVendorBrandCandidates`, which already
 * groups conservatively, flags ambiguity and records one `source_records` row
 * per group under the backfill's own registry entry. This stage does not
 * re-implement any of it — it DRIVES it and turns its output into report rows,
 * so a vendor group's fate is visible in the same place as every other subject's
 * and the run's counters cover it.
 *
 * **No brand is created here, and no code path in this file could create one.**
 * D23 is explicit that vendor strings are candidates routed to review; the
 * `CanonicalGraphWriter` has no brand method at all, which is why that is a
 * shape rather than a promise.
 *
 * ## This stage refuses a cohort, and the refusal is the honest answer
 *
 * The extraction is an AGGREGATE over the whole `listings` table, and a group's
 * ambiguity is a property of the whole catalogue: "Acme" and "ACME" spelled two
 * ways across two different stores is `multiple_display_forms`, and inside
 * either store alone it looks unambiguous. A cohort-scoped run would therefore
 * produce groups that are not the real groups and flag fewer of them for review
 * — a report that is worse than no report, because it looks like one.
 * `assertStageSupportsCohort` refuses it when the run is OPENED, so an operator
 * finds out before the pass rather than from a suspiciously clean result.
 *
 * ## One page, and why that is not a resumability gap
 *
 * The extraction is a single `GROUP BY` over distinct vendor values, bounded by
 * how many distinct strings sellers have typed rather than by the catalogue's
 * size. There is no cursor to hand back because there is no second page: the
 * pass completes or it fails and is re-run, and re-running is a no-op on an
 * unchanged catalogue because the observation's content hash is derived from
 * catalogue CONTENT alone.
 */

import { extractVendorBrandCandidates } from '../../canonical/vendor-brand-candidate.service.js';
import { findBackfillRecord } from '../../../db/backfill/backfillRecordRepository.js';
import {
  examineSubject,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';
import { addCounters, EMPTY_COUNTERS } from '../../../db/backfill/backfillRunRepository.js';
import { backfillSubjectKey } from '../mapping-version.js';

export async function runVendorBrandCandidatesPage(
  context: StageContext,
): Promise<StagePageResult> {
  const extraction = await extractVendorBrandCandidates();

  let counters = EMPTY_COUNTERS;
  for (const candidate of extraction.candidates) {
    counters = addCounters(
      counters,
      await examineSubject(
        context,
        { kind: 'vendor_value', normalizedName: candidate.normalizedName },
        () => verdictFor(context, candidate),
      ),
    );
  }

  // A single-page pass. The extraction has no cursor because it has no second
  // page — see the module docblock.
  return { counters, nextCursor: null };
}

type Candidate = Awaited<ReturnType<typeof extractVendorBrandCandidates>>['candidates'][number];

async function verdictFor(
  context: StageContext,
  candidate: Candidate,
): Promise<SubjectVerdict> {
  const forms = candidate.displayForms.join(' | ');
  if (candidate.ambiguous) {
    return {
      reasonCode: 'vendor_candidate_ambiguous',
      detail: `${String(candidate.listingCount)} listings; reasons ${candidate.reviewReasons.join(', ')}; forms ${forms}`,
    };
  }

  /**
   * Whether this group has been reported before, read off THIS domain's own
   * ledger rather than off the extraction.
   *
   * `extractVendorBrandCandidates` reports its insert/no-op split in aggregate
   * (`recorded` and `unchanged` totals) and not per group, so asking it which
   * groups were new is a question it cannot answer. The report row can: one
   * exists for this subject under this mapping version and mode exactly when a
   * previous run reported it, which is precisely the converged re-run that
   * `unchanged` names.
   */
  const previous = await findBackfillRecord({
    mappingVersion: context.mappingVersion,
    mode: context.mode,
    stage: context.stage,
    subjectKey: backfillSubjectKey({
      kind: 'vendor_value',
      normalizedName: candidate.normalizedName,
    }),
  });

  /**
   * A clean group is still ONLY a candidate.
   *
   * Neither reason means a brand was created or that review can be skipped —
   * #53's own service docblock makes the same point, and repeating it here is
   * deliberate, because this is the surface an operator reads the counts off.
   */
  return {
    reasonCode: previous === undefined ? 'vendor_candidate_recorded' : 'vendor_candidate_unchanged',
    detail: `${String(candidate.listingCount)} listings; forms ${forms}`,
  };
}
