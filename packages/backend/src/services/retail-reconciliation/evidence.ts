/**
 * Gathering the authoritative evidence one retail order's reconciliation is
 * built from (#128 "Reconciliation sources").
 *
 * Every figure below comes off a FROZEN record — the #123 procurement intent,
 * the #120 immutable quote, the payment and its ledger entries, the refunds,
 * the disputes, the #124 purchase orders and the documents a supplier issued.
 * Nothing is read from a live catalogue price and nothing is converted at
 * today's rate.
 *
 * ## Why the accounting currency is the buyer's PRESENTMENT currency
 *
 * Every other candidate needs a conversion this module is not allowed to make.
 * The customer amount was FROZEN in presentment at checkout and may never
 * change (ADR 0004 D8.1), so expressing the equation in anything else would
 * make the one immutable number in it depend on a rate. And the quote's
 * components already carry a presentment amount beside their source amount,
 * with the exact `FxRateSnapshot` between them — so the rates needed to bring a
 * supplier's figures into this currency are the rates the quote itself used, at
 * the moment the buyer accepted, stored.
 *
 * ## Every conversion reuses a STORED rate, or the reconciliation blocks
 *
 * `rateTableFrom` builds the (from → to) map out of the quote's own component
 * snapshots. A supplier amount in a currency the quote never converted has no
 * historical rate available, and the answer is `currency_unconvertible` — an
 * operator exception — never a call to `fx.service`. #128's multi-currency rule
 * 3 ("never revalue historical order truth using today's rate") is that absence
 * plus the scanned gate that keeps `fx.service` unimportable here.
 *
 * ## A missing term blocks; it never becomes a zero
 *
 * Every `blocked` entry names a term of the equation with no evidence behind it.
 * `classifyRetailReconciliation` refuses to produce a verdict while any of them
 * is present, and the caller raises each as an operator exception. The failure
 * this prevents is the quiet one: a supplier invoice that has not arrived
 * summed as zero cost, producing a large confident surplus and a refund the
 * buyer was never owed.
 */

