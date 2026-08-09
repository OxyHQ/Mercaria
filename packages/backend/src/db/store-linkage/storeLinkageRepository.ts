/**
 * Reads and writes for the merchant → native store linkage workflow (#84).
 *
 * The four tables' constraints are the authority and this module only
 * INTERPRETS them, the `nativeStoreLinkRepository` contract:
 *
 *  - `store_linkage_requests_open_key` decides whether a request is a new one or
 *    a replay. {@link openStoreLinkageRequest} uses `ON CONFLICT DO NOTHING` on
 *    that index and reads the incumbent back on an empty `RETURNING` set — so
 *    two concurrent replays produce exactly ONE request (and therefore one
 *    store, one link and one follow target), never a duplicate and never an
 *    unhandled 23505.
 *  - `mercaria_store_linkage_request_guard` decides whether a resolution may be
 *    written. {@link resolveStoreForRequest} is a compare-and-swap on
 *    `resolved_store_id IS NULL`; the trigger is what makes that a guarantee for
 *    a caller who never comes through here.
 *
 * There is deliberately no `updateRequest(patch)` here. Every write is a NAMED
 * transition with its own predicate, because a generic patch function is how a
 * state machine acquires a path nobody designed: `applied` is reachable only
 * from `applying`, `blocked` only with a reason, and a step only ever advances.
 */

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  StoreLinkageBlockReason,
  StoreLinkageCandidateSource,
  StoreLinkageMatchState,
  StoreLinkageMode,
  StoreLinkageOverlapRule,
  StoreLinkageProfileField,
  StoreLinkageState,
  StoreLinkageStep,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  STORE_LINKAGE_LIVE_STATES,
  storeLinkageCandidates,
  storeLinkageOfferOverlaps,
  storeLinkageProfileAdoptions,
  storeLinkageRequests,
} from '../schema/storeLinkage.js';

export type StoreLinkageRequestRow = typeof storeLinkageRequests.$inferSelect;
export type StoreLinkageCandidateRow = typeof storeLinkageCandidates.$inferSelect;
export type StoreLinkageProfileAdoptionRow = typeof storeLinkageProfileAdoptions.$inferSelect;
export type StoreLinkageOfferOverlapRow = typeof storeLinkageOfferOverlaps.$inferSelect;

/** The six impact counts, as the preview computes and stores them. */
export interface StoreLinkageImpactCounts {
  impactActiveListings: number;
  impactNativeOffers: number;
  impactExternalOffers: number;
  impactStorefronts: number;
  impactPlacedOrders: number;
  impactStoreMembers: number;
}

export interface OpenStoreLinkageRequestInput {
  merchantId: string;
  claimId: string;
  claimantOxyUserId: string;
  mode: StoreLinkageMode;
  /** NULL exactly on `create_store` — the CHECK says so, not a convention here. */
  requestedStoreId: string | null;
  /** The link this request ENDS. Present exactly on `correct_link` and `unlink`. */
  supersedesLinkId: string | null;
  reason: string;
  impact: StoreLinkageImpactCounts;
}

/** The four immutable columns the generated `request_key` is built from. */
export interface StoreLinkageRequestKey {
  claimId: string;
  mode: StoreLinkageMode;
  requestedStoreId: string | null;
  supersedesLinkId: string | null;
}

/**
 * Claim the live request for this (claim, mode, named store), or hand back the
 * one that already holds it.
 *
 * `ON CONFLICT DO NOTHING` on the partial unique, then a read of the incumbent:
 * an empty `RETURNING` set means somebody got there first, and the caller
 * receives THEIR row rather than an error. That is what makes replaying store
 * creation converge (issue acceptance 4) — the second call does not create a
 * second store because it does not create a second REQUEST, and the store is
 * made by the request.
 *
 * The conflict target is stated with its predicate. Both are required for a
 * partial index: Postgres refuses to infer an arbiter from the columns alone,
 * and drizzle would otherwise emit an `ON CONFLICT` the server rejects.
 */
