/**
 * The split JOB — undoing a merge, or dividing an entity that was always two
 * things (#59 split invariants 1–5).
 *
 * ## `revive_tombstone` is what makes acceptance 2 work
 *
 * "A mistaken merge can be split without losing source mappings or price
 * history." Every source mapping that pointed at the losing entity, and every
 * price observation recorded against its offers, is keyed on that entity's ID.
 * Minting a fresh row and moving children onto it satisfies the WORD "split" and
 * destroys exactly what the criterion protects — the old id, its slug and its
 * URL would all be dead, and every external reference to them would 404.
 *
 * So a split may name an existing TOMBSTONE and bring it back: `merged_into_id`
 * is cleared, the status returns to active, and the identity that was ended
 * exists again as itself. The redirect HISTORY rows are not deleted — they are
 * the record that the hop happened, and `merged_into_id` is what resolves.
 *
 * ## Split invariant 4, and why no redirect is minted
 *
 * "Old URLs do not silently resolve to the wrong new entity." The ORIGINAL
 * entity keeps its slug and its URL, and it is still correct for everything that
 * stayed. A new entity gets a NEW slug, which nothing has ever linked to. So the
 * invariant is satisfied by minting no redirect at all, rather than by minting a
 * careful one — there is no old URL whose answer changes.
 *
 * ## Split invariant 3, and the `saves` phase that answers it
 *
 * "Saved products and alerts receive a deterministic migration or an explicit
 * user-visible ambiguity state." #80 landed the product-save table the census
 * was waiting for, and the answer is the SECOND half of that sentence: a split
 * divides one identity into two and nothing in the data says which of them a
 * person meant, so `runSavesPhase` marks every save of the source
 * `ambiguous_after_split` and names the job — which is what makes both
 * candidates recoverable — and the buyer resolves it.
 *
 * Deterministic migration was considered and refused. "Keep the save where it
 * is" would be deterministic and would silently be wrong for exactly the buyers
 * whose interest moved to the new entity, with no signal anywhere that a
 * decision had been made on their behalf; that is the "selecting a child
 * silently" #80 migration rule 8 forbids, and moving them all is the same
 * mistake pointed the other way.
 *
 * Listing FAVORITES are untouched, and that is unchanged: a canonical split
 * never writes `listings` (the plan contains no column of it, and
 * `curation-isolation.test.ts` fails the build if one appears), so an exact
 * listing save means what it meant before whatever happened upstream.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  CATALOG_SPLIT_ITEM_TYPES_BY_ENTITY,
  nextSplitPhase,
  requiresSecondApproval,
  type CatalogImpactEstimate,
  type CatalogSplitItemType,
  type CatalogSplitPhase,
  type CatalogSplitTargetMode,
  type SplittableEntityType,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  advanceSplitPhase,
  approveSplitJob,
  blockSplitJob,
  completeSplitJob,
  findSplitJobById,
  insertSplitAssignment,
  insertSplitJob,
  listBlockedSplitJobs,
  listPendingSplitAssignments,
  markAssignmentApplied,
  markAssignmentSkipped,
  summarizeSplitAssignments,
  unblockSplitJob,
} from '../../db/curation/jobRepository.js';
import { log } from '../../lib/logger.js';
import { reassignRowById } from '../../db/curation/rehomeRepository.js';
import { markProductSavesAmbiguousAfterSplit } from '../../db/productSaves/productSaveRepository.js';
import { markPriceAlertsAmbiguousAfterSplit } from '../../db/priceAlerts/priceAlertRepository.js';
import { markWatchlistItemsAmbiguousAfterSplit } from '../../db/watchlists/watchlistItemRepository.js';
import { markShoppingAgentsAmbiguousAfterSplit } from '../../db/shoppingAgents/shoppingAgentRepository.js';
import type { CatalogSplitJobRow } from '../../db/schema/curation.js';
import {
  canonicalAttributeValues,
  canonicalImages,
  canonicalProductAliases,
  canonicalProducts,
  canonicalProductSourceLinks,
  canonicalVariantAliases,
  canonicalVariants,
  canonicalVariantSourceLinks,
  productIdentifiers,
} from '../../db/schema/canonicalCatalog.js';
import { nativeListingLinks, offers } from '../../db/schema/offers.js';
import { normalizeEntityName } from '../canonical/normalization.js';
import { splitImpactFromAssignments, impactColumnValues } from './impact.js';
import { CURATED_ENTITIES } from './entity-registry.js';
import { rebuildEntityRollups } from './rollups.js';
import { recordRevision } from './revision.js';

/**
 * Which column each assignable item type lives in, per splittable entity.
 *
 * A real drizzle column, so a rename is a `tsc` error rather than a reassignment
 * that finds nothing — and a TABLE rather than a `switch`, so
 * `CATALOG_SPLIT_ITEM_TYPES_BY_ENTITY` (the contract clients validate against)
 * and this (what actually moves) are checkably the same set. The isolation test
 * asserts exactly that.
 */
