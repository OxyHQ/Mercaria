/**
 * Commission reconciliation's STRUCTURAL guarantees, against a REAL Postgres
 * server (#67).
 *
 * Every property here is a trigger, a CHECK, a unique index or a real
 * transaction boundary, and not one of them exists under a mock: a mocked
 * `insert` accepts a statement the server rejects outright, so each of these
 * cases would pass green and ship broken.
 *
 * ## Scoping
 *
 * Every aggregate is scoped to ids this file created. `affiliate_transactions`
 * is shared with whatever else runs in parallel against the same throwaway
 * database, and an unscoped `count(*)` reads correctly right up until a sibling
 * seeds a row — after which it reads WRONG in the direction that looks fine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  affiliateCommissionPostings,
  affiliateReportRuns,
  affiliateTransactionObservations,
  affiliateTransactions,
} from '../../../db/schema/affiliateOutbound.js';
import { ledgerEntries } from '../../../db/schema/ledger.js';
import {
  AffiliateReportCountersError,
  completeAffiliateReportRun,
  findNewestCompletedAffiliateReportRun,
  openAffiliateReportRun,
} from '../../../db/affiliateOutbound/reportRunRepository.js';
import { claimAffiliateCommissionPosting } from '../../../db/affiliateOutbound/postingRepository.js';
import {
  listAffiliateTransactionObservations,
  findAffiliateTransactionById,
} from '../../../db/affiliateOutbound/transactionRepository.js';
import { insertLedgerTransaction } from '../../../db/payments/ledgerRepository.js';
import { config } from '../../../config/index.js';
import { applyReportedTransaction } from '../reconciliation/apply.js';
import {
  resolveRefusalAccountRef,
  runAffiliateReconciliationPass,
} from '../reconciliation/poll.service.js';
import { readReconciledAffiliateCommission } from '../funding.js';
import type {
  AffiliateReportReader,
  AffiliateReportWindowResult,
  ReportedAffiliateTransaction,
} from '../reconciliation/reader.js';

const EVENT_AT = new Date('2026-03-01T10:00:00.000Z');

/**
 * Assert a write is refused by a SPECIFIC rule.
 *
 * `rejects.toThrow()` alone also passes when the WRONG rule fired, which on a
 * table carrying a dozen CHECKs is most of the value of the assertion. drizzle
 * wraps the driver error, so the constraint name lives on the CAUSE and a
 * trigger's `RAISE` message lives further down still.
 */
async function expectRefusedBy(write: () => Promise<unknown>, rule: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the rule did not fire').toBeDefined();
  expect(refusalTextOf(caught), `expected ${String(rule)}; got: ${String(caught)}`).toMatch(rule);
}

/** Every message and constraint name in a wrapped driver error. */
function refusalTextOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    const named = current as { constraint_name?: unknown; message?: unknown; cause?: unknown };
    if (typeof named.constraint_name === 'string') parts.push(named.constraint_name);
    if (typeof named.message === 'string') parts.push(named.message);
    current = named.cause;
  }
  return parts.join(' | ');
}

/**
 * The SQLSTATE of a wrapped driver error.
 *
 * `error.code` is NOT it — drizzle wraps the postgres.js error, so the five
 * characters live on the CAUSE. Asserting the constraint NAME alone would also
 * pass on a CHECK that happened to mention it, and asserting `rejects.toThrow()`
 * would pass on a typo in the fixture.
 */
function sqlstateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    const named = current as { code?: unknown; cause?: unknown };
    if (typeof named.code === 'string' && /^[0-9A-Z]{5}$/u.test(named.code)) return named.code;
    current = named.cause;
  }
  return undefined;
}

/**
 * A transaction MATCHED to a click, written straight at the table.
 *
 * Deliberately not through `applyReportedTransaction`: no service path can
 * produce a matched row, because `AFFILIATE_CLICK_REFERENCE_SUPPORT` marks both
 * networks `not_supported` and `matchReportedTransaction` returns at its first
 * branch. The property under test is the DATABASE's, and a service that cannot
 * reach the state cannot test the constraint that guards it.
 */
