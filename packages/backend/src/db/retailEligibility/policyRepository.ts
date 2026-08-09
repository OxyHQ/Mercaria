/**
 * Retail eligibility policy versions, category rules and market capabilities
 * (#121 dimension 12, acceptance 7).
 *
 * The `retailPricingPolicyRepository` shape, and deliberately so: a versioned
 * policy where `draft` is the only editable state, activation supersedes the
 * key's current active version in ONE transaction, and the DATABASE — not this
 * module — refuses an edit to a published version.
 *
 * ## Nothing here can widen a policy beyond what the CHECKs already permit
 *
 * Every scope array is typed to the closed tuple its column CHECKs against, and
 * there is no other lever: no `bypass`, no `defaultVerdict`, no
 * `treatUnknownAsEligible` parameter exists on any function in this file. A
 * policy version can only ever say what it PERMITS, and every one of those
 * lists starts empty, which permits nothing.
 */

import { and, asc, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type {
  AgreementChannel,
  CurrencyCode,
  RetailCategoryAdmissibility,
  RetailComplianceEvidenceKind,
  RetailCrossBorderResponsibility,
  RetailCustomerType,
  RetailFulfilmentMethod,
  RetailPriceFinality,
  RetailResaleEvidenceKind,
  RetailVatTreatment,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  retailCategoryRules,
  retailEligibilityPolicies,
  retailMarketCapabilities,
} from '../schema/retailEligibility.js';

/** One policy row, whole — the table has no protected columns. */
export type RetailEligibilityPolicyRecord = typeof retailEligibilityPolicies.$inferSelect;
/** One category rule row, whole. */
export type RetailCategoryRuleRecord = typeof retailCategoryRules.$inferSelect;
/** One market capability row, whole. */
export type RetailMarketCapabilityRecord = typeof retailMarketCapabilities.$inferSelect;

/** What a new DRAFT policy version is created from. */
export interface NewRetailEligibilityPolicy {
  policyKey: string;
  version: number;
  name: string;
  summary: string;
  effectiveStart: Date;
  effectiveEnd?: Date;
  permittedDestinationCountries?: string[];
  permittedFulfilmentOriginCountries?: string[];
  permittedChannels?: AgreementChannel[];
  permittedCurrencies?: CurrencyCode[];
  permittedFulfilmentMethods?: RetailFulfilmentMethod[];
  permittedCustomerTypes?: RetailCustomerType[];
  requiredResaleEvidenceKinds?: RetailResaleEvidenceKind[];
  requiredIdentifierSchemes?: string[];
  requireCountryOfOrigin?: boolean;
  requireResponsibleOperator?: boolean;
  requireDeterministicProductMatch?: boolean;
  minimumMatchConfidence?: number;
  maxQuantityPerOrder?: number;
  maxOrderValue?: { amount: number; currency: CurrencyCode };
  manualExceptionsPermitted?: boolean;
  exceptionDualApprovalRequired?: boolean;
  createdByOxyUserId: string;
}

/** Draft a new policy version. Publishing it is a separate, audited step. */
export async function insertRetailEligibilityPolicy(
  db: DatabaseOrTransaction,
  input: NewRetailEligibilityPolicy,
): Promise<RetailEligibilityPolicyRecord> {
  const [row] = await db
    .insert(retailEligibilityPolicies)
    .values({
      policyKey: input.policyKey,
      version: input.version,
      name: input.name,
      summary: input.summary,
      effectiveStart: input.effectiveStart,
      effectiveEnd: input.effectiveEnd ?? null,
      permittedDestinationCountries: input.permittedDestinationCountries ?? [],
      permittedFulfilmentOriginCountries: input.permittedFulfilmentOriginCountries ?? [],
      permittedChannels: input.permittedChannels ?? [],
      permittedCurrencies: input.permittedCurrencies ?? [],
      permittedFulfilmentMethods: input.permittedFulfilmentMethods ?? [],
      permittedCustomerTypes: input.permittedCustomerTypes ?? [],
      requiredResaleEvidenceKinds: input.requiredResaleEvidenceKinds ?? [],
      requiredIdentifierSchemes: input.requiredIdentifierSchemes ?? [],
      ...(input.requireCountryOfOrigin !== undefined
        ? { requireCountryOfOrigin: input.requireCountryOfOrigin }
        : {}),
      ...(input.requireResponsibleOperator !== undefined
        ? { requireResponsibleOperator: input.requireResponsibleOperator }
        : {}),
      ...(input.requireDeterministicProductMatch !== undefined
        ? { requireDeterministicProductMatch: input.requireDeterministicProductMatch }
        : {}),
      ...(input.minimumMatchConfidence !== undefined
        ? { minimumMatchConfidence: input.minimumMatchConfidence }
        : {}),
      ...(input.maxQuantityPerOrder !== undefined
        ? { maxQuantityPerOrder: input.maxQuantityPerOrder }
        : {}),
      maxOrderValueAmount: input.maxOrderValue?.amount ?? null,
      maxOrderValueCurrency: input.maxOrderValue?.currency ?? null,
      ...(input.manualExceptionsPermitted !== undefined
        ? { manualExceptionsPermitted: input.manualExceptionsPermitted }
        : {}),
      ...(input.exceptionDualApprovalRequired !== undefined
        ? { exceptionDualApprovalRequired: input.exceptionDualApprovalRequired }
        : {}),
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) throw new Error('insertRetailEligibilityPolicy returned no row');
  return row;
}

/** Every version of every policy (or of one key), newest first. */
export async function listRetailEligibilityPolicies(
  db: DatabaseOrTransaction,
  filter?: { policyKey: string },
): Promise<RetailEligibilityPolicyRecord[]> {
  const query = db.select().from(retailEligibilityPolicies);
  return filter
    ? await query
        .where(eq(retailEligibilityPolicies.policyKey, filter.policyKey))
        .orderBy(desc(retailEligibilityPolicies.createdAt))
    : await query.orderBy(desc(retailEligibilityPolicies.createdAt));
}

/**
 * The version in force at `at`, or none.
 *
 * The partial unique index holds at most ONE active row per key, so this reads
 * a single row rather than resolving a conflict. `active` and "inside its
 * effective window" are different facts, and both are required: a version
 * activated ahead of its start date is active and not yet in force, and a
 * derivation under it would cite a policy that does not apply.
 */
export async function findActiveRetailEligibilityPolicy(
  db: DatabaseOrTransaction,
  input: { policyKey: string; at?: Date },
): Promise<RetailEligibilityPolicyRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .select()
    .from(retailEligibilityPolicies)
    .where(
      and(
        eq(retailEligibilityPolicies.policyKey, input.policyKey),
        eq(retailEligibilityPolicies.status, 'active'),
        lte(retailEligibilityPolicies.effectiveStart, at),
        // `gt`, never a raw `sql` template — see CONVENTIONS.md §"A Date is not
        // a safe parameter against an EXPRESSION".
        or(
          isNull(retailEligibilityPolicies.effectiveEnd),
          gt(retailEligibilityPolicies.effectiveEnd, at),
        ),
      ),
    )
    .limit(1);
  return row;
}

/** One version by row id — the operator surface's addressing. */
export async function findRetailEligibilityPolicyById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<RetailEligibilityPolicyRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailEligibilityPolicies)
    .where(eq(retailEligibilityPolicies.id, id))
    .limit(1);
  return row;
}

