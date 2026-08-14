/**
 * A sibling's match decision pins a canonical id, and the teardown declines it —
 * against a REAL Postgres, deterministically.
 *
 * ## What it reproduces, and why it is not a race
 *
 * `canonical-catalog.realdb.test.ts` failed once in four full baseline runs on
 * `85d6697` with `23503` on
 * `match_decisions_matched_canonical_variant_id_canonical_variants`: the matcher's
 * candidate retrieval is a trigram search over every canonical product (correctly
 * global for production), so a sibling driving `runMatch` recorded a decision
 * citing that file's fixture, and the fixture's own correctly-scoped delete could
 * not proceed. The intermittency is in WHICH sibling matches WHAT and WHEN; the
 * mechanism is not timing-dependent at all, so this file constructs the cited row
 * directly and the red is reliable.
 *
 * ## It constructs the row through the matcher's OWN writer
 *
 * `upsertMatchDecision` is the function `match.service` calls, so the row's shape,
 * its CHECKs and both foreign keys are the real ones. What is NOT re-run is
 * retrieval — the trigram search that decides WHICH product a sibling matches.
 * Re-running it would need the global active-matching-policy slot
 * (`match_policy_versions_active_key` admits one active policy per DATABASE), so
 * this file would have to queue behind every matcher file to assert something
 * about a foreign key. The policy version here is therefore `draft`: the FK needs
 * a ROW, not an active one, so nothing contends and nothing another file relies on
 * is touched.
 *
 * That division is worth stating plainly. This gate proves the TEARDOWN's
 * behaviour in the presence of a citing row. It does not prove a sibling will
 * produce one — the baseline red did that, and `postgres-candidate-source.ts`'s
 * unscoped retrieval is why it can happen again.
 *
 * ## The BARRIER cases, and why they need three backends
 *
 * Narrowing the delete was necessary and not sufficient: while the plan and the
 * two deletes were separate autocommitted statements, a sibling could commit a
 * citing decision in the gap and the delete met the same `23503`. The last
 * `describe` below drives that window directly rather than hoping to observe it.
 *
 * `Promise.all` does not interleave anything here — postgres.js pipelines onto
 * one connection — so each case is built from THREE dedicated backends: one
 * HOLDER whose open transaction decides exactly where the teardown stops, the
 * TEARER running the helper, and a SIBLING attempting the citing insert. The
 * lock statements order by `id`, so holding the row the teardown reaches FIRST
 * stops it having locked anything, and holding the row it reaches SECOND stops
 * it holding the first — which are the two sides of the invariant. Every wait is
 * asserted with `pg_blocking_pids` and THROWS if it never appears, because a
 * barrier that silently failed to open would make each of these cases pass by
 * measuring an ordinary sequential run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { constraintNameOf, createDatabase, uuidv7 } from '@oxyhq/db';
import type postgres from 'postgres';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import * as schema from '../schema/index.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { listings } from '../schema/catalog.js';
import { matchDecisions } from '../schema/matching.js';
import { normalizeEntityName } from '../../services/canonical/normalization.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * How long a barrier case waits for a lock wait that must appear.
 *
 * Generous, because it is not a timing assumption: the wait either appears
 * within a round trip or the mechanism under test is absent, and the ceiling
 * exists only so a missing barrier fails as a NAMED error rather than as
 * vitest's generic 30s timeout.
 */
const BLOCK_WAIT_MS = 10_000;

/** Poll interval for that wait. */
const BLOCK_POLL_MS = 25;

let db: Database;
/** Every id this file created, deleted in dependency order at the end. */
const createdProductIds: string[] = [];
let policyVersionId: string | null = null;
const createdDecisionIds: string[] = [];
/** A real native variant, because the decision's subject shape demands one. */
const createdListingIds: string[] = [];
const nativeVariantIds: string[] = [];

/**
 * A handle whose every statement runs on ONE backend, so its pid is knowable and
 * `pg_blocking_pids` can be asked about it by name.
 *
 * `max: 1` is what makes that true: the pool has exactly one connection, so a
 * statement issued while another is in flight queues behind it rather than
 * opening a second backend the caller cannot see.
 */
interface SoloConnection {
  readonly db: Database;
  readonly client: postgres.Sql;
  readonly pid: number;
}

