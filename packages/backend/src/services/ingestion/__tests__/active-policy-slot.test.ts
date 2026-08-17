/**
 * Every test file on the SHARED database that can reach the global active
 * matching policy takes the policy slot — or is named here with a reason.
 *
 * `match_policy_versions_active_key` is a partial unique with NO scoping
 * column: ONE active policy per database, correct for production and a shared
 * resource between the parallel files that run against one throwaway database.
 * `active-policy-slot.ts` is the mutex. This is what stops a file joining
 * without it.
 *
 * ## Why a gate and not two more `beforeAll` calls
 *
 * The mutex was added by #63, extended by #215, and by #266 it was held by four
 * files and skipped by two — with no way for a reader to tell whether the two
 * were exempt or forgotten. A guard whose membership is folklore is worse than
 * no guard, because the next person to add a matcher-driving file has nothing
 * to copy and no build failure if they copy the wrong neighbour. So the
 * membership is DERIVED here and the exemptions are STATED, which is the thing
 * #266 actually asked for; adding the missing acquire was the smaller half.
 *
 * ## The scope is the SHARED database, and that is load-bearing
 *
 * A file is in scope when it opens the suite's shared handle with
 * `connectPostgres` — the detector is `USES_SHARED_DATABASE` below, and this
 * sentence deliberately omits the call parentheses, because a content-based
 * scope rule can put its own documentation in scope and this file's prose
 * discusses every pattern it looks for. There is an assertion for that, so a
 * future sentence spelling it as a call fails the build here rather than
 * silently making the gate its own 106th file. It is NOT "is a real-database
 * file" and it is NOT the `*.realdb.test.ts` filename — both readings are wrong
 * in a way that costs something:
 *
 * - `adapter-contract-suite.ts` is a shared HARNESS rather than a test file,
 *   and it is both a toucher and a holder. The three contract files that run it
 *   spell no entry point of their own and are covered by its hold. A filename
 *   walk would miss the suite entirely and read as a clean estate.
 * - `db/__tests__/graph-plan-regression.realdb.test.ts` creates and drops its
 *   OWN database with `createMercariaTestDatabase` (its header says why: the
 *   benchmark generator TRUNCATES), and the dataset it seeds inserts a policy
 *   version with `status: 'active'` directly. It is the one real-database file
 *   in the repo that genuinely publishes an active policy, and it contends with
 *   NOBODY because the unique index is per database.
 *
 * That second one is out of scope today for TWO independent reasons, and only
 * one of them is this rule: it owns its database, AND the insert lives in
 * `graph-benchmark/dataset.ts` rather than in the test file, so no detector
 * matches it either way. Measured, so it is not overstated: widening the filter
 * to every realdb file leaves the census unchanged. What the control below
 * pins is the REASON — the three facts that make the exclusion a decision
 * rather than a coincidence — because either of them moving (the seeding
 * inlined, or another private-database file spelling a detector) turns a
 * correct file into a red build, and the fix then is to keep this rule rather
 * than to add an exemption.
 *
 * ## What "can reach it" means, and what it deliberately does not
 *
 * The detectors name the entry points that read the globally active policy,
 * make a row active, or hand the table to a statement builder. Four shapes are
 * deliberately ABSENT:
 *
 * - `createMatchPolicyVersion(` hardcodes `status: 'draft'`
 *   (`match-policy.service.ts:71`), and the unique index is partial on
 *   `active`, so a draft contends with nothing. `backfill.realdb.test.ts` is
 *   the file that exercises this: it creates a draft, never activates it, and
 *   drives #58's pipeline with the policy INJECTED. It reads no global state
 *   and correctly holds no slot.
 * - `evaluateMatch(` / `applyMatchOutcome(` take a policy as an ARGUMENT, so
 *   they never look one up. They do write `match_decisions`, which is a
 *   different hazard with a different guard — `db/__tests__/canonical-teardown.ts`
 *   — and detecting them here would force files that cannot contend to
 *   serialize, while telling a reader this slot protects something it does not.
 * - `drainOfferRefresh(` claims a task and opens a #62 run; it performs no
 *   fetch and no match (`offer-freshness/refresh-dispatcher.ts:1-9`). The page
 *   is driven by #62's own dispatcher, which is already detected.
 * - The raw table NAME in SQL text. Five in-scope files mention
 *   `match_policy_versions_active_key` in prose about this very index, so that
 *   pattern is contamination rather than a detector. The drizzle table SYMBOL
 *   handed to a statement builder is detected instead, and it is what catches a
 *   direct `db.update(...)` or `db.delete(...)` — deleting a policy another
 *   file's decision cites is the original failure the mutex was written for.
 *
 * ## What it does NOT measure, said out loud
 *
 * It measures the PRESENCE of an acquire, never its EXTENT. A file that takes
 * the slot inside an inner `describe`, inside a skipped one, behind an `if`, or
 * releases it on the next line, passes here while serializing nothing — and
 * extent is exactly what went wrong before: `~/Oxy/AGENTS.md` records that the
 * hold "must cover the whole FILE, not just the matching `describe`", which was
 * `ebay-ingestion`'s bug. A source scan cannot close that; it is stated so
 * nobody reads a green here as proof of it.
 *
 * The walk is also the test estate only. A helper module OUTSIDE `__tests__`
 * that writes the policy table is invisible to it —
 * `services/graph-benchmark/dataset.ts` is that shape, harmless today only
 * because its one consumer owns its database. The control below pins that
 * module's behaviour; it does not pin the set of files importing it.
 *
 * ## Its own vacuity floors
 *
 * A walk that found no files, or a detector that matched nothing, reads exactly
 * like a well-behaved estate. So the walk has a floor, the toucher set has an
 * exact size, the exemption list has an exact size AND every entry must still
 * be a toucher, the scope rule has a named positive control, and every detector
 * is mutation-tested against literal buffers below — including a near-miss that
 * must NOT match. The probes are assembled from fragments, and this file
 * asserts its own exclusion from the walk, so it cannot become the offender it
 * is looking for.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Floor on the walk itself. 105 files open the shared database today; 80 is
 * well below that and well above zero, so it catches a broken walk without
 * failing on ordinary growth or on a file somebody legitimately deletes.
 */
