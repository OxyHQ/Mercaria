/**
 * The curation writes, against a REAL PostgreSQL database (#59 acceptance 6:
 * "real-database tests cover collisions, partial failure, replay and rollback").
 *
 * Every property here is one a mocked repository cannot have, because a mocked
 * `insert`/`update` accepts any statement the server would refuse — a CHECK, a
 * partial unique, a trigger and `FOR UPDATE SKIP LOCKED` have no mocked
 * counterpart. The four the issue names, in order:
 *
 * - **COLLISIONS** — a merge that would violate a real unique is DETECTED at
 *   planning time and the job blocks. The identifier case is asserted against
 *   the actual `product_identifiers_canonical_active_key`.
 * - **PARTIAL FAILURE** — a job interrupted mid-phase leaves its completed
 *   phases recorded and its subject intact, and the resume finishes it.
 * - **REPLAY** — running a completed merge again moves ZERO rows. That is
 *   asserted through the `verify` phase, which IS a re-run of every plan target.
 * - **ROLLBACK** — a split whose destination is a tombstone gives the identity
 *   back with its own id, so every source mapping keyed on it resolves again.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres serves the whole suite and vitest runs files in
 * parallel workers, so every row this file writes carries a per-run suffix and
 * teardown deletes exactly what it created. A bare `delete from
 * catalog_merge_jobs` here would empty a sibling file's fixtures mid-run.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';
import {
  catalogEntitySuppressions,
  catalogMergeConflicts,
  catalogMergeJobPhases,
  catalogMergeJobs,
  catalogReviewItems,
  catalogRevisions,
  catalogSplitAssignments,
  catalogSplitJobs,
} from '../../../db/schema/curation.js';
import {
  canonicalProductAliases,
  canonicalProductRedirects,
  canonicalProducts,
  canonicalProductSourceLinks,
  canonicalVariants,
  productIdentifiers,
} from '../../../db/schema/canonicalCatalog.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { reviewAggregates } from '../../../db/schema/reviews.js';
import { productSaveAggregates } from '../../../db/schema/productSaves.js';
import { normalizeEntityName } from '../../canonical/normalization.js';
import { variantSignature } from '../../canonical/variant-signature.js';
import { claimMergeJobs, claimSplitJobs } from '../../../db/curation/jobRepository.js';
import { requestMerge, resolveMergeConflict, runMergeJob } from '../merge.service.js';
import { requestSplit, runSplitJob } from '../split.service.js';
import { estimateMergeImpact } from '../impact.js';
import { recordRevision, recordCompensation } from '../revision.js';
import { suppressEntity, liftEntitySuppression } from '../correction.service.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `op-${RUN}`;
const SECOND_OPERATOR = `op2-${RUN}`;

const createdProductIds: string[] = [];
const createdSourceIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  const productIds = createdProductIds.splice(0);
  const sourceIds = createdSourceIds.splice(0);

  if (productIds.length > 0) {
    const jobIds = (
      await db
        .select({ id: catalogMergeJobs.id })
        .from(catalogMergeJobs)
        .where(eq(catalogMergeJobs.requestedByOxyUserId, OPERATOR))
    ).map((row) => row.id);
    const splitIds = (
      await db
        .select({ id: catalogSplitJobs.id })
        .from(catalogSplitJobs)
        .where(eq(catalogSplitJobs.requestedByOxyUserId, OPERATOR))
    ).map((row) => row.id);

    /**
     * The append-only triggers are properties under test, so teardown has to go
     * around them — and `alter table … disable trigger` is DATABASE-WIDE, so the
     * window has to be held against every other file that opens one.
     *
     * The comment this replaces said the trigger was "re-enabled immediately, so
     * a sibling file running in parallel is never left without the guarantee",
     * and `product-saves.realdb.test.ts` carried the mirror image of it citing
     * this file as precedent. That reasoning is wrong in the direction that
     * makes it hard to notice: a small window does not make a database-wide
     * statement safe, it makes the collision RARE. Measured on this branch —
     * this exact teardown failed with `PostgresError: catalog_revisions is
     * append-only` (23514) on its own DELETE, because the sibling re-enabled the
     * trigger between this file's disable and its delete. Which files overlap is
     * decided by vitest's size-ordered file list, so adding any test anywhere
     * re-rolls it.
     *
     * So the whole window is taken under `withTriggerToggleLock`, which is what
     * every realdb teardown toggling a trigger now goes through — the key lives
     * in that one module (#275). Every
     * trigger toggled here is covered, not only the two another file also
     * toggles today: the rule is "toggling a trigger database-wide takes the
     * lock", because the alternative is a per-trigger judgement that silently
     * expires the day a second file starts toggling one of the others.
     */
    // ONE TABLE PER WINDOW (#301). This was one window over three tables.
    // `alter table … disable trigger` takes ShareRowExclusive, which conflicts
    // with the RowExclusive an ordinary INSERT/UPDATE/DELETE holds — so a window
    // holding one table's lock while acquiring the next one's deadlocks (40P01)
    // against any writer taking them in the opposite order, and the shared mutex
    // cannot prevent it because it serialises windows against windows and the
    // counterparty is a plain writer. With one disable per window the
    // transaction holds exactly one STRONG lock; every other lock it takes is
    // RowExclusive, which never conflicts with another RowExclusive, so no cycle
    // can form. The unguarded deletes keep their existing position relative to
    // the trigger they follow.
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table catalog_revisions disable trigger catalog_revisions_append_only`,
      );
      await tx
        .delete(catalogRevisions)
        .where(inArray(catalogRevisions.actorOxyUserId, [OPERATOR, SECOND_OPERATOR]));
      await tx.execute(
        sql`alter table catalog_revisions enable trigger catalog_revisions_append_only`,
      );
    });
    if (splitIds.length > 0) {
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table catalog_split_assignments disable trigger catalog_split_assignments_frozen`,
        );
        await tx
          .delete(catalogSplitAssignments)
          .where(inArray(catalogSplitAssignments.jobId, splitIds));
        await tx.execute(
          sql`alter table catalog_split_assignments enable trigger catalog_split_assignments_frozen`,
        );
        await tx.delete(catalogSplitJobs).where(inArray(catalogSplitJobs.id, splitIds));
      });
    }
    if (jobIds.length > 0) {
      await withTriggerToggleLock(db, async (tx) => {
        await tx.delete(catalogMergeConflicts).where(inArray(catalogMergeConflicts.jobId, jobIds));
        await tx.execute(
          sql`alter table catalog_merge_job_phases disable trigger catalog_merge_job_phases_append_only`,
        );
        await tx.delete(catalogMergeJobPhases).where(inArray(catalogMergeJobPhases.jobId, jobIds));
        await tx.execute(
          sql`alter table catalog_merge_job_phases enable trigger catalog_merge_job_phases_append_only`,
        );
        await tx.delete(catalogMergeJobs).where(inArray(catalogMergeJobs.id, jobIds));
      });
    }
    await db
      .delete(catalogEntitySuppressions)
      .where(eq(catalogEntitySuppressions.suppressedByOxyUserId, OPERATOR));
    await db.delete(catalogReviewItems).where(inArray(catalogReviewItems.subjectId, productIds));

    const variantIds = (
      await db
        .select({ id: canonicalVariants.id })
        .from(canonicalVariants)
        .where(inArray(canonicalVariants.productId, productIds))
    ).map((row) => row.id);
    await db.delete(productIdentifiers).where(inArray(productIdentifiers.productId, productIds));
    if (variantIds.length > 0) {
      await db.delete(productIdentifiers).where(inArray(productIdentifiers.variantId, variantIds));
      await deleteTestCanonicalRows(db, { variantIds });
    }
    await db
      .delete(canonicalProductSourceLinks)
      .where(inArray(canonicalProductSourceLinks.productId, productIds));
    await db.delete(canonicalProductAliases).where(inArray(canonicalProductAliases.productId, productIds));
    await db
      .delete(canonicalProductRedirects)
      .where(inArray(canonicalProductRedirects.fromId, productIds));
    // The `rollups` phase re-derives #76's aggregates, which RESTRICT the
    // product they describe — so teardown has to clear them before the product.
    // Their presence here is the merge working, not a leak.
    await db
      .delete(reviewAggregates)
      .where(inArray(reviewAggregates.canonicalProductId, productIds));
    // …and #80's save counter, which the same phase re-derives for both sides
    // and which RESTRICTs its product for the same reason. Same fact, one
    // domain over: their presence here is the merge working.
    await db
      .delete(productSaveAggregates)
      .where(inArray(productSaveAggregates.canonicalProductId, productIds));
    // The tombstone must lose its pointer before its winner can be deleted.
    await db
      .update(canonicalProducts)
      .set({ status: 'active', mergedIntoId: null })
      .where(inArray(canonicalProducts.id, productIds));
    await deleteTestCanonicalRows(db, { productIds });
  }
  if (sourceIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, sourceIds));
    await db.delete(catalogSources).where(inArray(catalogSources.id, sourceIds));
  }
});


