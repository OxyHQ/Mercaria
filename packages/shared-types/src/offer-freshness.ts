/**
 * Source-aware offer freshness, refresh scheduling and catalogue health —
 * issue #68, extending #57's offer model and #62's ingestion framework.
 *
 * ## The one rule this file exists to make structural: THERE IS NO GLOBAL TTL
 *
 * "How long is this offer's price still worth showing" is a question about ONE
 * source — eBay's API contract says delete the content when the listing is no
 * longer publicly available, an Amazon-style contract caps non-image caching at
 * 24 hours, an Awin feed is stale the moment its advertiser re-imports it. A
 * deployment-wide `OFFER_TTL_SECONDS` would be wrong for every one of them, and
 * wrong in the direction that breaks a contract rather than a page.
 *
 * So a {@link SourceFreshnessPolicy} **carries the id of the source it was
 * resolved for**, and {@link assessOfferFreshness} is handed the offer's own
 * source id beside it and REFUSES a policy that names a different one
 * (`unknown` / `policy_source_mismatch`). One shared policy object therefore
 * cannot serve two sources: the only way to get a second source's deadlines is
 * to resolve a second source's row. That is the structural half; the scanned
 * half is `freshness-isolation.test.ts`, which fails the build if the resolver
 * ever learns to read a duration out of configuration.
 *
 * ## The clock is `lastSeenAt`, not `observedAt` — and that is a decision
 *
 * `observedAt` is when the CURRENT terms were read, i.e. when the price last
 * CHANGED. `lastSeenAt` is when the source last confirmed the offer exists at
 * all. Running the deadlines from `observedAt` expires every stable price on a
 * feed that publishes the same number every day, which is most of a catalogue;
 * running them from `lastSeenAt` asks the question the contracts actually ask —
 * "when did we last check". Both are still reported, because a buyer comparing
 * offers wants the second and a merchant debugging a feed wants the first.
 *
 * ## Unknown is never a quiet yes
 *
 * `#57`'s device, extended rather than coerced: the `unknown` branch of
 * {@link OfferFreshnessAssessment} has no `expiry` property, so nothing can
 * compute "time remaining" for an offer whose policy could not be resolved; the
 * `expired` and `unavailable` branches have no `lastCheckedAt`, so a surface
 * that renders "last checked 3 hours ago" cannot compile for an offer that must
 * have left comparison entirely. And {@link rollUpOfferAvailability} never
 * answers `in_stock` from silence.
 */

import type { CatalogSourceHealthState } from './ingestion';
import type { OfferAvailability, OfferMoney } from './offer';

/* ────────────────────────────────────────────────────────────────────────── */
/* Refresh capability and scheduling                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * How a source can be refreshed. An ADAPTER declares which of these it can do
 * and the scheduler may schedule no other (#68 scheduler 1).
 *
 * The four are genuinely different obligations, not sizes of one:
 * `full_snapshot` is the only one that establishes absence and therefore the
 * only one that may retire an omitted record (#62's `mayRetireUnseen`);
 * `incremental` asks "what changed since"; `query_driven` re-reads the objects
 * a search would return; `targeted` re-reads a named list of objects and is
 * what a priority refresh needs.
 */
export type CatalogRefreshMode =
  | 'full_snapshot'
  | 'incremental'
  | 'query_driven'
  | 'targeted';

export const CATALOG_REFRESH_MODES: readonly CatalogRefreshMode[] = [
  'full_snapshot',
  'incremental',
  'query_driven',
  'targeted',
];

/**
 * The ONLY mode from which absence is evidence.
 *
 * `CATALOG_SOURCE_RETIRING_OUTCOMES`' sibling, one layer up: that tuple says
 * which run OUTCOMES may retire, this one says which refresh MODES could ever
 * produce such an outcome. An incremental pass that happens to end cleanly is
 * still not a statement about the records it did not ask for — which is
 * acceptance 3, held as a value rather than as a branch.
 */
export const CATALOG_SNAPSHOT_REFRESH_MODES: readonly CatalogRefreshMode[] = ['full_snapshot'];

/**
 * Why a refresh was asked for, most urgent first (#68 scheduler 2).
 *
 * The ORDER of this tuple is the priority order, and
 * {@link OFFER_REFRESH_PRIORITY_RANK} is derived from it rather than written
 * beside it — two hand-maintained orderings of one vocabulary is exactly the
 * disagreement these conventions exist to prevent.
 *
 * `alerted` leads because a price alert that fires on a stale price is a
 * message to a person about a price that does not exist. `scheduled` is last
 * because it is the cadence everything else pre-empts.
 */
export type OfferRefreshPriorityClass =
  /** A buyer is waiting to be told when this price moves (#78/#79). */
  | 'alerted'
  /** Somebody followed this offer out to the retailer recently. */
  | 'clicked'
  /** The offer's product is being viewed far more than the median. */
  | 'popular'
  /** The offer is one of the current cheapest on a variant a native listing competes on. */
  | 'comparison'
  /** The source's own cadence came round. */
  | 'scheduled';