const SHARED_DATABASE_FILE_FLOOR = 80;

/**
 * The vacuity floor on the TOUCH detectors, and the exact size beside it.
 *
 * Two numbers rather than one, because they answer different questions. The floor
 * is "did the detectors run at all" — a pattern that stopped matching reads
 * exactly like a healthy estate, and only a floor separates them. The exact count
 * is "did the population move", which is a prompt to CLASSIFY a new file rather
 * than a fault in itself.
 *
 * The floor is deliberately BELOW the count: it is the number of files that reach
 * the policy through a CALL or the TABLE — the detectors whose population is a
 * property of the code rather than of how many tests happen to name an operator
 * route. Set from the six that existed when the two numbers were split, so a
 * broken call/table detector still fails here even while the route detectors keep
 * matching new refusal tests.
 */
const TOUCHER_FLOOR = 6;

/** Every file any touch detector matches today. See `TOUCHER_FLOOR`. */
const TOUCHER_COUNT = 7;

/**
 * Opening the suite's SHARED handle. See the header: this is the scope rule,
 * and it is not interchangeable with "runs against a real server".
 *
 * It also earns its keep on the two static isolation gates, which quote a
 * matcher call inside their OWN mutation self-tests and can contend for nothing
 * (`awin-isolation.test.ts`, `feed-import-isolation.test.ts`).
 */
const USES_SHARED_DATABASE = new RegExp(`${'connect'}${'Postgres'}\\s*\\(`, 'u');

/** Minting a PRIVATE database, which is what puts a file out of scope. */
const USES_PRIVATE_DATABASE = new RegExp(`${'create'}${'MercariaTestDatabase'}\\s*\\(`, 'u');

