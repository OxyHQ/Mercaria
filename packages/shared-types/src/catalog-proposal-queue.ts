/**
 * The proposal review queue's depth, its aging, and the SLA target that does not
 * exist (#367 Workstream 6 — "add proposal queue metrics and aging/SLA
 * visibility").
 *
 * `catalog-metrics.ts` already carries three proposal readings — how many were
 * created, how many are open, how old the oldest one is — and each is a single
 * integer over the whole open set. What an operator working the queue actually
 * needs, and what this file adds, is the SHAPE of that set: which states it is
 * spread across, how the waiting is distributed, and what the numbers would look
 * like if the read had measured nothing at all.
 *
 * ## The failure mode this file is written against
 *
 * A queue metric that reports a comfortable number while measuring nothing. Every
 * shape here is chosen so that "the queue is empty", "the read found nothing" and
 * "this build's vocabulary no longer matches the data" are three DIFFERENT
 * answers:
 *
 * - {@link CatalogProposalQueueAging.countsAgree} compares a total counted as
 *   `count(*)` against the SUM of the per-state counts. Those two disagree
 *   exactly when a row carries a state this build does not know — the reachable
 *   case being a `pre` migration that widened `catalog_proposals_state_check`
 *   ahead of the image that reads it, which is how this repository ships a
 *   vocabulary change.
 * - {@link CatalogProposalQueueAging.unbandedOpenCount} is the open rows that
 *   landed in NO age band. The bands start at zero and are contiguous, so the
 *   only way to land outside them is an age below zero — a row whose
 *   `created_at` is in the FUTURE. That is not hypothetical in this repository:
 *   a page clock captured before an adapter ran produced `observed_at > now` on
 *   every record of every ingestion pass and failed a CHECK silently as a
 *   per-record parse failure (#63/#65). Here it is a number an operator can see
 *   rather than a row that quietly vanishes from a distribution.
 * - {@link CatalogProposalWaitAge}'s `unmeasured` branch has **no percentile
 *   property of any kind**, so a population too small to support one cannot be
 *   rendered as a number — the {@link CatalogMetricReading} device, at a
 *   different grain.
 *
 * ## There is no SLA target, and inventing one would be worse than having none
 *
 * Nothing anywhere in this repository defines how long a catalogue proposal may
 * wait. {@link CatalogProposalSlaVisibility} is therefore a union with ONE
 * member, `undefined_target`, and no member carrying a threshold, a deadline or a
 * breach count — the `GuestP2PAuthorization` and `GuestSellerActivation` device:
 * a second member arrives in the same change as the decision that justifies it,
 * and until then "we are within SLA" is unrepresentable rather than merely
 * unwritten. A number picked here to make a dashboard look finished would harden
 * the first time somebody quoted it.
 *
 * What IS published is the aging, which is the input any target would be compared
 * against — so the decision is one line of policy away from being enforceable,
 * and the gap is visible on the operator surface rather than absent from it.
 */

import type { CatalogProposalState } from './catalog-proposal';

/* -------------------------------------------------------------------------- */
/* Age bands                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One band of the waiting-age distribution.
 *
 * `fromSeconds` is inclusive and `toSeconds` is exclusive, and the last band's
 * `toSeconds` is `null` — open-ended, so no age above the last boundary can fall
 * out of the distribution. The bands are CONTIGUOUS from zero
 * (`band[n].fromSeconds === band[n - 1].toSeconds`), which is what makes
 * {@link CatalogProposalQueueAging.unbandedOpenCount} mean "an age below zero"
 * and nothing else.
 */
export interface CatalogProposalAgeBand {
  readonly key: string;
  readonly fromSeconds: number;
  /** `null` on the last band only. */
  readonly toSeconds: number | null;
}

const HOUR = 3_600;
const DAY = 24 * HOUR;

/**
 * The waiting-age distribution over OPEN proposals.
 *
 * Five bands, contiguous from zero and open-ended at the top. They are a
 * PARTITION and not a set of thresholds: every open proposal falls in exactly
 * one, so the band counts SUM to the open depth, which is a conserved total a
 * test can pin exactly rather than a floor that can only notice a deletion.
 *
 * The boundaries are working days rather than statistical quantiles, deliberately.
 * A quantile-derived band moves when the queue moves, so a bucket's meaning
 * changes between two readings and the history stops being comparable — and this
 * repository has already paid for a population that widened silently (#565).
 * These five are fixed, and they are the resolution at which "somebody should
 * look at this" changes: within a day, within the working week, beyond it,
 * beyond a month.
 */
export const CATALOG_PROPOSAL_AGE_BANDS: readonly CatalogProposalAgeBand[] = [
  { key: 'under_1d', fromSeconds: 0, toSeconds: DAY },
  { key: '1d_to_3d', fromSeconds: DAY, toSeconds: 3 * DAY },
  { key: '3d_to_7d', fromSeconds: 3 * DAY, toSeconds: 7 * DAY },
  { key: '7d_to_30d', fromSeconds: 7 * DAY, toSeconds: 30 * DAY },
  { key: 'over_30d', fromSeconds: 30 * DAY, toSeconds: null },
];

