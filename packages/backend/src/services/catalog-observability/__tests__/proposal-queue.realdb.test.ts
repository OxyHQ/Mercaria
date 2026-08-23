/**
 * The proposal queue's depth, aging and SLA visibility, against a REAL
 * PostgreSQL server (#367 W6 — "add proposal queue metrics and aging/SLA
 * visibility").
 *
 * ## What a mocked suite would report here
 *
 * Everything green over statements the server never parsed. The whole read is
 * one `select` carrying eight `count(*) filter` columns per state, five more per
 * age band, three ordered-set `percentile_disc` aggregates and a `max`, all
 * against `now()` — a stubbed `execute` evaluates none of them, and the shapes
 * this file grades (a band a row really lands in, a percentile that is really an
 * observed value) would be graded against numbers the test itself supplied.
 *
 * ## Two halves, and the split is a limitation stated rather than hidden
 *
 * The database is SHARED with parallel files and `catalog_proposals` has no
 * tenant predicate, so this file can only ever ADD to a population it does not
 * control. That is fine for everything that is a delta or an identity, and it is
 * impossible for the one property that needs a SMALL population: the
 * waiting-age percentiles are withheld below
 * `CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION`, and nothing here can drive the
 * shared queue below twenty open rows.
 *
 * So the refusal branch is driven through `deriveProposalQueueAging`, which is
 * PURE and takes a tally — the same function the route calls, one argument
 * earlier. The measured branch is driven here, by inserting enough rows to
 * cross the floor from wherever the database happens to be.
 *
 * ## Every assertion is a DELTA or an identity, and `now()` is why the exact
 * ones can be exact
 *
 * The fixture runs inside a rolled-back `repeatable read` transaction. Postgres
 * `now()` is TRANSACTION START, so the aggregate under test and the oracle query
 * beside it see the same instant — which is what lets an age be pinned to the
 * second rather than to a tolerance, and what makes "the reported maximum IS the
 * largest open age" an equality rather than a bound.
 *
 * Rolling back also means no row this file writes is visible to a sibling and
 * there is no teardown to get wrong, which matters because `catalog_proposals`
 * is `restrict` from three directions.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  CATALOG_PROPOSAL_AGE_BANDS,
  CATALOG_PROPOSAL_OPEN_STATES,
  CATALOG_PROPOSAL_STATES,
  CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION,
  type CatalogProposalState,
} from '@mercaria/shared-types';
import {
  closePostgres,
  connectPostgres,
  type Database,
  type Transaction,
} from '../../../db/postgres.js';
import { deriveProposalQueueAging, readProposalQueueAging } from '../proposal-queue.js';
import { tallyProposals, type ProposalTally } from '../queries.js';

const db: Database = await connectPostgres();

afterAll(async () => {
  await closePostgres();
});

/** Every id this file mints, so a stray commit would be identifiable as ours. */
const FIXTURE_PREFIX = 'obs-queue';

const HOUR = 3_600;
const DAY = 24 * HOUR;

/** Thrown to roll a fixture transaction back. Never escapes the helper. */
class RolledBack extends Error {}

/**
 * Run `work` inside a rolled-back `repeatable read` transaction.
 *
 * `repeatable read` for `metrics.realdb.test.ts`'s reason, measured there: every
 * assertion inside is a delta, and at `read committed` a parallel file's commit
 * between the two readings is indistinguishable from this file's own insert. The
 * callback parameter is named `tx` deliberately — `advisory-lock-census.ts`
 * classifies a handle as transactional by name.
 */