export const SPLIT_ITEM_COLUMNS: Readonly<
  Record<SplittableEntityType, Partial<Record<CatalogSplitItemType, AnyPgColumn>>>
> = {
  canonical_product: {
    canonical_variant: canonicalVariants.productId,
    product_identifier: productIdentifiers.productId,
    source_link: canonicalProductSourceLinks.productId,
    alias: canonicalProductAliases.productId,
    attribute_value: canonicalAttributeValues.productId,
    image: canonicalImages.productId,
  },
  canonical_variant: {
    product_identifier: productIdentifiers.variantId,
    source_link: canonicalVariantSourceLinks.variantId,
    offer: offers.canonicalVariantId,
    native_listing_link: nativeListingLinks.canonicalVariantId,
    alias: canonicalVariantAliases.variantId,
    attribute_value: canonicalAttributeValues.variantId,
    image: canonicalImages.variantId,
  },
};

export interface RequestSplitInput {
  readonly entityType: SplittableEntityType;
  readonly sourceEntityId: string;
  readonly targetMode: CatalogSplitTargetMode;
  readonly targetEntityId?: string | null;
  readonly targetSlug?: string | null;
  readonly targetName?: string | null;
  readonly reason: string;
  readonly actorOxyUserId: string;
  readonly reversesMergeJobId?: string | null;
  readonly reviewItemId?: string | null;
  readonly items: readonly { readonly itemType: CatalogSplitItemType; readonly itemRef: string }[];
}

/** The impact buckets an item type contributes to — the four-eyes threshold's input. */
function impactBucketForItem(itemType: CatalogSplitItemType): keyof CatalogImpactEstimate {
  switch (itemType) {
    case 'canonical_variant':
      return 'childEntities';
    case 'product_identifier':
      return 'identifiers';
    case 'source_link':
      return 'sourceLinks';
    case 'offer':
      return 'offers';
    case 'native_listing_link':
      return 'nativeListingLinks';
    case 'alias':
      return 'aliases';
    case 'attribute_value':
      return 'attributeValues';
    case 'image':
      return 'images';
  }
}

/**
 * Open a split job and record its assignment list.
 *
 * The list is written INSIDE the creating transaction and the job is still in
 * `plan`, which is the only window the trigger admits an assignment in — so the
 * set an operator approved with an impact estimate beside it is exactly the set
 * that executes (#59 split invariant 1).
 */
