/**
 * The ledger's two invariants, against a REAL PostgreSQL database.
 *
 * ## Why this cannot be a mocked test
 *
 * Both invariants are enforced by the SERVER, and a mock cannot tell you whether
 * the server would accept a write:
 *
 *  - **Balance** is checked by the repository before any SQL, so a mock would
 *    exercise it — but the CHECK constraints, the foreign key and the `bigint`
 *    round trip beside it are all server-side, and a mocked `insert` accepts a
 *    zero amount, an orphan entry and an out-of-range value alike.
 *  - **Append-only** is a TRIGGER. There is no mock of a trigger; asserting
 *    against one is the only way to know it exists, and the only way to notice a
 *    later migration dropping it.
 *
 * ## Randomized, with a logged seed
 *
 * The balance property is not "this one worked example balances", it is "every
 * set that sums to zero per currency is accepted and every set that does not is
 * refused". A generator is what states that, and a SEEDED one is what makes a
 * failure reproducible — the seed is printed on every run, so a red build can be
 * replayed exactly by pasting it back. No new dependency: `xorshift32` below is
 * six lines and deterministic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import { ledgerEntries, ledgerTransactions } from '../../schema/ledger.js';
import {
  findUnbalancedCurrencies,
  insertLedgerTransaction,
  UnbalancedLedgerTransactionError,
  type LedgerEntryInput,
} from '../ledgerRepository.js';
import type { Database } from '../../postgres.js';

/** Accounts the generator draws from. Every one of the seven, so none is untested. */
const ACCOUNTS = [
  'provider_clearing',
  'merchant_payable',
  'commission_revenue',
  'processor_expense',
  'refunds',
  'disputes',
  'reserves',
] as const;

/**
 * Currencies the generator mixes.
 *
 * FAIR is in the list on purpose: it carries EIGHT decimals, so its amounts are
 * a hundred million times larger than a cent for the same real value — which is
 * exactly the magnitude a `bigint` column exists for and an `integer` one would
 * overflow.
 */
const CURRENCIES: readonly CurrencyCode[] = ['EUR', 'USD', 'FAIR'];

/** The seed. Overridable so a red run can be replayed: `LEDGER_TEST_SEED=… bun test`. */
const SEED = Number.parseInt(process.env.LEDGER_TEST_SEED ?? '', 10) || 0x5eed1234;