export const OFFER_REFRESH_PRIORITY_CLASSES: readonly OfferRefreshPriorityClass[] = [
  'alerted',
  'clicked',
  'popular',
  'comparison',
  'scheduled',
];

/**
 * Rank 0 is the most urgent. DERIVED from the tuple above, so a class added in
 * the middle re-ranks everything below it automatically and no second list can
 * fall out of step.
 *
 * The stored `offer_refresh_tasks.priority_rank` column is a GENERATED `case`
 * over `priority_class` rendered from this same map, which is what stops a
 * service writing a rank that disagrees with its own class.
 */
export const OFFER_REFRESH_PRIORITY_RANK: Readonly<Record<OfferRefreshPriorityClass, number>> =
  Object.freeze(
    Object.fromEntries(OFFER_REFRESH_PRIORITY_CLASSES.map((value, index) => [value, index])),
  ) as Readonly<Record<OfferRefreshPriorityClass, number>>;

/**
 * The most urgent of several reasons.
 *
 * An offer can be popular AND alerted, and the queue orders on ONE class, so
 * the severity rule `deriveRetailCompleteness` established (#120) applies here
 * too: the class is the worst of the reasons, and every reason is still
 * recorded beside it so an operator can see why a row is where it is.
 */
export function highestRefreshPriority(
  reasons: readonly OfferRefreshPriorityClass[],
): OfferRefreshPriorityClass | undefined {
  let best: OfferRefreshPriorityClass | undefined;
  for (const reason of reasons) {
    if (best === undefined || OFFER_REFRESH_PRIORITY_RANK[reason] < OFFER_REFRESH_PRIORITY_RANK[best]) {
      best = reason;
    }
  }
  return best;
}

/** The lifecycle of one refresh task. The `offer_outboxes` vocabulary. */
export type OfferRefreshTaskStatus = 'pending' | 'processing' | 'done' | 'dead_letter';

export const OFFER_REFRESH_TASK_STATUSES: readonly OfferRefreshTaskStatus[] = [
  'pending',
  'processing',
  'done',
  'dead_letter',
];

/**
 * Why a claimed task could not be executed.
 *
 * `unsupported_mode` is the load-bearing member: a task may be ENQUEUED for any
 * mode a person or a policy asked for, because the durable record is never
 * gated (the house rule), and the DISPATCHER refuses one the registered adapter
 * does not declare. The refusal is recorded rather than silently downgraded to
 * a mode the adapter does support — a targeted refresh quietly answered with a
 * full snapshot is a quota bill nobody asked for.
 */
export type OfferRefreshRefusal =
  | 'adapter_missing'
  | 'unsupported_mode'
  | 'rights_suspended'
  | 'source_unconfigured'
  | 'rate_limited'
  | 'all_slots_busy';

export const OFFER_REFRESH_REFUSALS: readonly OfferRefreshRefusal[] = [
  'adapter_missing',
  'unsupported_mode',
  'rights_suspended',
  'source_unconfigured',
  'rate_limited',
  'all_slots_busy',
];

/* ────────────────────────────────────────────────────────────────────────── */
/* The per-source freshness policy                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * WHERE a policy's numbers came from.
 *
 * `source_policy` — a published, reviewed {@link SourceFreshnessPolicy} version.
 * `source_configuration` — derived from that source's OWN `catalog_source_configs`
 * row, for a source nobody has published a freshness version for yet. It is
 * still per-source: the numbers are that row's `fetch_cadence_seconds` and
 * `freshness_ttl_seconds`, never a constant.
 * `offer_deadline` — derived from the OFFER's own stored `stale_at`, for a row
 * whose source is a bare provenance registry entry with no ingestion config at
 * all (#60's backfill source, an operator's). It is per-OFFER and therefore not
 * the global TTL this module forbids: the number is the one whoever wrote that
 * row chose. It exists so that adopting #68 does not withdraw offers written
 * outside the ingestion framework from comparison on the deploy that adds it —
 * ADR 0002 D24's rule that a rollout lever is never introduced in the position
 * that removes a live surface.
 * `native_convergence` — a native offer, which has no source and no source
 * deadline (see {@link nativeOfferFreshness}).
 */
export type SourceFreshnessBasis =
  | 'source_policy'
  | 'source_configuration'
  | 'offer_deadline'
  | 'native_convergence';

export const SOURCE_FRESHNESS_BASES: readonly SourceFreshnessBasis[] = [
  'source_policy',
  'source_configuration',
  'offer_deadline',
  'native_convergence',
];

/**
 * The share of a source's own lifetime after which its offers enter `warning`.
 *
 * A FRACTION and deliberately not a duration: two thirds of a source's own TTL
 * is two thirds of a different number for every source, so this constant cannot
 * become the global TTL the whole file exists to prevent. `OFFER_AGING_FRACTION`
 * (#57) is the same device and this replaces it.
 *
 * It applies only when nobody has published an explicit warning threshold for
 * the source; a published policy states its own, which is the point of
 * publishing one.
 */
export const SOURCE_WARNING_FRACTION = 2 / 3;

