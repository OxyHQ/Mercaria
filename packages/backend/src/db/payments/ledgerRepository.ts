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

import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
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

/**
 * How many times this PROCESS has refused to write an unbalanced transaction.
 *
 * Issue #50's metric 8, and the only one whose correct value is a constant:
 * **it must stay zero.** A non-zero reading is not a degraded service, it is a
 * posting builder computing entries that do not balance — which means some
 * money movement has no accounting at all, because the refusal propagates as a
 * 500 rather than writing half a transaction.
 *
 * ## Deliberately process-local, and deliberately not a table
 *
 * Every alternative is worse for this particular number. A row would have to be
 * written by the same code path that has just refused to write, from inside a
 * transaction that is about to roll back — so the counter would be lost exactly
 * when it fired. A metrics library would be a dependency added for one integer
 * that should never move off zero.
 *
 * The cost is stated rather than hidden: this resets on restart and is per ECS
 * task, so `GET /internal/payments/metrics` reports what THIS task has seen. A
 * non-zero value is still unambiguous — the condition is impossible in normal
 * operation, so one is as alarming as a thousand — and the `error` log line at
 * the throw site is what survives the restart.
 */
let unbalancedAttempts = 0;

/** The counter above. See its docblock — the expected value is 0, always. */
export function ledgerImbalanceAttempts(): number {
  return unbalancedAttempts;
}

/**
 * Refuse a set of entries, counting the refusal.
 *
 * Every `throw` of {@link UnbalancedLedgerTransactionError} in this file goes
 * through here, so the counter cannot drift from the condition it measures the
 * way a `count++` beside each throw eventually would.
 */
function refuse(message: string): never {
  unbalancedAttempts += 1;
  throw new UnbalancedLedgerTransactionError(message);
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
 * The GLOBAL per-currency sum of every ledger entry — issue #50's jobs 5(b).
 *
 * Should always be empty. Every transaction is refused unless it sums to zero
 * per currency, and the append-only trigger refuses an edit afterwards, so the
 * sum of sums is zero by construction.
 *
 * It is audited anyway, on a timer, because "structurally impossible" and
 * "nobody has ever checked" are indistinguishable from outside the code — and
 * this is the cheapest check in the whole reconciliation package: one grouped
 * aggregate over one column, with the answer normally being no rows at all.
 *
 * @returns One entry per currency that does NOT net to zero. An empty array is
 *   the healthy answer.
 */
export async function findGlobalLedgerImbalances(
  db: DatabaseOrTransaction,
): Promise<{ currency: string; totalMinor: bigint }[]> {
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      total: sql<string>`sum(${ledgerEntries.amountMinor})`,
    })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.currency)
    .having(sql`sum(${ledgerEntries.amountMinor}) <> 0`);

  // `sum()` over an int8 column comes back as NUMERIC, which postgres.js hands
  // back as a STRING — reading it as a number would silently lose precision on
  // exactly the imbalance this exists to report.
  return rows.map((row) => ({ currency: row.currency, totalMinor: BigInt(row.total) }));
}

/**
 * Orders whose `merchant_payable` does not net to zero — issue #50's jobs 5(c).
 *
 * An open payable is ORDINARY and usually brief: it is credited when a charge
 * succeeds and closed when the transfer settles, so every order passes through
 * this state for as long as the settlement takes. `settledBefore` is what
 * separates that from a payable nobody is going to close — it excludes any order
 * whose payable has MOVED recently, so an in-flight settlement and an operator
 * mid-repair are both invisible here.
 *
 * The caller decides which of the results are genuinely unexplained, by looking
 * for the `transfer_withheld` or `reversal_failed` exception that would account
 * for one. That check is not in this query on purpose: it needs a jsonb payload
 * comparison per candidate, and doing it inside the aggregate would scan the
 * whole outbox to filter a handful of orders.
 */