async function insertMatchedTransaction(
  handle: Pick<Database, 'insert'>,
  clickId: string,
): Promise<void> {
  await handle.insert(affiliateTransactions).values({
    network: 'awin',
    networkTransactionId: `awin-${uuidv7()}`,
    advertiserRef: '7052',
    publisherRef: '189069',
    state: 'approved',
    orderValueAmount: 2400,
    orderValueCurrency: 'GBP',
    commissionAmount: 120,
    commissionCurrency: 'GBP',
    eventAt: EVENT_AT,
    networkProcessedAt: null,
    networkClickRef: `ref-${clickId}`,
    matchedClickId: clickId,
    matchState: 'matched',
    unmatchedReason: null,
    contentDigest: 'f'.repeat(64),
    observationCount: 1,
  });
}

/** One reported transaction, under an id this file owns. */
function reported(
  networkTransactionId: string,
  overrides: Partial<ReportedAffiliateTransaction> = {},
): ReportedAffiliateTransaction {
  return {
    networkTransactionId,
    advertiserRef: '7052',
    publisherRef: '189069',
    state: 'approved',
    orderValue: { amount: 2400, currency: 'GBP' },
    commission: { amount: 120, currency: 'GBP' },
    eventAt: EVENT_AT,
    networkProcessedAt: null,
    networkClickRef: null,
    ...overrides,
  };
}

/** A reader that answers from a script. Only the SOCKET is faked. */
function scriptedReader(
  accountRef: string,
  script: readonly AffiliateReportWindowResult[],
): AffiliateReportReader {
  let call = 0;
  return {
    network: 'awin',
    async listAccounts() {
      return [{ accountRef }];
    },
    async readWindow() {
      const result = script[call] ?? { outcome: 'read', transactions: [], rejected: [] };
      call += 1;
      return result;
    },
  };
}