const soloConnections: SoloConnection[] = [];

/** The backend the teardown under test runs on. */
let tearer: SoloConnection;
/** A second teardown, for the concurrency case. */
let otherTearer: SoloConnection;
/** Holds one row so the teardown stops exactly where a case needs it. */
let holder: SoloConnection;
/** Attempts the citing insert. */
let sibling: SoloConnection;
/** Reads `pg_blocking_pids`, and is never itself a participant. */
let probe: SoloConnection;

async function openSolo(): Promise<SoloConnection> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('vitest.pg.globalSetup did not publish DATABASE_URL');
  }
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 1, onnotice: () => undefined },
  });
  const rows = await instance.client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('the solo connection did not report a backend pid');
  const solo: SoloConnection = { db: instance.db, client: instance.client, pid };
  soloConnections.push(solo);
  return solo;
}

/**
 * Wait until `waiterPid` is blocked by `holderPid`, and THROW if it never is.
 *
 * `pg_blocking_pids` and NOT a `pg_locks` predicate on the relation: a row-lock
 * wait queues on the HOLDER's `transactionid`, so a query scoped to
 * `relation = 'canonical_products'::regclass` prints "they never overlapped"
 * beside a result only an overlap can produce. And not `pg_stat_activity.state`
 * either, which Postgres blanks for another role's backend.
 *
 * The throw is the point. Every case below rests on the wait having happened; a
 * barrier that never opened would leave the two statements running in sequence,
 * which is exactly the arrangement that passes for the wrong reason.
 */
