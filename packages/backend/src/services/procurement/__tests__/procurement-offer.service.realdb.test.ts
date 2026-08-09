/**
 * Source ingestion against a REAL Postgres database — the properties a mocked
 * repository cannot see:
 *
 *  - the upsert CONVERGES on `(supplier_account_id, supplier_sku)`: a
 *    redelivered feed row refreshes the one offer it already made, keeps
 *    `first_seen_at` and the row id, and moves `last_confirmed_at`;
 *  - one canonical variant sourced from SEVERAL suppliers stays one variant
 *    with several offers (#118 acceptance criterion 1);
 *  - a refresh cannot touch a purchase order's frozen cost snapshot (#118
 *    consistency rule 7) — the line was frozen at creation and the trigger
 *    holds it;
 *  - the cross-record guards refuse a feed writing under another supplier's
 *    identity.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres } from '../../../db/postgres.js';
import {
  createSupplier,
  type SupplierRecord,
} from '../../../db/procurement/supplierRepository.js';
import {
  createSupplierAccount,
  type SupplierAccountRecord,
} from '../../../db/procurement/supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
} from '../../../db/procurement/agreementRepository.js';
import {
  findProcurementOffersByVariant,
  retireProcurementOffer,
  type ProcurementOfferSourceInput,
} from '../../../db/procurement/procurementOfferRepository.js';
import {
  createPurchaseOrder,
  findPurchaseOrderLines,
  transitionPurchaseOrder,
} from '../../../db/procurement/purchaseOrderRepository.js';
import { ingestProcurementOffer } from '../procurement-offer.service.js';
import { createCanonicalProduct } from '../../canonical/canonical-product.service.js';
import { listVariants } from '../../canonical/canonical-variant.service.js';

beforeAll(async () => {
  await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

async function makeSupplierWithAccount(): Promise<{
  supplier: SupplierRecord;
  account: SupplierAccountRecord;
}> {
  const supplier = await createSupplier({
    supplierType: 'wholesaler',
    canonicalName: `Ingest supplier ${uuidv7()}`,
  });
  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: 'test-platform',
    environment: 'test',
    providerAccountId: `acct-${uuidv7()}`,
  });
  return { supplier, account };
}

/**
 * A REAL canonical product and its default variant.
 *
 * These ids used to be fabricated strings, which worked only while
 * `procurement_offers.canonical_product_id` / `.canonical_variant_id` were
 * DEFERRED foreign keys. #56 landed the canonical tables, the
 * `deferredForeignKeys.ts` gate forced both into real RESTRICT references, and
 * the database now — correctly — refuses a mapping to a product that does not
 * exist. That is the ledger working as designed, and the fixture has to mint
 * what it claims to reference.
 */
async function makeCanonicalIdentity(): Promise<{
  canonicalProductId: string;
  canonicalVariantId: string;
}> {
  const product = await createCanonicalProduct({ name: `Ingest product ${uuidv7()}` });
  const [variant] = await listVariants(product.id);
  if (!variant) throw new Error('the default variant is missing');
  return { canonicalProductId: product.id, canonicalVariantId: variant.id };
}

function observation(
  ids: { supplierId: string; supplierAccountId: string },
  overrides: Partial<ProcurementOfferSourceInput> = {},
): ProcurementOfferSourceInput {
  return {
    ...ids,
    supplierSku: `SKU-${uuidv7()}`,
    unitCostAmount: 1_500,
    unitCostCurrency: 'EUR',
    availability: 'in_stock',
    eligibleDestinationCountries: ['es'],
    provenance: 'feed',
    ...overrides,
  };
}

describe('the source upsert converges', () => {
  it('refreshes ONE row in place: same id, same first_seen_at, new terms', async () => {
    const { supplier, account } = await makeSupplierWithAccount();
    const sku = `SKU-${uuidv7()}`;
    const firstObserved = new Date(Date.now() - 3_600_000);

    const first = await ingestProcurementOffer(
      observation(
        { supplierId: supplier.id, supplierAccountId: account.id },
        { supplierSku: sku, unitCostAmount: 1_500, observedAt: firstObserved },
      ),
    );
    expect(first.created).toBe(true);

    const second = await ingestProcurementOffer(
      observation(
        { supplierId: supplier.id, supplierAccountId: account.id },
        { supplierSku: sku, unitCostAmount: 1_800, availability: 'limited' },
      ),
    );
    expect(second.created).toBe(false);

    // The SAME offer — refreshed, not duplicated.
    expect(second.offer.id).toBe(first.offer.id);
    expect(second.offer.unitCostAmount).toBe(1_800);
    expect(second.offer.availability).toBe('limited');
    // First-seen survives the refresh; last-confirmed moves with it.
    expect(second.offer.firstSeenAt.getTime()).toBe(firstObserved.getTime());
    expect(second.offer.lastConfirmedAt.getTime()).toBeGreaterThan(firstObserved.getTime());
    // Destination normalization happened on the way in.
    expect(second.offer.eligibleDestinationCountries).toEqual(['ES']);
  });

  it('a refresh REACTIVATES a retired offer — the source saying "it exists" is one fact', async () => {
    const { supplier, account } = await makeSupplierWithAccount();
    const sku = `SKU-${uuidv7()}`;
    const { offer } = await ingestProcurementOffer(
      observation({ supplierId: supplier.id, supplierAccountId: account.id }, { supplierSku: sku }),
    );
    await retireProcurementOffer(offer.id);

    const refreshed = await ingestProcurementOffer(
      observation({ supplierId: supplier.id, supplierAccountId: account.id }, { supplierSku: sku }),
    );
    expect(refreshed.offer.id).toBe(offer.id);
    expect(refreshed.offer.status).toBe('active');
    expect(refreshed.offer.retiredAt).toBeNull();
  });

  it('a refresh that asserts no mapping leaves the matcher’s mapping alone', async () => {
    const { supplier, account } = await makeSupplierWithAccount();
    const sku = `SKU-${uuidv7()}`;
    const { canonicalProductId, canonicalVariantId } = await makeCanonicalIdentity();
    await ingestProcurementOffer(
      observation(
        { supplierId: supplier.id, supplierAccountId: account.id },
        { supplierSku: sku, canonicalProductId, canonicalVariantId },
      ),
    );

    // The feed knows nothing about canonical identity: no mapping fields.
    const refreshed = await ingestProcurementOffer(
      observation({ supplierId: supplier.id, supplierAccountId: account.id }, { supplierSku: sku }),
    );
    expect(refreshed.offer.canonicalVariantId).toBe(canonicalVariantId);
  });
});

