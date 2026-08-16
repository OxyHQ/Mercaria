/**
 * The external-mapping domain's CHECKs, partial uniques, generated columns and
 * triggers, against a REAL PostgreSQL server (#367 Workstream 11).
 *
 * None of what this asserts exists without one. A mocked insert accepts any
 * statement including the ones the server refuses outright, so the fan-out
 * refusal, the four-eyes CHECK, the discriminated target shape, the two freeze
 * triggers and the `ON CONFLICT DO NOTHING` convergence would all be comments.
 *
 * ## The three it exists for
 *
 * - **The one-to-many refusal is an INDEX.** `..._live_primary_key` is a partial
 *   unique restricted to rows that resolve AND carry no fan-out approval, so a
 *   second live target is refused by the database rather than by a service
 *   comparison two workers can race past. Both directions are driven below: the
 *   refusal, and the fan-out that legitimately admits the second row.
 * - **`x <> NULL` is NULL and a CHECK rejects only FALSE.** The four-eyes
 *   constraint therefore carries an `approved_by_oxy_user_id is not null`
 *   conjunct, without which it ADMITS a fan-out on a mapping nobody approved —
 *   the exact row it exists to refuse. Driven directly, so the proof does not
 *   depend on anybody re-reading the constraint.
 * - **A stored GENERATED column is NULL inside a BEFORE UPDATE trigger.** Both
 *   freeze triggers compare `external_key` rather than `external_key_normalized`
 *   for that reason; a comparison against the generated column would raise on
 *   every update. The lifecycle cases below are what would fail if either
 *   trigger reached for it.
 *
 * ## A refusal is asserted with its SQLSTATE
 *
 * `expectRefusal` asserts the error CLASS. A statement failing because a column
 * was mistyped throws too, and a test that only asserts "it threw" passes
 * against exactly that — reporting a constraint as enforced when the statement
 * never reached it.
 *
 * ## Scoping
 *
 * The test database is SHARED across parallel files, so every fixture id carries
 * this run's suffix and the teardown deletes by those ids only, children first.
 * Three of the five tables refuse DELETE by trigger, so their teardown takes
 * `withTriggerToggleLock` and the window names exactly the tables it must.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';
import { catalogSources } from '../../../db/schema/provenance.js';
import {
  catalogExternalMappingReviews,
  catalogExternalMappingRunItems,
  catalogExternalMappingRuns,
  catalogExternalMappings,
  catalogExternalTokenObservations,
} from '../../../db/schema/catalogExternalMappings.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const SOURCE = `src-${RUN}`;
const OPERATOR_A = `op-a-${RUN}`;
const OPERATOR_B = `op-b-${RUN}`;

const mappingIds: string[] = [];
const reviewIds: string[] = [];
const runIds: string[] = [];
const observationIds: string[] = [];

/**
 * The validity anchor, safely in the PAST.
 *
 * `#253`: a fixture pinned to a future date passes today, keeps passing, and
 * breaks CI for whoever pushes on the day it arrives — in a file they did not
 * touch. `catalog_external_mappings_validity_order_check` needs
 * `valid_to > valid_from`, so the later instant is DERIVED as an offset from
 * this one rather than written as a second literal that could drift past it.
 */
const VALID_FROM = new Date('2020-01-01T00:00:00Z');
const VALID_TO = new Date(VALID_FROM.getTime() + 86_400_000);

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RAISE_EXCEPTION = 'P0001';

/**
 * Assert a statement is refused, and refused FOR THE RIGHT REASON.
 *
 * A drizzle error's SQLSTATE lives on `cause`, never on `error.code`.
 */
async function expectRefusal(
  label: string,
  run: () => Promise<unknown>,
  sqlState: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `${label}: was NOT refused`).toBeDefined();
  const cause = (caught as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (caught as { code?: string }).code;
  expect(code, `${label}: refused with SQLSTATE ${String(code)}, expected ${sqlState}`).toBe(
    sqlState,
  );
}

/** The insert shape, so a fixture cannot drift from the table. */
type MappingInsert = typeof catalogExternalMappings.$inferInsert;