/**
 * Claim a job the way the DISPATCHER does, then run it.
 *
 * `runMergeJob` requires an owned, unexpired lease on every terminal transition
 * — that owner check is what makes a worker whose lease was reclaimed discard
 * its own outcome instead of writing over somebody else's run. So a test that
 * ran a job without claiming it would exercise a path production never takes,
 * and would report `completed: false` for the right reason and the wrong test.
 *
 * Both helpers BACKDATE the row under test and then take exactly ONE. A claim
 * orders by `available_at` across the whole table with no filter and the job
 * queues are global to the one throwaway database a run shares, so a batch of
 * 25 both missed its own row once 25 older ones were pending AND stole up to 24
 * rows from whatever else was running. See `7f00a67` (#255) / `78e2f4b` (#231);
 * the production claim is deliberately unchanged, because oldest-first over the
 * whole table is correct for a shared queue.
 */
/**
 * `to_timestamp(0)` is THIS FILE's backdate instant for `catalog_merge_jobs`,
 * and it must stay distinct from every other file's.
 *
 * `claimMergeJobs` orders by `available_at` with no second column, so two files
 * backdating to the same instant are TIED and `for update skip locked`
 * guarantees their claims take DIFFERENT rows — each steals the other's job and
 * both go red, neither at fault. `product-saves.realdb.test.ts` therefore uses
 * `to_timestamp(1)`. A new file sharing this queue picks its own.
 */