export async function requestSplit(input: RequestSplitInput): Promise<CatalogSplitJobRow> {
  if (input.items.length === 0) {
    throw validationError(
      'A split must name what moves; an empty assignment list would produce a new entity with ' +
        'nothing in it and leave the original unchanged.',
    );
  }
  const allowed = CATALOG_SPLIT_ITEM_TYPES_BY_ENTITY[input.entityType];
  for (const item of input.items) {
    if (!allowed.includes(item.itemType)) {
      throw validationError(
        `A ${input.entityType} split cannot reassign a ${item.itemType}; that row does not hang ` +
          'off this grain.',
      );
    }
  }
  if (input.targetMode === 'new_entity' && input.entityType !== 'canonical_product') {
    throw validationError(
      "Only a canonical product may be split into a NEW entity: a variant's identity is its " +
        'option assignments, and minting one would mean inventing them. Revive the tombstone the ' +
        'merge created instead.',
    );
  }

  const db = getDb();
  const definition = CURATED_ENTITIES[input.entityType];
  const source = await db
    .select({ status: sql<string>`${definition.statusColumn}` })
    .from(definition.table)
    .where(eq(definition.idColumn, input.sourceEntityId))
    .limit(1);
  if (!source[0]) throw notFound(`No ${input.entityType} with id ${input.sourceEntityId}.`);

  if (input.targetMode === 'revive_tombstone') {
    if (!input.targetEntityId) {
      throw validationError('A tombstone revival must name the tombstone it brings back.');
    }
    const tombstone = await db
      .select({
        status: sql<string>`${definition.statusColumn}`,
        mergedIntoId: sql<string | null>`${definition.mergedIntoColumn}`,
      })
      .from(definition.table)
      .where(eq(definition.idColumn, input.targetEntityId))
      .limit(1);
    const row = tombstone[0];
    if (!row) throw notFound(`No ${input.entityType} with id ${input.targetEntityId}.`);
    if (row.status !== 'merged') {
      throw conflict(
        `${input.entityType} ${input.targetEntityId} is not a tombstone (it is ${row.status}); ` +
          'reviving a live entity would give one identity two homes.',
      );
    }
    if (row.mergedIntoId !== input.sourceEntityId) {
      throw conflict(
        `${input.entityType} ${input.targetEntityId} points at ${row.mergedIntoId ?? 'nothing'}, ` +
          `not at ${input.sourceEntityId}; reviving it here would strand its own children.`,
      );
    }
  }

  const counts: Partial<Record<keyof CatalogImpactEstimate, number>> = {};
  for (const item of input.items) {
    const bucket = impactBucketForItem(item.itemType);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  const impact = splitImpactFromAssignments(counts);
  const needsApproval = requiresSecondApproval(
    'split',
    impact.totalMoving,
    config.catalog.fourEyesRequired,
  );

  return db.transaction(async (tx) => {
    const job = await insertSplitJob(
      {
        entityType: input.entityType,
        sourceEntityId: input.sourceEntityId,
        targetMode: input.targetMode,
        targetEntityId: input.targetMode === 'revive_tombstone' ? (input.targetEntityId ?? null) : null,
        targetSlug: input.targetMode === 'new_entity' ? (input.targetSlug ?? null) : null,
        targetName: input.targetMode === 'new_entity' ? (input.targetName ?? null) : null,
        reason: input.reason,
        requestedByOxyUserId: input.actorOxyUserId,
        requiresSecondApproval: needsApproval,
        reversesMergeJobId: input.reversesMergeJobId ?? null,
        reviewItemId: input.reviewItemId ?? null,
        impact: impactColumnValues(impact),
      },
      tx,
    );
    for (const item of input.items) {
      await insertSplitAssignment(job.id, item.itemType, item.itemRef, tx);
    }
    await recordRevision(
      {
        entityType: input.entityType,
        entityId: input.sourceEntityId,
        action: 'split',
        actorKind: 'operator',
        actorOxyUserId: input.actorOxyUserId,
        reason: input.reason,
        note: `split requested (${input.targetMode})`,
        splitJobId: job.id,
        reviewItemId: input.reviewItemId ?? null,
        after: { targetMode: input.targetMode, items: input.items.length, impact },
      },
      tx,
    );
    return job;
  });
}

/** Record the second operator's approval. Same rule as a merge's. */
export async function approveSplit(
  jobId: string,
  approverOxyUserId: string,
  reason: string,
): Promise<CatalogSplitJobRow> {
  const db = getDb();
  const job = await findSplitJobById(jobId, db);
  if (!job) throw notFound(`No split job ${jobId}.`);
  if (job.requestedByOxyUserId === approverOxyUserId) {
    throw validationError(
      'A split cannot be approved by the operator who requested it; four eyes means two people.',
    );
  }
  const approved = await approveSplitJob(jobId, approverOxyUserId, db);
  if (!approved) throw conflict(`Split job ${jobId} already carries an approval.`);
  /**
   * Evaluate the gate EAGERLY, so the approval restarts the job now rather than
   * whenever the sweep next runs.
   *
   * `resolveMergeConflict` does the same and for the same reason: the sweep is
   * the guarantee, this is the latency. It asks the predicate rather than
   * assuming the approval was the last thing outstanding — a second opinion is
   * exactly what #663 showed cannot be allowed to exist.
   */
  if (approved.status === 'blocked' && splitJobBlockingState(approved).state === 'clear') {
    await unblockSplitJob(approved.id, db);
  }
  await recordRevision(
    {
      entityType: job.entityType,
      entityId: job.sourceEntityId,
      action: 'split',
      actorKind: 'operator',
      actorOxyUserId: approverOxyUserId,
      reason,
      note: 'second approval recorded',
      splitJobId: jobId,
    },
    db,
  );
  return approved;
}

/**
 * Why a split job cannot proceed right now — or that it can (#679).
 *
 * ## This is the ONE spelling of the `plan` gate
 *
 * `blocked` is not claimable, deliberately: a dispatcher that retried a job
 * waiting on a person would spin against a judgement only a person can make.
 * Splits never reached that state at all. {@link runMintPhase} carried an
 * approval gate that was UNREACHABLE, because
 * `catalog_split_jobs_second_approval_check` permits an unapproved four-eyes
 * split at `phase = 'plan'` and nowhere else — so the `plan -> mint` advance
 * raised on the CHECK first, the dispatcher released the job to `pending`, and
 * it span until it dead-lettered FOR WAITING while never appearing in the
 * operator's blocked inbox.
 *
 * So the gate lives at `plan`, and its position is a property of the SCHEMA
 * rather than a convention: `plan` is the only phase the CHECK lets an
 * unapproved job occupy. {@link mergeJobBlockingState} sits at
 * `awaiting_resolution` for exactly the same reason, because the merge's own
 * CHECK permits that phase.
 *
 * ## Why this cannot resume a job whose precondition is unmet
 *
 * Because the thing that decides to resume is the same function that decided to
 * block — #663's reasoning verbatim. There is no second opinion available to be
 * wrong, which is what an operator "retry" button would have been. Resuming is
 * also not RUNNING: {@link resumeBlockedSplitJobs} flips a status and claims
 * nothing, so `blocked` stays non-claimable.
 *
 * ## It refuses to vouch for a phase it does not own
 *
 * Only `plan` blocks today. A phase added later that blocks for some other
 * reason must NOT be auto-resumed by a predicate that never heard of it, so an
 * unrecognised phase answers `blocked` naming itself. {@link SplitPhaseOutcome}
 * states the same thing to the compiler.
 */
export type SplitJobBlockingState =
  /** The `clear` branch carries no reason: there is none to read. */
  | { readonly state: 'clear' }
  | { readonly state: 'blocked'; readonly reason: string };

/**
 * PURE, and it takes no database handle — unlike `mergeJobBlockingState`.
 *
 * That asymmetry is a fact rather than an oversight. A merge blocks on things
 * that live on OTHER rows — unresolved conflicts, a child job's status — so its
 * predicate must read, and #584/#599's ruling then applies (the handle is
 * required, because a default lets a caller inside a transaction escape to the
 * root connection and see pre-commit state). Every condition that can park a
 * SPLIT today is on the job's own row, so there is nothing to read and no
 * handle to get wrong. Taking one and ignoring it would state a dependency this
 * function does not have.
 *
 * A future condition needing a read makes this async and adds the required
 * handle at all three call sites — a loud change, which is the right kind.
 */
export function splitJobBlockingState(job: CatalogSplitJobRow): SplitJobBlockingState {
  if (job.phase !== 'plan') {
    return {
      state: 'blocked',
      reason:
        `This job is parked at the '${job.phase}' phase, which nothing here knows how to clear. ` +
        'Only `plan` has a resume condition; a phase that blocks for another reason owes one ' +
        'before it can be resumed automatically.',
    };
  }

  if (job.requiresSecondApproval && !job.approvedByOxyUserId) {
    return {
      state: 'blocked',
      reason: `This split moves ${job.impactTotalMoving} rows and needs a second operator's approval.`,
    };
  }

  return { state: 'clear' };
}

/**
 * Every blocked split whose condition has since cleared, back to `pending`.
 *
 * Bounded and driven from `drainCurationJobs`, so a manual drain and the loop
 * resume the same jobs. It needs no lease: `unblockSplitJob`'s CAS makes a
 * second sweeper's pass a no-op, and the work it schedules is claimed under the
 * ordinary lease like any other pending job.
 */
export async function resumeBlockedSplitJobs(batchSize: number): Promise<number> {
  const db = getDb();
  let resumed = 0;
  for (const job of await listBlockedSplitJobs(batchSize, db)) {
    if (splitJobBlockingState(job).state === 'blocked') continue;
    if (await unblockSplitJob(job.id, db)) {
      resumed += 1;
      log.general.info(
        { jobId: job.id, phase: job.phase },
        '[Curation] split job resumed: its blocking condition has cleared',
      );
    }
  }
  return resumed;
}

/**
 * One phase's outcome.
 *
 * It carries NO `blockedReason`, and that omission is a gate — #663's
 * `PhaseOutcome` device, applied here. Blocking is only safe where
 * {@link splitJobBlockingState} can decide the job is safe to RESUME, and it
 * can decide that for `plan` alone. A phase runner declared to return this type
 * cannot return a blocking outcome (excess-property checking on the returned
 * literal refuses it), so a future phase that needs to block fails `tsc` until
 * somebody has taught the predicate how its condition clears.
 */
interface SplitPhaseOutcome {
  readonly rowsAffected: number;
  readonly targetEntityId: string | null;
}

/** The one phase that may block, because it is the one the predicate covers. */
interface SplitPlanPhaseOutcome extends SplitPhaseOutcome {
  readonly blockedReason?: string;
}

/**
 * `mint` — bring the destination into existence, exactly once.
 *
 * The revival is a CAS on "still a tombstone pointing at this source", so a
 * resumed phase revives nothing and a concurrent second split loses. Minting a
 * new product is `ON CONFLICT DO NOTHING` on the slug plus a read, for the same
 * reason: the slug is unique forever, so a retry converges on the row the first
 * attempt created rather than failing on it.
 */
async function runMintPhase(
  job: CatalogSplitJobRow,
  db: DatabaseOrTransaction,
): Promise<SplitPhaseOutcome> {
  /**
   * The approval gate used to be HERE, and it was unreachable (#679).
   *
   * `catalog_split_jobs_second_approval_check` permits an unapproved four-eyes
   * split at `phase = 'plan'` and NOWHERE ELSE, so the `plan -> mint` advance
   * raised on the CHECK one statement before this line ever ran. Measured: the
   * `update … set phase = 'mint'` fails naming that constraint, the job is left
   * `processing` at `plan`, the dispatcher catches it and releases to `pending`,
   * and the job spins until it dead-letters FOR WAITING.
   *
   * So the gate moved to the phase the schema actually permits an unapproved
   * job to occupy, and this is a CLEAN CUT rather than a second opinion left
   * behind. The merge's equivalent gate lives at `awaiting_resolution` because
   * `catalog_merge_jobs_second_approval_check` permits that phase; the two
   * differ because their CHECKs differ, not by convention.
   */
  const definition = CURATED_ENTITIES[job.entityType];

  if (job.targetMode === 'revive_tombstone') {
    const targetId = job.targetEntityId;
    if (!targetId) {
      throw new Error(`Split job ${job.id} is a revival with no tombstone to revive.`);
    }
    const revived = await db
      .update(definition.table)
      .set({ status: 'active', mergedIntoId: null })
      .where(
        and(
          eq(definition.idColumn, targetId),
          eq(definition.mergedIntoColumn, job.sourceEntityId),
        ),
      )
      .returning({ id: definition.idColumn });
    return { rowsAffected: revived.length, targetEntityId: targetId };
  }

  const slug = job.targetSlug;
  const name = job.targetName;
  if (!slug || !name) {
    throw new Error(`Split job ${job.id} mints a new entity with no slug or name.`);
  }
  const source = await db
    .select({
      brandId: canonicalProducts.brandId,
      familyId: canonicalProducts.familyId,
      categoryId: canonicalProducts.categoryId,
    })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, job.sourceEntityId))
    .limit(1);
  const parent = source[0];
  await db
    .insert(canonicalProducts)
    .values({
      slug,
      name,
      normalizedName: normalizeEntityName(name),
      brandId: parent?.brandId ?? null,
      familyId: parent?.familyId ?? null,
      categoryId: parent?.categoryId ?? null,
    })
    .onConflictDoNothing();
  const minted = await db
    .select({ id: canonicalProducts.id })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.slug, slug))
    .limit(1);
  const targetId = minted[0]?.id;
  if (!targetId) {
    throw new Error(`Split job ${job.id} could neither mint nor find the product for slug ${slug}.`);
  }
  return { rowsAffected: 1, targetEntityId: targetId };
}

