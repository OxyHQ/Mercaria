/**
 * The fourteen forbidden accounting components (#128) — the DETECTOR.
 *
 * ## This module is the second line, not the first
 *
 * A retail margin is already unrepresentable three ways before anything here
 * runs. The chart of accounts has no `retail_margin_revenue` and ADR 0004 D7's
 * proof rests on that absence; `retail_reconciliation_components.component` is
 * CHECKed against the twelve allowed components, so a `gross_profit` row fails
 * the WRITE; and `RETAIL_COMPONENT_ROLES` has no role that could carry a figure
 * out of the equation into a revenue account, so there is no arithmetic step in
 * which one could appear.
 *
 * What this module adds is the ANSWER. A `.strict()` zod schema refuses an
 * undeclared field with "unrecognized key", which tells an operator they typed
 * something wrong rather than that they attempted something the commercial model
 * forbids — and on any non-strict path it would be ignored in silence.
 * `assertNoForbiddenAccountingOutput` maps the offending key onto the exact
 * {@link RetailForbiddenAccountingComponent} and says why retail can never carry
 * it. It is the `assertNoForbiddenPricingComponent` device from #120, applied at
 * the stage where the money would actually be KEPT rather than charged.
 *
 * ## Why this is a second detector and not a reuse of #120's
 *
 * The two vocabularies overlap and are not the same. #120 refuses inputs to a
 * PRICE — `markup`, `padding`, a support-cost allowance — and its patterns are
 * tuned to that. This refuses names for an OUTPUT — `realizedMargin`,
 * `toleranceRetention`, `unclaimedAdjustmentRevenue`, `breakage` — which #120
 * has no member for, because none of them is a thing anybody would try to put
 * into a quote. Sharing one table would mean one of the two answering with
 * somebody else's prohibition, and a refusal that names the wrong rule teaches
 * the wrong lesson.
 *
 * ## The patterns match SHAPES, not spellings
 *
 * `marginBps`, `margin_target`, `GrossMargin` and `MARGIN` are one attempt. The
 * patterns are case-insensitive substring shapes over the normalized key, and
 * the table is ORDERED so the more specific one wins.
 */

import {
  RETAIL_FORBIDDEN_ACCOUNTING_COMPONENT_LABELS,
  type RetailForbiddenAccountingComponent,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** One forbidden-output shape, matched against the normalized key. */
interface ForbiddenPattern {
  kind: RetailForbiddenAccountingComponent;
  pattern: RegExp;
}

/**
 * Ordered most-specific first.
 *
 * `unclaimedadjustmentrevenue` must be reported as
 * `unclaimed_adjustment_revenue` rather than as the generic `variance_revenue` a
 * later rule would catch, and `referralmarginbase` as the referral boundary
 * rather than as a plain margin — the specific answer is the one that tells an
 * operator which rule they met.
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { kind: 'referral_margin_base', pattern: /referral|ambassador|affiliate/ },
  {
    kind: 'unclaimed_adjustment_revenue',
    pattern: /unclaimed|uncollected|abandonedadjustment|lapsedadjustment/,
  },
  { kind: 'breakage_revenue', pattern: /breakage|escheat|forfeit/ },
  { kind: 'supplier_credit_revenue', pattern: /creditrevenue|creditincome|rebateincome/ },
  { kind: 'tolerance_retention', pattern: /retention|retain|keepdifference|tolerancekeep/ },
  { kind: 'rounding_profit', pattern: /roundingprofit|roundinggain|residualgain|dustincome/ },
  { kind: 'variance_revenue', pattern: /variancerevenue|varianceincome|variancegain/ },
  { kind: 'realized_margin', pattern: /realized|realised/ },
  { kind: 'gross_profit', pattern: /grossprofit|grossmargin/ },
  { kind: 'net_profit', pattern: /netprofit|netmargin|netincome/ },
  { kind: 'item_profit', pattern: /itemprofit|unitprofit|perorderprofit/ },
  { kind: 'planned_margin', pattern: /margin/ },
  { kind: 'retail_markup_revenue', pattern: /markup|uplift/ },
  { kind: 'retail_margin_revenue', pattern: /profit|takerate|contribution|earnings/ },
];

/** One detected attempt: the key that was sent, and what it amounts to. */
export interface ForbiddenAccountingOutputMatch {
  key: string;
  kind: RetailForbiddenAccountingComponent;
  /** The sentence explaining why retail can never carry it. */
  reason: string;
}

/** `margin_bps` / `marginBps` / `Margin Bps` → `marginbps`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which of `keys` name a forbidden accounting output, in input order. Pure — the
 * same keys always yield the same matches, so a refusal message is reproducible
 * in a test and in an operator's terminal.
 */
export function detectForbiddenAccountingOutputs(
  keys: readonly string[],
): ForbiddenAccountingOutputMatch[] {
  const matches: ForbiddenAccountingOutputMatch[] = [];
  for (const key of keys) {
    const haystack = normalizeKey(key);
    const hit = FORBIDDEN_PATTERNS.find((entry) => entry.pattern.test(haystack));
    if (hit) {
      matches.push({
        key,
        kind: hit.kind,
        reason: RETAIL_FORBIDDEN_ACCOUNTING_COMPONENT_LABELS[hit.kind],
      });
    }
  }
  return matches;
}

/**
 * Refuse a body that reaches for a forbidden accounting output, naming what it
 * is and why `mercaria_retail` cannot carry it.
 *
 * A `validationError` and not a `conflict`: the request is malformed against the
 * commercial model, and the caller can fix it by not sending the field.
 *
 * @param keys The candidate field names — an operator body's own keys.
 * @param context Where the attempt arrived, so the message says which surface
 *   refused it.
 */
export function assertNoForbiddenAccountingOutput(keys: readonly string[], context: string): void {
  const matches = detectForbiddenAccountingOutputs(keys);
  if (matches.length === 0) {
    return;
  }
  const detail = matches
    .map((match) => `\`${match.key}\` is ${match.reason} (${match.kind})`)
    .join('; ');
  throw validationError(
    `${context}: mercaria_retail reconciles to COST and has no account in which a margin could ` +
      `accumulate, so this cannot be configured — ${detail}. A difference between what the ` +
      'buyer paid and what the order finally cost is the buyer’s money or Mercaria’s loss, ' +
      'and there is no third destination.',
  );
}
