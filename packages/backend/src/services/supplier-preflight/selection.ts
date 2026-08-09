/**
 * Deterministic supplier selection and the substitution guard (#122 "Selection
 * and failover").
 *
 * PURE — no repository, no clock, no configuration read. The whole of #122
 * acceptance 7 ("supplier selection and failover are reproducible and never
 * change product identity silently") reduces to two properties this file holds:
 * the ORDER is a total function of the policy version plus the candidate facts,
 * and a replacement that changes what the customer was promised is refused by
 * name.
 *
 * ## A commission cannot reach this file, structurally
 *
 * {@link SourcingCandidateFacts} has no member that could hold an affiliate
 * commission, a referral payout, an organic ranking score, a paid placement, a
 * sponsored boost, a subscription tier, advertising revenue or a marketplace
 * fee yield — the eight things `SUPPLIER_FORBIDDEN_SOURCING_SIGNALS` names. The
 * comparator can only read what the facts type carries, and a policy version
 * can only rank on `SUPPLIER_SOURCING_CRITERIA`, whose CHECK is disjoint from
 * that list. `supplier-sourcing-isolation.test.ts` fails the build if any
 * module in this domain reaches the fee, referral or ranking layers, which
 * covers the route a determined author could still take.
 *
 * ## The order is TOTAL, which is what makes it reproducible
 *
 * Each criterion is a comparator returning a sign, applied in the policy's
 * declared order, and the chain ends on `procurementOfferId` — a unique,
 * immutable string. So two candidates can never compare equal, no sort
 * implementation's stability matters, and re-running a selection a week later
 * against the same facts produces the same list.
 */

import type {
  CurrencyCode,
  SupplierAdapterCapability,
  SupplierSourcingCriterion,
  SupplierSourcingReason,
  SupplierSubstitutionRefusal,
} from '@mercaria/shared-types';

/**
 * Everything selection may know about one candidate source.
 *
 * The absent members are the enforcement — see the module docblock. Every
 * present member is a property of whether this supplier can actually deliver
 * this item to this address, which is the only question selection asks.
 */
export interface SourcingCandidateFacts {
  procurementOfferId: string;
  supplierId: string;
  supplierAccountId: string;
  /** The adapter slug. Needed to know what the route can do, never to rank it. */
  provider: string;
  declaredCapabilities: readonly SupplierAdapterCapability[];
  /**
   * The complete landed cost in the requested currency, in minor units. NULL =
   * not yet known, which sorts LAST under `total_landed_cost` — an unknown cost
   * never wins a cost comparison.
   */
  landedCostMinor: number | null;
  currency: CurrencyCode;
  destinationEligible: boolean;
  /** How long ago the offer's terms were last confirmed. Smaller is fresher. */
  freshnessSeconds: number;
  /** The slow end of the delivery promise. NULL = no promise, which sorts last. */
  deliveryDaysMax: number | null;
  returnsSupported: boolean;
  /**
   * The share of answers this account got right inside the health window, in
   * basis points. NULL = no measurement, which is treated as NEUTRAL rather
   * than as bad — the `SELLER_TRUST_RESTRICTED_TIERS` rule (#92): restricting
   * on absence turns a brand-new supplier into a permanently unselectable one,
   * and turns a metrics outage into a marketplace-wide stop.
   */
  healthSuccessBps: number | null;
  /** How much of this checkout group the supplier already holds, in basis points. */
  currentShareBps: number;
  /** Whether this route is currently suppressed, and by which scope. */
  suppression: 'none' | 'supplier' | 'market';
  /** Whether the supplier account is in a state that can accept orders at all. */
  accountActive: boolean;
}

/** An absent health measurement withholds nothing — see `healthSuccessBps`. */
const NEUTRAL_HEALTH_BPS = 10_000;

/** What a policy version contributes to the decision. */
export interface SourcingPolicyFacts {
  /** The ORDERED criteria. Applied left to right; the first difference decides. */
  rankingCriteria: readonly SupplierSourcingCriterion[];
  requiredCapabilities: readonly SupplierAdapterCapability[];
  maxSourcingAttempts: number;
  maxSupplierShareBps: number;
}

/** One candidate the policy will not try, and why. */
export interface SkippedCandidate {
  candidate: SourcingCandidateFacts;
  reason: SupplierSourcingReason;
}