/** How many open proposals sit in one band. */
export interface CatalogProposalAgeBandCount {
  readonly key: string;
  readonly fromSeconds: number;
  readonly toSeconds: number | null;
  readonly count: number;
}

/* -------------------------------------------------------------------------- */
/* Percentiles                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The population below which a p95 says nothing a maximum did not already say.
 *
 * DERIVED, not chosen. These percentiles are nearest-rank (`percentile_disc`),
 * so p95 over `n` samples is the element at rank `ceil(0.95n)`. That equals `n` —
 * the maximum itself — for every `n < 20`, and stops equalling it at exactly 20.
 * Below this floor a "p95" is the largest observed age wearing a more
 * authoritative name, which is the shape of a number that gets quoted.
 *
 * `contract-gates.test.ts` re-derives the crossover from the rank formula rather
 * than trusting this constant, so changing the percentile set moves the floor or
 * fails the build.
 *
 * Below it the read answers {@link CatalogProposalWaitAge}'s `unmeasured` branch,
 * and the {@link CATALOG_PROPOSAL_AGE_BANDS} distribution is what remains — it is
 * exact at any population, because it counts rather than estimates.
 */
export const CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION = 20;

/**
 * The percentiles this domain publishes, in the order it publishes them.
 *
 * The ONE place the numbers live: `tallyProposals` renders its three
 * `percentile_disc` arguments from this tuple by position, and
 * `CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION` is derived from the largest of
 * them. Two spellings of "which percentiles" would let the SQL and the floor
 * describe different measurements, and the disagreement would be invisible —
 * both would still return numbers.
 *
 * `CatalogProposalWaitAge`'s field NAMES encode these values, so a change here
 * is a change to the published contract; `contract-gates.test.ts` pins the
 * correspondence in both directions.
 */
export const CATALOG_PROPOSAL_WAIT_AGE_PERCENTILES: readonly number[] = [0.5, 0.9, 0.95];

/**
 * Why a waiting-age percentile could not be produced.
 *
 * `population_below_floor` is a fact about the POPULATION rather than about the
 * reader — an empty queue is not a failure, and neither is a young one.
 *
 * `percentiles_unavailable` is unreachable by construction and is kept anyway:
 * the aggregate's `filter` and the population count are the same predicate in
 * the same statement, so a population above the floor cannot come back with a
 * NULL percentile. If it ever does, the alternative to this member is publishing
 * a `null` as a number — the backend compiles with `strict: false`, so nothing
 * would stop it — and a wait of `0` reads as a queue with no wait at all. The
 * two are separate members because collapsing them would report a defect as a
 * small sample and send whoever read it to wait for the queue to grow.
 */
export type CatalogProposalWaitAgeUnmeasuredReason =
  | 'population_below_floor'
  | 'percentiles_unavailable';

/**
 * The waiting-age percentiles over OPEN proposals, or the refusal to state them.
 *
 * A string discriminant, not a boolean: the backend compiles with
 * `strict: false`, so without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant and
 * `if (!waitAge.measured)` would leave the caller holding the whole union. The
 * `SupplierPreflight` finding, restated where it bites.
 *
 * Every figure on the `measured` branch was OBSERVED — nearest-rank, never
 * interpolated — so each one is the age of a proposal that really is waiting.
 */
export type CatalogProposalWaitAge =
  | {
      readonly state: 'measured';
      /** How many open proposals the percentiles were taken over. */
      readonly population: number;
      readonly p50Seconds: number;
      readonly p90Seconds: number;
      readonly p95Seconds: number;
      readonly maxSeconds: number;
    }
  | {
      readonly state: 'unmeasured';
      /** Still reported: "too small" and "empty" are different, and both are useful. */
      readonly population: number;
      readonly reason: CatalogProposalWaitAgeUnmeasuredReason;
      readonly floor: number;
    };

/* -------------------------------------------------------------------------- */
/* SLA                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether a review-time target exists. Today it does not, and that is the whole
 * type.
 *
 * There is no `defined` member, no `targetSeconds` field and no breach count
 * anywhere in this file, so no code path can claim a proposal is within or beyond
 * a target. Adding one is a deliberate change that lands with the policy it
 * enforces, in the same commit — which is the only way the number in it is
 * accountable to somebody.
 */
export type CatalogProposalSlaVisibility = {
  readonly state: 'undefined_target';
  /** Plain language for the operator surface. States the gap, promises nothing. */
  readonly statement: string;
  /** What would close it. Never blank — a gap with no owner is an apology. */
  readonly seam: string;
};