async function claimAndRunMerge(jobId: string, owner: string) {
  await db.execute(
    sql`update catalog_merge_jobs set available_at = to_timestamp(0) where id = ${jobId}`,
  );
  const claimed = await claimMergeJobs({ leaseOwner: owner, batchSize: 1 });
  expect(claimed.map((row) => row.id)).toEqual([jobId]);
  return runMergeJob(jobId, owner);
}

/** The same, for a split. */
async function claimAndRunSplit(jobId: string, owner: string) {
  await db.execute(
    sql`update catalog_split_jobs set available_at = to_timestamp(0) where id = ${jobId}`,
  );
  const claimed = await claimSplitJobs({ leaseOwner: owner, batchSize: 1 });
  expect(claimed.map((row) => row.id)).toEqual([jobId]);
  return runSplitJob(jobId, owner);
}

/**
 * Assert a statement is refused by a NAMED constraint.
 *
 * The driver's error message is `Failed query: …`; the constraint name lives on
 * the `cause`. Matching the message with a regex would therefore pass on ANY
 * failure of that statement — including one caused by a fixture mistake — which
 * is the "check that cannot distinguish success from failure" shape
 * `~/Oxy/AGENTS.md` warns about. Walking to the cause is what makes these
 * assertions name the constraint they are actually about.
 */
