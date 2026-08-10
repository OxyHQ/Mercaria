/**
 * The twelve forbidden funding kinds (#144, ADR 0005's eight prohibitions plus
 * its four pricing-isolation rules) — the DETECTOR.
 *
 * ## This module is the second line, not the first
 *
 * `mercaria_retail` margin is already unfundable three ways before anything
 * here runs. The vocabulary: `REFERRAL_FUNDING_SOURCE_IDS` has four members and
 * none of them is a retail, supplier, tax, refund or ranking anything, and the
 * union is DISJOINT from `REFERRAL_FORBIDDEN_FUNDING_KINDS` by a test. The
 * schema: `referral_reward_rules.funding_source_id` and
 * `referral_rewards.funding_source_id` both carry a CHECK rendered from that
 * same four-member tuple, so a forbidden value fails the WRITE — from a
 * service, from a migration, from `psql`. And the registry: there is no adapter
 * to realize a base for anything outside the four, so even a rule that somehow
 * existed could not compute an amount.
 *
 * What this module adds is the ANSWER. A `.strict()` schema refuses an
 * unrecognized `fundingSourceId` with "invalid enum value", which tells an
 * operator they typed something wrong rather than that they attempted something
 * the business model forbids. `assertNoForbiddenReferralFunding` maps the
 * attempt onto the exact {@link ReferralForbiddenFundingKind} and explains why
 * it can never fund a reward — the `forbidden-components.ts` device from #120,
 * which is the same shape of prohibition one domain over.
 *
 * ## The patterns match SHAPES, not spellings
 *
 * `retailMargin`, `retail_margin`, `RETAIL-MARGIN` and `mercariaRetailMargin`
 * are one attempt. The patterns run against the key or value LOWER-CASED with
 * separators stripped, and the table is ORDERED most-specific first, so a
 * refusal names the prohibition that was actually reached rather than a generic
 * one a later rule would also have caught.
 */

import {
  REFERRAL_FORBIDDEN_FUNDING_LABELS,
  type ReferralForbiddenFundingKind,
} from '@mercaria/shared-types';
import { validationError } from '../../../lib/errors/error-codes.js';

interface ForbiddenPattern {
  kind: ReferralForbiddenFundingKind;
  pattern: RegExp;
}

/**
 * Ordered most-specific first. `retailcostvariance` must be reported as
 * `mercaria_retail_cost_variance` and not as the `mercaria_retail_margin` a
 * broader retail rule would also match — a refusal that names the wrong
 * prohibition teaches the wrong lesson, and these two have genuinely different
 * reasons (one is zero by construction, the other is the customer's money).
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { kind: 'mercaria_retail_cost_variance', pattern: /costvariance|retailvariance|variancesurplus/ },
  { kind: 'mercaria_retail_margin', pattern: /retailmargin|mercariaretail|retailprofit|retailmarkup/ },
  { kind: 'supplier_shipping_handling', pattern: /suppliershipping|supplierhandling|shippingcost|handlingfee/ },
  { kind: 'supplier_acquisition_cost', pattern: /suppliercost|supplieracquisition|wholesalecost|landedcost|procurementcost/ },
  // Deliberately NOT a bare `tax`, `duty` or `vat`: normalized keys make `vat`
  // a substring of `activatedAt` and `tax` a substring of `taxonomy`, so the
  // obvious pattern refuses a legitimate rule body. A gate that cried wolf
  // would be disabled by whoever hit it next.
  {
    kind: 'customer_tax_duty',
    pattern: /taxamount|taxrevenue|taxshare|taxduty|salestax|customsduty|dutyamount|vatamount|vatcollected|vatshare/,
  },
  { kind: 'direct_payment_fx_cost', pattern: /fxcost|paymentcost|processorcost|processingfee|interchange/ },
  { kind: 'customer_refund_credit', pattern: /refund|storecredit|customercredit|chargeback/ },
  { kind: 'dropship_markup', pattern: /dropship|markup|uplift/ },
  { kind: 'buyer_service_charge', pattern: /servicecharge|buyerfee|buyersurcharge|checkoutfee/ },
  { kind: 'merchant_fee_increase', pattern: /feeincrease|feeuplift|merchantfee|commissionincrease|feeschedule/ },
  { kind: 'item_price_increase', pattern: /itemprice|listingprice|priceincrease|pricesurcharge/ },
  { kind: 'paid_ranking', pattern: /paidranking|sponsored|rankingboost|promotedplacement|rankingfee/ },
];

/** One detected attempt: what was sent, what it amounts to, and why it cannot be. */
export interface ForbiddenFundingMatch {
  input: string;
  kind: ReferralForbiddenFundingKind;
  reason: string;
}

/** `retail_margin` / `retailMargin` / `Retail Margin` → `retailmargin`. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which of `inputs` name a forbidden funding source, in input order.
 *
 * Pure, so a refusal message is reproducible in a test and in an operator's
 * terminal. `inputs` are candidate FIELD NAMES from a request body or candidate
 * VALUES for a funding source — the same shapes, matched the same way, because
 * `{ retailMargin: 500 }` and `{ fundingSourceId: 'retail_margin' }` are one
 * attempt wearing two hats.
 */
export function detectForbiddenReferralFunding(
  inputs: readonly string[],
): ForbiddenFundingMatch[] {
  const matches: ForbiddenFundingMatch[] = [];
  for (const input of inputs) {
    const haystack = normalize(input);
    const hit = FORBIDDEN_PATTERNS.find((entry) => entry.pattern.test(haystack));
    if (hit) {
      matches.push({ input, kind: hit.kind, reason: REFERRAL_FORBIDDEN_FUNDING_LABELS[hit.kind] });
    }
  }
  return matches;
}

/**
 * Refuse an input that reaches for a forbidden funding source, naming what it
 * is and why a referral reward can never be funded from it.
 *
 * A `validationError` and not a `conflict`: the request is malformed against
 * the commercial model, and the caller can fix it by not sending the field.
 *
 * @param inputs Candidate field names or funding-source values.
 * @param context Where the attempt arrived, so the message says which surface
 *   refused it.
 */
export function assertNoForbiddenReferralFunding(
  inputs: readonly string[],
  context: string,
): void {
  const matches = detectForbiddenReferralFunding(inputs);
  if (matches.length === 0) return;
  const detail = matches
    .map((match) => `\`${match.input}\` is ${match.reason} (${match.kind})`)
    .join('; ');
  throw validationError(
    `${context}: a referral reward is funded only from realized eligible Mercaria revenue or ` +
      `an explicit marketing budget, so this cannot be configured — ${detail}. Referral ` +
      'economics never change a buyer price, a merchant fee or an organic ranking.',
  );
}
