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
import { genericCompatibilityRelations } from '../../../db/schema/compatibility.js';
import { bundleComponents } from '../../../db/schema/canonicalCatalog.js';
import { replaceBundleComponents } from '../../../db/canonical/canonicalVariantRepository.js';
import { reviewAggregates, reviewTargetMigrations, reviews } from '../../../db/schema/reviews.js';
import { productSaveAggregates } from '../../../db/schema/productSaves.js';
import { normalizeEntityName } from '../../canonical/normalization.js';
import { variantSignature } from '../../canonical/variant-signature.js';
import { claimMergeJobs, claimSplitJobs } from '../../../db/curation/jobRepository.js';
import {
  approveMerge,
  mergeJobBlockingState,
  requestMerge,
  resolveMergeConflict,
  resumeBlockedMergeJobs,
  runMergeJob,
} from '../merge.service.js';
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
const createdReviewIds: string[] = [];
/**
 * #405's fixtures. Tracked rather than derived from the products, because both
 * endpoint columns are `ON DELETE restrict` and a relation left behind refuses
 * its own subject's delete — a teardown failure attributed to whichever product
 * happened to be deleted first.
 */
const createdRelationIds: string[] = [];
/** Bundle variants whose component rows this file wrote (#405). */
const createdBundleVariantIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  const productIds = createdProductIds.splice(0);
  const sourceIds = createdSourceIds.splice(0);
  const reviewIds = createdReviewIds.splice(0);
  const relationIds = createdRelationIds.splice(0);
  const bundleVariantIds = createdBundleVariantIds.splice(0);

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
    // `bundle_components.component_variant_id` is RESTRICT, so a component row
    // left behind refuses its own variant's delete. `bundle_variant_id`
    // CASCADEs, which covers only half of it.
    if (bundleVariantIds.length > 0) {
      await db
        .delete(bundleComponents)
        .where(inArray(bundleComponents.bundleVariantId, bundleVariantIds));
    }
    // AFTER the conflicts, which RESTRICT the relation they name, and BEFORE the
    // canonical rows, which the relation's own endpoints RESTRICT.
    if (relationIds.length > 0) {
      await db
        .delete(genericCompatibilityRelations)
        .where(inArray(genericCompatibilityRelations.id, relationIds));
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
    if (reviewIds.length > 0) {
      // The migration log RESTRICTS the review it names and is append-only by
      // trigger, so teardown goes around the trigger — one table per window
      // (#301), and the reviews themselves are deleted OUTSIDE it, because
      // `reviews` has no trigger to toggle and holding a second strong lock is
      // exactly what the one-table rule forbids.
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table review_target_migrations disable trigger mercaria_review_target_migration_append_only`,
        );
        await tx
          .delete(reviewTargetMigrations)
          .where(inArray(reviewTargetMigrations.reviewId, reviewIds));
        await tx.execute(
          sql`alter table review_target_migrations enable trigger mercaria_review_target_migration_append_only`,
        );
      });
      await db.delete(reviews).where(inArray(reviews.id, reviewIds));
    }
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

/**
 * One buyer's `product`-scope review of one canonical product.
 *
 * `classification_state: 'native'` is not decoration:
 * `reviews_classification_consistency_check` ties it to the scope both ways, so
 * the default `unclassified` would refuse a scoped row outright.
 */
async function seedProductReview(
  productId: string,
  authorOxyUserId: string,
  rating: number,
): Promise<string> {
  const rows = await db
    .insert(reviews)
    .values({
      authorOxyUserId,
      targetType: 'canonical_product',
      scope: 'product',
      classificationState: 'native',
      canonicalProductId: productId,
      rating,
    })
    .returning({ id: reviews.id });
  const reviewId = rows[0]?.id;
  if (!reviewId) throw new Error('failed to seed a review');
  createdReviewIds.push(reviewId);
  return reviewId;
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

describe('#333: a merge whose two products share ONE reviewer', () => {
  /**
   * `reviews_author_scope_target_key` is `(author_oxy_user_id, scope,
   * target_key)` and `target_key` is GENERATED over `canonical_product_id`, so a
   * buyer who reviewed both sides holds two rows that become one key the moment
   * the loser's is repointed. With the plan's original unguarded `repoint` the
   * `reviews` phase raised 23505 and the whole job went `failed`.
   *
   * Both remaining reviews are asserted, not just the moved one: "the merge
   * completed" and "nobody's review was destroyed" are different claims and a
   * fix that deleted the collision would satisfy the first.
   */
  it('completes, moves what can move, and RETAINS the collision on the tombstone', async () => {
    const loser = await seedProduct('review-s');
    const winner = await seedProduct('review-t');
    const bothSides = `buyer-both-${RUN}`;
    const loserOnly = `buyer-loser-${RUN}`;

    const colliding = await seedProductReview(loser.productId, bothSides, 2);
    const incumbent = await seedProductReview(winner.productId, bothSides, 5);
    const movable = await seedProductReview(loser.productId, loserOnly, 4);

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'one buyer reviewed both',
      actorOxyUserId: OPERATOR,
    });
    const result = await claimAndRunMerge(job.id, `lease-s-${RUN}`);
    expect(result.blocked).toBe(false);
    expect(result.completed).toBe(true);

    const after = await db
      .select({ id: reviews.id, productId: reviews.canonicalProductId })
      .from(reviews)
      .where(inArray(reviews.id, [colliding, incumbent, movable]));
    // NOTHING was deleted. Acceptance 2 begins here: a fix that resolved the
    // collision by removing a row would pass every assertion below it.
    expect(after).toHaveLength(3);
    const targetOf = new Map(after.map((row) => [row.id, row.productId]));
    // The winner's own review is untouched — a merge never writes the surviving
    // side of a collision, which is `applyConflictResolution`'s rule too.
    expect(targetOf.get(incumbent)).toBe(winner.productId);
    // The review with no counterpart followed the identity.
    expect(targetOf.get(movable)).toBe(winner.productId);
    // …and the collision stayed, which is what there was to decide.
    expect(targetOf.get(colliding)).toBe(loser.productId);

    // The disposition is RECORDED, in #76's own log, under the action #76
    // published for exactly this and nothing wrote until now. `from` and `to`
    // are both the loser because that is what happened: the merge considered
    // this review and left its target where it was.
    const recorded = await db
      .select({
        action: reviewTargetMigrations.action,
        fromTargetRef: reviewTargetMigrations.fromTargetRef,
        toTargetRef: reviewTargetMigrations.toTargetRef,
        reason: reviewTargetMigrations.reason,
        actorKind: reviewTargetMigrations.actorKind,
      })
      .from(reviewTargetMigrations)
      .where(inArray(reviewTargetMigrations.reviewId, [colliding, incumbent, movable]));
    expect(recorded).toEqual([
      {
        action: 'rehome_merge',
        fromTargetRef: loser.productId,
        toTargetRef: loser.productId,
        reason: 'merge_collision_author_already_reviewed_winner',
        actorKind: 'migration',
      },
    ]);

    // Both aggregates are DERIVABLE and were re-derived from what each side now
    // holds — #76's authority, never summed across the two. The seeded reviews
    // are unverified, so they land in the unverified pair by construction.
    const aggregates = await db
      .select({
        productId: reviewAggregates.canonicalProductId,
        unverifiedRating: reviewAggregates.unverifiedRating,
        unverifiedCount: reviewAggregates.unverifiedCount,
      })
      .from(reviewAggregates)
      .where(inArray(reviewAggregates.canonicalProductId, [loser.productId, winner.productId]));
    const aggregateOf = new Map(aggregates.map((row) => [row.productId, row]));
    // The winner: the incumbent 5 and the moved 4.
    expect(aggregateOf.get(winner.productId)?.unverifiedCount).toBe(2);
    expect(aggregateOf.get(winner.productId)?.unverifiedRating).toBeCloseTo(4.5, 5);
    // The tombstone: exactly the review left behind, so the retained rating is
    // still counted somewhere rather than vanishing from the graph.
    expect(aggregateOf.get(loser.productId)?.unverifiedCount).toBe(1);
    expect(aggregateOf.get(loser.productId)?.unverifiedRating).toBeCloseTo(2, 5);
  });

  it('is idempotent: a re-run moves nothing and writes no second record', async () => {
    const loser = await seedProduct('review-u');
    const winner = await seedProduct('review-v');
    const bothSides = `buyer-both2-${RUN}`;
    const colliding = await seedProductReview(loser.productId, bothSides, 3);
    await seedProductReview(winner.productId, bothSides, 4);

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'replay of a collision',
      actorOxyUserId: OPERATOR,
    });
    expect((await claimAndRunMerge(job.id, `lease-u-${RUN}`)).completed).toBe(true);

    /**
     * The re-run that resumability actually produces: a phase CLAIMED but never
     * STAMPED is re-run whole. Re-running the job with every phase record intact
     * would skip the `reviews` body entirely and assert nothing about it, so the
     * record is removed — one table per trigger window (#301).
     */
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table catalog_merge_job_phases disable trigger catalog_merge_job_phases_append_only`,
      );
      await tx
        .delete(catalogMergeJobPhases)
        .where(and(eq(catalogMergeJobPhases.jobId, job.id), eq(catalogMergeJobPhases.phase, 'reviews')));
      await tx.execute(
        sql`alter table catalog_merge_job_phases enable trigger catalog_merge_job_phases_append_only`,
      );
    });
    // `completed_at` goes with the status: `catalog_merge_jobs_completion_check`
    // ties the two, so a job re-opened without clearing it is unrepresentable.
    await db
      .update(catalogMergeJobs)
      .set({ status: 'pending', phase: 'reviews', completedAt: null })
      .where(eq(catalogMergeJobs.id, job.id));
    expect((await claimAndRunMerge(job.id, `lease-u2-${RUN}`)).completed).toBe(true);

    const still = await db
      .select({ productId: reviews.canonicalProductId })
      .from(reviews)
      .where(eq(reviews.id, colliding));
    expect(still[0]?.productId).toBe(loser.productId);

    // ONE record, not two: `UNIQUE(review_id, action, coalesce(to_target_ref,''))`
    // converges the replay rather than growing the log.
    const records = await db
      .select({ id: reviewTargetMigrations.id })
      .from(reviewTargetMigrations)
      .where(eq(reviewTargetMigrations.reviewId, colliding));
    expect(records).toHaveLength(1);
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

