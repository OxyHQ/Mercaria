/**
 * `billing_customers`, `merchant_subscriptions` and
 * `merchant_subscription_events` — the billing relationship and its append-only
 * trail (#89).
 *
 * ## The event row is the idempotency claim, and that is acceptance 3
 *
 * {@link appendSubscriptionEvent} is `ON CONFLICT DO NOTHING … RETURNING` on the
 * partial unique over `provider_event_id`: an empty result set IS the "already
 * applied" answer, exactly as the moderation event store reads it. Every
 * provider-driven state change goes through `applyProviderSubscriptionState`
 * (`services/billing/subscription.service.ts`), which appends the claim FIRST
 * and only mutates the subscription (and books the ledger) when the claim was
 * granted — so a redelivered `invoice.paid` cannot
 * book a second balanced transaction, and neither can an operator REPLAY of an
 * event `payment_provider_events` has already deduped.
 *
 * A conflict here is not an error to catch. The empty vs one-row `RETURNING` set
 * is the answer, so a genuine failure (a dropped connection, pool exhaustion)
 * still propagates instead of being read as a duplicate.
 */

import { and, asc, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type {
  BillingInterval,
  BillingProviderId,
  CurrencyCode,
  MerchantSubscriptionEventKind,
  MerchantSubscriptionStatus,
  SubscriptionCancellationBehavior,
} from '@mercaria/shared-types';
import {
  billingCustomers,
  merchantSubscriptionEvents,
  merchantSubscriptions,
} from '../schema/merchantPlans.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `billing_customers`. */
export type BillingCustomerRow = typeof billingCustomers.$inferSelect;

/** One row of `merchant_subscriptions`. */
export type MerchantSubscriptionRow = typeof merchantSubscriptions.$inferSelect;

/** One row of `merchant_subscription_events`. */
export type MerchantSubscriptionEventRow = typeof merchantSubscriptionEvents.$inferSelect;

/**
 * Record the platform billing customer for one store, converging on a repeat.
 *
 * The unique is `(provider, livemode, store_id)`, so two concurrent starts of the
 * same upgrade collide there rather than creating two customers — which matters
 * because a Mercaria row can be deduplicated after the fact and a provider
 * CUSTOMER cannot be un-created (#46's reasoning, one domain over).
 */
export async function ensureBillingCustomer(
  db: DatabaseOrTransaction,
  input: {
    storeId: string;
    provider: BillingProviderId;
    livemode: boolean;
    providerCustomerId: string;
  },
): Promise<{ created: boolean; row: BillingCustomerRow }> {
  const [inserted] = await db
    .insert(billingCustomers)
    .values(input)
    .onConflictDoNothing({
      target: [billingCustomers.provider, billingCustomers.livemode, billingCustomers.storeId],
    })
    .returning();
  if (inserted) return { created: true, row: inserted };

  const existing = await findBillingCustomer(db, {
    storeId: input.storeId,
    provider: input.provider,
    livemode: input.livemode,
  });
  if (!existing) {
    throw new Error(
      `Billing customer for store ${input.storeId} conflicted but cannot be read back.`,
    );
  }
  return { created: false, row: existing };
}

/** One store's billing customer on one rail and mode, or `undefined`. */
export async function findBillingCustomer(
  db: DatabaseOrTransaction,
  input: { storeId: string; provider: BillingProviderId; livemode: boolean },
): Promise<BillingCustomerRow | undefined> {
  const [row] = await db
    .select()
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.storeId, input.storeId),
        eq(billingCustomers.provider, input.provider),
        eq(billingCustomers.livemode, input.livemode),
      ),
    )
    .limit(1);
  return row;
}

/**
 * One billing customer by the PROVIDER's own id, or `undefined`.
 *
 * The reverse direction of {@link findBillingCustomer}, and it needs its own
 * query because a subscription arriving from the rail carries a customer id and
 * no store id — resolving the store is the whole point of this table.
 */
export async function findBillingCustomerByProviderId(
  db: DatabaseOrTransaction,
  input: { provider: BillingProviderId; livemode: boolean; providerCustomerId: string },
): Promise<BillingCustomerRow | undefined> {
  const [row] = await db
    .select()
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.provider, input.provider),
        eq(billingCustomers.livemode, input.livemode),
        eq(billingCustomers.providerCustomerId, input.providerCustomerId),
      ),
    )
    .limit(1);
  return row;
}

/** Everything a subscription row needs to exist. */
export interface NewMerchantSubscription {
  storeId: string;
  planId: string;
  billingCustomerId: string;
  provider: BillingProviderId;
  livemode: boolean;
  providerSubscriptionId: string;
  status: MerchantSubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  trialEndsAt?: Date;
  acceptedTermsVersion: string;
  acceptedByOxyUserId: string;
  acceptedAt: Date;
}

