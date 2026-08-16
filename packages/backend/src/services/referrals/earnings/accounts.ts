/**
 * The account boundary: which ledger accounts a referral posting may name, and
 * the runtime walk that proves a real posting stayed inside it (#145's funding
 * invariant, expressed where the money would actually move).
 *
 * ## Four layers, and the fourth is the only one anybody notices
 *
 * 1. **The vocabulary.** `REFERRAL_LEDGER_ACCOUNTS` and
 *    `REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS` are DISJOINT and their union is
 *    exactly `LEDGER_ACCOUNTS` — so a fourteenth account fails the build until
 *    somebody decides which side it is on.
 * 2. **The signature.** Every builder in `ledger-postings.ts` takes a partner, an
 *    amount and a currency, and has NO account parameter. A retail cost account
 *    is not refused there, it is unrepresentable.
 * 3. **The scan.** `referral-earnings-isolation.test.ts` fails the build if any
 *    module in this domain names a forbidden account, imports the retail,
 *    procurement or fee domain, or reaches a pricing writer.
 * 4. **The answer.** {@link assertReferralPostingAccounts} walks a REAL entry set
 *    at the one place it is written and names the exact prohibition, so a
 *    refusal is a sentence about a zero-profit channel rather than
 *    "unrecognized account".
 *
 * The fourth exists because the first three are all STATIC. The realdb suite
 * walks a genuinely emitted posting through this function, which is the #92
 * two-gate rule — a scanned gate plus a runtime walk of a real emitted value —
 * applied to a chart of accounts.
 */

import {
  REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS,
  REFERRAL_FORBIDDEN_LEDGER_ACCOUNT_LABELS,
  REFERRAL_LEDGER_ACCOUNTS,
  type LedgerAccount,
  type LedgerOwnerType,
} from '@mercaria/shared-types';
import type { LedgerEntryInput } from '../../../db/payments/ledgerRepository.js';

/**
 * The owner type every `referral_payable` entry carries.
 *
 * A FOURTH `LedgerOwnerType` rather than a reuse of the partner's own
 * `store`/`user` pair: a `referral_partners` row is already identified by one of
 * those, so reusing it would file a partner's referral earnings under the SAME
 * key a seller's sales payable uses and make one owner key mean two unrelated
 * economic relationships.
 */
export const REFERRAL_PAYABLE_OWNER_TYPE: LedgerOwnerType = 'referral_partner';

/** Raised when a posting builder produced an entry outside the referral boundary. */
export class ForbiddenReferralLedgerAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenReferralLedgerAccountError';
  }
}

/** Whether one account is inside the referral boundary. */
export function isReferralLedgerAccount(account: LedgerAccount): boolean {
  return REFERRAL_LEDGER_ACCOUNTS.includes(account);
}

/**
 * Refuse an entry set that names an account outside the referral boundary,
 * BEFORE any SQL is issued.
 *
 * Throws rather than filtering, the `PAYMENT_METADATA_KEYS` decision: an account
 * that should not be there is a defect in the composition, and dropping the leg
 * silently would ship an unbalanced transaction the repository then refuses with
 * a message about arithmetic rather than about the boundary that was crossed.
 *
 * @throws {ForbiddenReferralLedgerAccountError}
 */
export function assertReferralPostingAccounts(
  entries: readonly LedgerEntryInput[],
  context: string,
): void {
  for (const entry of entries) {
    if (isReferralLedgerAccount(entry.account)) continue;
    const label = REFERRAL_FORBIDDEN_LEDGER_ACCOUNT_LABELS[entry.account];
    throw new ForbiddenReferralLedgerAccountError(
      `${context} tried to post to \`${entry.account}\`, which no referral movement may name: ` +
        `${label ?? 'it is outside the closed set ADR 0005 gives the referral program'}. The ` +
        `approved accounts are ${REFERRAL_LEDGER_ACCOUNTS.join(', ')}.`,
    );
  }
}

/**
 * Refuse a `referral_payable` entry that does not name the partner it is owed
 * to, or that names one under the wrong key space.
 *
 * The account is per-owner exactly as `merchant_payable` is, and a payable with
 * no owner is a platform-wide obligation to nobody — which every partner-scoped
 * balance read would then silently exclude, reporting a smaller figure than
 * Mercaria owes.
 *
 * @throws {ForbiddenReferralLedgerAccountError}
 */
export function assertReferralPayableOwners(
  entries: readonly LedgerEntryInput[],
  context: string,
): void {
  for (const entry of entries) {
    if (entry.account !== 'referral_payable') continue;
    if (entry.ownerType === REFERRAL_PAYABLE_OWNER_TYPE && (entry.ownerId ?? '') !== '') continue;
    throw new ForbiddenReferralLedgerAccountError(
      `${context} produced a \`referral_payable\` entry owned by ` +
        `\`${String(entry.ownerType)}/${String(entry.ownerId)}\`. Every referral payable names ` +
        `the \`referral_partners.id\` it is owed to, under owner type ` +
        `\`${REFERRAL_PAYABLE_OWNER_TYPE}\`.`,
    );
  }
}

/**
 * The two assertions together, for the one call site that writes.
 *
 * Exported as a pair so `posting.service.ts` cannot run one and forget the
 * other — the failure mode a reviewer would never see, because a posting that
 * names the right accounts and the wrong owner still balances and still commits.
 */
export function assertReferralPosting(entries: readonly LedgerEntryInput[], context: string): void {
  assertReferralPostingAccounts(entries, context);
  assertReferralPayableOwners(entries, context);
}

/**
 * The forbidden set, re-exported so a caller can name a prohibition without
 * importing the payment domain's own chart.
 *
 * Deliberately a re-export of the shared tuple rather than a second list: two
 * lists describing one prohibition can disagree, and the direction they disagree
 * in is always the permissive one.
 */
export const FORBIDDEN_REFERRAL_LEDGER_ACCOUNTS = REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS;
