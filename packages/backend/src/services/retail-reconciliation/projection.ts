/**
 * The operator reconciliation view and the ten metrics (#128 "Operator surface"
 * and "Metrics").
 *
 * ## This is a different TYPE from anything a buyer or a merchant sees
 *
 * `RetailReconciliationView` carries the supplier's invoice by component and the
 * final wholesale cost, so a serializer that handed it to a public surface would
 * be handing over the cost of goods. It is a distinct type rather than a
 * filtered one — the `MerchantOrder` device — and it is only reachable behind
 * the procurement operator allow-list.
 *
 * ## Finality is DERIVED here, and has no column
 *
 * ADR 0004 D8.6 defines it as the LATEST of three live conditions, bounded at
 * 180 days after delivery. A stored `finalised_at` beside those conditions would
 * be the second representation of one fact that `deriveNativeCheckoutEligibility`
 * is the precedent against, and the place they must not disagree is the decision
 * to stop owing a buyer money.
 *
 * ## The metric list has no margin key, and that is enforced rather than
 * remembered
 *
 * `RETAIL_RECONCILIATION_METRIC_KEYS` is the complete set the surface serves,
 * and #128 says in words that gross margin and profit may not be published as
 * target metrics for `mercaria_retail`. A key that is not in the tuple 404s, so
 * a margin figure has no key to be served under — and
 * `RETAIL_RECONCILIATION_FORBIDDEN_DTO_FIELDS` is walked at RUNTIME over a real
 * emitted view, because a static scan sees the fields somebody wrote and the
 * walk sees the fields the code actually produced.
 */

import type {
  CurrencyCode,
  RetailAccountingComponent,
  RetailCustomerAdjustmentView,
  RetailReconciliationComponentView,
  RetailReconciliationEvidenceView,
  RetailReconciliationExceptionView,
  RetailReconciliationMetricKey,
  RetailReconciliationView,
  RetailSupplierCreditView,
} from '@mercaria/shared-types';
import { RETAIL_COMPONENT_ROLES } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  countAdjustmentOutcomesSince,
  listAdjustmentsForOrder,
  type RetailCustomerAdjustmentRow,
} from '../../db/retailReconciliation/adjustmentRepository.js';
import {
  countOpenExceptionsByKind,
  listReconciliationExceptionsForOrder,
  type RetailReconciliationExceptionRow,
} from '../../db/retailReconciliation/exceptionRepository.js';
import {
  findLatestReconciliation,
  listReconciliationComponents,
  listReconciliationEvidence,
  listReconciliationsSince,
  sumReconciliationComponent,
  type RetailReconciliationComponentRow,
  type RetailReconciliationEvidenceRow,
} from '../../db/retailReconciliation/reconciliationRepository.js';
import {
  listSupplierCreditsForOrder,
  listSupplierCreditsRecordedSince,
  type RetailSupplierCreditRow,
} from '../../db/retailReconciliation/supplierCreditRepository.js';
import { findReconcilableOrder } from '../../db/retailReconciliation/evidenceSourceRepository.js';
import { findActiveRetailReconciliationPolicy } from '../../db/retailReconciliation/policyRepository.js';
import { RETAIL_RECONCILIATION_POLICY_KEY } from './policy-key.js';