async function expectConstraintViolation(
  run: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${constraintName} to refuse the statement`).toBeDefined();
  const names: string[] = [];
  for (let cursor: unknown = caught, depth = 0; cursor && depth < 5; depth += 1) {
    const record = cursor as { constraint_name?: string; message?: string; cause?: unknown };
    if (record.constraint_name) names.push(record.constraint_name);
    if (record.message) names.push(record.message);
    cursor = record.cause;
  }
  expect(names.join(' | ')).toContain(constraintName);
}

/**
 * A canonical product with one default variant, minted directly.
 *
 * Each variant carries a DISTINCT signature, keyed on the label. Two products
 * whose variants share one would collide on
 * `canonical_variants_product_signature_key` the moment a merge repointed them,
 * which is a real conflict and is exercised on purpose in the collision suite —
 * seeding it into every fixture would make every merge here block.
 */
async function seedProduct(label: string): Promise<{ productId: string; variantId: string }> {
  const name = `Curation ${label} ${RUN}`;
  const rows = await db
    .insert(canonicalProducts)
    .values({ slug: `curation-${label}-${RUN}`, name, normalizedName: normalizeEntityName(name) })
    .returning({ id: canonicalProducts.id });
  const productId = rows[0]?.id;
  if (!productId) throw new Error('failed to seed a canonical product');
  createdProductIds.push(productId);

  const variants = await db
    .insert(canonicalVariants)
    .values({
      productId,
      name: `${label} default`,
      signature: variantSignature([{ key: 'colour', normalizedValue: label }]),
      // NOT the product's default. Two products each holding a default variant
      // collide on `canonical_variants_product_default_key` the moment a merge
      // repoints them — a real conflict the collision suite raises on purpose,
      // and one that would block every merge in this file if it were seeded
      // into every fixture.
      isDefault: false,
    })
    .returning({ id: canonicalVariants.id });
  const variantId = variants[0]?.id;
  if (!variantId) throw new Error('failed to seed a canonical variant');
  return { productId, variantId };
}

/** A source record, so a source LINK can be written and later followed. */
async function seedSourceRecord(label: string): Promise<string> {
  const sources = await db
    .insert(catalogSources)
    .values({
      kind: 'operator',
      name: `curation-${label}-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  const sourceId = sources[0]?.id;
  if (!sourceId) throw new Error('failed to seed a catalog source');
  createdSourceIds.push(sourceId);

  const hash = Array.from({ length: 64 }, (_, index) => '0123456789abcdef'[(index + label.length) % 16]).join('');
  const records = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      externalType: 'product',
      externalId: `ext-${label}-${RUN}`,
      observedAt: new Date(),
      contentHash: hash,
    })
    .returning({ id: sourceRecords.id });
  const recordId = records[0]?.id;
  if (!recordId) throw new Error('failed to seed a source record');
  return recordId;
}

describe('acceptance 1: a duplicate merge preserves everything and redirects the old URL', () => {
  it('rehomes source links, mints a former-name alias and tombstones the loser', async () => {
    const loser = await seedProduct('loser-a');
    const winner = await seedProduct('winner-a');
    const recordId = await seedSourceRecord('a');

    await db.insert(canonicalProductSourceLinks).values({
      productId: loser.productId,
      sourceRecordId: recordId,
      method: 'operator',
      matchRule: 'seeded',
    });

    const impact = await estimateMergeImpact('canonical_product', loser.productId);
    // The estimate an operator is SHOWN, before anything moves.
    expect(impact.sourceLinks).toBe(1);
    expect(impact.childEntities).toBe(1);
    expect(impact.totalMoving).toBeGreaterThanOrEqual(2);

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'duplicate product',
      actorOxyUserId: OPERATOR,
    });
    const result = await claimAndRunMerge(job.id, `lease-${RUN}`);
    expect(result.completed).toBe(true);
    expect(result.blocked).toBe(false);

    // The source link followed the identity.
    const links = await db
      .select({ productId: canonicalProductSourceLinks.productId })
      .from(canonicalProductSourceLinks)
      .where(eq(canonicalProductSourceLinks.sourceRecordId, recordId));
    expect(links.map((row) => row.productId)).toEqual([winner.productId]);

    // The variant followed it too — a merge moves children, not just pointers.
    const variants = await db
      .select({ productId: canonicalVariants.productId })
      .from(canonicalVariants)
      .where(eq(canonicalVariants.id, loser.variantId));
    expect(variants[0]?.productId).toBe(winner.productId);

    // The OLD URL resolves: the tombstone keeps its slug and points at the winner.
    const tombstone = await db
      .select({ status: canonicalProducts.status, mergedIntoId: canonicalProducts.mergedIntoId, slug: canonicalProducts.slug })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, loser.productId));
    expect(tombstone[0]?.status).toBe('merged');
    expect(tombstone[0]?.mergedIntoId).toBe(winner.productId);
    expect(tombstone[0]?.slug).toBe(`curation-loser-a-${RUN}`);

    // And the redirect HISTORY records the hop, which `merged_into_id` cannot.
    const redirects = await db
      .select({ toId: canonicalProductRedirects.toId, reason: canonicalProductRedirects.reason })
      .from(canonicalProductRedirects)
      .where(eq(canonicalProductRedirects.fromId, loser.productId));
    expect(redirects).toContainEqual({ toId: winner.productId, reason: 'merge' });

    // Search still finds the losing identity by the name it had.
    const aliases = await db
      .select({ alias: canonicalProductAliases.alias, kind: canonicalProductAliases.kind })
      .from(canonicalProductAliases)
      .where(eq(canonicalProductAliases.productId, winner.productId));
    expect(aliases).toContainEqual({ alias: `Curation loser-a ${RUN}`, kind: 'former_name' });
  });
});