describe('one canonical variant, several suppliers (#118 acceptance 1)', () => {
  it('two suppliers sourcing one variant are two OFFERS, never two products', async () => {
    const a = await makeSupplierWithAccount();
    const b = await makeSupplierWithAccount();
    const { canonicalProductId, canonicalVariantId } = await makeCanonicalIdentity();

    await ingestProcurementOffer(
      observation(
        { supplierId: a.supplier.id, supplierAccountId: a.account.id },
        { canonicalProductId, canonicalVariantId, unitCostAmount: 1_400 },
      ),
    );
    await ingestProcurementOffer(
      observation(
        { supplierId: b.supplier.id, supplierAccountId: b.account.id },
        { canonicalProductId, canonicalVariantId, unitCostAmount: 1_600 },
      ),
    );

    const offers = await findProcurementOffersByVariant(canonicalVariantId);
    expect(offers).toHaveLength(2);
    expect(new Set(offers.map((offer) => offer.supplierId)).size).toBe(2);
    // Both point at the ONE canonical identity — no per-supplier product rows.
    expect(new Set(offers.map((offer) => offer.canonicalProductId))).toEqual(
      new Set([canonicalProductId]),
    );
  });
});

describe('the cross-record guards', () => {
  it('refuses a feed writing under another supplier’s identity', async () => {
    const a = await makeSupplierWithAccount();
    const b = await makeSupplierWithAccount();
    await expect(
      ingestProcurementOffer(
        // Supplier B's id with supplier A's account: the IDOR shape.
        observation({ supplierId: b.supplier.id, supplierAccountId: a.account.id }),
      ),
    ).rejects.toThrow(/supplier\/account mismatch/);
  });
});

describe('source refresh vs the frozen purchase order (#118 consistency rule 7)', () => {
  it('refreshing the offer changes NOTHING on a submitted PO’s line snapshot', async () => {
    const { supplier, account } = await makeSupplierWithAccount();
    const sku = `SKU-${uuidv7()}`;
    const { offer } = await ingestProcurementOffer(
      observation(
        { supplierId: supplier.id, supplierAccountId: account.id },
        { supplierSku: sku, unitCostAmount: 2_000 },
      ),
    );

    const draft = await createAgreementVersion({
      supplierId: supplier.id,
      version: 1,
      dataProcessingTermsAccepted: true,
    });
    const agreement = await approveAgreement({
      agreementId: draft.id,
      reviewedByOxyUserId: 'oxy-reviewer',
      approvedByOxyUserId: 'oxy-approver',
      evidenceLocation: 'vault://x.pdf',
      effectiveAt: new Date(Date.now() - 86_400_000),
    });
    expect(agreement).toBeDefined();
    if (!agreement) return;

    const { purchaseOrder } = await createPurchaseOrder({
      supplierId: supplier.id,
      supplierAccountId: account.id,
      agreementId: agreement.id,
      orderId: `order-${uuidv7()}`,
      idempotencyKey: `po:${uuidv7()}`,
      currency: 'EUR',
      itemsAmount: 4_000,
      totalAmount: 4_000,
      destination: {
        recipientName: 'Buyer',
        line1: '1 Market Street',
        city: 'Valencia',
        postalCode: '46001',
        country: 'ES',
      },
      lines: [
        {
          supplierSku: sku,
          procurementOfferId: offer.id,
          quantity: 2,
          unitCostAmount: 2_000,
          lineTotalAmount: 4_000,
        },
      ],
    });
    await transitionPurchaseOrder({
      purchaseOrderId: purchaseOrder.id,
      expected: 'draft',
      next: 'submitted',
      initiator: 'system',
    });

    // The supplier re-prices. The OFFER moves…
    const refreshed = await ingestProcurementOffer(
      observation(
        { supplierId: supplier.id, supplierAccountId: account.id },
        { supplierSku: sku, unitCostAmount: 9_999 },
      ),
    );
    expect(refreshed.offer.unitCostAmount).toBe(9_999);

    // …and the submitted PO's snapshot does NOT.
    const lines = await findPurchaseOrderLines(purchaseOrder.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.unitCostAmount).toBe(2_000);
    expect(lines[0]?.procurementOfferId).toBe(offer.id);
  });
});