/** The whole reconciliation view for one order, or `undefined` when it has none. */
export async function readRetailReconciliationView(
  orderId: string,
): Promise<RetailReconciliationView | undefined> {
  const db = getDb();
  const latest = await findLatestReconciliation(orderId, db);
  if (!latest) return undefined;

  const [components, evidence, credits, adjustments, exceptions, order, active] = await Promise.all(
    [
      listReconciliationComponents(latest.id, db),
      listReconciliationEvidence(latest.id, db),
      listSupplierCreditsForOrder(orderId, db),
      listAdjustmentsForOrder(orderId, db),
      listReconciliationExceptionsForOrder(orderId, db),
      findReconcilableOrder(orderId, db),
      findActiveRetailReconciliationPolicy(RETAIL_RECONCILIATION_POLICY_KEY, db),
    ],
  );

  const live = adjustments.find((row) => row.supersededById === null);
  const finalisedAt = deriveFinality({
    deliveredAt: order?.deliveredAt ?? null,
    ceilingDays: active?.policy.finalityCeilingDays ?? null,
    openExceptions: exceptions.filter((row) => row.resolvedAt === null).length,
    openAdjustment: live !== undefined && live.state !== 'refund_settled',
  });

  return {
    orderId,
    revision: latest.revision,
    policyKey: latest.policyKey,
    policyVersion: latest.policyVersion,
    completeness: latest.completeness,
    ...(latest.outcome ? { outcome: latest.outcome } : {}),
    accountingCurrency: latest.accountingCurrency,
    customerAmountBeforeSubsidy: {
      amount: latest.customerAmountBeforeSubsidyMinor,
      currency: latest.accountingCurrency,
    },
    finalAttributableCost: {
      amount: latest.finalAttributableCostMinor,
      currency: latest.accountingCurrency,
    },
    costVarianceMinor: latest.costVarianceMinor,
    toleranceMinor: latest.toleranceMinor,
    components: components.map(projectComponent),
    evidence: evidence.map(projectEvidence),
    supplierCredits: credits.map(projectCredit),
    ...(live ? { adjustment: projectAdjustment(live) } : {}),
    exceptions: exceptions.map(projectException),
    computedAt: latest.computedAt.toISOString(),
    ...(finalisedAt ? { finalisedAt } : {}),
  };
}

/**
 * ADR 0004 D8.6's finality point, derived.
 *
 * The latest of: the supplier invoice reconciled (no blocking exception is
 * open), the customer side settled (no adjustment is still owed), and the
 * 180-day ceiling measured from DELIVERY. An order that has not been delivered
 * has no clock to measure from and is therefore never final, which is right:
 * the return window has not started.
 *
 * `undefined` means "not final yet" and is deliberately not a date in the
 * future — a projected finality would be read as a promise, and every one of
 * its three conditions can move.
 */
function deriveFinality(input: {
  deliveredAt: Date | null;
  ceilingDays: number | null;
  openExceptions: number;
  openAdjustment: boolean;
}): string | undefined {
  if (!input.deliveredAt || input.ceilingDays === null) return undefined;
  if (input.openExceptions > 0 || input.openAdjustment) return undefined;
  const ceiling = new Date(
    input.deliveredAt.getTime() + input.ceilingDays * 24 * 60 * 60 * 1_000,
  );
  return ceiling.getTime() <= Date.now() ? ceiling.toISOString() : undefined;
}

function projectComponent(
  row: RetailReconciliationComponentRow,
): RetailReconciliationComponentView {
  const component = row.component as RetailAccountingComponent;
  return {
    component,
    role: RETAIL_COMPONENT_ROLES[component],
    sourceAmount: { amount: row.sourceAmount, currency: row.sourceCurrency },
    accountingAmount: { amount: row.accountingAmount, currency: row.accountingCurrency },
    ...(row.fxRateFrom && row.fxRateTo && row.fxRateRate !== null
      ? {
          fxSnapshot: {
            from: row.fxRateFrom,
            to: row.fxRateTo,
            rate: row.fxRateRate,
            provider: row.fxRateProvider ?? 'stored',
            asOf: row.fxRateAsOf ?? '',
          },
        }
      : {}),
    evidenceCount: row.evidenceCount,
  };
}

function projectEvidence(row: RetailReconciliationEvidenceRow): RetailReconciliationEvidenceView {
  return {
    kind: row.kind,
    reference: row.reference,
    observedAt: row.observedAt.toISOString(),
    ...(row.evidenceAmount !== null && row.evidenceCurrency !== null
      ? { amount: { amount: row.evidenceAmount, currency: row.evidenceCurrency } }
      : {}),
  };
}

function projectCredit(row: RetailSupplierCreditRow): RetailSupplierCreditView {
  return {
    id: row.id,
    classification: row.classification,
    purchaseOrderId: row.purchaseOrderId,
    ...(row.supplierInvoiceReference
      ? { supplierInvoiceReference: row.supplierInvoiceReference }
      : {}),
    ...(row.orderId ? { orderId: row.orderId } : {}),
    amount: { amount: row.creditAmount, currency: row.creditCurrency },
    accountingAmount: { amount: row.accountingAmount, currency: row.accountingCurrency },
    issuedAt: row.issuedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    ...(row.ledgerTransactionId ? { ledgerTransactionId: row.ledgerTransactionId } : {}),
  };
}