/**
 * How much longer an offer survives past its deadline while its source is
 * DEGRADED, before the sweep retires it.
 *
 * A MULTIPLE of the source's own expected refresh interval, for the reason
 * above. Two intervals is "the source missed two refreshes in a row", which is
 * a real outage rather than one slow night, and it is what acceptance 1 buys:
 * a transient outage does not remove every prior offer.
 *
 * The grace never changes what a BUYER sees — an offer past its deadline reads
 * `expired` and leaves comparison immediately, whatever the source's health.
 * Grace delays the durable retirement only, so the offers come back when the
 * feed does instead of having to be re-ingested from scratch.
 */
export const SOURCE_OUTAGE_GRACE_INTERVALS = 2;

/**
 * One source's freshness contract, resolved for ONE source.
 *
 * `sourceId` is the field that makes a global TTL unrepresentable: a value of
 * this type names the source whose row it came from, and
 * {@link assessOfferFreshness} refuses to apply it to any other. A module-level
 * constant of this type would have to claim a specific source id, and would
 * then be inert for every other offer in the catalogue.
 */
export interface SourceFreshnessPolicy {
  /** The source these numbers were read for. Never optional, never widened. */
  readonly sourceId: string;
  readonly basis: SourceFreshnessBasis;
  /** The published version, when the basis is `source_policy`. */
  readonly policyVersion: number | null;
  /** How often this source is expected to be refreshed at all. */
  readonly expectedRefreshIntervalSeconds: number;
  /** How long after the last successful observation an offer enters `warning`. */
  readonly warningAfterSeconds: number;
  /** How long after the last successful observation an offer EXPIRES. */
  readonly expiryAfterSeconds: number;
  /** Extra survival granted to the RETIREMENT sweep while the source is degraded. */
  readonly outageGraceSeconds: number;
  /**
   * The source's own contractual cache cap, from
   * `catalog_source_policies.cache_ttl_seconds` (#62's `may_cache` right).
   *
   * It can only ever SHORTEN the lifetime — {@link effectiveOfferLifetimeSeconds}
   * is a `min`, and there is no parameter through which it could lengthen one.
   * `null` means the rights policy states no cap, not that caching is unlimited
   * by fiat: a source with no `may_cache` right stores no payload at all.
   */
  readonly cacheCapSeconds: number | null;
  /**
   * Whether an object the source declares GONE retires immediately.
   *
   * eBay's API License Agreement requires deleting content once the listing is
   * no longer publicly available, which is a deletion obligation rather than a
   * staleness one. Defaults TRUE, because retaining something a source says is
   * gone is the direction that breaks a contract.
   */
  readonly retireOnSourceUnavailable: boolean;
}

/**
 * The lifetime actually in force: the source's own expiry, capped by whatever
 * its rights policy permits.
 *
 * A `min`, and there is deliberately no branch that could pick the larger — a
 * contractual cap that a per-source policy could override would not be a cap.
 */
export function effectiveOfferLifetimeSeconds(policy: SourceFreshnessPolicy): number {
  return policy.cacheCapSeconds === null
    ? policy.expiryAfterSeconds
    : Math.min(policy.expiryAfterSeconds, policy.cacheCapSeconds);
}

