/**
 * The catalog integrity sweep against a REAL PostgreSQL server (#367 W17).
 *
 * Everything here is a property a mocked repository cannot have. Five of the six
 * checks are recursive CTEs, array comparisons, `is distinct from` over a
 * `text[]`, or a `not exists` against a table a foreign key points at — none of
 * which a stubbed `execute` evaluates at all. A mocked suite would report six
 * green checks over statements the server had never parsed.
 *
 * ## EVERY CHECK HAS A POSITIVE CONTROL, and that is the point of the file
 *
 * A detector asserted only against a clean database cannot fail. So every case
 * below inserts a genuinely broken row, asserts the check FINDS it, and — where
 * the distinction is available — asserts a correct row beside it is NOT found.
 * The assertion is a DELTA measured inside one transaction, never an absolute:
 * this database is shared with parallel files, siblings legitimately hold
 * findings of their own (`catalog-governance.realdb.test.ts` leaves change
 * requests naming subjects that never existed), and an absolute count would be
 * a test of what everybody else happened to be doing.
 *
 * ## Nothing is committed, so there is no teardown
 *
 * Every fixture is created inside a transaction that is ROLLED BACK, and the
 * check under test is driven on that same transaction handle. Three things fall
 * out of it at once: no row this file writes is ever visible to a parallel file;
 * the deliberately-broken rows cannot outlive the assertion that wanted them;
 * and the teardown-ordering hazard that comes with `restrict` foreign keys —
 * `categories`, `product_type_definitions`, `catalog_sources` are all `restrict`
 * from several directions — does not arise, because nothing has to be deleted.
 *
 * It is also the only way to test the CYCLE detector at all: see the case.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import type { CatalogIntegrityResult } from '@mercaria/shared-types';
import { CATALOG_INTEGRITY_CHECK_KINDS } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database, type Transaction } from '../../../db/postgres.js';
import {
  checkAncestryPathDrift,
  checkCategoryCycles,
  checkInvalidRedirects,
  checkOrphanedReferences,
  checkSchemaVersionAvailability,
  checkStalledQueueLeases,
  INTEGRITY_SAMPLE_LIMIT,
  runCatalogIntegrityChecks,
} from '../integrity.service.js';

const db: Database = await connectPostgres();

/**
 * Every id this file mints.
 *
 * `zz-` first so this file's rows are recognisable and cannot collide with a
 * sibling's. It buys NOTHING about where a row lands in a check's bounded
 * sample, and the reasoning that says otherwise is wrong twice over.
 *
 * This database is `en_US.utf8` under the LIBC provider (`datlocprovider = c`),
 * a locale collation rather than byte order, so a separator is a lower-priority
 * difference and character codes give the wrong answer for ids that differ only
 * in one. Measured against the server:
 *
 * ```
 * order by id desc:
 *   zzz-no-such-city
 *   zz-obs-trace-draft-published
 *   zz_obs_integ.x
 *   zz-obs-integ-orphan3-proposal      <- this file, FOURTH
 *   zz_obs_integ_floor
 *   gov-plan-123
 *   0198f1a2-3b4c-7d8e-9f01-234567890abc
 * ```
 *
 * So `zz-` outranks every uuid v7 hex id and every lower-cased prefix, and it
 * loses to `zzz-` and to `zz-obs-trace-` — a prefix that is already in this
 * repository. Whether an underscore wins is not a rule about `zz_` at all: the
 * collation drops the separator and compares the LETTERS, which is why
 * `zz_obs_integ.x` beats this file's ids and `zz_obs_integ_floor` does not.
 *
 * #713 measured `trace.realdb`, `pickup.realdb`, `vertical-locales-markets.e2e`
 * and `facet-scope-sweep.realdb` clean for the four tables these checks scan, and
 * rested the sample bound on that survey. It is recorded rather than relied on:
 * which prefixes reach a scanned table is a fact about the neighbours that
 * changes whenever one of them grows a fixture, and re-surveying is not something
 * a failure would prompt anybody to do. {@link probeId} is what a case uses when
 * a row has to be NAMED, and it does not depend on the answer.
 */
const P = 'zz-obs-integ';

/** A distinct suffix per case, so two cases cannot collide on a unique index. */
function id(scope: string, name: string): string {
  return `${P}-${scope}-${name}`;
}

/** A table a case can mint a {@link probeId} in. Closed, because it is interpolated raw. */
type ProbeTable =
  | 'categories'
  | 'category_redirects'
  | 'catalog_proposals'
  | 'catalog_governance_change_requests'
  | 'catalog_authoring_drafts'
  | 'catalog_backfill_runs'
  | 'catalog_external_mapping_runs'
  | 'catalog_external_token_observations';

/**
 * Mint an id that sorts above every row currently in `table`.
 *
 * Every scan in `integrity.service.ts` is `order by id desc`, so an id above
 * the table's current maximum is the FIRST row that scan examines and — if it
 * is a finding at all — the first finding its sub-scan reports.
 *
 * ## Why "currently" is a durable fact rather than a race
 *
 * The fixture transaction is `repeatable read` and the check under test is
 * driven on that same handle, so every statement of the case reads the snapshot
 * the first one took. A row a parallel file commits after that instant is
 * invisible to the mint AND to the check, and this transaction's own writes are
 * visible to both. So "above the maximum" holds for the whole case.
 *
 * The ordering claim is MEASURED here rather than asserted in prose: the
 * comparison below is the server's own, under the same collation `order by id
 * desc` uses, so a database whose collation does not put `${max}-${suffix}`
 * above `${max}` fails at the mint naming the premise, instead of surfacing
 * later as a check that appears not to name what it found.
 */
async function probeId(
  tx: Transaction,
  table: ProbeTable,
  scope: string,
  name: string,
): Promise<string> {
  const readable = id(scope, name);
  const ceiling = await tx.execute<{ newest: string | null }>(
    sql`select max(id) as newest from ${sql.raw(table)}`,
  );
  const newest = ceiling[0]?.newest ?? null;
  const minted = newest === null ? readable : `${newest}-${readable}`;

  const outranking = await tx.execute<{ total: number }>(
    sql`select count(*)::int as total from ${sql.raw(table)} where id >= ${minted}`,
  );
  expect(
    Number(outranking[0]?.total ?? 0),
    `${minted} does not outrank every ${table} row this transaction can see`,
  ).toBe(0);

  mintedProbes.add(`${table}:${minted}`);
  return minted;
}

