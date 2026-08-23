import { describe, expect, it } from 'vitest';
import {
  CATALOG_BACKFILL_PRODUCER_TERMINAL_CAUSES,
  CATALOG_BACKFILL_TERMINAL_CAUSES,
} from '@mercaria/shared-types';
import {
  backfillCauseCountsAgree,
  type BackfillRunTally,
} from '../../catalog-observability/queries';

/**
 * The terminal-cause vocabulary and the conserved total over it.
 *
 * Neither half is about the database, which is why this is a plain unit file
 * beside the realdb one: the vocabulary is a pair of tuples that can drift apart
 * in a text editor, and `backfillCauseCountsAgree` is arithmetic that a mocked
 * repository could never exercise wrongly.
 */

const tally = (over: Partial<BackfillRunTally>): BackfillRunTally => ({
  total: 0,
  completed: 0,
  failed: 0,
  running: 0,
  pending: 0,
  paused: 0,
  retryExhausted: 0,
  operatorCancelled: 0,
  unrecorded: 0,
  causeMissing: 0,
  ...over,
});

describe('the terminal-cause vocabulary', () => {
  it('every producer cause is a real cause', () => {
    for (const cause of CATALOG_BACKFILL_PRODUCER_TERMINAL_CAUSES) {
      expect(CATALOG_BACKFILL_TERMINAL_CAUSES, `${cause} is not in the stored vocabulary`).toContain(
        cause,
      );
    }
  });

  it('no producer may write `unrecorded`', () => {
    // `unrecorded` describes rows the MIGRATION classified — runs that ended
    // before the column existed. A producer able to write it could file a run
    // whose cause is perfectly well known under "we do not know", and the
    // dead-letter count would drop without anything looking wrong.
    expect(CATALOG_BACKFILL_PRODUCER_TERMINAL_CAUSES).not.toContain('unrecorded');
    // The positive control: the value IS in the stored vocabulary, so the
    // assertion above is about the split and not about a typo that would make
    // any `not.toContain` pass.
    expect(CATALOG_BACKFILL_TERMINAL_CAUSES).toContain('unrecorded');
  });

  it('the producer set is exactly the two producers of `failed`', () => {
    // An EXACT set, not containment. `failed` has two producers today —
    // `recordBackfillPageFailure` at the ceiling and `cancelCatalogBackfillRun`
    // — and a third arriving without a decision about what it means is the
    // failure this whole column exists to prevent. Adding one here is that
    // decision; the union type in `releaseBackfillRun` is what forces somebody
    // to come and take it.
    expect([...CATALOG_BACKFILL_PRODUCER_TERMINAL_CAUSES].sort()).toEqual([
      'operator_cancelled',
      'retry_exhausted',
    ]);
  });
});

describe('backfillCauseCountsAgree', () => {
  it('agrees when the four causes account for every failed run', () => {
    expect(
      backfillCauseCountsAgree(
        tally({ failed: 6, retryExhausted: 3, operatorCancelled: 2, unrecorded: 1 }),
      ),
    ).toBe(true);
  });

  it('agrees on an empty table, which is the ordinary case', () => {
    expect(backfillCauseCountsAgree(tally({}))).toBe(true);
  });

  it('DISAGREES when a failed run is unaccounted for', () => {
    // The direction that matters. A cause added to the CHECK tuple and not to
    // the tally query lands here: the dead-letter count would be quietly LOW,
    // and no threshold on the number itself could ever notice a number that is
    // too small. The collector refuses the reading rather than publishing it.
    expect(backfillCauseCountsAgree(tally({ failed: 4, retryExhausted: 3 }))).toBe(false);
  });

  it('DISAGREES when the causes exceed the failed population', () => {
    // The other direction, which a `>=` floor would have admitted: it means the
    // cause filters and the status filter disagree about what `failed` is.
    expect(
      backfillCauseCountsAgree(tally({ failed: 1, retryExhausted: 1, operatorCancelled: 1 })),
    ).toBe(false);
  });

  it('counts `cause_missing` toward the total, so a mid-rollout table still agrees', () => {
    // Rows the PREVIOUS image wrote during the rollout window carry no cause.
    // They are a real part of `failed`, so leaving them out of the identity
    // would make the agreement check fail on every deployment mid-rollout —
    // turning the instrument off at exactly the moment its bucket matters.
    expect(backfillCauseCountsAgree(tally({ failed: 3, retryExhausted: 1, causeMissing: 2 }))).toBe(
      true,
    );
  });
});