/**
 * `assignments` — move exactly what was named, one row at a time.
 *
 * Per-row rather than per-table, because the whole point of a split is that only
 * SOME of a table's rows move. `reassignRowById` carries a CAS on the FROM
 * value, so a row already moved reports `false` and is recorded as applied
 * anyway — a replay converges instead of failing (#59 split invariant 5).
 *
 * An item whose row has vanished is recorded with `skipped_reason` rather than
 * silently dropped, so the `verify` phase's assigned-versus-applied count stays
 * meaningful and an operator can see what did not move.
 */
async function runAssignmentPhase(
  job: CatalogSplitJobRow,
  db: DatabaseOrTransaction,
): Promise<SplitPhaseOutcome> {
  const targetId = job.targetEntityId;
  if (!targetId) {
    throw new Error(`Split job ${job.id} reached the assignment phase with no destination.`);
  }
  const columns = SPLIT_ITEM_COLUMNS[job.entityType];
  const pending = await listPendingSplitAssignments(job.id, db);
  let moved = 0;
  for (const assignment of pending) {
    const column = columns[assignment.itemType];
    if (!column) {
      await markAssignmentSkipped(assignment.id, 'item_type_not_assignable_for_this_grain', db);
      continue;
    }
    const applied = await reassignRowById(
      column,
      assignment.itemRef,
      job.sourceEntityId,
      targetId,
      db,
    );
    if (applied) {
      await markAssignmentApplied(assignment.id, db);
      moved += 1;
    } else {
      // Either the row already moved (a replay) or it no longer points at the
      // source. Both are terminal for this assignment and both are recorded, so
      // "assigned but not applied" is never an unexplained residue.
      const stillThere = await db
        .select({ id: sql<string>`${column}` })
        .from(column.table)
        .where(sql`${column} = ${targetId}`)
        .limit(1);
      if (stillThere.length > 0) {
        await markAssignmentApplied(assignment.id, db);
        moved += 1;
      } else {
        await markAssignmentSkipped(assignment.id, 'item_missing_or_already_moved', db);
      }
    }
  }
  return { rowsAffected: moved, targetEntityId: targetId };
}