/** Whether the cap, rather than the source's own policy, is what bounds the lifetime. */
export function lifetimeBoundByCacheCap(policy: SourceFreshnessPolicy): boolean {
  return policy.cacheCapSeconds !== null && policy.cacheCapSeconds < policy.expiryAfterSeconds;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The assessment                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * How current an offer is (#68 §"Freshness model").
 *
 * `current` and `warning` may appear in comparison and search; `expired`,
 * `unavailable` and `unknown` may not. That is {@link mayAppearInComparison},
 * an exhaustive `switch`, so a sixth level added later fails `tsc` there rather
 * than defaulting into the buyer-visible set.
 */
export type OfferFreshnessLevel = 'current' | 'warning' | 'expired' | 'unavailable' | 'unknown';

export const OFFER_FRESHNESS_LEVELS: readonly OfferFreshnessLevel[] = [
  'current',
  'warning',
  'expired',
  'unavailable',
  'unknown',
];

/** Which deadline the offer ran past. */
export type OfferExpiryReason =
  /** The source's own freshness policy elapsed. */
  | 'policy_lifetime_elapsed'
  /** The source's contractual cache cap elapsed first. */
  | 'cache_cap_elapsed';

export const OFFER_EXPIRY_REASONS: readonly OfferExpiryReason[] = [
  'policy_lifetime_elapsed',
  'cache_cap_elapsed',
];

/** Why no verdict could be reached. Never a soft yes. */
export type OfferFreshnessUnknownReason =
  /** The offer names a source nobody has configured for ingestion. */
  | 'source_unconfigured'
  /** A policy was supplied, for a DIFFERENT source. See the module docblock. */
  | 'policy_source_mismatch'
  /** The offer carries no source at all and is not native — an unclassifiable row. */
  | 'source_missing';

export const OFFER_FRESHNESS_UNKNOWN_REASONS: readonly OfferFreshnessUnknownReason[] = [
  'source_unconfigured',
  'policy_source_mismatch',
  'source_missing',
];

/**
 * The deadlines, when there are any.
 *
 * A discriminated union rather than two nullable timestamps: a NATIVE offer has
 * no source deadline at all (its `stale_at` measures how long ago the converger
 * ran, which says nothing about whether the listing is still for sale), and
 * `bounded: false` has no `expiresAt` property for a caller to read as "expires
 * at the epoch".
 */
export type OfferExpiryOutlook =
  | { readonly bounded: true; readonly warnsAt: string; readonly expiresAt: string }
  | { readonly bounded: false };

/**
 * What #68 answers about one offer.
 *
 * Five branches, three of which deliberately withhold a field:
 *
 * - `expired` and `unavailable` carry NO `lastCheckedAt`, because #68's public
 *   behaviour 2 grants a last-checked time to the WARNING state and to nothing
 *   else. An expired offer has left comparison; putting a timestamp beside it
 *   is presenting old data with a reassurance attached.
 * - `unknown` carries no `expiry` at all, so nothing can compute a countdown
 *   for an offer whose policy could not be resolved.
 */
export type OfferFreshnessAssessment =
  | {
      readonly level: 'current';
      readonly basis: SourceFreshnessBasis;
      readonly observedAt: string;
      readonly firstSeenAt: string;
      readonly lastSeenAt: string;
      readonly lastConfirmedAt?: string;
      /** Whole seconds since the terms last CHANGED. */
      readonly ageSeconds: number;
      /** Whole seconds since the source last CONFIRMED the offer exists. */
      readonly checkedAgeSeconds: number;
      readonly expiry: OfferExpiryOutlook;
    }
  | {
      readonly level: 'warning';
      readonly basis: SourceFreshnessBasis;
      readonly observedAt: string;
      readonly firstSeenAt: string;
      readonly lastSeenAt: string;
      readonly lastConfirmedAt?: string;
      readonly ageSeconds: number;
      readonly checkedAgeSeconds: number;
      /** #68 public behaviour 2 — the WARNING state's own field. */
      readonly lastCheckedAt: string;
      readonly expiry: { readonly bounded: true; readonly warnsAt: string; readonly expiresAt: string };
    }
  | {
      readonly level: 'expired';
      readonly basis: SourceFreshnessBasis;
      readonly observedAt: string;
      readonly firstSeenAt: string;
      readonly lastSeenAt: string;
      readonly ageSeconds: number;
      readonly checkedAgeSeconds: number;
      readonly expiredAt: string;
      readonly reason: OfferExpiryReason;
    }
  | {
      readonly level: 'unavailable';
      readonly basis: SourceFreshnessBasis;
      readonly observedAt: string;
      readonly firstSeenAt: string;
      readonly lastSeenAt: string;
      readonly ageSeconds: number;
      readonly checkedAgeSeconds: number;
      /** When the source itself said the object is gone. */
      readonly declaredUnavailableAt: string;
    }
  | {
      readonly level: 'unknown';
      readonly observedAt: string;
      readonly firstSeenAt: string;
      readonly lastSeenAt: string;
      readonly ageSeconds: number;
      readonly checkedAgeSeconds: number;
      readonly reason: OfferFreshnessUnknownReason;
    };

/** The timestamps one offer carries, as the derivation reads them. */
export interface OfferFreshnessObservation {
  /** The source this offer's terms came from. `null` on a native offer. */
  readonly sourceId: string | null;
  /** When the CURRENT terms were read — i.e. when the price last changed. */
  readonly observedAt: Date;
  readonly firstSeenAt: Date;
  /** The last successful observation of THIS EXACT offer (#68 freshness input 2). */
  readonly lastSeenAt: Date;
  /** The last time the source RE-STATED these terms (#68 freshness input 3). */
  readonly lastConfirmedAt: Date | null;
  /** When the source explicitly declared it gone (#68 freshness input 5). */
  readonly declaredUnavailableAt: Date | null;
  /**
   * The offer's OWN stored deadline (`offers.stale_at`), the last resort.
   *
   * Read only when no source policy resolves — see `offer_deadline` above. It is
   * NOT the authority when a policy exists: a contractual cache cap published
   * this morning must bite on rows stamped last week, which is exactly what a
   * stored deadline cannot do.
   */
  readonly storedExpiresAt: Date;
}

function wholeSecondsSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1_000));
}

/**
 * A NATIVE offer's freshness.
 *
 * `current`, unbounded, always — and the reason is #57's, restated: a native
 * offer is a projection of a listing Mercaria already owns, its buyability is
 * derived LIVE from `listings.status` and the variant's stock at projection
 * time, and its `stale_at` measures how long ago the convergence dispatcher
 * ran. Expiring it on that clock would delist a healthy catalogue during a
 * dispatcher outage, which is the exact failure #68 exists to prevent, pointed
 * at ourselves.
 */