describe('COLLISIONS: a merge that would violate a unique blocks instead of half-running', () => {
  it('detects an identifier collision, blocks, and only proceeds once it is decided', async () => {
    const loser = await seedProduct('loser-b');
    const winner = await seedProduct('winner-b');
    const value = `MPN-${RUN}`;

    // BOTH variants assert the same MPN, which is LEGAL today: ADR 0002 D14
    // gives MPN no cross-scheme canonical form and no global unique, precisely
    // because MPNs collide across brands for real. What is not legal is two
    // ACTIVE assertions of one MPN on ONE entity
    // (`product_identifiers_variant_active_key`), which is exactly what a merge
    // would produce — a raw 23505 four phases in, if nothing detected it first.
    //
    // The GTIN case is deliberately NOT the fixture: the canonical gate already
    // holds one active owner per GTIN ANYWHERE, so two entities cannot reach a
    // state a merge could collide from. The detector probes both, and this is
    // the branch a merge can actually meet.
    for (const variantId of [loser.variantId, winner.variantId]) {
      await db.insert(productIdentifiers).values({
        variantId,
        scheme: 'mpn',
        rawValue: value,
        normalizedValue: value.toLowerCase(),
      });
    }

    // The two identifiers hang off the VARIANTS, so the collision surfaces on a
    // variant merge — which is the merge a product merge would have to perform.
    const job = await requestMerge({
      entityType: 'canonical_variant',
      loserId: loser.variantId,
      winnerId: winner.variantId,
      reason: 'same configuration',
      actorOxyUserId: OPERATOR,
    });

    const blocked = await claimAndRunMerge(job.id, `lease-b-${RUN}`);
    expect(blocked.blocked).toBe(true);
    expect(blocked.completed).toBe(false);

    const conflicts = await db
      .select()
      .from(catalogMergeConflicts)
      .where(eq(catalogMergeConflicts.jobId, job.id));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('identifier');
    expect(conflicts[0]?.resolution).toBeNull();

    // The graph is UNTOUCHED while the job is blocked: nothing moved.
    const stillOnLoser = await db
      .select({ id: productIdentifiers.id })
      .from(productIdentifiers)
      .where(eq(productIdentifiers.variantId, loser.variantId));
    expect(stillOnLoser).toHaveLength(1);

    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no conflict to resolve');
    await resolveMergeConflict({
      conflictId,
      resolution: 'keep_winner',
      reason: 'the winner holds the manufacturer assertion',
      actorOxyUserId: OPERATOR,
    });

    const finished = await claimAndRunMerge(job.id, `lease-b2-${RUN}`);
    expect(finished.completed).toBe(true);

    // The loser's identifier moved AND was retired, so the gate still holds one
    // active owner. Nothing was deleted.
    const moved = await db
      .select({ status: productIdentifiers.status, variantId: productIdentifiers.variantId })
      .from(productIdentifiers)
      .where(eq(productIdentifiers.normalizedValue, value.toLowerCase()));
    expect(moved).toHaveLength(2);
    expect(moved.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(moved.every((row) => row.variantId === winner.variantId)).toBe(true);
  });

  it('refuses to merge INTO a tombstone, so resolution stays one hop', async () => {
    const loser = await seedProduct('loser-c');
    const winner = await seedProduct('winner-c');
    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'first merge',
      actorOxyUserId: OPERATOR,
    });
    await claimAndRunMerge(job.id, `lease-c-${RUN}`);

    const third = await seedProduct('third-c');
    await expect(
      requestMerge({
        entityType: 'canonical_product',
        loserId: third.productId,
        winnerId: loser.productId,
        reason: 'into a tombstone',
        actorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/tombstone/i);
  });
});

describe('REPLAY and PARTIAL FAILURE: a completed job re-run moves nothing', () => {
  it('records each phase exactly once and converges on a second run', async () => {
    const loser = await seedProduct('loser-d');
    const winner = await seedProduct('winner-d');
    const recordId = await seedSourceRecord('d');
    await db.insert(canonicalProductSourceLinks).values({
      productId: loser.productId,
      sourceRecordId: recordId,
      method: 'operator',
      matchRule: 'seeded',
    });

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'replay check',
      actorOxyUserId: OPERATOR,
    });
    const first = await claimAndRunMerge(job.id, `lease-d-${RUN}`);
    expect(first.completed).toBe(true);
    expect(first.rowsAffected).toBeGreaterThan(0);

    const phases = await db
      .select({ phase: catalogMergeJobPhases.phase, completedAt: catalogMergeJobPhases.completedAt })
      .from(catalogMergeJobPhases)
      .where(eq(catalogMergeJobPhases.jobId, job.id));
    // Every phase claimed exactly once, and every one of them completed.
    expect(new Set(phases.map((row) => row.phase)).size).toBe(phases.length);
    expect(phases.every((row) => row.completedAt !== null)).toBe(true);

    // A phase record cannot be re-opened: the trigger refuses it, which is what
    // makes the resume's skip list trustworthy.
    await expectConstraintViolation(
      () =>
        db
          .update(catalogMergeJobPhases)
          .set({ completedAt: null })
          .where(eq(catalogMergeJobPhases.jobId, job.id)),
      'already complete',
    );

    // The audit timeline is append-only. This is #59 acceptance 4.
    await expectConstraintViolation(
      () =>
        db
          .update(catalogRevisions)
          .set({ reason: 'rewritten' })
          .where(eq(catalogRevisions.mergeJobId, job.id)),
      'append-only',
    );
    await expectConstraintViolation(
      () => db.delete(catalogRevisions).where(eq(catalogRevisions.mergeJobId, job.id)),
      'append-only',
    );

    // A merge job's subject is immutable — repointing a running merge would
    // rehome one entity's children to two survivors.
    await expectConstraintViolation(
      () =>
        db
          .update(catalogMergeJobs)
          .set({ winnerId: loser.productId })
          .where(eq(catalogMergeJobs.id, job.id)),
      'immutable',
    );
  });

  it('a job interrupted mid-phase resumes and finishes', async () => {
    const loser = await seedProduct('loser-e');
    const winner = await seedProduct('winner-e');

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'partial failure check',
      actorOxyUserId: OPERATOR,
    });

    // Simulate the crash the phase records exist for: the job holds a lease that
    // has EXPIRED mid-run, with `plan` complete and nothing after it.
    await db
      .update(catalogMergeJobs)
      .set({
        status: 'processing',
        phase: 'children',
        leaseOwner: 'dead-task',
        leaseUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(catalogMergeJobs.id, job.id));
    await db
      .insert(catalogMergeJobPhases)
      .values({ jobId: job.id, phase: 'plan', startedAt: new Date(), completedAt: new Date() })
      .onConflictDoNothing();

    // A new worker RECLAIMS the expired lease — the dispatcher's own path, which
    // is what makes this a resume rather than a hand-written state fix-up.
    const resumed = await claimAndRunMerge(job.id, `lease-e-${RUN}`);
    expect(resumed.completed).toBe(true);

    const tombstone = await db
      .select({ mergedIntoId: canonicalProducts.mergedIntoId })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, loser.productId));
    expect(tombstone[0]?.mergedIntoId).toBe(winner.productId);
  });
});

