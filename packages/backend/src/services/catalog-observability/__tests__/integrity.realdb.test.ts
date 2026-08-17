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
  runCatalogIntegrityChecks,
} from '../integrity.service.js';

const db: Database = await connectPostgres();

/**
 * Every id this file mints.
 *
 * `zz-` first for a reason that is not cosmetic: every scan here orders
 * `id desc` (newest first, uuid v7), and a text id beginning `zz-` sorts above
 * every uuid v7 hex id and above every sibling fixture prefix in this
 * repository. So a row created by a case below is inside the bounded sample the
 * check returns, whatever else the shared database is holding.
 */
const P = 'zz-obs-integ';

/** A distinct suffix per case, so two cases cannot collide on a unique index. */
function id(scope: string, name: string): string {
  return `${P}-${scope}-${name}`;
}

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
 */
function expectDetected(
  before: CatalogIntegrityResult,
  after: CatalogIntegrityResult,
  what: string,
  handle: string,
  added = 1,
): void {
  expect(after.findings - before.findings, `${what}: findings did not move`).toBe(added);
  expect(after.population, `${what}: population shrank`).toBeGreaterThanOrEqual(before.population);
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
      const requestId = id('orphan', 'request');

      await tx.execute(sql`
        insert into catalog_governance_change_requests
          (id, domain, action, subject_kind, subject_id, state, parameters, reason,
           requested_by_oxy_user_id, requested_at, requires_second_approval,
           impact_coverage, impact_unmeasured_reason)
        values (${requestId}, 'taxonomy', 'taxonomy_deprecate', 'category',
                ${id('orphan', 'ghost-category')}, 'planned', '{}'::jsonb,
                'an integrity probe', ${id('orphan', 'operator')}, now(), false,
                'unmeasured', 'probe')
      `);

      const after = await checkOrphanedReferences(tx);
      expectDetected(
        before,
        after,
        'an open change request naming a category that does not exist',
        `catalog_governance_change_requests:${requestId}`,
      );
    });
  });

  it('ignores the same request once its subject exists, and once it is terminal', async () => {
    await rolledBack(async (tx) => {
      // A REAL subject. The negative control for the `not exists` predicate: a
      // check that reported every open request would pass the case above.
      const categoryId = await insertCategory(tx, id('orphan2', 'cat'), 'zz_obs_integ.orphan2');
      const before = await checkOrphanedReferences(tx);

      await tx.execute(sql`
        insert into catalog_governance_change_requests
          (id, domain, action, subject_kind, subject_id, state, parameters, reason,
           requested_by_oxy_user_id, requested_at, requires_second_approval,
           impact_coverage, impact_unmeasured_reason)
        values (${id('orphan2', 'live')}, 'taxonomy', 'taxonomy_deprecate', 'category',
                ${categoryId}, 'planned', '{}'::jsonb, 'an integrity probe',
                ${id('orphan2', 'operator')}, now(), false, 'unmeasured', 'probe')
      `);
      expectIgnored(before, await checkOrphanedReferences(tx), 'a request naming a live category');

      // And a WITHDRAWN request naming a ghost. A terminal request is history —
      // `CATALOG_GOVERNANCE_OPEN_CHANGE_STATES` is what the scan reads, and this
      // is the case that tells that tuple from "every request".
      await tx.execute(sql`
        insert into catalog_governance_change_requests
          (id, domain, action, subject_kind, subject_id, state, parameters, reason,
           requested_by_oxy_user_id, requested_at, requires_second_approval,
           impact_coverage, impact_unmeasured_reason)
        values (${id('orphan2', 'withdrawn')}, 'taxonomy', 'taxonomy_deprecate', 'category',
                ${id('orphan2', 'ghost')}, 'withdrawn', '{}'::jsonb, 'an integrity probe',
                ${id('orphan2', 'operator')}, now(), false, 'unmeasured', 'probe')
      `);
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
      const proposalId = id('orphan3', 'proposal');

      await tx.execute(sql`
        insert into catalog_proposals
          (id, type, origin, state, submitted_by_oxy_user_id, proposed_label, source_locale,
           normalized_label, search_label, resolved_entity_id, decided_by_oxy_user_id,
           decided_at, decision_reason)
        values (${proposalId}, 'attribute', 'operator', 'approved',
                ${id('orphan3', 'submitter')}, 'Integrity probe', 'en',
                ${id('orphan3', 'label')}, ${id('orphan3', 'label')},
                ${id('orphan3', 'ghost-attribute')}, ${id('orphan3', 'reviewer')}, now(),
                'merged into an existing definition')
      `);

      const after = await checkOrphanedReferences(tx);
      expectDetected(
        before,
        after,
        'an approved proposal resolved onto an attribute definition that does not exist',
        `catalog_proposals:${proposalId}`,
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

      const redirectIds: string[] = [];
      for (let index = 0; index < links; index += 1) {
        const redirectId = id('chain', `r${index}`);
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
        `category_redirects:${redirectIds[0]}`,
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

      const a = await insertCategory(tx, id('cycle', 'a'), 'zz_obs_integ.cycle.a');
      const b = await insertCategory(tx, id('cycle', 'b'), 'zz_obs_integ.cycle.b', { parentId: a });

      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update categories set parent_id = ${b} where id = ${a}`);
      await tx.execute(sql`set local session_replication_role = origin`);

      const after = await checkCategoryCycles(tx);
      // BOTH nodes reach themselves, so both are findings: a cycle has no head.
      expect(after.findings - before.findings, 'the cycle was not detected').toBe(2);
      expect(after.sample).toContain(`categories:${a}`);
      expect(after.sample).toContain(`categories:${b}`);
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
      const child = await insertCategory(tx, id('drift', 'child'), 'zz_obs_integ.drift.child', {
        parentId: root,
      });

      const after = await checkAncestryPathDrift(tx);
      expectDetected(before, after, 'a child carrying no ancestry', `categories:${child}`);
    });
  });

  it('finds a stale path left behind by a re-parent, and accepts the corrected one', async () => {
    await rolledBack(async (tx) => {
      const first = await insertCategory(tx, id('move', 'first'), 'zz_obs_integ.move.first');
      const second = await insertCategory(tx, id('move', 'second'), 'zz_obs_integ.move.second');
      const child = await insertCategory(tx, id('move', 'child'), 'zz_obs_integ.move.child', {
        parentId: first,
        ancestorIds: [first],
      });

      // Correct to begin with: the control that says the comparison is real
      // rather than reporting every row with a parent.
      const clean = await checkAncestryPathDrift(tx);

      // The move that forgets the path — the plausible half-write.
      await tx.execute(sql`update categories set parent_id = ${second} where id = ${child}`);
      const drifted = await checkAncestryPathDrift(tx);
      expectDetected(clean, drifted, 'a re-parent that left the old path', `categories:${child}`);

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
      const leaf = await insertCategory(tx, id('order', 'leaf'), 'zz_obs_integ.order.leaf', {
        parentId: mid,
        ancestorIds: [mid, root],
      });
      const reversed = await checkAncestryPathDrift(tx);
      expectDetected(before, reversed, 'a reversed ancestry path', `categories:${leaf}`);

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
      const draftId = id('schema', 'draft');

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
        `catalog_authoring_drafts:${draftId}`,
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
      const stalled = id('lease', 'run-stalled');

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
        `catalog_backfill_runs:${stalled}`,
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
      const runId = id('lease2', 'run');
      const observationId = id('lease2', 'observation');

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
      expect(after.sample).toContain(`catalog_external_mapping_runs:${runId}`);
      expect(after.sample).toContain(`catalog_external_token_observations:${observationId}`);
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