export function nativeOfferFreshness(
  input: OfferFreshnessObservation,
  now: Date,
): OfferFreshnessAssessment {
  return {
    level: 'current',
    basis: 'native_convergence',
    observedAt: input.observedAt.toISOString(),
    firstSeenAt: input.firstSeenAt.toISOString(),
    lastSeenAt: input.lastSeenAt.toISOString(),
    ...(input.lastConfirmedAt ? { lastConfirmedAt: input.lastConfirmedAt.toISOString() } : {}),
    ageSeconds: wholeSecondsSince(input.observedAt, now),
    checkedAgeSeconds: wholeSecondsSince(input.lastSeenAt, now),
    expiry: { bounded: false },
  };
}

/**
 * Assess one SOURCE-backed offer against its own source's policy.
 *
 * `now` is a parameter rather than a `new Date()` inside, so a test can put the
 * clock exactly on a boundary instead of racing it — #57's rule, kept.
 *
 * The decision procedure, worst-first (the `deriveRetailCompleteness` severity
 * rule, applied to freshness):
 *
 *  1. the source said it is GONE → `unavailable`, whatever the clock says;
 *  2. no policy, or a policy for another source → `unknown`;
 *  3. past the effective lifetime → `expired`, naming which deadline bound it;
 *  4. past the warning threshold → `warning`;
 *  5. otherwise → `current`.
 *
 * Step 2 is the one that carries the module's whole argument: a policy is a
 * per-source value and applying one source's deadlines to another's offers is
 * refused rather than tolerated.
 */
export function assessOfferFreshness(
  input: OfferFreshnessObservation,
  policy: SourceFreshnessPolicy | null,
  now: Date,
): OfferFreshnessAssessment {
  const common = {
    observedAt: input.observedAt.toISOString(),
    firstSeenAt: input.firstSeenAt.toISOString(),
    lastSeenAt: input.lastSeenAt.toISOString(),
    ageSeconds: wholeSecondsSince(input.observedAt, now),
    checkedAgeSeconds: wholeSecondsSince(input.lastSeenAt, now),
  } as const;

  if (input.sourceId === null) {
    return { level: 'unknown', ...common, reason: 'source_missing' };
  }
  if (input.declaredUnavailableAt !== null) {
    return {
      level: 'unavailable',
      basis: policy?.basis ?? 'source_configuration',
      ...common,
      declaredUnavailableAt: input.declaredUnavailableAt.toISOString(),
    };
  }
  if (policy !== null && policy.sourceId !== input.sourceId) {
    return { level: 'unknown', ...common, reason: 'policy_source_mismatch' };
  }

  /**
   * A source with NO ingestion configuration falls back to the OFFER's own
   * stored deadline, per offer.
   *
   * A bare `catalog_sources` registry row — #60's backfill source, the operator
   * one — ingests nothing (#62) and therefore has no contract to resolve; the
   * offers written against it nonetheless carry a `stale_at` somebody chose.
   * Answering `unknown` would withdraw every one of them from comparison on the
   * deploy that adds #68, which ADR 0002 D24 forbids, and it would do so on the
   * strength of a configuration gap rather than of anything about the offer.
   *
   * It is not a global TTL and could not become one: the number is that row's.
   */
  const effective: SourceFreshnessPolicy =
    policy ?? offerDeadlinePolicy(input);

  const lifetimeSeconds = effectiveOfferLifetimeSeconds(effective);
  const expiresAt = new Date(input.lastSeenAt.getTime() + lifetimeSeconds * 1_000);
  // A published warning threshold beyond the effective lifetime is not a state
  // any offer could reach — clamping it to the expiry keeps `warnsAt <=
  // expiresAt` true even when a contractual cap cut the lifetime below the
  // threshold somebody published.
  const warnsAt = new Date(
    Math.min(
      input.lastSeenAt.getTime() + effective.warningAfterSeconds * 1_000,
      expiresAt.getTime(),
    ),
  );

  if (now.getTime() >= expiresAt.getTime()) {
    return {
      level: 'expired',
      basis: effective.basis,
      ...common,
      expiredAt: expiresAt.toISOString(),
      reason: lifetimeBoundByCacheCap(effective) ? 'cache_cap_elapsed' : 'policy_lifetime_elapsed',
    };
  }

  const expiry = {
    bounded: true,
    warnsAt: warnsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  } as const;

  if (now.getTime() >= warnsAt.getTime()) {
    return {
      level: 'warning',
      basis: effective.basis,
      ...common,
      ...(input.lastConfirmedAt ? { lastConfirmedAt: input.lastConfirmedAt.toISOString() } : {}),
      lastCheckedAt: input.lastSeenAt.toISOString(),
      expiry,
    };
  }

  return {
    level: 'current',
    basis: effective.basis,
    ...common,
    ...(input.lastConfirmedAt ? { lastConfirmedAt: input.lastConfirmedAt.toISOString() } : {}),
    expiry,
  };
}

/**
 * The last-resort contract: the offer's OWN stored deadline.
 *
 * `sourceId` is still the offer's own source, so the mismatch guard above keeps
 * working; the lifetime is the span the writer chose, floored at a minute so a
 * deadline stamped in the past cannot produce a negative window. The warning
 * threshold is the same FRACTION every other basis uses — of a different number
 * for every offer, which is what keeps it from being a global value.
 *
 * There is no outage grace: nothing knows this source's cadence, and inventing
 * one would extend a lifetime nobody agreed to.
 */
