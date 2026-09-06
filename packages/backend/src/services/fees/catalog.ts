/**
 * Mercaria's commission, defined in the repository.
 *
 * ## Why the rate lives in code and not behind an operator API
 *
 * What Mercaria charges its sellers is a POLICY, and a policy wants an author on
 * the record. It does not want an administrator. The previous shape —
 * `POST /internal/payments/fee-schedules` gated on `PAYMENT_OPERATOR_OXY_USER_IDS`
 * — required a named person with a credential to exist before the marketplace
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
export const FEE_SCHEDULE_CATALOG: readonly FeeScheduleDefinition[] = [
  {
    scheduleKey: 'marketplace-standard',
    version: 1,
    name: 'Marketplace standard commission',
    merchantSummary:
      'Mercaria charges 10% of the item subtotal after discounts, plus €0.30 per order. ' +
      'Delivery and tax are never included. If you refund an order, the commission on the ' +
      'refunded amount is returned to you in proportion.',
    effectiveStart: new Date('2026-01-01T00:00:00.000Z'),
    eligibleCurrency: 'EUR',
    percentageBps: 1_000,
    fixedFee: { amount: 30, currency: 'EUR' },
    taxTreatment: 'unknown',
    termsVersion: 'marketplace-standard-v1',
  },
];