export async function openStoreLinkageRequest(
  db: DatabaseOrTransaction,
  input: OpenStoreLinkageRequestInput,
): Promise<{ request: StoreLinkageRequestRow; created: boolean }> {
  const [inserted] = await db
    .insert(storeLinkageRequests)
    .values({
      merchantId: input.merchantId,
      claimId: input.claimId,
      claimantOxyUserId: input.claimantOxyUserId,
      mode: input.mode,
      requestedStoreId: input.requestedStoreId,
      supersedesLinkId: input.supersedesLinkId,
      reason: input.reason,
      ...input.impact,
    })
    .onConflictDoNothing({
      target: storeLinkageRequests.requestKey,
      // The predicate is REQUIRED, not decoration: `store_linkage_requests_open_key`
      // is a PARTIAL unique, and Postgres refuses to infer an arbiter from the
      // column alone — the `ensureCart` lesson (#104), where an omitted predicate
      // turned an upsert into a 500.
      where: inArray(storeLinkageRequests.state, [...STORE_LINKAGE_LIVE_STATES]),
    })
    .returning();

  if (inserted) return { request: inserted, created: true };

  const incumbent = await findLiveRequest(db, input);
  if (!incumbent) {
    // The holder went terminal in the gap between the refused insert and this
    // read. A retry is the honest answer — the same conclusion
    // `linkNativeStore` reaches from the same shape.
    throw new Error('The linkage request raced a concurrent change; retry.');
  }
  return { request: incumbent, created: false };
}

/** The live request holding one idempotency key, if there is one. */
export async function findLiveRequest(
  db: DatabaseOrTransaction,
  key: StoreLinkageRequestKey,
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(storeLinkageRequests)
    .where(
      and(
        eq(storeLinkageRequests.claimId, key.claimId),
        eq(storeLinkageRequests.mode, key.mode),
        key.requestedStoreId === null
          ? isNull(storeLinkageRequests.requestedStoreId)
          : eq(storeLinkageRequests.requestedStoreId, key.requestedStoreId),
        key.supersedesLinkId === null
          ? isNull(storeLinkageRequests.supersedesLinkId)
          : eq(storeLinkageRequests.supersedesLinkId, key.supersedesLinkId),
        inArray(storeLinkageRequests.state, [...STORE_LINKAGE_LIVE_STATES]),
      ),
    );
  return row;
}

export async function findStoreLinkageRequestById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(storeLinkageRequests)
    .where(eq(storeLinkageRequests.id, id));
  return row;
}

/** Every request a claimant opened, newest first — their own history read. */
export async function listRequestsForClaimant(
  db: DatabaseOrTransaction,
  claimantOxyUserId: string,
  limit: number,
): Promise<StoreLinkageRequestRow[]> {
  return db
    .select()
    .from(storeLinkageRequests)
    .where(eq(storeLinkageRequests.claimantOxyUserId, claimantOxyUserId))
    .orderBy(desc(storeLinkageRequests.createdAt))
    .limit(limit);
}

/** The operator queue: what is waiting on a person, oldest first. */
export async function listRequestsInStates(
  db: DatabaseOrTransaction,
  states: readonly StoreLinkageState[],
  limit: number,
): Promise<StoreLinkageRequestRow[]> {
  if (states.length === 0) return [];
  return db
    .select()
    .from(storeLinkageRequests)
    .where(inArray(storeLinkageRequests.state, [...states]))
    .orderBy(asc(storeLinkageRequests.createdAt))
    .limit(limit);
}

/**
 * The ACTIVE (applied) request a store resolved through, if any.
 *
 * Reads the WORKFLOW, not the mapping: `native_store_links` remains the answer
 * to "which merchant is this store". This answers "which request put it there",
 * which is what a correction and an audit trace need.
 */
export async function findAppliedRequestForStore(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(storeLinkageRequests)
    .where(
      and(
        eq(storeLinkageRequests.resolvedStoreId, storeId),
        eq(storeLinkageRequests.state, 'applied'),
      ),
    )
    .orderBy(desc(storeLinkageRequests.appliedAt))
    .limit(1);
  return row;
}

/**
 * Write the resolved store — a compare-and-swap on `resolved_store_id IS NULL`.
 *
 * The empty `RETURNING` set is the "already resolved" answer, so a resumed
 * application reads the store the earlier attempt created instead of creating a
 * second one. The trigger behind this makes the same rule true for a caller who
 * never reaches this function.
 */
