/**
 * Supplier credits: linking them, classifying them and booking them (#128
 * "Supplier credits and returns").
 *
 * #124 records what a supplier ISSUED — a `purchase_order_documents` row of kind
 * `credit_note`, metadata only, booking nothing. This turns each of those into a
 * linked, classified, booked movement, exactly once.
 *
 * ## The classification is rules 2 and 3, and it is DERIVED from evidence
 *
 * A credit is `return_linked` when the purchase order it reverses belongs to an
 * order that has a customer return or refund against it, and `cost_reduction`
 * otherwise. The distinction is not a label somebody chooses: it decides whether
 * the credit may produce a customer adjustment, and a chooser would eventually
 * choose wrong in the direction that keeps money.
 *
 * Neither classification touches the customer's refund. Rule 2's "does not
 * reduce an already-promised customer refund" is held by this module writing
 * nothing on the customer side at all — the equation sees BOTH the refund and
 * the credit on the next revision, they lower opposite sides by the same amount,
 * and the variance is unchanged. Rule 3's "may create a customer adjustment"
 * happens the same way, by the credit lowering the cost side alone.
 *
 * ## Rule 4 is one unique index
 *
 * `retail_supplier_credits.claim_key` is `<purchaseOrderId>:<providerDocumentId>`,
 * so a redelivered supplier document, a poll after a webhook and this sweep
 * re-reading the same credit note all converge on one row. The key is composed
 * from what the credit IS about and never from when it was seen.
 *
 * ## Rule 5 is the chart of accounts
 *
 * "Credits cannot be silently classified as retail revenue" — the only posting a
 * credit can produce debits `supplier_prepaid` and credits `procurement_expense`
 * (ADR 0004 D7), and there is no revenue account reachable from
 * `supplierCreditReceived` at all.
 */

import type { CurrencyCode } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import {
  listPurchaseOrdersForOrder,
  listRefundsForOrder,
  listSupplierDocumentsForPurchaseOrders,
} from '../../db/retailReconciliation/evidenceSourceRepository.js';
import { raiseReconciliationException } from '../../db/retailReconciliation/exceptionRepository.js';
import {
  claimLedgerRecognition,
  claimRetailSupplierCredit,
  isLedgerRecognitionClaimed,
  supplierCreditClaimKey,
} from '../../db/retailReconciliation/supplierCreditRepository.js';
import { supplierCreditReceived } from '../payments/ledger-postings.js';
import { log } from '../../lib/logger.js';

/** What one ingestion pass over an order's credit notes did. */
export interface SupplierCreditIngestOutcome {
  recorded: number;
  booked: number;
}

/**
 * Record and book every credit note a retail order's purchase orders carry.
 *
 * Runs before the equation on the same order, so a credit that arrived since the
 * last pass is part of the evidence the next revision reads. Idempotent at both
 * steps: the credit's claim key converges a repeat, and the ledger recognition
 * claim converges a re-run of the posting.
 */
export async function ingestSupplierCreditsForOrder(input: {
  orderId: string;
  now?: Date;
}): Promise<SupplierCreditIngestOutcome> {
  const now = input.now ?? new Date();
  const db = getDb();

  const purchaseOrders = await listPurchaseOrdersForOrder(input.orderId, db);
  if (purchaseOrders.length === 0) return { recorded: 0, booked: 0 };

  const documents = await listSupplierDocumentsForPurchaseOrders(
    purchaseOrders.map((po) => po.id),
    db,
  );
  const creditNotes = documents.filter((doc) => doc.kind === 'credit_note');
  if (creditNotes.length === 0) return { recorded: 0, booked: 0 };

  // A customer return or refund on this order is what makes a credit
  // `return_linked`. Read once for the whole pass rather than per credit.
  const refunds = await listRefundsForOrder(input.orderId, db);
  const hasCustomerReturn = refunds.length > 0;

  let recorded = 0;
  let booked = 0;

  for (const note of creditNotes) {
    const po = purchaseOrders.find((entry) => entry.id === note.purchaseOrderId);
    if (!po) continue;

    const creditCurrency = note.currency as CurrencyCode;
    // The credit's net of the B2B tax it reverses, for the reason the invoice's
    // is: reverse-charge VAT is input-deductible and is not a cost of the sale
    // (ADR 0004 D2.4), so crediting it back would understate the cost by an
    // amount that was never in it.
    const netMinor = note.totalAmount - (note.taxAmount ?? 0);
    if (netMinor <= 0) continue;

    const classification = hasCustomerReturn ? 'return_linked' : 'cost_reduction';

    const didRecord = await recordAndBookSupplierCredit({
      classification,
      orderId: input.orderId,
      supplierId: po.supplierId,
      purchaseOrderId: po.id,
      providerDocumentId: note.providerDocumentId,
      ...(note.relatedProviderDocumentId
        ? { supplierInvoiceReference: note.relatedProviderDocumentId }
        : {}),
      currency: creditCurrency,
      amountMinor: netMinor,
      issuedAt: note.issuedAt,
      now,
    });
    if (didRecord) {
      recorded += 1;
      booked += 1;
    }
  }

  if (recorded > 0 || booked > 0) {
    log.general.info(
      { orderId: input.orderId, recorded, booked },
      '[RetailReconciliation] supplier credits ingested',
    );
  }
  return { recorded, booked };
}

