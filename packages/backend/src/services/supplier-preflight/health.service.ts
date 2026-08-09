/**
 * Automatic suppression when a supplier's live-quote capability is unhealthy
 * beyond policy (#122 operations 6).
 *
 * ## Automatic in ONE direction, and bounded in the other
 *
 * This loop may RAISE a `health_degraded` suppression and may LIFT one it
 * raised. It cannot raise a `kill_switch` — the CHECK on
 * `supplier_preflight_suppressions` restricts `origin = 'automatic_health'` to
 * that one kind and to a NULL raiser — so the power an operator holds stays an
 * operator's, and the automatic stop stays visibly automatic in the trail.
 *
 * It also cannot lift an OPERATOR's stop, and that asymmetry is deliberate: a
 * provider recovering is evidence about the provider, not about whatever
 * commercial or compliance reason a person had for stopping it.
 *
 * ## Every automatic stop carries its own expiry
 *
 * `expiresAt` is required for an automatic origin (a CHECK), so a stop raised
 * during an outage lapses on its own even if this loop never runs again. That
 * is the opposite posture from a compliance suppression, which must be lifted
 * deliberately — and it is right here because the thing being suppressed is a
 * transient capability, not a judgement about a product.
 *
 * ## An absent or thin measurement suppresses NOTHING
 *
 * `deriveSupplierHealthVerdict` answers `degraded: false` below the policy's
 * sample floor and on a stale window. Suppressing a brand-new supplier account
 * on its first three calls would make a first integration impossible to
 * complete, and suppressing on a stale window would turn a quiet night into an
 * outage — the `SELLER_TRUST_RESTRICTED_TIERS` rule (#92): restricting on
 * absence turns a metrics gap into a delisting.
 */

import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  deriveSupplierHealthVerdict,
  listSupplierPreflightHealth,
  type SupplierHealthVerdict,
} from '../../db/supplierPreflight/healthRepository.js';
import {
  findLiveSupplierPreflightSuppression,
  liftSupplierPreflightSuppression,
  raiseSupplierPreflightSuppression,
} from '../../db/supplierPreflight/suppressionRepository.js';
import { findActiveSupplierSourcingPolicy } from '../../db/supplierPreflight/sourcingPolicyRepository.js';
import { SUPPLIER_SOURCING_POLICY_KEY } from './preflight.service.js';

/** What one evaluation pass did. Returned so a test can assert without a clock. */
export interface SupplierHealthEvaluation {
  evaluated: number;
  raised: number;
  lifted: number;
  /** Accounts whose window said nothing — below the sample floor, or stale. */
  withheld: number;
}

/**
 * Evaluate every supplier account against the active policy's thresholds.
 *
 * No-ops entirely with no active policy: "beyond policy" needs a policy to be
 * beyond, and inventing default thresholds here would make an operator's
 * published version optional — a suppression nobody can date to a decision.
 */
export async function evaluateSupplierPreflightHealth(
  options: { now?: Date; db?: DatabaseOrTransaction } = {},
): Promise<SupplierHealthEvaluation> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const result: SupplierHealthEvaluation = { evaluated: 0, raised: 0, lifted: 0, withheld: 0 };

  const policy = await findActiveSupplierSourcingPolicy(
    { policyKey: SUPPLIER_SOURCING_POLICY_KEY, at: now },
    db,
  );
  if (!policy) return result;

  // The accounts with a health row are exactly the accounts that have been
  // called. An account nobody has called cannot be degraded, so iterating this
  // table rather than every supplier account is not an optimisation — it is the
  // set the question is about, and it keeps this domain from needing a
  // list-every-account read the procurement domain does not offer.
  const windows = await listSupplierPreflightHealth(db);
  for (const health of windows) {
    const account = { id: health.supplierAccountId };
    result.evaluated += 1;
    const verdict = deriveSupplierHealthVerdict(
      health,
      {
        windowMinutes: policy.healthWindowMinutes,
        minimumSamples: policy.healthMinimumSamples,
        maxFailureBps: policy.healthMaxFailureBps,
      },
      now,
    );

    if (verdict.successBps === null) {
      result.withheld += 1;
      continue;
    }

    const live = await findLiveSupplierPreflightSuppression(
      {
        scope: 'supplier_account',
        supplierId: null,
        supplierAccountId: account.id,
        marketCountry: null,
        kind: 'health_degraded',
      },
      db,
    );

    if (verdict.degraded && !live) {
      await raiseSupplierPreflightSuppression(
        {
          scope: 'supplier_account',
          supplierId: null,
          supplierAccountId: account.id,
          marketCountry: null,
          kind: 'health_degraded',
          origin: 'automatic_health',
          reason: describeDegradation(verdict, policy.healthMaxFailureBps),
          sourcingPolicyId: policy.id,
          raisedByOxyUserId: null,
          effectiveFrom: now,
          expiresAt: new Date(now.getTime() + policy.healthSuppressionMinutes * 60_000),
        },
        db,
      );
      result.raised += 1;
      log.general.warn(
        { supplierAccountId: account.id, successBps: verdict.successBps, samples: verdict.samples },
        '[SupplierPreflight] supplier account suppressed automatically on degraded health',
      );
      continue;
    }

    // Only an AUTOMATIC stop is lifted automatically. An operator's kill switch
    // survives a provider recovering, because it was never about the provider
    // recovering.
    if (!verdict.degraded && live && live.origin === 'automatic_health') {
      await liftSupplierPreflightSuppression(
        {
          suppressionId: live.id,
          liftedByOxyUserId: null,
          liftReason: `Health recovered to ${String(verdict.successBps)} bps over ${String(verdict.samples)} samples.`,
          now,
        },
        db,
      );
      result.lifted += 1;
      log.general.info(
        { supplierAccountId: account.id, successBps: verdict.successBps },
        '[SupplierPreflight] automatic health suppression lifted',
      );
    }
  }

  return result;
}

/** The reason text a raised stop carries. Numbers only — no provider message. */
function describeDegradation(verdict: SupplierHealthVerdict, maxFailureBps: number): string {
  const failureBps = verdict.successBps === null ? 10_000 : 10_000 - verdict.successBps;
  return (
    `Live quote failure rate ${String(failureBps)} bps over ${String(verdict.samples)} samples ` +
    `exceeds the policy ceiling of ${String(maxFailureBps)} bps.`
  );
}
