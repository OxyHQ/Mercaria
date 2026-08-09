/**
 * Writing and reading `analytics_events` (#77).
 *
 * The write side is a BATCH insert and nothing else — there is deliberately no
 * single-event `insert` export, because every producer goes through
 * `services/analytics/sink.ts`, which batches. A per-event insert would be an
 * obvious convenience and would put a database round trip on the commerce path
 * the sink exists to keep off it.
 *
 * The read side is bounded, projected and used only by the rollup and the
 * operator surface. Nothing here returns a whole row to a caller outside the
 * backend.
 */

import { and, count, countDistinct, eq, exists, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  AnalyticsActorKind,
  AnalyticsBuyerOrigin,
  AnalyticsClientSurface,
  AnalyticsCollectionMode,
  AnalyticsConsentState,
  AnalyticsEventClass,
  AnalyticsEventType,
  AnalyticsReasonCode,
  AnalyticsTrafficClass,
} from '@mercaria/shared-types';
import { ANALYTICS_HUMAN_TRAFFIC_CLASSES } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { analyticsEvents } from '../schema/analytics.js';

/**
 * One event, in exactly the shape the column set accepts.
 *
 * Every field is either a scalar, a bounded code or an entity id. There is no
 * index signature and no `unknown`, so a property that does not exist as a
 * column cannot be constructed — which is the allow-list, expressed where the
 * compiler can enforce it rather than only in the DDL.
 */
export interface AnalyticsEventInsert {
  readonly envelopeVersion: string;
  readonly eventType: AnalyticsEventType;
  readonly eventClass: AnalyticsEventClass;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly actorKind: AnalyticsActorKind;
  readonly oxyUserId: string | null;
  readonly pseudonymousSessionId: string | null;
  readonly pseudonymEpoch: number | null;
  readonly checkoutGroupId: string | null;
  readonly orderId: string | null;
  readonly clientSurface: AnalyticsClientSurface;
  readonly appVersion: string | null;
  readonly market: string | null;
  readonly queryEventId: string | null;
  readonly listingId: string | null;
  readonly productVariantId: string | null;
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly offerId: string | null;
  readonly merchantId: string | null;
  readonly storefrontId: string | null;
  readonly categoryId: string | null;
  readonly storeId: string | null;
  readonly searchPolicyVersion: string | null;
  readonly rankingPolicyVersion: string | null;
  readonly experimentKey: string | null;
  readonly experimentVersion: number | null;
  readonly experimentVariant: string | null;
  readonly trafficClass: AnalyticsTrafficClass;
  readonly consentState: AnalyticsConsentState;
  readonly collectionMode: AnalyticsCollectionMode;
  readonly buyerOrigin: AnalyticsBuyerOrigin | null;
  readonly reasonCode: AnalyticsReasonCode | null;
  readonly position: number | null;
  readonly resultCount: number | null;
  readonly latencyMs: number | null;
  readonly quantity: number | null;
  readonly itemCount: number | null;
  readonly expiresAt: Date;
}

/**
 * Append a batch of events.
 *
 * @returns How many rows were written.
 *
 * A failure PROPAGATES from here — the caller (`sink.ts`) is the one place that
 * swallows it, and it does so explicitly with a log line and a counter. Burying
 * the catch in the repository would make "analytics never blocks commerce" a
 * property of a try/catch nobody can see, and would also hide a genuine schema
 * violation from the test suite.
 */
export async function insertAnalyticsEvents(
  events: readonly AnalyticsEventInsert[],
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await getDb()
    .insert(analyticsEvents)
    .values(events.map((event) => ({ ...event })))
    .returning({ id: analyticsEvents.id });
  return rows.length;
}

/** How the rollup slices a day's events. Every field is a stored dimension. */
export interface AnalyticsEventCountSlice {
  readonly market: string;
  readonly clientSurface: string;
  readonly actorKind: string;
  readonly buyerOrigin: string;
  readonly storeId: string;
  readonly merchantId: string;
  readonly total: number;
}

/**
 * Count one day's events of the given types, grouped by every rollup dimension.
 *
 * `humanOnly` filters on `traffic_class`, which is what stops a preview fetch
 * inflating an offer impression (acceptance 2). The filter is a parameter
 * rather than always-on because a latency or error metric genuinely wants the
 * automated traffic counted.
 */