/** The attempt order, and everything left out of it with a reason. */
export interface SourcingSelection {
  /** In attempt order, already truncated to the policy's attempt limit. */
  ordered: readonly SourcingCandidateFacts[];
  /** Every candidate not in `ordered`, each with the reason it is not. */
  skipped: readonly SkippedCandidate[];
}

/**
 * Order the candidates a policy version would actually try.
 *
 * Filtering happens BEFORE ranking and is not a ranking signal: a suppressed
 * account, an ineligible destination, a missing required capability and an
 * over-concentration are refusals, not penalties, and a refusal that could be
 * outweighed by a low price is not a refusal.
 *
 * The truncation to `maxSourcingAttempts` is #122 selection 8 ("limit attempts
 * and avoid sequentially placing orders at several suppliers"), and it produces
 * `attempt_limit_reached` rows rather than silence — a candidate that would
 * have worked but was never tried is a fact an operator investigating a refusal
 * needs.
 */
export function selectSourcingOrder(
  candidates: readonly SourcingCandidateFacts[],
  policy: SourcingPolicyFacts,
): SourcingSelection {
  const skipped: SkippedCandidate[] = [];
  const eligible: SourcingCandidateFacts[] = [];

  for (const candidate of candidates) {
    const reason = refusalFor(candidate, policy);
    if (reason) skipped.push({ candidate, reason });
    else eligible.push(candidate);
  }

  const ranked = [...eligible].sort((left, right) => compareCandidates(left, right, policy));
  const ordered = ranked.slice(0, policy.maxSourcingAttempts);
  for (const candidate of ranked.slice(policy.maxSourcingAttempts)) {
    skipped.push({ candidate, reason: 'attempt_limit_reached' });
  }

  return { ordered, skipped };
}

/** The first refusal that applies, or `null` when the candidate may be tried. */
function refusalFor(
  candidate: SourcingCandidateFacts,
  policy: SourcingPolicyFacts,
): SupplierSourcingReason | null {
  if (candidate.suppression === 'supplier') return 'supplier_suppressed';
  if (candidate.suppression === 'market') return 'market_suppressed';
  if (!candidate.accountActive) return 'account_not_active';
  if (!candidate.destinationEligible) return 'offer_ineligible';
  const declared = new Set(candidate.declaredCapabilities);
  if (policy.requiredCapabilities.some((capability) => !declared.has(capability))) {
    return 'capability_missing';
  }
  if (candidate.currentShareBps >= policy.maxSupplierShareBps) return 'concentration_limit';
  return null;
}

/**
 * The total order.
 *
 * Every branch returns a strict sign or falls through to the next criterion,
 * and the chain ends on the offer id — so no pair is ever equal and the result
 * does not depend on the sort being stable.
 */
function compareCandidates(
  left: SourcingCandidateFacts,
  right: SourcingCandidateFacts,
  policy: SourcingPolicyFacts,
): number {
  for (const criterion of policy.rankingCriteria) {
    const sign = compareOn(criterion, left, right);
    if (sign !== 0) return sign;
  }
  return left.procurementOfferId < right.procurementOfferId ? -1 : 1;
}

function compareOn(
  criterion: SupplierSourcingCriterion,
  left: SourcingCandidateFacts,
  right: SourcingCandidateFacts,
): number {
  switch (criterion) {
    case 'total_landed_cost':
      // An unknown cost sorts last. Treating it as zero would make the source
      // that told us least look cheapest, which is `assumed_zero_shipping`
      // arriving through a comparator.
      return ascendingWithUnknownLast(left.landedCostMinor, right.landedCostMinor);
    case 'destination_eligibility':
      return booleanPreferred(left.destinationEligible, right.destinationEligible);
    case 'offer_freshness':
      return left.freshnessSeconds - right.freshnessSeconds;
    case 'delivery_promise':
      return ascendingWithUnknownLast(left.deliveryDaysMax, right.deliveryDaysMax);
    case 'return_capability':
      return booleanPreferred(left.returnsSupported, right.returnsSupported);
    case 'supplier_health':
      return (
        (right.healthSuccessBps ?? NEUTRAL_HEALTH_BPS) -
        (left.healthSuccessBps ?? NEUTRAL_HEALTH_BPS)
      );
    case 'concentration_headroom':
      return left.currentShareBps - right.currentShareBps;
    case 'reservation_capability':
      return booleanPreferred(
        left.declaredCapabilities.includes('inventory_reservation'),
        right.declaredCapabilities.includes('inventory_reservation'),
      );
  }
}