export async function resolveStoreForRequest(
  db: DatabaseOrTransaction,
  input: { requestId: string; storeId: string },
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .update(storeLinkageRequests)
    .set({ resolvedStoreId: input.storeId, step: 'store_ready' })
    .where(
      and(
        eq(storeLinkageRequests.id, input.requestId),
        isNull(storeLinkageRequests.resolvedStoreId),
      ),
    )
    .returning();
  return row;
}

/**
 * Advance the step cursor, never backwards.
 *
 * The predicate carries the CURRENT step the caller believes it is at, so a
 * second worker resuming the same request cannot rewind one that has already
 * moved past. An empty `RETURNING` set means somebody else advanced it, and the
 * caller re-reads rather than re-running the step.
 */
export async function advanceRequestStep(
  db: DatabaseOrTransaction,
  input: { requestId: string; from: StoreLinkageStep; to: StoreLinkageStep },
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .update(storeLinkageRequests)
    .set({ step: input.to })
    .where(
      and(eq(storeLinkageRequests.id, input.requestId), eq(storeLinkageRequests.step, input.from)),
    )
    .returning();
  return row;
}

/**
 * Take the application lease — a CAS that also counts the attempt.
 *
 * A request is claimable when it is `draft`/`awaiting_review` moving into
 * `applying`, or when it is ALREADY `applying` with an expired lease: the second
 * branch is what makes the job resumable after a task dies mid-run (issue
 * revocation rule 2). The owner check on release is what stops a reclaimed
 * request being completed twice.
 */
export async function claimRequestForApplication(
  db: DatabaseOrTransaction,
  input: { requestId: string; leaseOwner: string; leaseUntil: Date; now: Date },
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .update(storeLinkageRequests)
    .set({
      state: 'applying',
      leaseOwner: input.leaseOwner,
      leaseUntil: input.leaseUntil,
      attempts: sql`${storeLinkageRequests.attempts} + 1`,
      lastError: null,
    })
    .where(
      and(
        eq(storeLinkageRequests.id, input.requestId),
        or(
          inArray(storeLinkageRequests.state, ['draft', 'awaiting_review']),
          and(
            eq(storeLinkageRequests.state, 'applying'),
            // `input.now.toISOString()` with an explicit cast, never a raw
            // `Date`. `lt(column, date)` would be fine — drizzle knows the
            // column's type — but this comparison sits inside a raw `sql`
            // fragment, which has no column to take a type from, and postgres.js
            // refuses the `Date` with `ERR_INVALID_ARG_TYPE` at query time on
            // code that type-checks perfectly. `CONVENTIONS.md` §"A `Date` is
            // not a safe parameter against an EXPRESSION" records the same trap
            // from the report queries.
            sql`${storeLinkageRequests.leaseUntil} < ${input.now.toISOString()}::timestamptz`,
          ),
        ),
      ),
    )
    .returning();
  return row;
}

/**
 * Complete the application. The owner check is the second half of the lease:
 * a worker whose lease expired and was reclaimed must not be able to stamp
 * `applied` over the work its successor is doing.
 *
 * `supersedes_link_id` is deliberately NOT in the `set`: it is part of the
 * generated idempotency key, so the trigger refuses to move it and the value it
 * carries was decided when the request was opened. What a correction PRODUCED is
 * `native_store_link_id`, which is the one this writes.
 */