async function waitUntilBlockedBy(waiterPid: number, holderPid: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCK_WAIT_MS;
  for (;;) {
    const rows = await probe.client<
      { blockers: number[] }[]
    >`select pg_blocking_pids(${waiterPid}) as blockers`;
    if ((rows[0]?.blockers ?? []).includes(holderPid)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${what}: backend ${String(waiterPid)} was never blocked by ${String(holderPid)} ` +
          `within ${String(BLOCK_WAIT_MS)}ms, so this case measured a sequential run`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
  }
}

/**
 * Hold `FOR UPDATE` on one row until the returned `release` is awaited.
 *
 * An open transaction on a backend of its own, parked on a latch — which is what
 * lets a case decide where the teardown stops instead of leaving it to the
 * scheduler.
 */
async function holdRowLock(
  table: typeof canonicalProducts | typeof canonicalVariants,
  id: string,
): Promise<{ release: () => Promise<void> }> {
  let open: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  let acquired: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });

  const running = holder.db.transaction(async (tx) => {
    await tx.select({ id: table.id }).from(table).where(eq(table.id, id)).for('update');
    acquired();
    await held;
  });
  await locked;

  return {
    release: async () => {
      open();
      await running;
    },
  };
}

beforeAll(async () => {
  db = await connectPostgres();
  tearer = await openSolo();
  otherTearer = await openSolo();
  holder = await openSolo();
  sibling = await openSolo();
  probe = await openSolo();

  // A DRAFT policy version: the decision's foreign key needs a row to point at,
  // and `match_policy_versions_active_key` is a partial unique over `active`
  // only — so a draft contends with nobody. See the header.
  const { insertMatchPolicyVersion } = await import('../matching/matchPolicyRepository.js');
  const policy = await insertMatchPolicyVersion(db, {
    versionKey: `teardown-gate-${RUN}`,
    status: 'draft',
    description: 'realdb fixture for the canonical teardown gate',
    autoMinConfidence: 0.9,
    reviewMinConfidence: 0.55,
    minCandidateSeparation: 0.05,
    maxCandidates: 25,
    minTitleSimilarity: 0.2,
    weightIdentifier: 6,
    weightBrand: 3,
    weightModel: 2,
    weightAttribute: 4,
    weightTitle: 1,
    weightCategory: 2,
    weightSemantic: 0,
    semanticEnabled: false,
    minBenchmarkPrecision: 0.98,
    minBenchmarkSamples: 20,
    createdByOxyUserId: `operator-${RUN}`,
  });
  policyVersionId = policy.id;

  // `match_decisions_subject_shape_check` admits exactly two subject shapes and
  // both need a real foreign key. A NATIVE VARIANT is the cheaper of the two — a
  // source record would need a catalog source and an observation as well — so one
  // listing with a pool of variants backs every decision below.
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `teardown-gate-seller-${RUN}`,
      title: `Teardown gate listing ${RUN}`,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('the fixture listing was not created');
  createdListingIds.push(listing.id);

  const { insertVariants } = await import('../catalog/variantRepository.js');
  const variants = await insertVariants(
    listing.id,
    Array.from({ length: 12 }, (_unused, index) => ({
      title: `Subject ${String(index)}`,
      priceAmount: 1_000,
      priceCurrency: 'EUR' as const,
      inventoryTracked: false,
      inventoryAvailable: 0,
      position: index,
      optionValues: [],
    })),
  );
  for (const variant of variants) nativeVariantIds.push(variant.id);
}, 120_000);

afterAll(async () => {
  // The extra backends first: one still holding a row lock would block the
  // teardown below rather than reporting anything.
  for (const solo of soloConnections) await solo.client.end({ timeout: 5 });

  if (createdDecisionIds.length > 0) {
    await db.delete(matchDecisions).where(inArray(matchDecisions.id, createdDecisionIds));
  }
  // Through the HELPER, like every other fixture. This file is a victim of the
  // cross-file pin it exists to reproduce: it deletes only the decisions it owns,
  // so a sibling matcher's decision citing one of these products is exactly the
  // `23503` that used to fail this file's own teardown.
  await deleteTestCanonicalRows(db, { productIds: createdProductIds });
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  // The policy version is deliberately LEFT BEHIND. `mercaria_match_policy_immutable`
  // refuses a DELETE outright ("Supersede it instead"), which is right: a stored
  // confidence whose policy is gone is a number nobody can reproduce. A `draft`
  // row contends with nothing — `match_policy_versions_active_key` is a partial
  // unique over `active` — so leaving it costs one row in a database that is
  // dropped at the end of the run. Retaining rather than forcing is the same
  // posture as the plan this file gates.
  await closePostgres();
});

/** One canonical product with one variant, both owned by this file. */
interface SeededFixture {
  readonly productId: string;
  readonly variantId: string;
}

async function seedProductWithVariant(label: string): Promise<SeededFixture> {
  const name = `Teardown gate ${label} ${RUN}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name,
      slug: `teardown-gate-${label}-${RUN}`,
      normalizedName: normalizeEntityName(name),
      status: 'active',
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the fixture product was not created');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      name: label,
      // `canonical_variants_signature_shape_check` demands a sha-256 hex digest:
      // a signature this codebase did not produce would silently weaken the
      // uniqueness built over it.
      signature: createHash('sha256').update(`teardown-gate-${label}-${RUN}`).digest('hex'),
      status: 'active',
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('the fixture variant was not created');
  return { productId: product.id, variantId: variant.id };
}

/**
 * Two fixtures of this file's own, labelled by the order the LOCK reaches them.
 *
 * The helper's lock statements order by `id`, and `@oxyhq/db`'s uuid v7 is not
 * monotonic within a millisecond — measured at roughly 50% inversion — so which
 * of two rows minted a moment apart sorts first is not knowable from the order
 * they were created in. Every barrier below needs "the one the teardown reaches
 * first" and "the one it reaches second", so they are DERIVED from the ids
 * rather than assumed from the insert order.
 */
async function seedPair(
  label: string,
  orderedBy: 'product' | 'variant',
): Promise<{ first: SeededFixture; second: SeededFixture }> {
  const a = await seedProductWithVariant(`${label}-a`);
  const b = await seedProductWithVariant(`${label}-b`);
  const key = (fixture: SeededFixture): string =>
    orderedBy === 'product' ? fixture.productId : fixture.variantId;
  return key(a) < key(b) ? { first: a, second: b } : { first: b, second: a };
}

/**
 * The next unused native variant a decision may hang off.
 *
 * `match_decisions_evaluation_key` is UNIQUE over `('var:' || product_variant_id,
 * policy_version_id)`, so reusing one would silently UPDATE the earlier decision
 * — moving which canonical row it cites instead of adding a second citation, and
 * quietly making an earlier case measure nothing.
 */
let nextSubject = 0;
function takeSubjectVariantId(): string {
  const id = nativeVariantIds[nextSubject];
  nextSubject += 1;
  if (id === undefined) throw new Error('the fixture ran out of native variants for decisions');
  return id;
}

/**
 * Record a decision CITING a canonical row, exactly as an automatic match does,
 * through the matcher's own repository.
 *
 * The handle is a parameter because the barrier cases need this insert on a
 * backend of their own — the one whose wait they assert.
 */
async function citeCanonical(
  handle: Database,
  input: { productId: string; variantId: string | null },
): Promise<void> {
  if (policyVersionId === null) throw new Error('the fixture policy version is missing');
  const { upsertMatchDecision } = await import('../matching/matchDecisionRepository.js');
  const decision = await upsertMatchDecision(handle, {
    subjectKind: 'native_variant',
    subjectKey: `teardown-gate-subject-${RUN}-${uuidv7()}`,
    sourceRecordId: null,
    productVariantId: takeSubjectVariantId(),
    policyVersionId,
    outcome: 'automatic_match',
    decidedStage: 'global_identifier',
    confidence: null,
    matchedCanonicalProductId: input.productId,
    matchedCanonicalVariantId: input.variantId,
    reasonCodes: [],
    blockers: [],
    positiveIdentifiers: [],
    conflictingIdentifiers: [],
    normalizedBrand: null,
    normalizedModel: null,
    normalizedTitle: `teardown gate ${RUN}`,
    categoryKey: null,
    candidates: [],
    now: new Date(),
  });
  createdDecisionIds.push(decision.id);
}

/** Which of these ids still exist, so "deleted nothing" and "deleted everything" are both visible. */
async function survivingProductIds(ids: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: canonicalProducts.id })
    .from(canonicalProducts)
    .where(inArray(canonicalProducts.id, [...ids]));
  return rows.map((row) => row.id).sort();
}