/**
 * Create or re-open a store's subscription, converging on a repeat.
 *
 * One row per store (the unique), reused across cancellations — so a merchant
 * who cancels and comes back has ONE chain to read rather than a set of rows
 * whose ordering somebody has to reconstruct. Every column the conflict branch
 * sets is spelled out by NAME, never interpolated from a drizzle column object,
 * because `excluded.<col>` renders the JavaScript PROPERTY name and Postgres
 * folds it to lower case (`~/Oxy/AGENTS.md`).
 */
export async function upsertMerchantSubscription(
  db: DatabaseOrTransaction,
  input: NewMerchantSubscription,
): Promise<MerchantSubscriptionRow> {
  const [row] = await db
    .insert(merchantSubscriptions)
    .values({
      storeId: input.storeId,
      planId: input.planId,
      billingCustomerId: input.billingCustomerId,
      provider: input.provider,
      livemode: input.livemode,
      providerSubscriptionId: input.providerSubscriptionId,
      status: input.status,
      interval: input.interval,
      ...(input.currentPeriodStart ? { currentPeriodStart: input.currentPeriodStart } : {}),
      ...(input.currentPeriodEnd ? { currentPeriodEnd: input.currentPeriodEnd } : {}),
      ...(input.trialEndsAt ? { trialEndsAt: input.trialEndsAt } : {}),
      acceptedTermsVersion: input.acceptedTermsVersion,
      acceptedByOxyUserId: input.acceptedByOxyUserId,
      acceptedAt: input.acceptedAt,
    })
    .onConflictDoUpdate({
      target: merchantSubscriptions.storeId,
      set: {
        planId: input.planId,
        billingCustomerId: input.billingCustomerId,
        provider: input.provider,
        livemode: input.livemode,
        providerSubscriptionId: input.providerSubscriptionId,
        status: input.status,
        interval: input.interval,
        currentPeriodStart: input.currentPeriodStart ?? null,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
        trialEndsAt: input.trialEndsAt ?? null,
        // A re-subscription clears the previous ending, or a merchant who came
        // back would carry a cancellation deadline nobody asked for.
        graceExpiresAt: null,
        cancellationBehavior: null,
        cancelAt: null,
        cancelledAt: null,
        endedAt: null,
        acceptedTermsVersion: input.acceptedTermsVersion,
        acceptedByOxyUserId: input.acceptedByOxyUserId,
        acceptedAt: input.acceptedAt,
      },
    })
    .returning();
  if (!row) throw new Error(`Upserting the subscription for store ${input.storeId} returned no row.`);
  return row;
}

/** One store's subscription, or `undefined` — which is what "free" means. */
export async function findSubscriptionByStore(
  db: DatabaseOrTransaction,
  storeId: string,
): Promise<MerchantSubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantSubscriptions)
    .where(eq(merchantSubscriptions.storeId, storeId))
    .limit(1);
  return row;
}

/** One subscription by the provider's own id, or `undefined`. */
export async function findSubscriptionByProviderId(
  db: DatabaseOrTransaction,
  input: { provider: BillingProviderId; livemode: boolean; providerSubscriptionId: string },
): Promise<MerchantSubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantSubscriptions)
    .where(
      and(
        eq(merchantSubscriptions.provider, input.provider),
        eq(merchantSubscriptions.livemode, input.livemode),
        eq(merchantSubscriptions.providerSubscriptionId, input.providerSubscriptionId),
      ),
    )
    .limit(1);
  return row;
}

/** One subscription by its row id, or `undefined`. */
export async function findSubscriptionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MerchantSubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantSubscriptions)
    .where(eq(merchantSubscriptions.id, id))
    .limit(1);
  return row;
}

/** The columns a state change may move. Everything else is set at creation. */
export interface SubscriptionStatePatch {
  status?: MerchantSubscriptionStatus;
  planId?: string;
  interval?: BillingInterval;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  graceExpiresAt?: Date | null;
  cancellationBehavior?: SubscriptionCancellationBehavior | null;
  cancelAt?: Date | null;
  cancelledAt?: Date | null;
  endedAt?: Date | null;
  acceptedTermsVersion?: string;
  acceptedByOxyUserId?: string;
  acceptedAt?: Date;
}

/** Apply one patch. The CHECKs argue about whether the result is coherent. */
export async function updateSubscriptionState(
  db: DatabaseOrTransaction,
  id: string,
  patch: SubscriptionStatePatch,
): Promise<MerchantSubscriptionRow | undefined> {
  const [row] = await db
    .update(merchantSubscriptions)
    .set(patch)
    .where(eq(merchantSubscriptions.id, id))
    .returning();
  return row;
}

/** One row of the audit trail, as a writer supplies it. */
export interface NewSubscriptionEvent {
  subscriptionId: string;
  kind: MerchantSubscriptionEventKind;
  note: string;
  fromStatus?: MerchantSubscriptionStatus;
  toStatus?: MerchantSubscriptionStatus;
  planId?: string;
  actorOxyUserId?: string;
  providerEventId?: string;
  providerInvoiceId?: string;
  amount?: { amount: number; currency: CurrencyCode };
  ledgerTransactionId?: string;
}