export async function completeRequest(
  db: DatabaseOrTransaction,
  input: {
    requestId: string;
    leaseOwner: string;
    nativeStoreLinkId: string | null;
    matchState: StoreLinkageMatchState | null;
    appliedAt: Date;
  },
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .update(storeLinkageRequests)
    .set({
      state: 'applied',
      step: 'completed',
      nativeStoreLinkId: input.nativeStoreLinkId,
      matchState: input.matchState,
      appliedAt: input.appliedAt,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(
      and(
        eq(storeLinkageRequests.id, input.requestId),
        eq(storeLinkageRequests.state, 'applying'),
        eq(storeLinkageRequests.leaseOwner, input.leaseOwner),
      ),
    )
    .returning();
  return row;
}

/** Release a lease after a failed attempt, recording why. The row stays claimable. */
export async function releaseRequestWithError(
  db: DatabaseOrTransaction,
  input: { requestId: string; leaseOwner: string; error: string },
): Promise<void> {
  await db
    .update(storeLinkageRequests)
    .set({ leaseOwner: null, leaseUntil: null, lastError: input.error })
    .where(
      and(
        eq(storeLinkageRequests.id, input.requestId),
        eq(storeLinkageRequests.leaseOwner, input.leaseOwner),
      ),
    );
}

/**
 * Move a request to `blocked`, `awaiting_review`, `rejected` or `abandoned`.
 *
 * `blocked` carries its reason and every other state clears it, which is the
 * CHECK's requirement expressed once here rather than at each call site.
 */
export async function setRequestState(
  db: DatabaseOrTransaction,
  input: {
    requestId: string;
    state: Extract<
      StoreLinkageState,
      'draft' | 'awaiting_review' | 'blocked' | 'rejected' | 'abandoned'
    >;
    blockReason?: StoreLinkageBlockReason;
    decidedByOxyUserId?: string;
    decidedAt?: Date;
    decisionReason?: string;
  },
): Promise<StoreLinkageRequestRow | undefined> {
  const [row] = await db
    .update(storeLinkageRequests)
    .set({
      state: input.state,
      blockReason: input.state === 'blocked' ? (input.blockReason ?? null) : null,
      leaseOwner: null,
      leaseUntil: null,
      ...(input.decidedByOxyUserId !== undefined
        ? {
            decidedByOxyUserId: input.decidedByOxyUserId,
            decidedAt: input.decidedAt ?? new Date(),
            decisionReason: input.decisionReason ?? null,
          }
        : {}),
    })
    .where(eq(storeLinkageRequests.id, input.requestId))
    .returning();
  return row;
}

/** Refresh the stored impact preview. Counts only — see the schema docblock. */
export async function updateRequestImpact(
  db: DatabaseOrTransaction,
  requestId: string,
  impact: StoreLinkageImpactCounts,
): Promise<void> {
  await db
    .update(storeLinkageRequests)
    .set(impact)
    .where(eq(storeLinkageRequests.id, requestId));
}

// ── Candidates ──────────────────────────────────────────────────────────────

/**
 * Record one candidate store, converging on the (request, store) unique.
 *
 * `DO UPDATE` rather than `DO NOTHING`: re-running discovery after a claimant
 * proves another domain should be able to UPGRADE a candidate's evidence from
 * an intent to a proof. The disposition is deliberately not in the `set` — an
 * operator's decision must survive a rediscovery sweep.
 */
export async function upsertCandidate(
  db: DatabaseOrTransaction,
  input: {
    requestId: string;
    storeId: string;
    source: StoreLinkageCandidateSource;
    evidenceRef: string | null;
  },
): Promise<StoreLinkageCandidateRow> {
  const [row] = await db
    .insert(storeLinkageCandidates)
    .values(input)
    .onConflictDoUpdate({
      target: [storeLinkageCandidates.requestId, storeLinkageCandidates.storeId],
      set: { source: input.source, evidenceRef: input.evidenceRef },
    })
    .returning();
  if (!row) throw new Error('upsertCandidate returned no row.');
  return row;
}

export async function listCandidates(
  db: DatabaseOrTransaction,
  requestId: string,
): Promise<StoreLinkageCandidateRow[]> {
  return db
    .select()
    .from(storeLinkageCandidates)
    .where(eq(storeLinkageCandidates.requestId, requestId))
    .orderBy(asc(storeLinkageCandidates.createdAt));
}

/**
 * Select one candidate and reject the rest, in the caller's transaction.
 *
 * The order matters and is not cosmetic: the rejections go FIRST, because
 * `store_linkage_candidates_selected_key` permits one selected row per request
 * and re-selecting a different store would otherwise collide with the incumbent
 * selection instead of replacing it.
 */
export async function selectCandidate(
  db: DatabaseOrTransaction,
  input: { requestId: string; storeId: string },
): Promise<StoreLinkageCandidateRow | undefined> {
  await db
    .update(storeLinkageCandidates)
    .set({ disposition: 'rejected' })
    .where(
      and(
        eq(storeLinkageCandidates.requestId, input.requestId),
        sql`${storeLinkageCandidates.storeId} <> ${input.storeId}`,
      ),
    );
  const [row] = await db
    .update(storeLinkageCandidates)
    .set({ disposition: 'selected' })
    .where(
      and(
        eq(storeLinkageCandidates.requestId, input.requestId),
        eq(storeLinkageCandidates.storeId, input.storeId),
      ),
    )
    .returning();
  return row;
}

// ── Profile adoptions ───────────────────────────────────────────────────────

/**
 * Record one adopted field. `DO NOTHING` on the (request, field) unique, so a
 * resumed application re-applies nothing and writes no second audit row for the
 * same decision — and the table's append-only trigger means there is no
 * `DO UPDATE` available to get it wrong with.
 */
export async function recordProfileAdoption(
  db: DatabaseOrTransaction,
  input: {
    requestId: string;
    storeId: string;
    field: StoreLinkageProfileField;
    previousValue: string | null;
    adoptedValue: string;
    actorOxyUserId: string;
    at: Date;
  },
): Promise<StoreLinkageProfileAdoptionRow | undefined> {
  const [row] = await db
    .insert(storeLinkageProfileAdoptions)
    .values({ ...input, source: 'canonical_merchant' })
    .onConflictDoNothing({
      target: [storeLinkageProfileAdoptions.requestId, storeLinkageProfileAdoptions.field],
    })
    .returning();
  return row;
}

export async function listProfileAdoptions(
  db: DatabaseOrTransaction,
  requestId: string,
): Promise<StoreLinkageProfileAdoptionRow[]> {
  return db
    .select()
    .from(storeLinkageProfileAdoptions)
    .where(eq(storeLinkageProfileAdoptions.requestId, requestId))
    .orderBy(asc(storeLinkageProfileAdoptions.at));
}

// ── Offer overlaps ──────────────────────────────────────────────────────────

/**
 * Record one duplicate representation. `DO UPDATE` on (request, duplicate),
 * because re-running reconciliation after a price refresh may legitimately pick
 * a different primary under the SAME deterministic rule set — and the finding
 * should say what is true now rather than what was true on the first sweep.
 */
export async function recordOfferOverlap(
  db: DatabaseOrTransaction,
  input: {
    requestId: string;
    merchantId: string;
    canonicalVariantId: string;
    primaryOfferId: string;
    duplicateOfferId: string;
    rule: StoreLinkageOverlapRule;
    detectedAt: Date;
  },
): Promise<StoreLinkageOfferOverlapRow> {
  const [row] = await db
    .insert(storeLinkageOfferOverlaps)
    .values(input)
    .onConflictDoUpdate({
      target: [
        storeLinkageOfferOverlaps.requestId,
        storeLinkageOfferOverlaps.duplicateOfferId,
      ],
      set: {
        primaryOfferId: input.primaryOfferId,
        rule: input.rule,
        detectedAt: input.detectedAt,
      },
    })
    .returning();
  if (!row) throw new Error('recordOfferOverlap returned no row.');
  return row;
}

export async function listOfferOverlaps(
  db: DatabaseOrTransaction,
  requestId: string,
): Promise<StoreLinkageOfferOverlapRow[]> {
  return db
    .select()
    .from(storeLinkageOfferOverlaps)
    .where(eq(storeLinkageOfferOverlaps.requestId, requestId))
    .orderBy(asc(storeLinkageOfferOverlaps.detectedAt));
}

// ── Cross-domain READS: the impact preview and the overlap input ────────────
//
// Both reach tables this domain does not own, and both are READS. That is the
// boundary: the linkage domain counts what a linkage would affect and inspects
// which offers describe the same sale, and writes to neither — offers are
// materialized by #57's converger and orders, listings and members are touched
// by nobody here. `store-linkage-isolation.test.ts` asserts the write half.

/**
 * The six impact counts, in ONE round trip.
 *
 * Correlated scalar subqueries rather than six statements, because an impact
 * preview read across six round trips is six different moments and an operator
 * comparing two of its numbers would be comparing two different instants.
 *
 * `merchantId` is optional because a preview is also computed BEFORE a merchant
 * is known to be linkable — the three merchant-scoped counts then read zero,
 * which is honest: no external offer or storefront is attributable to a
 * merchant nobody has named.
 */
export async function countLinkageImpact(
  db: DatabaseOrTransaction,
  input: { storeId: string | null; merchantId: string | null },
): Promise<StoreLinkageImpactCounts> {
  /**
   * The two scope ids are bound ONCE in a CTE, and both are cast to `text`.
   *
   * The cast is not decoration: a bare placeholder in a bare `is not null`
   * gives Postgres no type context at all and the statement fails to PARSE with
   * `42P18 could not determine data type of parameter` — before any row is
   * read, so the failure is total rather than a wrong count.
   *
   * Joining against the CTE also replaces every `is not null` guard: a NULL
   * scope id matches no row, so the count is 0 for exactly the cases where the
   * scope is unknown. Honest, and one fewer branch than writing the guard out.
   */
  const [row] = await db.execute<{
    active_listings: number;
    native_offers: number;
    external_offers: number;
    storefront_count: number;
    placed_orders: number;
    store_members: number;
  }>(sql`
    with scope as (
      select ${input.storeId}::text as store_id, ${input.merchantId}::text as merchant_id
    )
    select
      (select count(*) from listings l, scope s
        where l.store_id = s.store_id and l.status = 'active')::int
        as active_listings,
      (select count(*) from offers o
        join listings l on l.id = o.listing_id, scope s
        where l.store_id = s.store_id and o.kind = 'native' and o.status = 'active')::int
        as native_offers,
      (select count(*) from offers o, scope s
        where o.merchant_id = s.merchant_id and o.kind <> 'native' and o.status = 'active')::int
        as external_offers,
      (select count(*) from storefronts f, scope s
        where f.merchant_id = s.merchant_id and f.status = 'active')::int
        as storefront_count,
      (select count(*) from orders o, scope s where o.store_id = s.store_id)::int
        as placed_orders,
      (select count(*) from store_members m, scope s where m.store_id = s.store_id)::int
        as store_members
  `);

  return {
    impactActiveListings: row?.active_listings ?? 0,
    impactNativeOffers: row?.native_offers ?? 0,
    impactExternalOffers: row?.external_offers ?? 0,
    impactStorefronts: row?.storefront_count ?? 0,
    impactPlacedOrders: row?.placed_orders ?? 0,
    impactStoreMembers: row?.store_members ?? 0,
  };
}

/** One active offer of a merchant, projected to what the overlap rules read. */
export interface OverlapInputRow {
  offerId: string;
  canonicalVariantId: string;
  kind: 'native' | 'external' | 'affiliate' | 'informational';
  sellerIsChannelOperator: boolean;
  lastSeenAt: Date;
}

/**
 * Every ACTIVE offer that represents a sale by this merchant, from both sides.
 *
 * The two sides are joined in SQL rather than merged in TypeScript because they
 * are found by completely different routes and reading them separately would
 * make the overlap detector's input depend on the order two queries returned:
 *
 *  - EXTERNAL: `offers.merchant_id` names the merchant directly.
 *  - NATIVE: the offer names a listing, the listing names the store, and the
 *    store resolves to the merchant through #54's ACTIVE `native_store_links`
 *    row — which is the whole point of the link, used here as a read.
 *
 * `sellerIsChannelOperator` is ADR 0002 D8's derived marketplace fact, computed
 * in the projection and stored nowhere: an offer on no storefront (every native
 * one) is trivially its own operator's, and an offer on a storefront is compared
 * against that storefront's operating merchant.
 */
export async function findMerchantOfferOverlapInput(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<OverlapInputRow[]> {
  const rows = await db.execute<{
    offer_id: string;
    canonical_variant_id: string;
    kind: 'native' | 'external' | 'affiliate' | 'informational';
    seller_is_channel_operator: boolean;
    last_seen_at: Date;
  }>(sql`
    select
      o.id                          as offer_id,
      o.canonical_variant_id        as canonical_variant_id,
      o.kind                        as kind,
      coalesce(sf.merchant_id = ${merchantId}::text, true) as seller_is_channel_operator,
      o.last_seen_at                as last_seen_at
    from offers o
    left join storefronts sf on sf.id = o.storefront_id
    left join listings l     on l.id = o.listing_id
    left join native_store_links nsl
      on nsl.store_id = l.store_id and nsl.status = 'active'
    where o.status = 'active'
      and (o.merchant_id = ${merchantId}::text or nsl.merchant_id = ${merchantId}::text)
  `);

  return rows.map((row) => ({
    offerId: row.offer_id,
    canonicalVariantId: row.canonical_variant_id,
    kind: row.kind,
    sellerIsChannelOperator: row.seller_is_channel_operator,
    lastSeenAt: new Date(row.last_seen_at),
  }));
}
