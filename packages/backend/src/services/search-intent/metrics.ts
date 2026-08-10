/**
 * Process-local interpretation counters (#95 deterministic-fallback rule 8).
 *
 * PROCESS-LOCAL, and that is a decision rather than a shortcut — the
 * `ledgerImbalanceAttempts` and `recordShadowComparison` reasoning. Several ECS
 * tasks each observe their own traffic, and aggregation across them belongs to
 * `oxy-infra` scraping the operator endpoint, not to a durable counter row this
 * domain would then have to keep correct.
 *
 * ## These do NOT replace `search_intent_turns`, and the split matters
 *
 * The ROWS answer "what has the fallback rate been over the last hour, across
 * the deployment" — the question a rollout decision rests on. These counters
 * answer "what is happening on this task right now" — the question somebody
 * asks at 3am with a provider misbehaving, when a query against a table whose
 * writes are also failing is the last thing they want. Two different questions,
 * two different mechanisms, and each is wrong for the other's job.
 *
 * Nothing here is ever awaited and nothing here can throw: a counter that could
 * fail an interpretation would be a measurement that costs a shopper their
 * search, which is exactly the inversion `recordAnalyticsEvent`'s `void` return
 * type exists to prevent one domain over.
 */

import type { IntentFallbackReason, InterpretationMode } from '@mercaria/shared-types';

/** What one task has observed since it started. */
export interface SearchIntentCounters {
  readonly interpretations: number;
  readonly modelInterpretations: number;
  readonly deterministicInterpretations: number;
  /** Every reason that occurred on this task, with its count. */
  readonly fallbackReasons: Readonly<Partial<Record<IntentFallbackReason, number>>>;
  /**
   * Candidates refused by the injection scan.
   *
   * Counted SEPARATELY from the fallback reason it produces, because the two
   * answer different questions: `unsafe_model_output` in the fallback breakdown
   * is a rate, and this is an absolute count somebody watches during an
   * incident. A rate hides a burst inside a busy hour.
   */
  readonly unsafeCandidates: number;
  /** Since when. So a rate can be computed against a real window. */
  readonly since: string;
}

let interpretations = 0;
let modelInterpretations = 0;
let deterministicInterpretations = 0;
let unsafeCandidates = 0;
const fallbackReasons = new Map<IntentFallbackReason, number>();
const since = new Date().toISOString();

/** Record one served interpretation. Returns nothing; nothing may await it. */
export function countInterpretation(
  mode: InterpretationMode,
  reason: IntentFallbackReason | undefined,
): void {
  interpretations += 1;
  if (mode === 'model') {
    modelInterpretations += 1;
    return;
  }
  deterministicInterpretations += 1;
  if (reason === undefined) return;
  fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
}

/** Record one candidate the injection scan refused. */
export function countUnsafeCandidate(): void {
  unsafeCandidates += 1;
}

/** This task's counters. */
export function readSearchIntentCounters(): SearchIntentCounters {
  return {
    interpretations,
    modelInterpretations,
    deterministicInterpretations,
    fallbackReasons: Object.fromEntries(fallbackReasons),
    unsafeCandidates,
    since,
  };
}

/** Reset the counters. TEST-ONLY, and named so that is obvious in a grep. */
export function resetSearchIntentCountersForTests(): void {
  interpretations = 0;
  modelInterpretations = 0;
  deterministicInterpretations = 0;
  unsafeCandidates = 0;
  fallbackReasons.clear();
}