describe('ROLLBACK: a mistaken merge is split back without losing a source mapping', () => {
  it('revives the tombstone with its OWN id, and the mapping resolves again', async () => {
    const loser = await seedProduct('loser-f');
    const winner = await seedProduct('winner-f');
    const recordId = await seedSourceRecord('f');
    const seeded = await db
      .insert(canonicalProductSourceLinks)
      .values({
        productId: loser.productId,
        sourceRecordId: recordId,
        method: 'operator',
        matchRule: 'seeded',
      })
      .returning({ id: canonicalProductSourceLinks.id });
    const linkId = seeded[0]?.id;
    if (!linkId) throw new Error('failed to seed a source link');

    const merge = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'a merge that turns out to be wrong',
      actorOxyUserId: OPERATOR,
    });
    await claimAndRunMerge(merge.id, `lease-f-${RUN}`);

    const split = await requestSplit({
      entityType: 'canonical_product',
      sourceEntityId: winner.productId,
      targetMode: 'revive_tombstone',
      targetEntityId: loser.productId,
      reason: 'the merge was wrong',
      actorOxyUserId: OPERATOR,
      reversesMergeJobId: merge.id,
      items: [
        { itemType: 'source_link', itemRef: linkId },
        { itemType: 'canonical_variant', itemRef: loser.variantId },
      ],
    });
    const result = await claimAndRunSplit(split.id, `lease-f2-${RUN}`);
    expect(result.completed).toBe(true);

    // The identity came back as ITSELF: same id, same slug, no longer a tombstone.
    const revived = await db
      .select({ id: canonicalProducts.id, status: canonicalProducts.status, mergedIntoId: canonicalProducts.mergedIntoId, slug: canonicalProducts.slug })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, loser.productId));
    expect(revived[0]?.status).toBe('active');
    expect(revived[0]?.mergedIntoId).toBeNull();
    expect(revived[0]?.slug).toBe(`curation-loser-f-${RUN}`);

    // And the source mapping, which is keyed on the entity id, points at it again.
    const link = await db
      .select({ productId: canonicalProductSourceLinks.productId })
      .from(canonicalProductSourceLinks)
      .where(eq(canonicalProductSourceLinks.id, linkId));
    expect(link[0]?.productId).toBe(loser.productId);

    // Every assignment reached a terminal state — that is the verify phase's own
    // reconciliation, and #59 split invariant 5's "resume without duplication".
    const assignments = await db
      .select({ appliedAt: catalogSplitAssignments.appliedAt, skipped: catalogSplitAssignments.skippedReason })
      .from(catalogSplitAssignments)
      .where(eq(catalogSplitAssignments.jobId, split.id));
    expect(assignments).toHaveLength(2);
    expect(assignments.every((row) => row.appliedAt !== null || row.skipped !== null)).toBe(true);

    // The assignment list is FROZEN once the job leaves `plan` (#59 invariant 1).
    await expectConstraintViolation(
      () =>
        db
          .insert(catalogSplitAssignments)
          .values({ jobId: split.id, itemType: 'alias', itemRef: 'anything' }),
      'assignment list is frozen',
    );
  });
});