/**
 * `saves` — hand every affected product save AND watchlist entry back to its
 * owner (#80 migration rule 8, #81 correction rule 2, #59 split invariant 3).
 *
 * Only a canonical PRODUCT split marks anything. A variant split moves offers
 * and identifiers between two configurations of the SAME product: a save's
 * product is unchanged and its preferred variant, if it has one, still exists
 * under its own identity — so there is no question to ask, and asking one would
 * put an unanswerable prompt in front of every buyer for a change that did not
 * affect them.
 *
 * Idempotent by predicate rather than by a phase record: the marking only
 * touches `resolved` rows, so a resumed job re-runs it as a no-op AND a save
 * already made ambiguous by an EARLIER split keeps naming that earlier job.
 * Retargeting an unanswered question at a newer job would destroy the pair of
 * candidates the buyer was being asked about.
 */
async function runSavesPhase(
  job: CatalogSplitJobRow,
  db: DatabaseOrTransaction,
): Promise<SplitPhaseOutcome> {
  if (job.entityType !== 'canonical_product') {
    return { rowsAffected: 0, targetEntityId: job.targetEntityId };
  }
  // Two domains, one phase, and they are marked together on purpose: a split
  // asks ONE question ("which of these two did you mean") of everybody holding
  // the source product, and a buyer who saved it AND put it in a build list is
  // owed the same prompt on both. Splitting this into two phases would let a
  // resumed job answer one and not the other.
  const markedSaves = await markProductSavesAmbiguousAfterSplit(job.sourceEntityId, job.id, db);
  const markedItems = await markWatchlistItemsAmbiguousAfterSplit(
    job.sourceEntityId,
    job.id,
    db,
  );
  return { rowsAffected: markedSaves + markedItems, targetEntityId: job.targetEntityId };
}