async function survivingVariantIds(ids: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: canonicalVariants.id })
    .from(canonicalVariants)
    .where(inArray(canonicalVariants.id, [...ids]));
  return rows.map((row) => row.id).sort();
}

describe('a sibling match decision pinning a canonical fixture', () => {
  it('refuses the owner’s own delete, and the teardown declines exactly that id', async () => {
    const cited = await seedProductWithVariant('cited');
    const free = await seedProductWithVariant('free');
    await citeCanonical(db, cited);

    // The vacuity guard: with no citing decision the bare delete SUCCEEDS and
    // every assertion below would be measuring nothing. This is the deliberate
    // bare statement `canonical-fixture-census.test.ts` permits this file — it
    // is the SUBJECT of the assertion and is not a teardown.
    let refused: unknown = null;
    try {
      await db.delete(canonicalVariants).where(eq(canonicalVariants.id, cited.variantId));
    } catch (error: unknown) {
      refused = error;
    }
    expect(refused, 'an uncited variant would make this whole case vacuous').not.toBeNull();
    // The NAME, not merely "it threw" — any other rule this row happens to
    // violate would satisfy a bare truthiness check and prove something else.
    expect(constraintNameOf(refused)).toBe(
      'match_decisions_matched_canonical_variant_id_canonical_variants',
    );

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [cited.variantId, free.variantId],
      productIds: [cited.productId, free.productId],
    });

    // The retention half.
    expect(plan.retainedVariantIds).toEqual([cited.variantId]);
    // A retained VARIANT pins its parent too — `canonical_variants.product_id`
    // would refuse the parent delete, and finding that out as a second 23503
    // leaves the teardown half done.
    expect(plan.retainedProductIds).toEqual([cited.productId]);

    // The FLOOR, and it is the assertion that matters: a rule that degenerated
    // to "retain everything" — a teardown that silently stopped cleaning up —
    // reads exactly like a correct one unless the UNCITED id is asserted
    // deletable.
    expect(plan.deletableVariantIds).toEqual([free.variantId]);
    expect(plan.deletableProductIds).toEqual([free.productId]);

    // …and the narrowed deletes really proceeded, on both tables.
    expect(await survivingVariantIds([cited.variantId, free.variantId])).toEqual([cited.variantId]);
    expect(await survivingProductIds([cited.productId, free.productId])).toEqual([cited.productId]);
  });

  it('declines nothing when no decision cites the fixture', async () => {
    const untouched = await seedProductWithVariant('untouched');

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [untouched.variantId],
      productIds: [untouched.productId],
    });

    expect(plan.retainedVariantIds).toEqual([]);
    expect(plan.retainedProductIds).toEqual([]);
    expect(plan.deletableVariantIds).toEqual([untouched.variantId]);
    expect(plan.deletableProductIds).toEqual([untouched.productId]);
    expect(await survivingProductIds([untouched.productId])).toEqual([]);
  });

  it('reads a decision citing only the PRODUCT as pinning the product alone', async () => {
    // `matched_canonical_product_id` is its own RESTRICT column, and an
    // `automatic_match` may name a product without a variant — so the product
    // half is not merely a consequence of the variant half.
    const product = await seedProductWithVariant('product-only');
    await citeCanonical(db, { productId: product.productId, variantId: null });

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [product.variantId],
      productIds: [product.productId],
    });

    expect(plan.retainedProductIds).toEqual([product.productId]);
    // The VARIANT is not cited, so it goes — the teardown declines the narrowest
    // thing that is actually pinned.
    expect(plan.deletableVariantIds).toEqual([product.variantId]);
    expect(await survivingVariantIds([product.variantId])).toEqual([]);
    expect(await survivingProductIds([product.productId])).toEqual([product.productId]);
  });
});

