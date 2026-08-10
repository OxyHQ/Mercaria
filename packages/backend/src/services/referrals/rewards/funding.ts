/**
 * The four funding adapters (#144, ADR 0005 "The reward-base contract").
 *
 * Every adapter answers the SAME sentence: *return the realized eligible
 * Mercaria funding for this conversion, in the funding's own currency — never
 * gross buyer spend, never a customer-side amount, never an estimate.* Rules
 * receive a base; they never receive an order, a cart or a fee schedule, and
 * `RealizeFundingInput` has no member through which one could arrive.
 *
 * | Source | Realized from |
 * |---|---|
 * | `connected_marketplace` | The `commission_revenue` ledger postings for the payment, net of commission returned on its refunds. Live. |
 * | `fixed_budget` | The headroom left on an explicit campaign budget row. Live. |
 * | `affiliate` | RECONCILED #67 commission, through a port. Refuses until #67 registers a reader. |
 * | `subscription` | RECOGNIZED #89 revenue, through a port. Refuses until #89 registers a reader. |
 *
 * ## The two ports refuse by DEFAULT, and that is the whole of fact 8
 *
 * ADR 0005 fact 8 says a funding source id is added only together with the code
 * that can realize its base, because "a source id the database accepts but no
 * code can produce is a row nothing can ever reconcile". #144 requires all four
 * adapters and tests for all four, so the ids exist — and what fact 8 actually
 * guards against is prevented instead by the port: `registerAffiliateCommissionReader`
 * has NO default implementation, so every deployment that has not shipped #67
 * answers `reader_not_registered` and no `affiliate` reward can be accrued
 * anywhere. The divergence and its reasoning are recorded in
 * `docs/referral-rewards.md`.
 *
 * The `#124` credential-port shape, deliberately: a reader is registered at
 * boot by the domain that owns the revenue, the default is a refusal rather
 * than a stub that answers zero, and a refusal is a NAMED outcome the accrual
 * records rather than an exception nobody classifies.
 *
 * ## An estimate is not a base
 *
 * `not_yet_reconciled` exists so #144 calculation rule 8 is held by the
 * vocabulary rather than by a reviewer: an affiliate commission the network has
 * not confirmed has a different answer from one confirmed at zero. An adapter
 * that collapsed the two would let a click estimate be paid as though it were
 * money.
 */