/**
 * Publish a draft, superseding the key's current active version in the SAME
 * transaction.
 *
 * Both statements are CAS (`retailPricingPolicyRepository`'s shape): the
 * supersede matches `status = 'active'` and the activation matches
 * `status = 'draft'`, so two concurrent activations produce exactly one winner
 * and the loser sees `undefined` rather than transiently leaving a key with two
 * active versions — which the partial unique index would refuse anyway, the CAS
 * is what makes the refusal a clean answer instead of a constraint error.
 */
export async function activateRetailEligibilityPolicy(
  db: DatabaseOrTransaction,
  input: { id: string; approvedByOxyUserId: string; at?: Date },
): Promise<RetailEligibilityPolicyRecord | undefined> {
  const at = input.at ?? new Date();
  return await db.transaction(async (tx) => {
    const draft = await findRetailEligibilityPolicyById(tx, input.id);
    if (!draft || draft.status !== 'draft') return undefined;

    await tx
      .update(retailEligibilityPolicies)
      .set({ status: 'superseded', updatedAt: at })
      .where(
        and(
          eq(retailEligibilityPolicies.policyKey, draft.policyKey),
          eq(retailEligibilityPolicies.status, 'active'),
        ),
      );

    const [row] = await tx
      .update(retailEligibilityPolicies)
      .set({
        status: 'active',
        approvedByOxyUserId: input.approvedByOxyUserId,
        activatedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(retailEligibilityPolicies.id, input.id),
          eq(retailEligibilityPolicies.status, 'draft'),
        ),
      )
      .returning();
    return row;
  });
}

