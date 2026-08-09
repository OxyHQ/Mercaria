/**
 * ADR 0001's "Ledger representability" table, as code.
 *
 * Every builder here is PURE: money in, entries out, no database, no clock, no
 * configuration. That is what lets the whole chart of accounts be table-tested
 * against worked examples — the same shape `enforcement-plan.ts` uses for
 * moderation, and for the same reason. The accounting is the part that has to be
 * right the first time, because a wrong posting is discovered by an accountant
 * months later rather than by a failing request.
 *
 * ## The sign convention, once more, because this is where it is applied
 *
 * `amountMinor` is SIGNED: **positive is a debit, negative is a credit**, and
 * every builder returns a set that sums to zero per currency. The commented
 * `debit`/`credit` labels below match ADR 0001's table column for column, so the
 * ADR can be read beside this file line by line.
 *
 * ## Where the numbers come from, and what this file refuses to invent
 *
 * Every amount is passed IN. Nothing here computes a commission rate, a fee or a
 * proration — those are decisions with their own owners (#88 owns the fee
 * schedule; the refund domain owns what is refundable) and a builder that
 * derived them would become a second place they are defined.
 *
 * The one arithmetic this file does is the residual: the buyer paid a gross, the
 * sellers are owed their nets, and Mercaria's commission is the difference. ADR
 * 0001 D3 makes that residual the SOLE source of commission truth — giving up
 * `application_fee_amount` reporting is precisely what the internal ledger
 * exists to replace — so it is computed here, from the figures above it, and
 * asserted to balance. The provider's fee is a separate EXPENSE, not a
 * deduction from it; see `chargeSucceeded`.
 */

import type { CurrencyCode, LedgerOwnerType, Money } from '@mercaria/shared-types';
import type {
  LedgerEntryInput,
  LedgerTransactionInput,
} from '../../db/payments/ledgerRepository.js';

/** A transaction header and the entries that balance it. */
export interface LedgerPosting {
  transaction: LedgerTransactionInput;
  entries: readonly LedgerEntryInput[];
}

/** What one seller order is owed out of a charge, and who is owed it. */
export interface SellerShare {
  orderId: string;
  ownerType: LedgerOwnerType;
  /** The store id or the P2P seller's Oxy user id. */
  ownerId: string;
  /** The seller's NET for this order, in the platform settlement currency. */
  netMinor: bigint;
}

/**
 * What one `mercaria_retail` order recovered out of a charge — ADR 0004 D7.
 *
 * It has NO owner, and the absence is the type doing its job. A `SellerShare`
 * names who is owed the money, and every reader that holds one goes on to
 * credit them a payable and then transfer it. A retail order's seller is
 * Mercaria: there is nobody to owe and nobody to pay, so a share of that shape
 * would be a receivable against ourselves that the settlement step would
 * happily try to send somewhere.
 */
export interface RetailRecoveryShare {
  orderId: string;
  /** This order's share of the charge, in the platform settlement currency. */
  recoveryMinor: bigint;
}

/** `Money.amount` as the `bigint` the ledger stores. */
export function toLedgerAmount(money: Money): bigint {
  return BigInt(money.amount);
}