/**
 * #405 — a merge that would land BOTH ends of one relation on the winner.
 *
 * This is the case no `uniqueWith` can express and `absenceGuard` cannot see:
 * that guard hunts a COLLIDING WINNER ROW, and here there is none. The offending
 * row is the one being moved, legal before the merge and illegal after it, and
 * before this it reached `relationships` and failed with a raw `23514` four
 * phases in.
 *
 * A real server is the whole point. The property under test IS
 * `generic_compatibility_relations_distinct_endpoints_check`; a mocked update
 * accepts the statement that constraint refuses, so a mocked version of every
 * case below passes whether or not anything was fixed.
 */
describe('#405: a merge that collapses both ends of one compatibility relation', () => {
  /** One OPEN relation, at whichever grain the caller names. */
  async function seedRelation(
    subject: { productId?: string; variantId?: string },
    target: { productId?: string; variantId?: string; typedKey?: string },
  ): Promise<string> {
    const rows = await db
      .insert(genericCompatibilityRelations)
      .values({
        kind: 'works_with',
        subjectProductId: subject.productId ?? null,
        subjectVariantId: subject.variantId ?? null,
        targetKind: target.typedKey
          ? 'typed'
          : target.productId
            ? 'canonical_product'
            : 'canonical_variant',
        targetProductId: target.productId ?? null,
        targetVariantId: target.variantId ?? null,
        targetType: target.typedKey ? 'connector_standard' : null,
        targetKey: target.typedKey ?? null,
        assertedByKind: 'operator',
      })
      .returning({ id: genericCompatibilityRelations.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('failed to seed a compatibility relation');
    createdRelationIds.push(id);
    return id;
  }

  async function collapseConflictsFor(jobId: string) {
    return db.select().from(catalogMergeConflicts).where(eq(catalogMergeConflicts.jobId, jobId));
  }

  /**
   * The shape #405's own text names FIRST, and the reason the detector probes
   * two shapes rather than three.
   *
   * The CHECK is unconditional and total, so `(x, x)` cannot be stored at all —
   * which makes a probe for it a branch that can never match, and a branch that
   * can never match reads as coverage. The legal pair beside it is the control:
   * without it, a refusal here could equally mean the fixture was malformed.
   */
  it('cannot even STORE a relation naming one entity at both ends', async () => {
    const subject = await seedProduct('collapse-unrepresentable');
    const other = await seedProduct('collapse-unrepresentable-other');

    // CONTROL: the same statement with two DIFFERENT endpoints is accepted.
    await seedRelation({ productId: subject.productId }, { productId: other.productId });

    await expectConstraintViolation(
      () => seedRelation({ productId: subject.productId }, { productId: subject.productId }),
      'generic_compatibility_relations_distinct_endpoints_check',
    );
  });

  it('BLOCKS a product merge, closes the relation, and leaves it on the tombstone', async () => {
    const loser = await seedProduct('collapse-p-loser');
    const winner = await seedProduct('collapse-p-winner');
    const bystander = await seedProduct('collapse-p-bystander');

    const collapsing = await seedRelation(
      { productId: loser.productId },
      { productId: winner.productId },
    );
    /**
     * The POSITIVE CONTROL for the guard, and it is not optional.
     *
     * `collapseGuard` takes rows OUT of the repoint, so "the relation did not
     * move" is the outcome of a working guard AND of a guard so wide it moves
     * nothing at all. This relation names the loser and an unrelated third
     * product, so it must still arrive on the winner.
     */
    const ordinary = await seedRelation(
      { productId: loser.productId },
      { productId: bystander.productId },
    );
    /**
     * The SECOND control, for `is distinct from` rather than for the guard's
     * width.
     *
     * A relation to a TYPED target leaves `target_product_id` NULL, and
     * `NULL <> '<winner>'` is NULL — so spelling the guard with a plain `<>`
     * takes this row out of the UPDATE and it never reaches the winner, with no
     * error anywhere. Every relation to a connector, a socket or a media format
     * is this shape, so the mistake would strand most of the table.
     */
    const typedTarget = await seedRelation(
      { productId: loser.productId },
      { typedKey: 'connector.usb_c' },
    );

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'the same product, twice',
      actorOxyUserId: OPERATOR,
    });

    const blocked = await claimAndRunMerge(job.id, `lease-405p-${RUN}`);
    expect(blocked.blocked).toBe(true);
    expect(blocked.completed).toBe(false);

    const conflicts = await collapseConflictsFor(job.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('compatibility_endpoint_collapse');
    // The ONE row, named. There is no winner counterpart and every pair column
    // is NULL, which `catalog_merge_conflicts_pair_shape_check` requires.
    expect(conflicts[0]?.collapsingRelationId).toBe(collapsing);
    expect(conflicts[0]?.loserRelationshipId).toBeNull();
    expect(conflicts[0]?.winnerRelationshipId).toBeNull();
    expect(conflicts[0]?.resolution).toBeNull();

    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no conflict to resolve');

    // `keep_winner` is refused by the DATABASE, not by a service branch: there
    // is no winner row to keep, and an accepted decision that changed nothing
    // would unblock the job straight back into the 23514.
    await expectConstraintViolation(
      () =>
        resolveMergeConflict({
          conflictId,
          resolution: 'keep_winner',
          reason: 'there is no winner row, so this is meaningless',
          actorOxyUserId: OPERATOR,
        }),
      'catalog_merge_conflicts_collapse_resolution_check',
    );

    await resolveMergeConflict({
      conflictId,
      resolution: 'close_relation',
      reason: 'the two products are one, so the claim is degenerate',
      actorOxyUserId: OPERATOR,
    });

    const finished = await claimAndRunMerge(job.id, `lease-405p2-${RUN}`);
    expect(finished.completed).toBe(true);

    const [closed] = await db
      .select()
      .from(genericCompatibilityRelations)
      .where(eq(genericCompatibilityRelations.id, collapsing));
    // CLOSED, attributable, and still on the tombstone — never deleted, never
    // moved. Repointing it is the statement the CHECK refuses.
    expect(closed?.validTo).not.toBeNull();
    expect(closed?.verification).toBe('revoked');
    expect(closed?.revokedByOxyUserId).toBe(OPERATOR);
    expect(closed?.subjectProductId).toBe(loser.productId);
    expect(closed?.targetProductId).toBe(winner.productId);

    const [moved] = await db
      .select()
      .from(genericCompatibilityRelations)
      .where(eq(genericCompatibilityRelations.id, ordinary));
    expect(moved?.subjectProductId).toBe(winner.productId);
    expect(moved?.validTo).toBeNull();

    const [movedTyped] = await db
      .select()
      .from(genericCompatibilityRelations)
      .where(eq(genericCompatibilityRelations.id, typedTarget));
    expect(movedTyped?.subjectProductId).toBe(winner.productId);
  });

  /**
   * The SECOND shape, and the one a rewrite drops: the relation already names
   * the winner and only its OTHER end has to move, so nothing about it looks
   * like the loser's row.
   */
  it('BLOCKS when the relation points from the WINNER at the loser', async () => {
    const loser = await seedProduct('collapse-rev-loser');
    const winner = await seedProduct('collapse-rev-winner');
    const collapsing = await seedRelation(
      { productId: winner.productId },
      { productId: loser.productId },
    );

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'duplicate, and the winner already cites it',
      actorOxyUserId: OPERATOR,
    });

    const blocked = await claimAndRunMerge(job.id, `lease-405r-${RUN}`);
    expect(blocked.blocked).toBe(true);

    const conflicts = await collapseConflictsFor(job.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('compatibility_endpoint_collapse');
    expect(conflicts[0]?.collapsingRelationId).toBe(collapsing);

    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no conflict to resolve');
    await resolveMergeConflict({
      conflictId,
      resolution: 'close_relation',
      reason: 'degenerate once the two are one',
      actorOxyUserId: OPERATOR,
    });
    expect((await claimAndRunMerge(job.id, `lease-405r2-${RUN}`)).completed).toBe(true);

    const [closed] = await db
      .select()
      .from(genericCompatibilityRelations)
      .where(eq(genericCompatibilityRelations.id, collapsing));
    expect(closed?.validTo).not.toBeNull();
    expect(closed?.targetProductId).toBe(loser.productId);
  });

  /**
   * The SAME CHECK's second conjunct, one grain down.
   *
   * `generic_compatibility_relations_distinct_endpoints_check` is two clauses,
   * products and variants, and a fix that wired only the product grain would
   * leave a variant merge failing with the identical `23514` — in a change whose
   * title said it was fixed.
   */
  it('BLOCKS a VARIANT merge on the same CHECK, at the variant grain', async () => {
    const loser = await seedProduct('collapse-v-loser');
    const winner = await seedProduct('collapse-v-winner');
    const collapsing = await seedRelation(
      { variantId: loser.variantId },
      { variantId: winner.variantId },
    );

    const job = await requestMerge({
      entityType: 'canonical_variant',
      loserId: loser.variantId,
      winnerId: winner.variantId,
      reason: 'one configuration, recorded twice',
      actorOxyUserId: OPERATOR,
    });

    const blocked = await claimAndRunMerge(job.id, `lease-405v-${RUN}`);
    expect(blocked.blocked).toBe(true);

    const conflicts = await collapseConflictsFor(job.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('compatibility_endpoint_collapse');
    expect(conflicts[0]?.collapsingRelationId).toBe(collapsing);

    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no conflict to resolve');
    await resolveMergeConflict({
      conflictId,
      resolution: 'close_relation',
      reason: 'degenerate once the two variants are one',
      actorOxyUserId: OPERATOR,
    });
    expect((await claimAndRunMerge(job.id, `lease-405v2-${RUN}`)).completed).toBe(true);

    const [closed] = await db
      .select()
      .from(genericCompatibilityRelations)
      .where(eq(genericCompatibilityRelations.id, collapsing));
    expect(closed?.validTo).not.toBeNull();
    expect(closed?.subjectVariantId).toBe(loser.variantId);
    expect(closed?.targetVariantId).toBe(winner.variantId);
  });
});

/**
 * #405, the redirect tables — `canonical_product_redirects_self_check` and its
 * family twin.
 *
 * ONE shape, because only `to_id` moves: `from_id` is `untouched` (a hop OUT of
 * the loser is history about the loser), so the row must already read
 * `(winner, loser)`.
 *
 * That looks unreachable — a redirect FROM the winner means the winner was
 * merged away, and `requestMerge` refuses a tombstone winner — until a SPLIT is
 * taken into account, which is why these fixtures build the state the way
 * production does rather than by inserting it. `revive_tombstone` clears
 * `merged_into_id` and leaves the redirect rows standing, so a revived entity is
 * a legal winner still naming the entity it later absorbs. The reachability
 * comes from #59 acceptance 2 itself, and no race is involved.
 */
describe('#405: a merge that would turn a redirect hop into a self-redirect', () => {
  it('cannot even STORE a redirect from an entity to itself', async () => {
    const one = await seedProduct('redirect-unrepresentable');
    const two = await seedProduct('redirect-unrepresentable-two');

    // CONTROL: the same statement between two DIFFERENT products is accepted.
    await db
      .insert(canonicalProductRedirects)
      .values({ fromId: one.productId, toId: two.productId, reason: 'merge' });

    await expectConstraintViolation(
      () =>
        db
          .insert(canonicalProductRedirects)
          .values({ fromId: one.productId, toId: one.productId, reason: 'merge' }),
      'canonical_product_redirects_self_check',
    );
  });

  it('BLOCKS a re-merge after a split revived the tombstone, and keeps the hop', async () => {
    const revived = await seedProduct('redirect-revived');
    const absorber = await seedProduct('redirect-absorber');

    // The state a real rollback leaves: `revived` was merged into `absorber`
    // (so a hop `revived -> absorber` exists), then split back. The hop stays —
    // `split.service.ts` says so in as many words — and `revived` is live again.
    await db
      .insert(canonicalProductRedirects)
      .values({ fromId: revived.productId, toId: absorber.productId, reason: 'merge' });

    // Now the operator merges the other way. `absorber` is the LOSER, and the
    // winner already holds a hop naming it.
    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: absorber.productId,
      winnerId: revived.productId,
      reason: 'the split was right and this one is the duplicate',
      actorOxyUserId: OPERATOR,
    });

    const blocked = await claimAndRunMerge(job.id, `lease-405rd-${RUN}`);
    expect(blocked.blocked).toBe(true);

    const conflicts = await db
      .select()
      .from(catalogMergeConflicts)
      .where(eq(catalogMergeConflicts.jobId, job.id));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('redirect_endpoint_collapse');
    expect(conflicts[0]?.collapsingProductRedirectId).not.toBeNull();
    expect(conflicts[0]?.collapsingFamilyRedirectId).toBeNull();
    expect(conflicts[0]?.collapsingRelationId).toBeNull();

    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no conflict to resolve');

    // `close_relation` is refused by the DATABASE: a redirect has no state to
    // close, and the two collapse resolutions are not interchangeable.
    await expectConstraintViolation(
      () =>
        resolveMergeConflict({
          conflictId,
          resolution: 'close_relation',
          reason: 'a redirect has nothing to close',
          actorOxyUserId: OPERATOR,
        }),
      'catalog_merge_conflicts_close_relation_kind_check',
    );

    await resolveMergeConflict({
      conflictId,
      resolution: 'retain_history',
      reason: 'the hop really happened; it stays as history',
      actorOxyUserId: OPERATOR,
    });
    expect((await claimAndRunMerge(job.id, `lease-405rd2-${RUN}`)).completed).toBe(true);

    // The hop is intact and unmoved — neither repointed into a self-redirect nor
    // deleted. Asserting BOTH ends is what stops a repoint passing as a retain.
    const [hop] = await db
      .select()
      .from(canonicalProductRedirects)
      .where(eq(canonicalProductRedirects.fromId, revived.productId));
    expect(hop?.toId).toBe(absorber.productId);
  });
});

