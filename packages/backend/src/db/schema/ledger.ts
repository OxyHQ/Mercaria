/**
 * The internal ledger: `ledger_transactions` and `ledger_entries`.
 *
 * ADR 0001 D3 gives up Stripe's `application_fee_amount` reporting, because that
 * mechanism does not exist for separate charges and transfers. Mercaria's
 * commission is the difference between what the buyer paid and the sum of what
 * the sellers were paid — a quantity that exists NOWHERE except here. That is
 * what makes this table load-bearing from day one rather than accounting
 * hygiene, and why it lands before a single real charge is created.
 *
 * ## Three properties, enforced in three different places
 *
 * A rule enforced in one place is a rule that holds until someone writes a
 * second call site. These are enforced at every layer that could break them:
 *
 *  1. **Balance.** Every transaction sums to zero PER CURRENCY. Enforced by the
 *     repository (`db/payments/ledgerRepository.ts`), which is the ONLY writer
 *     and refuses an unbalanced set before issuing any SQL, and pinned by
 *     randomized property tests over mixed-currency entry sets.
 *  2. **Append-only.** Enforced by a database TRIGGER that raises on UPDATE and
 *     on DELETE against both tables — appended as raw SQL to the migration,
 *     because drizzle-kit does not emit triggers. A trigger and not a
 *     convention: `psql`, a backfill script and a future service all go through
 *     it, and none of them can be reviewed in advance.
 *  3. **Correction by reversal.** A mistake becomes a NEW transaction whose
 *     entries are the negatives of the wrong ones. There is no other mechanism,
 *     which is the point — an audit trail you can edit is not one.
 *
 * ## The sign convention
 *
 * `amount_minor` is SIGNED: positive is a DEBIT, negative is a CREDIT, and the
 * entries of one transaction sum to zero per currency. There is deliberately no
 * `direction` column beside it: two representations of one fact can disagree,
 * and `direction: 'credit'` next to a positive amount is a row nobody can
 * interpret and nothing can prevent. `LedgerAccount` in `@mercaria/shared-types`
 * carries the per-account table of what a positive entry MEANS.
 *
 * ## Why these amounts are `bigint` when every other money column is a number
 *
 * `CONVENTIONS.md` makes money `bigint({ mode: 'number' })` so it maps to the
 * `number` that `Money.amount` already is. A ledger entry is not a `Money`: it
 * never ships to a client, it is never rendered, and it is summed across
 * arbitrarily many rows by the one part of the system whose job is to be exactly
 * right. `mode: 'bigint'` keeps it exact past 2^53 and — more usefully day to
 * day — makes the zero-sum check `=== 0n` on values that cannot have silently
 * lost a minor unit on the way in. The bound that applies is the column's own
 * int8 range, asserted by `assertSafeLedgerAmount` at every posting builder.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxyhq/db';
import {
  LEDGER_ACCOUNTS,
  LEDGER_OWNER_TYPES,
  LEDGER_TRANSACTION_KINDS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, CURRENCY_CODE_VALUES } from './columns';
import { payments } from './payments';

/**
 * `ledger_transactions` — one balanced set of entries, and what caused it.
 *
 * ## No `updated_at`, and that absence is the contract
 *
 * `CONVENTIONS.md`: the ABSENCE of `updated_at` is the append-only contract.
 * Here it is doubly true — the trigger makes an UPDATE impossible, so a column
 * recording when one happened would describe an event that cannot occur.
 *
 * ## The correlation columns are nullable on purpose
 *
 * A charge names a payment; a refund names a refund; an operator adjustment may
 * name nothing at all beyond its own description. Requiring a correlation would
 * force whoever books an adjustment to invent one, and an invented id in a
 * financial record is worse than an absent one.
 */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(LEDGER_TRANSACTION_KINDS) }).notNull(),
    /**
     * The payment this movement belongs to. A real foreign key: `payments` is
     * this domain's own table, written by the same service in the same
     * transaction, so there is no window in which the parent is unreachable.
     *
     * `restrict` rather than `cascade` — a payment is not deletable, and if
     * something ever tried, blocking it is right: deleting the ledger rows would
     * be destroying the record of money that actually moved.
     */
    paymentId: text().references(() => payments.id, { onDelete: 'restrict' }),
    /** Correlation to a seller order — no foreign key; see `./payments`. */
    orderId: text(),
    /** Correlation to a refund — no foreign key, for the same reason. */
    refundId: text(),
    /**
     * The provider's own dispute reference. Named `_ref`, not `_id`, because it
     * is a foreign key space Mercaria neither mints nor resolves — the same
     * distinction `payouts.provider_account_ref` makes.
     */
    disputeRef: text(),
    /** One line, for a human reading a trace. Never a payload, never a secret. */
    description: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('ledger_transactions_kind_check', t.kind, LEDGER_TRANSACTION_KINDS),
    index('ledger_transactions_payment_id_created_at_idx')
      .on(t.paymentId, t.createdAt)
      .where(sql`${t.paymentId} is not null`),
    index('ledger_transactions_order_id_created_at_idx')
      .on(t.orderId, t.createdAt)
      .where(sql`${t.orderId} is not null`),
    index('ledger_transactions_refund_id_idx')
      .on(t.refundId)
      .where(sql`${t.refundId} is not null`),
    index('ledger_transactions_kind_created_at_idx').on(t.kind, t.createdAt),
  ],
);

