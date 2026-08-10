/**
 * The seven signal derivations (#82 §"User-facing signals") — ONE pure function,
 * and both readers call it.
 *
 * The public product-page read and the merchant competitiveness read differ in
 * exactly one input — which offer is the FOCUS — and in nothing else. Two
 * derivations of one claim can disagree, and the place that must never happen is
 * a merchant's dashboard telling them their price is competitive while the
 * shopper's page says otherwise.
 *
 * ## The three states, and why the middle one exists
 *
 * `measured` carries a value and its evidence. `unmeasured` carries a reason and
 * NEITHER. Between them sits `not_present`, which is the one people collapse: it
 * means the derivation RAN over a sample that cleared every floor and the
 * condition does not hold — there was no material drop, no verified official
 * store publishes an offer. Reporting that as `unmeasured` tells a merchant their
 * data is too thin when it is fine; reporting it as `measured` with a zero tells
 * a shopper there was a drop of nothing.
 *
 * ## Nothing here converts a currency, reads a clock or touches a database
 *
 * Every amount arrives already expressed in the subject's currency, and every
 * publishable figure arrives as a {@link PriceHistoryValue} that already names
 * its FX basis. That is what makes the whole issue's acceptance 4 — reproducible
 * from immutable observations and a policy version — a property of this file's
 * SIGNATURE rather than of its discipline.
 */

import {
  PRICE_SIGNAL_KINDS,
  PRICE_SIGNAL_MEASURE,
  PRICE_MEASURE_INCLUDES_DELIVERY,
  priceDeltaBps,
  priceMarketPositionFor,
  priceQualityConfidenceFor,
  priceQualityLabelFor,
  priceSampleShortfall,
  type ConditionGroup,
  type CurrencyCode,
  type PriceHistoryValue,
  type PriceSeriesScopeKind,
  type PriceSignal,
  type PriceSignalFocus,
  type PriceSignalKind,
  type PriceSignalPolicy,
  type PriceSignalSample,
  type PriceSignalSubject,
  type PriceSignalUnmeasuredReason,
} from '@mercaria/shared-types';
import { buildSample, EMPTY_PRICE_SIGNAL_SAMPLE, type BuiltSample } from './sample.js';
import { lowerMedianIndex, nearestRankIndex, type PriceSampleEntry } from './statistics.js';

/** Everything a subject is, minus the two fields each signal fixes for itself. */
export interface PriceSignalScope {
  readonly scopeKind: PriceSeriesScopeKind;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly segment: ConditionGroup;
  readonly market?: string;
  readonly currency: CurrencyCode;
  readonly from: string;
  readonly to: string;
  readonly focus: PriceSignalFocus;
}

/**
 * Everything the derivation reads.
 *
 * The absent fields are the enforcement, as they are in `OfferRankingFacts` and
 * `analytics_events`: there is no commission, no plan, no fee, no margin and no
 * buyer here, so no derivation below can read one whatever anybody later wants it
 * to do. Adding one would be a visible act against a failing gate.
 */
export interface PriceSignalDerivationInput {
  readonly scope: PriceSignalScope;
  /**
   * The active policy, or ABSENT.
   *
   * Absent makes every signal `unmeasured`/`no_active_policy`, which is the
   * deliberate divergence from #74's built-in policy. A ranking must produce SOME
   * order or the comparison surface has none; a signal need produce no claim at
   * all, and "nobody has decided what 'good price' means here" is the purest
   * insufficient sample there is.
   */
  readonly policy?: PriceSignalPolicy;
  /** Cross-sectional: every eligible offer's item price, right now. */
  readonly currentItemPrice: readonly PriceSampleEntry[];
  /** Cross-sectional: every eligible offer whose delivery cost was published. */
  readonly currentKnownTotal: readonly PriceSampleEntry[];
  /** Longitudinal: one point per bucket over the window. */
  readonly historyItemPrice: readonly PriceSampleEntry[];
  readonly historyKnownTotal: readonly PriceSampleEntry[];
  /** The entry every "current price" signal is ABOUT. */
  readonly focusItemPrice?: PriceSampleEntry;
  readonly focusKnownTotal?: PriceSampleEntry;
  /**
   * Sellers #55 has VERIFIED as an official channel for this scope's brand.
   *
   * Empty is the ordinary state and makes `official_store_position`
   * `not_present`: a merchant with no verified relationship has no relationship
   * row at all, and a domain match or a name match cannot create one.
   */
  readonly officialSellerKeys: ReadonlySet<string>;
  /**
   * Entry id → the figure to publish for it, carrying #78's FX basis.
   *
   * The map rather than a field on the entry, because an entry is a NUMBER the
   * statistics operate on and a value is a FACT a consumer renders, and merging
   * them is how a `current_rate_reinterpretation` ends up in an arithmetic mean.
   */
  readonly values: ReadonlyMap<string, PriceHistoryValue>;
}