/**
 * Assembled from fragments, as above.
 *
 * The first six READ whichever policy is globally active; the next three can
 * make a row active; the last seven are the operator surface's handlers, which
 * do both. `runMatch` reads the policy BEFORE it loads its subject
 * (`match.service.ts:341`), which is why a file whose subjects never resolve is
 * still a reader.
 *
 * The DISPATCH half is the one worth reading. `offer-freshness.realdb.test.ts`
 * and the two adapter suites spell no matcher call at all: they drive
 * `runIngestionPage`, and `ingest.service.ts:913` is what reaches `runMatch`. A
 * gate naming only the direct calls would have found one claimant and stayed
 * green over the four that arrive by dispatch.
 *
 * The repository writer `insertMatchPolicyVersion` has a `status` the CALLER
 * chooses, so it is detected even though most uses are drafts — a static
 * pattern cannot read the column, and the direction that costs something is the
 * one where an active row is written by a file nobody serialized. The one file
 * that uses it deliberately for a draft is named in `SLOT_EXEMPT` below.
 *
 * MOST of these match nothing today — deliberately no count, because that
 * number is one nothing recomputes and it has been wrong twice already at two
 * different sizes. That they mostly match nothing is the point: a detector
 * added after the first offender is a detector that arrived too late, and the
 * mutation self-test below is what keeps them from being decoration.
 */
const ACTIVE_POLICY_CALLS: readonly RegExp[] = [
  new RegExp(`${'run'}${'Match'}\\s*\\(`, 'u'),
  new RegExp(`${'run'}${'MatchSweepPage'}\\s*\\(`, 'u'),
  new RegExp(`${'drain'}${'MatchQueue'}\\s*\\(`, 'u'),
  new RegExp(`${'run'}${'IngestionPage'}\\s*\\(`, 'u'),
  new RegExp(`${'drain'}${'CatalogIngestion'}\\s*\\(`, 'u'),
  new RegExp(`${'find'}${'ActiveMatchPolicyVersion'}\\s*\\(`, 'u'),
  new RegExp(`${'insert'}${'MatchPolicyVersion'}\\s*\\(`, 'u'),
  new RegExp(`${'activate'}${'MatchPolicy'}\\s*\\(`, 'u'),
  new RegExp(`${'activate'}${'MatchPolicyVersion'}\\s*\\(`, 'u'),
  new RegExp(`${'match'}${'MetricsHandler'}\\s*\\(`, 'u'),
  new RegExp(`${'list'}${'MatchReviewsHandler'}\\s*\\(`, 'u'),
  new RegExp(`${'evaluate'}${'SubjectHandler'}\\s*\\(`, 'u'),
  new RegExp(`${'drain'}${'MatchQueueHandler'}\\s*\\(`, 'u'),
  new RegExp(`${'run'}${'MatchSweepHandler'}\\s*\\(`, 'u'),
  new RegExp(`${'activate'}${'MatchPolicyHandler'}\\s*\\(`, 'u'),
  new RegExp(`${'drain'}${'IngestionHandler'}\\s*\\(`, 'u'),
];

/**
 * The drizzle table object handed to a statement builder — `insert(`, `update(`,
 * `delete(`, `from(`. A read is included on purpose: a file that SELECTS the
 * active policy is deciding what to do from a value a sibling controls.
 */
const ACTIVE_POLICY_TABLE = new RegExp(`\\(\\s*${'match'}${'PolicyVersions'}\\b`, 'u');

/**
 * The operator surface reached over HTTP.
 *
 * This repo's integration tests drive the REAL app with `fetch` against a path
 * literal rather than importing a handler
 * (`routes/__tests__/stripe-webhook.integration.test.ts` is the shape), so a
 * file exercising that surface would reach the slot while spelling no function
 * name at all. The matching prefix is taken WHOLE — five of its handlers read
 * or write the policy — while the ingestion surface is taken at the ONE path
 * that drains the pipeline, because the rest of it configures sources and
 * flagging all of it would fail files that reach nothing.
 */
