/**
 * The procurement schema's load-bearing constraints, against a REAL Postgres
 * database — the properties a mocked repository is structurally blind to:
 *
 *  - supplier identity: one Mercaria row per (provider, environment, platform
 *    account), and a credential column that cannot hold a pasted secret;
 *  - agreement versioning: one row per (supplier, version), and an approval
 *    the CHECK refuses when its record is incomplete;
 *  - EXACTLY ONE purchase order under concurrent duplicate creation (#118
 *    acceptance criterion 4) — two claims on one idempotency key, one row;
 *  - the transition CAS: two concurrent supplier answers, one winner, one
 *    transition row;
 *  - the hand-written triggers: lines immutable from birth, identity columns
 *    immutable forever, money/destination frozen after `draft` (#118
 *    consistency rules 6 and 7).
 *
 * No cleanup and no TRUNCATE — vitest runs files in parallel against ONE
 * throwaway database, so every id here is unique per run instead.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../postgres.js';
import {
  purchaseOrderLines,
  purchaseOrders,
  supplierAgreements,
  suppliers,
} from '../../schema/procurement.js';
import {
  createSupplier,
  mergeSuppliers,
} from '../supplierRepository.js';
import {
  createSupplierAccount,
  type SupplierAccountRecord,
} from '../supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
  findActiveAgreementsForSupplier,
  type SupplierAgreementRecord,
} from '../agreementRepository.js';
import {
  createPurchaseOrder,
  findPurchaseOrderLines,
  findPurchaseOrderTransitions,
  transitionPurchaseOrder,
  type NewPurchaseOrder,
} from '../purchaseOrderRepository.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * Assert a write is refused by the named CLASS of constraint — the
 * `schema.realdb.test.ts` helper, because "it threw" alone would also pass
 * when the WRONG constraint fired.
 */
async function expectRefused(write: () => Promise<unknown>, kind: 'check' | 'unique'): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  const matched = kind === 'check' ? isCheckViolation(caught) : isUniqueViolation(caught);
  expect(matched, `expected a ${kind} violation, got: ${String(caught)}`).toBe(true);
}

