/**
 * The emergency suppression path, END TO END, against a REAL Postgres database
 * (#121 acceptance 5: "test emergency suppression independent from ordinary
 * source refresh").
 *
 * ## Why this file exists beside the table tests
 *
 * `eligibility.test.ts` proves the DERIVATION refuses a recalled variant. That
 * is not the same claim. Acceptance 5 is about the PATH: an offer that is
 * genuinely eligible through the whole loaded fact chain, one INSERT into
 * `retail_suppressions`, and the very next call to `getRetailEligibility`
 * refusing — with nothing swept, no queue drained, no cache invalidated and the
 * catalogue-refresh path never touched.
 *
 * That is exactly what a fixture-only test cannot show, because the thing under
 * test is that no OTHER machinery is involved.
 *
 * ## And the reverse direction, which is the one that is easy to get wrong
 *
 * Lifting the suppression restores eligibility in the next call too. A gate
 * that stopped a sale and could not un-stop it would look correct in every test
 * that only checks the blocking direction.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { brands } from '../../../db/schema/organizations.js';
import { createSupplier, transitionSupplierStatus } from '../../../db/procurement/supplierRepository.js';
import {
  createSupplierAccount,
  transitionAccountState,
} from '../../../db/procurement/supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
} from '../../../db/procurement/agreementRepository.js';
import { upsertProcurementOfferFromSource } from '../../../db/procurement/procurementOfferRepository.js';
import {
  activateRetailEligibilityPolicy,
  insertRetailEligibilityPolicy,
  upsertRetailCategoryRule,
  upsertRetailMarketCapability,
} from '../../../db/retailEligibility/policyRepository.js';
import {
  insertRetailResaleEvidence,
  verifyRetailResaleEvidence,
} from '../../../db/retailEligibility/evidenceRepository.js';
import {
  liftRetailSuppression,
  raiseRetailSuppression,
} from '../../../db/retailEligibility/suppressionRepository.js';
import { listRetailEligibilityDecisionsForOffer } from '../../../db/retailEligibility/decisionRepository.js';
import {
  RETAIL_ELIGIBILITY_POLICY_KEY,
  getRetailEligibility,
} from '../retail-eligibility.service.js';

let db: Database;

/**
 * Unique to this run, and load-bearing rather than tidy.
 *
 * The matcher's candidate retrieval is a trigram and exact-name search over
 * EVERY `canonical_products` row (`postgres-candidate-source.ts`), correctly
 * global for production — so a fixture with a STABLE `normalized_name` is a
 * standing attractor for every later sibling's retrieval, in every run, and
 * this file's fixtures outlive it (see the teardown note below). Naming them
 * per run makes them ordinary per-run rows instead. Measured by #270: this was
 * the one canonical fixture in the estate with a literal name, and
 * `canonical-fixture-census.test.ts` now fails the build on a second.
 */
const RUN = uuidv7().slice(-12);

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  /**
   * Deliberately no teardown, and the reason is worth stating rather than
   * leaving as an omission.
   *
   * The fixtures here are a whole procurement chain — supplier, account,
   * approved agreement, procurement offer, policy version, category rule,
   * market capability, verified evidence, suppressions and the decisions they
   * produced — and every intra-graph key in it is RESTRICT. Unwinding it in a
   * hook would be a second, untested implementation of an order this file
   * exists to say nothing about. The rows are inert: the database is a
   * throwaway that the suite drops at the end of the run, and since #270 every
   * name they carry is scoped by RUN, so nothing here is a stable candidate a
   * sibling's matcher can keep finding.
   */
  await closePostgres();
});

/** A sha-256-shaped variant signature — the CHECK the canonical layer enforces. */
function signature(): string {
  return uuidv7().replace(/[^a-f0-9]/g, '').padEnd(64, '0').slice(0, 64);
}

/**
 * Build a whole eligible combination: supplier, account, approved agreement,
 * canonical product and variant, procurement offer, active policy version,
 * permissive category rule, fully-supported route and a verified resale grant.
 *
 * Deliberately assembled from the REAL repositories rather than from raw
 * inserts: a fixture that bypassed them could be eligible in a way production
 * never is.
 */
