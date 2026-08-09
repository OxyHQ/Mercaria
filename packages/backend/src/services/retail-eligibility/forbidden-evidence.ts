/**
 * The fourteen things that are never resale authority (#121 acceptance 1, ADR
 * 0004 D2.10) — the DETECTOR.
 *
 * ## This module is the second line, not the first
 *
 * An affiliate feed is already unstorable as resale evidence before anything
 * here runs: `retail_resale_evidence.kind` CHECKs against
 * `RETAIL_RESALE_EVIDENCE_KINDS`, `RETAIL_FORBIDDEN_EVIDENCE_KINDS` is a
 * disjoint union with no representation in any column, and a policy version's
 * `required_resale_evidence_kinds` is containment-CHECKed against the same
 * allowed tuple. That is what "never sufficient evidence" means structurally —
 * not a validator that says no.
 *
 * What this module adds is the ANSWER. A `.strict()` zod schema refuses an
 * unknown `kind` with "invalid enum value", which reads as a typo rather than
 * as an attempt at something the commercial model forbids.
 * `assertNoForbiddenResaleEvidence` maps the offered value onto the exact
 * {@link RetailForbiddenEvidenceKind} and explains why it proves nothing — an
 * operator who submits `affiliate_feed` is told that an affiliate agreement
 * grants linking and commission rights and never a right to resell.
 *
 * The `services/retail-pricing/forbidden-components.ts` device (#120), one
 * domain over and for the same reason: the schema is the wall, this is the sign
 * on it.
 *
 * ## The patterns match SHAPES, not spellings
 *
 * `affiliateFeed`, `affiliate_product_feed` and `AFFILIATE FEED` are one
 * attempt. The patterns are therefore case-insensitive shapes over the
 * normalized value, and the table is ORDERED so the more specific pattern wins:
 * `affiliate_product_feed` must be reported as `affiliate_product_feed` and not
 * as the generic `affiliate_program_membership` a broader rule would catch,
 * because a refusal that names the wrong prohibition teaches the wrong lesson.
 */

import {
  RETAIL_FORBIDDEN_EVIDENCE_LABELS,
  type RetailForbiddenEvidenceKind,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** One forbidden shape. `pattern` runs against the lower-cased, separator-stripped value. */
interface ForbiddenPattern {
  kind: RetailForbiddenEvidenceKind;
  pattern: RegExp;
}

/**
 * Ordered most-specific first. Every entry is a distinct ATTEMPT somebody might
 * make in good faith, and the point of the ordering is that each is answered
 * with the reason that actually applies to it.
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { kind: 'affiliate_product_feed', pattern: /affiliate.*(feed|catalog|catalogue|datafeed)/ },
  { kind: 'affiliate_program_membership', pattern: /affiliate|partnerprogram|commissionjunction|awin/ },
  { kind: 'price_comparison_feed', pattern: /pricecomparison|comparisonfeed|aggregatorfeed|shoppingfeed/ },
  { kind: 'api_key_possession', pattern: /apikey|accesstoken|clientsecret|credential/ },
  { kind: 'public_api_access', pattern: /publicapi|openapi|apiaccess|developerapi/ },
  { kind: 'public_product_page', pattern: /productpage|publicpage|weblisting|storefronturl/ },
  { kind: 'placed_consumer_order', pattern: /placedorder|testorder|consumerorder|trialpurchase/ },
  { kind: 'consumer_account_capability', pattern: /consumeraccount|retailaccount|customeraccount|primeaccount/ },
  { kind: 'marketplace_seller_account', pattern: /selleraccount|marketplaceaccount|sellercentral/ },
  { kind: 'supplier_category_label', pattern: /categorylabel|categorytag|suppliercategory/ },
  { kind: 'supplier_logo_or_branding', pattern: /logo|brandmark|trademarkimage/ },
  { kind: 'screenshot_of_listing', pattern: /screenshot|screencapture|pagecapture/ },
  { kind: 'unverified_self_declaration', pattern: /selfdeclar|selfcertif|selfattest/ },
  { kind: 'verbal_assurance', pattern: /verbal|phonecall|handshake|weweretold/ },
];

/** One detected attempt: what was offered, and what it amounts to. */
export interface ForbiddenEvidenceMatch {
  value: string;
  kind: RetailForbiddenEvidenceKind;
  /** The sentence explaining why it proves nothing about a right to resell. */
  reason: string;
}

/** `affiliate_feed` / `affiliateFeed` / `Affiliate Feed` → `affiliatefeed`. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which of `values` name something that can never be resale authority, in input
 * order. Pure — the same input always yields the same matches, so a refusal is
 * reproducible in a test and in an operator's terminal.
 */
export function detectForbiddenResaleEvidence(
  values: readonly string[],
): ForbiddenEvidenceMatch[] {
  const matches: ForbiddenEvidenceMatch[] = [];
  for (const value of values) {
    const haystack = normalize(value);
    const hit = FORBIDDEN_PATTERNS.find((entry) => entry.pattern.test(haystack));
    if (hit) {
      matches.push({ value, kind: hit.kind, reason: RETAIL_FORBIDDEN_EVIDENCE_LABELS[hit.kind] });
    }
  }
  return matches;
}

/**
 * Refuse an evidence submission that offers something that can never authorize
 * a resale, naming what it is and why.
 *
 * A `validationError` and not a `conflict`: the request is malformed against
 * the commercial model, and the caller can fix it by submitting an actual
 * grant.
 *
 * @param values The candidate evidence kinds, labels or free-text descriptors
 *   the caller sent.
 * @param context Where the attempt arrived, so the message says which surface
 *   refused it.
 */
export function assertNoForbiddenResaleEvidence(
  values: readonly string[],
  context: string,
): void {
  const matches = detectForbiddenResaleEvidence(values);
  if (matches.length === 0) {
    return;
  }
  const detail = matches
    .map((match) => `\`${match.value}\` is ${match.reason} (${match.kind})`)
    .join('; ');
  throw validationError(
    `${context}: mercaria_retail requires a WRITTEN grant of resale and direct-to-customer ` +
      `fulfilment under Mercaria's own checkout, so this cannot be recorded as resale ` +
      `authorization — ${detail}. A source that cannot sign such an agreement is ` +
      'external_referral material, not a supplier (ADR 0004 D2.10).',
  );
}