/**
 * Append one audit row, converging when the provider event was already applied.
 *
 * @returns `created: false` when a row for this `provider_event_id` already
 *   exists — the caller must then change NOTHING, because whatever this event
 *   implied has already been applied by the delivery that won.
 */
export async function appendSubscriptionEvent(
  db: DatabaseOrTransaction,
  input: NewSubscriptionEvent,
): Promise<{ created: boolean; row: MerchantSubscriptionEventRow | undefined }> {
  const values = {
    subscriptionId: input.subscriptionId,
    kind: input.kind,
    note: input.note,
    ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
    ...(input.toStatus ? { toStatus: input.toStatus } : {}),
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.actorOxyUserId ? { actorOxyUserId: input.actorOxyUserId } : {}),
    ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
    ...(input.providerInvoiceId ? { providerInvoiceId: input.providerInvoiceId } : {}),
    ...(input.amount
      ? { amountAmount: input.amount.amount, amountCurrency: input.amount.currency }
      : {}),
    ...(input.ledgerTransactionId ? { ledgerTransactionId: input.ledgerTransactionId } : {}),
  };

  if (!input.providerEventId) {
    const [row] = await db.insert(merchantSubscriptionEvents).values(values).returning();
    if (!row) throw new Error(`Appending a '${input.kind}' subscription event returned no row.`);
    return { created: true, row };
  }

  // The partial unique's predicate has to be repeated: Postgres cannot infer a
  // partial index as a conflict arbiter from the column alone.
  const [row] = await db
    .insert(merchantSubscriptionEvents)
    .values(values)
    .onConflictDoNothing({
      target: merchantSubscriptionEvents.providerEventId,
      where: sql`${merchantSubscriptionEvents.providerEventId} is not null`,
    })
    .returning();
  return row ? { created: true, row } : { created: false, row: undefined };
}

/** One subscription's trail, newest first. */
export async function listSubscriptionEvents(
  db: DatabaseOrTransaction,
  input: { subscriptionId: string; limit: number },
): Promise<MerchantSubscriptionEventRow[]> {
  return await db
    .select()
    .from(merchantSubscriptionEvents)
    .where(eq(merchantSubscriptionEvents.subscriptionId, input.subscriptionId))
    .orderBy(desc(merchantSubscriptionEvents.createdAt))
    .limit(input.limit);
}

/**
 * Whether one subscription already has an event of a kind since `since`.
 *
 * The grace announcement's idempotency, and it is a QUERY rather than a column
 * because "have we said this yet" is a fact about the trail. A flag beside the
 * deadline would be a second representation of it, and the two would disagree
 * the first time a deadline was recomputed.
 */
export async function hasSubscriptionEventSince(
  db: DatabaseOrTransaction,
  input: { subscriptionId: string; kind: MerchantSubscriptionEventKind; since: Date },
): Promise<boolean> {
  const [row] = await db
    .select({ id: merchantSubscriptionEvents.id })
    .from(merchantSubscriptionEvents)
    .where(
      and(
        eq(merchantSubscriptionEvents.subscriptionId, input.subscriptionId),
        eq(merchantSubscriptionEvents.kind, input.kind),
        // `.toISOString()` with an explicit cast, never a bare `Date`: a
        // comparison against a COLUMN takes its type from the column, and this
        // one does too — but the habit is what stops the next one being written
        // against an expression, which postgres.js refuses outright.
        sql`${merchantSubscriptionEvents.createdAt} >= ${input.since.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Past-due subscriptions whose grace has run out — the sweep's page.
 *
 * Keyset on the row id so a page cannot repeat or skip: the deadline is not
 * unique and ordering by it alone would do both.
 */
export async function listSubscriptionsPastGrace(
  db: DatabaseOrTransaction,
  input: { at: Date; limit: number; afterId?: string },
): Promise<MerchantSubscriptionRow[]> {
  return await db
    .select()
    .from(merchantSubscriptions)
    .where(
      and(
        eq(merchantSubscriptions.status, 'past_due'),
        isNotNull(merchantSubscriptions.graceExpiresAt),
        lte(merchantSubscriptions.graceExpiresAt, input.at),
        ...(input.afterId ? [sql`${merchantSubscriptions.id} > ${input.afterId}`] : []),
      ),
    )
    .orderBy(asc(merchantSubscriptions.id))
    .limit(input.limit);
}

/**
 * Subscriptions the reconciliation sweep should re-read, oldest touched first.
 *
 * Every state except `expired` is included: a cancelled-but-not-yet-ended
 * subscription still has a period running, and a paused one can be resumed at
 * the rail without Mercaria being told.
 */
export async function listReconcilableSubscriptions(
  db: DatabaseOrTransaction,
  input: { limit: number; afterId?: string },
): Promise<MerchantSubscriptionRow[]> {
  return await db
    .select()
    .from(merchantSubscriptions)
    .where(
      and(
        sql`${merchantSubscriptions.status} <> 'expired'`,
        ...(input.afterId ? [sql`${merchantSubscriptions.id} > ${input.afterId}`] : []),
      ),
    )
    .orderBy(asc(merchantSubscriptions.id))
    .limit(input.limit);
}