const ACTIVE_POLICY_ROUTES: readonly RegExp[] = [
  new RegExp(`${'/internal'}${'/matching'}`, 'u'),
  new RegExp(`${'/internal'}${'/ingestion'}${'/drain'}`, 'u'),
];

/**
 * Taking the mutex, as a BINDING rather than as a name.
 *
 * The asymmetry with the touch detectors is the reason. Those may match a
 * comment and that is tolerable — a false positive there fails the build loudly
 * and is fixed in one line, which is the trade the precedent records. A false
 * positive HERE is silent and points the other way: a file whose acquire was
 * deleted, with prose still quoting it, would read as protected and this gate
 * would say so. So the shape is `= await <call>`, which every claimant spells
 * and which prose describing the mutex does not.
 */
const ACQUIRES_SLOT = new RegExp(
  `=\\s*await\\s+${'acquire'}${'ActivePolicySlot'}\\s*\\(`,
  'u',
);

/**
 * Touchers that are exempt, each with the reason a reader can check.
 *
 * This list is pinned to an exact size below and every entry must still be a
 * detected toucher, because a list that only ever grows is how a gate switches
 * itself off one defensible line at a time — and an entry that stopped touching
 * is a stale excuse nobody would notice.
 */
const SLOT_EXEMPT: readonly { readonly file: string; readonly reason: string }[] = [
  {
    file: 'db/__tests__/canonical-teardown.realdb.test.ts',
    reason:
      "#268's gate constructs its interfering match_decisions row against a DRAFT policy version, " +
      'on purpose: the foreign key needs a row, not an active one, so it takes no global slot and ' +
      'cannot contend. It reads no active policy and drives no matcher.',
  },
];

/**
 * Files the ROUTE detectors match which reach no matching code AT ALL.
 *
 * A DIFFERENT category from {@link SLOT_EXEMPT} and the distinction is the point:
 * an exemption is a real toucher that cannot contend (it writes a DRAFT policy),
 * while these are files the detector is simply WRONG about. Collapsing the two
 * would turn "the detector over-matched" into "this toucher is excused", and the
 * second sentence is the one nobody re-examines.
 *
 * Why the route detectors over-match, and why that is not fixable by narrowing
 * them: they exist because an integration test drives the REAL app with `fetch`
 * against a path literal and would otherwise spell no function name at all. But a
 * file asserting that a surface is REFUSED names the same literal — and the
 * refusal is the whole of what it asserts. Telling those apart statically means a
 * regex over assertion text, which is more fragile than the census it would
 * protect. So the detector stays broad and the classification is explicit.
 *
 * **Expect this list to grow, and not as erosion.** Naming the nine internal
 * catalog surfaces and asserting 403-then-404 across them is the house shape for
 * the operator allow-list convention, so the next file that does it matches too.
 * Each entry carries a machine-checkable discriminator below, so an entry that
 * starts really touching fails the build instead of sitting here as a stale
 * excuse.
 */
const ROUTE_LITERAL_ONLY: readonly { readonly file: string; readonly reason: string }[] = [
  {
    file: 'routes/__tests__/catalog-rollout.realdb.test.ts',
    reason:
      "ADR 0007 D12's rollback gate. It names the operator prefix in a list of nine internal " +
      'surfaces and sends each one GET twice: once as a NON-operator expecting 403, and once ' +
      'against a deployment with an empty allow-list expecting 404. Both are decided before any ' +
      'handler runs, so no matching code is reached. MEASURED, not reasoned: a postgres.js debug ' +
      'hook over a run of that file captured 28 statements naming categories, listings and ' +
      'catalog_proposals, and NONE naming the policy table or any other matching table.',
  },
];