/**
 * Record a credit note whose customer order Mercaria cannot determine.
 *
 * #128 supplier-credit rule 1 asks that every credit be linked to the purchase
 * order, the invoice and the affected customer order. When the third is not
 * derivable the credit is still RECORDED — as `unattributable`, with an open
 * exception — because guessing would either invent a customer adjustment on the
 * wrong order or hide one that is genuinely owed, and losing the credit would
 * lose money Mercaria is owed.
 *
 * It books nothing: `supplierCreditReceived` credits `procurement_expense` with
 * an order correlation, and booking one against no order would leave an expense
 * reduction nobody can attribute at finality.
 */
export async function recordUnattributableSupplierCredit(input: {
  purchaseOrderId: string;
  orderId: string;
  providerDocumentId: string;
  amount: { amount: number; currency: CurrencyCode };
  issuedAt: Date;
  detail: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const db = getDb();
  await claimRetailSupplierCredit(
    {
      classification: 'unattributable',
      purchaseOrderId: input.purchaseOrderId,
      providerDocumentId: input.providerDocumentId,
      credit: input.amount,
      accounting: input.amount,
      issuedAt: input.issuedAt,
      recordedAt: now,
    },
    db,
  );
  await raiseReconciliationException(
    {
      kind: 'unlinked_supplier_credit',
      orderId: input.orderId,
      purchaseOrderId: input.purchaseOrderId,
      detail: input.detail,
      at: now,
    },
    db,
  );
}

/**
 * Record one credit and book it, in ONE transaction.
 *
 * Recording and booking are not two steps here, and that is why
 * `retail_supplier_credits` can be strictly append-only: the row is inserted
 * with its `ledger_transaction_id` already set, so there is no later UPDATE for
 * the trigger to refuse and no window in which a recorded credit is unbooked.
 *
 * ## The three steps, and why they are in this order
 *
 * 1. **Read the recognition claim.** Already held ⇒ the credit was recorded and
 *    booked by an earlier pass, atomically, so nothing is written at all.
 * 2. **Write the entries, then take the claim.** The claim names the
 *    transaction, so the transaction has to exist first; a claim taken
 *    concurrently makes this one THROW, which rolls the entries back. Reading
 *    the empty `ON CONFLICT DO NOTHING` result as "already booked" instead would
 *    COMMIT the duplicate entries — and the ledger is append-only, so nothing
 *    could remove them.
 * 3. **Insert the credit row naming the posting.** Its own `claim_key` unique is
 *    the second lock on the same door; a conflict here means the two claims
 *    disagree, which is a bug rather than a race, and rolling back is the only
 *    safe answer.
 *
 * @returns `false` when it was already recorded, the ordinary outcome of a
 *   re-run.
 */
async function recordAndBookSupplierCredit(input: {
  classification: 'return_linked' | 'cost_reduction';
  orderId: string;
  supplierId: string;
  purchaseOrderId: string;
  providerDocumentId: string;
  supplierInvoiceReference?: string;
  currency: CurrencyCode;
  amountMinor: number;
  issuedAt: Date;
  now: Date;
}): Promise<boolean> {
  const db = getDb();
  const claimKey = supplierCreditClaimKey(input.purchaseOrderId, input.providerDocumentId);

  return db.transaction(async (tx) => {
    if (await isLedgerRecognitionClaimed({ kind: 'supplier_credit', claimKey }, tx)) return false;

    const posting = supplierCreditReceived({
      orderId: input.orderId,
      supplierId: input.supplierId,
      purchaseOrderId: input.purchaseOrderId,
      currency: input.currency,
      amountMinor: BigInt(input.amountMinor),
    });
    const written = await insertLedgerTransaction(tx, posting.transaction, posting.entries);
    const claim = await claimLedgerRecognition(
      {
        kind: 'supplier_credit',
        claimKey,
        ledgerTransactionId: written.id,
        orderId: input.orderId,
        purchaseOrderId: input.purchaseOrderId,
        supplierId: input.supplierId,
        booked: { amount: input.amountMinor, currency: input.currency },
        bookedAt: input.now,
      },
      tx,
    );
    if (!claim) {
      throw new Error(
        `The supplier-credit posting for ${claimKey} was claimed concurrently; rolling back ` +
          'so the duplicate entries are discarded.',
      );
    }

    const { created } = await claimRetailSupplierCredit(
      {
        classification: input.classification,
        purchaseOrderId: input.purchaseOrderId,
        orderId: input.orderId,
        providerDocumentId: input.providerDocumentId,
        ...(input.supplierInvoiceReference
          ? { supplierInvoiceReference: input.supplierInvoiceReference }
          : {}),
        credit: { amount: input.amountMinor, currency: input.currency },
        // The credit is recorded in the SUPPLIER's own currency on both sides.
        // Converting it into the order's accounting currency is the
        // reconciliation's job, made with the rate the sale was priced at —
        // this module has no historical source for one, and inventing it here
        // would be exactly the revaluation #128 forbids.
        accounting: { amount: input.amountMinor, currency: input.currency },
        issuedAt: input.issuedAt,
        recordedAt: input.now,
        ledgerTransactionId: written.id,
      },
      tx,
    );
    if (!created) {
      throw new Error(
        `Supplier credit ${claimKey} already exists although its ledger recognition did not. ` +
          'The two claims disagree, which is a defect rather than a race; rolling back.',
      );
    }
    return true;
  });
}
