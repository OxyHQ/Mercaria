/**
 * The completeness gate (#120 "Completeness gate", ADR 0004 D3) — PURE.
 *
 * **An unknown direct cost is never zero.** A retail offer whose material costs
 * are not all quotable is not purchasable, in the same way an unready seller's
 * checkout group is refused under ADR 0001 D9. This module is where that fails
 * CLOSED, and it is pure so the four worked examples in #120 are table tests
 * rather than integration fixtures.
 *
 * ## The three questions it answers, and why they are separate
 *
 * `completeness` is what the quote KNOWS. `presentation` is what a public
 * surface may SHOW. `checkoutEligible` is whether money may move. They are not
 * the same question and collapsing them is exactly the bug #120 is guarding
 * against: an offer whose shipping is not yet quotable is perfectly showable as
 * a clearly-qualified STARTING item cost, and must never be shown as a
 * guaranteed final total.
 *
 * The mapping from `completeness` to `presentation` is one-to-one and is ALSO a
 * CHECK on `retail_cost_quotes`, so a row cannot be stored claiming an exact
 * price while carrying a block reason.
 *
 * ## Expiry is derived from the clock, never stored as a state
 *
 * A complete quote that has expired is still complete — its costs were known.
 * What it is not is chargeable. So expiry is a conjunct of `checkoutEligible`
 * and is NOT a `completeness` value: the `procurement-eligibility` rule
 * (`deriveOfferFreshness`), applied to money. A stored "expired" state beside
 * `expires_at` would be two representations of one fact, and the place they
 * must not disagree is a checkout gate.
 *
 * ## Why `undocumented` is an input rather than an inference
 *
 * "The supplier has a handling fee it will not document" is not the same fact
 * as "no handling component was quoted". The first is INELIGIBLE — Mercaria
 * knows a cost exists and cannot state it. The second may simply mean the
 * supplier charges none. Only the caller (#122's preflight, #118's agreement
 * record) can tell them apart, so the caller states it and this module refuses
 * to guess.
 */

import type {
  RetailCompletenessVerdict,
  RetailCostBlockReason,
  RetailCostComponentKind,
  RetailPricePresentation,
  RetailQuoteCompleteness,
} from '@mercaria/shared-types';

/** What the gate looks at. Every field is a FACT the caller established. */
export interface RetailCompletenessInput {
  /**
   * The component kinds the ACTIVE policy version approves. A quoted component
   * outside this set is refused (ADR 0004 D3.7) — an unapproved cost may not
   * enter a customer amount, however real it is.
   */
  allowedComponentKinds: readonly RetailCostComponentKind[];
  /**
   * The kinds that APPLY to this order: the item cost always, shipping once a
   * destination is known, tax where the market charges it, a handling fee where
   * the supplier levies one.
   */
  applicableKinds: readonly RetailCostComponentKind[];
  /** The kinds actually quoted, with an amount and a named source. */
  quotedKinds: readonly RetailCostComponentKind[];
  /**
   * Kinds KNOWN to apply whose amount the source will not document — an
   * undisclosed supplier handling fee is the worked example. Ineligible, never
   * priced at zero.
   */
  undocumentedKinds?: readonly RetailCostComponentKind[];
  /** ISO-3166-1 alpha-2, or absent when the buyer has given no destination yet. */
  destinationCountry?: string;
  /**
   * Whether the market's tax/customs treatment could be determined at all.
   * `false` BLOCKS that market — it never means zero tax.
   */
  taxTreatmentDetermined: boolean;
  /** Whether the agreement and compliance gates admit this destination (#121's verdict). */
  marketSupported: boolean;
  /** The quote's own deadline, and the clock to read it against. */
  expiresAt?: Date;
  now?: Date;
}

/** Which block reason a missing component of each kind produces. */
const MISSING_KIND_REASON: Record<RetailCostComponentKind, RetailCostBlockReason> = {
  supplier_item: 'supplier_price_unavailable',
  supplier_variant_surcharge: 'supplier_price_unavailable',
  supplier_handling: 'undocumented_supplier_fee',
  destination_shipping: 'shipping_not_quotable',
  tax_duty: 'tax_undetermined',
  fx_cost: 'fx_rate_unavailable',
  payment_processing: 'payment_cost_undetermined',
  other_direct_fulfilment: 'component_not_permitted_by_policy',
};

/**
 * The kinds that cannot even be ASKED about without a destination. Their
 * absence from a destination-less quote is not a missing cost — it is a
 * question that has not been posed yet, which is the whole difference between
 * "informational starting price" and "ineligible offer".
 */
const DESTINATION_DEPENDENT_KINDS: ReadonlySet<RetailCostComponentKind> = new Set<
  RetailCostComponentKind
>(['destination_shipping', 'tax_duty']);

/** The one-to-one mapping the `retail_cost_quotes` CHECK also enforces. */
const PRESENTATION_BY_COMPLETENESS: Record<RetailQuoteCompleteness, RetailPricePresentation> = {
  complete: 'exact_cost_only',
  awaiting_destination: 'starting_item_cost',
  blocked_undocumented_cost: 'not_purchasable',
  blocked_tax_undetermined: 'not_purchasable',
  blocked_unquotable_cost: 'not_purchasable',
};