export async function countEventsByDimension(input: {
  eventTypes: readonly AnalyticsEventType[];
  from: Date;
  to: Date;
  humanOnly: boolean;
}): Promise<readonly AnalyticsEventCountSlice[]> {
  if (input.eventTypes.length === 0) return [];
  const conditions = [
    inArray(analyticsEvents.eventType, [...input.eventTypes]),
    gte(analyticsEvents.occurredAt, input.from),
    lt(analyticsEvents.occurredAt, input.to),
  ];
  if (input.humanOnly) {
    conditions.push(
      inArray(analyticsEvents.trafficClass, [...ANALYTICS_HUMAN_TRAFFIC_CLASSES]),
    );
  }

  const rows = await getDb()
    .select({
      // `coalesce(…, '')` because a rollup dimension is a NOT NULL text column
      // whose empty string means "not sliced by this" — a NULL grouping key and
      // an empty one would be two spellings of one bucket.
      market: sql<string>`coalesce(${analyticsEvents.market}, '')`,
      clientSurface: sql<string>`${analyticsEvents.clientSurface}`,
      actorKind: sql<string>`${analyticsEvents.actorKind}`,
      buyerOrigin: sql<string>`coalesce(${analyticsEvents.buyerOrigin}, '')`,
      storeId: sql<string>`coalesce(${analyticsEvents.storeId}, '')`,
      merchantId: sql<string>`coalesce(${analyticsEvents.merchantId}, '')`,
      total: count(),
    })
    .from(analyticsEvents)
    .where(and(...conditions))
    .groupBy(
      sql`coalesce(${analyticsEvents.market}, '')`,
      analyticsEvents.clientSurface,
      analyticsEvents.actorKind,
      sql`coalesce(${analyticsEvents.buyerOrigin}, '')`,
      sql`coalesce(${analyticsEvents.storeId}, '')`,
      sql`coalesce(${analyticsEvents.merchantId}, '')`,
    );

  return rows.map((row) => ({ ...row, total: Number(row.total) }));
}

/**
 * Count searches whose `query_event_id` was followed, within the window, by one
 * of the qualifying success actions — the search-success numerator.
 *
 * A self-join on the correlation handle rather than on any actor id, which is
 * what keeps this metric computable without an identity join: it follows the
 * SEARCH, not the shopper, and the metric definition's attribution limit says
 * so out loud.
 */
export async function countSearchSuccesses(input: {
  successTypes: readonly AnalyticsEventType[];
  from: Date;
  to: Date;
  windowSeconds: number;
}): Promise<number> {
  if (input.successTypes.length === 0) return 0;

  // The follow-up side needs its own alias: both halves read the SAME table, and
  // a correlated reference to an un-aliased column renders BARE and resolves
  // against the subquery's own copy — the silent-empty-result trap
  // `CONVENTIONS.md` records under Naming. `qualified()` is the other fix; an
  // alias is clearer where the correlation is a self-join.
  const followUp = alias(analyticsEvents, 'follow_up');

  const rows = await getDb()
    .select({ successes: countDistinct(analyticsEvents.queryEventId) })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventType, 'search_results_returned'),
        isNotNull(analyticsEvents.queryEventId),
        inArray(analyticsEvents.trafficClass, [...ANALYTICS_HUMAN_TRAFFIC_CLASSES]),
        gte(analyticsEvents.occurredAt, input.from),
        lt(analyticsEvents.occurredAt, input.to),
        exists(
          getDb()
            .select({ one: sql`1` })
            .from(followUp)
            .where(
              and(
                eq(followUp.queryEventId, analyticsEvents.queryEventId),
                inArray(followUp.eventType, [...input.successTypes]),
                gte(followUp.occurredAt, analyticsEvents.occurredAt),
                // The documented success window: an action later than this
                // belongs to a different visit, not to this search.
                sql`${followUp.occurredAt} < ${analyticsEvents.occurredAt} + make_interval(secs => ${input.windowSeconds})`,
              ),
            ),
        ),
      ),
    );

  return Number(rows[0]?.successes ?? 0);
}

/** One event, projected for the operator trace. Never a whole row. */
export interface AnalyticsEventTraceRow {
  readonly id: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly actorKind: string;
  readonly clientSurface: string;
  readonly trafficClass: string;
  readonly market: string | null;
  readonly reasonCode: string | null;
  readonly queryEventId: string | null;
}

/**
 * The events of one search, for the operator trace.
 *
 * The projection names every field explicitly and carries NEITHER identity
 * column — no `oxy_user_id`, no `pseudonymous_session_id` — following the
 * payment status projection's rule. An operator investigating a funnel needs to
 * know what happened in what order; who it happened to is not on the list, and
 * the response has no field it could arrive in ("operator dashboards cannot
 * expose … cross-checkout identity correlation").
 */
export async function traceEventsByQuery(
  queryEventId: string,
  limit: number,
): Promise<readonly AnalyticsEventTraceRow[]> {
  return getDb()
    .select({
      id: analyticsEvents.id,
      eventType: analyticsEvents.eventType,
      occurredAt: analyticsEvents.occurredAt,
      receivedAt: analyticsEvents.receivedAt,
      actorKind: analyticsEvents.actorKind,
      clientSurface: analyticsEvents.clientSurface,
      trafficClass: analyticsEvents.trafficClass,
      market: analyticsEvents.market,
      reasonCode: analyticsEvents.reasonCode,
      queryEventId: analyticsEvents.queryEventId,
    })
    .from(analyticsEvents)
    .where(eq(analyticsEvents.queryEventId, queryEventId))
    .orderBy(analyticsEvents.occurredAt)
    .limit(limit);
}