async function makeEligibleCombination(): Promise<{
  procurementOfferId: string;
  supplierId: string;
  canonicalVariantId: string;
  categoryKey: string;
}> {
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Emergency-path supplier ${uuidv7()}`,
    establishmentCountries: ['ES'],
    fulfilmentOriginCountries: ['ES'],
  });
  await transitionSupplierStatus({
    supplierId: supplier.id,
    expected: 'under_review',
    next: 'active',
    eventKind: 'activated',
    byOxyUserId: 'oxy-operator-1',
  });

  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: 'test-platform',
    environment: 'test',
    providerAccountId: `acct-${uuidv7()}`,
    credentialReference: `/oxy/mercaria/suppliers/test/${uuidv7()}`,
    enabledMarkets: ['ES'],
    fulfilmentOrigins: ['ES'],
  });
  await transitionAccountState({ accountId: account.id, expected: 'inactive', next: 'active' });

  const draftAgreement = await createAgreementVersion({
    supplierId: supplier.id,
    version: 1,
    permittedDestinationCountries: ['ES'],
    permittedChannels: ['mercaria_branded_checkout'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
    catalogDataRightsGranted: true,
    imageRightsGranted: true,
  });
  const agreement = await approveAgreement({
    agreementId: draftAgreement.id,
    reviewedByOxyUserId: 'oxy-reviewer',
    approvedByOxyUserId: 'oxy-approver',
    evidenceLocation: 'vault://agreements/emergency-path.pdf',
    effectiveAt: new Date(Date.now() - 86_400_000),
  });
  if (!agreement) throw new Error('fixture agreement did not approve');

  // The product needs a BRAND: without one and without a traceability provider
  // the derivation reports `brand_identity_missing`, which is correct — GPSR
  // traceability starts with knowing who made the thing.
  const [brand] = await db
    .insert(brands)
    .values({
      slug: `emergency-path-brand-${uuidv7()}`,
      name: `Emergency Path Brand ${RUN}`,
      normalizedName: `emergency path brand ${RUN}`,
    })
    .returning();
  if (!brand) throw new Error('fixture brand was not created');
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      slug: `emergency-path-${uuidv7()}`,
      name: `Emergency path widget ${RUN}`,
      normalizedName: `emergency path widget ${RUN}`,
      brandId: brand.id,
    })
    .returning();
  if (!product) throw new Error('fixture product was not created');
  const [variant] = await db
    .insert(canonicalVariants)
    .values({ productId: product.id, signature: signature(), isDefault: true })
    .returning();
  if (!variant) throw new Error('fixture variant was not created');

  const { offer } = await upsertProcurementOfferFromSource({
    supplierId: supplier.id,
    supplierAccountId: account.id,
    agreementId: agreement.id,
    canonicalProductId: product.id,
    canonicalVariantId: variant.id,
    supplierSku: `SKU-${uuidv7()}`,
    unitCostAmount: 1_000,
    unitCostCurrency: 'EUR',
    availability: 'in_stock',
    fulfilmentOriginCountries: ['ES'],
    eligibleDestinationCountries: ['ES'],
    provenance: 'manual',
  });

  // The policy version. `RETAIL_ELIGIBILITY_POLICY_KEY` is the key
  // `getRetailEligibility` reads, so the suite has to publish under it — and
  // the partial unique means one version at a time across the whole file.
  const draftPolicy = await insertRetailEligibilityPolicy(db, {
    policyKey: RETAIL_ELIGIBILITY_POLICY_KEY,
    // A version high enough that a re-run of the suite against a database that
    // already holds one does not collide on `(policy_key, version)`.
    version: Date.now() % 1_000_000,
    name: 'Emergency-path launch policy',
    summary: 'ES only, one channel, one currency, nothing else permitted.',
    effectiveStart: new Date(Date.now() - 86_400_000),
    permittedDestinationCountries: ['ES'],
    permittedFulfilmentOriginCountries: ['ES'],
    permittedChannels: ['mercaria_branded_checkout'],
    permittedCurrencies: ['EUR'],
    permittedFulfilmentMethods: ['standard_delivery'],
    permittedCustomerTypes: ['consumer'],
    requiredResaleEvidenceKinds: ['signed_supply_agreement'],
    // The traceability port answers NO DATA until #122 registers a provider, so
    // this version does not require those facts — deliberately, which is the
    // lever's whole purpose.
    requireCountryOfOrigin: false,
    requireResponsibleOperator: false,
    createdByOxyUserId: 'oxy-operator-1',
  });
  const policy = await activateRetailEligibilityPolicy(db, {
    id: draftPolicy.id,
    approvedByOxyUserId: 'oxy-operator-2',
  });
  if (!policy) throw new Error('fixture policy did not activate');

  // The product has no category, so the derivation asks about no category key
  // at all — which would be `category_not_evaluated`. Give the product one, and
  // record a permissive rule for it.
  const categoryKey = `emergency-path-category-${uuidv7()}`;
  const { categories } = await import('../../../db/schema/catalog.js');
  const [category] = await db
    .insert(categories)
    .values({ name: 'Emergency path', slug: categoryKey })
    .returning();
  if (!category) throw new Error('fixture category was not created');
  const { eq } = await import('drizzle-orm');
  await db
    .update(canonicalProducts)
    .set({ categoryId: category.id })
    .where(eq(canonicalProducts.id, product.id));

  await upsertRetailCategoryRule(db, {
    policyId: policy.id,
    categoryKey,
    admissibility: 'permitted',
    reason: 'assessed and cleared for the pilot',
    recordedByOxyUserId: 'oxy-operator-1',
  });

  await upsertRetailMarketCapability(db, {
    policyId: policy.id,
    destinationCountry: 'ES',
    fulfilmentOriginCountry: 'ES',
    customerType: 'consumer',
    cancellationBeforeFulfilmentSupported: true,
    statutoryWithdrawalSupported: true,
    legalGuaranteeSupported: true,
    returnsSupported: true,
    defectHandlingSupported: true,
    refundThroughOriginalRailSupported: true,
    invoiceIssuanceSupported: true,
    recallNotificationSupported: true,
    deliveryEstimateAvailable: true,
    supportLanguages: ['es'],
    vatTreatment: 'destination_vat_oss',
    sellerRegistrationRecorded: true,
    sellerRegistrationRef: 'ES-OSS-0001',
    importerOfRecord: 'not_applicable',
    dutyResponsibility: 'not_applicable',
    priceFinality: 'final',
    reason: 'domestic ES route under OSS',
    recordedByOxyUserId: 'oxy-operator-1',
  });

  const evidence = await insertRetailResaleEvidence(db, {
    supplierId: supplier.id,
    agreementId: agreement.id,
    kind: 'signed_supply_agreement',
    documentUrl: 'https://vault.example/emergency-path-contract.pdf',
    recordedByOxyUserId: 'oxy-operator-1',
  });
  await verifyRetailResaleEvidence(db, {
    id: evidence.id,
    verifiedByOxyUserId: 'oxy-operator-2',
  });

  return {
    procurementOfferId: offer.id,
    supplierId: supplier.id,
    canonicalVariantId: variant.id,
    categoryKey,
  };
}

/** The exact question a checkout would ask. */
function query(procurementOfferId: string) {
  return {
    procurementOfferId,
    channel: 'mercaria_branded_checkout',
    destinationCountry: 'ES',
    currency: 'EUR' as const,
    quantity: 1,
    fulfilmentMethod: 'standard_delivery' as const,
    customerType: 'consumer' as const,
  };
}

describe('the emergency path, independent of any refresh', () => {
  it('an eligible offer becomes ineligible on ONE insert, and eligible again on the lift', async () => {
    const combination = await makeEligibleCombination();

    const before = await getRetailEligibility(query(combination.procurementOfferId), {
      surface: 'checkout',
    });
    expect(before.reasons, JSON.stringify(before.reasons)).toEqual([]);
    expect(before.verdict).toBe('eligible');
    expect(before.policyKey).toBe(RETAIL_ELIGIBILITY_POLICY_KEY);
    expect(before.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // THE emergency act: one INSERT, nothing else. No sweep, no queue, no
    // cache, and the catalogue-refresh path is never called.
    const suppression = await raiseRetailSuppression(db, {
      scope: 'canonical_variant',
      scopeRef: combination.canonicalVariantId,
      kind: 'recall',
      severity: 'stop_sale_and_recover',
      source: 'authority',
      reason: 'authority recall notice EU-2026-0001',
      raisedByOxyUserId: 'oxy-operator-1',
    });

    const during = await getRetailEligibility(query(combination.procurementOfferId), {
      surface: 'checkout',
    });
    expect(during.verdict).toBe('ineligible');
    expect(during.reasons).toContain('product_recalled');
    expect(during.nextRequiredAction).toBe('lift_suppression');
    // The verdict CHANGED, so the content hash did too — which is what makes
    // "did anything change?" answerable without diffing two reason arrays.
    expect(during.contentHash).not.toBe(before.contentHash);

    await liftRetailSuppression(db, {
      id: suppression.id,
      liftedByOxyUserId: 'oxy-operator-3',
      reason: 'the authority withdrew the notice',
    });

    const after = await getRetailEligibility(query(combination.procurementOfferId), {
      surface: 'checkout',
    });
    expect(after.verdict).toBe('eligible');
    // Two answers with identical facts hash identically, whatever the clock did.
    expect(after.contentHash).toBe(before.contentHash);

    // Every one of the three answers was RECORDED, including the refusal.
    const history = await listRetailEligibilityDecisionsForOffer(db, {
      procurementOfferId: combination.procurementOfferId,
    });
    expect(history).toHaveLength(3);
    expect(history.map((row) => row.verdict).sort()).toEqual([
      'eligible',
      'eligible',
      'ineligible',
    ]);
    for (const row of history) {
      expect(row.surface).toBe('checkout');
      expect(row.policyKey).toBe(RETAIL_ELIGIBILITY_POLICY_KEY);
    }
  });

  it('an operator trace answers the same question and records NOTHING', async () => {
    const combination = await makeEligibleCombination();
    const before = await listRetailEligibilityDecisionsForOffer(db, {
      procurementOfferId: combination.procurementOfferId,
    });
    const traced = await getRetailEligibility(query(combination.procurementOfferId), {
      surface: 'operator',
      record: false,
    });
    expect(traced.verdict).toBe('eligible');
    const after = await listRetailEligibilityDecisionsForOffer(db, {
      procurementOfferId: combination.procurementOfferId,
    });
    // A what-if must not pollute the measurement of what the catalogue answered.
    expect(after).toHaveLength(before.length);
  });

  it('refuses a question about a variant the offer does not map to', async () => {
    const combination = await makeEligibleCombination();
    await expect(
      getRetailEligibility(
        { ...query(combination.procurementOfferId), canonicalVariantId: 'some-other-variant' },
        { surface: 'checkout' },
      ),
    ).rejects.toThrow(/does not match/);
  });
});