/**
 * Derive the verdict. Fails closed: anything unknown blocks, and the reasons
 * are sorted and deduped so two derivations of one situation are byte-identical
 * (the moderation-envelope determinism rule, applied to a gate).
 *
 * The order of the branches is the order of severity, and it matters: an
 * undocumented cost is a harder fact than a missing destination, so an offer
 * that is BOTH is reported as ineligible rather than as awaiting a destination.
 * Reporting the softer verdict would let an ineligible offer be published as an
 * informational starting price.
 */
export function deriveRetailCompleteness(
  input: RetailCompletenessInput,
): RetailCompletenessVerdict {
  const reasons = new Set<RetailCostBlockReason>();
  const allowed = new Set(input.allowedComponentKinds);
  const quoted = new Set(input.quotedKinds);
  const undocumented = input.undocumentedKinds ?? [];
  const hasDestination = input.destinationCountry !== undefined;

  // A component the policy has not approved may not enter a customer amount,
  // whatever its evidence — ADR 0004 D3.7 requires it to be named and versioned
  // FIRST. Checked before anything else, because an unapproved component that
  // happened to be quoted must not make a quote look complete.
  for (const kind of input.quotedKinds) {
    if (!allowed.has(kind)) {
      reasons.add('component_not_permitted_by_policy');
    }
  }
  if (input.allowedComponentKinds.length === 0) {
    reasons.add('policy_missing');
  }

  // A cost the source refuses to document is a KNOWN unknown: ineligible, and
  // never priced at zero. This holds with or without a destination.
  for (const kind of undocumented) {
    reasons.add(MISSING_KIND_REASON[kind]);
  }
  for (const kind of input.applicableKinds) {
    // Without a destination, shipping and tax have not been ASKED yet — their
    // absence is `destination_unknown` below, not a missing cost.
    if (!hasDestination && DESTINATION_DEPENDENT_KINDS.has(kind)) {
      continue;
    }
    if (!quoted.has(kind) && !undocumented.includes(kind)) {
      reasons.add(MISSING_KIND_REASON[kind]);
    }
  }

  if (!hasDestination) {
    reasons.add('destination_unknown');
  } else {
    // Market eligibility and tax determinability are questions about a concrete
    // destination; asking them without one would produce a verdict about
    // nowhere.
    if (!input.marketSupported) {
      reasons.add('market_not_supported');
    }
    if (!input.taxTreatmentDetermined) {
      reasons.add('tax_undetermined');
    }
  }

  const completeness = classify({
    hasDestination,
    marketSupported: input.marketSupported,
    taxTreatmentDetermined: input.taxTreatmentDetermined,
    undocumentedCount: undocumented.length,
    reasons,
  });
  const presentation = PRESENTATION_BY_COMPLETENESS[completeness];
  const expired =
    input.expiresAt !== undefined &&
    input.expiresAt.getTime() <= (input.now ?? new Date()).getTime();

  return {
    completeness,
    presentation,
    blockReasons: [...reasons].sort(),
    // A blocked quote is not publishable at all; an incomplete-but-honest one
    // is, as a clearly qualified starting cost. Expiry does not un-publish an
    // informational figure — it only stops a charge.
    publishable: completeness === 'complete' || completeness === 'awaiting_destination',
    // Money moves only when everything is known AND the quote is still live.
    checkoutEligible: completeness === 'complete' && !expired,
  };
}

/**
 * Pick the single completeness value, HARDEST FACT FIRST. Split out so the
 * branch order is readable as the policy it encodes rather than buried in the
 * accumulation above — and the order is load-bearing: an offer that is both
 * ineligible and missing a destination must report the ineligibility, or a
 * blocked offer would get published as an informational starting price.
 */
function classify(input: {
  hasDestination: boolean;
  marketSupported: boolean;
  taxTreatmentDetermined: boolean;
  undocumentedCount: number;
  reasons: ReadonlySet<RetailCostBlockReason>;
}): RetailQuoteCompleteness {
  if (input.undocumentedCount > 0) {
    return 'blocked_undocumented_cost';
  }
  // Tax before market: "we could not determine the treatment" is the more
  // specific finding, and it is the one #120's worked example names.
  if (input.hasDestination && !input.taxTreatmentDetermined) {
    return 'blocked_tax_undetermined';
  }
  // Everything except the destination itself: the honest answer is a starting
  // item cost — not a blocked offer, and not a final total.
  const outstandingBesidesDestination = [...input.reasons].filter(
    (reason) => reason !== 'destination_unknown',
  );
  if (outstandingBesidesDestination.length > 0) {
    return 'blocked_unquotable_cost';
  }
  if (!input.hasDestination) {
    return 'awaiting_destination';
  }
  return 'complete';
}

/**
 * Whether a stored quote may still be charged against. Re-derived from the row
 * and the clock, never read from a column — the #117/#120 revalidation step
 * (a supplier quote that expired while the buyer sat inside a 3DS challenge is
 * the worked example).
 */
export function isRetailQuoteChargeable(
  quote: { completeness: RetailQuoteCompleteness; expiresAt: Date },
  now: Date = new Date(),
): boolean {
  return quote.completeness === 'complete' && quote.expiresAt.getTime() > now.getTime();
}
