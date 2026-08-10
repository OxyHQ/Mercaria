/**
 * `price_alert_triggers` and `price_alert_trigger_quotes` — the record that one
 * qualifying observation happened, written EXACTLY once (#79 §"Trigger
 * identity").
 *
 * ## This module is the SINGLE writer, and that is load-bearing
 *
 * "A quote exists exactly when a conversion happened" is a CROSS-ROW invariant
 * and no CHECK can see it, so it is held here, before any SQL is issued —
 * `insertRetailCostQuote`'s device, cited because it is the same problem. The
 * refusals below are `Error`s rather than typed refusals on purpose: every one
 * of them is a defect in the composition rather than a state a caller can be in,
 * and swallowing one would store a trigger whose amount cannot be re-derived.
 *
 * ## The conflict is not an error to catch
 *
 * `ON CONFLICT DO NOTHING … RETURNING` returns one row when this call created
 * the trigger and NO rows when an earlier one already had. That empty set IS
 * the "already triggered" answer — the `moderation_events` claim shape — so a
 * genuine failure (a dropped connection, a violated CHECK) still propagates
 * instead of being read as a duplicate.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type {
  ConditionGroup,
  CurrencyCode,
  OfferKind,
  PriceAlertComparisonBasis,
  PriceAlertTriggerQuote,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { priceAlertTriggerQuotes, priceAlertTriggers } from '../schema/priceAlerts.js';

export type PriceAlertTriggerRow = typeof priceAlertTriggers.$inferSelect;
export type PriceAlertTriggerQuoteRow = typeof priceAlertTriggerQuotes.$inferSelect;

/** Everything one trigger records. Composed by the evaluator, never partially. */
export interface NewPriceAlertTrigger {
  readonly alertId: string;
  readonly offerId: string;
  readonly observedPriceVersion: string;
  readonly alertPolicyVersion: string;
  readonly canonicalProductId: string;
  readonly canonicalVariantId: string;
  readonly basis: PriceAlertComparisonBasis;
  readonly amountAmount: number;
  readonly amountCurrency: CurrencyCode;
  readonly targetAmount: number;
  readonly targetCurrency: CurrencyCode;
  readonly nativeItemAmount: number;
  readonly nativeItemCurrency: string;
  readonly nativeDeliveryAmount?: number | null;
  readonly nativeDeliveryCurrency?: string | null;
  readonly conditionGroup?: ConditionGroup | null;
  readonly merchantId?: string | null;
  readonly offerKind: OfferKind;
  readonly nativeCheckoutEligible: boolean;
  readonly quotes: readonly PriceAlertTriggerQuote[];
}

/**
 * Check that the quotes describe EXACTLY the conversions this trigger's amounts
 * imply — before any statement runs.
 *
 * Both directions. A missing quote is an amount nobody can reproduce
 * (acceptance 3); a surplus one is a record of a conversion that did not happen,
 * which is worse, because it reads as evidence.
 */
function assertQuotesMatchConversions(input: NewPriceAlertTrigger): void {
  const expected = new Set<string>();
  if (input.nativeItemCurrency !== input.amountCurrency) expected.add('item_price');
  if (
    input.nativeDeliveryCurrency !== null &&
    input.nativeDeliveryCurrency !== undefined &&
    input.nativeDeliveryCurrency !== input.amountCurrency
  ) {
    expected.add('delivery_cost');
  }

  const supplied = new Set(input.quotes.map((quote) => quote.component));
  if (supplied.size !== input.quotes.length) {
    throw new Error('price alert trigger: two quotes for one component');
  }
  for (const component of expected) {
    if (!supplied.has(component as PriceAlertTriggerQuote['component'])) {
      throw new Error(`price alert trigger: ${component} was converted and carries no quote`);
    }
  }
  for (const component of supplied) {
    if (!expected.has(component)) {
      throw new Error(`price alert trigger: ${component} carries a quote and was not converted`);
    }
  }
  for (const quote of input.quotes) {
    if (quote.snapshot.to !== input.amountCurrency) {
      throw new Error('price alert trigger: a quote does not convert into the alert currency');
    }
    if (quote.snapshot.from === quote.snapshot.to) {
      throw new Error('price alert trigger: a quote converts a currency into itself');
    }
    if (!(quote.snapshot.rate > 0)) {
      throw new Error('price alert trigger: a quote carries a non-positive rate');
    }
  }
}

/**
 * Write one trigger and its quotes, or converge on the one that already exists.
 *
 * `undefined` means an earlier evaluation already recorded this exact
 * observation — a duplicate source event, an FX re-check, a second worker — and
 * the caller must NOT enqueue a notification for it. That is acceptance 1 in one
 * return value.
 */
