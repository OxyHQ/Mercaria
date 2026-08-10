/**
 * Reconciling ONE retail order: gather, evaluate, record, book (#128).
 *
 * The one impure composer of this domain. Everything it decides is decided by
 * pure functions it calls — `gatherReconciliationEvidence` reads the frozen
 * records, `classifyRetailReconciliation` evaluates the equation,
 * `reconciliationEvidenceDigest` says whether anything changed — and what this
 * adds is the transaction they all commit in.
 *
 * ## Everything commits together, and that is the whole design
 *
 * A revision, its components, its evidence, the exceptions it raises or clears,
 * the customer adjustment it may create and the ledger posting that recognizes
 * that adjustment are ONE `db.transaction`. Half a reconciliation is not a
 * state worth allowing: a revision whose components failed to write is a verdict
 * nobody can reproduce, and an adjustment whose recognition failed to book is an
 * obligation to a buyer that the books do not know about.
 *
 * The ledger posting is inside that transaction for the same reason
 * `chargeSucceeded`'s is inside the status transition's: the ledger repository
 * takes the caller's handle precisely so accounting cannot commit apart from the
 * thing it accounts for.
 *
 * ## A re-run under unchanged evidence writes NOTHING
 *
 * The digest is over the evidence and never over the clock, so the sweep can
 * visit one order every minute for a month and produce one revision. That is
 * what makes "exactly one customer adjustment obligation" (#128 acceptance 3)
 * survive a periodic sweep — the alternative is one obligation per tick, each
 * superseding the last.
 *
 * ## What this module does NOT do
 *
 * It does not call a rail. Turning a recognized adjustment into money is
 * `adjustment.service.ts`, through #49's existing refund domain, from its own
 * transaction — the commerce record commits before the rail is called, exactly
 * as every other refund in this codebase (ADR 0001 D7).
 */

