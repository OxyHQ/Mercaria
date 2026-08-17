/**
 * The reconciliation revision, its components and its evidence (#128).
 *
 * ONE repository for the three, because they are one immutable record written
 * in one transaction rather than three lifecycles: a revision with no components
 * is a verdict with no arithmetic behind it, and a component with no revision is
 * a figure about nothing.
 *
 * All three tables are append-only by TRIGGER. There is deliberately no update
 * function in this file and no delete — a correction is a new REVISION, exactly
 * as a ledger correction is a new reversing transaction.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  FxRateSnapshot,
  RetailAccountingComponent,
  RetailReconciliationCompleteness,
  RetailReconciliationEvidenceKind,
  RetailReconciliationOutcome,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  retailReconciliationComponents,
  retailReconciliationEvidence,
  retailReconciliations,
} from '../schema/retailReconciliation.js';

/** One evaluation of the equation for one order. */
export type RetailReconciliationRow = typeof retailReconciliations.$inferSelect;
/** One of the twelve components of one revision. */
export type RetailReconciliationComponentRow =
  typeof retailReconciliationComponents.$inferSelect;
/** One authoritative record a revision consumed. */
export type RetailReconciliationEvidenceRow = typeof retailReconciliationEvidence.$inferSelect;

/** One component, ready to be written. */
export interface NewReconciliationComponent {
  component: RetailAccountingComponent;
  source: { amount: number; currency: CurrencyCode };
  accounting: { amount: number; currency: CurrencyCode };
  /** Present exactly when the two currencies differ — a CHECK, both directions. */
  fxSnapshot?: FxRateSnapshot;
  evidenceCount: number;
}

/** One evidence record, ready to be written. */
export interface NewReconciliationEvidence {
  kind: RetailReconciliationEvidenceKind;
  reference: string;
  amount?: { amount: number; currency: CurrencyCode };
  observedAt: Date;
}

/** Everything one revision asserts. */
export interface NewReconciliation {
  orderId: string;
  revision: number;
  policyId: string;
  policyKey: string;
  policyVersion: number;
  completeness: RetailReconciliationCompleteness;
  outcome?: RetailReconciliationOutcome;
  accountingCurrency: CurrencyCode;
  customerAmountBeforeSubsidyMinor: number;
  finalAttributableCostMinor: number;
  costVarianceMinor: number;
  toleranceMinor: number;
  evidenceDigest: string;
  computedAt: Date;
  components: readonly NewReconciliationComponent[];
  evidence: readonly NewReconciliationEvidence[];
}

/** The five `fx_rate_*` columns, or five NULLs. Never a partial snapshot. */
function fxColumns(snapshot: FxRateSnapshot | undefined) {
  if (!snapshot) {
    return {
      fxRateFrom: null,
      fxRateTo: null,
      fxRateRate: null,
      fxRateProvider: null,
      fxRateAsOf: null,
    };
  }
  return {
    fxRateFrom: snapshot.from,
    fxRateTo: snapshot.to,
    fxRateRate: snapshot.rate,
    fxRateProvider: snapshot.provider,
    fxRateAsOf: snapshot.asOf,
  };
}

/**
 * Write one revision with its components and evidence, atomically.
 *
 * Takes the caller's handle and is normally given a real transaction, because
 * the revision, its components, its evidence, any exception it raises, the
 * adjustment it may create and the ledger posting that recognizes it all commit
 * together. Half a reconciliation is not a state: a revision whose components
 * failed to write is a verdict nobody can reproduce, and an adjustment whose
 * revision failed to write is an obligation with no justification.
 */