/** Derive every signal for one subject. */
export function derivePriceSignals(input: PriceSignalDerivationInput): PriceSignal[] {
  const policy = input.policy;
  if (policy === undefined) {
    return PRICE_SIGNAL_KINDS.map((kind) => ({
      kind,
      state: 'unmeasured' as const,
      subject: subjectFor(input.scope, kind),
      sample: EMPTY_PRICE_SIGNAL_SAMPLE,
      reason: 'no_active_policy' as const,
    }));
  }

  return [
    lowestObserved(input, policy, 'lowest_observed_item_price', input.historyItemPrice),
    lowestObserved(input, policy, 'lowest_observed_known_total', input.historyKnownTotal),
    currentVersusRecentMedian(input, policy),
    materialPriceDrop(input, policy),
    typicalRecentRange(input, policy),
    officialStorePosition(input, policy),
    priceQualityLabel(input, policy),
  ];
}

/** The subject one signal is about — `measure` and `deliveryIncluded` are its own. */
export function subjectFor(scope: PriceSignalScope, kind: PriceSignalKind): PriceSignalSubject {
  const measure = PRICE_SIGNAL_MEASURE[kind];
  return {
    scopeKind: scope.scopeKind,
    ...(scope.canonicalProductId === undefined ? {} : { canonicalProductId: scope.canonicalProductId }),
    ...(scope.canonicalVariantId === undefined ? {} : { canonicalVariantId: scope.canonicalVariantId }),
    segment: scope.segment,
    ...(scope.market === undefined ? {} : { market: scope.market }),
    currency: scope.currency,
    measure,
    deliveryIncluded: PRICE_MEASURE_INCLUDES_DELIVERY[measure],
    // #78's seam, restated where a consumer reads it: `offers` records no
    // tax-inclusion fact, so every subject says so rather than implying one.
    taxInclusion: 'unknown',
    from: scope.from,
    to: scope.to,
    focus: scope.focus,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The seven                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Issue items 1 and 2 — the lowest value observed in a NAMED range.
 *
 * The low is taken from the sample AFTER the robust filter, which is acceptance
 * 2: "a source anomaly cannot generate a public historic low". One retailer's
 * decimal-point error is set aside and NAMED in
 * `evidence.excludedOutlierObservationIds` rather than deleted, so an operator
 * can see the thing that would otherwise have become a headline.
 *
 * The filter is a CONJUNCTION — a modified z-score AND a relative floor — for a
 * reason this signal makes sharpest: the z-score alone would exclude a genuine
 * half-price sale on a tight market, so "recent low" would report everything
 * except the sale it exists to report. `partitionOutliers` states the whole
 * argument.
 *
 * The residual cost is stated rather than hidden: a discount deeper than the
 * policy's floor is reported as excluded rather than published as the low. That
 * is the direction to be wrong in — a low nobody could have paid is worse than a
 * low nobody was shown, because only the first one gets screenshotted — and it is
 * a POLICY number, so an operator can move it and see what moved.
 */
function lowestObserved(
  input: PriceSignalDerivationInput,
  policy: PriceSignalPolicy,
  kind: PriceSignalKind,
  entries: readonly PriceSampleEntry[],
): PriceSignal {
  const subject = subjectFor(input.scope, kind);
  if (entries.length === 0) {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'no_comparable_history');
  }

  const built = buildSample(entries, {
    deduplicate: false,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });
  const shortfall = priceSampleShortfall(built.sample, policy);
  if (shortfall !== undefined) return unmeasured(kind, subject, built.sample, shortfall, policy);

  // `kept` is ascending, so the low is the head. Written as an index rather than
  // a `reduce` so the tie-break is the module's ONE total order and not a second
  // spelling of it.
  const winner = built.kept[0];
  const value = winner === undefined ? undefined : input.values.get(winner.id);
  if (winner === undefined || value === undefined) {
    return unmeasured(kind, subject, built.sample, 'no_comparable_history', policy);
  }

  return {
    kind,
    state: 'measured',
    subject,
    sample: built.sample,
    policyVersion: policy.version,
    value: { measure: 'money', value },
    evidence: evidenceFor([winner], built),
  };
}

/**
 * Issue item 3 — the current price against the median of the RECENT history.
 *
 * Deliberately TEMPORAL, and deliberately not the same signal as
 * `position_vs_eligible_median`, which is cross-sectional. "Cheap for this
 * product lately" and "cheap compared with other sellers today" are different
 * claims about different things, and a shopper shown one number could not tell
 * which they were being told.
 */
function currentVersusRecentMedian(
  input: PriceSignalDerivationInput,
  policy: PriceSignalPolicy,
): PriceSignal {
  const kind: PriceSignalKind = 'current_vs_recent_median';
  const subject = subjectFor(input.scope, kind);
  const focus = input.focusItemPrice;
  if (focus === undefined) {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'no_eligible_current_offer', policy);
  }
  if (input.historyItemPrice.length === 0) {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'no_comparable_history', policy);
  }

  const built = buildSample(input.historyItemPrice, {
    deduplicate: false,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });
  const shortfall = priceSampleShortfall(built.sample, policy);
  if (shortfall !== undefined) return unmeasured(kind, subject, built.sample, shortfall, policy);

  return relativeSignal(input, policy, kind, subject, built, focus);
}