import type {
  CurrencyCode,
  RetailLedgerRecognitionKind,
  RetailReconciliationExceptionKind,
} from '@mercaria/shared-types';
import {
  RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS,
  RETAIL_RECONCILIATION_EXCEPTION_KINDS,
  RETAIL_RECONCILIATION_DEFAULT_TOLERANCE_MINOR,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import {
  claimRetailCustomerAdjustment,
  findLiveAdjustmentForOrder,
  supersedeAdjustment,
  sumSettledAdjustments,
} from '../../db/retailReconciliation/adjustmentRepository.js';
import {
  autoResolveReconciliationExceptions,
  raiseReconciliationException,
} from '../../db/retailReconciliation/exceptionRepository.js';
import {
  findActiveRetailReconciliationPolicy,
  type RetailReconciliationPolicyWithTolerances,
} from '../../db/retailReconciliation/policyRepository.js';
import {
  findLatestReconciliation,
  insertReconciliation,
  type RetailReconciliationRow,
} from '../../db/retailReconciliation/reconciliationRepository.js';
import {
  claimLedgerRecognition,
  isLedgerRecognitionClaimed,
} from '../../db/retailReconciliation/supplierCreditRepository.js';
import {
  procurementSettled,
  retailVarianceRecognized,
  type LedgerPosting,
} from '../payments/ledger-postings.js';
import { log } from '../../lib/logger.js';
import { classifyRetailReconciliation } from './equation.js';
import { gatherReconciliationEvidence, type ProcurementDraw } from './evidence.js';
import { reconciliationEvidenceDigest } from './evidence-digest.js';
import { RETAIL_RECONCILIATION_POLICY_KEY } from './policy-key.js';
import { alertOnAbsorbedVariance, feedSupplierVarianceMeasurements } from './variance-feedback.js';

/** What one reconciliation run did. */
export interface ReconcileOutcome {
  /** `undefined` when the order is not a reconcilable retail order. */
  reconciliation?: RetailReconciliationRow;
  /** False when the evidence was unchanged and the previous revision still stands. */
  created: boolean;
  /** The adjustment this run created, when the surplus was material. */
  adjustmentId?: string;
  /** The blocking conditions raised as operator exceptions. */
  blocked: readonly RetailReconciliationExceptionKind[];
}

/**
 * Reconcile one order.
 *
 * @param orderId A `mercaria_retail` order. Anything else returns
 *   `{ created: false }` — the sweep's page filter already excludes them, and a
 *   throw would make one misrouted id fail a whole page.
 */
export async function reconcileRetailOrder(input: {
  orderId: string;
  now?: Date;
}): Promise<ReconcileOutcome> {
  const now = input.now ?? new Date();
  const db = getDb();

  const active = await findActiveRetailReconciliationPolicy(RETAIL_RECONCILIATION_POLICY_KEY, db);
  if (!active) {
    // No published policy means no tolerance and no automation floor, and a
    // reconciliation without them would have to invent both. The refusal is
    // loud rather than defaulted for the reason #58 and #121 refuse without an
    // active version: a verdict made under a policy nobody published cannot be
    // reproduced or reviewed.
    log.general.warn(
      { orderId: input.orderId, policyKey: RETAIL_RECONCILIATION_POLICY_KEY },
      '[RetailReconciliation] no active policy version; nothing reconciled',
    );
    return { created: false, blocked: [] };
  }

  const gathered = await gatherReconciliationEvidence(input.orderId, db);
  if (!gathered) return { created: false, blocked: [] };

  const tolerance = resolveTolerance(active, gathered.accountingCurrency);
  const verdict = classifyRetailReconciliation({
    accountingCurrency: gathered.accountingCurrency,
    terms: gathered.terms,
    toleranceMinor: tolerance.toleranceMinor,
    blockedBy: gathered.blocked.map((block) => block.kind),
  });

  const digest = reconciliationEvidenceDigest({
    orderId: input.orderId,
    policyKey: active.policy.policyKey,
    policyVersion: active.policy.version,
    accountingCurrency: gathered.accountingCurrency,
    toleranceMinor: tolerance.toleranceMinor,
    records: gathered.digestRecords,
    blockedBy: gathered.blocked.map((block) => block.kind),
  });

  const previous = await findLatestReconciliation(input.orderId, db);
  if (previous?.evidenceDigest === digest) {
    // Nothing this reconciliation depends on has moved. The exceptions are
    // still refreshed below so an operator sees the condition is current rather
    // than a month old.
    await refreshExceptions({ gathered, reconciliationId: previous.id, now });
    return {
      created: false,
      reconciliation: previous,
      blocked: gathered.blocked.map((block) => block.kind),
    };
  }

  const revision = (previous?.revision ?? 0) + 1;
  const priorAdjustedMinor = await sumSettledAdjustments(input.orderId, db);
  const liveAdjustment = await findLiveAdjustmentForOrder(input.orderId, db);

  /**
   * The whole record, in one transaction.
   *
   * A `const` bound before it is used rather than a hoisted declaration, so a
   * reader meets the transaction body before the `try` that runs it.
   */
  const runReconciliationTransaction = async (): Promise<{
    row: RetailReconciliationRow;
    adjustmentId?: string;
  }> =>
    db.transaction(async (tx) => {
      const row = await insertReconciliation(
        {
          orderId: input.orderId,
          revision,
          policyId: active.policy.id,
          policyKey: active.policy.policyKey,
          policyVersion: active.policy.version,
          completeness: verdict.completeness,
          ...(verdict.completeness === 'complete' ? { outcome: verdict.outcome } : {}),
          accountingCurrency: gathered.accountingCurrency,
          // An incomplete revision carries zeros in the three amount columns and
          // NO outcome. The zeros are not a claim about the money — the
          // biconditional CHECK makes the absent verdict the fact a reader has
          // to interpret, and the components beside it say what evidence was
          // found. Leaving them nullable instead would put three more nullable
          // money columns into a table whose whole point is that a figure is
          // either evidenced or absent.
          customerAmountBeforeSubsidyMinor:
            verdict.completeness === 'complete' ? verdict.customerAmountBeforeSubsidyMinor : 0,
          finalAttributableCostMinor:
            verdict.completeness === 'complete' ? verdict.finalAttributableCostMinor : 0,
          costVarianceMinor: verdict.completeness === 'complete' ? verdict.costVarianceMinor : 0,
          toleranceMinor: tolerance.toleranceMinor,
          evidenceDigest: digest,
          computedAt: now,
          components: gathered.components,
          evidence: gathered.evidence,
        },
        tx,
      );

      // The supplier draws, one posting per purchase order, each claimed so a
      // re-run books nothing.
      for (const draw of gathered.procurementDraws) {
        await bookProcurementDraw({ orderId: input.orderId, draw, now, tx });
      }

      if (
        verdict.completeness !== 'complete' ||
        verdict.outcome !== 'customer_adjustment_required'
      ) {
        return { row };
      }

      // #128 item 2: the refundable difference is calculated after considering
      // PRIOR adjustments. A later revision that finds the same surplus an
      // earlier one already paid must not pay it twice.
      const owedMinor = verdict.costVarianceMinor - priorAdjustedMinor;
      if (owedMinor <= 0) return { row };

      // ADR 0004 D8.2: the automation floor bounds whether Mercaria calls the
      // rail unasked. A sub-floor surplus is still owed, still recorded and
      // still refundable on request — what it does not get is an unrequested
      // refund, which is a different decision from whether the money is the
      // buyer's.
      const method =
        owedMinor >= tolerance.automationFloorMinor ? 'provider_refund' : 'recorded_payable';
      const { adjustment, created } = await claimRetailCustomerAdjustment(
        {
          orderId: input.orderId,
          reconciliationId: row.id,
          reconciliationRevision: revision,
          amount: { amount: owedMinor, currency: gathered.accountingCurrency },
          method,
          ...(method === 'recorded_payable'
            ? { blockReason: 'below_automation_threshold' as const }
            : {}),
          ...(gathered.nonRefundableProviderCostMinor > 0
            ? {
                nonRefundableProviderCost: {
                  amount: gathered.nonRefundableProviderCostMinor,
                  currency: gathered.accountingCurrency,
                },
              }
            : {}),
        },
        tx,
      );

      if (created) {
        await recognizeVariance({
          orderId: input.orderId,
          reconciliationId: row.id,
          amountMinor: owedMinor,
          currency: gathered.accountingCurrency,
          now,
          tx,
        });
        if (liveAdjustment && liveAdjustment.id !== adjustment.id) {
          await supersedeAdjustment({ id: liveAdjustment.id, supersededById: adjustment.id }, tx);
        }
      }
      return { row, adjustmentId: adjustment.id };
    });

  let written: { row: RetailReconciliationRow; adjustmentId?: string };
  try {
    written = await runReconciliationTransaction();
  } catch (error: unknown) {
    if (error instanceof ConcurrentLedgerRecognitionError) {
      // Another task booked one of this run's postings while this transaction
      // was writing its entries, so the whole transaction was discarded. Nothing
      // is wrong and nothing is lost: the winner committed, and the next pass
      // reads its revision. Reporting it as a failure would page somebody about
      // two tasks doing their job.
      log.general.info(
        { orderId: input.orderId, err: error.message },
        '[RetailReconciliation] a concurrent run booked this order first',
      );
      return { created: false, blocked: gathered.blocked.map((block) => block.kind) };
    }
    throw error;
  }

  await refreshExceptions({ gathered, reconciliationId: written.row.id, now });

  // #128 negative-variance rules 3 and 5. Outside the transaction on purpose:
  // an alert and a supplier measurement are RECORDINGS about a reconciliation
  // that is already correct, and a failure to raise one must not roll back the
  // verdict — the reverse of the ledger posting above, which must not be able to
  // commit apart from what it accounts for.
  if (verdict.completeness === 'complete' && verdict.outcome === 'mercaria_absorbed') {
    await alertOnAbsorbedVariance({
      orderId: input.orderId,
      absorbedMinor: Math.abs(verdict.costVarianceMinor),
      customerAmountMinor: verdict.customerAmountBeforeSubsidyMinor,
      currency: gathered.accountingCurrency,
      now,
    });
    for (const supplierId of new Set(gathered.procurementDraws.map((draw) => draw.supplierId))) {
      await feedSupplierVarianceMeasurements({ supplierId, now });
    }
  }

  log.general.info(
    {
      orderId: input.orderId,
      revision,
      completeness: verdict.completeness,
      outcome: verdict.completeness === 'complete' ? verdict.outcome : undefined,
      blocked: gathered.blocked.length,
    },
    '[RetailReconciliation] revision recorded',
  );

  return {
    reconciliation: written.row,
    created: true,
    ...(written.adjustmentId ? { adjustmentId: written.adjustmentId } : {}),
    blocked: gathered.blocked.map((block) => block.kind),
  };
}

/**
 * The tolerance and automation floor for one currency under one policy version.
 *
 * A version that published no row for a currency falls back to the shared-types
 * default rather than to zero — a tolerance of zero would classify every
 * half-even rounding residue as a material variance and generate a refund
 * obligation for one minor unit on a large share of orders. The fallback is the
 * SAME derivation the operator surface offers as a default, so a published
 * version and an unpublished currency behave alike.
 */
function resolveTolerance(
  active: RetailReconciliationPolicyWithTolerances,
  currency: CurrencyCode,
): { toleranceMinor: number; automationFloorMinor: number } {
  const row = active.tolerances.find((entry) => entry.currency === currency);
  if (row) {
    return { toleranceMinor: row.toleranceMinor, automationFloorMinor: row.automationFloorMinor };
  }
  return {
    toleranceMinor: RETAIL_RECONCILIATION_DEFAULT_TOLERANCE_MINOR[currency],
    // With no published floor, every material surplus is refunded automatically.
    // The alternative — a large default floor — would leave money owed to buyers
    // sitting unrefunded because nobody published a row.
    automationFloorMinor: 0,
  };
}

/**
 * Raise what is blocking, and close what no longer is.
 *
 * Outside the reconciliation's transaction deliberately: an exception is a
 * RECORDING about the state of the evidence and not part of the verdict, and a
 * failure to write one must not roll back a revision that is otherwise correct.
 * The upsert makes a repeat a bump rather than a row.
 */
async function refreshExceptions(input: {
  gathered: { order: { id: string }; blocked: readonly { kind: RetailReconciliationExceptionKind; detail: string; purchaseOrderId?: string }[] };
  reconciliationId: string;
  now: Date;
}): Promise<void> {
  const raised = new Set<RetailReconciliationExceptionKind>();
  for (const block of input.gathered.blocked) {
    raised.add(block.kind);
    await raiseReconciliationException({
      kind: block.kind,
      orderId: input.gathered.order.id,
      reconciliationId: input.reconciliationId,
      ...(block.purchaseOrderId ? { purchaseOrderId: block.purchaseOrderId } : {}),
      detail: block.detail,
      at: input.now,
    });
  }

  // Only the BLOCKING kinds are auto-resolved. `absorbed_variance_over_threshold`
  // and `recurring_quote_inaccuracy` are raised ABOUT a completed reconciliation
  // and are somebody's to close: clearing them because the next revision
  // happened to be fine would erase the alert that a cost model is unreliable.
  const cleared = RETAIL_RECONCILIATION_EXCEPTION_KINDS.filter(
    (kind) => RETAIL_RECONCILIATION_BLOCKING_EXCEPTION_KINDS.includes(kind) && !raised.has(kind),
  );
  await autoResolveReconciliationExceptions({
    orderId: input.gathered.order.id,
    kinds: cleared,
    reason: 'The evidence this condition described is now present.',
    now: input.now,
  });
}

/** Book a purchase order's draw against the supplier's prepaid balance, once. */
async function bookProcurementDraw(input: {
  orderId: string;
  draw: ProcurementDraw;
  now: Date;
  tx: DatabaseOrTransaction;
}): Promise<void> {
  const { draw } = input;
  if (draw.amountMinor <= 0) return;

  await bookOnce({
    kind: 'procurement_settled',
    claimKey: draw.purchaseOrderId,
    posting: procurementSettled({
      orderId: input.orderId,
      supplierId: draw.supplierId,
      purchaseOrderId: draw.purchaseOrderId,
      currency: draw.currency,
      amountMinor: BigInt(draw.amountMinor),
    }),
    orderId: input.orderId,
    purchaseOrderId: draw.purchaseOrderId,
    supplierId: draw.supplierId,
    amount: { amount: draw.amountMinor, currency: draw.currency },
    now: input.now,
    tx: input.tx,
  });
}

/** Extract a positive variance to `customer_adjustment`, once per revision. */
async function recognizeVariance(input: {
  orderId: string;
  reconciliationId: string;
  amountMinor: number;
  currency: CurrencyCode;
  now: Date;
  tx: DatabaseOrTransaction;
}): Promise<void> {
  await bookOnce({
    kind: 'variance_recognized',
    claimKey: input.reconciliationId,
    posting: retailVarianceRecognized({
      orderId: input.orderId,
      currency: input.currency,
      amountMinor: BigInt(input.amountMinor),
    }),
    orderId: input.orderId,
    amount: { amount: input.amountMinor, currency: input.currency },
    now: input.now,
    tx: input.tx,
  });
}

/**
 * Write one posting and take its claim, in the caller's transaction.
 *
 * ## The order of the three steps is the whole safety property
 *
 * 1. **Read the claim.** Already held ⇒ nothing is written at all, which is the
 *    ordinary outcome of a re-run and costs one indexed lookup.
 * 2. **Write the entries.** They have to exist before the claim can name them:
 *    `retail_ledger_recognitions.ledger_transaction_id` is NOT NULL, and a
 *    claim pointing at nothing would be a record of a posting that does not
 *    exist.
 * 3. **Insert the claim, and THROW if it was taken in between.** A concurrent
 *    task that passed step 1 at the same moment wins the unique index; the loser
 *    throws, and the throw rolls the whole transaction back — including the
 *    entries it just wrote.
 *
 * Step 3 is why `claimLedgerRecognition`'s empty result must be an ERROR here
 * and not a shrug. `ON CONFLICT DO NOTHING` does not abort a transaction, so
 * treating the empty set as "already booked" would COMMIT the duplicate entries
 * this function exists to prevent — and the ledger is append-only, so nothing
 * could ever remove them. The caller catches the throw and reports the run as
 * not-created, because the racer that won did the work.
 */
async function bookOnce(input: {
  kind: RetailLedgerRecognitionKind;
  claimKey: string;
  posting: LedgerPosting;
  orderId?: string;
  purchaseOrderId?: string;
  supplierId?: string;
  amount: { amount: number; currency: CurrencyCode };
  now: Date;
  tx: DatabaseOrTransaction;
}): Promise<void> {
  const held = await isLedgerRecognitionClaimed(
    { kind: input.kind, claimKey: input.claimKey },
    input.tx,
  );
  if (held) return;

  const written = await insertLedgerTransaction(
    input.tx,
    input.posting.transaction,
    input.posting.entries,
  );
  const claim = await claimLedgerRecognition(
    {
      kind: input.kind,
      claimKey: input.claimKey,
      ledgerTransactionId: written.id,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      booked: input.amount,
      bookedAt: input.now,
    },
    input.tx,
  );
  if (!claim) {
    throw new ConcurrentLedgerRecognitionError(
      `Another task claimed the '${input.kind}' posting for '${input.claimKey}' while this ` +
        'transaction was writing its entries. Rolling back so the duplicate entries are ' +
        'discarded; the winning task has booked it.',
    );
  }
}

/**
 * Raised when a concurrent task took a recognition claim mid-transaction.
 *
 * A distinct class so `reconcileRetailOrder` can report the run as not-created
 * instead of surfacing a 500: nothing is wrong, another task did the work, and
 * the next pass will read the committed result. Any other error still
 * propagates, because a reconciliation that failed for a real reason must not
 * look like a race.
 */
export class ConcurrentLedgerRecognitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentLedgerRecognitionError';
  }
}