function offerDeadlinePolicy(input: OfferFreshnessObservation): SourceFreshnessPolicy {
  const spanSeconds = Math.max(
    60,
    Math.floor((input.storedExpiresAt.getTime() - input.lastSeenAt.getTime()) / 1_000),
  );
  return {
    sourceId: input.sourceId ?? '',
    basis: 'offer_deadline',
    policyVersion: null,
    expectedRefreshIntervalSeconds: spanSeconds,
    warningAfterSeconds: Math.max(60, Math.floor(spanSeconds * SOURCE_WARNING_FRACTION)),
    expiryAfterSeconds: spanSeconds,
    outageGraceSeconds: 0,
    cacheCapSeconds: null,
    retireOnSourceUnavailable: true,
  };
}

/**
 * May this offer appear in comparison, search summaries and outbound routing?
 *
 * An exhaustive `switch` and not a set-membership test, so a sixth level fails
 * `tsc` here instead of falling into whichever branch the `default` happened to
 * be. #68 public behaviour 3 and 6 are this one function; the outbound gate and
 * the comparison read both call it rather than each spelling the rule.
 */
export function mayAppearInComparison(assessment: OfferFreshnessAssessment): boolean {
  switch (assessment.level) {
    case 'current':
    case 'warning':
      return true;
    case 'expired':
    case 'unavailable':
    case 'unknown':
      return false;
  }
}

/**
 * When the RETIREMENT sweep may act, as opposed to when the buyer stops seeing
 * the offer (#68 scheduler 6).
 *
 * The two are deliberately different instants. Display stops at `expiresAt`,
 * derived, with no sweep involved — so a source outage can never present old
 * data as fresh. The durable retirement waits an extra grace window while the
 * source is DEGRADED, so a transient outage does not remove every prior offer
 * (acceptance 1) and the catalogue comes back when the feed does.
 *
 * `null` means the offer has no source deadline to be retired on — a native
 * offer, whose lifecycle follows its listing.
 */
export function offerRetirementDueAt(
  input: OfferFreshnessObservation,
  policy: SourceFreshnessPolicy | null,
  sourceHealth: CatalogSourceHealthState,
): Date | null {
  if (policy === null || input.sourceId === null || policy.sourceId !== input.sourceId) return null;
  const expiresAtMs = input.lastSeenAt.getTime() + effectiveOfferLifetimeSeconds(policy) * 1_000;
  const graceMs = sourceHealthGrantsGrace(sourceHealth) ? policy.outageGraceSeconds * 1_000 : 0;
  return new Date(expiresAtMs + graceMs);
}

/**
 * Which source health states earn an offer the outage grace.
 *
 * The three FETCH failures and nothing else. A `schema_drift` or a
 * `matching_ambiguity` means Mercaria read the feed perfectly well and did not
 * like what was in it — granting grace there would keep serving prices the
 * source has had every opportunity to correct. `rights_suspended` earns none
 * either, and that is the important exclusion: a withdrawn right is a decision
 * to stop showing the data, so extending its life is the one thing the grace
 * must never do.
 */
