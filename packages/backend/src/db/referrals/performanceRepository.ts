/**
 * The aggregate reads one partner's own performance breakdown is built from
 * (#147, under ADR 0005 A5).
 *
 * ## Every function here takes a partner id, and that IS the boundary
 *
 * There is no unscoped read in this file, no `partnerId?: string`, and no
 * function that takes a code, a program or a market without one. "Show me
 * everybody's clicks in Andorra" is unrepresentable rather than refused —
 * `orderAccessSubjectForCommerceActor`'s device, applied to a metric.
 *
 * ## Two queries, never one
 *
 * Clicks come from `referral_touches` and conversions from
 * `referral_conversions`; they are read separately and merged by the service.
 * A single `left join` from touches to conversions would multiply a touch by
 * every conversion its attribution produced and report a click count nobody can
 * reproduce — the classic fan-out, and one nothing in the response would
 * disclose.
 *
 * ## What the SQL cannot see, stated where it is written
 *
 * `traffic_class = 'organic'` is the whole of the bot filter, because that is
 * the whole of what #143's classifier records. It reads three self-declared
 * headers; a crawler presenting an ordinary user agent is counted as a person.
 * That limit is published to the partner in
 * `REFERRAL_METRIC_DEFINITIONS.referral_human_clicks.attributionLimit` rather
 * than being a fact only this file knows.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { ReferralPerformanceDimension } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  referralAttributions,
  referralCodes,
  referralConversions,
  referralPrograms,
  referralTouches,
} from '../schema/referrals.js';

/**
 * The conversion states that count as QUALIFIED.
 *
 * `eligible` is the ONE, and it is the state `verifyConversion` moves a
 * conversion to — `referral_conversions_verified_check` makes it unwritable
 * without a `verified_at`, so "qualified" is a fact the row carries rather than
 * a set this file composes.
 *
 * `pending` is excluded deliberately: a conversion nobody has verified is a
 * candidate, and counting it would make a partner's conversion figure fall when
 * one is rejected — a number that goes backwards with no event a partner can
 * see. `rejected`, `reversed` and `corrected` are excluded from the other
 * direction, for the same reason.
 */
const QUALIFIED_CONVERSION_STATES = ['eligible'] as const;

/** One grouped cell as the database returns it. */
export interface ReferralPerformanceBucket {
  /** NULL-safe: a touch with no campaign groups under the empty key. */
  key: string;
  count: number;
}

export interface ReferralPerformanceWindow {
  partnerId: string;
  /** Inclusive. */
  from: Date;
  /** Exclusive — the service adds a day to the caller's inclusive `through`. */
  until: Date;
}

/**
 * The SQL expression each dimension groups by, on the CLICK side.
 *
 * A `Record` over the dimension union, so a dimension added to the tuple
 * without a grouping fails `tsc` — #85's `requirements.ts` device, which is
 * what makes "six dimensions, all answerable" checkable rather than asserted.
 */
