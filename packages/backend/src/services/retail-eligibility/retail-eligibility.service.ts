/**
 * `getRetailEligibility` — THE authoritative retail eligibility gate (#121
 * service contract).
 *
 * One function, used by publication (#57/#129), search, cart and checkout
 * (#123). It loads the facts, calls the pure derivation in `eligibility.ts`,
 * and records what it answered. Clients cannot override it: the query type has
 * no `force`, `skip` or `assumeEligible` member, and the only thing that can
 * change a verdict is DATA — an evidence row, a policy version, a recorded and
 * dual-approved exception — every piece of which is audited.
 *
 * ## Loading and deciding are SEPARATE modules, and that is load-bearing
 *
 * `eligibility.ts` is pure and imports no repository. This module is the only
 * one that touches the database. That split is what lets #121 acceptance 8's
 * whole test list run as table tests over fixtures AND run against a real
 * server through the same derivation, byte for byte — and it is what makes
 * "the derivation never reads a stored verdict" checkable rather than promised
 * (`retail-eligibility-isolation.test.ts` fails the build if `eligibility.ts`
 * imports `decisionRepository.js`).
 *
 * ## The decision is RECORDED, never READ back as an answer
 *
 * `retail_eligibility_decisions` is an append-only observation for the operator
 * trace, the re-evaluation sweep and the eligible-catalogue measurement. This
 * function never consults it. A verdict is always re-derived, which is what
 * makes an expiry (acceptance 2) and a recall (acceptance 5) bite with no sweep
 * having run.
 *
 * ## A policy-less answer is returned and NOT recorded
 *
 * With no active policy version the derivation answers `unknown` /
 * `policy_missing`, which blocks. Nothing is written: a decision that cannot
 * cite the version it was made under is not reproducible, and a record of it
 * would be evidence of nothing.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type {
  AgreementChannel,
  RetailComplianceEvidenceKind,
  RetailEligibilityQuery,
  RetailEligibilityReason,
  RetailEligibilityResult,
  RetailResaleEvidenceKind,
} from '@mercaria/shared-types';
import { AGREEMENT_CHANNELS } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { categories } from '../../db/schema/catalog.js';
import { canonicalProducts, productIdentifiers } from '../../db/schema/canonicalCatalog.js';
import { retailCategoryRules } from '../../db/schema/retailEligibility.js';
import { brands } from '../../db/schema/organizations.js';
import {
  findProcurementOfferById,
  type ProcurementOfferRecord,
} from '../../db/procurement/procurementOfferRepository.js';
import { findSupplierById } from '../../db/procurement/supplierRepository.js';
import { findSupplierAccountById } from '../../db/procurement/supplierAccountRepository.js';
import {
  findAgreementById,
  type SupplierAgreementRecord,
} from '../../db/procurement/agreementRepository.js';
import {
  findActiveRetailEligibilityPolicy,
  findRetailMarketCapability,
  type RetailCategoryRuleRecord,
  type RetailEligibilityPolicyRecord,
  type RetailMarketCapabilityRecord,
} from '../../db/retailEligibility/policyRepository.js';
import {
  listRetailComplianceEvidenceForProduct,
  listRetailResaleEvidence,
  type RetailComplianceEvidenceRecord,
  type RetailResaleEvidenceRecord,
} from '../../db/retailEligibility/evidenceRepository.js';
import {
  listLiveRetailSuppressionsForOffer,
  type RetailSuppressionRecord,
} from '../../db/retailEligibility/suppressionRepository.js';
import {
  findLiveRetailEligibilityException,
  type RetailEligibilityExceptionRecord,
} from '../../db/retailEligibility/exceptionRepository.js';
import {
  recordRetailEligibilityDecision,
  type RetailEligibilitySurface,
} from '../../db/retailEligibility/decisionRepository.js';
import { deriveProcurementEligibility } from '../procurement/procurement-eligibility.js';
import type { ProcurementEligibility } from '@mercaria/shared-types';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { deriveRetailEligibility, type RetailEligibilityDerivationInput } from './eligibility.js';
import { hashRetailEligibilityDecision } from './eligibility-hash.js';
import { readRetailTraceability, type RetailTraceabilityFacts } from './traceability.port.js';

/**
 * The policy key every retail eligibility answer is derived under.
 *
 * A constant and not an environment variable: which policy governs
 * `mercaria_retail` is not a per-deployment choice, and a variable holding it
 * could only ever disagree with the rows it names — the
 * `CROWDSOURCE_APP_ID` reasoning. Publishing a NEW VERSION under this key is
 * how the policy changes.
 */