export async function insertReconciliation(
  input: NewReconciliation,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationRow> {
  const id = uuidv7();
  const [row] = await db
    .insert(retailReconciliations)
    .values({
      id,
      orderId: input.orderId,
      revision: input.revision,
      policyId: input.policyId,
      policyKey: input.policyKey,
      policyVersion: input.policyVersion,
      completeness: input.completeness,
      ...(input.outcome ? { outcome: input.outcome } : {}),
      accountingCurrency: input.accountingCurrency,
      customerAmountBeforeSubsidyMinor: input.customerAmountBeforeSubsidyMinor,
      finalAttributableCostMinor: input.finalAttributableCostMinor,
      costVarianceMinor: input.costVarianceMinor,
      toleranceMinor: input.toleranceMinor,
      evidenceDigest: input.evidenceDigest,
      computedAt: input.computedAt,
    })
    .returning();
  if (!row) throw new Error('The reconciliation insert returned no row.');

  if (input.components.length > 0) {
    await db.insert(retailReconciliationComponents).values(
      input.components.map((component) => ({
        id: uuidv7(),
        reconciliationId: id,
        component: component.component,
        sourceAmount: component.source.amount,
        sourceCurrency: component.source.currency,
        accountingAmount: component.accounting.amount,
        accountingCurrency: component.accounting.currency,
        evidenceCount: component.evidenceCount,
        ...fxColumns(component.fxSnapshot),
      })),
    );
  }

  if (input.evidence.length > 0) {
    await db.insert(retailReconciliationEvidence).values(
      input.evidence.map((evidence) => ({
        id: uuidv7(),
        reconciliationId: id,
        kind: evidence.kind,
        reference: evidence.reference,
        evidenceAmount: evidence.amount?.amount ?? null,
        evidenceCurrency: evidence.amount?.currency ?? null,
        observedAt: evidence.observedAt,
      })),
    );
  }

  return row;
}

/** The newest revision for one order, or `undefined` when it has never been reconciled. */
export async function findLatestReconciliation(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationRow | undefined> {
  const [row] = await db
    .select()
    .from(retailReconciliations)
    .where(eq(retailReconciliations.orderId, orderId))
    .orderBy(desc(retailReconciliations.revision))
    .limit(1);
  return row;
}

/** One revision by id. */
export async function findReconciliationById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationRow | undefined> {
  const [row] = await db
    .select()
    .from(retailReconciliations)
    .where(eq(retailReconciliations.id, id))
    .limit(1);
  return row;
}

/** Every component of one revision, in the twelve's own order. */
export async function listReconciliationComponents(
  reconciliationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationComponentRow[]> {
  return db
    .select()
    .from(retailReconciliationComponents)
    .where(eq(retailReconciliationComponents.reconciliationId, reconciliationId));
}

/** Every evidence record of one revision — the correlation trail. */
export async function listReconciliationEvidence(
  reconciliationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationEvidenceRow[]> {
  return db
    .select()
    .from(retailReconciliationEvidence)
    .where(eq(retailReconciliationEvidence.reconciliationId, reconciliationId));
}

/**
 * The next page of retail orders to reconcile, by id, resumable from a cursor.
 *
 * Keyset on the ORDER id and nothing else. A cursor on `updated_at` would skip
 * an order whose evidence changed while the page was in flight, and one on a
 * revision count would re-read every order that has never been reconciled
 * forever.
 *
 * `commercial_role = 'mercaria_retail'` is stated here and not left to the
 * caller: every other order in this database has a seller who was transferred
 * their money, and reconciling one against a supplier invoice it does not have
 * would raise a missing-evidence exception on every marketplace sale.
 */
export async function listRetailOrdersToReconcile(
  input: { afterOrderId?: string; limit: number; paidSince?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ id: string }[]> {
  const conditions = [sql`o.commercial_role = 'mercaria_retail'`, sql`o.payment_status = 'paid'`];
  if (input.afterOrderId) conditions.push(sql`o.id > ${input.afterOrderId}`);
  if (input.paidSince) {
    conditions.push(sql`o.paid_at >= ${input.paidSince.toISOString()}::timestamptz`);
  }

  const rows = await db.execute<{ id: string }>(sql`
    select o.id
    from orders o
    where ${sql.join(conditions, sql` and `)}
    order by o.id
    limit ${input.limit}
  `);
  return [...rows];
}

/**
 * The absorbed-variance revisions for one supplier inside a window — the input
 * to #128's recurring-variance feedback.
 *
 * Joined through the procurement INTENT rather than through the purchase order,
 * because an order whose procurement never happened has no purchase order and is
 * exactly the case a recurring-variance measure must see.
 */
export async function countRecentAbsorbedVariance(
  input: { supplierId: string; since: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ orders: number; totalMinor: number }> {
  const rows = await db.execute<{ orders: string; total: string | null }>(sql`
    select count(distinct r.order_id) as orders,
           coalesce(sum(-r.cost_variance_minor), 0) as total
    from retail_reconciliations r
    join retail_procurement_intents i on i.order_id = r.order_id
    where i.supplier_id = ${input.supplierId}
      and r.outcome = 'mercaria_absorbed'
      and r.computed_at >= ${input.since.toISOString()}::timestamptz
      and r.revision = (
        select max(r2.revision) from retail_reconciliations r2 where r2.order_id = r.order_id
      )
  `);
  const row = [...rows][0];
  // `count()` and `sum()` come back from postgres.js as STRINGS — reading either
  // as a number would silently lose precision on the one figure a stop threshold
  // is compared against.
  return {
    orders: row ? Number(row.orders) : 0,
    totalMinor: row?.total ? Number(row.total) : 0,
  };
}

/** Every revision naming one of a set of orders — the metrics reader's page. */
export async function listLatestReconciliationsForOrders(
  orderIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await db
    .select()
    .from(retailReconciliations)
    .where(inArray(retailReconciliations.orderId, [...orderIds]))
    .orderBy(desc(retailReconciliations.revision));
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.orderId)) return false;
    seen.add(row.orderId);
    return true;
  });
}

/** Every revision computed since an instant — the metrics window. */
export async function listReconciliationsSince(
  input: { since: Date; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailReconciliationRow[]> {
  return db
    .select()
    .from(retailReconciliations)
    .where(
      and(
        gte(retailReconciliations.computedAt, input.since),
        // The newest revision of each order only: an order reconciled four times
        // is one order, and counting every revision would report a metric that
        // grows with how often the sweep ran.
        sql`${retailReconciliations.revision} = (
          select max(r2.revision) from retail_reconciliations r2
          where r2.order_id = ${retailReconciliations.orderId}
        )`,
      ),
    )
    .orderBy(desc(retailReconciliations.computedAt))
    .limit(input.limit);
}

/**
 * The total of one COMPONENT across a set of revisions, in minor units.
 *
 * The metrics surface's only route to a figure that lives on the child table —
 * `mercaria_subsidy_spend` is the sum of the promotion component, and summing it
 * in the service would mean loading every component of every revision in the
 * window to add one of them up.
 */
export async function sumReconciliationComponent(
  input: { reconciliationIds: readonly string[]; component: RetailAccountingComponent },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (input.reconciliationIds.length === 0) return 0;
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${retailReconciliationComponents.accountingAmount}), 0)`,
    })
    .from(retailReconciliationComponents)
    .where(
      and(
        inArray(retailReconciliationComponents.reconciliationId, [...input.reconciliationIds]),
        eq(retailReconciliationComponents.component, input.component),
      ),
    );
  // `sum()` over a bigint column comes back from postgres.js as a STRING; the
  // query builder's `mode: 'number'` is applied by the RESULT MAPPER and does
  // not reach an aggregate expression.
  return Number(rows[0]?.total ?? 0);
}
