/**
 * The optional semantic scorer (#58 pipeline 6, acceptance 6).
 *
 * There is no scorer in this repository, and that is the shipped state. What is
 * here is the SEAM one would plug into, plus the three independent levers that
 * keep it off — because "semantic or LLM services can be disabled without
 * breaking deterministic matching" is only credible if the disabled path is the
 * one that runs by default and is therefore the one that is actually tested.
 *
 * ## Three levers, and why not one
 *
 * 1. **No scorer is registered.** The module-level slot starts empty. A
 *    deployment that never calls {@link registerSemanticScorer} has nothing to
 *    call, so this is not a flag anybody can flip by accident.
 * 2. **`config.matching.semanticEnabled`** — the operational kill switch, off by
 *    default. It exists so an incident can stop a registered scorer without a
 *    deploy, which is the situation a flag is actually for.
 * 3. **`match_policy_versions.semantic_enabled`** — the POLICY's own answer,
 *    off by default. A policy that never consulted a scorer stays reproducible
 *    forever even if one is later registered, which is what "outcomes can be
 *    compared" (operations 2) requires.
 *
 * They are three because they answer three different questions — is one
 * available, may we use it right now, and did THIS policy use it — and a single
 * flag would answer the first two and silently lie about the third.
 *
 * ## What a scorer may and may not do
 *
 * It RERANKS a candidate set a deterministic stage already produced. It cannot
 * introduce a candidate, because {@link SemanticScorer} is only ever handed ids
 * that retrieval returned, and it cannot carry a decision, because a candidate
 * whose only support is a similarity carries `no_deterministic_support` — a
 * blocker, which makes an automatic outcome unrepresentable at the database.
 * A scorer is therefore capable of changing which of two plausible candidates
 * wins and incapable of creating a merge on its own.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';

/** What a scorer is asked. Ids in, similarities out — no writes, no candidates. */
export interface SemanticScoringRequest {
  readonly subjectTitle: string;
  readonly subjectBrand: string | null;
  /** Candidate variant id → the canonical text to compare against. */
  readonly candidates: ReadonlyMap<string, string>;
}

export interface SemanticScorer {
  /** An id recorded in the decision's reason trace, so a rerank is attributable. */
  readonly id: string;
  /**
   * @returns Candidate variant id → similarity in `[0, 1]`. A candidate the
   *   scorer omits simply has no semantic feature, which the weighted mean
   *   handles as any other unknown.
   */
  score(request: SemanticScoringRequest): Promise<ReadonlyMap<string, number>>;
}

let registered: SemanticScorer | null = null;

/** Install a scorer. Deliberately explicit — nothing auto-discovers one. */
export function registerSemanticScorer(scorer: SemanticScorer): void {
  registered = scorer;
  log.general.info({ scorerId: scorer.id }, '[Matching] semantic scorer registered');
}

/** Remove the scorer. The state a fresh process is already in. */
export function clearSemanticScorer(): void {
  registered = null;
}

/**
 * The scorer to use for a policy, or `null`.
 *
 * All three levers, in one place, so no caller can consult two of them and
 * forget the third.
 */
export function resolveSemanticScorer(policySemanticEnabled: boolean): SemanticScorer | null {
  if (!policySemanticEnabled) return null;
  if (!config.matching.semanticEnabled) return null;
  return registered;
}

/**
 * Score, and fail OPEN to "no semantic feature".
 *
 * A scorer is an optional refinement of a ranking the deterministic stages
 * already produced. Letting its failure propagate would make an optional
 * dependency load-bearing — the outage would stop matching entirely rather than
 * degrading it to the behaviour the default deployment already has.
 */
export async function scoreSemantically(
  scorer: SemanticScorer,
  request: SemanticScoringRequest,
): Promise<ReadonlyMap<string, number>> {
  try {
    const scores = await scorer.score(request);
    const bounded = new Map<string, number>();
    for (const [candidateId, value] of scores) {
      // A scorer is external code. A value outside [0, 1] would fail the
      // candidate row's CHECK far from here, so it is clamped at the boundary
      // and a NaN is dropped rather than stored.
      if (!Number.isFinite(value)) continue;
      bounded.set(candidateId, Math.min(1, Math.max(0, value)));
    }
    return bounded;
  } catch (err) {
    log.general.warn({ err, scorerId: scorer.id }, '[Matching] semantic scoring failed; ignored');
    return new Map();
  }
}