/**
 * `ledger_entries` — one signed movement against one account in one currency.
 *
 * ## Zero is not a permitted amount
 *
 * The CHECK below refuses `amount_minor = 0`. A zero entry cannot unbalance a
 * transaction, which is exactly why it is worth refusing: it conveys nothing,
 * survives every balance check, and accumulates. A posting with no processor fee
 * OMITS the `processor_expense` leg rather than booking a zero one, and the
 * constraint is what makes that a rule instead of a habit.
 *
 * ## `owner_type` and `owner_id` travel together
 *
 * `merchant_payable` rows name the seller they are owed to; every other account
 * is platform-wide and leaves both NULL. The CHECK pins them to
 * "both present or both absent" — a type with no id is unusable and an id with
 * no type is ambiguous between a store and an Oxy user, which are different key
 * spaces that can collide.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: generatedId(),
    /**
     * `restrict`: a transaction with some of its entries deleted would be
     * unbalanced, which is the one state this whole table exists to make
     * unrepresentable. The append-only trigger already refuses the DELETE, so
     * this constraint is the second lock on the same door — and the one that
     * still holds if the trigger is ever dropped by a migration nobody read.
     */
    transactionId: text()
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    account: text({ enum: asEnumValues(LEDGER_ACCOUNTS) }).notNull(),
    /** `store` or `user` — set only on the per-seller accounts. */
    ownerType: text({ enum: asEnumValues(LEDGER_OWNER_TYPES) }),
    /**
     * The store id or Oxy user id this entry is owed to. POLYMORPHIC by
     * `owner_type` and permanently unconstrained: one of the two key spaces is
     * not even in this database.
     */
    ownerId: text(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** SIGNED minor units — positive debit, negative credit. See the file docblock. */
    amountMinor: bigint({ mode: 'bigint' }).notNull(),
    /** Which seller order this leg is about, when it is about one. No foreign key. */
    orderId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('ledger_entries_account_check', t.account, LEDGER_ACCOUNTS),
    checkOneOf('ledger_entries_owner_type_check', t.ownerType, LEDGER_OWNER_TYPES),
    ...currencyChecks('ledger_entries', [t.currency]),
    check('ledger_entries_amount_nonzero_check', sql`${t.amountMinor} <> 0`),
    check(
      'ledger_entries_owner_complete_check',
      sql`num_nonnulls(${t.ownerType}, ${t.ownerId}) in (0, 2)`,
    ),
    // Reading a transaction back — the balance check, and every trace.
    index('ledger_entries_transaction_id_idx').on(t.transactionId),
    // "What is the balance of this account in this currency?" — the account
    // statement every financial report is built from.
    index('ledger_entries_account_currency_created_at_idx').on(
      t.account,
      t.currency,
      t.createdAt,
    ),
    // "What do we owe this seller?" — partial, because only the payable rows
    // carry an owner and the platform-wide rows would otherwise dominate it.
    index('ledger_entries_owner_created_at_idx')
      .on(t.ownerType, t.ownerId, t.createdAt.desc())
      .where(sql`${t.ownerId} is not null`),
    index('ledger_entries_order_id_idx').on(t.orderId).where(sql`${t.orderId} is not null`),
  ],
);