/**
 * Charge succeeded — the posting that turns a captured payment into money owed.
 *
 * | Debit | Credit |
 * |---|---|
 * | provider clearing (G − F), processor expense (F) | merchant payable (ΣNᵢ, per order), commission revenue (C) |
 *
 * `C` is not a parameter. It is `G − ΣNᵢ` — the charge minus what the sellers
 * are owed — and computing it here rather than accepting it is the point: ADR
 * 0001 D3 DEFINES the commission as that residual, so a caller passing one could
 * disagree with the arithmetic and the ledger would balance anyway with the
 * wrong split.
 *
 * The fee is NOT subtracted from it. `F` is Mercaria's own cost (D5:
 * `fees.payer=application`), expensed on its own account, and the two legs
 * together say what the margin actually is: commission revenue `C` credited,
 * processor expense `F` debited, net `C − F`. Netting the fee into the
 * commission instead would balance just as well and would report a smaller
 * revenue against a cost that had vanished — which is precisely the kind of
 * wrong-but-balanced answer the per-leg assertions in the posting tests exist to
 * catch.
 *
 * A zero fee or a zero commission OMITS its leg rather than booking a zero one —
 * `ledger_entries` refuses a zero amount, and a fee-free rail (the `mock`
 * provider, a future direct-settlement one) is an ordinary case rather than an
 * exception.
 *
 * ## The retail legs, and why they change what the residual MEANS
 *
 * ADR 0004 D4 concern 8: a mixed group's split runs over ALL its orders so the
 * allocation stays exact, but a `mercaria_retail` order's share never enters
 * transfer creation or commission arithmetic. Here that is one credit to
 * `retail_cost_recovery` per retail order and one subtraction from the
 * residual.
 *
 * The subtraction is the load-bearing half. Without it the retail share would
 * still be booked — as `commission_revenue`, because the residual is DEFINED as
 * everything the sellers were not owed — and the ledger would balance perfectly
 * while reporting Mercaria margin on a sale whose planned margin is zero (D7
 * proof 1). So the commission is now "the charge minus what the sellers are
 * owed minus what retail recovered", which is ADR 0001 D3's residual restricted
 * to marketplace orders, exactly as D4 concern 8 words it.
 *
 * @param grossMinor What the platform received, in `currency`.
 * @param feeMinor The provider's processing fee, borne by Mercaria (ADR D5).
 * @param shares One entry per CONNECTED-MARKETPLACE seller order in the group.
 * @param retailShares One entry per `mercaria_retail` order in the group.
 *   Empty for every marketplace-only checkout, which is every checkout today.
 */
export function chargeSucceeded(input: {
  paymentId: string;
  currency: CurrencyCode;
  grossMinor: bigint;
  feeMinor: bigint;
  shares: readonly SellerShare[];
  retailShares?: readonly RetailRecoveryShare[];
}): LedgerPosting {
  const retailShares = input.retailShares ?? [];
  const payableTotal = input.shares.reduce((total, share) => total + share.netMinor, 0n);
  const retailTotal = retailShares.reduce((total, share) => total + share.recoveryMinor, 0n);
  const commissionMinor = input.grossMinor - payableTotal - retailTotal;

  const entries: LedgerEntryInput[] = [
    // Funds landed on the platform balance, net of what the provider kept.
    {
      account: 'provider_clearing',
      currency: input.currency,
      amountMinor: input.grossMinor - input.feeMinor,
    },
  ];
  if (input.feeMinor !== 0n) {
    entries.push({
      account: 'processor_expense',
      currency: input.currency,
      amountMinor: input.feeMinor,
    });
  }
  for (const share of input.shares) {
    if (share.netMinor === 0n) continue;
    entries.push({
      account: 'merchant_payable',
      currency: input.currency,
      amountMinor: -share.netMinor,
      ownerType: share.ownerType,
      ownerId: share.ownerId,
      orderId: share.orderId,
    });
  }
  // The retail legs. `orderId` and no owner: the entry names WHICH retail order
  // recovered the money — which is what makes D7 proof 2 (recovery bounded by
  // cost, per order) a query rather than an intention — while carrying nobody
  // to owe it to.
  for (const share of retailShares) {
    if (share.recoveryMinor === 0n) continue;
    entries.push({
      account: 'retail_cost_recovery',
      currency: input.currency,
      amountMinor: -share.recoveryMinor,
      orderId: share.orderId,
    });
  }
  if (commissionMinor !== 0n) {
    entries.push({
      account: 'commission_revenue',
      currency: input.currency,
      amountMinor: -commissionMinor,
    });
  }

  return {
    transaction: {
      kind: 'charge_succeeded',
      description: `Charge succeeded for payment ${input.paymentId}`,
      paymentId: input.paymentId,
    },
    entries,
  };
}