/** A supplier fixture, unique per call. */
async function makeSupplier() {
  return await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Supplier ${uuidv7()}`,
    establishmentCountries: ['ES'],
    fulfilmentOriginCountries: ['ES'],
  });
}

/** An account fixture on that supplier. */
async function makeAccount(
  supplierId: string,
  overrides: Partial<Parameters<typeof createSupplierAccount>[0]> = {},
): Promise<SupplierAccountRecord> {
  return await createSupplierAccount({
    supplierId,
    provider: 'test-platform',
    environment: 'test',
    providerAccountId: `acct-${uuidv7()}`,
    credentialReference: `/oxy/mercaria/suppliers/test/${uuidv7()}`,
    enabledMarkets: ['ES'],
    fulfilmentOrigins: ['ES'],
    ...overrides,
  });
}

/** An APPROVED agreement fixture with full retail-dropship rights. */
async function makeApprovedAgreement(supplierId: string): Promise<SupplierAgreementRecord> {
  const draft = await createAgreementVersion({
    supplierId,
    version: 1,
    permittedDestinationCountries: ['ES', 'FR'],
    permittedChannels: ['mercaria_marketplace'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
  });
  const approved = await approveAgreement({
    agreementId: draft.id,
    reviewedByOxyUserId: 'oxy-reviewer',
    approvedByOxyUserId: 'oxy-approver',
    evidenceLocation: 'vault://agreements/test.pdf',
    effectiveAt: new Date(Date.now() - 86_400_000),
  });
  if (!approved) throw new Error('fixture agreement did not approve');
  return approved;
}

/** A whole PO input, ready to claim. */
function purchaseOrderInput(
  ids: { supplierId: string; supplierAccountId: string; agreementId: string },
  overrides: Partial<NewPurchaseOrder> = {},
): NewPurchaseOrder {
  return {
    ...ids,
    orderId: `order-${uuidv7()}`,
    idempotencyKey: `po:${uuidv7()}`,
    currency: 'EUR',
    itemsAmount: 5_000,
    shippingAmount: 500,
    totalAmount: 5_500,
    destination: {
      recipientName: 'Buyer',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
    lines: [
      {
        supplierSku: 'SKU-1',
        quantity: 2,
        unitCostAmount: 2_500,
        lineTotalAmount: 5_000,
      },
    ],
    ...overrides,
  };
}

describe('supplier identity', () => {
  it('refuses a second Mercaria row for one platform account — whoever claims it', async () => {
    const supplierA = await makeSupplier();
    const supplierB = await makeSupplier();
    const platformAccountId = `acct-${uuidv7()}`;
    await makeAccount(supplierA.id, { providerAccountId: platformAccountId });
    await expectRefused(
      () => makeAccount(supplierB.id, { providerAccountId: platformAccountId }),
      'unique',
    );
  });

  it('refuses a pasted secret in credential_reference — the column holds PATHS', async () => {
    const supplier = await makeSupplier();
    await expectRefused(
      () => makeAccount(supplier.id, { credentialReference: 'sk_live_51Habc123SECRET' }),
      'check',
    );
  });

  it('refuses a merged tombstone that names no winner', async () => {
    const supplier = await makeSupplier();
    await expectRefused(
      () => db.update(suppliers).set({ status: 'merged' }).where(eq(suppliers.id, supplier.id)),
      'check',
    );
  });
});

describe('agreement versions', () => {
  it('one row per (supplier, version)', async () => {
    const supplier = await makeSupplier();
    await createAgreementVersion({ supplierId: supplier.id, version: 1 });
    await expectRefused(() => createAgreementVersion({ supplierId: supplier.id, version: 1 }), 'unique');
  });

  it('refuses an approval whose record is incomplete — the CHECK, not the service', async () => {
    const supplier = await makeSupplier();
    const draft = await createAgreementVersion({
      supplierId: supplier.id,
      version: 1,
      // Data-processing terms NOT accepted: ADR 0004 D2.7 makes them mandatory
      // in every supply agreement, so the approved CHECK requires the flag.
      dataProcessingTermsAccepted: false,
    });
    await expectRefused(
      () =>
        db
          .update(supplierAgreements)
          .set({
            approvalState: 'approved',
            approvedAt: new Date(),
            approvedByOxyUserId: 'oxy-approver',
            reviewedByOxyUserId: 'oxy-reviewer',
            evidenceLocation: 'vault://x.pdf',
            effectiveAt: new Date(),
          })
          .where(eq(supplierAgreements.id, draft.id)),
      'check',
    );
  });

  it('resolves a tombstone-signed agreement forward to the merge winner', async () => {
    const loser = await makeSupplier();
    const winner = await makeSupplier();
    await makeApprovedAgreement(loser.id);
    const merged = await mergeSuppliers({ winnerId: winner.id, loserId: loser.id });
    expect(merged?.winnerId).toBe(winner.id);

    const active = await findActiveAgreementsForSupplier(winner.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.supplierId).toBe(loser.id);
  });
});

describe('exactly one purchase order under concurrent retries (#118 acceptance 4)', () => {
  it('two concurrent claims on one idempotency key yield ONE row, ONE line set, ONE birth event', async () => {
    const supplier = await makeSupplier();
    const account = await makeAccount(supplier.id);
    const agreement = await makeApprovedAgreement(supplier.id);
    const input = purchaseOrderInput({
      supplierId: supplier.id,
      supplierAccountId: account.id,
      agreementId: agreement.id,
    });

    const [first, second] = await Promise.all([
      createPurchaseOrder(input),
      createPurchaseOrder(input),
    ]);

    // Both callers hold the SAME purchase order…
    expect(first.purchaseOrder.id).toBe(second.purchaseOrder.id);
    // …and exactly one of them created it.
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);

    // The loser wrote nothing: one line, one birth transition, not two.
    const lines = await findPurchaseOrderLines(first.purchaseOrder.id);
    expect(lines).toHaveLength(1);
    const trail = await findPurchaseOrderTransitions(first.purchaseOrder.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.status).toBe('draft');
  });
});

describe('the transition CAS', () => {
  it('two concurrent supplier answers produce one winner and one transition row', async () => {
    const supplier = await makeSupplier();
    const account = await makeAccount(supplier.id);
    const agreement = await makeApprovedAgreement(supplier.id);
    const { purchaseOrder } = await createPurchaseOrder(
      purchaseOrderInput({
        supplierId: supplier.id,
        supplierAccountId: account.id,
        agreementId: agreement.id,
      }),
    );
    const submitted = await transitionPurchaseOrder({
      purchaseOrderId: purchaseOrder.id,
      expected: 'draft',
      next: 'submitted',
      initiator: 'system',
    });
    expect(submitted?.status).toBe('submitted');

    const [accepted, rejected] = await Promise.all([
      transitionPurchaseOrder({
        purchaseOrderId: purchaseOrder.id,
        expected: 'submitted',
        next: 'accepted',
        initiator: 'supplier',
      }),
      transitionPurchaseOrder({
        purchaseOrderId: purchaseOrder.id,
        expected: 'submitted',
        next: 'rejected',
        initiator: 'supplier',
        reasonCode: 'out_of_stock',
      }),
    ]);

    const winners = [accepted, rejected].filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);

    // The trail records draft, submitted, and ONE answer — the loser appended
    // nothing, because its history row commits with its CAS or not at all.
    const trail = await findPurchaseOrderTransitions(purchaseOrder.id);
    expect(trail).toHaveLength(3);
  });
});

describe('the immutability triggers (#118 consistency rules 6 and 7)', () => {
  async function makeDraftPurchaseOrder() {
    const supplier = await makeSupplier();
    const account = await makeAccount(supplier.id);
    const agreement = await makeApprovedAgreement(supplier.id);
    const { purchaseOrder } = await createPurchaseOrder(
      purchaseOrderInput({
        supplierId: supplier.id,
        supplierAccountId: account.id,
        agreementId: agreement.id,
      }),
    );
    return { supplier, account, agreement, purchaseOrder };
  }

  it('refuses ANY update or delete of a line — the snapshot is the record', async () => {
    const { purchaseOrder } = await makeDraftPurchaseOrder();
    const [line] = await findPurchaseOrderLines(purchaseOrder.id);
    expect(line).toBeDefined();
    if (!line) return;

    await expectRefused(
      () =>
        db.update(purchaseOrderLines).set({ quantity: 99 }).where(eq(purchaseOrderLines.id, line.id)),
      'check',
    );
    await expectRefused(
      () => db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.id)),
      'check',
    );
  });

  it('refuses rewriting WHICH supplier a PO names, even in draft — merges cannot rewrite history', async () => {
    const { purchaseOrder } = await makeDraftPurchaseOrder();
    const otherSupplier = await makeSupplier();
    await expectRefused(
      () =>
        db
          .update(purchaseOrders)
          .set({ supplierId: otherSupplier.id })
          .where(eq(purchaseOrders.id, purchaseOrder.id)),
      'check',
    );
  });

  it('a supplier merge leaves the historical PO naming the tombstone', async () => {
    const { supplier, purchaseOrder } = await makeDraftPurchaseOrder();
    const winner = await makeSupplier();
    const result = await mergeSuppliers({ winnerId: winner.id, loserId: supplier.id });
    expect(result?.repointedAccounts).toBe(1);

    const [po] = await db
      .select({ supplierId: purchaseOrders.supplierId })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, purchaseOrder.id));
    expect(po?.supplierId).toBe(supplier.id);

    const [tombstone] = await db
      .select({ status: suppliers.status, mergedIntoId: suppliers.mergedIntoId })
      .from(suppliers)
      .where(eq(suppliers.id, supplier.id));
    expect(tombstone).toEqual({ status: 'merged', mergedIntoId: winner.id });
  });

  it('allows re-quoting a DRAFT and freezes the money the moment it submits', async () => {
    const { purchaseOrder } = await makeDraftPurchaseOrder();

    // A draft may still be re-quoted.
    await db
      .update(purchaseOrders)
      .set({ itemsAmount: 6_000, totalAmount: 6_500 })
      .where(eq(purchaseOrders.id, purchaseOrder.id));

    const submitted = await transitionPurchaseOrder({
      purchaseOrderId: purchaseOrder.id,
      expected: 'draft',
      next: 'submitted',
      initiator: 'system',
    });
    expect(submitted?.status).toBe('submitted');

    // From here the cost snapshot is frozen…
    await expectRefused(
      () =>
        db.update(purchaseOrders).set({ itemsAmount: 1 }).where(eq(purchaseOrders.id, purchaseOrder.id)),
      'check',
    );
    // …and so is the destination snapshot.
    await expectRefused(
      () =>
        db
          .update(purchaseOrders)
          .set({ destinationLine1: 'Somewhere else 2' })
          .where(eq(purchaseOrders.id, purchaseOrder.id)),
      'check',
    );

    // Non-frozen operational columns still move — the freeze is surgical, not
    // a lock on the row.
    const [updated] = await db
      .update(purchaseOrders)
      .set({ operatorNote: 'looked at it' })
      .where(eq(purchaseOrders.id, purchaseOrder.id))
      .returning({ operatorNote: purchaseOrders.operatorNote });
    expect(updated?.operatorNote).toBe('looked at it');
  });

  it('the frozen columns really are the ones the docblock claims — fx too', async () => {
    const { purchaseOrder } = await makeDraftPurchaseOrder();
    await transitionPurchaseOrder({
      purchaseOrderId: purchaseOrder.id,
      expected: 'draft',
      next: 'submitted',
      initiator: 'system',
    });
    await expectRefused(
      () =>
        db
          .update(purchaseOrders)
          .set({
            fxRateFrom: 'EUR',
            fxRateTo: 'FAIR',
            fxRateRate: 2,
            fxRateProvider: 'test',
            fxRateAsOf: new Date().toISOString(),
          })
          .where(eq(purchaseOrders.id, purchaseOrder.id)),
      'check',
    );
  });
});

describe('vacuity guard', () => {
  it('the triggers exist in the catalogue — a dropped migration line cannot pass silently', async () => {
    const rows = await db.execute(
      sql`select tgname from pg_trigger
          where tgname in ('purchase_order_lines_immutable', 'purchase_orders_frozen')`,
    );
    expect(rows.length).toBe(2);
  });
});