/** xorshift32 — deterministic, dependency-free, and adequate for choosing shapes. */
function xorshift32(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

let db: Database;
let closePostgres: typeof import('../../postgres.js').closePostgres;

beforeAll(async () => {
  const postgres = await import('../../postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  // The seed must be readable in CI output, or a red run cannot be replayed.
  console.log(`[ledger.realdb] PRNG seed ${SEED} (replay with LEDGER_TEST_SEED=${SEED})`);
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * A tag unique to THIS run, written into every transaction's description.
 *
 * There is no `beforeEach` cleanup, and there cannot usefully be one: the
 * trigger refuses DELETE, and the only way to empty these tables is TRUNCATE —
 * a TABLE-level statement, which would take another test file's rows with it.
 * vitest runs files in parallel against ONE throwaway database, so a truncate
 * here is a cross-file failure that reproduces only under concurrency and looks
 * exactly like a bug in whichever file lost the race. (It happened: the POS
 * sale's payment vanished mid-transaction the first time this file ran beside
 * it.)
 *
 * So every assertion below is SCOPED to rows this run wrote. That is not a
 * workaround, it is the stronger form: an assertion counting every row in the
 * table is one another test can break, and one that passes for the wrong reason
 * as soon as a fixture is added somewhere else.
 */
const RUN_TAG = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** This run's transactions, by the tag in their description. */
const ownRows = sql`${ledgerTransactions.description} like ${`%${RUN_TAG}%`}`;

/** Entries belonging to this run's transactions. */
const ownEntries = sql`${ledgerEntries.transactionId} in (select ${ledgerTransactions.id} from ${ledgerTransactions} where ${ownRows})`;

/**
 * A random BALANCED set: pick a currency mix, then for each currency draw N-1
 * random legs and make the last one their negation.
 *
 * The final leg is what guarantees the sum is zero, and re-drawing until it is
 * non-zero is what keeps the set legal — a zero entry is refused by its own
 * CHECK, so a generator that produced one would be testing the wrong rule.
 */
function balancedEntries(random: () => number): LedgerEntryInput[] {
  const currencyCount = 1 + Math.floor(random() * CURRENCIES.length);
  const entries: LedgerEntryInput[] = [];

  for (let index = 0; index < currencyCount; index += 1) {
    const currency = CURRENCIES[index] ?? 'EUR';
    const legs = 2 + Math.floor(random() * 3);
    let running = 0n;
    for (let leg = 0; leg < legs - 1; leg += 1) {
      const magnitude = BigInt(1 + Math.floor(random() * 1_000_000_000));
      const amount = random() < 0.5 ? magnitude : -magnitude;
      running += amount;
      entries.push({ account: pickAccount(random), currency, amountMinor: amount });
    }
    if (running === 0n) {
      // The closing leg would be zero, which no entry may be. Nudge the run so
      // the balancing leg is a real amount.
      const nudge = BigInt(1 + Math.floor(random() * 1_000));
      running += nudge;
      entries.push({ account: pickAccount(random), currency, amountMinor: nudge });
    }
    entries.push({ account: pickAccount(random), currency, amountMinor: -running });
  }
  return entries;
}

function pickAccount(random: () => number): (typeof ACCOUNTS)[number] {
  return ACCOUNTS[Math.floor(random() * ACCOUNTS.length)] ?? 'provider_clearing';
}

describe('the ledger balances, per currency', () => {
  it('accepts 60 randomized balanced transactions across mixed currencies', async () => {
    const random = xorshift32(SEED);
    for (let round = 0; round < 60; round += 1) {
      const entries = balancedEntries(random);
      expect(findUnbalancedCurrencies(entries)).toEqual([]);

      const inserted = await insertLedgerTransaction(
        db,
        { kind: 'adjustment', description: `balanced round ${String(round)} ${RUN_TAG}` },
        entries,
      );
      expect(inserted.entryIds).toHaveLength(entries.length);
    }

    // The whole book, read back from the SERVER rather than from what we think
    // we wrote: every currency nets to zero.
    const totals = await db
      .select({
        currency: ledgerEntries.currency,
        total: sql<string>`sum(${ledgerEntries.amountMinor})`,
      })
      .from(ledgerEntries)
      .where(ownEntries)
      .groupBy(ledgerEntries.currency);
    expect(totals.length).toBeGreaterThan(0);
    for (const row of totals) {
      expect(BigInt(row.total)).toBe(0n);
    }
  });

  it('refuses 40 randomized UNBALANCED transactions, naming the offending currency', async () => {
    const random = xorshift32(SEED ^ 0x55aa);
    for (let round = 0; round < 40; round += 1) {
      const entries = balancedEntries(random);
      // Break exactly one leg, by a non-zero amount, so the set is unbalanced in
      // precisely one currency and nothing else about it changes.
      const index = Math.floor(random() * entries.length);
      const victim = entries[index];
      if (!victim) continue;
      const broken = [...entries];
      broken[index] = { ...victim, amountMinor: victim.amountMinor + 1n };

      expect(findUnbalancedCurrencies(broken)).toEqual([victim.currency]);
      await expect(
        insertLedgerTransaction(
          db,
          { kind: 'adjustment', description: `unbalanced round ${String(round)} ${RUN_TAG}` },
          broken,
        ),
      ).rejects.toThrow(UnbalancedLedgerTransactionError);
    }

    // Nothing was written. A rejected transaction must leave no header behind
    // either — an empty `ledger_transactions` row is an unbalanced transaction
    // wearing a different shape.
    const [{ count }] = await db
      .select({ count: sql<string>`count(*)` })
      .from(ledgerTransactions)
      .where(sql`${ledgerTransactions.description} like ${`unbalanced round%${RUN_TAG}%`}`);
    expect(Number(count)).toBe(0);
  });

  it('refuses a single-entry transaction, a zero amount, and an out-of-range amount', async () => {
    await expect(
      insertLedgerTransaction(db, { kind: 'adjustment', description: `lonely ${RUN_TAG}` }, [
        { account: 'reserves', currency: 'EUR', amountMinor: 100n },
      ]),
    ).rejects.toThrow(UnbalancedLedgerTransactionError);

    await expect(
      insertLedgerTransaction(db, { kind: 'adjustment', description: `zero leg ${RUN_TAG}` }, [
        { account: 'reserves', currency: 'EUR', amountMinor: 0n },
        { account: 'provider_clearing', currency: 'EUR', amountMinor: 0n },
      ]),
    ).rejects.toThrow(UnbalancedLedgerTransactionError);

    // 2^63 — one past what the column can hold. Caught by the range assertion
    // before any SQL, so the error names the posting rather than the INSERT.
    await expect(
      insertLedgerTransaction(db, { kind: 'adjustment', description: `overflow ${RUN_TAG}` }, [
        { account: 'reserves', currency: 'FAIR', amountMinor: 2n ** 63n },
        { account: 'provider_clearing', currency: 'FAIR', amountMinor: -(2n ** 63n) },
      ]),
    ).rejects.toThrow(RangeError);
  });

  it('round-trips a FAIR amount past the 2^53 JavaScript ceiling exactly', async () => {
    // 2^53 + 1 is the first integer a JS `number` cannot represent. If these
    // columns were `mode: 'number'` the value below would come back as 2^53,
    // and every balance check over a large FAIR book would silently drift.
    const huge = 2n ** 53n + 1n;
    await insertLedgerTransaction(db, { kind: 'adjustment', description: `big fair ${RUN_TAG}` }, [
      { account: 'provider_clearing', currency: 'FAIR', amountMinor: huge },
      { account: 'merchant_payable', currency: 'FAIR', amountMinor: -huge, ownerType: 'store', ownerId: 'store-1' },
    ]);

    const rows = await db
      .select({ amount: ledgerEntries.amountMinor })
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.amountMinor} = ${huge.toString()}::bigint and ${ownEntries}`);
    expect(rows[0]?.amount).toBe(huge);
  });
});

describe('the ledger is append-only', () => {
  /**
   * Assert that `run` was refused BY THE TRIGGER.
   *
   * drizzle wraps a driver error in a `Failed query: …` envelope and hangs the
   * real one off `cause`, so matching the top-level message alone would pass
   * against ANY failure — a syntax error, a missing table, a dead connection.
   * Walking the cause chain is what makes this check able to tell the trigger
   * from everything else; and because a missing trigger means the statement
   * SUCCEEDS, `error === null` fails the assertion rather than slipping through.
   */
  async function expectAppendOnlyRefusal(run: () => Promise<unknown>): Promise<void> {
    const error: unknown = await run().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error, 'the statement was NOT refused — is the trigger still there?').not.toBeNull();

    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(' | ')).toMatch(/append-only/);
  }

  /** One committed transaction to attempt mutations against. */
  async function seed(): Promise<string> {
    const inserted = await insertLedgerTransaction(
      db,
      { kind: 'charge_succeeded', description: `seeded ${RUN_TAG}` },
      [
        { account: 'provider_clearing', currency: 'EUR', amountMinor: 5_000n },
        {
          account: 'merchant_payable',
          currency: 'EUR',
          amountMinor: -5_000n,
          ownerType: 'store',
          ownerId: 'store-1',
          orderId: 'order-1',
        },
      ],
    );
    return inserted.id;
  }

  it('refuses an UPDATE of an entry', async () => {
    await seed();
    await expectAppendOnlyRefusal(() =>
      db.update(ledgerEntries).set({ amountMinor: 1n }).where(ownEntries),
    );
  });

  it('refuses a DELETE of an entry', async () => {
    await seed();
    await expectAppendOnlyRefusal(() => db.delete(ledgerEntries).where(ownEntries));
  });

  it('refuses an UPDATE of a transaction', async () => {
    await seed();
    await expectAppendOnlyRefusal(() =>
      db.update(ledgerTransactions).set({ description: 'edited' }).where(ownRows),
    );
  });

  it('refuses a DELETE of a transaction', async () => {
    await seed();
    await expectAppendOnlyRefusal(() => db.delete(ledgerTransactions).where(ownRows));
  });

  it('leaves the row untouched after a refused UPDATE', async () => {
    const seededId = await seed();
    await expectAppendOnlyRefusal(() =>
      db.update(ledgerEntries).set({ amountMinor: 1n }).where(ownEntries),
    );

    // The refusal is BEFORE the write, so nothing is half-applied. Asserting
    // this separately matters: a trigger that raised AFTER the row version was
    // written would pass every test above and still corrupt the book.
    const rows = await db
      .select({ amount: ledgerEntries.amountMinor })
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.transactionId} = ${seededId}`);
    expect(rows.map((row) => row.amount).sort()).toEqual([-5_000n, 5_000n]);
  });

  it('corrects a mistake with a REVERSING transaction, leaving both in the book', async () => {
    const wrongId = await seed();

    // The correction: the same legs, negated. Not an edit of the original — the
    // original stays exactly as it was written, which is what makes the book
    // auditable rather than merely current.
    const reversalId = await insertLedgerTransaction(
      db,
      { kind: 'adjustment', description: `reverses ${wrongId} ${RUN_TAG}` },
      [
        { account: 'provider_clearing', currency: 'EUR', amountMinor: -5_000n },
        {
          account: 'merchant_payable',
          currency: 'EUR',
          amountMinor: 5_000n,
          ownerType: 'store',
          ownerId: 'store-1',
          orderId: 'order-1',
        },
      ],
    );
    expect(reversalId.id).not.toBe(wrongId);

    // Both transactions are present…
    const [{ count }] = await db
      .select({ count: sql<string>`count(*)` })
      .from(ledgerTransactions)
      .where(sql`${ledgerTransactions.id} in (${wrongId}, ${reversalId.id})`);
    expect(Number(count)).toBe(2);

    // …and every ACCOUNT now nets to zero, which is what "reversed" means.
    const perAccount = await db
      .select({
        account: ledgerEntries.account,
        total: sql<string>`sum(${ledgerEntries.amountMinor})`,
      })
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.transactionId} in (${wrongId}, ${reversalId.id})`)
      .groupBy(ledgerEntries.account);
    expect(perAccount).toHaveLength(2);
    for (const row of perAccount) {
      expect(BigInt(row.total)).toBe(0n);
    }
  });
});