/** Withdraw an active version, or abandon a draft, without a replacement. */
export async function retireRetailEligibilityPolicy(
  db: DatabaseOrTransaction,
  id: string,
  at: Date = new Date(),
): Promise<RetailEligibilityPolicyRecord | undefined> {
  const [row] = await db
    .update(retailEligibilityPolicies)
    .set({ status: 'retired', updatedAt: at })
    .where(
      and(
        eq(retailEligibilityPolicies.id, id),
        or(
          eq(retailEligibilityPolicies.status, 'draft'),
          eq(retailEligibilityPolicies.status, 'active'),
        ),
      ),
    )
    .returning();
  return row;
}

/* ------------------------------------------------------------------------- *
 * Category rules
 * ------------------------------------------------------------------------- */

/** What one category rule records. */
export interface NewRetailCategoryRule {
  policyId: string;
  categoryKey: string;
  admissibility: RetailCategoryAdmissibility;
  requiredComplianceEvidenceKinds?: RetailComplianceEvidenceKind[];
  requiresAgeAssurance?: boolean;
  dangerousGoodsRestricted?: boolean;
  requiresAuthorizedDealer?: boolean;
  requiresBatchTraceability?: boolean;
  reason: string;
  recordedByOxyUserId: string;
  recordedAt?: Date;
}

/**
 * Record (or correct) one category's rule under one policy version.
 *
 * `ON CONFLICT DO UPDATE` on `(policy_id, category_key)`: a rule is a statement
 * about a category under a version, and a second statement about the same pair
 * REPLACES it rather than creating a duplicate an operator would have to
 * reconcile. The audit row is what preserves the previous statement — the rule
 * table holds current policy, the audit table holds history.
 *
 * The policy version's own immutability trigger does NOT cover this table on
 * purpose: a category's rule is evaluated evidence, not a term of the policy,
 * and gating it behind a new version would mean a newly-assessed category
 * cannot be admitted without republishing everything else.
 */
export async function upsertRetailCategoryRule(
  db: DatabaseOrTransaction,
  input: NewRetailCategoryRule,
): Promise<RetailCategoryRuleRecord> {
  const recordedAt = input.recordedAt ?? new Date();
  const values = {
    policyId: input.policyId,
    categoryKey: input.categoryKey,
    admissibility: input.admissibility,
    requiredComplianceEvidenceKinds: input.requiredComplianceEvidenceKinds ?? [],
    requiresAgeAssurance: input.requiresAgeAssurance ?? false,
    dangerousGoodsRestricted: input.dangerousGoodsRestricted ?? false,
    requiresAuthorizedDealer: input.requiresAuthorizedDealer ?? false,
    requiresBatchTraceability: input.requiresBatchTraceability ?? false,
    reason: input.reason,
    recordedByOxyUserId: input.recordedByOxyUserId,
    recordedAt,
  };
  const [row] = await db
    .insert(retailCategoryRules)
    .values(values)
    .onConflictDoUpdate({
      target: [retailCategoryRules.policyId, retailCategoryRules.categoryKey],
      set: {
        admissibility: values.admissibility,
        requiredComplianceEvidenceKinds: values.requiredComplianceEvidenceKinds,
        requiresAgeAssurance: values.requiresAgeAssurance,
        dangerousGoodsRestricted: values.dangerousGoodsRestricted,
        requiresAuthorizedDealer: values.requiresAuthorizedDealer,
        requiresBatchTraceability: values.requiresBatchTraceability,
        reason: values.reason,
        recordedByOxyUserId: values.recordedByOxyUserId,
        recordedAt: values.recordedAt,
        updatedAt: recordedAt,
      },
    })
    .returning();
  if (!row) throw new Error('upsertRetailCategoryRule returned no row');
  return row;
}