export const RETAIL_ELIGIBILITY_POLICY_KEY = 'mercaria-retail-eligibility';

/** What the caller says about where the question came from, and whether to record it. */
export interface GetRetailEligibilityOptions {
  surface: RetailEligibilitySurface;
  /**
   * Whether to write the decision row. Default TRUE. A `false` is for a
   * what-if trace an operator runs, which must not pollute the measurement of
   * what the catalogue actually answered.
   */
  record?: boolean;
  db?: DatabaseOrTransaction;
}

/**
 * Answer the eligibility question for one exact combination.
 *
 * Throws only for a MALFORMED question — an unknown offer, a channel outside
 * the vocabulary, a `canonicalVariantId` that contradicts the offer's own
 * mapping. Everything else is an answer: an ineligible or unknown verdict with
 * bounded reasons, never an exception a caller might catch and ignore.
 */
export async function getRetailEligibility(
  query: RetailEligibilityQuery,
  options: GetRetailEligibilityOptions,
): Promise<RetailEligibilityResult> {
  const db = options.db ?? getDb();
  const now = query.at ? new Date(query.at) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw validationError('`at` must be an ISO-8601 instant.');
  }
  const channel = assertAgreementChannel(query.channel);

  const offer = await findProcurementOfferById(query.procurementOfferId, db);
  if (!offer) {
    throw notFound(`Procurement offer ${query.procurementOfferId} does not exist.`);
  }
  // A caller that names a variant is asserting WHICH product it is asking
  // about. Answering for a different one would be the false-merge failure #58
  // exists to prevent, arriving through a query parameter — so it is refused
  // rather than resolved to one of the two.
  if (query.canonicalVariantId && query.canonicalVariantId !== offer.canonicalVariantId) {
    throw validationError(
      'canonicalVariantId does not match the procurement offer\'s own mapping. ' +
        'Ask about the offer, or about the variant it actually maps to.',
    );
  }

  const [supplier, account, policy] = await Promise.all([
    findSupplierById(offer.supplierId, db),
    findSupplierAccountById(offer.supplierAccountId, db),
    findActiveRetailEligibilityPolicy(db, { policyKey: RETAIL_ELIGIBILITY_POLICY_KEY, at: now }),
  ]);
  if (!supplier) throw notFound(`Supplier ${offer.supplierId} does not exist.`);
  if (!account) throw notFound(`Supplier account ${offer.supplierAccountId} does not exist.`);

  const agreement = offer.agreementId ? await findAgreementById(offer.agreementId, db) : undefined;
  const productContext = await loadProductContext(db, offer.canonicalProductId);

  const supply = deriveProcurementEligibility({
    supplier: { status: supplier.status, riskLevel: supplier.riskLevel },
    account: { state: account.state },
    agreement: agreement
      ? {
          approvalState: agreement.approvalState,
          effectiveAt: agreement.effectiveAt,
          expiresAt: agreement.expiresAt,
          permittedDestinationCountries: agreement.permittedDestinationCountries,
          permittedChannels: agreement.permittedChannels,
          resaleRightsGranted: agreement.resaleRightsGranted,
          dropshipRightsGranted: agreement.dropshipRightsGranted,
          blindDropshipVerified: agreement.blindDropshipVerified,
          dataProcessingTermsAccepted: agreement.dataProcessingTermsAccepted,
        }
      : null,
    offer: {
      id: offer.id,
      status: offer.status,
      availability: offer.availability,
      canonicalProductId: offer.canonicalProductId,
      canonicalVariantId: offer.canonicalVariantId,
      eligibleDestinationCountries: offer.eligibleDestinationCountries,
      lastConfirmedAt: offer.lastConfirmedAt,
      quoteTtlSeconds: offer.quoteTtlSeconds,
      expiresAt: offer.expiresAt,
      deliveryDaysMin: offer.deliveryDaysMin,
      deliveryDaysMax: offer.deliveryDaysMax,
    },
    destinationCountry: query.destinationCountry,
    channel,
    now,
  });

  // The origin is resolved by the derivation from the offer's declared origins
  // and the policy's permitted set, so the capability lookup needs it FIRST —
  // which is why the derivation is run once to resolve the route and the
  // capability is then loaded and the derivation run again with it. Two passes
  // over a pure function, rather than a second copy of the origin rule here.
  const originProbe = deriveRetailEligibility(
    buildDerivationInput({
      query,
      channel,
      now,
      offer,
      agreement,
      supply,
      product: productContext,
      policy,
      categoryRule: null,
      marketCapability: null,
      resaleEvidence: [],
      complianceEvidence: [],
      suppressions: [],
      exception: null,
      traceability: {},
    }),
  );
  const fulfilmentOriginCountry = originProbe.fulfilmentOriginCountry;

  const [categoryRule, marketCapability, resaleEvidence, complianceEvidence, suppressions,
    exception, traceability] = await Promise.all([
    policy && productContext.categoryKeys.length > 0
      ? findMostSpecificCategoryRule(db, policy.id, productContext.categoryKeys)
      : Promise.resolve(undefined),
    policy && fulfilmentOriginCountry
      ? findRetailMarketCapability(db, {
          policyId: policy.id,
          destinationCountry: query.destinationCountry,
          fulfilmentOriginCountry,
          customerType: query.customerType,
        })
      : Promise.resolve(undefined),
    listRetailResaleEvidence(db, { supplierId: offer.supplierId }),
    listRetailComplianceEvidenceForProduct(db, {
      supplierId: offer.supplierId,
      canonicalProductId: offer.canonicalProductId,
      canonicalVariantId: offer.canonicalVariantId,
      supplierSku: offer.supplierSku,
    }),
    listLiveRetailSuppressionsForOffer(db, {
      supplierId: offer.supplierId,
      supplierAccountId: offer.supplierAccountId,
      canonicalProductId: offer.canonicalProductId,
      canonicalVariantId: offer.canonicalVariantId,
      supplierSku: offer.supplierSku,
      categoryKey: productContext.categoryKeys[0] ?? null,
      brandId: productContext.brandId,
      destinationCountry: query.destinationCountry,
      now,
    }),
    findLiveRetailEligibilityException(db, {
      supplierId: offer.supplierId,
      canonicalVariantId: offer.canonicalVariantId,
      now,
    }),
    readRetailTraceability({
      canonicalProductId: offer.canonicalProductId,
      canonicalVariantId: offer.canonicalVariantId,
      supplierId: offer.supplierId,
      supplierSku: offer.supplierSku,
    }),
  ]);

  const derivation = deriveRetailEligibility(
    buildDerivationInput({
      query,
      channel,
      now,
      offer,
      agreement,
      supply,
      product: productContext,
      policy,
      categoryRule: categoryRule ?? null,
      marketCapability: marketCapability ?? null,
      resaleEvidence,
      complianceEvidence,
      suppressions,
      exception: exception ?? null,
      traceability,
    }),
  );

  const contentHash = hashRetailEligibilityDecision({
    policyKey: policy?.policyKey ?? RETAIL_ELIGIBILITY_POLICY_KEY,
    policyVersion: policy?.version ?? 0,
    procurementOfferId: offer.id,
    canonicalVariantId: offer.canonicalVariantId,
    destinationCountry: query.destinationCountry.toUpperCase(),
    fulfilmentOriginCountry: derivation.fulfilmentOriginCountry,
    channel,
    currency: query.currency,
    quantity: query.quantity,
    fulfilmentMethod: query.fulfilmentMethod,
    customerType: query.customerType,
    verdict: derivation.verdict,
    reasons: derivation.reasons,
    nextRequiredAction: derivation.nextRequiredAction,
    evidence: derivation.evidence,
    appliedExceptionId: derivation.appliedExceptionId,
  });

  if (policy && options.record !== false) {
    await recordRetailEligibilityDecision(db, {
      policyId: policy.id,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      procurementOfferId: offer.id,
      supplierId: offer.supplierId,
      canonicalVariantId: offer.canonicalVariantId,
      destinationCountry: query.destinationCountry,
      fulfilmentOriginCountry: derivation.fulfilmentOriginCountry,
      channel,
      currency: query.currency,
      quantity: query.quantity,
      fulfilmentMethod: query.fulfilmentMethod,
      customerType: query.customerType,
      verdict: derivation.verdict,
      reasons: derivation.reasons,
      nextRequiredAction: derivation.nextRequiredAction,
      resaleEvidenceIds: derivation.evidence
        .filter((ref) => ref.registry === 'resale')
        .map((ref) => ref.id),
      complianceEvidenceIds: derivation.evidence
        .filter((ref) => ref.registry === 'compliance')
        .map((ref) => ref.id),
      exceptionId: derivation.appliedExceptionId,
      contentHash,
      evaluatedAt: now,
      surface: options.surface,
    });
  }

  if (derivation.waivedReasons.length > 0) {
    // A waiver is never invisible: it is on the decision row AND in the log,
    // because "why did this become sellable" is asked long after the exception
    // row has scrolled out of anybody's view.
    log.general.warn(
      {
        procurementOfferId: offer.id,
        exceptionId: derivation.appliedExceptionId,
        waivedReasons: derivation.waivedReasons,
      },
      '[RetailEligibility] an approved exception waived eligibility reasons',
    );
  }

  return {
    verdict: derivation.verdict,
    reasons: derivation.reasons,
    nextRequiredAction: derivation.nextRequiredAction,
    evidence: derivation.evidence,
    supplyReasons: [...supply.reasons],
    ...(policy
      ? { policyId: policy.id, policyKey: policy.policyKey, policyVersion: policy.version }
      : {}),
    ...(derivation.tax ? { tax: derivation.tax } : {}),
    evaluatedAt: now.toISOString(),
    contentHash,
  };
}

