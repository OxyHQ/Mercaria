/**
 * The click record (#67 "Click event").
 *
 * ONE writer, and it takes a fully-composed row rather than a request. That is
 * the mechanism behind "no unnecessary browsing profile": the input type names
 * every fact that may be stored, so a caller holding an Express request has
 * nothing to pass an IP or a user agent as — the columns do not exist and
 * neither do the parameters.
 *
 * There is no update and no delete here. The row is immutable by trigger, and
 * its removal is the shared expiry sweep's, driven by `retention_expires_at`.
 */

import { and, count, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type {
  OutboundClientSurface,
  OutboundDestinationKind,
  OutboundRedirectRefusalReason,
} from '@mercaria/shared-types';
import { affiliateOutboundClicks } from '../schema/affiliateOutbound.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** One click row. */
export type AffiliateOutboundClickRow = typeof affiliateOutboundClicks.$inferSelect;

/**
 * Everything a click may record, and nothing else.
 *
 * Compare with `AFFILIATE_CLICK_RECORDED_FACTS` in shared-types, which names
 * the same set as VALUES so a test can walk the real table against it.
 */
export interface NewAffiliateOutboundClick {
  readonly offerId: string;
  readonly canonicalVariantId?: string | null;
  readonly merchantId?: string | null;
  readonly storefrontId?: string | null;
  readonly catalogSourceId?: string | null;
  readonly affiliateNetwork?: string | null;
  readonly affiliateProgramRef?: string | null;
  readonly affiliatePublisherRef?: string | null;
  readonly destinationHost?: string | null;
  readonly destinationKind?: OutboundDestinationKind | null;
  readonly market?: string | null;
  readonly clientSurface: OutboundClientSurface;
  readonly trafficClass: 'organic' | 'bot' | 'preview' | 'internal';
  readonly trafficSignal: string;
  readonly consentMode: 'granted' | 'denied' | 'unknown';
  readonly disposition: 'redirected' | 'refused';
  readonly refusalReason?: OutboundRedirectRefusalReason | null;
  readonly occurredAt: Date;
  readonly retentionExpiresAt: Date;
}

/** Record one click. Returns the row so the caller can cite its id in a trace. */
export async function insertAffiliateOutboundClick(
  input: NewAffiliateOutboundClick,
  db: DatabaseOrTransaction = getDb(),
): Promise<AffiliateOutboundClickRow> {
  const [row] = await db
    .insert(affiliateOutboundClicks)
    .values({
      offerId: input.offerId,
      canonicalVariantId: input.canonicalVariantId ?? null,
      merchantId: input.merchantId ?? null,
      storefrontId: input.storefrontId ?? null,
      catalogSourceId: input.catalogSourceId ?? null,
      affiliateNetwork: input.affiliateNetwork ?? null,
      affiliateProgramRef: input.affiliateProgramRef ?? null,
      affiliatePublisherRef: input.affiliatePublisherRef ?? null,
      destinationHost: input.destinationHost ?? null,
      destinationKind: input.destinationKind ?? null,
      market: input.market ?? null,
      clientSurface: input.clientSurface,
      trafficClass: input.trafficClass,
      trafficSignal: input.trafficSignal,
      consentMode: input.consentMode,
      disposition: input.disposition,
      refusalReason: input.refusalReason ?? null,
      occurredAt: input.occurredAt,
      retentionExpiresAt: input.retentionExpiresAt,
    })
    .returning();
  if (row === undefined) {
    // An insert that returned nothing is not a duplicate here — there is no
    // conflict clause — so it is a real failure and must propagate rather than
    // be read as "already recorded".
    throw new Error('affiliate_outbound_clicks insert returned no row');
  }
  return row;
}

/** One click by id — the operator trace's only entry point. */
export async function findAffiliateOutboundClickById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AffiliateOutboundClickRow | undefined> {
  const [row] = await db
    .select()
    .from(affiliateOutboundClicks)
    .where(eq(affiliateOutboundClicks.id, id))
    .limit(1);
  return row;
}

/** One offer's recent clicks — the trace that opens from an OFFER. */
export async function listAffiliateOutboundClicksForOffer(
  input: { readonly offerId: string; readonly limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AffiliateOutboundClickRow[]> {
  return db
    .select()
    .from(affiliateOutboundClicks)
    .where(eq(affiliateOutboundClicks.offerId, input.offerId))
    .orderBy(desc(affiliateOutboundClicks.occurredAt))
    .limit(input.limit);
}

/** The three click counts one report needs, over one window. */
export interface AffiliateClickTotals {
  readonly humanClicks: number;
  readonly nonHumanClicks: number;
  readonly refusedClicks: number;
}

/**
 * Count clicks over a window, optionally scoped to one network.
 *
 * `humanClicks` is `organic` AND `redirected`. A bot that was redirected is not
 * a human click and a human whose click was REFUSED never reached the merchant,
 * so neither may enter the numerator #67 reporting item 2 names — and the two
 * are counted separately rather than merged into "other", because an operator
 * reading a dead button needs the refusals on their own.
 *
 * Counted with three FILTERed aggregates in ONE statement rather than three
 * round trips. `count()` comes back through drizzle as a number here (it is an
 * `int8` in Postgres, which postgres.js decodes as a STRING — so the sum is
 * coerced explicitly rather than left to a `+` that would concatenate).
 */
export async function countAffiliateOutboundClicks(
  input: {
    readonly from: Date;
    readonly to: Date;
    readonly affiliateNetwork?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<AffiliateClickTotals> {
  const where = [
    gte(affiliateOutboundClicks.occurredAt, input.from),
    lte(affiliateOutboundClicks.occurredAt, input.to),
  ];
  if (input.affiliateNetwork !== undefined) {
    where.push(eq(affiliateOutboundClicks.affiliateNetwork, input.affiliateNetwork));
  }
  const [row] = await db
    .select({
      human: sql<string>`count(*) filter (where ${affiliateOutboundClicks.trafficClass} = 'organic'
        and ${affiliateOutboundClicks.disposition} = 'redirected')`,
      nonHuman: sql<string>`count(*) filter (where ${affiliateOutboundClicks.trafficClass} <> 'organic'
        and ${affiliateOutboundClicks.disposition} = 'redirected')`,
      refused: sql<string>`count(*) filter (where ${affiliateOutboundClicks.disposition} = 'refused')`,
    })
    .from(affiliateOutboundClicks)
    .where(and(...where));
  return {
    humanClicks: Number(row?.human ?? 0),
    nonHumanClicks: Number(row?.nonHuman ?? 0),
    refusedClicks: Number(row?.refused ?? 0),
  };
}

/** How many rows are past their retention deadline — the sweep's own evidence. */
export async function countExpiredAffiliateOutboundClicks(
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(affiliateOutboundClicks)
    .where(lt(affiliateOutboundClicks.retentionExpiresAt, now));
  return row?.value ?? 0;
}