/**
 * The rule for one category under one policy version, or none.
 *
 * "None" is the fail-closed default and is a genuine answer: the derivation
 * reports `category_not_evaluated`, which is `unknown`, which blocks (ADR 0004
 * D12.3).
 */
export async function findRetailCategoryRule(
  db: DatabaseOrTransaction,
  input: { policyId: string; categoryKey: string },
): Promise<RetailCategoryRuleRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailCategoryRules)
    .where(
      and(
        eq(retailCategoryRules.policyId, input.policyId),
        eq(retailCategoryRules.categoryKey, input.categoryKey),
      ),
    )
    .limit(1);
  return row;
}

/** Every category rule under one policy version, alphabetically. */
export async function listRetailCategoryRules(
  db: DatabaseOrTransaction,
  policyId: string,
): Promise<RetailCategoryRuleRecord[]> {
  return await db
    .select()
    .from(retailCategoryRules)
    .where(eq(retailCategoryRules.policyId, policyId))
    .orderBy(asc(retailCategoryRules.categoryKey));
}

/* ------------------------------------------------------------------------- *
 * Market capabilities
 * ------------------------------------------------------------------------- */

/** What one route determination records. */
export interface NewRetailMarketCapability {
  policyId: string;
  destinationCountry: string;
  fulfilmentOriginCountry: string;
  customerType: RetailCustomerType;
  cancellationBeforeFulfilmentSupported?: boolean;
  statutoryWithdrawalSupported?: boolean;
  legalGuaranteeSupported?: boolean;
  returnsSupported?: boolean;
  defectHandlingSupported?: boolean;
  refundThroughOriginalRailSupported?: boolean;
  invoiceIssuanceSupported?: boolean;
  recallNotificationSupported?: boolean;
  deliveryEstimateAvailable?: boolean;
  supportLanguages?: string[];
  vatTreatment?: RetailVatTreatment;
  sellerRegistrationRecorded?: boolean;
  sellerRegistrationRef?: string;
  ossRelevant?: boolean;
  iossRelevant?: boolean;
  importerOfRecord?: RetailCrossBorderResponsibility;
  dutyResponsibility?: RetailCrossBorderResponsibility;
  priceFinality?: RetailPriceFinality;
  orderValueThreshold?: { amount: number; currency: CurrencyCode };
  supplierInvoiceTaxNote?: string;
  customerInvoiceNote?: string;
  reason: string;
  recordedByOxyUserId: string;
  recordedAt?: Date;
}

/**
 * Record (or correct) one route's determination. `ON CONFLICT DO UPDATE` for
 * the reason `upsertRetailCategoryRule` records: this is evaluated evidence
 * about a route, not a term of the policy.
 */
