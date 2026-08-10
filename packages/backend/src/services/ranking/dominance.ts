/**
 * Source-specific dominance and ranking regressions (#74 policy rules 5 and 6,
 * acceptance 7).
 *
 * PURE, and it REPAIRS NOTHING. Nothing in this module re-orders a comparison to
 * satisfy a threshold, and nothing may be added that does: a shuffle applied to
 * make a report look better would be an undocumented ranking input, which is the
 * one thing the whole issue is about. A finding is reported so a person can
 * decide whether the catalogue, the policy or the source is what needs changing
 * — the `payment_discrepancies` posture, applied to an ordering.
 *
 * ## The window has a floor, and the floor is the point
 *
 * A concentration measured over fewer positions than the policy's window is not
 * a measurement about the window: two offers on a product, both from one
 * retailer, is 100% of a two-position list and an entirely ordinary state. So a
 * comparison shorter than `dominanceWindow` produces NO findings at all rather
 * than a small number that reads like a large one — the vacuity discipline every
 * other measurement in this codebase carries, applied to a share.
 *
 * ## A regression is a DIFF over one input, not a metric over time
 *
 * `compareRankings` takes two orderings of the SAME eligible set, which is what
 * makes acceptance 7's "canaried, compared and rolled back without re-ingesting
 * offers" true by construction: the offers did not move, only the weights did.
 * It deliberately reads no measurement — a click-through rate belongs to #77 and
 * a ranking module that could read one would be one line from ordering by it.
 */

import type {
  RankedOffer,
  RankingComparisonDiff,
  RankingDominanceDimension,
  RankingDominanceFinding,
  RankingPolicy,
} from '@mercaria/shared-types';

/**
 * The axes one offer sits on.
 *
 * Supplied by the caller from the offer rows, because this module reads no
 * database — and deliberately only these three. A fourth axis somebody might
 * reach for (a brand, a category, a price band) would be measuring the
 * CATALOGUE rather than the comparison's concentration, which is a different
 * question with a different remedy.
 */
export interface DominanceSubject {
  readonly offerId: string;
  /** The catalogue source the observation came from, when it has one. */
  readonly sourceId?: string;
  readonly merchantId?: string;
  readonly affiliateNetwork?: string;
}

function keyFor(
  subject: DominanceSubject,
  dimension: RankingDominanceDimension,
): string | undefined {
  if (dimension === 'source') return subject.sourceId;
  if (dimension === 'merchant') return subject.merchantId;
  return subject.affiliateNetwork;
}

/**
 * Which sources, merchants or networks hold more of the top positions than the
 * policy permits.
 *
 * Counted over the top `dominanceWindow` positions only: concentration deep in a
 * long tail is not what a shopper sees, and measuring the whole list would make
 * the finding a property of the catalogue's shape rather than of the ordering.
 */
export function detectRankingDominance(input: {
  readonly ranked: readonly RankedOffer[];
  readonly subjects: ReadonlyMap<string, DominanceSubject>;
  readonly policy: RankingPolicy;
}): readonly RankingDominanceFinding[] {
  const window = input.policy.dominanceWindow;
  if (input.ranked.length < window) return [];

  const top = input.ranked.slice(0, window);
  const findings: RankingDominanceFinding[] = [];

  for (const dimension of ['source', 'merchant', 'affiliate_network'] as const) {
    const counts = new Map<string, number>();
    for (const entry of top) {
      const subject = input.subjects.get(entry.offerId);
      if (subject === undefined) continue;
      const key = keyFor(subject, dimension);
      if (key === undefined) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, positions] of counts) {
      const share = positions / window;
      if (share < input.policy.dominanceShare) continue;
      findings.push({
        dimension,
        key,
        positions,
        window,
        share,
        threshold: input.policy.dominanceShare,
      });
    }
  }

  // Worst first, then by dimension and key, so two runs over one input print in
  // the same order — a report whose row order moved between runs is a diff
  // nobody can read.
  return findings.sort((a, b) => {
    if (a.share !== b.share) return b.share - a.share;
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
}

/**
 * How a candidate policy's ordering differs from a baseline's over ONE input.
 *
 * `moved` is sorted by the size of the movement, largest first, because the
 * question a reviewer asks of a canary is "what moved most", and an
 * offer-id-ordered list buries it. Offers present in one ordering and not the
 * other cannot occur here by construction — both orderings rank the same
 * eligible set — so there is no entrant/leaver case to model, and if one ever
 * appears it is a bug in the caller rather than a diff to render.
 */
export function compareRankings(input: {
  readonly baseline: readonly RankedOffer[];
  readonly baselineVersion: string;
  readonly candidate: readonly RankedOffer[];
  readonly candidateVersion: string;
  readonly baselineDominance: readonly RankingDominanceFinding[];
  readonly candidateDominance: readonly RankingDominanceFinding[];
}): RankingComparisonDiff {
  const baselineRanks = new Map(input.baseline.map((entry) => [entry.offerId, entry.rank]));

  const moved: RankingComparisonDiff['moved'][number][] = [];
  for (const entry of input.candidate) {
    const baselineRank = baselineRanks.get(entry.offerId);
    if (baselineRank === undefined || baselineRank === entry.rank) continue;
    moved.push({
      offerId: entry.offerId,
      baselineRank,
      candidateRank: entry.rank,
      delta: entry.rank - baselineRank,
    });
  }
  moved.sort((a, b) => {
    const byMagnitude = Math.abs(b.delta) - Math.abs(a.delta);
    return byMagnitude !== 0 ? byMagnitude : a.offerId < b.offerId ? -1 : 1;
  });

  const baselineLeader = input.baseline[0]?.offerId;
  const candidateLeader = input.candidate[0]?.offerId;

  // A finding the CANDIDATE produces that the baseline did not. Existing
  // concentration is a fact about the catalogue and is not this diff's news;
  // concentration a weight change INTRODUCED is.
  const baselineKeys = new Set(
    input.baselineDominance.map((finding) => `${finding.dimension}:${finding.key}`),
  );
  const newDominance = input.candidateDominance.filter(
    (finding) => !baselineKeys.has(`${finding.dimension}:${finding.key}`),
  );

  return {
    baselineVersion: input.baselineVersion,
    candidateVersion: input.candidateVersion,
    compared: input.candidate.length,
    moved,
    leaderChanged: baselineLeader !== candidateLeader,
    ...(baselineLeader === undefined ? {} : { baselineLeaderOfferId: baselineLeader }),
    ...(candidateLeader === undefined ? {} : { candidateLeaderOfferId: candidateLeader }),
    newDominance,
  };
}
