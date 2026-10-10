/**
 * The matching policy a deployment starts with, when it has none.
 *
 * #58's matcher evaluates nothing without an ACTIVE policy version
 * (`skipped: 'no_active_policy'`), and no migration creates one, so a fresh
 * deployment attaches no external price to any product until somebody
 * publishes a version. This module publishes the baseline once.
 *
 * ## What the baseline can and cannot do
 *
 * It automates exactly what needs no benchmark: the identifier stages (an
 * existing source link, a validated GTIN with one active owner, an MPN under an
 * agreeing brand), which `decideOutcome` treats as certain by construction. The
 * heuristic stages stay behind their category gates, and the baseline opens
 * none, so a title that merely resembles a product goes to review rather than
 * merging. The thresholds below only rank those reviews.
 *
 * Once ANY policy is active — the baseline or one an operator published — this
 * module does nothing, so it never supersedes a human decision.
 */

import { findActiveMatchPolicyVersion, insertMatchPolicyVersion } from '../../db/matching/matchPolicyRepository.js';
import { getDb } from '../../db/postgres.js';
import { log } from '../../lib/logger.js';
import { CATALOG_AUTOPILOT_ACTOR } from './actor.js';

export const BASELINE_MATCH_POLICY_KEY = 'baseline-identifier-v1';

/** Publish the baseline policy if no policy is active. Returns whether it did. */
export async function ensureActiveMatchPolicy(now: Date = new Date()): Promise<boolean> {
  const db = getDb();
  if ((await findActiveMatchPolicyVersion(db)) !== undefined) return false;
  try {
    await insertMatchPolicyVersion(db, {
      versionKey: BASELINE_MATCH_POLICY_KEY,
      status: 'active',
      description:
        'Baseline: identifier stages automatic, heuristic stages to review (no category gate is open).',
      autoMinConfidence: 0.95,
      reviewMinConfidence: 0.6,
      minCandidateSeparation: 0.05,
      maxCandidates: 25,
      minTitleSimilarity: 0.3,
      weightIdentifier: 6,
      weightBrand: 3,
      weightModel: 2,
      weightAttribute: 4,
      weightTitle: 1,
      weightCategory: 2,
      weightSemantic: 0,
      semanticEnabled: false,
      minBenchmarkPrecision: 0.98,
      minBenchmarkSamples: 200,
      createdByOxyUserId: CATALOG_AUTOPILOT_ACTOR,
      activatedAt: now,
    });
  } catch (error: unknown) {
    // Another task published it (or an operator activated one) in between: the
    // one-active partial unique refused the second, which is the outcome wanted.
    if ((await findActiveMatchPolicyVersion(db)) !== undefined) return false;
    throw error;
  }
  log.general.info({ versionKey: BASELINE_MATCH_POLICY_KEY }, '[CatalogAutopilot] baseline match policy published');
  return true;
}