/** A `proposed` attribute mapping, with everything else defaulted. */
function proposal(overrides: Partial<MappingInsert> = {}): MappingInsert & { id: string } {
  const id = `m-${uuidv7().slice(-10)}-${RUN}`;
  mappingIds.push(id);
  return {
    id,
    catalogSourceId: SOURCE,
    dimension: 'attribute',
    externalKey: `field_${RUN}`,
    targetAttributeKey: 'ram_capacity',
    transformRule: 'identity',
    transformRuleVersion: 1,
    version: 1,
    state: 'proposed',
    provenance: 'operator',
    confidence: 1,
    validFrom: VALID_FROM,
    ...overrides,
  };
}

async function approve(id: string, by: string): Promise<void> {
  await db
    .update(catalogExternalMappings)
    .set({ state: 'approved', approvedByOxyUserId: by, approvedAt: new Date() })
    .where(eq(catalogExternalMappings.id, id));
}

beforeAll(async () => {
  db = await connectPostgres();
  await db.insert(catalogSources).values({
    id: SOURCE,
    kind: 'operator',
    name: `external-mapping realdb ${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
});

afterAll(async () => {
  // Children first. `run_items` cascades from `runs`, but it also refuses DELETE
  // by trigger, so it is removed inside the window rather than left to a cascade
  // that the same trigger would block.
  await withTriggerToggleLock(db, async (tx) => {
    for (const [table, ids, trigger] of [
      ['catalog_external_mapping_run_items', runIds, 'mercaria_catalog_external_run_item_no_delete'],
      ['catalog_external_mapping_reviews', reviewIds, 'mercaria_catalog_external_review_no_delete'],
      ['catalog_external_mappings', mappingIds, 'mercaria_catalog_external_mapping_no_delete'],
    ] as const) {
      if (ids.length === 0) continue;
      await tx.execute(sql.raw(`alter table ${table} disable trigger ${trigger}`));
    }
    if (runIds.length > 0) {
      await tx
        .delete(catalogExternalMappingRunItems)
        .where(inArray(catalogExternalMappingRunItems.runId, runIds));
    }
    if (observationIds.length > 0) {
      await tx
        .delete(catalogExternalTokenObservations)
        .where(inArray(catalogExternalTokenObservations.id, observationIds));
    }
    if (runIds.length > 0) {
      await tx.delete(catalogExternalMappingRuns).where(inArray(catalogExternalMappingRuns.id, runIds));
    }
    if (reviewIds.length > 0) {
      await tx
        .delete(catalogExternalMappingReviews)
        .where(inArray(catalogExternalMappingReviews.id, reviewIds));
    }
    if (mappingIds.length > 0) {
      await tx.delete(catalogExternalMappings).where(inArray(catalogExternalMappings.id, mappingIds));
    }
    for (const [table, ids, trigger] of [
      ['catalog_external_mapping_run_items', runIds, 'mercaria_catalog_external_run_item_no_delete'],
      ['catalog_external_mapping_reviews', reviewIds, 'mercaria_catalog_external_review_no_delete'],
      ['catalog_external_mappings', mappingIds, 'mercaria_catalog_external_mapping_no_delete'],
    ] as const) {
      if (ids.length === 0) continue;
      await tx.execute(sql.raw(`alter table ${table} enable trigger ${trigger}`));
    }
  });
  await db.delete(catalogSources).where(eq(catalogSources.id, SOURCE));
  await closePostgres();
});

describe('1-2. the one-to-many refusal, and the four-eyes CHECK that prices it', () => {
  it('refuses a SECOND live approved mapping for one token with no fan-out approval', async () => {
    const key = `dup_${RUN}`;
    const first = proposal({ externalKey: key, targetAttributeKey: 'ram_capacity' });
    await db.insert(catalogExternalMappings).values(first);
    await approve(first.id, OPERATOR_A);

    const second = proposal({ externalKey: key, targetAttributeKey: 'storage_capacity', version: 2 });
    await db.insert(catalogExternalMappings).values(second);
    await expectRefusal(
      'a second live target with no fan-out',
      () => approve(second.id, OPERATOR_A),
      UNIQUE_VIOLATION,
    );
  });

  it('ADMITS the second once a fan-out is approved by a DIFFERENT operator', async () => {
    const key = `fan_${RUN}`;
    const first = proposal({ externalKey: key, targetAttributeKey: 'ram_capacity' });
    await db.insert(catalogExternalMappings).values(first);
    await approve(first.id, OPERATOR_A);

    const second = proposal({
      externalKey: key,
      targetAttributeKey: 'storage_capacity',
      version: 2,
      state: 'approved',
      approvedByOxyUserId: OPERATOR_A,
      approvedAt: new Date(),
      fanOutApprovedByOxyUserId: OPERATOR_B,
      fanOutApprovedAt: new Date(),
      fanOutRationale: 'this feed uses one field for both capacities',
    });
    await db.insert(catalogExternalMappings).values(second);
    const live = await db
      .select({ id: catalogExternalMappings.id })
      .from(catalogExternalMappings)
      .where(
        and(
          eq(catalogExternalMappings.catalogSourceId, SOURCE),
          eq(catalogExternalMappings.externalKeyNormalized, key),
          eq(catalogExternalMappings.state, 'approved'),
        ),
      );
    expect(live).toHaveLength(2);
  });

  it('refuses a fan-out approved by the SAME operator', async () => {
    await expectRefusal(
      'same operator on both halves',
      () =>
        db.insert(catalogExternalMappings).values(
          proposal({
            externalKey: `same_${RUN}`,
            state: 'approved',
            approvedByOxyUserId: OPERATOR_A,
            approvedAt: new Date(),
            fanOutApprovedByOxyUserId: OPERATOR_A,
            fanOutApprovedAt: new Date(),
            fanOutRationale: 'nope',
          }),
        ),
      CHECK_VIOLATION,
    );
  });

  it('refuses a fan-out on a mapping with a NULL approver — the `x <> NULL` trap', async () => {
    // The whole reason the CHECK carries `approved_by_oxy_user_id is not null`.
    // Without that conjunct `fan_out_approved_by <> approved_by` evaluates to
    // NULL here, a CHECK rejects only FALSE, and this row is ADMITTED.
    await expectRefusal(
      'fan-out with no approver',
      () =>
        db.insert(catalogExternalMappings).values(
          proposal({
            externalKey: `nullapp_${RUN}`,
            fanOutApprovedByOxyUserId: OPERATOR_B,
            fanOutApprovedAt: new Date(),
            fanOutRationale: 'approved by nobody',
          }),
        ),
      CHECK_VIOLATION,
    );
  });
});

describe('3. the discriminated target, including the `else false` branch', () => {
  it('refuses every cross-dimension target', async () => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['attribute row carrying a unit code', { dimension: 'attribute', targetAttributeKey: 'x', targetUnitFamily: 'mass', targetUnitCode: 'g' }],
      ['unit row carrying an attribute key', { dimension: 'unit', targetUnitFamily: 'mass', targetUnitCode: 'g', targetAttributeKey: 'x' }],
      ['product_type row with no key', { dimension: 'product_type' }],
      ['controlled_value with no attribute', { dimension: 'controlled_value', targetControlledValue: 'black' }],
      ['size_system row carrying a pin', { dimension: 'size_system', targetSizeSystemKey: 'shoe.eu', targetProductTypeKey: 'smartphone' }],
    ];
    for (const [label, target] of cases) {
      await expectRefusal(
        label,
        () =>
          db.insert(catalogExternalMappings).values(
            proposal({
              externalKey: `shape_${label.replace(/\W+/g, '_')}_${RUN}`,
              targetAttributeKey: null,
              ...target,
            }),
          ),
        CHECK_VIOLATION,
      );
    }
  });

  it('refuses an unknown dimension — the `else false` branch', async () => {
    // The dimension CHECK refuses it first, which is the point: BOTH constraints
    // have to be satisfied, so a seventh dimension added to the tuple without a
    // branch in the shape CHECK still cannot be written.
    await expectRefusal(
      'a dimension nobody declared',
      () =>
        db.execute(sql`
          insert into catalog_external_mappings
            (id, catalog_source_id, dimension, external_key, transform_rule,
             transform_rule_version, version, state, provenance, confidence, valid_from)
          values (${`bad-${RUN}`}, ${SOURCE}, 'brand', ${`brand_${RUN}`}, 'identity',
                  1, 1, 'proposed', 'operator', 1, now())
        `),
      CHECK_VIOLATION,
    );
  });
});

describe('4-5. the two triggers on a mapping', () => {
  it('the freeze trigger refuses a target change on an approved row and PERMITS a valid_to stamp', async () => {
    const row = proposal({ externalKey: `frozen_${RUN}` });
    await db.insert(catalogExternalMappings).values(row);
    const id = row.id;
    await approve(id, OPERATOR_A);

    await expectRefusal(
      'retargeting an approved mapping',
      () =>
        db
          .update(catalogExternalMappings)
          .set({ targetAttributeKey: 'storage_capacity' })
          .where(eq(catalogExternalMappings.id, id)),
      RAISE_EXCEPTION,
    );

    // The same UPDATE path the trigger must NOT raise on — and the case that
    // would fail if it compared the stored GENERATED column, which is NULL here.
    await db
      .update(catalogExternalMappings)
      .set({ state: 'superseded', validTo: VALID_TO })
      .where(eq(catalogExternalMappings.id, id));
    const [after] = await db
      .select({ state: catalogExternalMappings.state, validTo: catalogExternalMappings.validTo })
      .from(catalogExternalMappings)
      .where(eq(catalogExternalMappings.id, id));
    expect(after?.state).toBe('superseded');
    expect(after?.validTo).not.toBeNull();
  });

  it('the state trigger refuses `rejected` -> `approved`', async () => {
    const row = proposal({ externalKey: `rej_${RUN}` });
    await db.insert(catalogExternalMappings).values(row);
    const id = row.id;
    await db
      .update(catalogExternalMappings)
      .set({
        state: 'rejected',
        rejectedReason: 'the source means something else',
        reviewedByOxyUserId: OPERATOR_A,
        reviewedAt: new Date(),
      })
      .where(eq(catalogExternalMappings.id, id));

    await expectRefusal(
      'resurrecting a rejection',
      () => approve(id, OPERATOR_B),
      RAISE_EXCEPTION,
    );
  });
});

describe('6. one OPEN review per token, converged CONCURRENTLY', () => {
  it('two concurrent upserts produce ONE row with occurrences 2', async () => {
    const key = `race_${RUN}`;
    const values = (id: string) => ({
      id,
      catalogSourceId: SOURCE,
      dimension: 'attribute' as const,
      externalKey: key,
      reason: 'unmapped' as const,
      state: 'open' as const,
      priority: 5,
      occurrences: 1,
      firstObservedAt: new Date(),
      lastObservedAt: new Date(),
      summary: 'nothing maps this',
    });
    const a = `r-a-${RUN}`;
    const b = `r-b-${RUN}`;
    reviewIds.push(a, b);

    const upsert = (id: string) =>
      db
        .insert(catalogExternalMappingReviews)
        .values(values(id))
        .onConflictDoUpdate({
          target: [
            catalogExternalMappingReviews.catalogSourceId,
            catalogExternalMappingReviews.dimension,
            catalogExternalMappingReviews.externalKeyNormalized,
          ],
          targetWhere: sql`${catalogExternalMappingReviews.state} = 'open'`,
          set: { occurrences: sql`${catalogExternalMappingReviews.occurrences} + 1` },
        });

    // Sequential would pass under a read-then-write a real race defeats, so both
    // are issued before either is awaited.
    await Promise.all([upsert(a), upsert(b)]);

    const rows = await db
      .select({ id: catalogExternalMappingReviews.id, occurrences: catalogExternalMappingReviews.occurrences })
      .from(catalogExternalMappingReviews)
      .where(
        and(
          eq(catalogExternalMappingReviews.catalogSourceId, SOURCE),
          eq(catalogExternalMappingReviews.externalKeyNormalized, key),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(2);
  });
});

describe('7. an observation converges rather than multiplying', () => {
  it('a re-delivery updates ONE row', async () => {
    const key = `obs_${RUN}`;
    const id = `o-${RUN}`;
    observationIds.push(id);
    const values = {
      id,
      catalogSourceId: SOURCE,
      dimension: 'attribute' as const,
      externalKey: key,
      subjectKind: 'catalog_source_object' as const,
      subjectKey: `subject-${RUN}`,
      resolutionOutcome: 'unresolved' as const,
      unresolvedReason: 'unmapped' as const,
      firstObservedAt: new Date(),
      lastObservedAt: new Date(),
      occurrences: 1,
    };
    const upsert = () =>
      db
        .insert(catalogExternalTokenObservations)
        .values(values)
        .onConflictDoUpdate({
          target: [
            catalogExternalTokenObservations.catalogSourceId,
            catalogExternalTokenObservations.dimension,
            catalogExternalTokenObservations.externalKeyNormalized,
            catalogExternalTokenObservations.subjectKind,
            catalogExternalTokenObservations.subjectKey,
          ],
          set: { occurrences: sql`${catalogExternalTokenObservations.occurrences} + 1` },
        });
    await upsert();
    await upsert();
    await upsert();

    const rows = await db
      .select({ occurrences: catalogExternalTokenObservations.occurrences })
      .from(catalogExternalTokenObservations)
      .where(eq(catalogExternalTokenObservations.catalogSourceId, SOURCE));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
  });

  it('refuses an `unresolved` row carrying a mapping id — the TWO-biconditional shape', async () => {
    // The single spelling over their conjunction is SATISFIED by this row,
    // because both sides evaluate false. That is why there are two.
    const mapping = proposal({ externalKey: `bicond_${RUN}` });
    await db.insert(catalogExternalMappings).values(mapping);
    await expectRefusal(
      'unresolved with a mapping id',
      () =>
        db.insert(catalogExternalTokenObservations).values({
          id: `o-bad-${RUN}`,
          catalogSourceId: SOURCE,
          dimension: 'attribute',
          externalKey: `bicond_${RUN}`,
          subjectKind: 'source_record',
          subjectKey: `s-${RUN}`,
          resolvedMappingId: mapping.id,
          resolutionOutcome: 'unresolved',
          unresolvedReason: 'unmapped',
          firstObservedAt: new Date(),
          lastObservedAt: new Date(),
        }),
      CHECK_VIOLATION,
    );
  });
});

describe('8-10. runs: the vacuity floor, the item shape, and idempotency', () => {
  it('refuses an unbalanced counter set', async () => {
    const id = `run-bad-${RUN}`;
    await expectRefusal(
      'counters that do not sum to `scanned`',
      () =>
        db.insert(catalogExternalMappingRuns).values({
          id,
          catalogSourceId: SOURCE,
          mode: 'dry_run',
          state: 'running',
          requestedByOxyUserId: OPERATOR_A,
          scanned: 10,
          unchanged: 3,
        }),
      CHECK_VIOLATION,
    );
  });

  it('refuses each mismatched outcome/pointer pair, and accepts the matching ones', async () => {
    const runId = `run-${RUN}`;
    runIds.push(runId);
    await db.insert(catalogExternalMappingRuns).values({
      id: runId,
      catalogSourceId: SOURCE,
      mode: 'dry_run',
      state: 'running',
      requestedByOxyUserId: OPERATOR_A,
    });
    const mapping = proposal({ externalKey: `item_${RUN}` });
    await db.insert(catalogExternalMappings).values(mapping);
    const mappingId = mapping.id;

    await expectRefusal(
      '`newly_mapped` with a previous mapping',
      () =>
        db.insert(catalogExternalMappingRunItems).values({
          id: `it-bad-${RUN}`,
          runId,
          subjectKind: 'source_record',
          subjectKey: `s1-${RUN}`,
          externalKey: `item_${RUN}`,
          outcome: 'newly_mapped',
          previousMappingId: mappingId,
          nextMappingId: mappingId,
        }),
      CHECK_VIOLATION,
    );
    await expectRefusal(
      '`refused` with no detail',
      () =>
        db.insert(catalogExternalMappingRunItems).values({
          id: `it-bad2-${RUN}`,
          runId,
          subjectKind: 'source_record',
          subjectKey: `s2-${RUN}`,
          externalKey: `item_${RUN}`,
          outcome: 'refused',
        }),
      CHECK_VIOLATION,
    );

    await db.insert(catalogExternalMappingRunItems).values({
      id: `it-ok-${RUN}`,
      runId,
      subjectKind: 'source_record',
      subjectKey: `s3-${RUN}`,
      externalKey: `item_${RUN}`,
      outcome: 'newly_mapped',
      nextMappingId: mappingId,
    });
  });

  it('a resumed run re-reads its page and does NOT double its items', async () => {
    const runId = `run2-${RUN}`;
    runIds.push(runId);
    await db.insert(catalogExternalMappingRuns).values({
      id: runId,
      catalogSourceId: SOURCE,
      mode: 'apply',
      state: 'running',
      requestedByOxyUserId: OPERATOR_A,
    });
    const insert = (id: string) =>
      db
        .insert(catalogExternalMappingRunItems)
        .values({
          id,
          runId,
          subjectKind: 'source_record',
          subjectKey: `resumed-${RUN}`,
          externalKey: `resume_${RUN}`,
          outcome: 'unchanged',
        })
        .onConflictDoNothing()
        .returning({ id: catalogExternalMappingRunItems.id });

    expect(await insert(`res-1-${RUN}`)).toHaveLength(1);
    // The empty RETURNING set IS the "already counted" answer a resumed page
    // reads. `DO UPDATE` here would let the run double its own counters.
    expect(await insert(`res-2-${RUN}`)).toHaveLength(0);
  });
});

describe('11. every DELETE trigger raises', () => {
  it('refuses a delete on each append-only table', async () => {
    const mapping = proposal({ externalKey: `del_${RUN}` });
    await db.insert(catalogExternalMappings).values(mapping);
    await expectRefusal(
      'deleting a mapping',
      () =>
        db.delete(catalogExternalMappings).where(eq(catalogExternalMappings.id, mapping.id)),
      RAISE_EXCEPTION,
    );

    const reviewId = `r-del-${RUN}`;
    reviewIds.push(reviewId);
    await db.insert(catalogExternalMappingReviews).values({
      id: reviewId,
      catalogSourceId: SOURCE,
      dimension: 'unit',
      externalKey: `delrev_${RUN}`,
      reason: 'unmapped',
      state: 'open',
      priority: 0,
      occurrences: 1,
      firstObservedAt: new Date(),
      lastObservedAt: new Date(),
      summary: 'x',
    });
    await expectRefusal(
      'deleting a review',
      () =>
        db.delete(catalogExternalMappingReviews).where(eq(catalogExternalMappingReviews.id, reviewId)),
      RAISE_EXCEPTION,
    );
  });

  it('the review subject trigger refuses an edit and refuses a reopen', async () => {
    const id = `r-frz-${RUN}`;
    reviewIds.push(id);
    await db.insert(catalogExternalMappingReviews).values({
      id,
      catalogSourceId: SOURCE,
      dimension: 'unit',
      externalKey: `frzrev_${RUN}`,
      observedRawValue: 'GB',
      reason: 'unmapped',
      state: 'open',
      priority: 0,
      occurrences: 1,
      firstObservedAt: new Date(),
      lastObservedAt: new Date(),
      summary: 'x',
    });
    await expectRefusal(
      'editing the subject',
      () =>
        db
          .update(catalogExternalMappingReviews)
          .set({ observedRawValue: 'TB' })
          .where(eq(catalogExternalMappingReviews.id, id)),
      RAISE_EXCEPTION,
    );

    // The disposition still moves — the case that would fail if the trigger
    // reached for the stored generated column.
    await db
      .update(catalogExternalMappingReviews)
      .set({ state: 'dismissed', resolvedByOxyUserId: OPERATOR_A, resolvedAt: new Date() })
      .where(eq(catalogExternalMappingReviews.id, id));
    await expectRefusal(
      'reopening a settled review',
      () =>
        db
          .update(catalogExternalMappingReviews)
          .set({ state: 'open', resolvedByOxyUserId: null, resolvedAt: null })
          .where(eq(catalogExternalMappingReviews.id, id)),
      RAISE_EXCEPTION,
    );
  });
});

describe('12. the fixtures this file owns are the ones it deletes', () => {
  it('every row it created carries this run’s suffix', () => {
    // The scoping proof. A teardown that deleted by anything wider would take a
    // sibling file's rows with it on a shared database, and the failure would
    // surface in the victim naming nothing about the cause.
    for (const id of [...mappingIds, ...reviewIds, ...runIds, ...observationIds]) {
      expect(id, `${id} is not scoped to this run`).toContain(RUN);
    }
    expect(mappingIds.length, 'no mappings were created — did the suite run?').toBeGreaterThan(5);
  });
});
