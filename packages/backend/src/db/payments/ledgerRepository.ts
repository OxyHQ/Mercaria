/**
 * The ONLY writer of `ledger_transactions` and `ledger_entries`.
 *
 * There is one exported write function and it takes a whole transaction with all
 * of its entries, because a ledger transaction is not a row that later grows
 * legs — it is balanced or it does not exist. An API that let a caller insert an
 * entry would make "unbalanced" a reachable state for as long as the caller took
 * to insert the next one, and a crash in between would make it permanent.
 *
 * ## Three checks, and the order they run in matters
 *
 * 1. Structural: at least two entries. One entry cannot balance against nothing,
 *    and a transaction with none is a description of a movement that did not
 *    happen.
 * 2. Range: every amount within the `bigint` column's own limits, asserted
 *    against the POSTING that produced it rather than against the INSERT that
 *    rejected it — the error names the builder.
 * 3. Balance: the entries sum to exactly zero PER CURRENCY. Per currency, not
 *    overall: a cross-currency movement books both legs in their own currencies
 *    at a captured rate (ADR 0001 D8), and adding a EUR amount to a USD one to
 *    reach zero would be arithmetic on two different things.
 *
 * All three run BEFORE any SQL. The database enforces the rest — a trigger
 * refuses UPDATE and DELETE, a CHECK refuses a zero amount, a foreign key
 * refuses an orphan entry — but the balance is the one property no single-row
 * constraint can express, which is exactly why it lives here and is pinned by
 * randomized property tests rather than by review.
 */

import {
  assertSafeLedgerAmount,
  type CurrencyCode,
  type LedgerAccount,
  type LedgerOwnerType,
  type LedgerTransactionKind,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { ledgerEntries, ledgerTransactions } from '../schema/ledger.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One signed leg of a balanced movement. */
export interface LedgerEntryInput {
  account: LedgerAccount;
  currency: CurrencyCode;
  /** SIGNED minor units — positive debit, negative credit. Never zero. */
  amountMinor: bigint;
  /** Set together, on the per-seller accounts only. */
  ownerType?: LedgerOwnerType;
  ownerId?: string;
  /** Which seller order this leg is about, when it is about one. */
  orderId?: string;
}

/** The transaction header: what happened, and what it was about. */
export interface LedgerTransactionInput {
  kind: LedgerTransactionKind;
  description: string;
  paymentId?: string;
  orderId?: string;
  refundId?: string;
  disputeRef?: string;
}

/** What a caller gets back — enough to correlate, never the rows themselves. */
export interface InsertedLedgerTransaction {
  id: string;
  entryIds: readonly string[];
}

/**
 * Raised when a caller tries to write a set of entries that is not a ledger
 * transaction.
 *
 * A distinct class, not a bare `Error`: the payment service catches nothing and
 * lets this propagate, so it surfaces as a 500 with a message naming the exact
 * imbalance. That is the right outcome — an unbalanced posting is a bug in a
 * posting builder, and completing the payment while silently dropping the
 * accounting would be worse than failing the request.
 */
export class UnbalancedLedgerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedLedgerTransactionError';
  }
}

/** `{EUR: 0n, USD: -1n}` — the per-currency sums, in input order. */
function sumByCurrency(entries: readonly LedgerEntryInput[]): Map<CurrencyCode, bigint> {
  const sums = new Map<CurrencyCode, bigint>();
  for (const entry of entries) {
    sums.set(entry.currency, (sums.get(entry.currency) ?? 0n) + entry.amountMinor);
  }
  return sums;
}

/**
 * Check a set of entries without writing it.
 *
 * Exported so a posting builder can be unit-tested against the same rule the
 * repository enforces, rather than against a re-statement of it that can drift.
 *
 * @returns the offending currencies, empty when the set balances.
 */
export function findUnbalancedCurrencies(entries: readonly LedgerEntryInput[]): CurrencyCode[] {
  return [...sumByCurrency(entries)]
    .filter(([, total]) => total !== 0n)
    .map(([currency]) => currency);
}

/**
 * Write one balanced transaction and its entries, atomically.
 *
 * @param db A database handle or an OPEN transaction. Taking either is the whole
 *   point: a charge's ledger postings must commit with the payment status
 *   transition that caused them, and a helper typed only as `Database` would
 *   silently run outside its caller's transaction — which is how a payment
 *   succeeds with no accounting, or accounting with no payment.
 * @throws {UnbalancedLedgerTransactionError} When the entries do not sum to zero
 *   per currency, or there are fewer than two of them.
 * @throws {RangeError} When an amount is outside the column's range.
 */
export async function insertLedgerTransaction(
  db: DatabaseOrTransaction,
  transaction: LedgerTransactionInput,
  entries: readonly LedgerEntryInput[],
): Promise<InsertedLedgerTransaction> {
  if (entries.length < 2) {
    throw new UnbalancedLedgerTransactionError(
      `A ledger transaction needs at least two entries to balance; '${transaction.kind}' has ` +
        `${String(entries.length)}.`,
    );
  }

  for (const [index, entry] of entries.entries()) {
    assertSafeLedgerAmount(entry.amountMinor, `${transaction.kind}.entries[${String(index)}]`);
    if (entry.amountMinor === 0n) {
      throw new UnbalancedLedgerTransactionError(
        `A ledger entry may not be zero: '${transaction.kind}' entry ${String(index)} on ` +
          `'${entry.account}' carries no amount. Omit the leg instead of booking nothing.`,
      );
    }
  }

  const unbalanced = findUnbalancedCurrencies(entries);
  if (unbalanced.length > 0) {
    const sums = sumByCurrency(entries);
    const detail = unbalanced
      .map((currency) => `${currency}=${String(sums.get(currency) ?? 0n)}`)
      .join(', ');
    throw new UnbalancedLedgerTransactionError(
      `Ledger transaction '${transaction.kind}' does not balance to zero per currency: ${detail}.`,
    );
  }

  const transactionId = uuidv7();
  const rows = entries.map((entry) => ({
    id: uuidv7(),
    transactionId,
    account: entry.account,
    currency: entry.currency,
    amountMinor: entry.amountMinor,
    ...(entry.ownerType ? { ownerType: entry.ownerType } : {}),
    ...(entry.ownerId ? { ownerId: entry.ownerId } : {}),
    ...(entry.orderId ? { orderId: entry.orderId } : {}),
  }));

  await db.insert(ledgerTransactions).values({
    id: transactionId,
    kind: transaction.kind,
    description: transaction.description,
    ...(transaction.paymentId ? { paymentId: transaction.paymentId } : {}),
    ...(transaction.orderId ? { orderId: transaction.orderId } : {}),
    ...(transaction.refundId ? { refundId: transaction.refundId } : {}),
    ...(transaction.disputeRef ? { disputeRef: transaction.disputeRef } : {}),
  });
  await db.insert(ledgerEntries).values(rows);

  return { id: transactionId, entryIds: rows.map((row) => row.id) };
}