/**
 * The positive control on the scope rule.
 *
 * `graph-plan-regression.realdb.test.ts` is a real-database file that DOES
 * publish an active policy, through the benchmark dataset it seeds — and it is
 * correctly out of scope because it owns its database. Asserting the exclusion
 * by name, together with the two facts that make it correct, is what stops a
 * later reader widening the filter to every realdb file and meeting a red build
 * on a file that is right.
 */
const PRIVATE_DATABASE_CONTROL = {
  file: 'db/__tests__/graph-plan-regression.realdb.test.ts',
  dataset: 'services/graph-benchmark/dataset.ts',
} as const;

/** Every test file and shared test harness under `src/`, relative to `src/`. */
function testEstateFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string, insideTests: boolean): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full, insideTests || entry === '__tests__');
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (!insideTests && !entry.endsWith('.test.ts')) continue;
      found.push(relative(SRC_ROOT, full).split(sep).join('/'));
    }
  };
  walk(SRC_ROOT, false);
  return found.sort();
}

function read(file: string): string {
  return readFileSync(join(SRC_ROOT, file), 'utf8');
}

function usesSharedDatabase(source: string): boolean {
  return USES_SHARED_DATABASE.test(source);
}

function touchesActivePolicy(source: string): boolean {
  return (
    ACTIVE_POLICY_CALLS.some((pattern) => pattern.test(source)) ||
    ACTIVE_POLICY_TABLE.test(source) ||
    ACTIVE_POLICY_ROUTES.some((pattern) => pattern.test(source))
  );
}