describe('the audit timeline and the compensating correction', () => {
  it('records a compensation exactly once, pointing backwards in time', async () => {
    const product = await seedProduct('audit-g');
    const revision = await recordRevision({
      entityType: 'canonical_product',
      entityId: product.productId,
      action: 'correct',
      actorKind: 'operator',
      actorOxyUserId: OPERATOR,
      reason: 'a correction that turns out to be wrong',
    });

    const compensation = await recordCompensation({
      revisionId: revision.id,
      reason: 'undoing it',
      actorOxyUserId: SECOND_OPERATOR,
    });
    expect(compensation.compensatesRevisionId).toBe(revision.id);
    expect(compensation.action).toBe('compensate');

    // One compensation per revision: two would each claim to have undone it.
    await expect(
      recordCompensation({
        revisionId: revision.id,
        reason: 'undoing it again',
        actorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/already compensated/i);

    // A compensation cannot itself be compensated; the timeline reads forwards.
    await expect(
      recordCompensation({
        revisionId: compensation.id,
        reason: 'redo',
        actorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/cannot itself be compensated/i);
  });

  it('a machine revision cannot name a person, and an operator one must', async () => {
    const product = await seedProduct('audit-h');
    await expect(
      recordRevision({
        entityType: 'canonical_product',
        entityId: product.productId,
        action: 'update',
        actorKind: 'ingestion',
        actorOxyUserId: OPERATOR,
        reason: 'a feed asserted this',
      }),
    ).rejects.toThrow(/must not name a person/i);

    await expect(
      recordRevision({
        entityType: 'canonical_product',
        entityId: product.productId,
        action: 'update',
        actorKind: 'operator',
        reason: 'somebody did this',
      }),
    ).rejects.toThrow(/must name the operator/i);
  });
});

describe('suppression hides without deleting', () => {
  it('sets the status, records who and why, and lifts back to active', async () => {
    const product = await seedProduct('suppress-i');
    await suppressEntity({
      entityType: 'canonical_product',
      entityId: product.productId,
      reason: 'pending_investigation',
      note: 'reported twice',
      actorOxyUserId: OPERATOR,
    });

    const hidden = await db
      .select({ status: canonicalProducts.status })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, product.productId));
    expect(hidden[0]?.status).toBe('suppressed');

    // The variant, its identifiers and every piece of evidence are untouched.
    const variants = await db
      .select({ id: canonicalVariants.id })
      .from(canonicalVariants)
      .where(eq(canonicalVariants.productId, product.productId));
    expect(variants).toHaveLength(1);

    // A second suppression is refused by the partial unique, through a sentence.
    await expect(
      suppressEntity({
        entityType: 'canonical_product',
        entityId: product.productId,
        reason: 'data_quality',
        note: null,
        actorOxyUserId: SECOND_OPERATOR,
      }),
    ).rejects.toThrow(/already suppressed/i);

    await liftEntitySuppression({
      entityType: 'canonical_product',
      entityId: product.productId,
      reason: 'investigation closed',
      actorOxyUserId: SECOND_OPERATOR,
    });
    const restored = await db
      .select({ status: canonicalProducts.status })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, product.productId));
    expect(restored[0]?.status).toBe('active');

    // Both acts are in the timeline, and neither can be edited away.
    const revisions = await db
      .select({ action: catalogRevisions.action })
      .from(catalogRevisions)
      .where(
        and(
          eq(catalogRevisions.entityType, 'canonical_product'),
          eq(catalogRevisions.entityId, product.productId),
        ),
      );
    expect(revisions.map((row) => row.action)).toEqual(
      expect.arrayContaining(['suppress', 'unsuppress']),
    );
  });
});

