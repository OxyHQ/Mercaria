/**
 * Which ranking policy a comparison is served under (#74 policy rule 1,
 * acceptance 7).
 *
 * The one module in this domain that reads the policy table; everything else
 * takes a {@link RankingPolicy} as an argument. That is what keeps the scorer
 * pure and what makes "run this comparison under version X instead" — the
 * operator surface's whole job — a matter of passing a different value rather
 * than of a second code path.
 *
 * ## A deployment with no published policy still ranks
 *
 * `BUILTIN_RANKING_POLICY` is a real, named version and every ranked result says
 * so. See `policy.ts` for why this domain diverges from #58's and #121's "no
 * active version ⇒ refuse": the two answer questions with opposite consequences,
 * and refusing here would withdraw the comparison surface on the deploy that
 * shipped it.
 *
 * ## The canary lever stops routing, never the row
 *
 * `RANKING_CANARY_ENABLED=false` pins every subject to the active arm and
 * changes nothing about the canary version, so an incident is one variable and a
 * resumption is one variable back. Editing the row to stop it would lose the
 * ramp somebody set, and — since a stopped canary may never return to `draft` —
 * would not be reversible at all.
 */

import type { RankingPolicy } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findRankingPolicyVersion,
  findServingRankingPolicies,
  type RankingPolicyVersionRow,
} from '../../db/ranking/rankingPolicyRepository.js';
import {
  BUILTIN_RANKING_POLICY,
  OFFER_COMPARISON_POLICY_KEY,
  rankingPolicyFromRow,
  resolveRankingArm,
} from './policy.js';

/**
 * Resolve the policy for one comparison SUBJECT.
 *
 * `subjectKey` is the canonical variant or product being compared — never a
 * person, a session or a device. A rollout over the catalogue is reproducible
 * from the operator surface with nothing in hand but the product id; a rollout
 * over people would be an experiment, which is #77's domain and carries its own
 * consent and retention rules.
 */
export async function resolveRankingPolicy(
  subjectKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicy> {
  const serving = await findServingRankingPolicies(OFFER_COMPARISON_POLICY_KEY, db);
  if (serving.length === 0) return BUILTIN_RANKING_POLICY;

  const active = serving.find((row) => row.status === 'active');
  const canary = serving.find((row) => row.status === 'canary');

  if (canary !== undefined && config.ranking.canaryEnabled) {
    const arm = resolveRankingArm({
      policyKey: OFFER_COMPARISON_POLICY_KEY,
      subjectKey,
      canaryShareBps: canary.canaryShareBps,
    });
    if (arm === 'canary') return rankingPolicyFromRow(canary, 'canary');
  }

  // A canary with no active version beside it is a legitimate state — the first
  // published policy can be introduced as one — and the subjects it did not take
  // fall to the built-in rather than to nothing.
  return active === undefined ? BUILTIN_RANKING_POLICY : rankingPolicyFromRow(active, 'active');
}

/**
 * Resolve ONE named version, for the operator surface's comparison.
 *
 * The arm reported is `active`, which is honest rather than convenient: this is
 * a policy being EVALUATED against an input, not one serving a rollout, and
 * labelling it `canary` would put a rollout arm on a result nobody was routed
 * to. The built-in is addressable by its own version string, so a comparison
 * against "what a fresh deployment would do" needs no special case.
 */
export async function resolveNamedRankingPolicy(
  version: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RankingPolicy | null> {
  if (version === BUILTIN_RANKING_POLICY.version) return BUILTIN_RANKING_POLICY;
  const row: RankingPolicyVersionRow | null = await findRankingPolicyVersion(
    OFFER_COMPARISON_POLICY_KEY,
    version,
    db,
  );
  return row === null ? null : rankingPolicyFromRow(row, 'active');
}