/** The canonical-graph context one offer's product sits in. */
interface ProductContext {
  /** Nearest-first: the product's own category slug, then its ancestors. */
  categoryKeys: string[];
  brandId: string | null;
  brandKey: string | null;
  /** The identifier schemes this product carries ACTIVE, deduped. */
  identifierSchemes: string[];
}

/**
 * Read the brand, the category path and the active identifier schemes of one
 * canonical product.
 *
 * The category path is nearest-first (`[ownSlug, ...ancestors reversed]`)
 * because a rule recorded against a leaf category is a more deliberate
 * statement than one inherited from its parent — the `attribute_scopes`
 * inheritance rule (#94), applied to admissibility.
 */
async function loadProductContext(
  db: DatabaseOrTransaction,
  canonicalProductId: string | null,
): Promise<ProductContext> {
  if (!canonicalProductId) {
    return { categoryKeys: [], brandId: null, brandKey: null, identifierSchemes: [] };
  }
  const [product] = await db
    .select({
      brandId: canonicalProducts.brandId,
      categoryId: canonicalProducts.categoryId,
    })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, canonicalProductId))
    .limit(1);
  if (!product) {
    return { categoryKeys: [], brandId: null, brandKey: null, identifierSchemes: [] };
  }

  const [category] = product.categoryId
    ? await db
        .select({ slug: categories.slug, ancestorSlugs: categories.ancestorSlugs })
        .from(categories)
        .where(eq(categories.id, product.categoryId))
        .limit(1)
    : [];

  const [brand] = product.brandId
    ? await db
        .select({ slug: brands.slug })
        .from(brands)
        .where(eq(brands.id, product.brandId))
        .limit(1)
    : [];

  const identifiers = await db
    .selectDistinct({ scheme: productIdentifiers.scheme })
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.productId, canonicalProductId),
        eq(productIdentifiers.status, 'active'),
      ),
    );

  return {
    // `catalog-write.service` stores the path as `[...ancestorSlugs, slug]`, so
    // the ancestors are ROOT-FIRST and reversing them yields nearest-first.
    categoryKeys: category ? [category.slug, ...[...category.ancestorSlugs].reverse()] : [],
    brandId: product.brandId,
    brandKey: brand?.slug ?? null,
    identifierSchemes: identifiers.map((row) => row.scheme),
  };
}