import type {
  CurrencyCode,
  FxRateSnapshot,
  RetailAccountingComponent,
  RetailReconciliationExceptionKind,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { sumLedgerAccountForPayment } from '../../db/payments/ledgerRepository.js';
import { findNativePaymentByCheckoutGroupId } from '../../db/payments/paymentRepository.js';
import { findRetailCostQuoteById } from '../../db/retailPricing/retailCostQuoteRepository.js';
import {
  listRetailProcurementIntentLines,
  listRetailProcurementIntents,
} from '../../db/retailCheckout/retailCheckoutRepository.js';
import {
  findReconcilableOrder,
  listCheckoutGroupOrderWeights,
  listDisputesForOrder,
  listPurchaseOrdersForOrder,
  listRefundsForOrder,
  listSupplierDocumentsForPurchaseOrders,
  type OrderRefundRecord,
  type ReconcilableOrder,
} from '../../db/retailReconciliation/evidenceSourceRepository.js';
import { listSupplierCreditsForOrder } from '../../db/retailReconciliation/supplierCreditRepository.js';
import type {
  NewReconciliationComponent,
  NewReconciliationEvidence,
} from '../../db/retailReconciliation/reconciliationRepository.js';
import { findRetailReturnCaseForRequest } from '../../db/retailServiceRequests/returnCaseRepository.js';
import { listSupplierRecoveriesForPurchaseOrder } from '../../db/retailServiceRequests/supplierRecoveryRepository.js';
import { retailRefundIdempotencyKey } from '../retail-service-requests/refund-bridge.js';
import { apportion } from '../payments/settlement-shares.js';
import { roundMinorUnits } from '../../utils/money.js';
import type { ReconciliationTerm } from './equation.js';
import type { EvidenceDigestRecord } from './evidence-digest.js';

/** One term of the equation that has no evidence behind it. */
export interface ReconciliationBlock {
  kind: RetailReconciliationExceptionKind;
  detail: string;
  purchaseOrderId?: string;
}

/** A supplier draw #128 still owes the ledger, in the SUPPLIER's own currency. */
export interface ProcurementDraw {
  purchaseOrderId: string;
  supplierId: string;
  currency: CurrencyCode;
  amountMinor: number;
}

/** Everything the equation and the record need, gathered once. */
export interface GatheredReconciliationEvidence {
  order: ReconcilableOrder;
  accountingCurrency: CurrencyCode;
  components: NewReconciliationComponent[];
  terms: ReconciliationTerm[];
  evidence: NewReconciliationEvidence[];
  digestRecords: EvidenceDigestRecord[];
  blocked: ReconciliationBlock[];
  /** Per purchase order, what a `procurement_settled` posting should book. */
  procurementDraws: ProcurementDraw[];
  /**
   * The provider cost that would NOT come back if the whole order were
   * refunded, in the accounting currency (ADR 0004 D8.7 case b/c).
   *
   * Recorded on the adjustment rather than netted off it, so an operator sees
   * the shortfall instead of inferring it — #128 item 9's "record unavoidable
   * non-refundable provider costs explicitly rather than hiding them as
   * Mercaria margin".
   */
  nonRefundableProviderCostMinor: number;
}

/** The purchase-order states that owe a supplier invoice before a cost is final. */
const INVOICE_OWING_PO_STATES = new Set(['accepted', 'shipped', 'delivered']);
/** The states in which procurement never happened, so the attributable cost is zero. */
const NO_COST_PO_STATES = new Set(['rejected', 'expired', 'cancelled']);

/** A running total per component, with the source currency it was stated in. */
interface Bucket {
  sourceMinor: number;
  sourceCurrency: CurrencyCode;
  accountingMinor: number;
  fxSnapshot?: FxRateSnapshot;
  evidenceCount: number;
}

/**
 * The stored conversions available to this reconciliation, keyed `from>to`.
 *
 * Built from the quote's own component snapshots and from nothing else. A pair
 * the quote never converted is a pair this reconciliation cannot convert, which
 * is the point — the alternative is a fresh rate applied to a historical amount.
 */
type RateTable = Map<string, FxRateSnapshot>;

function rateKey(from: string, to: string): string {
  return `${from}>${to}`;
}

/**
 * Convert `amountMinor` from `from` into `to` using a STORED rate.
 *
 * Half-even, once, through the same `roundMinorUnits` the pricing engine uses —
 * no third rounding scheme was invented. Returns `undefined` when no stored rate
 * covers the pair, which the caller turns into `currency_unconvertible` rather
 * than into a number.
 */
function convertWithStoredRate(
  rates: RateTable,
  amountMinor: number,
  from: CurrencyCode,
  to: CurrencyCode,
): { amountMinor: number; fxSnapshot?: FxRateSnapshot } | undefined {
  if (from === to) return { amountMinor };
  const direct = rates.get(rateKey(from, to));
  if (direct) {
    return { amountMinor: roundMinorUnits(amountMinor * direct.rate), fxSnapshot: direct };
  }
  const inverse = rates.get(rateKey(to, from));
  if (inverse && inverse.rate > 0) {
    // The same conversion read backwards. The snapshot recorded is the one this
    // amount was actually converted with, so `from`/`to` are restated in the
    // direction it was applied — a snapshot naming the opposite pair would fail
    // `retail_reconciliation_components_fx_pair_check` at the WRITE, which is
    // the constraint doing its job rather than a nuisance.
    const rate = 1 / inverse.rate;
    return {
      amountMinor: roundMinorUnits(amountMinor * rate),
      fxSnapshot: { from, to, rate, provider: inverse.provider, asOf: inverse.asOf },
    };
  }
  return undefined;
}

/** Gather everything one order's reconciliation reads. */
/**
 * Which return cases behind these credits have no refund of their OWN yet.
 *
 * `commitRetailServiceRefund` derives every refund it writes from the request
 * (`retailRefundIdempotencyKey`), so the request's refund is identifiable by
 * that key and by nothing else about the refund. Reused rather than re-spelled:
 * two spellings of one key would disagree the first time #127 changed its
 * prefix, and this side would silently stop finding refunds that exist.
 *
 * A recovery with no service request, or one whose request has no return case,
 * contributes nothing — it was never a customer return, so no refund is owed
 * for it here.
 *
 * @returns the service-request ids still missing their refund, for the refusal
 *   to name. An operator who cannot see WHICH return is unmatched has to open
 *   every one.
 */
async function findReturnRequestsWithoutRefund(
  credits: readonly { purchaseOrderId: string; supplierRecoveryId: string }[],
  refunds: readonly OrderRefundRecord[],
  db: DatabaseOrTransaction,
): Promise<string[]> {
  if (credits.length === 0) return [];
  const keys = new Set(
    refunds.map((refund) => refund.idempotencyKey).filter((key): key is string => key !== null),
  );
  const missing = new Set<string>();
  for (const credit of credits) {
    // #127 publishes no single-recovery reader and this domain does not add one
    // to somebody else's repository — the per-purchase-order list is the reader
    // that exists, and a purchase order carries a handful of recoveries.
    const recoveries = await listSupplierRecoveriesForPurchaseOrder(credit.purchaseOrderId, db);
    const recovery = recoveries.find((row) => row.id === credit.supplierRecoveryId);
    if (!recovery?.serviceRequestId) continue;
    const returnCase = await findRetailReturnCaseForRequest(recovery.serviceRequestId, db);
    if (!returnCase) continue;
    if (keys.has(retailRefundIdempotencyKey(recovery.serviceRequestId))) continue;
    missing.add(recovery.serviceRequestId);
  }
  return [...missing];
}

export async function gatherReconciliationEvidence(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<GatheredReconciliationEvidence | undefined> {
  const order = await findReconcilableOrder(orderId, db);
  if (!order || order.commercialRole !== 'mercaria_retail') return undefined;

  const intents = await listRetailProcurementIntents(orderId, db);
  if (intents.length === 0) return undefined;

  const accountingCurrency = intents[0]?.buyerLockedTotalCurrency as CurrencyCode;
  const blocked: ReconciliationBlock[] = [];
  const evidence: NewReconciliationEvidence[] = [];
  const digestRecords: EvidenceDigestRecord[] = [];
  const buckets = new Map<RetailAccountingComponent, Bucket>();
  const rates: RateTable = new Map();
  const procurementDraws: ProcurementDraw[] = [];

  const add = (
    component: RetailAccountingComponent,
    input: {
      sourceMinor: number;
      sourceCurrency: CurrencyCode;
      accountingMinor: number;
      fxSnapshot?: FxRateSnapshot;
    },
  ): void => {
    if (input.sourceMinor === 0 && input.accountingMinor === 0) return;
    const existing = buckets.get(component);
    if (!existing) {
      buckets.set(component, {
        sourceMinor: input.sourceMinor,
        sourceCurrency: input.sourceCurrency,
        accountingMinor: input.accountingMinor,
        ...(input.fxSnapshot ? { fxSnapshot: input.fxSnapshot } : {}),
        evidenceCount: 1,
      });
      return;
    }
    // Two evidence records in DIFFERENT source currencies collapse onto the
    // accounting side only. The source pair then describes one of them and
    // would be a lie about the other, so it is dropped to the accounting
    // currency — which is also what makes the FX biconditional CHECK pass, and
    // is why the accounting figure is the one the equation reads.
    if (existing.sourceCurrency !== input.sourceCurrency) {
      existing.sourceCurrency = accountingCurrency;
      existing.sourceMinor = existing.accountingMinor + input.accountingMinor;
      delete existing.fxSnapshot;
    } else {
      existing.sourceMinor += input.sourceMinor;
    }
    existing.accountingMinor += input.accountingMinor;
    existing.evidenceCount += 1;
  };

  const record = (input: NewReconciliationEvidence): void => {
    evidence.push(input);
    digestRecords.push({
      kind: input.kind,
      reference: input.reference,
      ...(input.amount
        ? { amountMinor: input.amount.amount, currency: input.amount.currency }
        : {}),
      observedAt: input.observedAt,
    });
  };

  /* ---------------------------------------------------------------------- */
  /*  The customer side, and the quote that composed it                      */
  /* ---------------------------------------------------------------------- */

  let customerChargeMinor = 0;
  let subsidyMinor = 0;
  let customerTaxMinor = 0;
  let quotedHandlingMinor = 0;
  const seenQuotes = new Set<string>();

  for (const intent of intents) {
    if (intent.buyerLockedTotalCurrency !== accountingCurrency) {
      blocked.push({
        kind: 'currency_unconvertible',
        detail:
          `Supplier ${intent.supplierId}'s share of this order was locked in ` +
          `${intent.buyerLockedTotalCurrency} while the order's accounting currency is ` +
          `${accountingCurrency}. One order cannot have been charged in two currencies, so ` +
          'this is a data fault rather than a conversion.',
      });
      continue;
    }
    customerChargeMinor += intent.buyerLockedTotalAmount;

    const lines = await listRetailProcurementIntentLines(intent.id, db);
    for (const line of lines) {
      if (seenQuotes.has(line.quoteId)) continue;
      seenQuotes.add(line.quoteId);

      const quote = await findRetailCostQuoteById(db, line.quoteId);
      if (!quote) {
        blocked.push({
          kind: 'missing_cost_quote',
          detail:
            `The immutable cost quote ${line.quoteId} this line was locked under cannot be ` +
            'read, so the components the buyer was charged for are unknown.',
        });
        continue;
      }

      record({
        kind: 'retail_cost_quote',
        reference: quote.quote.id,
        amount: {
          amount: quote.quote.customerTotalAmount,
          currency: quote.quote.customerTotalCurrency as CurrencyCode,
        },
        observedAt: quote.quote.quotedAt,
      });

      subsidyMinor += quote.quote.subsidyAmount ?? 0;
      if (quote.quote.subsidyAmount) {
        record({
          kind: 'promotion_subsidy',
          reference: quote.quote.subsidyBudgetRef ?? quote.quote.id,
          amount: {
            amount: quote.quote.subsidyAmount,
            currency: quote.quote.subsidyCurrency as CurrencyCode,
          },
          observedAt: quote.quote.quotedAt,
        });
      }

      for (const component of quote.components) {
        // Every stored conversion this order has access to. Collected from
        // EVERY component, including ones whose kind is not used below: a
        // supplier's currency pair is a property of the supplier, and a rate
        // captured on the item line converts its shipping line just as well.
        if (component.fxRateFrom && component.fxRateTo && component.fxRateRate !== null) {
          rates.set(rateKey(component.fxRateFrom, component.fxRateTo), {
            from: component.fxRateFrom,
            to: component.fxRateTo,
            rate: component.fxRateRate,
            provider: component.fxRateProvider ?? 'quote',
            asOf: component.fxRateAsOf ?? quote.quote.quotedAt.toISOString(),
          });
        }
        if (component.kind === 'tax_duty') customerTaxMinor += component.presentmentAmount;
        if (component.kind === 'supplier_handling') {
          quotedHandlingMinor += component.presentmentAmount;
        }
      }
    }
  }

  add('customer_charge', {
    sourceMinor: customerChargeMinor,
    sourceCurrency: accountingCurrency,
    accountingMinor: customerChargeMinor,
  });
  add('mercaria_promotion_subsidy', {
    sourceMinor: subsidyMinor,
    sourceCurrency: accountingCurrency,
    accountingMinor: subsidyMinor,
  });
  add('tax_duty_liability', {
    sourceMinor: customerTaxMinor,
    sourceCurrency: accountingCurrency,
    accountingMinor: customerTaxMinor,
  });
  // The supplier's handling fee, as the quote stated it. #124's purchase order
  // has no handling column, so this is the only evidence of it — and a handling
  // fee the supplier BILLED differently shows up in the invoice-versus-purchase-
  // order residual below rather than being lost.
  add('supplier_handling_cost', {
    sourceMinor: quotedHandlingMinor,
    sourceCurrency: accountingCurrency,
    accountingMinor: quotedHandlingMinor,
  });

  /* ---------------------------------------------------------------------- */
  /*  The supplier side                                                      */
  /* ---------------------------------------------------------------------- */

  const purchaseOrders = await listPurchaseOrdersForOrder(orderId, db);
  const documents = await listSupplierDocumentsForPurchaseOrders(
    purchaseOrders.map((po) => po.id),
    db,
  );

  for (const po of purchaseOrders) {
    record({
      kind: 'purchase_order',
      reference: po.id,
      amount: { amount: po.totalAmount, currency: po.currency as CurrencyCode },
      observedAt: po.acceptedAt ?? po.createdAt,
    });

    if (NO_COST_PO_STATES.has(po.status)) {
      // Procurement did not happen, so no supplier cost is attributable to
      // these lines. That is a MEASURED zero and not an assumed one — the
      // purchase order's own terminal state is the evidence — and it is what
      // makes a compensating refund reconcile to a variance of the whole locked
      // amount rather than to a missing invoice.
      continue;
    }

    const invoices = documents.filter(
      (doc) => doc.purchaseOrderId === po.id && doc.kind === 'invoice',
    );
    if (invoices.length === 0) {
      blocked.push({
        kind: 'missing_supplier_invoice',
        purchaseOrderId: po.id,
        detail: INVOICE_OWING_PO_STATES.has(po.status)
          ? `Purchase order ${po.id} is '${po.status}' and no supplier invoice has been ` +
            'recorded against it, so the final supplier cost is not known.'
          : `Purchase order ${po.id} is still '${po.status}': procurement has neither ` +
            'completed nor definitively failed, so there is no final cost to reconcile yet.',
      });
      continue;
    }
    if (invoices.length > 1) {
      blocked.push({
        kind: 'duplicate_supplier_charge',
        purchaseOrderId: po.id,
        detail:
          `Purchase order ${po.id} carries ${String(invoices.length)} supplier invoices. ADR ` +
          '0004 D6.6 matches statement lines to purchase orders ONE to one; two invoices for ' +
          'one order is a double charge until somebody says otherwise.',
      });
      continue;
    }

    const invoice = invoices[0];
    if (!invoice) continue;
    record({
      kind: 'supplier_invoice',
      reference: invoice.providerDocumentId,
      amount: { amount: invoice.totalAmount, currency: invoice.currency as CurrencyCode },
      observedAt: invoice.issuedAt,
    });

    const supplierCurrency = invoice.currency as CurrencyCode;
    // The B2B tax on the supply TO Mercaria is input-deductible under reverse
    // charge (ADR 0004 D2.4) and is not a cost of the sale. Including it would
    // overstate the attributable cost and manufacture an absorbed variance on
    // every cross-border order.
    const invoiceNetMinor = invoice.totalAmount - (invoice.taxAmount ?? 0);

    // The purchase order is the only BREAKDOWN available; the invoice is
    // authoritative on the TOTAL. So the shipping and duty the purchase order
    // named are attributed as they stand, and the difference between the
    // invoice's net total and the purchase order's own net total lands on the
    // ITEM cost as the residual — which is where a supplier's re-priced goods,
    // an extra handling fee and a corrected quantity all actually show up.
    const shippingSource = po.shippingAmount;
    const dutySource = po.dutyAmount;
    const itemSource = invoiceNetMinor - shippingSource - dutySource;

    const converted = [
      { component: 'supplier_item_cost' as const, minor: itemSource },
      { component: 'fulfilment_shipping_cost' as const, minor: shippingSource },
      { component: 'tax_duty_liability' as const, minor: dutySource },
    ];

    let convertible = true;
    for (const entry of converted) {
      if (entry.minor === 0) continue;
      if (entry.minor < 0) {
        blocked.push({
          kind: 'duplicate_supplier_charge',
          purchaseOrderId: po.id,
          detail:
            `Supplier invoice ${invoice.providerDocumentId} nets ${String(invoiceNetMinor)} ` +
            `${supplierCurrency} minor units against a purchase order whose shipping and duty ` +
            `alone come to ${String(shippingSource + dutySource)}. A negative item cost is not ` +
            'a discount, it is two records describing different purchases.',
        });
        convertible = false;
        break;
      }
      const result = convertWithStoredRate(rates, entry.minor, supplierCurrency, accountingCurrency);
      if (!result) {
        blocked.push({
          kind: 'currency_unconvertible',
          purchaseOrderId: po.id,
          detail:
            `Supplier invoice ${invoice.providerDocumentId} is in ${supplierCurrency} and this ` +
            `order is accounted in ${accountingCurrency}, and the cost quote recorded no ` +
            'conversion between them. Converting at today’s rate would revalue historical ' +
            'order truth, so the reconciliation waits for the rate the sale was made at.',
        });
        convertible = false;
        break;
      }
      add(entry.component, {
        sourceMinor: entry.minor,
        sourceCurrency: supplierCurrency,
        accountingMinor: result.amountMinor,
        ...(result.fxSnapshot ? { fxSnapshot: result.fxSnapshot } : {}),
      });
    }
    if (!convertible) continue;

    // What the ledger still owes for this purchase order. The invoice's net
    // total, not the purchase order's, because ADR 0004 D6.4's draw is against
    // what the supplier actually billed.
    procurementDraws.push({
      purchaseOrderId: po.id,
      supplierId: po.supplierId,
      currency: supplierCurrency,
      amountMinor: invoiceNetMinor,
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Supplier credits                                                       */
  /* ---------------------------------------------------------------------- */

  const credits = await listSupplierCreditsForOrder(orderId, db);
  const returnLinkedCredits: { purchaseOrderId: string; supplierRecoveryId: string }[] = [];
  for (const credit of credits) {
    record({
      kind: 'supplier_credit_note',
      reference: credit.providerDocumentId,
      amount: {
        amount: credit.creditAmount,
        currency: credit.creditCurrency as CurrencyCode,
      },
      observedAt: credit.issuedAt,
    });
    if (credit.classification === 'return_linked' && credit.supplierRecoveryId) {
      returnLinkedCredits.push({
        purchaseOrderId: credit.purchaseOrderId,
        supplierRecoveryId: credit.supplierRecoveryId,
      });
    }
    add('supplier_credit', {
      sourceMinor: credit.creditAmount,
      sourceCurrency: credit.creditCurrency as CurrencyCode,
      accountingMinor: credit.accountingAmount,
      ...(credit.fxRateFrom && credit.fxRateTo && credit.fxRateRate !== null
        ? {
            fxSnapshot: {
              from: credit.fxRateFrom,
              to: credit.fxRateTo,
              rate: credit.fxRateRate,
              provider: credit.fxRateProvider ?? 'supplier_credit',
              asOf: credit.fxRateAsOf ?? credit.issuedAt.toISOString(),
            },
          }
        : {}),
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Money that went back to the buyer                                      */
  /* ---------------------------------------------------------------------- */

  const refunds = await listRefundsForOrder(orderId, db);
  for (const refund of refunds) {
    record({
      kind: 'customer_refund_record',
      reference: refund.id,
      amount: { amount: refund.amountMinor, currency: refund.currency as CurrencyCode },
      observedAt: refund.createdAt,
    });
    if (refund.currency !== accountingCurrency) {
      blocked.push({
        kind: 'currency_unconvertible',
        detail:
          `Refund ${refund.id} is denominated in ${refund.currency} while the order was ` +
          `charged in ${accountingCurrency}. A refund is a reversal of the charge and cannot ` +
          'be in another currency, so this is a data fault rather than a conversion.',
      });
      continue;
    }
    add('customer_refund', {
      sourceMinor: refund.amountMinor,
      sourceCurrency: accountingCurrency,
      accountingMinor: refund.amountMinor,
    });
  }

  // #128 supplier-credit rule 2: a credit that accompanies a customer return
  // reconciles against the return lifecycle and does not reduce an
  // already-promised refund. Both movements have to be present for that to be
  // true of the arithmetic — the credit lowers the cost side and the refund
  // lowers the customer side by the same amount, leaving the variance
  // unchanged. A credit whose refund has not been recorded would lower one side
  // alone and manufacture a surplus to refund a second time.
  //
  // The question is the RETURN CASE's OWN refund, not "has this order any
  // refund at all". An order can carry a refund for something else entirely — a
  // cancelled second line, a goodwill gesture, a failed procurement — and
  // reading one of those as the return's refund lets a return-linked credit
  // through with its customer side genuinely missing, which is the exact
  // arithmetic this block exists to prevent. The link is the recovery's own
  // service request, and the refund #127 commits for one carries a DERIVED
  // idempotency key, so the match is on identity rather than on coincidence.
  const unmatchedReturnRequests = await findReturnRequestsWithoutRefund(
    returnLinkedCredits,
    refunds,
    db,
  );
  if (unmatchedReturnRequests.length > 0) {
    blocked.push({
      kind: 'missing_customer_refund_record',
      detail:
        `This order carries supplier credit(s) linked to a customer return whose own refund ` +
        `has not been recorded: ${unmatchedReturnRequests.join(', ')}. Counting the credit ` +
        'alone would lower the cost side without lowering the customer side and would create ' +
        'a second refund for money that has already gone back.',
    });
  }

  const disputes = await listDisputesForOrder(orderId, db);
  for (const dispute of disputes) {
    record({
      kind: 'stripe_dispute',
      reference: dispute.providerDisputeId,
      amount: { amount: dispute.amountMinor, currency: dispute.currency as CurrencyCode },
      observedAt: dispute.createdAt,
    });
    // Only a LOST dispute moved money away from Mercaria and toward the buyer.
    // A warning is an inquiry with no balance movement (#49), and an open one
    // has not resolved — counting either would report the customer as having
    // been repaid for a charge they still hold.
    if (dispute.outcome !== 'lost') continue;
    if (dispute.currency !== accountingCurrency) {
      blocked.push({
        kind: 'currency_unconvertible',
        detail:
          `Dispute ${dispute.providerDisputeId} is denominated in ${dispute.currency} while ` +
          `the order was charged in ${accountingCurrency}, and no stored rate relates them.`,
      });
      continue;
    }
    add('dispute_movement', {
      sourceMinor: dispute.amountMinor,
      sourceCurrency: accountingCurrency,
      accountingMinor: dispute.amountMinor,
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  The provider's own cost                                                */
  /* ---------------------------------------------------------------------- */

  const nonRefundableProviderCostMinor = await addProviderCost({
    order,
    accountingCurrency,
    add,
    record,
    blocked,
    db,
  });

  /* ---------------------------------------------------------------------- */

  const components: NewReconciliationComponent[] = [];
  const terms: ReconciliationTerm[] = [];
  for (const [component, bucket] of buckets) {
    assertSafeMoneyAmount(bucket.accountingMinor, `retail.reconciliation.${component}`);
    components.push({
      component,
      source: { amount: bucket.sourceMinor, currency: bucket.sourceCurrency },
      accounting: { amount: bucket.accountingMinor, currency: accountingCurrency },
      ...(bucket.fxSnapshot && bucket.sourceCurrency !== accountingCurrency
        ? { fxSnapshot: bucket.fxSnapshot }
        : {}),
      evidenceCount: bucket.evidenceCount,
    });
    terms.push({ component, accountingAmountMinor: bucket.accountingMinor });
  }

  return {
    order,
    accountingCurrency,
    components,
    terms,
    evidence,
    digestRecords,
    blocked,
    procurementDraws,
    nonRefundableProviderCostMinor,
  };
}

/**
 * The order's share of the provider's ACTUAL processing cost.
 *
 * The fee is charged once for the whole PaymentIntent (ADR 0001 D4), so
 * attributing it needs every sibling's weight — a retail order in a three-order
 * cart must not carry the whole fee. `apportion` is the house largest-remainder
 * rule, the same one `settlement-shares.ts` splits a charge with, so the parts
 * sum back to the whole exactly.
 *
 * The figure comes off the LEDGER rather than off `payments`, because `payments`
 * has no fee column by design: the fee is booked straight to `processor_expense`
 * when the charge is booked (ADR 0001 D5), so the book is where the ACTUAL lives
 * and reading it back is what trues the estimate (ADR 0004 D8.7 case a).
 *
 * @returns the same figure, which is also what would NOT come back on a full
 *   refund (ADR 0004 D8.7 case b).
 */
async function addProviderCost(input: {
  order: ReconcilableOrder;
  accountingCurrency: CurrencyCode;
  add: (
    component: RetailAccountingComponent,
    value: {
      sourceMinor: number;
      sourceCurrency: CurrencyCode;
      accountingMinor: number;
      fxSnapshot?: FxRateSnapshot;
    },
  ) => void;
  record: (evidence: NewReconciliationEvidence) => void;
  blocked: ReconciliationBlock[];
  db: DatabaseOrTransaction;
}): Promise<number> {
  const { order, accountingCurrency, add, record, blocked, db } = input;

  const payment = await findNativePaymentByCheckoutGroupId(db, order.checkoutGroupId);
  if (!payment) {
    // A retail order with no native payment was never charged on a rail
    // Mercaria operates, so there is no provider cost to attribute. It is not a
    // missing document: `external` and `manual_pos` book no ledger entries at
    // all, by design (ADR 0001 D12).
    return 0;
  }
  record({
    kind: 'stripe_payment',
    reference: payment.id,
    amount: {
      amount: payment.presentmentAmount,
      currency: payment.presentmentCurrency as CurrencyCode,
    },
    observedAt: payment.createdAt,
  });

  const fees = await sumLedgerAccountForPayment(db, {
    paymentId: payment.id,
    account: 'processor_expense',
  });
  if (fees.length === 0) return 0;
  if (fees.length > 1) {
    blocked.push({
      kind: 'missing_provider_fee',
      detail:
        `Payment ${payment.id} booked processor expense in ${String(fees.length)} currencies. ` +
        'A charge settles in one, so attributing a share of it needs somebody to say which.',
    });
    return 0;
  }

  const fee = fees[0];
  if (!fee) return 0;
  const feeCurrency = fee.currency as CurrencyCode;
  const feeMinor = Number(fee.totalMinor);
  if (feeMinor <= 0) return 0;
  record({
    kind: 'stripe_processing_fee',
    reference: `${payment.id}:processor_expense`,
    amount: { amount: feeMinor, currency: feeCurrency },
    observedAt: payment.updatedAt,
  });

  const weights = await listCheckoutGroupOrderWeights(order.checkoutGroupId, db);
  const shares = apportion({
    totalMinor: BigInt(feeMinor),
    weights: weights.map((entry) => BigInt(entry.weightMinor)),
  });
  const index = weights.findIndex((entry) => entry.orderId === order.id);
  const shareMinor = index >= 0 ? Number(shares[index] ?? 0n) : feeMinor;
  if (shareMinor === 0) return 0;

  if (feeCurrency === accountingCurrency) {
    add('provider_processing_cost', {
      sourceMinor: shareMinor,
      sourceCurrency: feeCurrency,
      accountingMinor: shareMinor,
    });
    return shareMinor;
  }

  // The payment's OWN captured presentment→platform rate, inverted. It is the
  // rate this charge actually settled at, stored on the row at charge time —
  // the only historical rate that relates these two currencies for this order.
  if (
    payment.platformRateFrom !== accountingCurrency ||
    payment.platformRateTo !== feeCurrency ||
    !payment.platformRateRate ||
    payment.platformRateRate <= 0
  ) {
    blocked.push({
      kind: 'currency_unconvertible',
      detail:
        `The provider fee on payment ${payment.id} is in ${feeCurrency} and this order is ` +
        `accounted in ${accountingCurrency}, and the payment recorded no conversion between ` +
        'them. Converting at today’s rate would revalue what the charge actually cost.',
    });
    return 0;
  }
  const rate = 1 / payment.platformRateRate;
  const accountingMinor = roundMinorUnits(shareMinor * rate);
  add('provider_processing_cost', {
    sourceMinor: shareMinor,
    sourceCurrency: feeCurrency,
    accountingMinor,
    fxSnapshot: {
      from: feeCurrency,
      to: accountingCurrency,
      rate,
      provider: payment.platformRateProvider ?? 'payment',
      asOf: payment.platformRateAsOf ?? payment.createdAt.toISOString(),
    },
  });
  return accountingMinor;
}
