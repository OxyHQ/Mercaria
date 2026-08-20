/**
 * `price_alerts` — reads and writes of one buyer's own price conditions (#79).
 *
 * ## Every buyer-facing read is SCOPED TO ITS OWNER in the statement
 *
 * `findPriceAlertForOwner` takes the owner as a predicate rather than fetching
 * by id and comparing afterwards, so a service that forgets the check cannot
 * exist: there is no function here that returns an alert by id alone. An id
 * belonging to somebody else is therefore a 404 and not a 403 — the id is opaque
 * and a distinguishable answer would confirm that a stranger's alert exists
 * (#80's `findProductSaveByIdForOwner`, same reasoning).
 *
 * ## There is deliberately no "who is watching this product" read
 *
 * {@link listEvaluableAlertsForProduct} exists because the evaluator must have
 * it, and it returns whole rows to a worker inside the process. Nothing else
 * reads by product, no route reaches it, and no function here takes a merchant
 * or a storefront at all — issue abuse rule 6, held by the absence of the
 * function rather than by a filter somebody has to remember.
 */

import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type {
  ConditionGroup,
  PriceAlertAvailabilityRequirement,
  PriceAlertBlockReason,
  PriceAlertComparisonBasis,
  PriceAlertProximityScope,
  PriceAlertRepeatPolicy,
  PriceAlertSellerScope,
  PriceAlertState,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { priceAlerts } from '../schema/priceAlerts.js';

export type PriceAlertRow = typeof priceAlerts.$inferSelect;

/** Everything a buyer states when they create an alert. */
export interface NewPriceAlert {
  readonly oxyUserId: string;
  readonly canonicalProductId: string;
  readonly canonicalVariantId?: string | null;
  readonly targetAmount: number;
  readonly targetCurrency: PriceAlertRow['targetCurrency'];
  readonly basis: PriceAlertComparisonBasis;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly market?: string | null;
  readonly sellerScope: PriceAlertSellerScope;
  readonly proximityScope: PriceAlertProximityScope;
  readonly merchantId?: string | null;
  readonly storefrontId?: string | null;
  readonly availabilityRequirement: PriceAlertAvailabilityRequirement;
  readonly minimumAvailableQuantity?: number | null;
  readonly requirePickupAvailable: boolean;
  readonly repeatPolicy: PriceAlertRepeatPolicy;
  readonly resetThresholdAmount?: number | null;
  readonly cooldownSeconds?: number | null;
  readonly quietHoursStartMinute?: number | null;
  readonly quietHoursEndMinute?: number | null;
  readonly quietHoursTimeZone?: string | null;
  readonly locale?: string | null;
  readonly emailOptIn: boolean;
}

/** The fields a buyer may change afterwards. */
export interface PriceAlertPatch {
  readonly targetAmount?: number;
  readonly targetCurrency?: PriceAlertRow['targetCurrency'];
  readonly basis?: PriceAlertComparisonBasis;
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly market?: string | null;
  readonly sellerScope?: PriceAlertSellerScope;
  readonly merchantId?: string | null;
  readonly storefrontId?: string | null;
  readonly availabilityRequirement?: PriceAlertAvailabilityRequirement;
  readonly minimumAvailableQuantity?: number | null;
  readonly requirePickupAvailable?: boolean;
  readonly repeatPolicy?: PriceAlertRepeatPolicy;
  readonly resetThresholdAmount?: number | null;
  readonly cooldownSeconds?: number | null;
  readonly quietHoursStartMinute?: number | null;
  readonly quietHoursEndMinute?: number | null;
  readonly quietHoursTimeZone?: string | null;
  readonly locale?: string | null;
  readonly emailOptIn?: boolean;
  readonly state?: PriceAlertState;
}

export async function insertPriceAlert(
  input: NewPriceAlert,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertRow> {
  const rows = await db
    .insert(priceAlerts)
    .values({
      oxyUserId: input.oxyUserId,
      canonicalProductId: input.canonicalProductId,
      canonicalVariantId: input.canonicalVariantId ?? null,
      targetAmount: input.targetAmount,
      targetCurrency: input.targetCurrency,
      basis: input.basis,
      conditionGroups: [...input.conditionGroups],
      market: input.market ?? null,
      sellerScope: input.sellerScope,
      proximityScope: input.proximityScope,
      merchantId: input.merchantId ?? null,
      storefrontId: input.storefrontId ?? null,
      availabilityRequirement: input.availabilityRequirement,
      minimumAvailableQuantity: input.minimumAvailableQuantity ?? null,
      requirePickupAvailable: input.requirePickupAvailable,
      repeatPolicy: input.repeatPolicy,
      resetThresholdAmount: input.resetThresholdAmount ?? null,
      cooldownSeconds: input.cooldownSeconds ?? null,
      quietHoursStartMinute: input.quietHoursStartMinute ?? null,
      quietHoursEndMinute: input.quietHoursEndMinute ?? null,
      quietHoursTimeZone: input.quietHoursTimeZone ?? null,
      locale: input.locale ?? null,
      emailOptIn: input.emailOptIn,
      state: 'enabled',
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('price_alerts insert returned no row');
  return row;
}

/** One alert, SCOPED TO ITS OWNER. See the module docblock. */
export async function findPriceAlertForOwner(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertRow | undefined> {
  const rows = await db
    .select()
    .from(priceAlerts)
    .where(
      and(
        eq(priceAlerts.id, id),
        eq(priceAlerts.oxyUserId, oxyUserId),
        ne(priceAlerts.state, 'deleted'),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * One alert by id and NOTHING else — the operator trace's read, and the
 * dispatcher's.
 *
 * Deliberately separate from {@link findPriceAlertForOwner} rather than an
 * optional owner parameter: an owner argument that can be omitted is one a
 * caller forgets, and the two callers of this one are a leased worker and a
 * surface behind an operator allow-list. A `deleted` alert IS returned here,
 * because a queued delivery naming it has to be able to say why it was
 * suppressed.
 */
export async function findPriceAlertById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertRow | undefined> {
  const rows = await db.select().from(priceAlerts).where(eq(priceAlerts.id, id)).limit(1);
  return rows[0];
}

/** A buyer's own list, newest first — keyset-free, because the cap is 200. */
export async function listPriceAlertsForOwner(
  input: {
    readonly oxyUserId: string;
    readonly canonicalProductId?: string;
    readonly limit: number;
    readonly offset?: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertRow[]> {
  return db
    .select()
    .from(priceAlerts)
    .where(
      and(
        eq(priceAlerts.oxyUserId, input.oxyUserId),
        ne(priceAlerts.state, 'deleted'),
        ...(input.canonicalProductId
          ? [eq(priceAlerts.canonicalProductId, input.canonicalProductId)]
          : []),
      ),
    )
    .orderBy(desc(priceAlerts.createdAt), desc(priceAlerts.id))
    .limit(input.limit)
    .offset(input.offset ?? 0);
}

/** Issue abuse rule 1's cap, counted over the states a buyer can still see. */
export async function countPriceAlertsForOwner(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(priceAlerts)
    .where(and(eq(priceAlerts.oxyUserId, oxyUserId), ne(priceAlerts.state, 'deleted')));
  return rows[0]?.total ?? 0;
}

/**
 * How many alerts this account created inside the window — issue abuse rule 1's
 * RATE half, counted in Postgres.
 *
 * Durable rather than a per-IP bucket, for the reason #83 states about its own
 * three durable axes: "how often may this ACCOUNT create an alert, across every
 * ECS task" is not a question an in-process limiter can answer. Deleted rows are
 * counted too — deleting one is not a way to buy another creation.
 */
export async function countPriceAlertsCreatedSince(
  oxyUserId: string,
  since: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(priceAlerts)
    .where(
      and(
        eq(priceAlerts.oxyUserId, oxyUserId),
        sql`${priceAlerts.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    );
  return rows[0]?.total ?? 0;
}

/**
 * Every alert on one product that is still worth evaluating — the ONE read by
 * product, and the evaluator's.
 *
 * Ordered by id so a batch is deterministic and a partially processed page
 * resumes in the same order; the alerts of one product are bounded by the
 * per-account cap times the number of accounts, which is why the caller passes
 * a limit rather than trusting the set to be small.
 */
export async function listEvaluableAlertsForProduct(
  canonicalProductId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertRow[]> {
  return db
    .select()
    .from(priceAlerts)
    .where(
      and(
        eq(priceAlerts.canonicalProductId, canonicalProductId),
        eq(priceAlerts.state, 'enabled'),
        eq(priceAlerts.resolutionState, 'resolved'),
      ),
    )
    .orderBy(priceAlerts.id)
    .limit(limit);
}

/** Apply a buyer's edit, scoped to its owner. */
export async function updatePriceAlertForOwner(
  id: string,
  oxyUserId: string,
  patch: PriceAlertPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertRow | undefined> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    values[key] = key === 'conditionGroups' ? [...(value as readonly string[])] : value;
  }
  if (Object.keys(values).length === 0) return findPriceAlertForOwner(id, oxyUserId, db);

  const rows = await db
    .update(priceAlerts)
    .set(values)
    .where(
      and(
        eq(priceAlerts.id, id),
        eq(priceAlerts.oxyUserId, oxyUserId),
        ne(priceAlerts.state, 'deleted'),
      ),
    )
    .returning();
  return rows[0];
}

/**
 * Delete an alert — a STATE and not a row removal.
 *
 * A queued delivery names the alert and must be able to say `alert_deleted`
 * rather than fail on a missing row, and a repeat DELETE converges rather than
 * 404ing (#104's own rule for the cart's DELETE). The triggers CASCADE only when
 * the row is genuinely removed, which is what a privacy erasure does — see
 * {@link erasePriceAlertsForOwner}.
 */
export async function softDeletePriceAlertForOwner(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(priceAlerts)
    .set({ state: 'deleted' })
    .where(
      and(
        eq(priceAlerts.id, id),
        eq(priceAlerts.oxyUserId, oxyUserId),
        ne(priceAlerts.state, 'deleted'),
      ),
    )
    .returning({ id: priceAlerts.id });
  return rows.length === 1;
}

/**
 * Erasure — one scoped DELETE, and `oxy_user_id` is the whole of what this
 * domain stores about a person.
 *
 * The triggers and their quotes CASCADE from the alert, and the delivery records
 * CASCADE from both; the `notifications` rows they produced are Oxy's own feed
 * and are erased by whoever owns that table, which is the correct division —
 * this domain never wrote them.
 */
export async function erasePriceAlertsForOwner(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .delete(priceAlerts)
    .where(eq(priceAlerts.oxyUserId, oxyUserId))
    .returning({ id: priceAlerts.id });
  return rows.length;
}

/** What one alert's evaluation concluded — the unit `recordPriceAlertEvaluated` stamps. */
export interface PriceAlertEvaluationRecord {
  readonly id: string;
  /** EMPTY means it qualified. Order is the evaluator's. */
  readonly reasons: readonly PriceAlertBlockReason[];
}

/**
 * Stamp an evaluation, whatever it concluded — including WHY it did not fire.
 *
 * The outcome is written by the SAME statement that stamps `last_evaluated_at`
 * (#752). Two statements could leave an alert stamped as evaluated carrying the
 * PREVIOUS evaluation's block reasons, which is worse than no reasons at all:
 * an operator would read a stale cause as the current one and it would look
 * exactly like a correct answer.
 *
 * Alerts are grouped by their reason SET rather than updated one by one. The
 * distinct sets are bounded by the vocabulary and in practice are a handful —
 * alerts on one product mostly fail the same way, and `above_target` alone
 * covers most of them. A per-row `unnest` was the alternative and does not fit:
 * the payload is an array PER ROW, and a Postgres `text[][]` must be
 * rectangular, so it cannot carry reason sets of differing length.
 */
export async function recordPriceAlertEvaluated(
  outcomes: readonly PriceAlertEvaluationRecord[],
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (outcomes.length === 0) return;

  const groups = new Map<string, { reasons: readonly PriceAlertBlockReason[]; ids: string[] }>();
  for (const outcome of outcomes) {
    // Space-joined, and that is safe rather than lucky: every member of
    // PRICE_ALERT_BLOCK_REASONS is a snake_case identifier containing no space,
    // so two distinct sets cannot collide onto one key. ORDER is preserved, so
    // the stored reasons read in the order the evaluator read the conditions.
    const key = outcome.reasons.join(' ');
    const group = groups.get(key);
    if (group) group.ids.push(outcome.id);
    else groups.set(key, { reasons: outcome.reasons, ids: [outcome.id] });
  }

  for (const group of groups.values()) {
    await db
      .update(priceAlerts)
      .set({
        lastEvaluatedAt: now,
        lastBlockReasons: [...group.reasons],
        // The biconditional `price_alerts_last_block_shape_check` enforces, set
        // in the one place that knows both halves.
        lastBlockedAt: group.reasons.length > 0 ? now : null,
      })
      .where(inArray(priceAlerts.id, group.ids));
  }
}

/**
 * Re-arm a `reset_threshold` alert, because an evaluation SAW the price above
 * its threshold.
 *
 * Scoped to the policy in the predicate rather than by the caller checking
 * first: re-arming an alert on any other policy would silently change what its
 * repeat rule means, and this is a statement inside a worker loop where a
 * forgotten guard is invisible.
 */
export async function rearmPriceAlert(
  id: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(priceAlerts)
    .set({ rearmedAt: now })
    .where(and(eq(priceAlerts.id, id), eq(priceAlerts.repeatPolicy, 'reset_threshold')));
}

/**
 * Record that an alert fired.
 *
 * A `once` alert moves to `triggered` in the SAME statement that stamps the
 * timestamp, so there is no window in which it has fired and is still evaluable
 * — which is the window a second worker would fire it again in. Every other
 * policy stays `enabled`.
 */
export async function recordPriceAlertTriggered(
  input: {
    readonly id: string;
    readonly amountMinor: number;
    readonly now: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(priceAlerts)
    .set({
      lastTriggeredAt: input.now,
      lastTriggeredAmount: input.amountMinor,
      state: sql`case when ${priceAlerts.repeatPolicy} = 'once' then 'triggered' else ${priceAlerts.state} end`,
    })
    .where(eq(priceAlerts.id, input.id));
}

/** Record that a notification for this alert actually reached the buyer. */
export async function recordPriceAlertDelivered(
  id: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(priceAlerts).set({ lastDeliveredAt: now }).where(eq(priceAlerts.id, id));
}

/**
 * A product MERGE is about to move these alerts — stamp where they came FROM
 * (#59 merge invariant 2).
 *
 * Runs BEFORE the generic rehomer and is scoped to the LOSER, which is the whole
 * reason it exists: `applyRehomeTarget` sets a column to the WINNER's id and
 * knows nothing about provenance, so a stamp applied afterwards would have to
 * find "the alerts on the winner that just moved" — indistinguishable from the
 * ones that were always there.
 *
 * Idempotent by PREDICATE: after the move there are no alerts left on the loser,
 * so a resumed phase re-runs it as a no-op. The `is null` guard additionally
 * keeps a SECOND merge from overwriting the first hop of a chain, which is the
 * one a buyer would recognise.
 */
export async function stampPriceAlertRehoming(
  input: { readonly canonicalProductId: string; readonly now: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(priceAlerts)
    .set({ rehomedFromCanonicalProductId: input.canonicalProductId, rehomedAt: input.now })
    .where(
      and(
        eq(priceAlerts.canonicalProductId, input.canonicalProductId),
        isNull(priceAlerts.rehomedAt),
      ),
    )
    .returning({ id: priceAlerts.id });
  return rows.length;
}

/**
 * A product SPLIT divided this alert's subject — PAUSE it and mark it (#59
 * split invariant 3).
 *
 * Idempotent by PREDICATE and not by a phase record: only `resolved` alerts are
 * touched, so a resumed job re-runs it as a no-op AND an alert already made
 * ambiguous by an EARLIER split keeps naming that earlier job. Retargeting an
 * unanswered question at a newer job would destroy the pair of candidates the
 * buyer was being asked about — #80's own wording, and the same mistake here.
 *
 * `deleted` alerts are excluded: a buyer who removed an alert is not owed a
 * question about it.
 */
export async function markPriceAlertsAmbiguousAfterSplit(
  input: {
    readonly sourceCanonicalProductId: string;
    readonly splitJobId: string;
    readonly targetCanonicalProductId?: string | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(priceAlerts)
    .set({
      resolutionState: 'ambiguous_after_split',
      splitJobId: input.splitJobId,
      splitTargetCanonicalProductId: input.targetCanonicalProductId ?? null,
      // The ambiguity CHECK requires it, and the buyer requires it more: an
      // ambiguous alert that kept notifying would be notifying about a product
      // they may not have meant.
      state: 'paused',
    })
    .where(
      and(
        eq(priceAlerts.canonicalProductId, input.sourceCanonicalProductId),
        eq(priceAlerts.resolutionState, 'resolved'),
        ne(priceAlerts.state, 'deleted'),
      ),
    )
    .returning({ id: priceAlerts.id });
  return rows.length;
}

/** The buyer's answer to a split ambiguity — a CAS on "still ambiguous". */
export async function clearPriceAlertAmbiguity(
  input: {
    readonly id: string;
    readonly oxyUserId: string;
    readonly canonicalProductId: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertRow | undefined> {
  const rows = await db
    .update(priceAlerts)
    .set({
      canonicalProductId: input.canonicalProductId,
      // A variant preference cannot survive a split: the configuration it named
      // may have moved to the other side, and a preference silently pointing at
      // a variant of a product the alert no longer watches would match nothing.
      canonicalVariantId: null,
      resolutionState: 'resolved',
      splitJobId: null,
      splitTargetCanonicalProductId: null,
      state: 'enabled',
    })
    .where(
      and(
        eq(priceAlerts.id, input.id),
        eq(priceAlerts.oxyUserId, input.oxyUserId),
        eq(priceAlerts.resolutionState, 'ambiguous_after_split'),
      ),
    )
    .returning();
  return rows[0];
}

/** The operator metric: how many alerts are in each state, right now. */
export async function summarizePriceAlerts(
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  enabled: number;
  paused: number;
  triggered: number;
  ambiguous: number;
  neverEvaluated: number;
}> {
  const rows = await db
    .select({
      enabled: sql<number>`count(*) filter (where ${priceAlerts.state} = 'enabled')::int`,
      paused: sql<number>`count(*) filter (where ${priceAlerts.state} = 'paused')::int`,
      triggered: sql<number>`count(*) filter (where ${priceAlerts.state} = 'triggered')::int`,
      ambiguous: sql<number>`count(*) filter (where ${priceAlerts.resolutionState} = 'ambiguous_after_split')::int`,
      neverEvaluated: sql<number>`count(*) filter (where ${priceAlerts.state} = 'enabled' and ${priceAlerts.lastEvaluatedAt} is null)::int`,
    })
    .from(priceAlerts)
    .where(ne(priceAlerts.state, 'deleted'));
  const row = rows[0];
  return {
    enabled: row?.enabled ?? 0,
    paused: row?.paused ?? 0,
    triggered: row?.triggered ?? 0,
    ambiguous: row?.ambiguous ?? 0,
    neverEvaluated: row?.neverEvaluated ?? 0,
  };
}

/**
 * The oldest `last_evaluated_at` among evaluable alerts — issue operations 3's
 * EVALUATION LAG, measured on the alerts rather than on the queue.
 *
 * ABSENT rather than zero when there is nothing outstanding, the
 * `oldestPendingRebuildAgeSeconds` decision: reporting zero would make a stalled
 * evaluator indistinguishable from an idle one.
 */
export async function readOldestEvaluationAge(
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number | undefined> {
  const rows = await db
    .select({ oldest: sql<Date | null>`min(${priceAlerts.lastEvaluatedAt})` })
    .from(priceAlerts)
    .where(and(eq(priceAlerts.state, 'enabled'), lt(priceAlerts.lastEvaluatedAt, now)));
  const oldest = rows[0]?.oldest;
  if (!oldest) return undefined;
  return Math.max(0, Math.floor((now.getTime() - new Date(oldest).getTime()) / 1_000));
}