describe('commission reconciliation, against a real server', () => {
  let db: Database;
  /** A run to hang observations off, so the FK is satisfied. */
  let runId: string;

  beforeAll(async () => {
    db = await connectPostgres();
    const run = await openAffiliateReportRun(db, {
      network: 'awin',
      accountRef: `pub-${uuidv7()}`,
      windowFrom: new Date('2026-02-01T00:00:00.000Z'),
      windowTo: new Date('2026-03-03T23:59:59.000Z'),
    });
    runId = run.id;
  }, 120_000);

  afterAll(async () => {
    await closePostgres();
  });

  it('writes the row, the trail and the accrual, and books nothing for `pending`', async () => {
    const pendingId = `awin-${uuidv7()}`;
    const pending = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(pendingId, { state: 'pending' }),
      now: new Date(),
    });
    expect(pending.outcome).toBe('applied');
    if (pending.outcome !== 'applied') return;
    expect(pending.kind).toBe('first_observation');
    // THE rule: a pending commission is a claim the network may still decline.
    expect(pending.booked).toHaveLength(0);

    const postings = await db
      .select()
      .from(affiliateCommissionPostings)
      .where(eq(affiliateCommissionPostings.transactionId, pending.transactionId));
    expect(postings).toHaveLength(0);

    // Every transaction is `unmatched` today, and for the CONTRACT reason.
    const row = await findAffiliateTransactionById(db, pending.transactionId);
    expect(row?.matchState).toBe('unmatched');
    expect(row?.unmatchedReason).toBe('network_supplies_no_reference');
    expect(row?.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('accrues on approval, settles on payment, and reverses without deleting history', async () => {
    const networkTransactionId = `awin-${uuidv7()}`;
    const now = new Date();

    const approved = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId),
      now,
    });
    expect(approved.outcome).toBe('applied');
    if (approved.outcome !== 'applied') return;
    const transactionId = approved.transactionId;
    expect(approved.booked.map((entry) => entry.kind)).toEqual(['accrual']);

    // A confirming re-poll: `unchanged`, no new observation, NO second credit.
    const again = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId),
      now: new Date(now.getTime() + 60_000),
    });
    expect(again.outcome).toBe('applied');
    if (again.outcome !== 'applied') return;
    expect(again.kind).toBe('unchanged');
    expect(again.booked).toHaveLength(0);
    // An `unchanged` re-poll writes NO observation row and does NOT move the
    // counter — which is what makes `observation_count` the next revision. A
    // 45-day lookback polled hourly would otherwise write ~1080 rows per
    // transaction saying nothing changed. Pinned here, and again below against
    // the whole trail, so writing a row on an unchanged poll fails the build
    // rather than silently doubling the table and shifting every revision.
    const confirmed = await findAffiliateTransactionById(db, transactionId);
    expect(confirmed?.observationCount).toBe(1);
    expect(await listAffiliateTransactionObservations(db, transactionId)).toHaveLength(1);
    expect(confirmed?.lastObservedAt.getTime()).toBeGreaterThan(now.getTime());

    const paid = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId, { state: 'paid' }),
      now: new Date(now.getTime() + 120_000),
    });
    expect(paid.outcome).toBe('applied');
    if (paid.outcome !== 'applied') return;
    expect(paid.kind).toBe('state_change');
    expect(paid.booked.map((entry) => entry.kind)).toEqual(['settlement']);

    const reversed = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId, { state: 'reversed' }),
      now: new Date(now.getTime() + 180_000),
    });
    expect(reversed.outcome).toBe('applied');
    if (reversed.outcome !== 'applied') return;
    // The clawback: the recognition is unwound AND the settlement is put back,
    // or `platform_funds` keeps money the network is taking away.
    expect(reversed.booked.map((entry) => entry.kind)).toEqual(['reversal', 'settlement']);

    // Acceptance 4: reporting moved and NOTHING was deleted.
    const trail = await listAffiliateTransactionObservations(db, transactionId);
    expect(trail.map((entry) => `${String(entry.revision)}:${entry.kind}:${entry.state}`)).toEqual([
      '1:first_observation:approved',
      '2:state_change:paid',
      '3:state_change:reversed',
    ]);

    const row = await findAffiliateTransactionById(db, transactionId);
    // `observation_count` EQUALS the trail length, which is what makes it the
    // next revision. Asserted against `trail.length` rather than against the
    // literal 3, so it is the invariant that is pinned and not a count.
    expect(row?.observationCount).toBe(trail.length);
    expect(trail.map((entry) => entry.revision)).toEqual([1, 2, 3]);
    expect(row?.state).toBe('reversed');

    // The book, scoped to THIS transaction's own ledger transactions.
    const postings = await db
      .select()
      .from(affiliateCommissionPostings)
      .where(eq(affiliateCommissionPostings.transactionId, transactionId));
    expect(postings).toHaveLength(4);
    const ledgerIds = postings.map((posting) => posting.ledgerTransactionId);
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, ledgerIds));
    // A floor, so "everything balances" is not what zero entries would report.
    expect(entries.length).toBe(8);
    const perCurrency = new Map<string, bigint>();
    for (const entry of entries) {
      perCurrency.set(entry.currency, (perCurrency.get(entry.currency) ?? 0n) + entry.amountMinor);
    }
    expect([...perCurrency]).toEqual([['GBP', 0n]]);
    // And the whole lifecycle nets the receivable back to zero, which is the
    // property a publisher statement is reconciled against.
    const receivable = entries
      .filter((entry) => entry.account === 'affiliate_receivable')
      .reduce((total, entry) => total + entry.amountMinor, 0n);
    expect(receivable).toBe(0n);
  });

  it('answers #144 with the reconciled commission, and never a zero for `pending`', async () => {
    const pendingId = `awin-${uuidv7()}`;
    const pending = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(pendingId, { state: 'pending' }),
      now: new Date(),
    });
    if (pending.outcome !== 'applied') throw new Error('the fixture did not apply');
    // `undefined`, which the adapter reports as `not_yet_reconciled` — an
    // estimate is not a base.
    expect(
      await readReconciledAffiliateCommission({ recordRef: pending.transactionId, db }),
    ).toBeUndefined();

    const approvedId = `awin-${uuidv7()}`;
    const approved = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(approvedId),
      now: new Date(),
    });
    if (approved.outcome !== 'applied') throw new Error('the fixture did not apply');
    expect(
      await readReconciledAffiliateCommission({ recordRef: approved.transactionId, db }),
    ).toMatchObject({ amountMinor: 120, currency: 'GBP', version: 'revision:1' });

    // A DECLINED commission is a realized zero, not an open question: the
    // network has decided, and leaving the reward pending forever is a queue
    // that never drains.
    await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(approvedId, { state: 'declined' }),
      now: new Date(),
    });
    expect(
      await readReconciledAffiliateCommission({ recordRef: approved.transactionId, db }),
    ).toMatchObject({ amountMinor: 0, currency: 'GBP', version: 'revision:2' });
  });

  it('refuses UPDATE and DELETE on the observation trail', async () => {
    const networkTransactionId = `awin-${uuidv7()}`;
    const applied = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId),
      now: new Date(),
    });
    if (applied.outcome !== 'applied') throw new Error('the fixture did not apply');

    await expectRefusedBy(
      async () =>
        db
          .update(affiliateTransactionObservations)
          .set({ state: 'declined' })
          .where(eq(affiliateTransactionObservations.transactionId, applied.transactionId)),
      /append-only/,
    );
    await expectRefusedBy(
      async () =>
        db
          .delete(affiliateTransactionObservations)
          .where(eq(affiliateTransactionObservations.transactionId, applied.transactionId)),
      /append-only/,
    );
    // The floor: the rows the two statements targeted are still there, so
    // neither refusal was a refusal to touch nothing.
    const trail = await listAffiliateTransactionObservations(db, applied.transactionId);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.state).toBe('approved');
  });

  it('refuses UPDATE and DELETE on the commission postings', async () => {
    const networkTransactionId = `awin-${uuidv7()}`;
    const applied = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId),
      now: new Date(),
    });
    if (applied.outcome !== 'applied') throw new Error('the fixture did not apply');

    await expectRefusedBy(
      async () =>
        db
          .update(affiliateCommissionPostings)
          .set({ amountMinor: 1 })
          .where(eq(affiliateCommissionPostings.transactionId, applied.transactionId)),
      /append-only/,
    );
    await expectRefusedBy(
      async () =>
        db
          .delete(affiliateCommissionPostings)
          .where(eq(affiliateCommissionPostings.transactionId, applied.transactionId)),
      /append-only/,
    );
    const postings = await db
      .select()
      .from(affiliateCommissionPostings)
      .where(eq(affiliateCommissionPostings.transactionId, applied.transactionId));
    expect(postings).toHaveLength(1);
    expect(postings[0]?.amountMinor).toBe(120);
  });

  it('makes a second claim of one posting a NO-OP rather than a second credit', async () => {
    const networkTransactionId = `awin-${uuidv7()}`;
    const applied = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId),
      now: new Date(),
    });
    if (applied.outcome !== 'applied') throw new Error('the fixture did not apply');

    const ledger = await insertLedgerTransaction(
      db,
      { kind: 'affiliate_commission_accrued', description: 'a second attempt at revision 1' },
      [
        { account: 'affiliate_receivable', currency: 'GBP', amountMinor: 120n },
        { account: 'affiliate_commission_revenue', currency: 'GBP', amountMinor: -120n },
      ],
    );
    // The EMPTY result IS the "already booked" answer — not an error to
    // interpret, and not a read-then-write two workers could both pass.
    const claimed = await claimAffiliateCommissionPosting(db, {
      transactionId: applied.transactionId,
      ledgerTransactionId: ledger.id,
      kind: 'accrual',
      revision: 1,
      amountMinor: 120,
      currency: 'GBP',
      postedAt: new Date(),
    });
    expect(claimed).toBeUndefined();

    const postings = await db
      .select()
      .from(affiliateCommissionPostings)
      .where(eq(affiliateCommissionPostings.transactionId, applied.transactionId));
    expect(postings).toHaveLength(1);
  });

  it('refuses an unbalanced ledger transaction', async () => {
    await expect(
      insertLedgerTransaction(
        db,
        { kind: 'affiliate_commission_accrued', description: 'one penny short' },
        [
          { account: 'affiliate_receivable', currency: 'GBP', amountMinor: 120n },
          { account: 'affiliate_commission_revenue', currency: 'GBP', amountMinor: -119n },
        ],
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it('refuses a completed run whose counters do not account for what it saw', async () => {
    const run = await openAffiliateReportRun(db, {
      network: 'awin',
      accountRef: `pub-${uuidv7()}`,
      windowFrom: new Date('2026-02-01T00:00:00.000Z'),
      windowTo: new Date('2026-02-28T23:59:59.000Z'),
    });

    // Layer one: the repository refuses BEFORE any SQL, so the error names the
    // pass that miscounted rather than the INSERT that was rejected.
    await expect(
      completeAffiliateReportRun(db, {
        id: run.id,
        counters: {
          seen: 5,
          created: 1,
          stateChanged: 0,
          amountChanged: 0,
          restated: 0,
          unchanged: 0,
        },
      }),
    ).rejects.toBeInstanceOf(AffiliateReportCountersError);

    // Layer two: the CHECK, reached by a writer that did not route through it.
    await expectRefusedBy(
      async () =>
        db
          .update(affiliateReportRuns)
          .set({
            state: 'completed',
            transactionsSeen: 5,
            transactionsCreated: 1,
            completedAt: new Date(),
          })
          .where(eq(affiliateReportRuns.id, run.id)),
      /counters_total_check/,
    );

    // And the honest counters are accepted, so the refusals above are not just
    // "this table rejects everything".
    const completed = await completeAffiliateReportRun(db, {
      id: run.id,
      counters: {
        seen: 5,
        created: 1,
        stateChanged: 1,
        amountChanged: 1,
        restated: 1,
        unchanged: 1,
      },
    });
    expect(completed?.state).toBe('completed');
  });

  it('runs a pass, records the counters, and answers freshness from a COMPLETED run', async () => {
    const accountRef = `pub-${uuidv7()}`;
    const first = `awin-${uuidv7()}`;
    const second = `awin-${uuidv7()}`;
    const reader = scriptedReader(accountRef, [
      {
        outcome: 'read',
        transactions: [reported(first), reported(second, { state: 'pending' })],
        rejected: [],
      },
    ]);

    const pass = await runAffiliateReconciliationPass(db, {
      network: 'awin',
      readerOverrides: { awin: reader },
    });
    expect(pass.unavailable).toBeNull();
    expect(pass.runs.length).toBeGreaterThanOrEqual(2);
    const [firstRun] = pass.runs;
    expect(firstRun?.state).toBe('completed');
    expect(firstRun?.counters).toEqual({
      seen: 2,
      created: 2,
      stateChanged: 0,
      amountChanged: 0,
      restated: 0,
      unchanged: 0,
    });

    const newest = await findNewestCompletedAffiliateReportRun(db, 'awin');
    expect(newest).toBeDefined();

    // A second pass over the same window is the NORMAL case, and every row
    // lands in `unchanged` rather than being re-created or re-booked.
    const repeat = await runAffiliateReconciliationPass(db, {
      network: 'awin',
      readerOverrides: {
        awin: scriptedReader(accountRef, [
          {
            outcome: 'read',
            transactions: [reported(first), reported(second, { state: 'pending' })],
            rejected: [],
          },
        ]),
      },
    });
    expect(repeat.runs[0]?.counters).toEqual({
      seen: 2,
      created: 0,
      stateChanged: 0,
      amountChanged: 0,
      restated: 0,
      unchanged: 2,
    });
  });

  it('FAILS a window whose report carried rows and yielded none', async () => {
    // The vacuity floor. A `completed` run with `seen = 0` is what a quiet
    // month looks like, and reporting a network that renamed a field as one
    // would hide it behind a green dashboard forever.
    const accountRef = `pub-${uuidv7()}`;
    const pass = await runAffiliateReconciliationPass(db, {
      network: 'awin',
      readerOverrides: {
        awin: scriptedReader(accountRef, [
          {
            outcome: 'read',
            transactions: [],
            rejected: [{ networkTransactionId: '1', reason: 'unrecognised commissionStatus (x)' }],
          },
        ]),
      },
    });
    expect(pass.runs).toHaveLength(1);
    expect(pass.runs[0]?.state).toBe('failed');
    expect(pass.runs[0]?.failureReason).toBe('response_unreadable');
    expect(pass.runs[0]?.rejected).toBe(1);
  });

  it('records a reader failure as the run’s own reason, and reads nothing', async () => {
    const accountRef = `pub-${uuidv7()}`;
    const pass = await runAffiliateReconciliationPass(db, {
      network: 'awin',
      readerOverrides: {
        awin: scriptedReader(accountRef, [
          {
            outcome: 'failed',
            reason: 'credential_unavailable',
            detail: 'the Publisher API token is not configured',
          },
        ]),
      },
    });
    // A credential rejected for January will be rejected for February: the
    // account's pass stops rather than spending the network's allowance
    // proving it.
    expect(pass.runs).toHaveLength(1);
    expect(pass.runs[0]?.failureReason).toBe('credential_unavailable');
  });

  it('skips an account another task is already polling', async () => {
    const accountRef = `pub-${uuidv7()}`;
    // A `running` run IS the lease. Left open on purpose.
    await openAffiliateReportRun(db, {
      network: 'awin',
      accountRef,
      windowFrom: new Date('2026-02-01T00:00:00.000Z'),
      windowTo: new Date('2026-02-28T23:59:59.000Z'),
    });

    let consulted = 0;
    const reader: AffiliateReportReader = {
      network: 'awin',
      async listAccounts() {
        return [{ accountRef }];
      },
      async readWindow() {
        consulted += 1;
        return { outcome: 'read', transactions: [], rejected: [] };
      },
    };
    const pass = await runAffiliateReconciliationPass(db, {
      network: 'awin',
      readerOverrides: { awin: reader },
    });
    expect(pass.skippedAccounts).toBe(1);
    expect(pass.runs).toHaveLength(0);
    // The floor on the skip: the network was never called at all.
    expect(consulted).toBe(0);
  });

  it('answers `network_not_configured` for eBay, and never invents a publisher account', async () => {
    // This deployment configures no EPN campaign id, so there is no publisher
    // identity a run could name — and `account_ref` naming a placeholder would
    // make every reader of that column wrong forever. The refusal travels in
    // the pass result instead; `resolveRefusalAccountRef` is where the other
    // branch (a configured campaign id DOES get a durable `failed` run) is
    // measured, because a function reading `config` directly could only ever be
    // tested against whichever branch this deployment happens to be in.
    const before = await db
      .select({ id: affiliateReportRuns.id })
      .from(affiliateReportRuns)
      .where(eq(affiliateReportRuns.network, 'ebay'));
    const pass = await runAffiliateReconciliationPass(db, { network: 'ebay' });
    expect(pass.unavailable?.reason).toBe('network_not_configured');
    expect(resolveRefusalAccountRef('ebay', config.ebay)).toBeNull();
    expect(pass.runs).toHaveLength(0);
    const after = await db
      .select({ id: affiliateReportRuns.id })
      .from(affiliateReportRuns)
      .where(eq(affiliateReportRuns.network, 'ebay'));
    expect(after.length).toBe(before.length);
  });

  it('admits the `direct` network end to end, and still refuses a name nothing produces', async () => {
    // The migration's whole effect, asserted where it lives. A directly-signed
    // shop is a first-class network: its run opens, its transaction applies,
    // its accrual books — and the widened CHECK is proved by the pair, because
    // an insert that merely SUCCEEDS says nothing about whether a constraint is
    // present at all.
    const directRun = await openAffiliateReportRun(db, {
      network: 'direct',
      accountRef: `shop-${uuidv7()}`,
      windowFrom: new Date('2026-02-01T00:00:00.000Z'),
      windowTo: new Date('2026-03-03T23:59:59.000Z'),
    });
    const networkTransactionId = `direct-${uuidv7()}`;
    const applied = await applyReportedTransaction(db, {
      network: 'direct',
      reportRunId: directRun.id,
      reported: reported(networkTransactionId),
      now: new Date(),
    });
    expect(applied.outcome).toBe('applied');
    if (applied.outcome !== 'applied') return;

    const row = await findAffiliateTransactionById(db, applied.transactionId);
    expect(row?.network).toBe('direct');
    // Unmatched, and for the SAME structural reason the two networks are: the
    // URL handed over is the shop's own and Mercaria composes nothing, so
    // there is no per-click reference for it to echo back.
    expect(row?.matchState).toBe('unmatched');

    // The negative control. Without it the case above would pass on a table
    // carrying no network CHECK at all — which is exactly the state a
    // regenerated migration that dropped and never re-added one would leave.
    await expectRefusedBy(
      () =>
        db.insert(affiliateTransactions).values({
          network: 'not-a-network' as 'direct',
          networkTransactionId: `bogus-${uuidv7()}`,
          state: 'approved',
          commissionAmount: 120,
          commissionCurrency: 'GBP',
          eventAt: EVENT_AT,
          matchState: 'unmatched',
          // Every OTHER rule on this row has to be satisfied or the control
          // passes against whichever fires first — which it did twice while
          // this case was written, on the digest length and then on the
          // match-shape biconditional. `expectRefusedBy` reads the constraint
          // NAME, which is the only reason either was visible.
          unmatchedReason: 'network_supplies_no_reference',
          contentDigest: 'd'.repeat(64),
        }),
      /affiliate_transactions_network_check/u,
    );
  });

  it('does not poll `direct`, and writes no run saying it tried', async () => {
    // Unlike eBay's seam this one is not waiting on a credential: a
    // directly-signed shop is not an API, so there is nothing to poll and
    // `resolveRefusalAccountRef` names no publisher for it. A refused-attempt
    // row every hour for a network that will never have a reader is noise that
    // trains an operator to stop reading the table.
    const before = await db
      .select({ id: affiliateReportRuns.id })
      .from(affiliateReportRuns)
      .where(eq(affiliateReportRuns.network, 'direct'));
    const pass = await runAffiliateReconciliationPass(db, { network: 'direct' });
    expect(pass.unavailable?.reason).toBe('network_not_configured');
    expect(resolveRefusalAccountRef('direct', config.ebay)).toBeNull();
    expect(pass.runs).toHaveLength(0);
    const after = await db
      .select({ id: affiliateReportRuns.id })
      .from(affiliateReportRuns)
      .where(eq(affiliateReportRuns.network, 'direct'));
    expect(after.length).toBe(before.length);
  });

  it('leaves NOTHING behind when a transaction cannot be applied', async () => {
    // A commission re-denominated after it was booked. The refusal is raised
    // from inside the database transaction so the whole apply rolls back —
    // returning it would COMMIT a changed row with no observation and no
    // posting, which is the half-written state the single-transaction rule
    // exists to prevent.
    const networkTransactionId = `awin-${uuidv7()}`;
    const applied = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId),
      now: new Date(),
    });
    if (applied.outcome !== 'applied') throw new Error('the fixture did not apply');

    const refused = await applyReportedTransaction(db, {
      network: 'awin',
      reportRunId: runId,
      reported: reported(networkTransactionId, {
        commission: { amount: 100, currency: 'EUR' },
      }),
      now: new Date(),
    });
    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') return;
    expect(refused.reason).toBe('currency_restated');

    const row = await findAffiliateTransactionById(db, applied.transactionId);
    expect(row?.commissionCurrency).toBe('GBP');
    expect(row?.observationCount).toBe(1);
    const trail = await listAffiliateTransactionObservations(db, applied.transactionId);
    expect(trail).toHaveLength(1);
    const postings = await db
      .select()
      .from(affiliateCommissionPostings)
      .where(
        and(
          eq(affiliateCommissionPostings.transactionId, applied.transactionId),
          eq(affiliateCommissionPostings.currency, 'EUR'),
        ),
      );
    expect(postings).toHaveLength(0);
  });

  it('keeps `affiliate_transactions` deduplicated by the network’s own id', async () => {
    const networkTransactionId = `awin-${uuidv7()}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await applyReportedTransaction(db, {
        network: 'awin',
        reportRunId: runId,
        reported: reported(networkTransactionId),
        now: new Date(),
      });
    }
    const rows = await db
      .select({ id: affiliateTransactions.id })
      .from(affiliateTransactions)
      .where(
        and(
          eq(affiliateTransactions.network, 'awin'),
          eq(affiliateTransactions.networkTransactionId, networkTransactionId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  /**
   * #445 — one click, one transaction.
   *
   * The network key stops one TRANSACTION being counted twice; this stops one
   * CLICK being credited twice, which is what a matcher would make possible.
   * Nothing in the service layer can breach it today, which is exactly why the
   * guard has to be the DATABASE's: the code that could breach it does not
   * exist yet, so a service-level check would be written by the same person who
   * writes the matcher, at the same time, from the same wrong assumption.
   */
  describe('one click cannot be credited to two transactions', () => {
    it('refuses the SECOND transaction citing one click, with SQLSTATE 23505', async () => {
      const clickId = `click-${uuidv7()}`;
      await insertMatchedTransaction(db, clickId);

      let caught: unknown;
      try {
        await insertMatchedTransaction(db, clickId);
      } catch (error) {
        caught = error;
      }

      expect(caught, 'the second write SUCCEEDED; the index did not fire').toBeDefined();
      // The SQLSTATE, not merely "it threw": a unique violation and a CHECK
      // violation are different facts and only one of them is this index.
      expect(sqlstateOf(caught)).toBe('23505');
      expect(refusalTextOf(caught)).toMatch(/affiliate_transactions_matched_click_key/u);

      const rows = await db
        .select({ id: affiliateTransactions.id })
        .from(affiliateTransactions)
        .where(eq(affiliateTransactions.matchedClickId, clickId));
      expect(rows).toHaveLength(1);

      await db.delete(affiliateTransactions).where(eq(affiliateTransactions.matchedClickId, clickId));
    });

    /**
     * The MUTATION control for the case above.
     *
     * Drop the index inside a transaction that is rolled back, and the same pair
     * of writes is ADMITTED. Without this, the case above passes identically
     * whether the index exists or the fixture is simply wrong about what it is
     * inserting — "I found a refusal" and "there is a constraint" look the same
     * from one green test.
     *
     * The window is one statement wide and one table wide: `DROP INDEX` takes
     * ACCESS EXCLUSIVE on `affiliate_transactions`, and this database is shared
     * with whatever runs in parallel.
     */
    it('MUTATION: admits the same pair once the index is dropped, then restores it', async () => {
      const clickId = `click-${uuidv7()}`;
      let admitted = 0;

      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`drop index "affiliate_transactions_matched_click_key"`);
          await insertMatchedTransaction(tx, clickId);
          await insertMatchedTransaction(tx, clickId);
          admitted = 2;
          throw new Error('rolling back the mutation');
        }),
      ).rejects.toThrow(/rolling back the mutation/u);

      // Both writes landed with the index gone — so the refusal above was the
      // index and not the fixture.
      expect(admitted).toBe(2);

      // The rollback took the DDL with it: the index is back, and enforcing.
      const [restored] = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from pg_indexes
             where indexname = 'affiliate_transactions_matched_click_key'`,
      );
      expect(restored?.count).toBe(1);

      const leaked = await db
        .select({ id: affiliateTransactions.id })
        .from(affiliateTransactions)
        .where(eq(affiliateTransactions.matchedClickId, clickId));
      expect(leaked).toHaveLength(0);
    });
  });
});
