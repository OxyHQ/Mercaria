/**
 * Connected-account readiness, independently of onboarding redirects — issue
 * #50, jobs 6.
 *
 * ## It REUSES #46's sweep and adds nothing to it
 *
 * `reconcileStaleAccounts` already asks the one question that matters — which
 * accounts have not been read lately, and what does Stripe say about them now —
 * with the ordering (oldest first, never-synced ahead of everything), the
 * per-account isolation and the lease-free argument all worked out. Writing a
 * second sweep here would have been two loops racing to re-read the same
 * accounts, each halving the other's usefulness.
 *
 * What #50 added was the RETURN. That sweep used to report two counters, which
 * can say whether it ran and cannot say which seller is stuck — so it now
 * reports the accounts that FAILED and the ones that DRIFTED, and this file
 * turns both into discrepancy rows.
 *
 * ## Drift is recorded even though the sweep has already fixed it
 *
 * A re-read that MOVES the stored state means an `account.updated` was never
 * delivered. The state is correct by the time this sees it, so nothing needs
 * repairing — but a seller whose readiness silently lagged is a seller who
 * silently could not be sold through (ADR 0001 D9 gates checkout on exactly this
 * verdict), and the lag can be up to `STRIPE_ACCOUNT_SYNC_STALE_AFTER_MS`.
 *
 * So the row is `warning` and it is resolved by the same call that raises it:
 * the finding is a record that a webhook was lost, not a task. If drift keeps
 * appearing for the same account, `occurrences` on that one row is what says so
 * — which is the signal an operator actually wants, and one a
 * raise-without-resolving design would have buried under a hundred open rows.
 */

import { reconcileStaleAccounts } from '../stripe/account-reconciler.js';
import { reportDiscrepancy, resolveDetectedDiscrepancy } from './discrepancy.service.js';

/** What one run of this job did. */
export interface AccountReadinessResult {
  refreshed: number;
  failed: number;
  discrepancies: number;
}

/**
 * Re-read one batch of stale connected accounts and record what was odd.
 *
 * Not paginated with a cursor, unlike the other three jobs, and it needs no
 * apology: #46's sweep is ALREADY a cursor, expressed as a column —
 * `provider_accounts.last_synced_at`, visited oldest first. A batch that
 * succeeds advances it for every account it touched, so the next run naturally
 * starts where this one stopped without anything being persisted here.
 */
export async function reconcileAccountReadiness(input: {
  limit: number;
}): Promise<AccountReadinessResult> {
  const sweep = await reconcileStaleAccounts({ batchSize: input.limit });

  let discrepancies = 0;
  for (const observation of sweep.observations) {
    if (observation.error !== undefined) {
      await reportDiscrepancy({
        kind: 'account_sync_failed',
        provider: 'stripe',
        // The ROW id, not the connected-account id: the account id is redacted
        // in every observation (a full one in an aggregated log store is a
        // durable link between a store and one merchant's finances), and a
        // redacted value is not unique enough to key a queue on.
        correlationKey: observation.accountRowId,
        detail: {
          ownerType: observation.ownerType,
          ownerId: observation.ownerId,
          providerAccountId: observation.providerAccountId,
          error: observation.error,
        },
      });
      discrepancies += 1;
      continue;
    }

    if (observation.drift) {
      const row = await reportDiscrepancy({
        kind: 'account_state_drift',
        provider: 'stripe',
        correlationKey: observation.accountRowId,
        detail: {
          ownerType: observation.ownerType,
          ownerId: observation.ownerId,
          providerAccountId: observation.providerAccountId,
          from: observation.drift.from,
          to: observation.drift.to,
        },
      });
      // Raised and closed in one call — see the file docblock. The record is
      // that a webhook was lost; the state itself is already correct.
      await resolveDetectedDiscrepancy({
        discrepancyId: row.id,
        reason: 'converged_from_provider',
        note:
          `The sweep re-read the account and applied '${observation.drift.from}' → ` +
          `'${observation.drift.to}'. Nothing is outstanding; the row records that no ` +
          'account.updated arrived for this change.',
      });
      discrepancies += 1;
    }
  }

  return { refreshed: sweep.refreshed, failed: sweep.failed, discrepancies };
}