/**
 * The probe handles {@link probeId} has minted.
 *
 * {@link expectDetected} asserts membership, so a call site that passes an
 * ordinary {@link id} fails immediately and by name rather than passing on an
 * empty database and flaking on a busy one — which is the whole of #622.
 */
const mintedProbes = new Set<string>();

afterAll(async () => {
  await closePostgres();
});

/** Thrown to roll a fixture transaction back. Never escapes the helper. */
class RolledBack extends Error {}

/**
 * Run `work` inside a rolled-back `repeatable read` transaction.
 *
 * ## The isolation level is load-bearing, and it was MEASURED
 *
 * Every case here asserts a DELTA — findings before a broken row exists against
 * findings after — and at PostgreSQL's default `read committed` each statement
 * takes a fresh snapshot, so a parallel test file committing its own row
 * between the two readings lands in the delta. That is not a theoretical race:
 * running this file alone was green and the first FULL-SUITE run failed on
 * `expected 2 to be 1` in the proposal case and on a population that went DOWN
 * by one in the schema case, from two different siblings, in one run.
 *
 * At `repeatable read` every statement in the transaction reads the snapshot
 * taken by the first one, so everybody else's catalogue is frozen for the
 * duration while this transaction's own writes stay visible to it. The delta is
 * then exactly what this file did. Write conflicts cannot arise — every row
 * touched carries an id no other file can mint — and the transaction is rolled
 * back regardless.
 *
 * The callback parameter is named `tx` deliberately: `advisory-lock-census.ts`
 * classifies a handle as transactional by NAME, collected from the callbacks of
 * `transaction(…)`, and the `session_replication_role` case below is held to
 * "issued on a transaction handle" by that rule.
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

/**
 * Assert a check reacted to a row that was created between two readings.
 *
 * `population` is asserted to have grown too — or the delta could have come
 * from a scan that shrank, and a check whose denominator moves the other way
 * from its numerator is measuring something else.
 *
 * ## Why the sample assertion is answerable, and why it stays
 *
 * The third assertion is what makes the delta a fact about THIS row: a delta of
 * one says a check found one more thing than it did a statement ago, and the
 * handle is what says the thing it found is the row this case created rather
 * than something that row disturbed. It is not redundant with the first.
 *
 * ## What makes it answerable, read from `integrity.service.ts` rather than assumed
 *
 * Two facts, both in the service:
 *
 * 1. Every sub-scan orders `id desc`, at both hops — the bounded `examined` CTE
 *    and the finding query over it — so a sub-scan's first finding is the one
 *    with the highest id.
 * 2. `result()` takes a turn from each sub-scan rather than slicing the head of
 *    their concatenation, so the FIRST finding of every reporting sub-scan is in
 *    the sample whenever the number of sub-scans is under
 *    {@link INTEGRITY_SAMPLE_LIMIT}. No check here has more than three.
 *
 * So a probe that is the highest-id row of its own table is named, whatever else
 * the shared database is holding — and {@link probeId} is what makes that true,
 * by minting above the table's maximum inside the fixture's `repeatable read`
 * snapshot. The membership assertion below is what stops a case reaching for an
 * ordinary {@link id}, whose rank is a property of the run: it sorts above a
 * uuid v7 and below `zzz-` and `zz-obs-trace-`, so on an empty database it is
 * named and under load it is whatever the neighbours left. That is #622, and it was
 * reachable from all nine call sites, not the two that happened to fail.
 *
 * This does NOT assume the ordering is why the row is named: `result()` breaking
 * its per-sub-scan turn, or a check growing a twenty-first sub-scan, both fail
 * the sample assertion — which is the point of keeping it.
 *
 * An empty sample fails this assertion rather than passing it, which is the
 * property to preserve if it is ever rewritten: "no rows" and "my row is there"
 * must never read the same.
 */
function expectDetected(
  before: CatalogIntegrityResult,
  after: CatalogIntegrityResult,
  what: string,
  table: ProbeTable,
  probe: string,
  added = 1,
): void {
  expect(after.findings - before.findings, `${what}: findings did not move`).toBe(added);
  expect(after.population, `${what}: population shrank`).toBeGreaterThanOrEqual(before.population);
  expectNamed(after, what, table, probe);
}

/**
 * The sample half of {@link expectDetected}, on its own.
 *
 * The two cases that find a PAIR — a cycle, whose two nodes each reach
 * themselves, and the two queue tables holding an expired claim — assert their
 * own delta and then name both rows, so they need the naming assertion without
 * the one-row delta. It is the same assertion and the same registry check: every
 * sample-membership assertion in this file goes through here.
 */
function expectNamed(
  after: CatalogIntegrityResult,
  what: string,
  table: ProbeTable,
  probe: string,
): void {
  const handle = `${table}:${probe}`;
  expect(
    mintedProbes.has(handle),
    `${what}: ${probe} did not come from probeId, so nothing bounds where it lands in the sample`,
  ).toBe(true);
  expect(after.sample, `${what}: the offending row is not named in the sample`).toContain(handle);
}

/** Assert a check did NOT react — the other half of a control. */
function expectIgnored(
  before: CatalogIntegrityResult,
  after: CatalogIntegrityResult,
  what: string,
): void {
  expect(after.findings, `${what}: a correct row was reported as a finding`).toBe(before.findings);
}

/**
 * A `text[]` literal, written as an explicit `array[…]` constructor.
 *
 * Interpolating a JS array into a drizzle `sql` template does NOT produce one:
 * a bare array renders as a row constructor, and a single-element array is
 * bound as a scalar the server then refuses with `22P02 malformed array
 * literal` — which is what the first run of this file did, on exactly the
 * fixtures whose ancestry was supposed to be CORRECT. That is the direction
 * that matters: the broken-row cases passed regardless.
 */