async function rolledBack<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  let captured: T;
  try {
    await db.transaction(
      async (tx) => {
        captured = await work(tx);
        throw new RolledBack('fixture transaction rolled back deliberately');
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return captured;
}

/** One fixture row. `ageSeconds` is relative to the transaction's own `now()`. */
interface Fixture {
  readonly suffix: string;
  readonly state: CatalogProposalState;
  readonly ageSeconds: number;
  /** Seconds from `now()`; positive is a deferral still ahead. Deferred rows only. */
  readonly deferUntilSeconds?: number;
}

/**
 * The fixture set.
 *
 * ## Why twenty-five open rows and not three
 *
 * `CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION` is twenty, and this file cannot
 * lower the shared queue below it — so it raises it above, unconditionally,
 * which is the only direction available. Twenty-five leaves the measured branch
 * reachable whatever the database already held.
 *
 * ## Why the ages are exact multiples of a day
 *
 * Each one is written as `now() - interval`, and `now()` is transaction start,
 * so `extract(epoch from (now() - created_at))` is that interval to the second.
 * A band assertion is then an exact delta rather than "roughly the right
 * bucket", and a row one second from a boundary is a deliberate choice rather
 * than a race.
 *
 * ## The future-dated row
 *
 * `ageSeconds: -HOUR` is a proposal whose `created_at` is an hour from now,
 * which is what a clock fault looks like — the failure that produced
 * `observed_at > now` on every ingested record in #63 and #65 and hid as a
 * per-record parse failure. It falls in NO band, so it is what
 * `unbandedOpenCount` is for, and it is inserted here rather than described in a
 * comment because a health flag nobody has ever seen fire is one nobody trusts.
 */
const FIXTURES: readonly Fixture[] = [
  // under_1d — 8 open
  ...Array.from({ length: 8 }, (_, i) => ({
    suffix: `u${String(i)}`,
    state: 'submitted' as const,
    ageSeconds: HOUR,
  })),
  // 1d_to_3d — 5 open
  ...Array.from({ length: 5 }, (_, i) => ({
    suffix: `a${String(i)}`,
    state: 'submitted' as const,
    ageSeconds: 2 * DAY,
  })),
  // 3d_to_7d — 4 open, two of them waiting on the merchant
  { suffix: 'b0', state: 'submitted', ageSeconds: 5 * DAY },
  { suffix: 'b1', state: 'submitted', ageSeconds: 5 * DAY },
  { suffix: 'b2', state: 'needs_information', ageSeconds: 5 * DAY },
  { suffix: 'b3', state: 'needs_information', ageSeconds: 5 * DAY },
  // 7d_to_30d — 5 open, four of them deferred (two still ahead, two lapsed)
  { suffix: 'c0', state: 'needs_information', ageSeconds: 10 * DAY },
  { suffix: 'c1', state: 'deferred', ageSeconds: 10 * DAY, deferUntilSeconds: 3 * DAY },
  { suffix: 'c2', state: 'deferred', ageSeconds: 10 * DAY, deferUntilSeconds: 3 * DAY },
  { suffix: 'c3', state: 'deferred', ageSeconds: 10 * DAY, deferUntilSeconds: -2 * DAY },
  { suffix: 'c4', state: 'deferred', ageSeconds: 10 * DAY, deferUntilSeconds: -2 * DAY },
  // over_30d — 3 open, including the oldest thing in the database
  { suffix: 'd0', state: 'submitted', ageSeconds: 60 * DAY },
  { suffix: 'd1', state: 'needs_information', ageSeconds: 60 * DAY },
  { suffix: 'd2', state: 'submitted', ageSeconds: OLDEST_AGE_SECONDS() },
  // Open, and dated in the FUTURE. Falls in no band.
  { suffix: 'future', state: 'submitted', ageSeconds: -HOUR },
  // Resolved rows: they change the depth-by-state and the decision count, and
  // must change NEITHER the backlog nor any band.
  { suffix: 'r0', state: 'approved', ageSeconds: 20 * DAY },
  { suffix: 'r1', state: 'approved', ageSeconds: 20 * DAY },
  { suffix: 'r2', state: 'rejected', ageSeconds: 20 * DAY },
  { suffix: 'r3', state: 'withdrawn', ageSeconds: 20 * DAY },
];

/**
 * The age of the single oldest fixture row.
 *
 * Deliberately far older than anything a sibling file plausibly writes, because
 * the maximum-age assertion is an EQUALITY: it says the reported maximum is this
 * row's age exactly, which is only a statement about the read if this row really
 * is the oldest open proposal in the database. It is asserted to be, rather than
 * assumed, by comparing against the oracle's own maximum.
 */
function OLDEST_AGE_SECONDS(): number {
  return 4_000 * DAY;
}

/** How many fixture rows land in each band, computed from the fixtures themselves. */
function expectedBandCounts(): Map<string, number> {
  const counts = new Map<string, number>(CATALOG_PROPOSAL_AGE_BANDS.map((band) => [band.key, 0]));
  const open = new Set<string>(CATALOG_PROPOSAL_OPEN_STATES);
  for (const fixture of FIXTURES) {
    if (!open.has(fixture.state)) continue;
    const band = CATALOG_PROPOSAL_AGE_BANDS.find(
      (candidate) =>
        fixture.ageSeconds >= candidate.fromSeconds
        && (candidate.toSeconds === null || fixture.ageSeconds < candidate.toSeconds),
    );
    if (!band) continue;
    counts.set(band.key, (counts.get(band.key) ?? 0) + 1);
  }
  return counts;
}

/** How many fixture rows land in each state. */
function expectedStateCounts(): Map<string, number> {
  const counts = new Map<string, number>(CATALOG_PROPOSAL_STATES.map((state) => [state, 0]));
  for (const fixture of FIXTURES) {
    counts.set(fixture.state, (counts.get(fixture.state) ?? 0) + 1);
  }
  return counts;
}

async function insertFixtures(tx: Transaction): Promise<void> {
  for (const fixture of FIXTURES) {
    const id = `${FIXTURE_PREFIX}-${fixture.suffix}`;
    const decided = !['submitted', 'needs_information', 'deferred', 'withdrawn'].includes(
      fixture.state,
    );
    await tx.execute(sql`
      insert into catalog_proposals
        (id, type, origin, state, submitted_by_oxy_user_id,
         proposed_label, source_locale, normalized_label, search_label,
         created_at, deferred_until, resolved_entity_id, rejection_reason,
         decided_by_oxy_user_id, decided_at, decision_reason)
      values (
        ${id}, 'brand', 'operator', ${fixture.state},
        ${`${FIXTURE_PREFIX}-submitter`},
        ${`Queue Probe ${fixture.suffix}`}, 'en',
        ${`${FIXTURE_PREFIX} probe ${fixture.suffix}`},
        ${`${FIXTURE_PREFIX} probe ${fixture.suffix}`},
        now() - make_interval(secs => ${fixture.ageSeconds}),
        ${
          fixture.deferUntilSeconds === undefined
            ? sql`null`
            : sql`now() + make_interval(secs => ${fixture.deferUntilSeconds})`
        },
        ${fixture.state === 'approved' ? `${FIXTURE_PREFIX}-entity-${fixture.suffix}` : null},
        ${fixture.state === 'rejected' ? 'out_of_scope' : null},
        ${decided ? `${FIXTURE_PREFIX}-decider` : null},
        ${decided ? sql`now()` : sql`null`},
        ${decided ? 'Queue probe decision' : null}
      )
    `);
  }
}

/**
 * Every OPEN proposal's age, read as plain rows.
 *
 * The oracle for the percentile assertions, and it is deliberately not a second
 * aggregate: it selects the ages and nothing else, so a percentile reported by
 * the subject can be checked for MEMBERSHIP in the set it claims to have been
 * drawn from. That is what "nearest-rank, never interpolated" means, and it is a
 * property no re-implementation of `percentile_disc` in JavaScript would be
 * needed to state.
 */
async function openAges(tx: Transaction): Promise<number[]> {
  const open = sql.join(
    CATALOG_PROPOSAL_OPEN_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  const rows = await tx.execute<{ age: number }>(sql`
    select extract(epoch from (now() - created_at))::double precision as age
    from catalog_proposals
    where state in (${open})
  `);
  return rows.map((row) => Number(row.age));
}

describe('#367 W6 — the proposal queue read, against Postgres', () => {
  it('counts every state, bands every open row and refuses to lose one', async () => {
    await rolledBack(async (tx) => {
      const before = await readProposalQueueAging(tx);
      const beforeTally = await tallyProposals(7 * DAY, tx);
      await insertFixtures(tx);
      const after = await readProposalQueueAging(tx);

      /* ---- Depth by state -------------------------------------------------- */

      // One entry per member of the tuple, in the tuple's ORDER — asserting the
      // order is what says the read walked the vocabulary rather than whatever
      // states happened to have rows. An empty state is a bucket carrying zero,
      // never an absent bucket.
      expect(after.depthByState.map((entry) => entry.state)).toEqual([
        ...CATALOG_PROPOSAL_STATES,
      ]);
      const beforeByState = new Map(before.depthByState.map((e) => [e.state, e.count]));
      const afterByState = new Map(after.depthByState.map((e) => [e.state, e.count]));
      const expectedStates = expectedStateCounts();
      let statesChecked = 0;
      for (const state of CATALOG_PROPOSAL_STATES) {
        expect(
          (afterByState.get(state) ?? 0) - (beforeByState.get(state) ?? 0),
          `${state} did not move by the rows this file inserted`,
        ).toBe(expectedStates.get(state) ?? 0);
        statesChecked += 1;
      }
      // A loop that ran zero times reports zero failures.
      expect(statesChecked).toBe(CATALOG_PROPOSAL_STATES.length);

      // The `open` flag is derived from the shared tuple, not restated.
      for (const entry of after.depthByState) {
        expect(entry.open, `${entry.state}'s open flag disagrees with the tuple`).toBe(
          CATALOG_PROPOSAL_OPEN_STATES.includes(entry.state),
        );
      }

      /* ---- The two totals, and the identity between them ------------------- */

      const openFixtures = FIXTURES.filter((f) =>
        CATALOG_PROPOSAL_OPEN_STATES.includes(f.state),
      ).length;
      expect(after.openDepth - before.openDepth, 'the backlog did not see the open rows').toBe(
        openFixtures,
      );
      expect(after.totalDepth - before.totalDepth, 'the total did not see every row').toBe(
        FIXTURES.length,
      );
      // `countsAgree` compares a `count(*)` against the SUM of the per-state
      // filters, so it is false exactly when a row carries a state this build's
      // tuple does not name. Both readings, because a fixture that introduced
      // one would be this file's own fault and should be visible as such.
      expect(before.countsAgree, 'the database already holds an unknown proposal state').toBe(true);
      expect(after.countsAgree).toBe(true);
      // And the identity that flag stands for, computed here from the answer.
      expect(after.depthByState.reduce((total, e) => total + e.count, 0)).toBe(after.totalDepth);
      expect(
        after.depthByState
          .filter((e) => e.open)
          .reduce((total, e) => total + e.count, 0),
      ).toBe(after.openDepth);

      /* ---- The bands, as a conserved partition ----------------------------- */

      expect(after.agingBands.map((band) => band.key)).toEqual(
        CATALOG_PROPOSAL_AGE_BANDS.map((band) => band.key),
      );
      const beforeBands = new Map(before.agingBands.map((band) => [band.key, band.count]));
      const expectedBands = expectedBandCounts();
      let bandsChecked = 0;
      for (const band of after.agingBands) {
        expect(
          band.count - (beforeBands.get(band.key) ?? 0),
          `${band.key} did not receive the rows this file aged into it`,
        ).toBe(expectedBands.get(band.key) ?? 0);
        bandsChecked += 1;
      }
      expect(bandsChecked).toBe(CATALOG_PROPOSAL_AGE_BANDS.length);
      // The floor for the band assertions themselves: with every expectation
      // zero the loop above is `0 === 0` five times over, which is true and is a
      // measurement of nothing.
      expect(
        [...expectedBands.values()].filter((count) => count > 0).length,
        'the fixture set does not populate several bands, so the partition proved nothing',
      ).toBeGreaterThanOrEqual(4);

      /* ---- The row dated in the future ------------------------------------- */

      // ONE row, and it is the whole reason `unbandedOpenCount` exists. It is
      // open, so it is in `openDepth`; its age is negative, so it is in no band.
      expect(
        after.unbandedOpenCount - before.unbandedOpenCount,
        'a proposal created in the future was silently absorbed into a band',
      ).toBe(1);
      // The independent confirmation: `unbandedOpenCount` is `openDepth` minus
      // the banded total, and the tally counts `age < 0` with a filter of its
      // own. The two are computed from different columns of the same statement
      // and must agree while the bands stay contiguous — a gap opened between
      // two bands is exactly where they would part company.
      const afterTally = await tallyProposals(7 * DAY, tx);
      expect(
        afterTally.openWithFutureCreatedAt - beforeTally.openWithFutureCreatedAt,
        'the negative-age filter and the band subtraction disagree',
      ).toBe(1);
      // …and the two really are separate computations of one fact: the flag is
      // `openDepth` minus the banded total, the tally column is a `where age < 0`
      // filter, and they came out of different columns of the same statement.
      expect(afterTally.openWithFutureCreatedAt).toBe(after.unbandedOpenCount);

      /* ---- Ages, from the row's own clock ---------------------------------- */

      // EXACT, not a tolerance: `now()` is transaction start, so a row created
      // at `now() - interval '4000 days'` has that age to the second for every
      // statement in this transaction.
      expect(after.oldestOpenAgeSeconds).toBe(OLDEST_AGE_SECONDS());
      const submitted = after.depthByState.find((entry) => entry.state === 'submitted');
      expect(submitted?.oldestAgeSeconds, "the oldest 'submitted' age is not the fixture's").toBe(
        OLDEST_AGE_SECONDS(),
      );
      // A state's oldest age is null when it is empty and a number when it is
      // not — never zero, which reads as "perfectly up to date".
      for (const entry of after.depthByState) {
        expect(
          entry.oldestAgeSeconds === null,
          `${entry.state}: count ${String(entry.count)} against age ${String(entry.oldestAgeSeconds)}`,
        ).toBe(entry.count === 0);
      }

      /* ---- Deferred ahead vs deferred at all ------------------------------- */

      // Four deferrals inserted, two of them still ahead. The distinction is the
      // whole point: a planned deferral reads as backlog and this is what lets a
      // reader subtract it.
      expect(
        (afterByState.get('deferred') ?? 0) - (beforeByState.get('deferred') ?? 0),
      ).toBe(4);
      expect(
        after.deferredAheadCount - before.deferredAheadCount,
        'a lapsed deferral was counted as still deferred, or a live one was not',
      ).toBe(2);

      /* ---- The percentiles ------------------------------------------------- */

      // The population is now certainly above the floor, because this file added
      // twenty-two open rows to whatever was there.
      expect(after.openDepth).toBeGreaterThanOrEqual(CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION);
      expect(after.waitAge.state).toBe('measured');
      if (after.waitAge.state !== 'measured') return;

      const ages = await openAges(tx);
      expect(ages.length, 'the oracle read no open rows').toBe(after.openDepth);
      // Nearest-rank: every figure published is an age some open proposal really
      // has. An interpolating percentile would land between two of them and fail
      // this, which is the difference between `percentile_disc` and
      // `percentile_cont` stated as a property rather than as a spelling.
      const observed = new Set(ages);
      for (const [label, value] of [
        ['p50', after.waitAge.p50Seconds],
        ['p90', after.waitAge.p90Seconds],
        ['p95', after.waitAge.p95Seconds],
        ['max', after.waitAge.maxSeconds],
      ] as const) {
        expect(observed.has(value), `${label} (${String(value)}) is not any open row's age`).toBe(
          true,
        );
      }
      expect(after.waitAge.p50Seconds).toBeLessThanOrEqual(after.waitAge.p90Seconds);
      expect(after.waitAge.p90Seconds).toBeLessThanOrEqual(after.waitAge.p95Seconds);
      expect(after.waitAge.p95Seconds).toBeLessThanOrEqual(after.waitAge.maxSeconds);
      // The exact pin. The oldest row this file inserted is far older than
      // anything a sibling writes, so the maximum is a value this file chose —
      // and it is compared against the oracle's own maximum too, which is what
      // makes the premise ("it really is the oldest") an assertion rather than
      // an assumption.
      expect(after.waitAge.maxSeconds).toBe(OLDEST_AGE_SECONDS());
      expect(Math.max(...ages)).toBe(OLDEST_AGE_SECONDS());
      expect(after.waitAge.population).toBe(after.openDepth);

      /* ---- SLA ------------------------------------------------------------- */

      expect(after.sla.state).toBe('undefined_target');
      // The response carries no target of any kind, checked over the REAL
      // emitted object rather than over the type — the #92 two-gate rule, and
      // the half a static scan cannot give.
      const emitted = JSON.stringify(after);
      for (const forbidden of ['targetSeconds', 'breachCount', 'withinTarget', 'deadline']) {
        expect(emitted.includes(forbidden), `the emitted queue reading carries ${forbidden}`).toBe(
          false,
        );
      }

      process.stdout.write(
        `\ncatalog proposal queue: open ${String(before.openDepth)} -> ${String(after.openDepth)}, `
          + `bands ${after.agingBands.map((b) => `${b.key}=${String(b.count)}`).join(' ')}, `
          + `p50/p90/p95 ${String(Math.round(after.waitAge.p50Seconds))}/`
          + `${String(Math.round(after.waitAge.p90Seconds))}/`
          + `${String(Math.round(after.waitAge.p95Seconds))}s, `
          + `unbanded ${String(after.unbandedOpenCount)}, sla ${after.sla.state}\n`,
      );
    });
  });

  it('carries no id, store, submitter or label anywhere in the response', async () => {
    // The privacy half, over a REAL emitted reading rather than over the DTO.
    // Every value must be a number, a boolean, an ISO instant or a closed-set
    // key; a proposal id would be the handle that makes "what is this merchant
    // asking for" answerable from a metrics surface.
    const reading = await readProposalQueueAging();
    const emitted = JSON.stringify(reading);
    expect(emitted.length, 'the reading serialized as nothing').toBeGreaterThan(200);
    for (const forbidden of [
      'proposalId',
      'storeId',
      'submittedBy',
      'oxyUserId',
      'proposedLabel',
      'convergenceKey',
    ]) {
      expect(emitted.includes(forbidden), `the queue reading carries ${forbidden}`).toBe(false);
    }
    // The positive control for that scan: a field that IS there. Without it a
    // response of `{}` would satisfy every line above.
    expect(emitted).toContain('agingBands');
  });

  it('every fixture row is gone, so nothing this file wrote outlives it', async () => {
    const rows = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from catalog_proposals where id like ${`${FIXTURE_PREFIX}-%`}
    `);
    expect(Number(rows[0]?.total ?? 0), 'the fixture transaction committed a proposal').toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The refusal branch, driven through the PURE derivation                      */
/* -------------------------------------------------------------------------- */

/** A tally with everything zero, to be overridden field by field. */
function emptyTally(overrides: Partial<ProposalTally> = {}): ProposalTally {
  return {
    createdInWindow: 0,
    decidedInWindow: 0,
    openNow: 0,
    oldestOpenAgeSeconds: null,
    byState: CATALOG_PROPOSAL_STATES.map((state) => ({
      state,
      count: 0,
      oldestAgeSeconds: null,
    })),
    totalRows: 0,
    openByAgeBand: CATALOG_PROPOSAL_AGE_BANDS.map((band) => ({ key: band.key, count: 0 })),
    openWithFutureCreatedAt: 0,
    deferredAhead: 0,
    openAgePercentiles: {
      p50Seconds: null,
      p90Seconds: null,
      p95Seconds: null,
      maxSeconds: null,
    },
    ...overrides,
  };
}

describe('#367 W6 — a population too small for a percentile is refused, not estimated', () => {
  it('withholds every percentile below the floor and carries no number to render', () => {
    const below = CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION - 1;
    const reading = deriveProposalQueueAging(
      emptyTally({
        openNow: below,
        totalRows: below,
        // Values ARE available — the refusal is about the population, not about
        // the read having failed. Publishing these would be the defect.
        openAgePercentiles: {
          p50Seconds: 100,
          p90Seconds: 900,
          p95Seconds: 990,
          maxSeconds: 990,
        },
      }),
    );
    expect(reading.waitAge.state).toBe('unmeasured');
    if (reading.waitAge.state !== 'unmeasured') return;
    expect(reading.waitAge.reason).toBe('population_below_floor');
    expect(reading.waitAge.floor).toBe(CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION);
    // The population survives, because "the queue is empty" and "the queue is
    // too small to summarise" both land here and lead to opposite conclusions.
    expect(reading.waitAge.population).toBe(below);
    // THE enforcement: no property a caller could read as a quantity.
    for (const property of ['p50Seconds', 'p90Seconds', 'p95Seconds', 'maxSeconds']) {
      expect(Object.keys(reading.waitAge), `the refusal carries ${property}`).not.toContain(
        property,
      );
    }
  });

  it('publishes them at the floor exactly — the other side of the boundary', () => {
    const reading = deriveProposalQueueAging(
      emptyTally({
        openNow: CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION,
        totalRows: CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION,
        openAgePercentiles: { p50Seconds: 100, p90Seconds: 900, p95Seconds: 990, maxSeconds: 990 },
      }),
    );
    // Without this the test above passes against a floor of one million, which
    // would withhold every figure this issue exists to publish.
    expect(reading.waitAge.state).toBe('measured');
    if (reading.waitAge.state !== 'measured') return;
    expect(reading.waitAge.p95Seconds).toBe(990);
  });

  it('refuses under its OWN reason when a percentile came back null over a live queue', () => {
    // The population clears the floor and the read produced no figure, which
    // would mean the aggregate's filter and this function's population disagree
    // — the same predicate in the same statement, so it cannot happen. The
    // refusal still exists because `strict: false` would otherwise let a `null`
    // be published as a number, and a wait of 0 reads as no wait at all.
    //
    // A SEPARATE reason from the floor's, and that is the assertion: collapsing
    // them would report a defect as a small sample and send whoever read it to
    // wait for the queue to grow.
    const reading = deriveProposalQueueAging(
      emptyTally({
        openNow: 100,
        totalRows: 100,
        openAgePercentiles: { p50Seconds: 100, p90Seconds: null, p95Seconds: 990, maxSeconds: 990 },
      }),
    );
    expect(reading.waitAge.state).toBe('unmeasured');
    if (reading.waitAge.state !== 'unmeasured') return;
    expect(reading.waitAge.reason).toBe('percentiles_unavailable');
    expect(reading.waitAge.population).toBe(100);
  });

  it('an empty queue reports no age at all, never an age of zero', () => {
    const reading = deriveProposalQueueAging(emptyTally());
    expect(reading.openDepth).toBe(0);
    expect(reading.totalDepth).toBe(0);
    expect(reading.oldestOpenAgeSeconds).toBeNull();
    expect(reading.unbandedOpenCount).toBe(0);
    expect(reading.countsAgree).toBe(true);
    expect(reading.waitAge.state).toBe('unmeasured');
    expect(reading.agingBands.every((band) => band.count === 0)).toBe(true);
    for (const entry of reading.depthByState) {
      expect(entry.oldestAgeSeconds, `${entry.state} reported an age over no rows`).toBeNull();
    }
  });
});

describe('#367 W6 — the two health flags fire', () => {
  it('countsAgree is FALSE when a row carries a state this build does not know', () => {
    // The reachable cause is a `pre` migration widening
    // `catalog_proposals_state_check` ahead of the image that reads it, which is
    // how this repository ships a vocabulary change. Without the flag the
    // symptom is a backlog that is quietly short.
    const reading = deriveProposalQueueAging(emptyTally({ openNow: 0, totalRows: 3 }));
    expect(reading.countsAgree).toBe(false);
    expect(reading.totalDepth).toBe(3);
    // And it is TRUE on the same shape once the states account for the rows —
    // a flag that were always false would pass the line above.
    const agreeing = deriveProposalQueueAging(
      emptyTally({
        totalRows: 3,
        byState: CATALOG_PROPOSAL_STATES.map((state) => ({
          state,
          count: state === 'approved' ? 3 : 0,
          oldestAgeSeconds: state === 'approved' ? 60 : null,
        })),
      }),
    );
    expect(agreeing.countsAgree).toBe(true);
  });

  it('unbandedOpenCount is the SUBTRACTION, so a band gap shows up too', () => {
    // Not the tally's own `age < 0` filter: that column is zero here and the
    // flag still fires, because five open rows landed in bands holding four.
    // A gap opened between two bands is the edit a later reader makes, and the
    // negative-age filter is blind to it.
    const bands = CATALOG_PROPOSAL_AGE_BANDS.map((band, index) => ({
      key: band.key,
      count: index === 0 ? 4 : 0,
    }));
    const reading = deriveProposalQueueAging(
      emptyTally({ openNow: 5, totalRows: 5, openByAgeBand: bands, openWithFutureCreatedAt: 0 }),
    );
    expect(reading.unbandedOpenCount).toBe(1);
    // The clean case on the same shape.
    const whole = deriveProposalQueueAging(
      emptyTally({
        openNow: 4,
        totalRows: 4,
        openByAgeBand: bands,
      }),
    );
    expect(whole.unbandedOpenCount).toBe(0);
  });
});