import type {
  CurrencyCode,
  RealizedFunding,
  ReferralFundingSourceId,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import { findCampaignBudgetById } from '../../../db/referrals/campaignBudgetRepository.js';
import { readRealizedCommissionForPayment } from '../../../db/referrals/commissionBaseRepository.js';

/**
 * What an adapter is asked. Deliberately narrow: a funding RECORD reference and
 * the instant the question is being asked as of.
 *
 * There is no order, no cart, no buyer, no basket total and no fee snapshot in
 * this type, which is what makes "a rule must never compute a percentage of
 * gross basket value" a property of the call graph rather than a rule somebody
 * has to remember at the one site that could break it.
 */
export interface RealizeFundingInput {
  /** The funding record's own id: a payment id, a budget row id, a #67/#89 record. */
  recordRef: string;
  /** The instant the base is being read as of — a conversion's own event time. */
  at: Date;
  db: DatabaseOrTransaction;
}

/** One source's realization. Pure with respect to everything but its record. */
export interface ReferralFundingAdapter {
  sourceId: ReferralFundingSourceId;
  realize(input: RealizeFundingInput): Promise<RealizedFunding>;
}

/**
 * A reader of RECONCILED affiliate commission (#67).
 *
 * @returns the reconciled amount, or `undefined` when the network has confirmed
 *   nothing for this record — which the adapter reports as
 *   `not_yet_reconciled`, never as a base of zero.
 */
export type AffiliateCommissionReader = (input: {
  recordRef: string;
  at: Date;
  db: DatabaseOrTransaction;
}) => Promise<{ amountMinor: number; currency: CurrencyCode; version: string; observedAt: Date } | undefined>;

/** A reader of RECOGNIZED Mercaria Pro subscription revenue (#89). */
export type SubscriptionRevenueReader = AffiliateCommissionReader;

let affiliateReader: AffiliateCommissionReader | undefined;
let subscriptionReader: SubscriptionRevenueReader | undefined;

/**
 * Register #67's reconciled-commission reader. Called once at boot by the
 * affiliate domain when it ships; until then the `affiliate` adapter refuses
 * every request and no reward of that source can exist.
 */
export function registerAffiliateCommissionReader(reader: AffiliateCommissionReader): void {
  affiliateReader = reader;
}

/** Register #89's recognized-revenue reader. Same contract, same default. */
export function registerSubscriptionRevenueReader(reader: SubscriptionRevenueReader): void {
  subscriptionReader = reader;
}

/**
 * Drop both registrations.
 *
 * Exists for tests, which must be able to assert the DEFAULT refusal as well as
 * the registered path — a port whose unregistered behaviour is untestable is a
 * port whose unregistered behaviour is unknown.
 */
export function resetReferralFundingReaders(): void {
  affiliateReader = undefined;
  subscriptionReader = undefined;
}

const connectedMarketplaceAdapter: ReferralFundingAdapter = {
  sourceId: 'connected_marketplace',
  async realize(input) {
    const commission = await readRealizedCommissionForPayment(input.db, input.recordRef);
    switch (commission.outcome) {
      case 'no_postings':
        return { outcome: 'unavailable', reason: 'record_not_found' };
      case 'ambiguous_currency':
        return { outcome: 'unavailable', reason: 'ambiguous_currency' };
      case 'realized':
        return {
          outcome: 'realized',
          amountMinor: commission.amountMinor,
          currency: commission.currency,
          recordRef: input.recordRef,
          recordVersion: commission.lastTransactionId,
          observedAt: commission.observedAt,
        };
    }
  },
};

const fixedBudgetAdapter: ReferralFundingAdapter = {
  sourceId: 'fixed_budget',
  async realize(input) {
    const budget = await findCampaignBudgetById(input.db, input.recordRef);
    if (!budget) return { outcome: 'unavailable', reason: 'record_not_found' };
    // A closed, exhausted or invalidated budget has no headroom to offer. Zero
    // rather than a distinct refusal: the accrual's own claim is what decides,
    // and reporting WHY here would let a caller probe a campaign's spend.
    const headroom =
      budget.status === 'open' ? Math.max(0, budget.budgetMinor - budget.claimedMinor) : 0;
    return {
      outcome: 'realized',
      amountMinor: headroom,
      currency: budget.currency,
      recordRef: budget.id,
      // The claimed figure IS the version: a later claim moves it, which is
      // exactly the signal that the headroom a reward was accrued against has
      // changed.
      recordVersion: `claimed:${String(budget.claimedMinor)}`,
      observedAt: budget.updatedAt,
    };
  },
};

const affiliateAdapter: ReferralFundingAdapter = {
  sourceId: 'affiliate',
  async realize(input) {
    if (!affiliateReader) return { outcome: 'unavailable', reason: 'reader_not_registered' };
    const reconciled = await affiliateReader({
      recordRef: input.recordRef,
      at: input.at,
      db: input.db,
    });
    if (!reconciled) return { outcome: 'unavailable', reason: 'not_yet_reconciled' };
    return {
      outcome: 'realized',
      amountMinor: reconciled.amountMinor,
      currency: reconciled.currency,
      recordRef: input.recordRef,
      recordVersion: reconciled.version,
      observedAt: reconciled.observedAt,
    };
  },
};

const subscriptionAdapter: ReferralFundingAdapter = {
  sourceId: 'subscription',
  async realize(input) {
    if (!subscriptionReader) return { outcome: 'unavailable', reason: 'reader_not_registered' };
    const recognized = await subscriptionReader({
      recordRef: input.recordRef,
      at: input.at,
      db: input.db,
    });
    if (!recognized) return { outcome: 'unavailable', reason: 'not_yet_reconciled' };
    return {
      outcome: 'realized',
      amountMinor: recognized.amountMinor,
      currency: recognized.currency,
      recordRef: input.recordRef,
      recordVersion: recognized.version,
      observedAt: recognized.observedAt,
    };
  },
};

/**
 * The COMPLETE adapter set, keyed by source id.
 *
 * A module-level constant rather than a mutable registry: the four sources are
 * static, and a `registerFundingAdapter` would put a production seam in place
 * through which a fifth — a retail one, say — could be added at runtime with no
 * migration, no CHECK widening and no review. The two things that genuinely
 * vary between deployments are the #67 and #89 READERS, and those have their
 * own narrow ports above.
 */
export const REFERRAL_FUNDING_ADAPTERS: Readonly<
  Record<ReferralFundingSourceId, ReferralFundingAdapter>
> = Object.freeze({
  connected_marketplace: connectedMarketplaceAdapter,
  affiliate: affiliateAdapter,
  subscription: subscriptionAdapter,
  fixed_budget: fixedBudgetAdapter,
});

/**
 * The adapter for one source.
 *
 * Throws rather than returning `undefined` for an unknown id: the argument is
 * typed to the closed union and every stored value carries a CHECK against the
 * same tuple, so reaching here with something else means a constraint was
 * dropped — which is a fault to surface, not a base to skip.
 */
export function resolveFundingAdapter(sourceId: ReferralFundingSourceId): ReferralFundingAdapter {
  const adapter = REFERRAL_FUNDING_ADAPTERS[sourceId];
  if (!adapter) {
    throw new Error(
      `No referral funding adapter for \`${String(sourceId)}\`. The approved set is ` +
        `${Object.keys(REFERRAL_FUNDING_ADAPTERS).join(', ')}; mercaria_retail margin, supplier ` +
        'cost, shipping, tax, direct fees and positive retail cost variance are excluded by ' +
        'ADR 0005 and have no adapter by construction.',
    );
  }
  return adapter;
}