function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** A category, inserted raw so the fixture states exactly what is on the row. */
async function insertCategory(
  tx: Transaction,
  categoryId: string,
  key: string,
  options: { parentId?: string; ancestorIds?: readonly string[] } = {},
): Promise<string> {
  await tx.execute(sql`
    insert into categories (id, key, name, slug, parent_id, ancestor_ids, lifecycle, selectable)
    values (${categoryId}, ${key}, ${'Integrity probe'}, ${`${categoryId}-slug`},
            ${options.parentId ?? null},
            ${textArray(options.ancestorIds ?? [])},
            'published', true)
  `);
  return categoryId;
}

/**
 * A governance change request, inserted raw.
 *
 * `subject_kind` is `category` at every call site: the column is polymorphic
 * over nine kinds and each takes the same `not exists` path, so a case that
 * varied it would be measuring the discriminant rather than the check.
 */
async function insertChangeRequest(
  tx: Transaction,
  requestId: string,
  subjectId: string,
  state: 'planned' | 'withdrawn' = 'planned',
): Promise<string> {
  await tx.execute(sql`
    insert into catalog_governance_change_requests
      (id, domain, action, subject_kind, subject_id, state, parameters, reason,
       requested_by_oxy_user_id, requested_at, requires_second_approval,
       impact_coverage, impact_unmeasured_reason)
    values (${requestId}, 'taxonomy', 'taxonomy_deprecate', 'category',
            ${subjectId}, ${state}, '{}'::jsonb, 'an integrity probe',
            ${`${requestId}-operator`}, now(), false, 'unmeasured', 'probe')
  `);
  return requestId;
}

/** An APPROVED proposal that resolved onto `resolvedEntityId`. */
async function insertApprovedProposal(
  tx: Transaction,
  proposalId: string,
  resolvedEntityId: string,
): Promise<string> {
  await tx.execute(sql`
    insert into catalog_proposals
      (id, type, origin, state, submitted_by_oxy_user_id, proposed_label, source_locale,
       normalized_label, search_label, resolved_entity_id, decided_by_oxy_user_id,
       decided_at, decision_reason)
    values (${proposalId}, 'attribute', 'operator', 'approved',
            ${`${proposalId}-submitter`}, 'Integrity probe', 'en',
            ${`${proposalId}-label`}, ${`${proposalId}-label`},
            ${resolvedEntityId}, ${`${proposalId}-reviewer`}, now(),
            'merged into an existing definition')
  `);
  return proposalId;
}

/* -------------------------------------------------------------------------- */
/* The sweep itself                                                            */
/* -------------------------------------------------------------------------- */