/**
 * Issue item 4 — a material fall against a prior VALID observation.
 *
 * "Prior valid" is what makes this safe: the history it reads has already had
 * #78's anomaly flags, quarantines, superseded corrections and rights
 * withdrawals removed, and this module's own robust filter has set aside the
 * rest. A scale error therefore cannot manufacture a 90% drop, which is the one
 * thing a price-drop badge must never do.
 *
 * A rise, an unchanged price, and a fall smaller than the policy's threshold are
 * all `not_present` — MEASURED, and different from "we could not tell".
 */
function materialPriceDrop(
  input: PriceSignalDerivationInput,
  policy: PriceSignalPolicy,
): PriceSignal {
  const kind: PriceSignalKind = 'material_price_drop';
  const subject = subjectFor(input.scope, kind);
  const focus = input.focusItemPrice;
  if (focus === undefined) {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'no_eligible_current_offer', policy);
  }
  if (input.historyItemPrice.length === 0) {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'no_comparable_history', policy);
  }

  const built = buildSample(input.historyItemPrice, {
    deduplicate: false,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });
  const shortfall = priceSampleShortfall(built.sample, policy);
  if (shortfall !== undefined) return unmeasured(kind, subject, built.sample, shortfall, policy);

  // The most recent surviving observation whose amount DIFFERS from the current
  // one. Newest-first over the kept set, which is ordered by amount, so it is
  // re-sorted by time here rather than assumed.
  const byTimeDesc = [...built.kept].sort(
    (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
  );
  const previous = byTimeDesc.find((entry) => entry.amount !== focus.amount);
  if (previous === undefined) {
    return { kind, state: 'not_present', subject, sample: built.sample, policyVersion: policy.version };
  }

  const deltaBps = priceDeltaBps(focus.amount, previous.amount);
  if (deltaBps > -policy.materialDropBps) {
    return { kind, state: 'not_present', subject, sample: built.sample, policyVersion: policy.version };
  }

  const current = input.values.get(focus.id);
  const before = input.values.get(previous.id);
  if (current === undefined || before === undefined) {
    return unmeasured(kind, subject, built.sample, 'no_comparable_history', policy);
  }

  return {
    kind,
    state: 'measured',
    subject,
    sample: built.sample,
    policyVersion: policy.version,
    value: { measure: 'drop', current, previous: before, deltaBps },
    evidence: evidenceFor([focus, previous], built),
  };
}

/**
 * Issue item 5 — the typical recent range.
 *
 * The inter-quartile range of the outlier-filtered sample, at NEAREST RANK, so
 * both endpoints are prices somebody actually published and each names its own
 * observation. An interpolated quartile is a number no seller ever asked for, and
 * "typical" is a claim that has to be answerable with "this one, and this one".
 */