/**
 * #405, the third table — `bundle_components_self_check`.
 *
 * The same collapse with no soft state anywhere: no `valid_to`, no status, both
 * columns NOT NULL, and the table's own writer (`replaceBundleComponents`) is
 * delete-then-insert. So the only way one of its rows stops being current is
 * that it stops existing — and curation deletes nothing.
 *
 * The act therefore belongs to the catalogue and the DECISION belongs to the
 * merge, and `resolveMergeConflict` REFUSES the decision while the row is still
 * there. Checking at resolve time rather than at apply time is what keeps the
 * job out of a state nothing can lift: a job leaves `blocked` only when a
 * resolution is accepted.
 */
describe('#405: a merge that would make a bundle contain itself', () => {
  async function seedBundleComponent(bundleVariantId: string, componentVariantId: string) {
    await db
      .insert(bundleComponents)
      .values({ bundleVariantId, componentVariantId, quantity: 2, position: 3 });
    createdBundleVariantIds.push(bundleVariantId);
  }

  it('cannot even STORE a bundle whose component is itself', async () => {
    const bundle = await seedProduct('bundle-unrepresentable');
    const part = await seedProduct('bundle-unrepresentable-part');

    // CONTROL: the same statement with two DIFFERENT variants is accepted.
    await seedBundleComponent(bundle.variantId, part.variantId);

    await expectConstraintViolation(
      () => seedBundleComponent(bundle.variantId, bundle.variantId),
      'bundle_components_self_check',
    );
  });

  it('BLOCKS, REFUSES the decision until the bundle is fixed, then completes', async () => {
    const loser = await seedProduct('bundle-loser');
    const winner = await seedProduct('bundle-winner');
    const bystander = await seedProduct('bundle-bystander');

    // The WINNER's bundle lists the loser as a component — the shape where
    // leaving the row behind is actively wrong, because the winner is live and
    // would go on listing a tombstone that resolves back to the bundle itself.
    await seedBundleComponent(winner.variantId, loser.variantId);
    // The control that the merge still moves ordinary component rows.
    await seedBundleComponent(bystander.variantId, loser.variantId);

    const job = await requestMerge({
      entityType: 'canonical_variant',
      loserId: loser.variantId,
      winnerId: winner.variantId,
      reason: 'one variant, listed twice',
      actorOxyUserId: OPERATOR,
    });

    const blocked = await claimAndRunMerge(job.id, `lease-405b-${RUN}`);
    expect(blocked.blocked).toBe(true);

    const conflicts = await db
      .select()
      .from(catalogMergeConflicts)
      .where(eq(catalogMergeConflicts.jobId, job.id));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('bundle_self_containment');
    expect(conflicts[0]?.collapsingBundleVariantId).toBe(winner.variantId);
    expect(conflicts[0]?.collapsingComponentVariantId).toBe(loser.variantId);
    // The quantity and position ride in `detail`, because this is the one
    // collapse whose row is GONE by the time anybody reads the decision.
    expect(conflicts[0]?.detail).toContain('quantity 2');
    expect(conflicts[0]?.detail).toContain('position 3');

    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no conflict to resolve');

    /**
     * THE LOAD-BEARING ASSERTION. The component is still there, so the decision
     * is REFUSED and nothing is recorded.
     *
     * Accepting it would unblock the job, which would then re-block in the
     * resolution phase with every conflict already resolved — and
     * `unblockMergeJob` has exactly one caller, this path, so nothing could ever
     * lift it again.
     */
    await expect(
      resolveMergeConflict({
        conflictId,
        resolution: 'drop_component',
        reason: 'claiming it is gone when it is not',
        actorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/still lists/u);

    const [unchanged] = await db
      .select()
      .from(catalogMergeConflicts)
      .where(eq(catalogMergeConflicts.id, conflictId));
    expect(unchanged?.resolution).toBeNull();

    // The operator removes it through the catalogue's OWN writer, where
    // deleting a component row is the ordinary edit.
    await replaceBundleComponents(db, winner.variantId, []);

    await resolveMergeConflict({
      conflictId,
      resolution: 'drop_component',
      reason: 'the bundle and its component are one variant; removed',
      actorOxyUserId: OPERATOR,
    });
    expect((await claimAndRunMerge(job.id, `lease-405b2-${RUN}`)).completed).toBe(true);

    const remaining = await db
      .select()
      .from(bundleComponents)
      .where(eq(bundleComponents.componentVariantId, winner.variantId));
    // The bystander's row moved onto the winner. Asserting the survivor rather
    // than only the absence is what stops "nothing moved" passing.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.bundleVariantId).toBe(bystander.variantId);
  });
});

/**
 * #663 — a blocked job whose condition has CLEARED gets back to `pending`.
 *
 * `unblockMergeJob` used to have exactly one caller, `resolveMergeConflict`,
 * which fires on a resolution. So a job that reached `blocked` with every
 * conflict ALREADY resolved was stranded: there was nothing left to resolve, the
 * dispatcher will not claim `blocked`, and no route existed. Two conditions
 * reach that state and both are exercised below.
 *
 * These cases need a REAL server for the ordinary reason the rest of this file
 * does — `claimMergeJobs` is `FOR UPDATE SKIP LOCKED` against a status a mocked
 * update would happily ignore — and for one more: the strand is only real
 * because a blocked job is genuinely unclaimable, which is a property of the
 * claim STATEMENT. Each case asserts that directly rather than assuming it.
 *
 * ## Why `resumeBlockedMergeJobs` may be called against the shared database
 *
 * It reads every blocked merge job, not only this file's. That is safe here and
 * the reason is not "no sibling writes these tables" — `product-saves.realdb.
 * test.ts` does — it is that the sweep resumes a job only when the SAME
 * predicate that blocked it now says clear, so a sibling's job blocked on an
 * undecided conflict is untouched by construction. What this file must not do
 * is assert on the sweep's RETURN COUNT, which legitimately includes rows it
 * does not own; every assertion below is on this file's own job id.
 */
describe('#663: resuming a merge job whose blocking condition has cleared', () => {
  /** Two products whose variants share a signature — a `merge_pair` conflict. */
  async function seedSignatureCollision(label: string) {
    const loser = await seedProduct(`${label}-loser`);
    const winner = await seedProduct(`${label}-winner`);
    const shared = variantSignature([{ key: 'colour', normalizedValue: `shared-${label}` }]);
    await db
      .update(canonicalVariants)
      .set({ signature: shared })
      .where(inArray(canonicalVariants.id, [loser.variantId, winner.variantId]));
    return { loser, winner };
  }

  async function statusOf(jobId: string): Promise<string> {
    const rows = await db
      .select({ status: catalogMergeJobs.status })
      .from(catalogMergeJobs)
      .where(eq(catalogMergeJobs.id, jobId));
    const status = rows[0]?.status;
    if (!status) throw new Error(`merge job ${jobId} vanished`);
    return status;
  }

  /**
   * What the dispatcher's claim would take right now — in a ROLLED-BACK
   * transaction, so asking the question changes nothing.
   *
   * A plain claim here is destructive twice over, and the first version of this
   * helper was both: `claimMergeJobs` has no filter beyond the due predicate, so
   * a batch of 25 steals rows from whatever sibling file is running (the hazard
   * `claimAndRunMerge` above already records) AND it claimed this test's own
   * CHILD job, leaving it `processing` under a lease owner that would never run
   * it. That showed up as the child's status being wrong in an assertion about
   * the parent, which is the least legible way for it to show up.
   *
   * `tx.rollback()` throws by design, so the ids are captured in a closure
   * before it and the promise's rejection is the expected path — the
   * `connectors.realdb.test.ts` idiom.
   *
   * It BACKDATES first, to this file's own `to_timestamp(0)`, which is older
   * than any other file's instant. That is what makes `batchSize: 1` a real
   * question rather than a vacuous one: if this job were claimable at all it
   * would sort first, so it is the one row a batch of one must return.
   */
  async function claimWouldTake(jobId: string, owner: string): Promise<readonly string[]> {
    await db.execute(
      sql`update catalog_merge_jobs set available_at = to_timestamp(0) where id = ${jobId}`,
    );
    let taken: readonly string[] = [];
    await db
      .transaction(async (tx) => {
        taken = (await claimMergeJobs({ leaseOwner: owner, batchSize: 1 }, tx)).map((row) => row.id);
        tx.rollback();
      })
      .catch(() => undefined);
    return taken;
  }

  it('resumes a `merge_pair` parent when its CHILD completes, and not before', async () => {
    const { loser, winner } = await seedSignatureCollision('663mp');
    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'one product, listed twice',
      actorOxyUserId: OPERATOR,
    });

    const blocked = await claimAndRunMerge(job.id, `lease-663mp-${RUN}`);
    expect(blocked.blocked).toBe(true);

    const conflicts = await db
      .select()
      .from(catalogMergeConflicts)
      .where(eq(catalogMergeConflicts.jobId, job.id));
    expect(conflicts.map((row) => row.kind)).toEqual(['variant_signature']);
    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no signature conflict to resolve');

    const { childJobId } = await resolveMergeConflict({
      conflictId,
      resolution: 'merge_pair',
      reason: 'the two configurations are the same thing',
      actorOxyUserId: OPERATOR,
    });
    if (!childJobId) throw new Error('`merge_pair` opened no child job');

    /**
     * Resolving the last conflict does NOT unblock this job, and that is the
     * change #663 asks for.
     *
     * Before it, `resolveMergeConflict` asked only whether anything was
     * undecided, so this job went `pending`, was claimed, re-blocked on the
     * incomplete child, and could never be lifted again. It now asks the whole
     * predicate, which still names the child.
     */
    expect(await statusOf(job.id)).toBe('blocked');

    // The control for everything below: while it is blocked, nothing claims it.
    expect(await claimWouldTake(job.id, `lease-663mp-claim-${RUN}`)).not.toContain(job.id);

    // And the sweep will not resume it either, because the condition it blocked
    // on is still true. This is the property that separates a real
    // re-evaluation from a retry button.
    await resumeBlockedMergeJobs(50);
    expect(await statusOf(job.id)).toBe('blocked');

    const state = await mergeJobBlockingState(
      (await db.select().from(catalogMergeJobs).where(eq(catalogMergeJobs.id, job.id)))[0],
      db,
    );
    expect(state.state).toBe('blocked');
    /**
     * The child's CURRENT status, not "must complete first": a running child
     * and a dead-lettered one lead an operator to opposite actions.
     *
     * Read from the row rather than written out, so this cannot pass by
     * agreeing with a guess — and so the child is asserted to be genuinely
     * untouched by everything above, which the first draft of this file was not.
     */
    const childStatus = (
      await db
        .select({ status: catalogMergeJobs.status })
        .from(catalogMergeJobs)
        .where(eq(catalogMergeJobs.id, childJobId))
    )[0]?.status;
    expect(childStatus).toBe('pending');
    expect(state.state === 'blocked' && state.reason).toContain(childStatus);
    expect(state.state === 'blocked' && state.reason).toContain(childJobId);

    // The child runs. Nothing in the child's path touches the parent.
    expect((await claimAndRunMerge(childJobId, `lease-663mp-child-${RUN}`)).completed).toBe(true);
    expect(await statusOf(job.id)).toBe('blocked');

    // NOW the sweep lifts it — the whole of #663.
    await resumeBlockedMergeJobs(50);
    expect(await statusOf(job.id)).toBe('pending');

    /**
     * The POSITIVE control for every `not.toContain` above.
     *
     * The same call, the same backdate, the same batch of one — and now it
     * takes this job. Without it, "the claim did not return it" would also be
     * satisfied by a claim that returns nothing at all, which is what a
     * mis-scoped fixture looks like.
     */
    expect(await claimWouldTake(job.id, `lease-663mp-claim2-${RUN}`)).toEqual([job.id]);

    expect((await claimAndRunMerge(job.id, `lease-663mp2-${RUN}`)).completed).toBe(true);

    // The merge actually happened, rather than the job merely reaching `done`.
    const tombstone = await db
      .select({ status: canonicalProducts.status, mergedIntoId: canonicalProducts.mergedIntoId })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, loser.productId));
    expect(tombstone[0]?.status).toBe('merged');
    expect(tombstone[0]?.mergedIntoId).toBe(winner.productId);
  });

  it('resumes a four-eyes job when the SECOND APPROVAL arrives, and not before', async () => {
    const loser = await seedProduct('663fe-loser');
    const winner = await seedProduct('663fe-winner');
    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'duplicate listing of one product',
      actorOxyUserId: OPERATOR,
    });

    /**
     * The requirement is set on the ROW rather than by moving the four-eyes
     * threshold.
     *
     * `requires_second_approval` is snapshotted at request time precisely so a
     * threshold change cannot retroactively unapprove a job, and the gate under
     * test reads the COLUMN. Raising `config.catalog.fourEyesRequired` instead
     * would widen a global bound for every file sharing this database, which is
     * the hazard `~/Oxy/AGENTS.md` records; this touches one row this file owns.
     */
    await db
      .update(catalogMergeJobs)
      .set({ requiresSecondApproval: true })
      .where(eq(catalogMergeJobs.id, job.id));

    const blocked = await claimAndRunMerge(job.id, `lease-663fe-${RUN}`);
    expect(blocked.blocked).toBe(true);
    expect(await statusOf(job.id)).toBe('blocked');
    expect(await claimWouldTake(job.id, `lease-663fe-claim-${RUN}`)).not.toContain(job.id);

    // Unapproved, the sweep leaves it exactly where it is.
    await resumeBlockedMergeJobs(50);
    expect(await statusOf(job.id)).toBe('blocked');

    /**
     * On `main` this is where the job died, and NOTHING covered it.
     *
     * `catalog_merge_jobs_second_approval_check` permits `awaiting_resolution`
     * unapproved, so a four-eyes merge advances there within seconds of being
     * requested and blocks; `approveMergeJob` writes the two approval columns
     * and does not unblock. Every merge over the impact threshold was stranded.
     */
    await approveMerge(job.id, SECOND_OPERATOR, 'reviewed the impact and the pair');

    await resumeBlockedMergeJobs(50);
    expect(await statusOf(job.id)).toBe('pending');
    // The positive control, as above: the same claim now takes it.
    expect(await claimWouldTake(job.id, `lease-663fe-claim2-${RUN}`)).toEqual([job.id]);
    expect((await claimAndRunMerge(job.id, `lease-663fe2-${RUN}`)).completed).toBe(true);

    const tombstone = await db
      .select({ status: canonicalProducts.status, mergedIntoId: canonicalProducts.mergedIntoId })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, loser.productId));
    expect(tombstone[0]?.status).toBe('merged');
    expect(tombstone[0]?.mergedIntoId).toBe(winner.productId);
  });

  it('never resumes a parent whose child DEAD-LETTERED, and says so', async () => {
    const { loser, winner } = await seedSignatureCollision('663dl');
    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'one product, listed twice',
      actorOxyUserId: OPERATOR,
    });
    expect((await claimAndRunMerge(job.id, `lease-663dl-${RUN}`)).blocked).toBe(true);

    const conflicts = await db
      .select()
      .from(catalogMergeConflicts)
      .where(eq(catalogMergeConflicts.jobId, job.id));
    const conflictId = conflicts[0]?.id;
    if (!conflictId) throw new Error('no signature conflict to resolve');
    const { childJobId } = await resolveMergeConflict({
      conflictId,
      resolution: 'merge_pair',
      reason: 'the two configurations are the same thing',
      actorOxyUserId: OPERATOR,
    });
    if (!childJobId) throw new Error('`merge_pair` opened no child job');

    await db
      .update(catalogMergeJobs)
      .set({ status: 'dead_letter', lastError: 'exhausted its attempts' })
      .where(eq(catalogMergeJobs.id, childJobId));

    /**
     * A child that will never complete is a genuine dead end, and resuming the
     * parent is the WRONG answer to it — the parent must not repoint a variant
     * whose signature twin never became a tombstone. What the predicate owes is
     * an accurate name for the thing a person has to go and look at.
     */
    await resumeBlockedMergeJobs(50);
    expect(await statusOf(job.id)).toBe('blocked');

    const state = await mergeJobBlockingState(
      (await db.select().from(catalogMergeJobs).where(eq(catalogMergeJobs.id, job.id)))[0],
      db,
    );
    expect(state.state === 'blocked' && state.reason).toContain(childJobId);
    expect(state.state === 'blocked' && state.reason).toContain('dead_letter');
  });

  it('refuses to vouch for a phase it does not own, so a future one fails closed', async () => {
    const loser = await seedProduct('663ph-loser');
    const winner = await seedProduct('663ph-winner');
    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: 'duplicate listing of one product',
      actorOxyUserId: OPERATOR,
    });

    /**
     * A SYNTHETIC state, deliberately, and the only way to reach this branch.
     *
     * `awaiting_resolution` is the one phase that blocks today, so a job parked
     * anywhere else cannot be produced by any code path — which is exactly why
     * the branch needs a test: it is the guard for the phase somebody adds
     * later, and a guard nobody has ever seen fire is a guard nobody knows is
     * inert. Its companion is a `tsc` error (`PhaseOutcome` carries no
     * `blockedReason`); this is the runtime half.
     */
    await db
      .update(catalogMergeJobs)
      .set({ status: 'blocked', phase: 'offers', lastError: 'a phase nobody has written yet' })
      .where(eq(catalogMergeJobs.id, job.id));

    const state = await mergeJobBlockingState(
      (await db.select().from(catalogMergeJobs).where(eq(catalogMergeJobs.id, job.id)))[0],
      db,
    );
    expect(state.state).toBe('blocked');
    expect(state.state === 'blocked' && state.reason).toContain('offers');

    await resumeBlockedMergeJobs(50);
    expect(await statusOf(job.id)).toBe('blocked');
  });
});
