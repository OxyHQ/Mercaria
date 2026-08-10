/**
 * The reproducible input snapshot (#96 solver design rule 6).
 *
 * PURE. One snapshot per solve, carrying everything the search read: the
 * request, the four policy versions, the candidate offers with the prices they
 * were solved against, and the rates that produced those prices. Re-running the
 * solver over the snapshot gives the same plans, which is what makes a
 * re-rendered or revalidated result checkable rather than merely plausible.
 *
 * ## It is RETURNED, never stored
 *
 * UX rule 9 says to "recalculate with current data rather than presenting a
 * stale plan as current", and a stored plan served later is precisely the thing
 * it forbids. So the snapshot travels with the response, the client hands it
 * back to revalidate, and nothing in this domain owns a table. Saving a result
 * for later is #81's watchlist, where a saved thing is explicitly a saved thing.
 *
 * ## The digest is over a CANONICAL serialization
 *
 * Sorted keys, sorted lists, one field per line. Two solves over the same
 * catalogue produce the same digest whatever order the assembler visited things
 * in — and a digest that changed with map iteration order would make
 * revalidation report a change nobody made.
 */

import { createHash } from 'node:crypto';
import {
  type BasketInputSnapshot,
  type BasketRequest,
  type ComparisonPolicyIdentity,
  type FxRateSnapshot,
} from '@mercaria/shared-types';
import { renderCandidateTerms, type BasketCandidate } from './candidates.js';

export interface SnapshotInput {
  readonly policy: ComparisonPolicyIdentity;
  readonly evaluatedAt: string;
  readonly request: BasketRequest;
  readonly candidates: readonly BasketCandidate[];
  readonly rates: readonly FxRateSnapshot[];
}

/**
 * Build the snapshot.
 *
 * `evaluatedAt` is deliberately NOT in the digest. A snapshot taken a second
 * later over an unchanged catalogue is the same input, and folding the clock in
 * would make every digest unique and the whole mechanism decorative. What the
 * digest covers is what could change an ANSWER: the request, the policy
 * versions, the candidate set, the prices and the rates.
 */
export function buildBasketSnapshot(input: SnapshotInput): BasketInputSnapshot {
  const candidateTerms: Record<string, string> = {};
  for (const candidate of input.candidates) {
    candidateTerms[candidate.offerRef] = renderCandidateTerms(candidate);
  }
  const candidateOfferRefs = [...input.candidates.map((candidate) => candidate.offerRef)].sort();

  return {
    digest: digestOf(input, candidateOfferRefs, candidateTerms),
    policy: input.policy,
    evaluatedAt: input.evaluatedAt,
    comparisonCurrency: input.request.comparisonCurrency,
    ...(input.request.market === undefined ? {} : { market: input.request.market }),
    request: input.request,
    candidateOfferRefs,
    rates: [...input.rates].sort((left, right) =>
      `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`),
    ),
    candidateTerms,
  };
}

/** The canonical serialization, hashed. */
function digestOf(
  input: SnapshotInput,
  candidateOfferRefs: readonly string[],
  candidateTerms: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [
    `policy:${input.policy.comparisonPolicyVersion}`,
    `ranking:${input.policy.rankingPolicyVersion}`,
    `constraints:${input.policy.constraintEvaluationVersion}`,
    `normalization:${input.policy.normalizationRuleVersion}`,
    `currency:${input.request.comparisonCurrency}`,
    `market:${input.request.market ?? ''}`,
    `channel:${input.request.channelPolicy}`,
    `conditions:${[...(input.request.conditionGroups ?? [])].sort().join('+')}`,
    `objectives:${[...input.request.objectives].sort().join(',')}`,
    `maxMerchants:${String(input.request.maxMerchants ?? '')}`,
    `excluded:${[...(input.request.excludedMerchantIds ?? [])].sort().join(',')}`,
    `pickup:${input.request.pickupPreference === undefined ? 'absent' : 'requested'}`,
  ];
  for (const line of [...input.request.lines].sort((left, right) =>
    left.lineId.localeCompare(right.lineId),
  )) {
    parts.push(
      [
        `line:${line.lineId}`,
        line.canonicalProductId,
        line.canonicalVariantId ?? '',
        String(line.quantity),
        [...(line.conditionGroups ?? [])].sort().join('+'),
        line.merchantId ?? '',
      ].join(':'),
    );
  }
  for (const ref of candidateOfferRefs) {
    parts.push(`offer:${ref}:${candidateTerms[ref] ?? 'unknown'}`);
  }
  for (const rate of [...input.rates].sort((left, right) =>
    `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`),
  )) {
    parts.push(`rate:${rate.from}->${rate.to}:${String(rate.rate)}:${rate.provider}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