export async function upsertRetailMarketCapability(
  db: DatabaseOrTransaction,
  input: NewRetailMarketCapability,
): Promise<RetailMarketCapabilityRecord> {
  const recordedAt = input.recordedAt ?? new Date();
  const values = {
    policyId: input.policyId,
    destinationCountry: input.destinationCountry.toUpperCase(),
    fulfilmentOriginCountry: input.fulfilmentOriginCountry.toUpperCase(),
    customerType: input.customerType,
    cancellationBeforeFulfilmentSupported: input.cancellationBeforeFulfilmentSupported ?? false,
    statutoryWithdrawalSupported: input.statutoryWithdrawalSupported ?? false,
    legalGuaranteeSupported: input.legalGuaranteeSupported ?? false,
    returnsSupported: input.returnsSupported ?? false,
    defectHandlingSupported: input.defectHandlingSupported ?? false,
    refundThroughOriginalRailSupported: input.refundThroughOriginalRailSupported ?? false,
    invoiceIssuanceSupported: input.invoiceIssuanceSupported ?? false,
    recallNotificationSupported: input.recallNotificationSupported ?? false,
    deliveryEstimateAvailable: input.deliveryEstimateAvailable ?? false,
    supportLanguages: input.supportLanguages ?? [],
    vatTreatment: input.vatTreatment ?? ('not_determined' as const),
    sellerRegistrationRecorded: input.sellerRegistrationRecorded ?? false,
    sellerRegistrationRef: input.sellerRegistrationRef ?? null,
    ossRelevant: input.ossRelevant ?? false,
    iossRelevant: input.iossRelevant ?? false,
    importerOfRecord: input.importerOfRecord ?? ('undetermined' as const),
    dutyResponsibility: input.dutyResponsibility ?? ('undetermined' as const),
    priceFinality: input.priceFinality ?? ('undetermined' as const),
    orderValueThresholdMinor: input.orderValueThreshold?.amount ?? null,
    orderValueThresholdCurrency: input.orderValueThreshold?.currency ?? null,
    supplierInvoiceTaxNote: input.supplierInvoiceTaxNote ?? null,
    customerInvoiceNote: input.customerInvoiceNote ?? null,
    reason: input.reason,
    recordedByOxyUserId: input.recordedByOxyUserId,
    recordedAt,
  };
  const [row] = await db
    .insert(retailMarketCapabilities)
    .values(values)
    .onConflictDoUpdate({
      target: [
        retailMarketCapabilities.policyId,
        retailMarketCapabilities.destinationCountry,
        retailMarketCapabilities.fulfilmentOriginCountry,
        retailMarketCapabilities.customerType,
      ],
      set: {
        cancellationBeforeFulfilmentSupported: values.cancellationBeforeFulfilmentSupported,
        statutoryWithdrawalSupported: values.statutoryWithdrawalSupported,
        legalGuaranteeSupported: values.legalGuaranteeSupported,
        returnsSupported: values.returnsSupported,
        defectHandlingSupported: values.defectHandlingSupported,
        refundThroughOriginalRailSupported: values.refundThroughOriginalRailSupported,
        invoiceIssuanceSupported: values.invoiceIssuanceSupported,
        recallNotificationSupported: values.recallNotificationSupported,
        deliveryEstimateAvailable: values.deliveryEstimateAvailable,
        supportLanguages: values.supportLanguages,
        vatTreatment: values.vatTreatment,
        sellerRegistrationRecorded: values.sellerRegistrationRecorded,
        sellerRegistrationRef: values.sellerRegistrationRef,
        ossRelevant: values.ossRelevant,
        iossRelevant: values.iossRelevant,
        importerOfRecord: values.importerOfRecord,
        dutyResponsibility: values.dutyResponsibility,
        priceFinality: values.priceFinality,
        orderValueThresholdMinor: values.orderValueThresholdMinor,
        orderValueThresholdCurrency: values.orderValueThresholdCurrency,
        supplierInvoiceTaxNote: values.supplierInvoiceTaxNote,
        customerInvoiceNote: values.customerInvoiceNote,
        reason: values.reason,
        recordedByOxyUserId: values.recordedByOxyUserId,
        recordedAt: values.recordedAt,
        updatedAt: recordedAt,
      },
    })
    .returning();
  if (!row) throw new Error('upsertRetailMarketCapability returned no row');
  return row;
}

/** The determination for one route, or none — which is `market_capability_unknown`. */
export async function findRetailMarketCapability(
  db: DatabaseOrTransaction,
  input: {
    policyId: string;
    destinationCountry: string;
    fulfilmentOriginCountry: string;
    customerType: RetailCustomerType;
  },
): Promise<RetailMarketCapabilityRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailMarketCapabilities)
    .where(
      and(
        eq(retailMarketCapabilities.policyId, input.policyId),
        eq(retailMarketCapabilities.destinationCountry, input.destinationCountry.toUpperCase()),
        eq(
          retailMarketCapabilities.fulfilmentOriginCountry,
          input.fulfilmentOriginCountry.toUpperCase(),
        ),
        eq(retailMarketCapabilities.customerType, input.customerType),
      ),
    )
    .limit(1);
  return row;
}

/** Every route determination under one policy version. */
export async function listRetailMarketCapabilities(
  db: DatabaseOrTransaction,
  policyId: string,
): Promise<RetailMarketCapabilityRecord[]> {
  return await db
    .select()
    .from(retailMarketCapabilities)
    .where(eq(retailMarketCapabilities.policyId, policyId))
    .orderBy(
      asc(retailMarketCapabilities.destinationCountry),
      asc(retailMarketCapabilities.fulfilmentOriginCountry),
    );
}
