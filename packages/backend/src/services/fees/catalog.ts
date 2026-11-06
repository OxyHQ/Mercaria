/**
 * Mercaria's commission, defined in the repository.
 *
 * ## Why the rate lives in code and not behind an operator API
 *
 * What Mercaria charges its sellers is a POLICY, and a policy wants an author on
 * the record. It does not want an administrator. The previous shape —
 * `POST /internal/payments/fee-schedules` gated on the payment operator desk —
 * required a named person with a credential to exist before the marketplace
 * could charge anything, and Oxy is deliberately not built to have those.
 *
 * Defined here, a rate change is a pull request: proposed, reviewed, and applied
 * by a deployment. `fee_schedules.drafted_by_*` records `deployment` plus the
 * commit, so "who decided this" resolves to a reviewed change. When fee policy
 * moves to a CrowdSource jury, what changes is who opens the PR — the
 * `crowdsource_decision` authority is already in the vocabulary and the column
 * can hold it today.
 *
 * ## The catalogue drafts; it does NOT activate
 *
 * Publishing a DRAFT costs nothing: `order-fees.service.ts` selects only active
 * schedules, so a draft charges no one. ACTIVATING is the dangerous act — the
 * moment a schedule is applicable, `merchant-activation/checkout-gate.ts`
 * refuses `seller_not_activated` for every store with no acceptance row, which
 * takes those stores' checkout offline.
 *
 * So activation is deliberately NOT a field here. A deploy that could flip a
 * rate live would be a deploy that can take the marketplace down, and no amount
 * of guarding makes that a good shape for a routine change.
 *
 * ## `scheduleKey` and `version` are the identity
 *
 * At most one schedule per key is active (`fee_schedules_one_active_per_key`),
 * and activating a new version supersedes the old. Editing an entry below is
 * therefore not editing a rate — it is describing the NEXT version, and the
 * script refuses to touch a version that already exists rather than rewriting
 * published terms a merchant has accepted.
 */

import type { CurrencyCode, FeeTaxTreatment, OrderSellerType } from '@mercaria/shared-types';

/** One version of one schedule, exactly as the repository defines it. */
export interface FeeScheduleDefinition {
  /** Stable across versions. The unit "one active schedule" is scoped to this. */
  scheduleKey: string;
  /** Monotonic per key. A new rate is a new version, never an edit. */
  version: number;
  name: string;
  /** What a merchant is shown before accepting. Plain, not a key — see below. */
  merchantSummary: string;
  effectiveStart: Date;
  eligibleSellerType?: OrderSellerType;
  eligibleCurrency?: CurrencyCode;
  percentageBps: number;
  fixedFee?: { amount: number; currency: CurrencyCode };
  taxTreatment?: FeeTaxTreatment;
  /** The terms document version a merchant accepts alongside this schedule. */
  termsVersion: string;
}

/**
 * The published catalogue.
 *
 * `merchantSummary` is a SENTENCE and not an i18n key, deliberately, and it is
 * the one place in this repository where that is right: it is the text a
 * merchant's acceptance row points AT. A key would let the words a merchant
 * agreed to change under them after they agreed, which is the opposite of what
 * an acceptance record is for. Translating it means a new version with its own
 * `termsVersion`, accepted afresh.
 */
/**
 * The words of the card-sales terms (ADR 0018 D1), English only by design (see
 * above). ONE string, so a store and a private seller accept the same text: a
 * reword is a new version of BOTH schedules, each with its own `termsVersion`.
 */
const CARD_SALES_SUMMARY =
  'Mercaria charges 5% of the item subtotal after discounts, plus $0.30 per order, on ' +
  'card sales in US dollars. Card processing is included: there is no separate ' +
  'processing fee. Delivery and tax are never included. Sales paid in FairCoin carry ' +
  'no fee. If you refund an order, the fee on the refunded amount is returned to you ' +
  'in proportion.';

export const FEE_SCHEDULE_CATALOG: readonly FeeScheduleDefinition[] = [
  /**
   * The marketplace commission on STORE card sales (ADR 0018).
   *
   * 5% + $0.30 per order, ALL-IN: Oxy Platforms, Inc. is the platform on
   * separate charges and transfers (ADR 0001 D3), so it already pays the card
   * processor, and the seller sees one fee with no processing line beside it.
   *
   * Scoped to USD because card checkout presents only in USD (ADR 0001 D8 as
   * amended): every card sale is a USD order, and nothing else is. A sale in
   * FAIR matches no schedule and records the honest `no_active_schedule` zero,
   * which is how "0% on FairCoin" is expressed — the scope set has no
   * payment-method column, deliberately, and does not need one.
   *
   * Scoped to STORES, with the private sellers' twin below under its own key,
   * so the two kinds of seller are versioned and activated independently: a
   * stores-and-people v2 of this key would have superseded v1 and asked every
   * store to accept identical terms again before it could take another card
   * order (ADR 0018 D3).
   */
  {
    scheduleKey: 'marketplace-card',
    version: 1,
    name: 'Marketplace fee on card sales',
    merchantSummary: CARD_SALES_SUMMARY,
    effectiveStart: new Date('2026-11-06T00:00:00.000Z'),
    eligibleSellerType: 'store',
    eligibleCurrency: 'USD',
    percentageBps: 500,
    fixedFee: { amount: 30, currency: 'USD' },
    taxTreatment: 'unknown',
    termsVersion: 'marketplace-card-v1',
  },
  /**
   * The same commission on PRIVATE (P2P) sellers' card sales (ADR 0018 D3):
   * the owner's decision is that it applies to marketplace card sales
   * generally. Identical rate and words; `user`-scoped, so it and the store
   * schedule are disjoint and `selectFeeSchedule` never sees two matches.
   *
   * A private seller accepts it on the storefront's Settings → Payments
   * (`/seller/fees/accept`), which shipped before this version was activated —
   * activation is refused while a payment-ready private seller has not.
   */
  {
    scheduleKey: 'marketplace-card-individual',
    version: 1,
    name: 'Marketplace fee on card sales',
    merchantSummary: CARD_SALES_SUMMARY,
    effectiveStart: new Date('2026-11-06T00:00:00.000Z'),
    eligibleSellerType: 'user',
    eligibleCurrency: 'USD',
    percentageBps: 500,
    fixedFee: { amount: 30, currency: 'USD' },
    taxTreatment: 'unknown',
    termsVersion: 'marketplace-card-individual-v1',
  },
];