/**
 * The function every fixture now calls — the lock, the plan and the two
 * statements, in one transaction.
 *
 * The partition itself is decided by the cases above. What is left, and what
 * twenty-four teardowns depend on, is that the deletes it issues really happen,
 * really stop at the pinned rows, and really run in the one order
 * `canonical_variants.product_id` (RESTRICT) permits.
 */
describe('deleteTestCanonicalRows', () => {
  it('deletes the uncited rows and leaves exactly the pinned ones', async () => {
    const pinned = await seedProductWithVariant('helper-pinned');
    const free = await seedProductWithVariant('helper-free');
    await citeCanonical(db, pinned);

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [pinned.variantId, free.variantId],
      productIds: [pinned.productId, free.productId],
    });

    expect(plan.retainedVariantIds).toEqual([pinned.variantId]);
    expect(plan.retainedProductIds).toEqual([pinned.productId]);

    // Both halves, because "it deleted nothing" and "it deleted everything" are
    // the two ways this can be wrong and each satisfies one assertion alone.
    expect(await survivingVariantIds([pinned.variantId, free.variantId])).toEqual([
      pinned.variantId,
    ]);
    expect(await survivingProductIds([pinned.productId, free.productId])).toEqual([
      pinned.productId,
    ]);
  });

  it('discovers a variant the caller never recorded', async () => {
    // Several fixtures mint a product through a repository that creates its
    // default variant, so the file knows the product id and never sees the
    // variant's. Passing product ids alone must still clear the children —
    // `canonical_variants.product_id` is RESTRICT, so a missed child is a
    // `23503` on the parent rather than a leftover row.
    const orphaned = await seedProductWithVariant('helper-discovered');

    const plan = await deleteTestCanonicalRows(db, { productIds: [orphaned.productId] });

    expect(plan.deletableVariantIds).toEqual([orphaned.variantId]);
    expect(plan.deletableProductIds).toEqual([orphaned.productId]);

    const survivors = await db
      .select({ id: canonicalVariants.id })
      .from(canonicalVariants)
      .where(eq(canonicalVariants.productId, orphaned.productId));
    expect(survivors).toEqual([]);
  });

  it('retains a merge WINNER whose loser a sibling pinned', async () => {
    // `canonical_products.merged_into_id` is a self-referencing ON DELETE
    // RESTRICT. Measured against this server: deleting winner and loser in ONE
    // statement succeeds, and deleting the winner ALONE with the loser present
    // raises 23503 on `..._merged_into_id_fkey`. So a partition that retains the
    // loser and frees the winner produces exactly that refusal — which is what
    // this helper would do if it read `match_decisions` and nothing else.
    const winner = await seedProductWithVariant('merge-winner');
    const loser = await seedProductWithVariant('merge-loser');
    await db
      .update(canonicalProducts)
      .set({ status: 'merged', mergedIntoId: winner.productId })
      .where(eq(canonicalProducts.id, loser.productId));
    // A SIBLING cites the loser — an ordinary active row until the merge ran.
    await citeCanonical(db, loser);

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [winner.variantId, loser.variantId],
      productIds: [winner.productId, loser.productId],
    });

    // Both, and the winner only because the loser points at it.
    expect([...plan.retainedProductIds].sort()).toEqual([winner.productId, loser.productId].sort());
    expect(await survivingProductIds([winner.productId, loser.productId])).toHaveLength(2);
  });

  it('retains a merge winner one variant hop away', async () => {
    // The same rule on `canonical_variants.merged_into_id`, and it has to run
    // BEFORE the parent-pinning step: the winner variant's product is only
    // reachable once the winner variant itself is retained.
    const winner = await seedProductWithVariant('merge-variant-winner');
    const loser = await seedProductWithVariant('merge-variant-loser');
    await db
      .update(canonicalVariants)
      .set({ status: 'merged', mergedIntoId: winner.variantId })
      .where(eq(canonicalVariants.id, loser.variantId));
    await citeCanonical(db, loser);

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [winner.variantId, loser.variantId],
      productIds: [winner.productId, loser.productId],
    });

    expect([...plan.retainedVariantIds].sort()).toEqual([winner.variantId, loser.variantId].sort());
    // …and the winner variant's PARENT with it, or the product delete meets a
    // child it cannot remove.
    expect([...plan.retainedProductIds].sort()).toEqual([winner.productId, loser.productId].sort());
  });

  it('does nothing, and issues nothing, for an empty teardown', async () => {
    // Every caller is a hook that may run before its fixtures exist. An empty
    // input has to be a no-op rather than an `inArray(col, [])`, which drizzle
    // renders as the literal `false` — correct, and a round trip per hook.
    const plan = await deleteTestCanonicalRows(db, { productIds: [], variantIds: [] });
    expect(plan).toEqual({
      deletableVariantIds: [],
      deletableProductIds: [],
      retainedVariantIds: [],
      retainedProductIds: [],
    });
  });
});