export async function insertPriceAlertTrigger(
  input: NewPriceAlertTrigger,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertTriggerRow | undefined> {
  assertQuotesMatchConversions(input);

  const inserted = await db
    .insert(priceAlertTriggers)
    .values({
      alertId: input.alertId,
      offerId: input.offerId,
      observedPriceVersion: input.observedPriceVersion,
      alertPolicyVersion: input.alertPolicyVersion,
      canonicalProductId: input.canonicalProductId,
      canonicalVariantId: input.canonicalVariantId,
      basis: input.basis,
      amountAmount: input.amountAmount,
      amountCurrency: input.amountCurrency,
      targetAmount: input.targetAmount,
      targetCurrency: input.targetCurrency,
      nativeItemAmount: input.nativeItemAmount,
      nativeItemCurrency: input.nativeItemCurrency,
      nativeDeliveryAmount: input.nativeDeliveryAmount ?? null,
      nativeDeliveryCurrency: input.nativeDeliveryCurrency ?? null,
      conditionGroup: input.conditionGroup ?? null,
      merchantId: input.merchantId ?? null,
      offerKind: input.offerKind,
      nativeCheckoutEligible: input.nativeCheckoutEligible,
    })
    .onConflictDoNothing()
    .returning();

  const trigger = inserted[0];
  if (!trigger) return undefined;

  if (input.quotes.length > 0) {
    await db.insert(priceAlertTriggerQuotes).values(
      input.quotes.map((quote) => ({
        triggerId: trigger.id,
        component: quote.component,
        fxFrom: quote.snapshot.from,
        fxTo: quote.snapshot.to,
        fxRate: quote.snapshot.rate,
        fxProvider: quote.snapshot.provider,
        fxAsOf: new Date(quote.snapshot.asOf),
      })),
    );
  }

  return trigger;
}

/** One trigger by id — the delivery job's own read. */
export async function findPriceAlertTrigger(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertTriggerRow | undefined> {
  const rows = await db
    .select()
    .from(priceAlertTriggers)
    .where(eq(priceAlertTriggers.id, id))
    .limit(1);
  return rows[0];
}

/** The quotes behind one trigger, so its amount can be re-derived. */
export async function listPriceAlertTriggerQuotes(
  triggerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertTriggerQuoteRow[]> {
  return db
    .select()
    .from(priceAlertTriggerQuotes)
    .where(eq(priceAlertTriggerQuotes.triggerId, triggerId))
    .orderBy(priceAlertTriggerQuotes.component);
}

/** One alert's own history, newest first. */
export async function listPriceAlertTriggers(
  alertId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertTriggerRow[]> {
  return db
    .select()
    .from(priceAlertTriggers)
    .where(eq(priceAlertTriggers.alertId, alertId))
    .orderBy(desc(priceAlertTriggers.createdAt), desc(priceAlertTriggers.id))
    .limit(limit);
}

/**
 * How many triggers were written since `since` — issue operations 3's trigger
 * count.
 *
 * A COUNT over a window and never a per-product breakdown: "how many people did
 * this product notify" is one join from "who is watching it", and issue abuse
 * rule 6 is that no analytics surface exposes a buyer's targets.
 */
export async function countPriceAlertTriggersSince(
  since: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(priceAlertTriggers)
    .where(gte(priceAlertTriggers.createdAt, since));
  return rows[0]?.total ?? 0;
}

/**
 * Whether this alert already has a trigger for this exact observation.
 *
 * Used by the operator TRACE to explain a non-notification, never by the
 * evaluator: the evaluator relies on the unique index, because a read-then-write
 * would let two concurrent workers both read "no" and both insert. The index
 * refuses the second and `insertPriceAlertTrigger` reports it as a converge.
 */
export async function findPriceAlertTriggerByIdentity(
  input: {
    readonly alertId: string;
    readonly offerId: string;
    readonly observedPriceVersion: string;
    readonly alertPolicyVersion: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceAlertTriggerRow | undefined> {
  const rows = await db
    .select()
    .from(priceAlertTriggers)
    .where(
      and(
        eq(priceAlertTriggers.alertId, input.alertId),
        eq(priceAlertTriggers.offerId, input.offerId),
        eq(priceAlertTriggers.observedPriceVersion, input.observedPriceVersion),
        eq(priceAlertTriggers.alertPolicyVersion, input.alertPolicyVersion),
      ),
    )
    .limit(1);
  return rows[0];
}