/**
 * `alerts` — #79 evaluation 9, and the same refusal as `saves` with one thing
 * more.
 *
 * A split divides one identity into two and nothing in the data says which of
 * them a person meant, so every alert on the source is MARKED for the buyer to
 * resolve. What it adds beyond the saved-product case is a PAUSE: a save on the
 * wrong side of a split shows somebody the wrong page next time they look, and
 * an alert on the wrong side would go and tell them about a product they may
 * never have been watching.
 *
 * Idempotent by predicate, so a resumed job re-runs it as a no-op — and an alert
 * already made ambiguous by an EARLIER split keeps naming that earlier job,
 * because retargeting an unanswered question at a newer one destroys the pair of
 * candidates the buyer was being asked about.
 */
async function runAlertsPhase(
  job: CatalogSplitJobRow,
  db: DatabaseOrTransaction,
): Promise<SplitPhaseOutcome> {
  if (job.entityType !== 'canonical_product') {
    return { rowsAffected: 0, targetEntityId: job.targetEntityId };
  }
  const marked = await markPriceAlertsAmbiguousAfterSplit(
    {
      sourceCanonicalProductId: job.sourceEntityId,
      splitJobId: job.id,
      targetCanonicalProductId: job.targetEntityId,
    },
    db,
  );
  return { rowsAffected: marked, targetEntityId: job.targetEntityId };
}