/**
 * Transfer created — the seller's receivable is settled and leaves the platform
 * balance.
 *
 * | Debit | Credit |
 * |---|---|
 * | merchant payable (Nᵢ) | provider clearing (Nᵢ) |
 *
 * ADR 0001 D6: from here the money is on the seller's own provider balance and
 * payout timing is between them and the provider. A failed PAYOUT does not
 * reopen this — which is why `payouts` books nothing at all.
 */
export function transferCreated(input: {
  paymentId: string;
  transferId: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'transfer_created',
      description: `Transfer ${input.transferId} for order ${input.orderId}`,
      paymentId: input.paymentId,
      orderId: input.orderId,
    },
    entries: [
      {
        account: 'merchant_payable',
        currency: input.currency,
        amountMinor: input.amountMinor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        orderId: input.orderId,
      },
      {
        account: 'provider_clearing',
        currency: input.currency,
        amountMinor: -input.amountMinor,
      },
    ],
  };
}

/**
 * Refund — money returned to the buyer, and who bears it.
 *
 * | Debit | Credit |
 * |---|---|
 * | merchant payable (R − c), commission revenue (c) | provider clearing (R) |
 *
 * The seller bears the refunded principal and Mercaria returns its commission
 * share on it (ADR 0001 D5). Debiting `commission_revenue` is what "returned"
 * means under the sign convention: the account's normal balance is a credit, so
 * a debit reduces it.
 *
 * ## Cross-currency asymmetry is expected and is NOT corrected here
 *
 * A provider refunds at the refund-time rate and does not return its original
 * conversion fee. ADR 0001 D7 is explicit that the refund legs are recorded at
 * their OWN captured amounts and never derived from the charge legs — so
 * `amountMinor` is what the provider actually moved, and the residual against
 * the original charge stays visible in the accounts rather than being smoothed
 * away.
 */
export function refundPosting(input: {
  paymentId: string;
  refundId: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  /** The total returned to the buyer. */
  amountMinor: bigint;
  /** Mercaria's commission share of it, returned with it. */
  commissionShareMinor: bigint;
}): LedgerPosting {
  const sellerShare = input.amountMinor - input.commissionShareMinor;
  const entries: LedgerEntryInput[] = [];
  if (sellerShare !== 0n) {
    entries.push({
      account: 'merchant_payable',
      currency: input.currency,
      amountMinor: sellerShare,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      orderId: input.orderId,
    });
  }
  if (input.commissionShareMinor !== 0n) {
    entries.push({
      account: 'commission_revenue',
      currency: input.currency,
      amountMinor: input.commissionShareMinor,
    });
  }
  entries.push({
    account: 'provider_clearing',
    currency: input.currency,
    amountMinor: -input.amountMinor,
  });

  return {
    transaction: {
      kind: 'refund',
      description: `Refund ${input.refundId} for order ${input.orderId}`,
      paymentId: input.paymentId,
      orderId: input.orderId,
      refundId: input.refundId,
    },
    entries,
  };
}

/**
 * Transfer reversal received — the seller's balance funded the refund, and the
 * money is back on the platform.
 *
 * | Debit | Credit |
 * |---|---|
 * | provider clearing | merchant payable |
 *
 * Separate from the refund itself, deliberately. A reversal can FAIL where the
 * refund did not (an insufficient seller balance with no reserve to cover it),
 * and ADR 0001 D7 says the buyer's refund is not blocked on it. Two
 * transactions is what lets the ledger show a refund that happened and a
 * recovery that did not, which is exactly the state the operator exception path
 * exists to surface.
 */
export function transferReversal(input: {
  paymentId: string;
  transferId: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
  refundId?: string;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'transfer_reversal',
      description: `Reversal of transfer ${input.transferId} for order ${input.orderId}`,
      paymentId: input.paymentId,
      orderId: input.orderId,
      ...(input.refundId ? { refundId: input.refundId } : {}),
    },
    entries: [
      {
        account: 'provider_clearing',
        currency: input.currency,
        amountMinor: input.amountMinor,
      },
      {
        account: 'merchant_payable',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        orderId: input.orderId,
      },
    ],
  };
}

