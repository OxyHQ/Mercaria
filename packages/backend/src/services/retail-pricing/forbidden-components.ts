/**
 * The fourteen forbidden pricing components (#120, ADR 0004 D3) — the DETECTOR.
 *
 * ## This module is the second line, not the first
 *
 * A markup is already unrepresentable three ways before anything here runs:
 * `retail_pricing_policies` has no markup, margin, profit or padding column; a
 * component row's `kind` CHECK reads the eight-member allowed tuple, so a
 * component named `markup` fails the WRITE; and the customer total is the exact
 * sum of the component rows, so there is no arithmetic step in which one could
 * be added. That is what "impossible through the supported configuration and
 * API surface" means — not a validator that says no.
 *
 * What this module adds is the ANSWER. A `.strict()` zod schema refuses an
 * undeclared field with "unrecognized key", which tells an operator that they
 * typed something wrong rather than that they attempted something the business
 * model forbids. `assertNoForbiddenPricingComponent` maps the offending key
 * onto the exact `RetailForbiddenComponentKind` and explains why it can never be
 * a customer cost — and because the mapping is by NAME, it also catches a key
 * that would otherwise be silently ignored on a non-strict path.
 *
 * ## The patterns match SHAPES, not spellings
 *
 * `markupBps`, `markup_percent`, `priceMarkup` and `MARKUP` are one attempt.
 * The patterns are therefore case-insensitive substring shapes over the
 * normalized key, and the table is ORDERED: the more specific pattern wins, so
 * `referralCommissionBps` is reported as `referral_commission` rather than as
 * generic profit. A key matching nothing is not forbidden by this module — it
 * is refused by the `.strict()` schema above it, which is the correct division:
 * this module answers "why", the schema answers "no".
 */

import {
  RETAIL_FORBIDDEN_COMPONENT_LABELS,
  type RetailForbiddenComponentKind,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/**
 * One forbidden-component shape. `pattern` runs against the LOWER-CASED key
 * with separators stripped, so `markup_bps`, `markupBps` and `MarkupPercent`
 * all normalize to the same haystack.
 */
interface ForbiddenPattern {
  kind: RetailForbiddenComponentKind;
  pattern: RegExp;
}

/**
 * Ordered most-specific first. `referralcommission` must be reported as
 * `referral_commission`, not as the `commission` a later generic rule would
 * catch — a refusal that names the wrong prohibition teaches the wrong lesson.
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { kind: 'referral_commission', pattern: /referral|ambassador|bounty/ },
  { kind: 'affiliate_economics', pattern: /affiliate/ },
  { kind: 'merchant_subscription_economics', pattern: /subscription|planfee|plantier/ },
  { kind: 'paid_ranking_economics', pattern: /sponsored|paidranking|rankingboost|promotedplacement/ },
  { kind: 'fraud_chargeback_reserve', pattern: /fraud|chargebackreserve|disputereserve/ },
  { kind: 'return_defect_reserve', pattern: /returnreserve|defectreserve|breakagereserve/ },
  { kind: 'expected_support_cost', pattern: /supportcost|supportallowance|servicecostallowance/ },
  { kind: 'overhead_allocation', pattern: /overhead|allocationrate|platformcostshare/ },
  { kind: 'minimum_gross_profit_floor', pattern: /grossprofit|profitfloor|minmargin|marginfloor/ },
  { kind: 'percentage_margin_target', pattern: /margin/ },
  { kind: 'percentage_markup', pattern: /markup|uplift|surchargerate/ },
  { kind: 'fixed_profit', pattern: /profit|takerate|contribution/ },
  { kind: 'psychological_rounding', pattern: /charm|roundup|psychological|priceending/ },
  { kind: 'operator_padding', pattern: /padding|buffer|cushion|fudge/ },
];

/** One detected attempt: the key that was sent, and what it amounts to. */
export interface ForbiddenComponentMatch {
  key: string;
  kind: RetailForbiddenComponentKind;
  /** The sentence explaining why it can never be a customer cost. */
  reason: string;
}

/** `markup_bps` / `markupBps` / `Markup Bps` → `markupbps`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which of `keys` name a forbidden pricing component, in input order. Pure —
 * the same keys always yield the same matches, so a refusal message is
 * reproducible in a test and in an operator's terminal.
 */
export function detectForbiddenPricingComponents(
  keys: readonly string[],
): ForbiddenComponentMatch[] {
  const matches: ForbiddenComponentMatch[] = [];
  for (const key of keys) {
    const haystack = normalizeKey(key);
    const hit = FORBIDDEN_PATTERNS.find((entry) => entry.pattern.test(haystack));
    if (hit) {
      matches.push({ key, kind: hit.kind, reason: RETAIL_FORBIDDEN_COMPONENT_LABELS[hit.kind] });
    }
  }
  return matches;
}

/**
 * Refuse a configuration or quote input that reaches for a forbidden component,
 * naming what it is and why retail cannot carry it.
 *
 * A `validationError` and not a `conflict`: the request is malformed against
 * the commercial model, and the caller can fix it by not sending the field.
 *
 * @param keys The candidate field names — an operator body's own keys, or the
 *   component kinds a quote was composed from.
 * @param context Where the attempt arrived (`retail pricing policy`, …), so the
 *   message says which surface refused it.
 */
export function assertNoForbiddenPricingComponent(
  keys: readonly string[],
  context: string,
): void {
  const matches = detectForbiddenPricingComponents(keys);
  if (matches.length === 0) {
    return;
  }
  const detail = matches
    .map((match) => `\`${match.key}\` is ${match.reason} (${match.kind})`)
    .join('; ');
  throw validationError(
    `${context}: mercaria_retail is a cost-recovery channel with zero markup and zero ` +
      `intended item profit, so this cannot be configured — ${detail}. The customer amount ` +
      'is the exact sum of the approved direct-cost components and nothing else.',
  );
}