/**
 * `agents` — #97, and the strongest form of the refusal `saves` and `alerts`
 * already make.
 *
 * A split divides one identity into two and nothing in the data says which of
 * them a person meant, so every agent watching the source is MARKED for the
 * shopper to resolve — and BLOCKED while it waits, which is what
 * `shopping_agents_ambiguity_blocked_check` makes unavoidable rather than
 * remembered.
 *
 * The escalation across the three phases is the whole argument for blocking
 * rather than leaving it live: a save on the wrong side of a split shows a
 * shopper the wrong page the next time they happen to look; an alert on the
 * wrong side notifies them ONCE about a product they may never have been
 * watching; and an AGENT on the wrong side goes on doing that, on its own
 * schedule, for as long as nobody looks. Only the last one keeps acting, so it
 * is the only one where waiting for an answer costs less than guessing.
 *
 * Only a canonical PRODUCT split marks anything, for `runSavesPhase`'s reason: a
 * variant split moves rows between two configurations of the SAME product, so an
 * agent's subject is unchanged and there is no question to ask.
 *
 * Idempotent by predicate rather than by a phase record: the marking only
 * touches `resolved` agents, so a resumed job re-runs it as a no-op AND an agent
 * already made ambiguous by an EARLIER split keeps naming that earlier job —
 * retargeting an unanswered question at a newer one destroys the pair of
 * candidates the shopper was being asked about.
 */
async function runAgentsPhase(
  job: CatalogSplitJobRow,
  db: DatabaseOrTransaction,
): Promise<SplitPhaseOutcome> {
  if (job.entityType !== 'canonical_product') {
    return { rowsAffected: 0, targetEntityId: job.targetEntityId };
  }
  const marked = await markShoppingAgentsAmbiguousAfterSplit(
    {
      sourceCanonicalProductId: job.sourceEntityId,
      splitJobId: job.id,
      targetCanonicalProductId: job.targetEntityId,
    },
    db,
  );
  return { rowsAffected: marked, targetEntityId: job.targetEntityId };
}

/**
 * `verify` — assigned versus applied (#59 split invariant 5).
 *
 * Every assignment must have reached a terminal state. A pending one means the
 * phase was interrupted, and throwing keeps the job claimable so the next run
 * finishes it rather than declaring a partial split complete.
 */
async function runSplitVerifyPhase(
  job: CatalogSplitJobRow,
  db: DatabaseOrTransaction,
): Promise<SplitPhaseOutcome> {
  const summary = await summarizeSplitAssignments(job.id, db);
  const outstanding = summary.assigned - summary.applied - summary.skipped;
  if (outstanding > 0) {
    throw new Error(
      `Split job ${job.id} failed its consistency check: ${outstanding} assignment(s) reached no ` +
        'terminal state. The job stays claimable and the next run finishes them.',
    );
  }
  return { rowsAffected: 0, targetEntityId: job.targetEntityId };
}

/**
 * `plan` — the gate (#679).
 *
 * The phase does no work: the assignment list IS the plan and it was written at
 * request time, frozen by a trigger once the job leaves `plan`. What it does is
 * ASK, and asking is the whole point — the condition it blocks on is exactly
 * the condition {@link resumeBlockedSplitJobs} will later test for having
 * cleared, so the two cannot disagree. That is #663's finding applied here
 * before the same dead end could be built.
 */
function runPlanPhase(job: CatalogSplitJobRow): SplitPlanPhaseOutcome {
  const state = splitJobBlockingState(job);
  if (state.state === 'blocked') {
    return { rowsAffected: 0, targetEntityId: job.targetEntityId, blockedReason: state.reason };
  }
  return { rowsAffected: 0, targetEntityId: job.targetEntityId };
}