function ascendingWithUnknownLast(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function booleanPreferred(left: boolean, right: boolean): number {
  if (left === right) return 0;
  return left ? -1 : 1;
}

/**
 * What a replacement must preserve, and what the customer was told.
 *
 * Deliberately a small, flat type: comparing two of these IS the substitution
 * rule, so a fact that is not on it cannot be silently preserved-in-spirit.
 */
export interface SubstitutionSubject {
  /** The canonical identity. NULL when the offer is unmapped (#118). */
  canonicalVariantId: string | null;
  supplierSku: string;
  quantity: number;
  currency: CurrencyCode;
  /** The total the customer was quoted or would be, in minor units. */
  totalMinor: number;
  /** The slow end of the delivery promise. NULL = none was made. */
  deliveryDaysMax: number | null;
  returnsSupported: boolean;
}

/** Permitted, or refused with every promise the replacement broke. */
export type SubstitutionDecision =
  | { permitted: true }
  | { permitted: false; refusals: readonly SupplierSubstitutionRefusal[] };

/**
 * Whether a failover source may replace the one that failed (#122 selection
 * 5–6).
 *
 * Two rules, and they apply at different times on purpose:
 *
 *  - **Product identity is checked ALWAYS**, locked terms or not. #122
 *    selection 6 is unconditional: a different variant is a different thing,
 *    whatever stage checkout is at. Where both sides carry a canonical variant
 *    the comparison is that; where either does not, the supplier SKU is the
 *    only identity available and two different SKUs from two suppliers cannot
 *    be PROVEN to be the same product, so it refuses. That is what makes "do
 *    not silently substitute another variant or a used condition" a comparison
 *    of identities rather than a judgement — a refurbished unit is a different
 *    supplier SKU and, once matched, a different canonical variant.
 *  - **Commercial terms are checked only once they are LOCKED.** Before the
 *    customer has been told a price and a date, there is nothing to preserve;
 *    after, the replacement may not cost more, arrive later or return worse.
 *
 * All applicable refusals are collected rather than short-circuiting, because
 * the operator reading a failed sourcing run needs to know whether one promise
 * broke or four.
 */
export function assertSubstitutionPermitted(
  locked: SubstitutionSubject,
  replacement: SubstitutionSubject,
  options: { termsLocked: boolean },
): SubstitutionDecision {
  const refusals: SupplierSubstitutionRefusal[] = [];

  if (locked.canonicalVariantId !== null && replacement.canonicalVariantId !== null) {
    if (locked.canonicalVariantId !== replacement.canonicalVariantId) {
      refusals.push('different_canonical_variant');
    }
  } else if (locked.supplierSku !== replacement.supplierSku) {
    refusals.push('different_supplier_sku');
  }

  if (locked.quantity !== replacement.quantity) refusals.push('different_quantity');

  if (options.termsLocked) {
    if (locked.currency !== replacement.currency) refusals.push('different_currency');
    if (replacement.totalMinor > locked.totalMinor) refusals.push('higher_total_price');
    if (isSlower(locked.deliveryDaysMax, replacement.deliveryDaysMax)) {
      refusals.push('slower_delivery_commitment');
    }
    if (locked.returnsSupported && !replacement.returnsSupported) {
      refusals.push('weaker_return_capability');
    }
  }

  return refusals.length === 0
    ? { permitted: true }
    : { permitted: false, refusals: [...new Set(refusals)].sort() };
}

/**
 * Whether the replacement arrives later than what was promised.
 *
 * A replacement with NO promise against a locked one that HAD a promise is
 * slower, not equal: withdrawing a delivery date the customer was given is
 * exactly the silent downgrade #122 selection 6 forbids.
 */
function isSlower(lockedDays: number | null, replacementDays: number | null): boolean {
  if (lockedDays === null) return false;
  if (replacementDays === null) return true;
  return replacementDays > lockedDays;
}