/** The one SLA answer this deployment can give. */
export const CATALOG_PROPOSAL_SLA_STATES: readonly CatalogProposalSlaVisibility['state'][] = [
  'undefined_target',
];

/**
 * The published, unchanging answer to "are we meeting our proposal SLA".
 *
 * A function rather than a constant so that closing the seam is an edit to ONE
 * body every caller already reaches, rather than a value several surfaces might
 * have copied.
 */
export function describeCatalogProposalSla(): CatalogProposalSlaVisibility {
  return {
    state: 'undefined_target',
    statement:
      'No review-time target is defined for catalogue proposals. The queue depth and the '
      + 'waiting-age distribution below are measured; whether any of them is acceptable is a '
      + 'policy decision nobody has made, so this surface states none.',
    seam:
      'Closing it is a decision recorded on #367 Workstream 6 naming a target per open state '
      + '(a proposal awaiting an operator and one awaiting a submitter are not the same wait), '
      + 'plus a second member on CatalogProposalSlaVisibility and the breach metric '
      + 'proposal_sla_breach_count, which is defined and declared unmeasured for exactly this '
      + 'reason.',
  };
}

/* -------------------------------------------------------------------------- */
/* The queue reading                                                           */
/* -------------------------------------------------------------------------- */

/** How many proposals sit in one lifecycle state. */
export interface CatalogProposalStateDepth {
  readonly state: CatalogProposalState;
  readonly count: number;
  /** Whether this state is one somebody is still waiting on. */
  readonly open: boolean;
  /**
   * Seconds since the oldest row in this state was created, or `null` when the
   * state is empty.
   *
   * `null` and not zero. An empty state reporting an age of zero reads as one
   * that is perfectly up to date, which is the same shape as one that has
   * stopped being fed — the `ageSeconds` builder's decision, restated per state
   * because that builder cannot express a per-bucket age.
   */
  readonly oldestAgeSeconds: number | null;
}

/**
 * The proposal review queue, measured.
 *
 * Carries no proposal id, no store id, no submitter, no label and no
 * convergence key — integers and closed-set keys only. Which proposal is oldest
 * is a question `/internal/catalog-proposals?state=submitted` already answers,
 * ordered by the index built for it; this surface answers how bad the queue is,
 * and keeping a row handle off it is what stops "how much is this merchant
 * asking for" being one filter away from a metrics read.
 */
export interface CatalogProposalQueueAging {
  readonly measuredAt: string;

  /**
   * Every state in {@link CatalogProposalState}, including the empty ones and
   * including the resolved ones.
   *
   * All eight rather than the three open ones, because a queue is read against
   * its throughput: a backlog of forty beside two hundred approvals is a
   * different situation from a backlog of forty beside none, and a surface that
   * only reported the open states could not tell them apart.
   */
  readonly depthByState: readonly CatalogProposalStateDepth[];

  /** Rows in an open state. Equals the sum of the open entries above. */
  readonly openDepth: number;
  /** Every row, counted as `count(*)` — NOT summed from the states above. */
  readonly totalDepth: number;
  /**
   * Whether the per-state counts account for every row.
   *
   * False means a row carries a state this build's `CATALOG_PROPOSAL_STATES`
   * does not contain. See the file header: the reachable cause is a `pre`
   * migration widening the state CHECK ahead of the image that reads it, and the
   * symptom without this flag would be a backlog that is quietly short.
   */
  readonly countsAgree: boolean;

  /**
   * The waiting-age distribution over the open rows. A partition: these counts
   * sum to `openDepth − unbandedOpenCount`.
   */
  readonly agingBands: readonly CatalogProposalAgeBandCount[];
  /**
   * Open rows that fell in no band — `openDepth` minus the banded total, by
   * SUBTRACTION rather than by a filter of its own.
   *
   * MUST be zero, and there are exactly two ways for it not to be: a row whose
   * age is negative because `created_at` is in the future, and a gap opened
   * between two bands. The subtraction catches both; a dedicated `age < 0` count
   * would catch only the first, and the second is the one a later edit
   * introduces.
   *
   * Reported rather than asserted, because a metrics read is not the place to
   * throw — and because a clock fault that silently shrank a distribution is
   * precisely the class of bug this number exists to surface.
   */
  readonly unbandedOpenCount: number;

  /** Seconds since the oldest open row was created, or `null` when none is open. */
  readonly oldestOpenAgeSeconds: number | null;

  /**
   * Open rows in state `deferred` whose `deferred_until` has NOT yet passed.
   *
   * `proposal_backlog_count`'s attribution limit says a planned deferral reads
   * as backlog; this is the number that lets a reader subtract it. A deferred row
   * whose date has passed is deliberately NOT counted here — it is back in the
   * queue and is genuinely waiting.
   */
  readonly deferredAheadCount: number;

  readonly waitAge: CatalogProposalWaitAge;
  readonly sla: CatalogProposalSlaVisibility;
}