/**
 * The most specific category rule on a nearest-first path, or none.
 *
 * ONE query for the whole path, then a pick by position: a rule per candidate
 * would be N round trips for a taxonomy that is rarely more than four deep, and
 * picking in SQL would put the specificity rule somewhere a reader of this
 * domain would not look for it.
 */
async function findMostSpecificCategoryRule(
  db: DatabaseOrTransaction,
  policyId: string,
  categoryKeys: readonly string[],
): Promise<RetailCategoryRuleRecord | undefined> {
  const rows = await db
    .select()
    .from(retailCategoryRules)
    .where(
      and(
        eq(retailCategoryRules.policyId, policyId),
        inArray(retailCategoryRules.categoryKey, [...categoryKeys]),
      ),
    );
  const byKey = new Map(rows.map((row) => [row.categoryKey, row]));
  for (const key of categoryKeys) {
    const rule = byKey.get(key);
    if (rule) return rule;
  }
  return undefined;
}

/** Assemble the pure derivation's input from loaded rows. */
function buildDerivationInput(parts: {
  query: RetailEligibilityQuery;
  channel: AgreementChannel;
  now: Date;
  offer: ProcurementOfferRecord;
  agreement: SupplierAgreementRecord | undefined;
  supply: ProcurementEligibility;
  product: ProductContext;
  policy: RetailEligibilityPolicyRecord | undefined;
  categoryRule: RetailCategoryRuleRecord | null;
  marketCapability: RetailMarketCapabilityRecord | null;
  resaleEvidence: readonly RetailResaleEvidenceRecord[];
  complianceEvidence: readonly RetailComplianceEvidenceRecord[];
  suppressions: readonly RetailSuppressionRecord[];
  exception: RetailEligibilityExceptionRecord | null;
  traceability: RetailTraceabilityFacts;
}): RetailEligibilityDerivationInput {
  const { offer, policy, product } = parts;
  return {
    query: {
      destinationCountry: parts.query.destinationCountry,
      channel: parts.channel,
      currency: parts.query.currency,
      quantity: parts.query.quantity,
      orderValue: parts.query.orderValue ?? null,
      fulfilmentMethod: parts.query.fulfilmentMethod,
      customerType: parts.query.customerType,
      // #129 supplies the buyer's language once the storefront carries one; a
      // route with NO support language at all already blocks, so an unstated
      // language never reads as coverage.
      customerLanguage: null,
    },
    policy: policy
      ? {
          id: policy.id,
          policyKey: policy.policyKey,
          version: policy.version,
          permittedDestinationCountries: policy.permittedDestinationCountries,
          permittedFulfilmentOriginCountries: policy.permittedFulfilmentOriginCountries,
          permittedChannels: policy.permittedChannels,
          permittedCurrencies: policy.permittedCurrencies,
          permittedFulfilmentMethods: policy.permittedFulfilmentMethods,
          permittedCustomerTypes: policy.permittedCustomerTypes,
          requiredResaleEvidenceKinds: policy.requiredResaleEvidenceKinds as RetailResaleEvidenceKind[],
          requiredIdentifierSchemes: policy.requiredIdentifierSchemes,
          requireCountryOfOrigin: policy.requireCountryOfOrigin,
          requireResponsibleOperator: policy.requireResponsibleOperator,
          requireDeterministicProductMatch: policy.requireDeterministicProductMatch,
          minimumMatchConfidence: policy.minimumMatchConfidence,
          maxQuantityPerOrder: policy.maxQuantityPerOrder,
          maxOrderValue:
            policy.maxOrderValueAmount !== null && policy.maxOrderValueCurrency !== null
              ? { amount: policy.maxOrderValueAmount, currency: policy.maxOrderValueCurrency }
              : null,
          manualExceptionsPermitted: policy.manualExceptionsPermitted,
          exceptionDualApprovalRequired: policy.exceptionDualApprovalRequired,
        }
      : null,
    offer: {
      id: offer.id,
      supplierId: offer.supplierId,
      supplierSku: offer.supplierSku,
      canonicalProductId: offer.canonicalProductId,
      canonicalVariantId: offer.canonicalVariantId,
      mappingConfidence: offer.confidence,
      fulfilmentOriginCountries: offer.fulfilmentOriginCountries,
      brandKey: product.brandKey,
      categoryKey: product.categoryKeys[0] ?? null,
      identifierSchemes: product.identifierSchemes,
    },
    agreement: parts.agreement
      ? {
          id: parts.agreement.id,
          excludedBrands: parts.agreement.excludedBrands,
          excludedCategories: parts.agreement.excludedCategories,
          excludedProductRefs: parts.agreement.excludedProductRefs,
          catalogDataRightsGranted: parts.agreement.catalogDataRightsGranted,
          imageRightsGranted: parts.agreement.imageRightsGranted,
          mapRestricted: parts.agreement.mapRestricted,
        }
      : null,
    supply: parts.supply,
    categoryRule: parts.categoryRule
      ? {
          categoryKey: parts.categoryRule.categoryKey,
          admissibility: parts.categoryRule.admissibility,
          requiredComplianceEvidenceKinds:
            parts.categoryRule.requiredComplianceEvidenceKinds as RetailComplianceEvidenceKind[],
          requiresAgeAssurance: parts.categoryRule.requiresAgeAssurance,
          dangerousGoodsRestricted: parts.categoryRule.dangerousGoodsRestricted,
          requiresAuthorizedDealer: parts.categoryRule.requiresAuthorizedDealer,
          requiresBatchTraceability: parts.categoryRule.requiresBatchTraceability,
        }
      : null,
    marketCapability: parts.marketCapability
      ? {
          cancellationBeforeFulfilmentSupported:
            parts.marketCapability.cancellationBeforeFulfilmentSupported,
          statutoryWithdrawalSupported: parts.marketCapability.statutoryWithdrawalSupported,
          legalGuaranteeSupported: parts.marketCapability.legalGuaranteeSupported,
          returnsSupported: parts.marketCapability.returnsSupported,
          defectHandlingSupported: parts.marketCapability.defectHandlingSupported,
          refundThroughOriginalRailSupported:
            parts.marketCapability.refundThroughOriginalRailSupported,
          invoiceIssuanceSupported: parts.marketCapability.invoiceIssuanceSupported,
          recallNotificationSupported: parts.marketCapability.recallNotificationSupported,
          deliveryEstimateAvailable: parts.marketCapability.deliveryEstimateAvailable,
          supportLanguages: parts.marketCapability.supportLanguages,
          vatTreatment: parts.marketCapability.vatTreatment,
          sellerRegistrationRecorded: parts.marketCapability.sellerRegistrationRecorded,
          importerOfRecord: parts.marketCapability.importerOfRecord,
          dutyResponsibility: parts.marketCapability.dutyResponsibility,
          priceFinality: parts.marketCapability.priceFinality,
        }
      : null,
    resaleEvidence: parts.resaleEvidence.map((row) => ({
      id: row.id,
      kind: row.kind,
      reviewState: row.reviewState,
      expiresAt: row.expiresAt,
      agreementId: row.agreementId,
      scopeBrandKeys: row.scopeBrandKeys,
      scopeCategoryKeys: row.scopeCategoryKeys,
      scopeSupplierSkus: row.scopeSupplierSkus,
      scopeDestinationCountries: row.scopeDestinationCountries,
    })),
    complianceEvidence: parts.complianceEvidence.map((row) => ({
      id: row.id,
      kind: row.kind,
      reviewState: row.reviewState,
      expiresAt: row.expiresAt,
      canonicalProductId: row.canonicalProductId,
      canonicalVariantId: row.canonicalVariantId,
      supplierSku: row.supplierSku,
      marketCountries: row.marketCountries,
    })),
    suppressions: parts.suppressions.map((row) => ({
      id: row.id,
      scope: row.scope,
      scopeRef: row.scopeRef,
      kind: row.kind,
      severity: row.severity,
      effectiveFrom: row.effectiveFrom,
      liftedAt: row.liftedAt,
    })),
    exception: parts.exception
      ? {
          id: parts.exception.id,
          waivedReasons: parts.exception.waivedReasons as RetailEligibilityReason[],
          scopeDestinationCountries: parts.exception.scopeDestinationCountries,
          canonicalVariantId: parts.exception.canonicalVariantId,
          expiresAt: parts.exception.expiresAt,
          secondApprovedByOxyUserId: parts.exception.secondApprovedByOxyUserId,
        }
      : null,
    traceability: parts.traceability,
    now: parts.now,
  };
}

/** A channel outside the vocabulary is a malformed question, not an answer. */
function assertAgreementChannel(channel: string): AgreementChannel {
  const match = AGREEMENT_CHANNELS.find((value) => value === channel);
  if (!match) {
    throw validationError(
      `channel must be one of ${AGREEMENT_CHANNELS.join(', ')}; received \`${channel}\`.`,
    );
  }
  return match;
}