export function sourceHealthGrantsGrace(health: CatalogSourceHealthState): boolean {
  return health === 'auth_failure' || health === 'rate_limit' || health === 'source_outage';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Anomaly protection                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The four shapes of a feed that has gone wrong in a way individual records
 * cannot show (#68 §"Anomaly protection" 1).
 *
 * Each is a statement about a DISTRIBUTION, which is why #62's per-record
 * `anomalous_change` quarantine does not cover them: a feed that started
 * publishing majors where it used to publish minors looks entirely reasonable
 * one row at a time.
 */
export type CatalogSourceAnomalyKind =
  | 'feed_wide_zero_price'
  | 'currency_change'
  | 'price_scale_shift'
  | 'mass_disappearance';

export const CATALOG_SOURCE_ANOMALY_KINDS: readonly CatalogSourceAnomalyKind[] = [
  'feed_wide_zero_price',
  'currency_change',
  'price_scale_shift',
  'mass_disappearance',
];

/** How a quarantine ended. `released` and `corrected` are different facts. */
export type CatalogSourceQuarantineResolution =
  /** An operator judged the output sound and let it through, on the record. */
  | 'released'
  /** A later run published a distribution that no longer trips the detector. */
  | 'corrected';

export const CATALOG_SOURCE_QUARANTINE_RESOLUTIONS: readonly CatalogSourceQuarantineResolution[] = [
  'released',
  'corrected',
];

/**
 * What one page or run of observations looked like, as a whole.
 *
 * Deliberately small: a median, a currency and three counts. Anything richer
 * would be a second copy of the observations, and the comparison this feeds is
 * "did the feed change SHAPE", which four numbers answer.
 */
export interface SourceObservationDistribution {
  readonly sampleSize: number;
  readonly pricedCount: number;
  readonly zeroPricedCount: number;
  /** In minor units of {@link dominantCurrency}. `null` when nothing was priced. */
  readonly medianPriceMinor: number | null;
  readonly dominantCurrency: string | null;
  /** 0–1. A feed with two currencies is not itself an anomaly. */
  readonly dominantCurrencyShare: number;
}

/**
 * The per-source thresholds the detectors read.
 *
 * On the source's own freshness policy row, for the reason the TTL is: "how far
 * may this feed's median move before we stop believing it" is a different
 * number for a supermarket and for an auction house, and a deployment-wide
 * constant would be wrong for both.
 */
export interface SourceAnomalyThresholds {
  /**
   * Below this many records, NOTHING is anomalous.
   *
   * The floor is what keeps a legitimate sale, a thin category page and a
   * nearly-empty feed out of the quarantine: a distribution over nine rows is
   * not evidence about a catalogue, and a detector that fired on it would be
   * disabled by whoever hit it next.
   */
  readonly minimumSampleSize: number;
  /** The share of priced records at zero above which the feed reads as broken. */
  readonly zeroPriceShare: number;
  /**
   * How far the median may move, as a FACTOR either way.
   *
   * This is the number that tells a sale from a scale error. A seasonal sale
   * moves a catalogue's median by well under 2×; publishing majors where minors
   * were published moves it by exactly 100×, and a currency redenomination by
   * whatever the rate is. A default of 10 sits in the gap, and it is a
   * per-source value precisely so a feed with a genuinely volatile median can
   * raise its own.
   */
  readonly priceScaleFactor: number;
  /** The share of previously-known objects a COMPLETE snapshot may drop. */
  readonly disappearanceShare: number;
}

/** One detector's verdict, with the numbers that produced it. */
export interface SourceAnomalyFinding {
  readonly kind: CatalogSourceAnomalyKind;
  /** The statistic this run produced, as a number an operator can read. */
  readonly observed: number;
  /** What it was compared against. `null` when the detector needs no baseline. */
  readonly baseline: number | null;
  /** A short, value-free description — field names and ratios, never payloads. */
  readonly detail: string;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/**
 * Compare one run's distribution against what this source has published before
 * (#68 anomaly 1 and 3).
 *
 * PURE, and it takes the prior as an argument rather than reading it, so the
 * "does a legitimate sale trip this" question is answerable from a table of
 * inputs instead of from a seeded database.
 *
 * A `null` prior means this source has never published a clean distribution, so
 * the three comparative detectors have nothing to compare against and stay
 * silent — a first run cannot be anomalous relative to a history it does not
 * have, and treating it as one would make every new source quarantine itself.
 * `feed_wide_zero_price` still fires, because "almost every price is zero" is a
 * statement about the run alone.
 */
export function detectSourceAnomalies(input: {
  readonly current: SourceObservationDistribution;
  readonly prior: SourceObservationDistribution | null;
  readonly thresholds: SourceAnomalyThresholds;
  /**
   * How many of the source's previously-known objects this run did NOT see.
   * Meaningful only for a COMPLETE snapshot; the caller passes `null` for every
   * other mode, which is acceptance 3 held one layer up.
   */
  readonly unseenPriorObjects: number | null;
  readonly priorObjectCount: number;
}): readonly SourceAnomalyFinding[] {
  const { current, prior, thresholds } = input;
  const findings: SourceAnomalyFinding[] = [];

  /**
   * MASS DISAPPEARANCE is measured FIRST and is not gated by the price-sample
   * floor, which is the ordering the whole detector turns on.
   *
   * The floor exists so a thin page's PRICES are not compared against a
   * catalogue's; disappearance is a statement about how many objects a pass
   * failed to mention, and the pass that fails to mention EVERYTHING is the one
   * that returns zero records. Gating it on the sample size would make the
   * worst case — a feed that came back empty — the one case the detector is
   * silent about, and it would be silent in the direction that retires a whole
   * catalogue. Measured: an empty final page produced `sampleSize: 0` and no
   * finding at all.
   *
   * It has its own floor, on the PRIOR object count, which is the denominator
   * the share is taken over.
   */
  if (input.unseenPriorObjects !== null && input.priorObjectCount >= thresholds.minimumSampleSize) {
    const share = ratio(input.unseenPriorObjects, input.priorObjectCount);
    if (share >= thresholds.disappearanceShare) {
      findings.push({
        kind: 'mass_disappearance',
        observed: share,
        baseline: thresholds.disappearanceShare,
        detail: `unseen/known = ${input.unseenPriorObjects}/${input.priorObjectCount}`,
      });
    }
  }

  if (current.sampleSize < thresholds.minimumSampleSize) return findings;

  const zeroShare = ratio(current.zeroPricedCount, current.pricedCount);
  if (current.pricedCount > 0 && zeroShare >= thresholds.zeroPriceShare) {
    findings.push({
      kind: 'feed_wide_zero_price',
      observed: zeroShare,
      baseline: thresholds.zeroPriceShare,
      detail: `zero_priced/priced = ${current.zeroPricedCount}/${current.pricedCount}`,
    });
  }

  if (prior !== null && prior.sampleSize >= thresholds.minimumSampleSize) {
    if (
      prior.dominantCurrency !== null &&
      current.dominantCurrency !== null &&
      prior.dominantCurrency !== current.dominantCurrency
    ) {
      // A price that changed DENOMINATION is not a price that changed — #62's
      // per-record rule, restated for the whole feed.
      findings.push({
        kind: 'currency_change',
        observed: current.dominantCurrencyShare,
        baseline: prior.dominantCurrencyShare,
        detail: `dominant_currency ${prior.dominantCurrency} -> ${current.dominantCurrency}`,
      });
    }

    if (
      prior.medianPriceMinor !== null &&
      current.medianPriceMinor !== null &&
      prior.medianPriceMinor > 0 &&
      current.medianPriceMinor > 0
    ) {
      const factor = current.medianPriceMinor / prior.medianPriceMinor;
      if (factor >= thresholds.priceScaleFactor || factor <= 1 / thresholds.priceScaleFactor) {
        findings.push({
          kind: 'price_scale_shift',
          observed: factor,
          baseline: thresholds.priceScaleFactor,
          detail: `median_price_minor ${prior.medianPriceMinor} -> ${current.medianPriceMinor}`,
        });
      }
    }
  }

  return findings;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Catalogue health and the product summary                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * How one source's offers are distributed across freshness levels, plus the
 * scheduling backlog behind them (#68 §"Source health").
 *
 * Every count names its level explicitly rather than being a `Record` keyed on
 * the level union, so adding a level does not silently produce a report with a
 * missing number that reads as zero.
 */
export interface SourceCatalogHealth {
  readonly sourceId: string;
  readonly provider: string;
  readonly adapterRegistered: boolean;
  readonly declaredRefreshModes: readonly CatalogRefreshMode[];
  readonly healthState: CatalogSourceHealthState;
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastFailureAt: string | null;
  readonly consecutiveFailures: number;
  /** Every classified error this source has produced, newest window first. */
  readonly errorClassCounts: Readonly<Record<string, number>>;
  readonly offerCounts: {
    readonly current: number;
    readonly warning: number;
    readonly expired: number;
    readonly unavailable: number;
    readonly retired: number;
  };
  /** The oldest observation still being shown, or `null` when nothing is. */
  readonly oldestCurrentObservedAt: string | null;
  readonly queue: {
    readonly pending: number;
    readonly processing: number;
    readonly deadLettered: number;
    /** Seconds between now and the oldest pending task's due time. */
    readonly oldestPendingLagSeconds: number | null;
  };
  readonly openQuarantines: number;
  readonly anomalyCounts: Readonly<Record<CatalogSourceAnomalyKind, number>>;
  /** Per-market and per-advertiser breakdown (#68 source health 8). */
  readonly markets: readonly SourceMarketHealth[];
  readonly advertisers: readonly SourceAdvertiserHealth[];
}

/** One market's slice of a source's catalogue. */
export interface SourceMarketHealth {
  /** ISO 3166-1 alpha-2, or `null` for offers published for no particular market. */
  readonly country: string | null;
  readonly currentOffers: number;
  readonly expiredOffers: number;
}

/** One affiliate advertiser's slice. `null` for offers with no network. */
export interface SourceAdvertiserHealth {
  readonly affiliateNetwork: string | null;
  readonly affiliateProgramRef: string | null;
  readonly currentOffers: number;
  readonly expiredOffers: number;
}

/**
 * Roll several offers' availability into one answer for a product page.
 *
 * #68 public behaviour 4 in one function: `unknown` survives. A product whose
 * only offers say nothing about stock is `unknown`, never `in_stock` — and the
 * empty case is `unknown` rather than `out_of_stock`, because "every offer
 * expired" (public behaviour 7) is a statement about Mercaria's information and
 * not about the retailer's shelves.
 */
export function rollUpOfferAvailability(
  states: readonly OfferAvailability[],
): OfferAvailability {
  if (states.includes('in_stock')) return 'in_stock';
  if (states.includes('preorder')) return 'preorder';
  const known = states.filter((state) => state !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.includes('out_of_stock') ? 'out_of_stock' : 'unavailable';
}

/**
 * The derived availability and price summary for one canonical product
 * (#68 scheduler 10, public behaviour 7).
 *
 * Computed LIVE from the current eligible offers rather than stored, which is
 * why "rebuild after eligible-offer changes" needs no rebuild: there is no
 * projection to fall out of date. #61 measured the alternative at one million
 * offers and adopted no materialized view; `docs/performance/canonical-graph-benchmarks.md`
 * carries the numbers.
 *
 * `lowestPrice` is ABSENT rather than zero when nothing current is priced, and
 * `currentOfferCount` of zero is a legitimate summary — a product page renders
 * from it instead of failing when every offer has expired.
 */
export interface ProductOfferSummary {
  readonly canonicalProductId: string;
  readonly currentOfferCount: number;
  readonly availability: OfferAvailability;
  readonly lowestPrice?: OfferMoney;
  /** The oldest observation among the offers being shown. */
  readonly oldestCurrentObservedAt?: string;
  /** The freshest observation among them. */
  readonly newestCurrentObservedAt?: string;
  /** How many current offers are in the WARNING state — the "check soon" count. */
  readonly warningOfferCount: number;
}