/**
 * Comments removed, for `holdsSlot` ONLY.
 *
 * The asymmetry again. A comment match on a TOUCH detector is tolerable — it
 * fails the build loudly and is fixed in one line, which is the trade the
 * precedent records, and it is why the touch detectors read raw source. A
 * comment match on the HOLD detector is silent and points the wrong way: a file
 * whose acquire was deleted, with prose quoting the assignment, reads as
 * protected and this gate says so.
 *
 * Requiring `= await` narrowed that and did not close it — an `@example` on the
 * mutex, or a claimant's own docblock rewording "holds the slot" into the
 * assignment it spells, both match. Documenting the pattern is exactly what
 * #266 asks people to do, so the plausible shape is the one that defeats it.
 *
 * `~/Oxy/AGENTS.md` warns that comment stripping truncates at a `//` inside a
 * string literal and can hide a real call. That objection cuts the SAFE way
 * here: a truncation makes `holdsSlot` under-report, which is a red build
 * naming the file, never a silent pass.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
}

function holdsSlot(source: string): boolean {
  return ACQUIRES_SLOT.test(stripComments(source));
}

describe('the global active-matching-policy slot', () => {
  const estate = testEstateFiles();
  const shared = estate.filter((file) => usesSharedDatabase(read(file)));

  it('walked a plausible number of shared-database files', () => {
    expect(shared.length).toBeGreaterThanOrEqual(SHARED_DATABASE_FILE_FLOOR);
  });

  it('is held by EXACTLY the shared-database files that can reach the active policy', () => {
    const touchers: string[] = [];
    const holders: string[] = [];
    for (const file of shared) {
      const source = read(file);
      if (touchesActivePolicy(source)) touchers.push(file);
      if (holdsSlot(source)) holders.push(file);
    }

    // TWO checks, deliberately separate, because they fail for OPPOSITE reasons
    // and one message cannot serve both. This was one assertion — an exact
    // `toHaveLength(6)` carrying the vacuity message — and when the population
    // GREW it reported that the gate "measured nothing", sending the next reader
    // to hunt a broken detector instead of at their own new file.
    //
    // First the vacuity floor: a detector that stopped matching reads exactly
    // like a clean estate, and this is the only thing standing between them.
    expect(
      touchers.length,
      'the detectors matched fewer files than can exist, so this gate measured nothing',
    ).toBeGreaterThanOrEqual(TOUCHER_FLOOR);

    // Then the exact size, whose only failure mode is that the population moved.
    expect(
      touchers.length,
      'the number of files the detectors match has CHANGED. If you added one, classify it: make '
        + 'it take the slot (a holder), or add it to SLOT_EXEMPT if it touches but cannot contend, '
        + 'or to ROUTE_LITERAL_ONLY if a route detector matched a file that reaches no matching '
        + 'code — then update TOUCHER_COUNT. Do not just bump the number.',
    ).toBe(TOUCHER_COUNT);

    const exempt = SLOT_EXEMPT.map((entry) => entry.file);
    const routeOnly = ROUTE_LITERAL_ONLY.map((entry) => entry.file);

    // Exact identity, never containment: a containment check passes when a file
    // stops touching, and pinning the sets is what makes a NEW toucher fail the
    // build rather than quietly widen a list.
    expect([...holders, ...exempt, ...routeOnly].sort()).toEqual(touchers);
    // Disjoint, so an excuse can never be spent on a file that already holds the
    // slot — which would read as coverage for a file it does not cover. All three
    // pairs, because two overlapping excuses hide each other.
    expect(holders.filter((file) => exempt.includes(file))).toEqual([]);
    expect(holders.filter((file) => routeOnly.includes(file))).toEqual([]);
    expect(exempt.filter((file) => routeOnly.includes(file))).toEqual([]);
    // Every excuse still describes a real DETECTED file.
    expect(exempt.every((file) => touchers.includes(file))).toBe(true);
    expect(routeOnly.every((file) => touchers.includes(file))).toBe(true);
  });

  it('pins the route-literal class, and every entry PROVES it reaches no matching code', () => {
    // The machine-checkable half of the classification, and what stops this list
    // being the soft place a real toucher lands. An entry is only legitimate if a
    // ROUTE detector matched it and NEITHER a call detector NOR the table
    // detector did — so a file in here that starts calling `runMatch` or
    // selecting the policy table fails the build rather than staying excused.
    expect(ROUTE_LITERAL_ONLY.length, 'the route-literal class is unexpectedly large').toBeLessThanOrEqual(
      3,
    );
    for (const entry of ROUTE_LITERAL_ONLY) {
      const source = read(entry.file);
      expect(
        ACTIVE_POLICY_ROUTES.some((pattern) => pattern.test(source)),
        `${entry.file} no longer matches a route detector, so its entry is stale`,
      ).toBe(true);
      expect(
        ACTIVE_POLICY_CALLS.filter((pattern) => pattern.test(source)).map((p) => p.source),
        `${entry.file} now CALLS into matching and must take the slot instead`,
      ).toEqual([]);
      expect(
        ACTIVE_POLICY_TABLE.test(source),
        `${entry.file} now reads or writes the policy table and must take the slot instead`,
      ).toBe(false);
      // And it must not silently become a holder either, which would make the
      // entry unnecessary rather than wrong — caught by the disjointness
      // assertions above, and stated here so the reason is reviewable.
      expect(entry.reason.length, entry.file).toBeGreaterThan(80);
    }
  });

  it('pins the exemption list, and every exemption states why', () => {
    // A list that only grows is the gate switching itself off. One file is
    // exempt today; adding a second is a decision somebody makes on purpose.
    expect(SLOT_EXEMPT).toHaveLength(1);
    for (const entry of SLOT_EXEMPT) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(80);
    }
  });

  it('excludes the one realdb file that owns its database, for the stated reason', () => {
    // The scope rule's positive control. All three facts must hold together, or
    // the exclusion is an accident rather than a decision: the file publishes an
    // ACTIVE policy, it mints its own database, and it never opens the shared
    // one. Any of the three changing should be read here rather than as a
    // mysterious red somewhere else.
    const control = read(PRIVATE_DATABASE_CONTROL.file);
    const dataset = read(PRIVATE_DATABASE_CONTROL.dataset);

    expect(ACTIVE_POLICY_TABLE.test(dataset), 'the dataset stopped writing the policy table').toBe(
      true,
    );
    expect(dataset).toMatch(new RegExp(`${'status'}:\\s*'${'active'}'`, 'u'));
    // The link between the two, so "the control seeds that dataset" is read
    // rather than assumed. The import carries the runtime `.js` specifier.
    expect(control).toContain(PRIVATE_DATABASE_CONTROL.dataset.replace(/^services\//u, '').replace(/\.ts$/u, '.js'));
    expect(USES_PRIVATE_DATABASE.test(control), 'the control stopped minting its own database').toBe(
      true,
    );
    expect(usesSharedDatabase(control), 'the control now opens the SHARED database').toBe(false);
    expect(shared).not.toContain(PRIVATE_DATABASE_CONTROL.file);
  });

  it('fires on EVERY detected call shape, and on none of their near misses', () => {
    // MOST of the call detectors match no file today, so the census above
    // cannot prove they work — a pattern that stopped matching would read
    // exactly like a well-behaved estate. Deliberately not "N of the sixteen":
    // the header says why a count here is a number nothing recomputes, and this
    // comment proved it by shipping one that was wrong on the day it landed
    // (eleven, measured thirteen). The floor below is the assertion that keeps
    // the probes and the detectors in step. Each is exercised against a real
    // call, against the same call wrapped across lines (the house spelling for
    // a long one, which a line-based detector would read as clean), and against
    // the same identifier with a suffix, so a broken pattern and an over-broad
    // one both fail rather than reading as clean.
    const names: readonly string[] = [
      `${'run'}${'Match'}`,
      `${'run'}${'MatchSweepPage'}`,
      `${'drain'}${'MatchQueue'}`,
      `${'run'}${'IngestionPage'}`,
      `${'drain'}${'CatalogIngestion'}`,
      `${'find'}${'ActiveMatchPolicyVersion'}`,
      `${'insert'}${'MatchPolicyVersion'}`,
      `${'activate'}${'MatchPolicy'}`,
      `${'activate'}${'MatchPolicyVersion'}`,
      `${'match'}${'MetricsHandler'}`,
      `${'list'}${'MatchReviewsHandler'}`,
      `${'evaluate'}${'SubjectHandler'}`,
      `${'drain'}${'MatchQueueHandler'}`,
      `${'run'}${'MatchSweepHandler'}`,
      `${'activate'}${'MatchPolicyHandler'}`,
      `${'drain'}${'IngestionHandler'}`,
    ];

    // The floor: as many probes as detectors, so dropping a detector without
    // dropping its probe leaves this list longer than the patterns it exercises.
    expect(names).toHaveLength(ACTIVE_POLICY_CALLS.length);

    for (const name of names) {
      expect(touchesActivePolicy(`await ${name}(db, { limit: 50 });`), name).toBe(true);
      expect(touchesActivePolicy(`await ${name}\n  (db);`), `${name} (wrapped)`).toBe(true);
      expect(touchesActivePolicy(`const ${name}Count = 3;`), `${name} (near miss)`).toBe(false);
      expect(holdsSlot(`await ${name}(db);`), `${name} (not the slot)`).toBe(false);
    }
  });

  it('fires on the table shape and on the routes, and on none of their near misses', () => {
    const table = `${'match'}${'PolicyVersions'}`;
    expect(touchesActivePolicy(`await db.update(${table}).set({ status: 'active' });`)).toBe(true);
    expect(touchesActivePolicy(`await db.delete(${table}).where(eq(${table}.id, id));`)).toBe(true);
    // An IMPORT of the symbol is not a statement against the table. A file that
    // only reads the type, or names the table in a comment, reaches nothing.
    expect(touchesActivePolicy(`import { ${table} } from '../schema/matching.js';`)).toBe(false);
    // The prose this gate deliberately does not detect: five in-scope files
    // mention the index by name while touching nothing.
    expect(touchesActivePolicy(`// ${'match_policy'}${'_versions_active_key'} is a partial unique`)).toBe(
      false,
    );

    expect(touchesActivePolicy(`await fetch(\`\${base}${'/internal'}${'/matching'}/policies\`);`)).toBe(
      true,
    );
    expect(
      touchesActivePolicy(`await fetch(\`\${base}${'/internal'}${'/ingestion'}${'/drain'}\`);`),
    ).toBe(true);
    // The rest of the ingestion operator surface configures sources and must
    // not be read as reaching the matcher.
    expect(touchesActivePolicy(`await fetch(\`\${base}${'/internal'}${'/ingestion'}/sources\`);`)).toBe(
      false,
    );
  });

  it('detects a toucher that does not hold the slot, and only a real call', () => {
    const call = `await ${'run'}${'IngestionPage'}({ runId, leaseOwner });`;
    const acquire = `${'policySlot'} = await ${'acquire'}${'ActivePolicySlot'}(db);`;

    expect(touchesActivePolicy(call)).toBe(true);
    expect(holdsSlot(call)).toBe(false);
    expect(holdsSlot(`${call}\n${acquire}`)).toBe(true);

    // A near miss: a DIFFERENT symbol that merely starts the same way must not
    // be read as a call to the mutex, or a file could look protected by a name.
    expect(holdsSlot(`const ${'acquire'}${'ActivePolicySlotKey'} = 1;`)).toBe(false);

    // The dangerous near misses: a file whose acquire was DELETED, with prose
    // still quoting it, must not read as protected. This is the one false
    // positive that would SILENCE the gate rather than fail it, so the probes
    // cover the bare mention AND the full assignment — the second is the shape
    // anybody documenting "how to join the slot" would naturally write, and the
    // `= await` narrowing alone does not reject it.
    const assignment = `${'policySlot'} = await ${'acquire'}${'ActivePolicySlot'}(db);`;
    expect(holdsSlot(`// see ${'acquire'}${'ActivePolicySlot'}(db) for the mutex`)).toBe(false);
    expect(holdsSlot(`// ${assignment}`)).toBe(false);
    // Both docblock shapes, WITH their delimiters. The stripper is syntactic,
    // so a bare ` * …` continuation line is not tested — it cannot occur
    // outside a block, and treating one as a comment on its own would mean
    // stripping any line beginning with an asterisk.
    expect(holdsSlot(`/**\n * The pattern is \`${assignment}\`\n */`)).toBe(false);
    expect(holdsSlot(`/**\n * @example\n * ${assignment}\n */`)).toBe(false);
    // And the real thing, on a line that also carries a trailing comment, still
    // counts — stripping must not eat the statement in front of the `//`.
    expect(holdsSlot(`  ${assignment} // held for the whole file`)).toBe(true);
  });

  it('keeps ITSELF out of the walk, so its own prose cannot become a finding', () => {
    // A content-based scope rule can put its own documentation in scope, and
    // this file's prose necessarily discusses every pattern it looks for. The
    // header omits the scope call's parentheses for that reason; this is what
    // fails the build if a future sentence puts them back, instead of the count
    // silently moving and a later sentence spelling a detector contiguously
    // turning the census red on a correct estate.
    const self = 'services/ingestion/__tests__/active-policy-slot.test.ts';
    expect(estate, 'the walk stopped finding this file, so this control is inert').toContain(self);
    expect(shared).not.toContain(self);
  });

  it('puts a file in scope only when it opens the SHARED database', () => {
    const quoted = `expect(PATTERN.test('const decision = await ${'run'}${'Match'}(subject);')).toBe(true);`;
    expect(touchesActivePolicy(quoted)).toBe(true);
    expect(usesSharedDatabase(quoted)).toBe(false);
    expect(usesSharedDatabase(`db = await ${'connect'}${'Postgres'}();`)).toBe(true);
    expect(usesSharedDatabase(`url = await ${'create'}${'MercariaTestDatabase'}(ADMIN_URL);`)).toBe(
      false,
    );
  });
});