function clickGroupExpression(dimension: ReferralPerformanceDimension) {
  switch (dimension) {
    case 'program':
      return sql<string>`${referralPrograms.programId}`;
    case 'campaign':
      return sql<string>`coalesce(${referralTouches.campaignRef}, '')`;
    case 'instrument':
      return sql<string>`${referralTouches.codeId}`;
    case 'market':
      return sql<string>`coalesce(${referralCodes.market}, '')`;
    case 'client_surface':
      return sql<string>`${referralTouches.clientSurface}`;
    case 'date':
      return sql<string>`to_char(${referralTouches.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  }
}

/** The same, on the CONVERSION side, reached through the winning attribution. */
function conversionGroupExpression(dimension: ReferralPerformanceDimension) {
  switch (dimension) {
    case 'program':
      return sql<string>`${referralAttributions.programId}`;
    case 'campaign':
      return sql<string>`coalesce(${referralCodes.campaignRef}, '')`;
    case 'instrument':
      return sql<string>`${referralAttributions.winningCodeId}`;
    case 'market':
      return sql<string>`coalesce(${referralCodes.market}, '')`;
    case 'client_surface':
      // The surface the WINNING touch arrived on. A conversion has no surface
      // of its own — it is an order or an activation — so reporting one here
      // means reporting the touch that earned it, which is what the dimension
      // means on the click side too.
      return sql<string>`coalesce(${referralTouches.clientSurface}, '')`;
    case 'date':
      return sql<string>`to_char(${referralConversions.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  }
}

/**
 * Organic clicks for one partner in one window, grouped by one dimension.
 *
 * Served by `referral_touches_partner_id_occurred_at_idx`, which #142 built for
 * exactly this shape.
 */
export async function countPartnerClicksByDimension(
  db: DatabaseOrTransaction,
  input: ReferralPerformanceWindow & { dimension: ReferralPerformanceDimension },
): Promise<ReferralPerformanceBucket[]> {
  const key = clickGroupExpression(input.dimension);
  const rows = await db
    .select({ key, count: sql<number>`count(*)::int` })
    .from(referralTouches)
    .innerJoin(referralCodes, eq(referralCodes.id, referralTouches.codeId))
    .innerJoin(referralPrograms, eq(referralPrograms.id, referralTouches.programVersionId))
    .where(
      and(
        eq(referralTouches.partnerId, input.partnerId),
        eq(referralTouches.trafficClass, 'organic'),
        gte(referralTouches.occurredAt, input.from),
        lte(referralTouches.occurredAt, input.until),
      ),
    )
    .groupBy(key);
  return rows.map((row) => ({ key: row.key ?? '', count: Number(row.count) }));
}

/** The undimensioned total, so a breakdown's rows can be checked against it. */
export async function countPartnerClicks(
  db: DatabaseOrTransaction,
  input: ReferralPerformanceWindow,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(referralTouches)
    .where(
      and(
        eq(referralTouches.partnerId, input.partnerId),
        eq(referralTouches.trafficClass, 'organic'),
        gte(referralTouches.occurredAt, input.from),
        lte(referralTouches.occurredAt, input.until),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Qualified conversions for one partner in one window, grouped by one
 * dimension.
 *
 * The partner scope is on the ATTRIBUTION, because `referral_conversions`
 * carries no partner id — an attribution is what names a partner, and the join
 * is what makes "this partner's conversions" a question about rows this partner
 * earned rather than about rows that mention them.
 *
 * The touch join is LEFT: an attribution whose winning touch has been swept
 * (touches expire on their own clock, ADR 0005 D6) still has a conversion, and
 * an inner join would silently drop it from every dimension rather than only
 * from the surface breakdown.
 */
export async function countPartnerConversionsByDimension(
  db: DatabaseOrTransaction,
  input: ReferralPerformanceWindow & { dimension: ReferralPerformanceDimension },
): Promise<ReferralPerformanceBucket[]> {
  const key = conversionGroupExpression(input.dimension);
  const rows = await db
    .select({ key, count: sql<number>`count(*)::int` })
    .from(referralConversions)
    .innerJoin(referralAttributions, eq(referralAttributions.id, referralConversions.attributionId))
    .innerJoin(referralCodes, eq(referralCodes.id, referralAttributions.winningCodeId))
    .leftJoin(referralTouches, eq(referralTouches.id, referralAttributions.winningTouchId))
    .where(
      and(
        eq(referralAttributions.partnerId, input.partnerId),
        inArray(referralConversions.state, [...QUALIFIED_CONVERSION_STATES]),
        gte(referralConversions.occurredAt, input.from),
        lte(referralConversions.occurredAt, input.until),
      ),
    )
    .groupBy(key);
  return rows.map((row) => ({ key: row.key ?? '', count: Number(row.count) }));
}

/** The undimensioned conversion total for the same window. */
export async function countPartnerConversions(
  db: DatabaseOrTransaction,
  input: ReferralPerformanceWindow,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(referralConversions)
    .innerJoin(referralAttributions, eq(referralAttributions.id, referralConversions.attributionId))
    .where(
      and(
        eq(referralAttributions.partnerId, input.partnerId),
        inArray(referralConversions.state, [...QUALIFIED_CONVERSION_STATES]),
        gte(referralConversions.occurredAt, input.from),
        lte(referralConversions.occurredAt, input.until),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Conversions this partner has that no reward row has been evaluated for yet.
 *
 * A COUNT and never an amount: the base is read from the ledger at accrual, so
 * before that there is no figure to state and any estimate would be one
 * Mercaria invented and a partner would treat as a promise.
 */
export async function countPartnerPendingConversions(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(referralConversions)
    .innerJoin(referralAttributions, eq(referralAttributions.id, referralConversions.attributionId))
    .where(
      and(
        eq(referralAttributions.partnerId, partnerId),
        inArray(referralConversions.state, ['pending', 'eligible']),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * The distinct programs this partner holds an instrument under.
 *
 * There is no `referral_partner_programs` table and none is wanted: a partner's
 * program set IS the set their codes name, so a second representation could
 * only disagree with the instruments a partner can actually see.
 *
 * A code names a program VERSION, not a program, so the stable identity comes
 * off the joined version row. Reading `programVersionId` as a program id is the
 * mistake this join exists to prevent: it would split one program's history
 * across every version a partner ever held a code under.
 */
export async function listPartnerProgramIds(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ programId: referralPrograms.programId })
    .from(referralCodes)
    .innerJoin(referralPrograms, eq(referralPrograms.id, referralCodes.programVersionId))
    .where(eq(referralCodes.partnerId, partnerId));
  return rows.map((row) => row.programId);
}

/** How many distinct partners hold an instrument under one program. */
export async function countProgramActivePartners(
  db: DatabaseOrTransaction,
  programId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${referralCodes.partnerId})::int` })
    .from(referralCodes)
    .innerJoin(referralPrograms, eq(referralPrograms.id, referralCodes.programVersionId))
    .where(eq(referralPrograms.programId, programId));
  return Number(row?.count ?? 0);
}