function typicalRecentRange(
  input: PriceSignalDerivationInput,
  policy: PriceSignalPolicy,
): PriceSignal {
  const kind: PriceSignalKind = 'typical_recent_range';
  const subject = subjectFor(input.scope, kind);
  if (input.historyItemPrice.length === 0) {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'no_comparable_history', policy);
  }

  const built = buildSample(input.historyItemPrice, {
    deduplicate: false,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });
  const shortfall = priceSampleShortfall(built.sample, policy);
  if (shortfall !== undefined) return unmeasured(kind, subject, built.sample, shortfall, policy);

  const lowIndex = nearestRankIndex(built.kept.length, 0.25);
  const highIndex = nearestRankIndex(built.kept.length, 0.75);
  const lowEntry = lowIndex === undefined ? undefined : built.kept[lowIndex];
  const highEntry = highIndex === undefined ? undefined : built.kept[highIndex];
  const low = lowEntry === undefined ? undefined : input.values.get(lowEntry.id);
  const high = highEntry === undefined ? undefined : input.values.get(highEntry.id);
  if (lowEntry === undefined || highEntry === undefined || low === undefined || high === undefined) {
    return unmeasured(kind, subject, built.sample, 'no_comparable_history', policy);
  }

  return {
    kind,
    state: 'measured',
    subject,
    sample: built.sample,
    policyVersion: policy.version,
    value: { measure: 'money_range', low, high },
    evidence: evidenceFor([lowEntry, highEntry], built),
  };
}

/**
 * Issue item 6 — the official store's price against OTHER new offers.
 *
 * Two things are load-bearing and both come from the issue's own wording.
 *
 * "Other new offers" means the reference sample EXCLUDES the official seller's
 * own entries: comparing a price against a median it is itself in understates the
 * gap, and on a thin market a single official offer would be compared against
 * itself.
 *
 * "New offers" means the signal is defined for the `new` segment only. Asked for
 * `used`, it answers `unmeasured`/`segment_not_applicable` rather than quietly
 * comparing a refurbished price against a brand's own retail one — which is issue
 * item 7's separation, arriving where it would otherwise be easiest to lose.
 */
function officialStorePosition(
  input: PriceSignalDerivationInput,
  policy: PriceSignalPolicy,
): PriceSignal {
  const kind: PriceSignalKind = 'official_store_position';
  const subject = subjectFor(input.scope, kind);
  if (input.scope.segment !== 'new') {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'segment_not_applicable', policy);
  }

  const official = input.currentItemPrice.filter((entry) =>
    input.officialSellerKeys.has(entry.sellerKey),
  );
  const others = input.currentItemPrice.filter(
    (entry) => !input.officialSellerKeys.has(entry.sellerKey),
  );

  const built = buildSample(others, {
    deduplicate: true,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });

  if (official.length === 0) {
    // MEASURED and absent: #55 has verified nobody as an official channel for
    // this brand, which is the ordinary state and a fact rather than a gap.
    return { kind, state: 'not_present', subject, sample: built.sample, policyVersion: policy.version };
  }

  const shortfall = priceSampleShortfall(built.sample, policy);
  if (shortfall !== undefined) return unmeasured(kind, subject, built.sample, shortfall, policy);

  const officialEntry = [...official].sort((left, right) => left.amount - right.amount)[0];
  if (officialEntry === undefined) {
    return unmeasured(kind, subject, built.sample, 'no_eligible_current_offer', policy);
  }
  return relativeSignal(input, policy, kind, subject, built, officialEntry);
}

/**
 * Issue item 8 — the label, backed by a documented policy AND a confidence.
 *
 * Cross-sectional: the focus price against the median of every eligible offer,
 * one per seller. The label is `priceQualityLabelFor`'s and the confidence is
 * `priceQualityConfidenceFor`'s, and both live in `@mercaria/shared-types`
 * because the copy in `@mercaria/ui` keys on them.
 *
 * There is no `low` confidence: a sample that does not clear the floors produces
 * NO label, which is acceptance 3. That is why a two-valued confidence is not
 * decoration — it is the visible half of a rule whose other half is a refusal.
 */