function projectAdjustment(row: RetailCustomerAdjustmentRow): RetailCustomerAdjustmentView {
  return {
    id: row.id,
    orderId: row.orderId,
    reconciliationRevision: row.reconciliationRevision,
    amount: { amount: row.adjustmentAmount, currency: row.adjustmentCurrency },
    method: row.method,
    state: row.state,
    ...(row.blockReason ? { blockReason: row.blockReason } : {}),
    ...(row.nonRefundableProviderCostAmount !== null &&
    row.nonRefundableProviderCostCurrency !== null
      ? {
          nonRefundableProviderCost: {
            amount: row.nonRefundableProviderCostAmount,
            currency: row.nonRefundableProviderCostCurrency,
          },
        }
      : {}),
    ...(row.refundId ? { refundId: row.refundId } : {}),
    ...(row.notifiedAt ? { notifiedAt: row.notifiedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectException(
  row: RetailReconciliationExceptionRow,
): RetailReconciliationExceptionView {
  return {
    id: row.id,
    kind: row.kind,
    orderId: row.orderId,
    detail: row.detail,
    raisedAt: row.raisedAt.toISOString(),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
    ...(row.resolvedByOxyUserId ? { resolvedByOxyUserId: row.resolvedByOxyUserId } : {}),
    ...(row.resolutionReason ? { resolutionReason: row.resolutionReason } : {}),
  };
}

/** One metric, with the definition that makes its number readable. */
export interface RetailReconciliationMetric {
  key: RetailReconciliationMetricKey;
  /** What the number counts. Never a rate without its denominator stated. */
  definition: string;
  value: number;
  /** Present on the money metrics, absent on the counts. */
  currency?: CurrencyCode;
  /** How many orders or records the figure was measured over. */
  sampleSize: number;
}

/**
 * The ten metrics, over one window.
 *
 * Every one carries its DEFINITION beside the number — #77's rule that a metric
 * whose definition is unstated cannot be stored applies just as well to one that
 * is served, and a bare integer labelled `quote_to_invoice_variance` is
 * unreadable.
 *
 * The absences are the list: there is no gross margin, no profit and no take
 * rate, because #128 says outright that they may not be published as target
 * metrics for a channel whose expected margin is zero. The tuple is what makes
 * that a value a test can run rather than a paragraph.
 */
export async function readRetailReconciliationMetrics(input: {
  since: Date;
  limit?: number;
}): Promise<RetailReconciliationMetric[]> {
  const db = getDb();
  const limit = input.limit ?? 1_000;
  const [revisions, credits, openExceptions, adjustmentOutcomes] = await Promise.all([
    listReconciliationsSince({ since: input.since, limit }, db),
    listSupplierCreditsRecordedSince({ since: input.since, limit }, db),
    countOpenExceptionsByKind(db),
    countAdjustmentOutcomesSince({ since: input.since }, db),
  ]);

  const complete = revisions.filter((row) => row.completeness === 'complete');
  const subsidyMinor = await sumReconciliationComponent(
    { reconciliationIds: complete.map((row) => row.id), component: 'mercaria_promotion_subsidy' },
    db,
  );
  const exact = complete.filter((row) => row.outcome === 'cost_recovered_exactly');
  const positive = complete.filter((row) => row.outcome === 'customer_adjustment_required');
  const absorbed = complete.filter((row) => row.outcome === 'mercaria_absorbed');
  const currency = revisions[0]?.accountingCurrency;

  const missingEvidence = openExceptions
    .filter((entry) => entry.kind.startsWith('missing_') || entry.kind === 'unlinked_supplier_credit')
    .reduce((total, entry) => total + entry.open, 0);
  const duplicates = openExceptions
    .filter((entry) => entry.kind.startsWith('duplicate_'))
    .reduce((total, entry) => total + entry.open, 0);

  // Absolute variance as a share of the customer amount, in basis points, over
  // the completed revisions — #128's metric 4. A share and not an absolute,
  // because "€3 out on a €5 order" and "€3 out on a €900 one" are different
  // facts about a cost model and an absolute figure cannot tell them apart.
  const varianceBps = complete.length
    ? Math.round(
        complete.reduce((total, row) => {
          const base = row.customerAmountBeforeSubsidyMinor;
          if (base <= 0) return total;
          return total + (Math.abs(row.costVarianceMinor) * 10_000) / base;
        }, 0) / complete.length,
      )
    : 0;

  const creditLatencyHours = credits.length
    ? Math.round(
        credits.reduce(
          (total, credit) =>
            total + (credit.recordedAt.getTime() - credit.issuedAt.getTime()) / 3_600_000,
          0,
        ) / credits.length,
      )
    : 0;

  return [
    metric('orders_reconciled_exactly', exact.length, complete.length,
      'Completed revisions whose customer amount before subsidy equalled the final attributable cost EXACTLY. Rounded-off orders are counted under the tolerance and not here.'),
    metric('positive_adjustment_variance', sumVariance(positive), positive.length,
      'Total surplus owed back to buyers across completed revisions with a material positive variance, in the accounting currency’s minor units.', currency),
    metric('negative_absorbed_variance', Math.abs(sumVariance(absorbed)), absorbed.length,
      'Total shortfall Mercaria absorbed across completed revisions with a material negative variance, in minor units. Never recharged to a buyer.', currency),
    metric('quote_to_invoice_variance', varianceBps, complete.length,
      'Mean ABSOLUTE cost variance as basis points of the customer amount, over completed revisions. A share rather than an amount, so a small order and a large one are comparable.'),
    metric('supplier_credit_latency', creditLatencyHours, credits.length,
      'Mean hours between a supplier ISSUING a credit note and Mercaria recording it, over the window.'),
    metric('missing_evidence', missingEvidence, revisions.length,
      'Open exceptions whose condition is an absent invoice, fee, tax determination, quote, refund record or unlinked credit. Each one is a term of the equation with no evidence behind it.'),
    metric('duplicate_charge_or_credit', duplicates, revisions.length,
      'Open exceptions reporting a purchase order with two invoices, or a refund or credit counted more than once.'),
    metric('adjustment_refund_success', adjustmentOutcomes.settled, adjustmentOutcomes.created,
      'Customer adjustments created in the window whose refund has SETTLED, against how many were created. `refund_committed` is deliberately not counted: it is a promise the rail has not kept yet, and a gap between the two is money owed and not yet moved.'),
    metric('cost_quote_accuracy_percentile', percentile95(complete), complete.length,
      'The 95th percentile of absolute cost variance in basis points of the customer amount. The tail is the number that matters: a mean hides the orders whose cost model was wrong.'),
    metric('mercaria_subsidy_spend', subsidyMinor, complete.length,
      'Total Mercaria-funded promotion subsidy on reconciled retail orders, in minor units, summed from the promotion component of each completed revision. A marketing expense — it is why the equation’s customer term is the amount BEFORE subsidy.', currency),
  ];
}

function metric(
  key: RetailReconciliationMetricKey,
  value: number,
  sampleSize: number,
  definition: string,
  currency?: CurrencyCode,
): RetailReconciliationMetric {
  return { key, value, sampleSize, definition, ...(currency ? { currency } : {}) };
}

function sumVariance(rows: readonly { costVarianceMinor: number }[]): number {
  return rows.reduce((total, row) => total + row.costVarianceMinor, 0);
}

/** The 95th percentile of absolute variance, in basis points of the customer amount. */
function percentile95(
  rows: readonly { costVarianceMinor: number; customerAmountBeforeSubsidyMinor: number }[],
): number {
  const points = rows
    .filter((row) => row.customerAmountBeforeSubsidyMinor > 0)
    .map((row) =>
      Math.round((Math.abs(row.costVarianceMinor) * 10_000) / row.customerAmountBeforeSubsidyMinor),
    )
    .sort((a, b) => a - b);
  if (points.length === 0) return 0;
  const index = Math.min(points.length - 1, Math.ceil(points.length * 0.95) - 1);
  return points[Math.max(0, index)] ?? 0;
}