async function runSplitPhase(
  job: CatalogSplitJobRow,
  phase: CatalogSplitPhase,
  db: DatabaseOrTransaction,
): Promise<SplitPlanPhaseOutcome> {
  switch (phase) {
    case 'plan':
      return runPlanPhase(job);
    case 'mint':
      return runMintPhase(job, db);
    case 'assignments':
      return runAssignmentPhase(job, db);
    case 'saves':
      return runSavesPhase(job, db);
    case 'alerts':
      return runAlertsPhase(job, db);
    case 'agents':
      return runAgentsPhase(job, db);
    case 'redirects':
      // Deliberately nothing. The source keeps its slug and its URL, and the
      // destination has a new one nothing has ever linked to — so there is no
      // old address whose answer changes, which is #59 split invariant 4
      // satisfied by the identity model rather than by a redirect somebody has
      // to get right. The phase exists so the record says it was considered.
      return { rowsAffected: 0, targetEntityId: job.targetEntityId };
    case 'rollups': {
      const targetId = job.targetEntityId;
      if (!targetId) return { rowsAffected: 0, targetEntityId: null };
      return {
        rowsAffected: await rebuildEntityRollups(job.entityType, job.sourceEntityId, targetId, db),
        targetEntityId: targetId,
      };
    }
    case 'verify':
      return runSplitVerifyPhase(job, db);
    case 'done':
      return { rowsAffected: 0, targetEntityId: job.targetEntityId };
  }
}

export interface RunSplitJobResult {
  readonly jobId: string;
  readonly finalPhase: CatalogSplitPhase;
  readonly completed: boolean;
  readonly blocked: boolean;
  readonly rowsAffected: number;
}

/** Run a CLAIMED split from wherever it is. Per-phase transactions, as a merge. */
export async function runSplitJob(jobId: string, leaseOwner: string): Promise<RunSplitJobResult> {
  const db = getDb();
  let job = await findSplitJobById(jobId, db);
  if (!job) throw notFound(`No split job ${jobId}.`);
  let totalRows = 0;

  for (;;) {
    const phase = job.phase;
    if (phase === 'done') break;
    const outcome = await db.transaction(async (tx) => runSplitPhase(job, phase, tx));
    if (outcome.blockedReason) {
      /**
       * PARK it. Until #679 this branch returned `blocked: true` and wrote
       * nothing, so the job kept its lease at `processing`, `claimSplitJobs`
       * reclaimed it on lease expiry, and `attempts` climbed until it
       * dead-lettered for waiting — while `listSplitJobs({status:'blocked'})`,
       * reachable from the operator surface, could never return it.
       *
       * Blocking is also what stops `attempts` counting a WAIT as an attempt:
       * the release path is not taken at all, so nothing increments.
       */
      await blockSplitJob(job.id, leaseOwner, outcome.blockedReason, db);
      log.general.info(
        { jobId: job.id, phase, reason: outcome.blockedReason },
        '[Curation] split job blocked on an operator decision',
      );
      return { jobId: job.id, finalPhase: phase, completed: false, blocked: true, rowsAffected: totalRows };
    }
    totalRows += outcome.rowsAffected;

    const next = nextSplitPhase(phase);
    if (!next) break;
    if (!(await advanceSplitPhase(job.id, leaseOwner, next, outcome.targetEntityId, db))) {
      return { jobId: job.id, finalPhase: phase, completed: false, blocked: false, rowsAffected: totalRows };
    }
    const refreshed = await findSplitJobById(job.id, db);
    if (!refreshed) break;
    job = refreshed;
  }

  const completed = await completeSplitJob(job.id, leaseOwner, db);
  await recordRevision(
    {
      entityType: job.entityType,
      entityId: job.targetEntityId ?? job.sourceEntityId,
      action: 'split',
      actorKind: 'operator',
      actorOxyUserId: job.requestedByOxyUserId,
      reason: job.reason,
      note: `split completed from ${job.sourceEntityId}`,
      splitJobId: job.id,
      after: { targetEntityId: job.targetEntityId },
    },
    db,
  );
  return { jobId: job.id, finalPhase: 'done', completed, blocked: false, rowsAffected: totalRows };
}