export async function findOpenMerchantPayables(
  db: DatabaseOrTransaction,
  input: { settledBefore: Date; afterOrderId?: string; limit: number },
): Promise<{ orderId: string; currency: string; totalMinor: bigint; lastMovedAt: Date }[]> {
  const rows = await db
    .select({
      orderId: sql<string>`${ledgerEntries.orderId}`,
      currency: ledgerEntries.currency,
      total: sql<string>`sum(${ledgerEntries.amountMinor})`,
      // Typed `string`, and the mapping happens below. `CONVENTIONS.md`'s third
      // trap: a raw `sql` fragment bypasses drizzle's column mappers, so a
      // `timestamptz` inside an AGGREGATE comes back as a raw string however the
      // generic is annotated — and `sql<Date>` here would be a type assertion
      // that is simply false, crashing at the first `.toISOString()` on a code
      // path that only runs when a real discrepancy exists.
      lastMovedAt: sql<string>`max(${ledgerTransactions.createdAt})`,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerEntries.account, 'merchant_payable'),
        isNotNull(ledgerEntries.orderId),
        ...(input.afterOrderId ? [gt(ledgerEntries.orderId, input.afterOrderId)] : []),
      ),
    )
    .groupBy(ledgerEntries.orderId, ledgerEntries.currency)
    .having(
      and(
        sql`sum(${ledgerEntries.amountMinor}) <> 0`,
        // `.toISOString()` with an explicit cast, NEVER a bare `Date`.
        // `CONVENTIONS.md`: a comparison against an EXPRESSION has no column to
        // take a type from, so postgres.js is handed a raw `Date` and refuses it
        // with `ERR_INVALID_ARG_TYPE` — a hard failure at query time on code that
        // type-checks perfectly. `gte(column, date)` is fine; `max(...) < date`
        // is not, and this is the second instance of that trap in this repo.
        sql`max(${ledgerTransactions.createdAt}) < ${input.settledBefore.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(sql`${ledgerEntries.orderId}`)
    .limit(input.limit);

  return rows.map((row) => ({
    orderId: row.orderId,
    currency: row.currency,
    // `sum()` over an int8 column comes back as NUMERIC, which postgres.js hands
    // back as a STRING — reading it as a number would silently lose precision on
    // exactly the balance this exists to report.
    totalMinor: BigInt(row.total),
    lastMovedAt: new Date(row.lastMovedAt),
  }));
}

/**
 * What has been booked to one account for one payment, per currency.
 *
 * The amount side of #50's jobs 3: a refund's own platform figure never reaches
 * a Mercaria column — it goes straight into the ledger — so the only way to
 * compare it against what the rail says the platform balance lost is to read the
 * book back.
 */
export async function sumLedgerAccountForRefund(
  db: DatabaseOrTransaction,
  input: { refundId: string; account: LedgerAccount },
): Promise<{ currency: string; totalMinor: bigint }[]> {
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      total: sql<string>`sum(${ledgerEntries.amountMinor})`,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(eq(ledgerTransactions.refundId, input.refundId), eq(ledgerEntries.account, input.account)),
    )
    .groupBy(ledgerEntries.currency);

  return rows.map((row) => ({ currency: row.currency, totalMinor: BigInt(row.total) }));
}

/**
 * Payment ids that have NO ledger transaction of a given kind.
 *
 * The absence check behind `ledger_transaction_missing` (#50, jobs 5(a)). A
 * trigger prevents a booked transaction being edited away; nothing prevents one
 * never being written, and under ADR 0001 D3 the ledger is the only place
 * commission exists — so a charge with no `charge_succeeded` is revenue that
 * exists nowhere.
 *
 * Written as a NOT EXISTS over the candidate ids rather than a left join from
 * `payments`, so the caller keeps its own pagination and this stays a question
 * about a bounded set it already holds.
 */
export async function paymentsMissingLedgerKind(
  db: DatabaseOrTransaction,
  input: { paymentIds: readonly string[]; kind: LedgerTransactionKind },
): Promise<Set<string>> {
  if (input.paymentIds.length === 0) return new Set();
  const found = await db
    .selectDistinct({ paymentId: ledgerTransactions.paymentId })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.kind, input.kind),
        inArray(ledgerTransactions.paymentId, [...input.paymentIds]),
      ),
    );

  const booked = new Set(found.map((row) => row.paymentId).filter((id): id is string => id !== null));
  return new Set(input.paymentIds.filter((id) => !booked.has(id)));
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
    refuse(
      `A ledger transaction needs at least two entries to balance; '${transaction.kind}' has ` +
        `${String(entries.length)}.`,
    );
  }

  for (const [index, entry] of entries.entries()) {
    assertSafeLedgerAmount(entry.amountMinor, `${transaction.kind}.entries[${String(index)}]`);
    if (entry.amountMinor === 0n) {
      refuse(
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
    refuse(
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