function priceQualityLabel(
  input: PriceSignalDerivationInput,
  policy: PriceSignalPolicy,
): PriceSignal {
  const kind: PriceSignalKind = 'price_quality_label';
  const subject = subjectFor(input.scope, kind);
  const focus = input.focusItemPrice;
  if (focus === undefined) {
    return unmeasured(kind, subject, EMPTY_PRICE_SIGNAL_SAMPLE, 'no_eligible_current_offer', policy);
  }

  const built = buildSample(input.currentItemPrice, {
    deduplicate: true,
    outlierModifiedZThreshold: policy.outlierModifiedZThreshold,
    outlierMinDeviationBps: policy.outlierMinDeviationBps,
  });
  const shortfall = priceSampleShortfall(built.sample, policy);
  if (shortfall !== undefined) return unmeasured(kind, subject, built.sample, shortfall, policy);

  const medianIndex = lowerMedianIndex(built.kept);
  const medianEntry = medianIndex === undefined ? undefined : built.kept[medianIndex];
  const reference = medianEntry === undefined ? undefined : input.values.get(medianEntry.id);
  const current = input.values.get(focus.id);
  if (medianEntry === undefined || reference === undefined || current === undefined) {
    return unmeasured(kind, subject, built.sample, 'no_eligible_current_offer', policy);
  }

  const deltaBps = priceDeltaBps(focus.amount, medianEntry.amount);
  return {
    kind,
    state: 'measured',
    subject,
    sample: built.sample,
    policyVersion: policy.version,
    value: {
      measure: 'label',
      current,
      reference,
      deltaBps,
      label: priceQualityLabelFor(deltaBps, policy),
      confidence: priceQualityConfidenceFor(built.sample, policy),
    },
    evidence: evidenceFor([focus, medianEntry], built),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Shared shapes                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The median-relative signal both `current_vs_recent_median` and
 * `official_store_position` produce.
 *
 * One function, because the two claims differ in their SAMPLE and not in their
 * arithmetic, and a second copy of "compare against the median and band it"
 * would be a second place for the band to be applied asymmetrically.
 */
function relativeSignal(
  input: PriceSignalDerivationInput,
  policy: PriceSignalPolicy,
  kind: PriceSignalKind,
  subject: PriceSignalSubject,
  built: BuiltSample,
  focus: PriceSampleEntry,
): PriceSignal {
  const medianIndex = lowerMedianIndex(built.kept);
  const medianEntry = medianIndex === undefined ? undefined : built.kept[medianIndex];
  const reference = medianEntry === undefined ? undefined : input.values.get(medianEntry.id);
  const current = input.values.get(focus.id);
  if (medianEntry === undefined || reference === undefined || current === undefined) {
    return unmeasured(kind, subject, built.sample, 'no_comparable_history', policy);
  }

  const deltaBps = priceDeltaBps(focus.amount, medianEntry.amount);
  return {
    kind,
    state: 'measured',
    subject,
    sample: built.sample,
    policyVersion: policy.version,
    value: {
      measure: 'relative',
      current,
      reference,
      deltaBps,
      position: priceMarketPositionFor(deltaBps, policy.typicalBandBps),
    },
    evidence: evidenceFor([focus, medianEntry], built),
  };
}

/**
 * The observations a claim cites, plus the ones the robust method set aside.
 *
 * The excluded list travels on EVERY measured signal rather than only where an
 * exclusion changed the answer, because "nothing was excluded" and "we do not
 * report exclusions" are indistinguishable from an empty field that is sometimes
 * populated.
 */
function evidenceFor(cited: readonly PriceSampleEntry[], built: BuiltSample) {
  return {
    observationIds: [...new Set(cited.map((entry) => entry.id))],
    offerIds: [...new Set(cited.map((entry) => entry.offerId))],
    excludedOutlierObservationIds: built.excluded.map((entry) => entry.id),
  };
}

/** The unmeasured branch, with no value and no evidence for anyone to read. */
function unmeasured(
  kind: PriceSignalKind,
  subject: PriceSignalSubject,
  sample: PriceSignalSample,
  reason: PriceSignalUnmeasuredReason,
  policy?: PriceSignalPolicy,
): PriceSignal {
  return {
    kind,
    state: 'unmeasured',
    subject,
    sample,
    reason,
    ...(policy === undefined ? {} : { policyVersion: policy.version }),
  };
}