describe('runCatalogIntegrityChecks', () => {
  it('runs all six checks, reports `complete`, and prints every population', async () => {
    const report = await runCatalogIntegrityChecks();

    // `complete` is the whole contract of the report: five clean checks and one
    // that threw look identical in `results` alone.
    expect(report.complete, 'a check did not run — see the logged failure').toBe(true);
    expect(report.results).toHaveLength(CATALOG_INTEGRITY_CHECK_KINDS.length);
    expect([...report.results].map((r) => r.kind).sort()).toEqual(
      [...CATALOG_INTEGRITY_CHECK_KINDS].sort(),
    );

    for (const entry of report.results) {
      expect(Number.isInteger(entry.population), `${entry.kind}: population is not a count`).toBe(
        true,
      );
      expect(entry.population, `${entry.kind}: negative population`).toBeGreaterThanOrEqual(0);
      expect(entry.sample.length, `${entry.kind}: sample is unbounded`).toBeLessThanOrEqual(20);
      expect(entry.sample.length, `${entry.kind}: more samples than findings`).toBeLessThanOrEqual(
        entry.findings,
      );
      expect(Date.parse(entry.checkedAt), `${entry.kind}: checkedAt is not a timestamp`).not.toBeNaN();
    }

    // Printed on SUCCESS, not only on failure: `findings: 0` over a population
    // of zero and over a population of forty thousand are the same assertion and
    // opposite facts, and the run log is where a reader sees which one this was.
    // `process.stdout.write` rather than `console`, which vitest intercepts.
    process.stdout.write(
      `\ncatalog integrity sweep (population/findings):\n${[...report.results]
        .map((entry) => `  ${entry.kind.padEnd(28)} ${entry.population} / ${entry.findings}`)
        .join('\n')}\n\n`,
    );
  });

  /**
   * The whole sweep's vacuity floor, in one case.
   *
   * The case above legitimately reports six populations of ZERO on a freshly
   * migrated throwaway database — which is the honest reading and is exactly
   * why it cannot be the only case: six population queries that returned
   * nothing and six that are broken produce the same six zeroes. This seeds ONE
   * row each check must examine and asserts every population moved, so a
   * `countExamined` that silently counted the wrong set, or a subject query
   * whose predicate matches nothing, fails here rather than reading as a clean
   * catalogue forever.
   */
  it('counts a real row into every one of the six populations', async () => {
    await rolledBack(async (tx) => {
      const before = await runCatalogIntegrityChecks(tx);

      const { storeId, listingId, categoryId } = await insertPublishedDraftFixtures(tx, 'floor');
      const child = await insertCategory(tx, id('floor', 'child'), 'zz_obs_integ.floor.child', {
        parentId: categoryId,
        ancestorIds: [categoryId],
      });
      await tx.execute(sql`
        insert into category_redirects
          (id, subject_kind, subject_category_id, target_category_id, reason, effective_from)
        values (${id('floor', 'redirect')}, 'category_id', ${child}, ${categoryId}, 'merged',
                now() - interval '1 hour')
      `);
      const definitionId = id('floor', 'ptd');
      await tx.execute(sql`
        insert into product_type_definitions
          (id, key, version, lifecycle, name, pending_proposal_policy, published_by_oxy_user_id, published_at)
        values (${definitionId}, 'zz_obs_integ_floor', 1, 'published', 'Integrity probe',
                'block_publication', ${id('floor', 'operator')}, now())
      `);
      await tx.execute(sql`
        insert into catalog_authoring_drafts
          (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
           flow, locale, market, schema_hash, version, published_listing_id, published_at, expires_at)
        values (${id('floor', 'draft')}, ${storeId}, ${id('floor', 'author')}, 'published',
                ${categoryId}, ${definitionId}, 'merchant', 'en', 'ES', 'probe-hash', 1,
                ${listingId}, now(), null)
      `);
      await tx.execute(sql`
        insert into catalog_backfill_runs
          (id, stage, mode, mapping_version, cohort_kind, cohort_value, status, started_at,
           lease_owner, lease_until, requested_by_oxy_user_id)
        values (${id('floor', 'run')}, 'variant_matching', 'dry_run', 1, 'store',
                ${id('floor', 'store')}, 'running', now(), ${id('floor', 'worker')},
                now() + interval '10 minutes', ${id('floor', 'operator')})
      `);

      const after = await runCatalogIntegrityChecks(tx);
      expect(after.complete).toBe(true);

      const populationOf = (report: typeof after, kind: string): number =>
        [...report.results].find((entry) => entry.kind === kind)?.population ?? -1;

      for (const kind of CATALOG_INTEGRITY_CHECK_KINDS) {
        expect(
          populationOf(after, kind),
          `${kind}: population did not grow — this check examined none of the rows it exists for`,
        ).toBeGreaterThan(populationOf(before, kind));
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 1. Orphaned references                                                      */
/* -------------------------------------------------------------------------- */

describe('checkOrphanedReferences', () => {
  it('finds an OPEN change request whose subject category no longer exists', async () => {
    await rolledBack(async (tx) => {
      const before = await checkOrphanedReferences(tx);
      const requestId = await insertChangeRequest(
        tx,
        await probeId(tx, 'catalog_governance_change_requests', 'orphan', 'request'),
        id('orphan', 'ghost-category'),
      );

      const after = await checkOrphanedReferences(tx);
      expectDetected(
        before,
        after,
        'an open change request naming a category that does not exist',
        'catalog_governance_change_requests',
        requestId,
      );
    });
  });

  it('ignores the same request once its subject exists, and once it is terminal', async () => {
    await rolledBack(async (tx) => {
      // A REAL subject. The negative control for the `not exists` predicate: a
      // check that reported every open request would pass the case above.
      const categoryId = await insertCategory(tx, id('orphan2', 'cat'), 'zz_obs_integ.orphan2');
      const before = await checkOrphanedReferences(tx);

      await insertChangeRequest(tx, id('orphan2', 'live'), categoryId);
      expectIgnored(before, await checkOrphanedReferences(tx), 'a request naming a live category');

      // And a WITHDRAWN request naming a ghost. A terminal request is history —
      // `CATALOG_GOVERNANCE_OPEN_CHANGE_STATES` is what the scan reads, and this
      // is the case that tells that tuple from "every request".
      await insertChangeRequest(
        tx,
        id('orphan2', 'withdrawn'),
        id('orphan2', 'ghost'),
        'withdrawn',
      );
      expectIgnored(
        before,
        await checkOrphanedReferences(tx),
        'a terminal request naming a ghost category',
      );
    });
  });

  it('finds an APPROVED proposal whose resolved attribute definition is gone', async () => {
    await rolledBack(async (tx) => {
      const before = await checkOrphanedReferences(tx);
      const proposalId = await insertApprovedProposal(
        tx,
        await probeId(tx, 'catalog_proposals', 'orphan3', 'proposal'),
        id('orphan3', 'ghost-attribute'),
      );

      const after = await checkOrphanedReferences(tx);
      expectDetected(
        before,
        after,
        'an approved proposal resolved onto an attribute definition that does not exist',
        'catalog_proposals',
        proposalId,
      );
    });
  });

  /**
   * The case above, with the condition that used to break it created HERE
   * instead of waited for (#618, #622).
   *
   * `checkOrphanedReferences` is three sub-scans, and the sample used to be the
   * head of their concatenation — so once the earlier two produced
   * `INTEGRITY_SAMPLE_LIMIT` handles between them, no `catalog_proposals` handle
   * could appear at all, whatever the check found. Both earlier sub-scans are
   * database-wide and `catalog-governance.realdb.test.ts` legitimately leaves
   * orphaned change requests behind, so on `main` whether the case above passed
   * was decided by which files had committed before this one ran: measured over
   * ten full-suite runs, five failed, every failing run reporting
   * `orphaned_reference` findings at or above the cap and every passing run
   * reporting none.
   *
   * Seeding the flood inside this file's own rolled-back transaction makes that
   * condition hold on EVERY run, so this case fails on the unrepaired assembly
   * rather than half the time.
   */
  it('names a dangling proposal behind a sample already full of change requests', async () => {
    await rolledBack(async (tx) => {
      for (let n = 0; n < INTEGRITY_SAMPLE_LIMIT; n += 1) {
        await insertChangeRequest(
          tx,
          id('flood', `request-${String(n).padStart(2, '0')}`),
          id('flood', 'ghost-category'),
        );
      }
      const before = await checkOrphanedReferences(tx);

      // The premise of the case, asserted rather than assumed: with the sample
      // any shorter than the cap there is room for the proposal at the tail, the
      // assertion below passes on the unrepaired assembly too, and this case
      // measures nothing.
      expect(before.sample, 'the flood did not fill the sample').toHaveLength(
        INTEGRITY_SAMPLE_LIMIT,
      );

      const proposalId = await insertApprovedProposal(
        tx,
        await probeId(tx, 'catalog_proposals', 'flood', 'proposal'),
        id('flood', 'ghost-attribute'),
      );

      expectDetected(
        before,
        await checkOrphanedReferences(tx),
        'a dangling proposal behind a full sample of dangling change requests',
        'catalog_proposals',
        proposalId,
      );
    });
  });

  /**
   * The case above floods a DIFFERENT sub-scan; this one floods the probe's OWN,
   * which is the half #622 was reopened for.
   *
   * `result()` gives each sub-scan a turn, so a rival sub-scan can no longer
   * starve this one. What it cannot do is decide where a row sits WITHIN its own
   * sub-scan: that is `order by id desc`, and an ordinary {@link id} outranks a
   * uuid v7 and loses to any `zzz-` or `zz_` fixture — so on a database holding
   * enough higher-sorting findings of the same kind, the probe falls outside the
   * cap and the check appears not to name what it found. That was reachable from
   * every call site here, and it was a property of what parallel files had
   * committed rather than of the check.
   *
   * The crowd below is what a busy database looks like from inside this
   * transaction, created rather than waited for. It is minted DOMINANT, one id
   * above the next, so the premise holds on an empty database and a loaded one
   * alike: no foreign proposal can outrank the crowd, so every proposal handle
   * the sample carries is one of ours.
   *
   * Mutating {@link probeId} back to {@link id} at the one line below turns this
   * case red and leaves the rest of the file green — which is what says the
   * naming assertion is answerable rather than lucky.
   */
  it('names a dangling proposal that higher-sorting rows in its OWN table would crowd out', async () => {
    await rolledBack(async (tx) => {
      const baseline = await checkOrphanedReferences(tx);

      const crowd: string[] = [];
      for (let n = 0; n < INTEGRITY_SAMPLE_LIMIT; n += 1) {
        crowd.push(
          await insertApprovedProposal(
            tx,
            await probeId(tx, 'catalog_proposals', 'crowd', `p${String(n).padStart(2, '0')}`),
            id('crowd', 'ghost-attribute'),
          ),
        );
      }
      const before = await checkOrphanedReferences(tx);

      // Two premises, both asserted rather than assumed. The crowd became
      // findings at all — without that this case measures an empty table — and
      // it holds every proposal slot the sample has, so a probe ranked below it
      // cannot appear whatever share of the cap this sub-scan is given.
      expect(before.findings - baseline.findings, 'the crowd did not become findings').toBe(
        crowd.length,
      );
      const proposalsNamed = before.sample.filter((entry) =>
        entry.startsWith('catalog_proposals:'),
      );
      expect(proposalsNamed.length, 'the crowd took no proposal slot in the sample').toBeGreaterThan(
        0,
      );
      expect(
        proposalsNamed.filter((entry) => !crowd.includes(entry.slice('catalog_proposals:'.length))),
        'a proposal this case did not create outranks the crowd',
      ).toEqual([]);

      const proposalId = await insertApprovedProposal(
        tx,
        await probeId(tx, 'catalog_proposals', 'crowd', 'probe'),
        id('crowd', 'ghost-attribute'),
      );

      expectDetected(
        before,
        await checkOrphanedReferences(tx),
        'a dangling proposal under twenty higher-sorting dangling proposals',
        'catalog_proposals',
        proposalId,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Invalid redirects                                                        */
/* -------------------------------------------------------------------------- */

describe('checkInvalidRedirects', () => {
  /**
   * A chain of nine, built the way the schema documents a correction being
   * made: each new redirect's target is a fresh category, so the cycle guard's
   * FORWARD walk is one hop and every insert is individually legitimate. The
   * resolver's own `MAX_REDIRECT_HOPS` is 8, so the HEAD of the chain — and
   * only the head — is `chain_exhausted`.
   */
  it('finds the head of a chain the resolver can no longer walk, and nothing else in it', async () => {
    await rolledBack(async (tx) => {
      const links = 9;
      const categoryIds: string[] = [];
      for (let index = 0; index <= links; index += 1) {
        categoryIds.push(
          await insertCategory(tx, id('chain', `c${index}`), `zz_obs_integ.chain.c${index}`),
        );
      }

      const before = await checkInvalidRedirects(tx);

      // Only the HEAD is a finding, so only the head is minted for rank. The
      // eight members after it carry ordinary ids that legitimately sort above
      // it and are never reported — which the assertions below check.
      const redirectIds: string[] = [];
      for (let index = 0; index < links; index += 1) {
        const redirectId =
          index === 0
            ? await probeId(tx, 'category_redirects', 'chain', 'r0')
            : id('chain', `r${index}`);
        redirectIds.push(redirectId);
        await tx.execute(sql`
          insert into category_redirects
            (id, subject_kind, subject_category_id, target_category_id, reason, effective_from)
          values (${redirectId}, 'category_id', ${categoryIds[index]},
                  ${categoryIds[index + 1]}, 'reparented', now() - interval '1 hour')
        `);
      }

      const after = await checkInvalidRedirects(tx);
      expectDetected(
        before,
        after,
        'a nine-hop redirect chain whose head the resolver cannot finish',
        'category_redirects',
        redirectIds[0],
      );

      // The other eight are chain MEMBERS and are not findings — a chain is the
      // documented correction pattern, so a check that flagged every chain would
      // report ordinary maintenance as breakage while passing the assertion
      // above.
      for (const redirectId of redirectIds.slice(1)) {
        expect(after.sample, `${redirectId} is a resolvable chain member`).not.toContain(
          `category_redirects:${redirectId}`,
        );
      }
    });
  });

  it('ignores a short chain and a plain redirect, and counts both in the population', async () => {
    await rolledBack(async (tx) => {
      const a = await insertCategory(tx, id('short', 'a'), 'zz_obs_integ.short.a');
      const b = await insertCategory(tx, id('short', 'b'), 'zz_obs_integ.short.b');
      const c = await insertCategory(tx, id('short', 'c'), 'zz_obs_integ.short.c');

      const before = await checkInvalidRedirects(tx);
      await tx.execute(sql`
        insert into category_redirects
          (id, subject_kind, subject_category_id, target_category_id, reason, effective_from)
        values (${id('short', 'r1')}, 'category_id', ${a}, ${b}, 'merged', now() - interval '1 hour')
      `);
      await tx.execute(sql`
        insert into category_redirects
          (id, subject_kind, subject_category_id, target_category_id, reason, effective_from)
        values (${id('short', 'r2')}, 'category_id', ${b}, ${c}, 'merged', now() - interval '1 hour')
      `);

      const after = await checkInvalidRedirects(tx);
      expectIgnored(before, after, 'a two-hop chain the resolver finishes');
      expect(after.population, 'the two redirects were not examined').toBe(before.population + 2);
    });
  });

  it('leaves a future-dated redirect out of the population', async () => {
    await rolledBack(async (tx) => {
      const a = await insertCategory(tx, id('future', 'a'), 'zz_obs_integ.future.a');
      const b = await insertCategory(tx, id('future', 'b'), 'zz_obs_integ.future.b');

      const before = await checkInvalidRedirects(tx);
      await tx.execute(sql`
        insert into category_redirects
          (id, subject_kind, subject_category_id, target_category_id, reason, effective_from)
        values (${id('future', 'r')}, 'category_id', ${a}, ${b}, 'operator', now() + interval '30 days')
      `);

      // A redirect staged ahead of a cutover is not yet effective on the ROW,
      // and this check reports what the schema's own dating says. That the
      // RESOLVER ignores `effective_from` entirely is recorded in the service's
      // docblock and is why the chain sub-read is not dated.
      const after = await checkInvalidRedirects(tx);
      expect(after.population, 'a future-dated redirect entered the population').toBe(
        before.population,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Category cycles                                                          */
/* -------------------------------------------------------------------------- */

describe('checkCategoryCycles', () => {
  /**
   * ## The positive control needs the trigger stood down, and that is the point
   *
   * `mercaria_category_hierarchy_guard` refuses a cycle on INSERT and on any
   * UPDATE that moves `parent_id`, so a cycle CANNOT be created through any
   * ordinary write — which is exactly why the detector exists, and exactly why
   * asserting it against a clean tree would prove nothing at all.
   *
   * `set local session_replication_role = replica` is what a bad restore, a
   * bulk load or a logical-replication stream does to user triggers, so the
   * fixture reproduces the real provenance of the row rather than simulating
   * one. It is `SET LOCAL` on the transaction handle — a bare `SET` on a POOLED
   * connection outlives the test and silences every trigger for whichever file
   * borrows that backend next — and the transaction is rolled back, so both the
   * setting and the cycle are gone before anything else can read either.
   * `advisory-lock-census.test.ts` fails the build on either mistake.
   */
  it('finds a two-node cycle inserted with the hierarchy guard stood down', async () => {
    await rolledBack(async (tx) => {
      const before = await checkCategoryCycles(tx);

      const a = await insertCategory(
        tx,
        await probeId(tx, 'categories', 'cycle', 'a'),
        'zz_obs_integ.cycle.a',
      );
      const b = await insertCategory(
        tx,
        await probeId(tx, 'categories', 'cycle', 'b'),
        'zz_obs_integ.cycle.b',
        { parentId: a },
      );

      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update categories set parent_id = ${b} where id = ${a}`);
      await tx.execute(sql`set local session_replication_role = origin`);

      const after = await checkCategoryCycles(tx);
      // BOTH nodes reach themselves, so both are findings: a cycle has no head.
      expect(after.findings - before.findings, 'the cycle was not detected').toBe(2);
      expectNamed(after, 'the first node of a two-node cycle', 'categories', a);
      expectNamed(after, 'the second node of a two-node cycle', 'categories', b);
      // The walk terminated. Without the depth cap in the recursive term this
      // statement runs until the connection dies, which is the failure the check
      // would otherwise INTRODUCE, so completing at all is the assertion.
      expect(after.population, 'the cycle nodes were not in the population').toBeGreaterThanOrEqual(
        before.population + 1,
      );
    });
  });

  it('reports nothing for an ordinary three-level branch', async () => {
    await rolledBack(async (tx) => {
      const root = await insertCategory(tx, id('acyclic', 'root'), 'zz_obs_integ.acyclic.root');
      const mid = await insertCategory(tx, id('acyclic', 'mid'), 'zz_obs_integ.acyclic.mid', {
        parentId: root,
        ancestorIds: [root],
      });

      const before = await checkCategoryCycles(tx);
      await insertCategory(tx, id('acyclic', 'leaf'), 'zz_obs_integ.acyclic.leaf', {
        parentId: mid,
        ancestorIds: [root, mid],
      });

      const after = await checkCategoryCycles(tx);
      expectIgnored(before, after, 'a well-formed branch');
      expect(after.population, 'the new child was not examined').toBe(before.population + 1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Ancestry path drift                                                      */
/* -------------------------------------------------------------------------- */

describe('checkAncestryPathDrift', () => {
  it('finds a child whose `ancestor_ids` is empty under a real parent', async () => {
    await rolledBack(async (tx) => {
      const root = await insertCategory(tx, id('drift', 'root'), 'zz_obs_integ.drift.root');
      const before = await checkAncestryPathDrift(tx);

      // The materialized path is maintained by the MOVE statement and by
      // nothing else — no CHECK can read another row and no trigger recomputes
      // it — so a write that sets `parent_id` and leaves `ancestor_ids` alone is
      // accepted in full and every descendants read is silently wrong from then
      // on. That is the whole failure this check exists for, written literally.
      const child = await insertCategory(
        tx,
        await probeId(tx, 'categories', 'drift', 'child'),
        'zz_obs_integ.drift.child',
        { parentId: root },
      );

      const after = await checkAncestryPathDrift(tx);
      expectDetected(before, after, 'a child carrying no ancestry', 'categories', child);
    });
  });

  it('finds a stale path left behind by a re-parent, and accepts the corrected one', async () => {
    await rolledBack(async (tx) => {
      const first = await insertCategory(tx, id('move', 'first'), 'zz_obs_integ.move.first');
      const second = await insertCategory(tx, id('move', 'second'), 'zz_obs_integ.move.second');
      const child = await insertCategory(
        tx,
        await probeId(tx, 'categories', 'move', 'child'),
        'zz_obs_integ.move.child',
        { parentId: first, ancestorIds: [first] },
      );

      // Correct to begin with: the control that says the comparison is real
      // rather than reporting every row with a parent.
      const clean = await checkAncestryPathDrift(tx);

      // The move that forgets the path — the plausible half-write.
      await tx.execute(sql`update categories set parent_id = ${second} where id = ${child}`);
      const drifted = await checkAncestryPathDrift(tx);
      expectDetected(clean, drifted, 'a re-parent that left the old path', 'categories', child);

      // And the correction: the same row, path rewritten, is no longer a
      // finding. Without this the case above would also pass against a check
      // that reported every category unconditionally.
      await tx.execute(
        sql`update categories set ancestor_ids = ${textArray([second])} where id = ${child}`,
      );
      const repaired = await checkAncestryPathDrift(tx);
      expect(repaired.findings, 'a corrected path is still reported').toBe(clean.findings);
    });
  });

  it('accepts a two-level path root-first, and rejects the same ids reversed', async () => {
    await rolledBack(async (tx) => {
      const root = await insertCategory(tx, id('order', 'root'), 'zz_obs_integ.order.root');
      const mid = await insertCategory(tx, id('order', 'mid'), 'zz_obs_integ.order.mid', {
        parentId: root,
        ancestorIds: [root],
      });
      const before = await checkAncestryPathDrift(tx);

      // ORDER is the fact under test. `ancestor_ids` is root-first (ADR 0007
      // D2), and an array carrying the right ids the wrong way round is the
      // shape a hand-written path takes — every membership query still passes,
      // and every breadcrumb is backwards.
      const leaf = await insertCategory(
        tx,
        await probeId(tx, 'categories', 'order', 'leaf'),
        'zz_obs_integ.order.leaf',
        { parentId: mid, ancestorIds: [mid, root] },
      );
      const reversed = await checkAncestryPathDrift(tx);
      expectDetected(before, reversed, 'a reversed ancestry path', 'categories', leaf);

      await tx.execute(
        sql`update categories set ancestor_ids = ${textArray([root, mid])} where id = ${leaf}`,
      );
      const corrected = await checkAncestryPathDrift(tx);
      expect(corrected.findings, 'a root-first path is reported as drift').toBe(before.findings);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Unretrievable pinned schema versions                                     */
/* -------------------------------------------------------------------------- */

/** The store and listing a published draft needs to exist at all. */
async function insertPublishedDraftFixtures(tx: Transaction, scope: string): Promise<{
  storeId: string;
  listingId: string;
  categoryId: string;
}> {
  const storeId = id(scope, 'store');
  const listingId = id(scope, 'listing');
  const categoryId = await insertCategory(tx, id(scope, 'cat'), `zz_obs_integ.${scope}`);
  await tx.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${storeId}, 'Integrity probe', ${`${storeId}-handle`}, '', '#000000')
  `);
  await tx.execute(sql`
    insert into listings (id, owner_type, store_id, title, description, condition,
                          condition_assertion, status)
    values (${listingId}, 'store', ${storeId}, 'Integrity probe', 'Integrity probe',
            'new', 'seller_declared', 'active')
  `);
  return { storeId, listingId, categoryId };
}

describe('checkSchemaVersionAvailability', () => {
  it('finds a published draft pinning a version that went back to `review`', async () => {
    await rolledBack(async (tx) => {
      const { storeId, listingId, categoryId } = await insertPublishedDraftFixtures(tx, 'schema');
      const definitionId = id('schema', 'ptd');
      const draftId = await probeId(tx, 'catalog_authoring_drafts', 'schema', 'draft');

      // `review` is EDITABLE, so this version's fields can still move and the
      // schema the draft's answers were recorded under is no longer obtainable.
      // `composeAuthoringSchema` refuses exactly this, and the check derives the
      // set from `PRODUCT_TYPE_EDITABLE_LIFECYCLES` rather than restating it.
      await tx.execute(sql`
        insert into product_type_definitions (id, key, version, lifecycle, name, pending_proposal_policy)
        values (${definitionId}, 'zz_obs_integ_schema', 1, 'review', 'Integrity probe',
                'block_publication')
      `);

      const before = await checkSchemaVersionAvailability(tx);
      await tx.execute(sql`
        insert into catalog_authoring_drafts
          (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
           flow, locale, market, schema_hash, version, published_listing_id, published_at, expires_at)
        values (${draftId}, ${storeId}, ${id('schema', 'author')}, 'published', ${categoryId},
                ${definitionId}, 'merchant', 'en', 'ES', 'probe-hash', 1, ${listingId}, now(), null)
      `);

      const after = await checkSchemaVersionAvailability(tx);
      expectDetected(
        before,
        after,
        'a published draft pinning an unfrozen product-type version',
        'catalog_authoring_drafts',
        draftId,
      );
    });
  });

  it('accepts a published draft pinning a `published` version, and counts it', async () => {
    await rolledBack(async (tx) => {
      const { storeId, listingId, categoryId } = await insertPublishedDraftFixtures(tx, 'schemaok');
      const definitionId = id('schemaok', 'ptd');

      await tx.execute(sql`
        insert into product_type_definitions
          (id, key, version, lifecycle, name, pending_proposal_policy, published_by_oxy_user_id, published_at)
        values (${definitionId}, 'zz_obs_integ_schemaok', 1, 'published', 'Integrity probe',
                'block_publication', ${id('schemaok', 'operator')}, now())
      `);

      const before = await checkSchemaVersionAvailability(tx);
      await tx.execute(sql`
        insert into catalog_authoring_drafts
          (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
           flow, locale, market, schema_hash, version, published_listing_id, published_at, expires_at)
        values (${id('schemaok', 'draft')}, ${storeId}, ${id('schemaok', 'author')}, 'published',
                ${categoryId}, ${definitionId}, 'merchant', 'en', 'ES', 'probe-hash', 1,
                ${listingId}, now(), null)
      `);

      const after = await checkSchemaVersionAvailability(tx);
      expectIgnored(before, after, 'a draft pinning a frozen published version');
      expect(after.population, 'the published draft was not examined').toBe(before.population + 1);
    });
  });

  it('leaves an OPEN draft out of the population entirely', async () => {
    await rolledBack(async (tx) => {
      const { storeId, categoryId } = await insertPublishedDraftFixtures(tx, 'schemaopen');
      const definitionId = id('schemaopen', 'ptd');

      await tx.execute(sql`
        insert into product_type_definitions (id, key, version, lifecycle, name, pending_proposal_policy)
        values (${definitionId}, 'zz_obs_integ_schemaopen', 1, 'draft', 'Integrity probe',
                'block_publication')
      `);

      const before = await checkSchemaVersionAvailability(tx);
      // An open draft against an editable version is ordinary authoring in
      // progress, not a broken audit record: the schema hash mismatch is what
      // the upgrade preview exists to show the merchant.
      await tx.execute(sql`
        insert into catalog_authoring_drafts
          (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
           flow, locale, market, schema_hash, version, expires_at)
        values (${id('schemaopen', 'draft')}, ${storeId}, ${id('schemaopen', 'author')}, 'open',
                ${categoryId}, ${definitionId}, 'merchant', 'en', 'ES', 'probe-hash', 1,
                now() + interval '1 day')
      `);

      const after = await checkSchemaVersionAvailability(tx);
      expect(after.population, 'an open draft entered the population').toBe(before.population);
      expectIgnored(before, after, 'an open draft against an editable version');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Stalled queue leases                                                     */
/* -------------------------------------------------------------------------- */

describe('checkStalledQueueLeases', () => {
  it('finds a backfill run holding an expired lease, and not one holding a live lease', async () => {
    await rolledBack(async (tx) => {
      const before = await checkStalledQueueLeases(tx);
      const stalled = await probeId(tx, 'catalog_backfill_runs', 'lease', 'run-stalled');

      await tx.execute(sql`
        insert into catalog_backfill_runs
          (id, stage, mode, mapping_version, cohort_kind, cohort_value, status, started_at,
           lease_owner, lease_until, requested_by_oxy_user_id)
        values (${stalled}, 'variant_matching', 'dry_run', 1, 'store', ${id('lease', 'store-a')},
                'running', now() - interval '2 hours', ${id('lease', 'worker')},
                now() - interval '1 hour', ${id('lease', 'operator')})
      `);
      // A LIVE lease, which is a task doing its job. It must be in the
      // population and not in the findings, or the check is counting claims
      // rather than stalls.
      await tx.execute(sql`
        insert into catalog_backfill_runs
          (id, stage, mode, mapping_version, cohort_kind, cohort_value, status, started_at,
           lease_owner, lease_until, requested_by_oxy_user_id)
        values (${id('lease', 'run-live')}, 'variant_matching', 'dry_run', 1, 'store',
                ${id('lease', 'store-b')}, 'running', now() - interval '2 minutes',
                ${id('lease', 'worker')}, now() + interval '10 minutes', ${id('lease', 'operator')})
      `);

      const after = await checkStalledQueueLeases(tx);
      expectDetected(
        before,
        after,
        'a backfill run whose lease expired an hour ago',
        'catalog_backfill_runs',
        stalled,
      );
      expect(after.population, 'both claims should be in the population').toBe(
        before.population + 2,
      );
    });
  });

  it('finds an expired claim on a mapping run and on a token observation', async () => {
    await rolledBack(async (tx) => {
      const sourceId = id('lease2', 'source');
      await tx.execute(sql`
        insert into catalog_sources (id, kind, name, may_display, may_store, attribution_required)
        values (${sourceId}, 'operator', ${id('lease2', 'source-name')}, false, false, false)
      `);

      const before = await checkStalledQueueLeases(tx);
      const runId = await probeId(tx, 'catalog_external_mapping_runs', 'lease2', 'run');
      const observationId = await probeId(
        tx,
        'catalog_external_token_observations',
        'lease2',
        'observation',
      );

      await tx.execute(sql`
        insert into catalog_external_mapping_runs
          (id, catalog_source_id, mode, state, requested_by_oxy_user_id,
           claimed_at, claimed_by, claim_expires_at)
        values (${runId}, ${sourceId}, 'dry_run', 'running', ${id('lease2', 'operator')},
                now() - interval '2 hours', ${id('lease2', 'worker')}, now() - interval '1 hour')
      `);
      await tx.execute(sql`
        insert into catalog_external_token_observations
          (id, catalog_source_id, dimension, external_key, subject_kind, subject_key,
           resolution_outcome, unresolved_reason, first_observed_at, last_observed_at, occurrences,
           reprocess_requested_at, reprocess_claimed_at, reprocess_claimed_by,
           reprocess_claim_expires_at)
        values (${observationId}, ${sourceId}, 'attribute', ${id('lease2', 'token')},
                'operator_probe', ${id('lease2', 'subject')}, 'unresolved', 'unmapped',
                now() - interval '3 hours', now() - interval '3 hours', 1,
                now() - interval '3 hours', now() - interval '2 hours', ${id('lease2', 'worker')},
                now() - interval '1 hour')
      `);

      const after = await checkStalledQueueLeases(tx);
      expect(after.findings - before.findings, 'both expired claims should be found').toBe(2);
      expectNamed(after, 'a mapping run holding an expired claim', 'catalog_external_mapping_runs', runId);
      expectNamed(
        after,
        'a token observation holding an expired reprocess claim',
        'catalog_external_token_observations',
        observationId,
      );
      expect(after.population, 'both claims should be in the population').toBe(
        before.population + 2,
      );
    });
  });

  it('leaves a finished mapping run and a reprocessed observation out of the population', async () => {
    await rolledBack(async (tx) => {
      const sourceId = id('lease3', 'source');
      await tx.execute(sql`
        insert into catalog_sources (id, kind, name, may_display, may_store, attribution_required)
        values (${sourceId}, 'operator', ${id('lease3', 'source-name')}, false, false, false)
      `);

      const before = await checkStalledQueueLeases(tx);
      // A COMPLETED run keeps its claim columns as history. Reading the expiry
      // without the completion is how a finished queue reports a permanent
      // stall, which is the reading that gets a check muted.
      await tx.execute(sql`
        insert into catalog_external_mapping_runs
          (id, catalog_source_id, mode, state, requested_by_oxy_user_id,
           claimed_at, claimed_by, claim_expires_at, finished_at)
        values (${id('lease3', 'run')}, ${sourceId}, 'dry_run', 'completed',
                ${id('lease3', 'operator')}, now() - interval '2 hours', ${id('lease3', 'worker')},
                now() - interval '1 hour', now() - interval '30 minutes')
      `);
      await tx.execute(sql`
        insert into catalog_external_token_observations
          (id, catalog_source_id, dimension, external_key, subject_kind, subject_key,
           resolution_outcome, unresolved_reason, first_observed_at, last_observed_at, occurrences,
           reprocess_requested_at, reprocess_claimed_at, reprocess_claimed_by,
           reprocess_claim_expires_at, reprocessed_at)
        values (${id('lease3', 'observation')}, ${sourceId}, 'attribute', ${id('lease3', 'token')},
                'operator_probe', ${id('lease3', 'subject')}, 'unresolved', 'unmapped',
                now() - interval '3 hours', now() - interval '3 hours', 1,
                now() - interval '3 hours', now() - interval '2 hours', ${id('lease3', 'worker')},
                now() - interval '1 hour', now() - interval '30 minutes')
      `);

      const after = await checkStalledQueueLeases(tx);
      expect(after.population, 'finished work entered the population').toBe(before.population);
      expectIgnored(before, after, 'a finished run and a reprocessed observation');
    });
  });
});