/**
 * The window between deciding and deleting, driven rather than waited for.
 *
 * Each case parks the teardown at a chosen point with a held row lock, does the
 * thing a sibling would do, and asserts BOTH the wait it must produce and the
 * outcome. Without the transaction and the locks every one of these is the old
 * `23503`, in this file rather than in whichever fixture happened to lose.
 */
describe('the plan/delete window', () => {
  it('retains a decision committed while the teardown is still waiting for its FIRST lock', async () => {
    const { first, second } = await seedPair('window-before', 'product');

    // Holding the row the teardown reaches FIRST parks it having locked nothing,
    // which is the only state in which a sibling can still commit.
    const hold = await holdRowLock(canonicalProducts, first.productId);
    const teardown = deleteTestCanonicalRows(tearer.db, {
      productIds: [first.productId, second.productId],
    });
    await waitUntilBlockedBy(tearer.pid, holder.pid, 'the teardown never reached its product lock');

    // The sibling's decision COMMITS here — inside the teardown's transaction,
    // before it has locked or read anything.
    await citeCanonical(sibling.db, second);

    await hold.release();
    const plan = await teardown;

    // Seen, and declined. A plan that had read `match_decisions` before this
    // point would have missed it and the delete would have raised 23503.
    expect(plan.retainedProductIds).toEqual([second.productId]);
    expect(plan.retainedVariantIds).toEqual([second.variantId]);
    expect(plan.deletableProductIds).toEqual([first.productId]);
    expect(await survivingProductIds([first.productId, second.productId])).toEqual([
      second.productId,
    ]);
  });

  it('makes a VARIANT decision attempted after the lock wait, then fail on its own foreign key', async () => {
    const { first, second } = await seedPair('window-variant', 'variant');

    // Holding the row the teardown reaches SECOND parks it HOLDING the first —
    // which is the state a sibling must not be able to write against.
    const hold = await holdRowLock(canonicalVariants, second.variantId);
    const teardown = deleteTestCanonicalRows(tearer.db, {
      variantIds: [first.variantId, second.variantId],
    });
    await waitUntilBlockedBy(tearer.pid, holder.pid, 'the teardown never reached its variant lock');

    // `FOR KEY SHARE` on the cited variant conflicts with the teardown's
    // `FOR UPDATE`, so this insert waits rather than committing.
    const attempted = citeCanonical(sibling.db, first).then(
      () => 'committed' as const,
      (error: unknown) => error,
    );
    await waitUntilBlockedBy(
      sibling.pid,
      tearer.pid,
      'the sibling insert was never blocked by the teardown, so nothing was locked',
    );

    await hold.release();
    const plan = await teardown;
    expect(plan.retainedVariantIds).toEqual([]);
    expect([...plan.deletableVariantIds].sort()).toEqual(
      [first.variantId, second.variantId].sort(),
    );
    expect(await survivingVariantIds([first.variantId, second.variantId])).toEqual([]);

    const outcome = await attempted;
    expect(outcome, 'the sibling insert committed against a row the teardown deleted').not.toBe(
      'committed',
    );
    expect(constraintNameOf(outcome)).toBe(
      'match_decisions_matched_canonical_variant_id_canonical_variants',
    );
  });

  it('makes a PRODUCT-only decision attempted after the lock wait, then fail on its own foreign key', async () => {
    const { first, second } = await seedPair('window-product', 'product');

    const hold = await holdRowLock(canonicalProducts, second.productId);
    const teardown = deleteTestCanonicalRows(tearer.db, {
      productIds: [first.productId, second.productId],
    });
    await waitUntilBlockedBy(tearer.pid, holder.pid, 'the teardown never reached its product lock');

    // A decision naming the PRODUCT and no variant — `matched_canonical_product_id`
    // is its own RESTRICT column, so this is a second edge and not a consequence
    // of the variant one.
    const attempted = citeCanonical(sibling.db, {
      productId: first.productId,
      variantId: null,
    }).then(
      () => 'committed' as const,
      (error: unknown) => error,
    );
    await waitUntilBlockedBy(
      sibling.pid,
      tearer.pid,
      'the sibling insert was never blocked by the teardown, so nothing was locked',
    );

    await hold.release();
    const plan = await teardown;
    expect(plan.retainedProductIds).toEqual([]);
    expect(await survivingProductIds([first.productId, second.productId])).toEqual([]);

    const outcome = await attempted;
    expect(outcome, 'the sibling insert committed against a row the teardown deleted').not.toBe(
      'committed',
    );
    expect(constraintNameOf(outcome)).toBe(
      'match_decisions_matched_canonical_product_id_canonical_products',
    );
  });

  it('lets two overlapping teardowns given the ids in OPPOSITE orders both complete', async () => {
    const { first, second } = await seedPair('window-deadlock', 'product');

    // The hold is on the row the ORDERED lock reaches first, which is what makes
    // this case decisive rather than merely concurrent. Both teardowns are
    // parked on it, and what they are holding while parked is the whole
    // question: the shipped helper holds NOTHING (its one statement blocks on
    // its first row), while a helper that walked the caller's array would have
    // let the second call take `second` — its own first id — before parking.
    // Releasing then completes both here, and cross-locks them there.
    const hold = await holdRowLock(canonicalProducts, first.productId);

    const one = deleteTestCanonicalRows(tearer.db, {
      productIds: [first.productId, second.productId],
    });
    await waitUntilBlockedBy(tearer.pid, holder.pid, 'the first teardown never took its lock');

    const two = deleteTestCanonicalRows(otherTearer.db, {
      productIds: [second.productId, first.productId],
    });
    // Blocked by the FIRST TEARDOWN, not by the holder: a second waiter for a
    // row queues on the tuple lock the first waiter already took, so `pg_locks`
    // names T1 and never the session actually sitting on the row. Measured here
    // — asking for the holder times out on correct code.
    await waitUntilBlockedBy(
      otherTearer.pid,
      tearer.pid,
      'the second teardown never reached the held row, so the two never overlapped',
    );

    await hold.release();
    // Neither may raise. A cross-lock surfaces here as `40P01 deadlock detected`
    // on whichever call Postgres chose to abort, so this `await` IS the
    // assertion — an ordering that came from the caller cannot get past it.
    const [planOne, planTwo] = await Promise.all([one, two]);

    // The first call owned every row; the second found them gone and declined
    // nothing, which is what a teardown of an already-empty set looks like.
    expect([...planOne.deletableProductIds].sort()).toEqual(
      [first.productId, second.productId].sort(),
    );
    expect(planTwo.retainedProductIds).toEqual([]);
    expect(await survivingProductIds([first.productId, second.productId])).toEqual([]);
  });
});
