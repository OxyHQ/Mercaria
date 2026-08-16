/**
 * #144's affiliate funding port, filled (#67).
 *
 * `services/referrals/rewards/funding.ts` publishes
 * `registerAffiliateCommissionReader` with NO default implementation, so every
 * deployment that has not shipped #67 answers `reader_not_registered` and no
 * `affiliate` reward can be accrued anywhere. This is the registration that
 * closes it, and it is ONE function so the seam is a call site rather than an
 * import graph.
 *
 * ## The three answers, and why `undefined` is not zero
 *
 * ADR 0005 calculation rule 8 is that an ESTIMATE is not a base, and #144's
 * `not_yet_reconciled` exists to hold the difference. So:
 *
 * | The network says | This reader answers | The adapter reports |
 * |---|---|---|
 * | `pending` | `undefined` | `not_yet_reconciled` |
 * | `approved` / `paid` | the commission | a realized base |
 * | `declined` / `reversed` | **zero, in the transaction's own currency** | a realized base of zero |
 *
 * The last row is the one worth arguing about, and it is deliberate. A declined
 * commission is not an unanswered question — the network HAS decided, and it
 * decided nothing is owed. Reporting it as `not_yet_reconciled` would leave a
 * reward pending forever on money that will never arrive, which is a queue that
 * grows and never drains and which nobody would think to look at. Reporting the
 * realized answer of zero lets the rule compute zero and close.
 *
 * `pending` is the opposite case and must stay `undefined`: the network may
 * still approve it, so a base of zero would be a decision Mercaria made on the
 * network's behalf.
 *
 * ## `version` is the observation REVISION
 *
 * `affiliate_transactions.observation_count` equals the number of rows in the
 * append-only trail and therefore names the exact observation the amount came
 * from — which makes a base reproducible: an operator holding
 * `revision:4` can read `affiliate_transaction_observations` at revision 4 and
 * see precisely the figures that were used. It also MOVES whenever the network
 * restates, which is the signal #144 needs that a reward was accrued against an
 * amount that has since been superseded. A timestamp would not identify a row,
 * and the ledger transaction id would name a posting rather than the report
 * that caused it — and a `pending` transaction has no posting at all.
 */

import {
  AFFILIATE_EARNED_STATES,
  type CurrencyCode,
} from '@mercaria/shared-types';
import { registerAffiliateCommissionReader } from '../referrals/rewards/funding.js';
import { findAffiliateTransactionById } from '../../db/affiliateOutbound/transactionRepository.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';

/**
 * The reconciled commission for one `affiliate_transactions` id.
 *
 * @param recordRef An `affiliate_transactions.id`. A ref naming no row answers
 *   `undefined`, which the adapter reports as `not_yet_reconciled` rather than
 *   as `record_not_found` — #144's own choice of vocabulary, and the honest one
 *   here: a reward whose funding record has not been created yet and one whose
 *   network has not decided are the same fact from the rule's point of view.
 */
export async function readReconciledAffiliateCommission(input: {
  recordRef: string;
  db: DatabaseOrTransaction;
}): Promise<
  { amountMinor: number; currency: CurrencyCode; version: string; observedAt: Date } | undefined
> {
  const row = await findAffiliateTransactionById(input.db, input.recordRef);
  if (!row) return undefined;
  // `pending` is the network still deciding. See the table in the docblock.
  if (row.state === 'pending') return undefined;

  const earned = AFFILIATE_EARNED_STATES.includes(row.state);
  return {
    amountMinor: earned ? row.commissionAmount : 0,
    currency: row.commissionCurrency as CurrencyCode,
    version: `revision:${String(row.observationCount)}`,
    observedAt: row.lastObservedAt,
  };
}

/**
 * Register the reader. Called ONCE at boot.
 *
 * Not gated by `AFFILIATE_RECONCILIATION_ENABLED`, deliberately: that flag
 * gates the POLL, and a deployment that has stopped polling still holds
 * reconciled commissions a referral rule is entitled to read. Gating this would
 * make an incident lever silently change what a reward is worth.
 */
export function registerAffiliateCommissionFundingReader(): void {
  registerAffiliateCommissionReader(readReconciledAffiliateCommission);
}