describe('the CHECKs a service bug cannot walk around', () => {
  it('refuses a pair-shaped review item with one side, and an unordered duplicate pair', async () => {
    const first = await seedProduct('pair-j');
    const second = await seedProduct('pair-k');
    const [low, high] =
      first.productId < second.productId
        ? [first.productId, second.productId]
        : [second.productId, first.productId];

    await expectConstraintViolation(
      () =>
        db.insert(catalogReviewItems).values({
          kind: 'suspected_duplicate',
          detector: 'duplicate_scan',
          subjectType: 'canonical_product',
          subjectId: low,
          reasonCodes: ['normalized_name_collision'],
          firstDetectedAt: new Date(),
          lastDetectedAt: new Date(),
        }),
      'catalog_review_items_pair_shape_check',
    );

    // (B, A) is refused, so one problem cannot become two queue items.
    await expectConstraintViolation(
      () =>
        db.insert(catalogReviewItems).values({
          kind: 'suspected_duplicate',
          detector: 'duplicate_scan',
          subjectType: 'canonical_product',
          subjectId: high,
          counterpartType: 'canonical_product',
          counterpartId: low,
          reasonCodes: ['normalized_name_collision'],
          firstDetectedAt: new Date(),
          lastDetectedAt: new Date(),
        }),
      'catalog_review_items_pair_order_check',
    );
  });

  it('refuses an impact total that disagrees with its own components', async () => {
    const loser = await seedProduct('impact-l');
    const winner = await seedProduct('impact-m');
    await expectConstraintViolation(
      () =>
        db.insert(catalogMergeJobs).values({
          entityType: 'canonical_product',
          loserId: loser.productId,
          winnerId: winner.productId,
          reason: 'a merge claiming to be small',
          requestedByOxyUserId: OPERATOR,
          availableAt: new Date(),
          impactOffers: 500,
          impactTotalMoving: 1,
        }),
      'catalog_merge_jobs_impact_total_check',
    );
  });

  it('refuses a second live merge job for the same losing entity', async () => {
    const loser = await seedProduct('dup-n');
    const winnerA = await seedProduct('dup-o');
    const winnerB = await seedProduct('dup-p');
    await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winnerA.productId,
      reason: 'first',
      actorOxyUserId: OPERATOR,
    });
    await expect(
      requestMerge({
        entityType: 'canonical_product',
        loserId: loser.productId,
        winnerId: winnerB.productId,
        reason: 'second, irreconcilable',
        actorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/already has an open merge job/i);
  });

  it('refuses a `merge_pair` resolution on a conflict that is not a signature collision', async () => {
    // The CHECK, asserted directly: `merge_pair` is the only resolution for a
    // variant-signature collision and is refused for every other kind, because
    // keeping one of two rows that are not the same thing would strand children.
    const loser = await seedProduct('kindcheck-q');
    const winner = await seedProduct('kindcheck-r');
    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'kind check',
      actorOxyUserId: OPERATOR,
    });
    await db.insert(catalogMergeConflicts).values({
      jobId: job.id,
      kind: 'default_variant',
      detail: 'both default',
      loserVariantId: loser.variantId,
      winnerVariantId: winner.variantId,
    });
    await expectConstraintViolation(
      () =>
        db
          .update(catalogMergeConflicts)
          .set({
            resolution: 'merge_pair',
            resolvedByOxyUserId: OPERATOR,
            resolvedAt: new Date(),
            resolutionReason: 'wrong resolution for this kind',
            childJobId: job.id,
          })
          .where(and(eq(catalogMergeConflicts.jobId, job.id), sql`kind = 'default_variant'`)),
      'catalog_merge_conflicts_merge_pair_kind_check',
    );
  });
});