/**
 * Dispute created — the platform balance is debited for the amount AND the fee.
 *
 * | Debit | Credit |
 * |---|---|
 * | disputes (D), processor expense (f) | provider clearing (D + f) |
 *
 * The principal sits in `disputes` until the outcome is known, rather than being
 * charged straight to the seller: a dispute is not yet a loss, and booking it as
 * one would make a won dispute look like a windfall. Recovering the principal
 * from the seller is a separate `transfer_reversal` (ADR 0001 D7).
 */
export function disputeCreated(input: {
  paymentId: string;
  disputeRef: string;
  orderId?: string;
  currency: CurrencyCode;
  amountMinor: bigint;
  feeMinor: bigint;
}): LedgerPosting {
  const entries: LedgerEntryInput[] = [
    {
      account: 'disputes',
      currency: input.currency,
      amountMinor: input.amountMinor,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
  ];
  if (input.feeMinor !== 0n) {
    entries.push({
      account: 'processor_expense',
      currency: input.currency,
      amountMinor: input.feeMinor,
    });
  }
  entries.push({
    account: 'provider_clearing',
    currency: input.currency,
    amountMinor: -(input.amountMinor + input.feeMinor),
  });

  return {
    transaction: {
      kind: 'dispute_created',
      description: `Dispute ${input.disputeRef} opened`,
      paymentId: input.paymentId,
      disputeRef: input.disputeRef,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
    entries,
  };
}

/**
 * Dispute won — the provider returns the principal.
 *
 * | Debit | Credit |
 * |---|---|
 * | provider clearing | disputes |
 *
 * The FEE is not returned and no leg reverses it: a lost fee on a won dispute is
 * a real cost Mercaria bore (ADR 0001 D5), and booking it back would overstate
 * revenue by the amount of every dispute ever raised.
 */
export function disputeWon(input: {
  paymentId: string;
  disputeRef: string;
  orderId?: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'dispute_won',
      description: `Dispute ${input.disputeRef} won`,
      paymentId: input.paymentId,
      disputeRef: input.disputeRef,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
    entries: [
      {
        account: 'provider_clearing',
        currency: input.currency,
        amountMinor: input.amountMinor,
      },
      {
        account: 'disputes',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        ...(input.orderId ? { orderId: input.orderId } : {}),
      },
    ],
  };
}

/**
 * Dispute lost — the held amount becomes the seller's loss.
 *
 * | Debit | Credit |
 * |---|---|
 * | merchant payable | disputes |
 *
 * The seller's receivable absorbs it, which is what "a lost dispute stays a
 * seller-side loss" means in accounts (ADR 0001 D7). Where the receivable is
 * already settled, the recovery is the paired `transfer_reversal`; this posting
 * only closes the `disputes` holding account.
 */
export function disputeLost(input: {
  paymentId: string;
  disputeRef: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'dispute_lost',
      description: `Dispute ${input.disputeRef} lost`,
      paymentId: input.paymentId,
      orderId: input.orderId,
      disputeRef: input.disputeRef,
    },
    entries: [
      {
        account: 'merchant_payable',
        currency: input.currency,
        amountMinor: input.amountMinor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        orderId: input.orderId,
      },
      {
        account: 'disputes',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        orderId: input.orderId,
      },
    ],
  };
}

/**
 * An operator correction, expressed as ordinary entries.
 *
 * The escape hatch, and it is deliberately not a special one: it produces the
 * same append-only rows as everything else and is subject to the same balance
 * rule. Reversing a previous transaction means passing this the negatives of its
 * entries — which is why there is no `reverseTransaction(id)` helper here. That
 * helper would need to READ the ledger to build its entries, making a correction
 * a function of what is already stored rather than of what an operator decided,
 * and it would quietly become the mechanism by which history is rewritten one
 * approved reversal at a time.
 */
export function adjustment(input: {
  description: string;
  entries: readonly LedgerEntryInput[];
  paymentId?: string;
  orderId?: string;
  refundId?: string;
  disputeRef?: string;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'adjustment',
      description: input.description,
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.refundId ? { refundId: input.refundId } : {}),
      ...(input.disputeRef ? { disputeRef: input.disputeRef } : {}),
    },
    entries: input.entries,
  };
}
