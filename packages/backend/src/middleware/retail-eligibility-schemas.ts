/**
 * Request schemas for the retail eligibility operator surface (#121).
 *
 * `.strict()` throughout, and here the strictness is doing MORE than refusing a
 * smuggled audit field: these bodies are the ones where somebody would try to
 * make an offer sellable. The schemas below enumerate the COMPLETE set of
 * levers, and they contain no `bypass`, no `forceEligible`, no
 * `defaultVerdict`, no `skipChecks` and no `treatUnknownAsEligible` — so an
 * override that is not a recorded, dual-approved, expiring exception over a
 * WAIVABLE reason cannot be written down.
 *
 * `reason` is mandatory on every mutating body, because every act on this
 * surface writes an audit row and an audit row with no reason answers nothing.
 */

import { z } from 'zod';
import {
  AGREEMENT_CHANNELS,
  ALL_CURRENCY_CODES,
  RETAIL_CATEGORY_ADMISSIBILITIES,
  RETAIL_COMPLIANCE_EVIDENCE_KINDS,
  RETAIL_CROSS_BORDER_RESPONSIBILITIES,
  RETAIL_CUSTOMER_TYPES,
  RETAIL_FULFILMENT_METHODS,
  RETAIL_PRICE_FINALITIES,
  RETAIL_RESALE_EVIDENCE_KINDS,
  RETAIL_SUPPRESSION_KINDS,
  RETAIL_SUPPRESSION_SCOPES,
  RETAIL_SUPPRESSION_SEVERITIES,
  RETAIL_SUPPRESSION_SOURCES,
  RETAIL_VAT_TREATMENTS,
  RETAIL_WAIVABLE_REASONS,
  assertSafeMoneyAmount,
  type AgreementChannel,
  type CurrencyCode,
  type RetailCategoryAdmissibility,
  type RetailComplianceEvidenceKind,
  type RetailCrossBorderResponsibility,
  type RetailCustomerType,
  type RetailEligibilityReason,
  type RetailFulfilmentMethod,
  type RetailPriceFinality,
  type RetailResaleEvidenceKind,
  type RetailSuppressionKind,
  type RetailSuppressionScope,
  type RetailSuppressionSeverity,
  type RetailSuppressionSource,
  type RetailVatTreatment,
} from '@mercaria/shared-types';

/** A non-empty tuple, which is what `z.enum` requires. */
function values<T extends string>(list: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = list;
  if (first === undefined) throw new Error('an empty value set cannot be a zod enum');
  return [first, ...rest];
}

const CURRENCY_VALUES = values(ALL_CURRENCY_CODES as readonly CurrencyCode[]);
const CHANNEL_VALUES = values(AGREEMENT_CHANNELS as readonly AgreementChannel[]);
const METHOD_VALUES = values(RETAIL_FULFILMENT_METHODS as readonly RetailFulfilmentMethod[]);
const CUSTOMER_TYPE_VALUES = values(RETAIL_CUSTOMER_TYPES as readonly RetailCustomerType[]);
const RESALE_KIND_VALUES = values(RETAIL_RESALE_EVIDENCE_KINDS as readonly RetailResaleEvidenceKind[]);
const COMPLIANCE_KIND_VALUES = values(
  RETAIL_COMPLIANCE_EVIDENCE_KINDS as readonly RetailComplianceEvidenceKind[],
);
const ADMISSIBILITY_VALUES = values(
  RETAIL_CATEGORY_ADMISSIBILITIES as readonly RetailCategoryAdmissibility[],
);
const VAT_VALUES = values(RETAIL_VAT_TREATMENTS as readonly RetailVatTreatment[]);
const RESPONSIBILITY_VALUES = values(
  RETAIL_CROSS_BORDER_RESPONSIBILITIES as readonly RetailCrossBorderResponsibility[],
);
const FINALITY_VALUES = values(RETAIL_PRICE_FINALITIES as readonly RetailPriceFinality[]);
const SUPPRESSION_SCOPE_VALUES = values(
  RETAIL_SUPPRESSION_SCOPES as readonly RetailSuppressionScope[],
);
const SUPPRESSION_KIND_VALUES = values(RETAIL_SUPPRESSION_KINDS as readonly RetailSuppressionKind[]);
const SUPPRESSION_SEVERITY_VALUES = values(
  RETAIL_SUPPRESSION_SEVERITIES as readonly RetailSuppressionSeverity[],
);
const SUPPRESSION_SOURCE_VALUES = values(
  RETAIL_SUPPRESSION_SOURCES as readonly RetailSuppressionSource[],
);
/**
 * Only the WAIVABLE reasons are on the wire.
 *
 * The database refuses an unwaivable one anyway, and `assertReasonsAreWaivable`
 * explains WHY — but the enum means an HTTP caller cannot even name a recall in
 * this field, which is the `RESERVED_OFFER_FACT_KEYS` device: the strongest
 * version of a rule is the one with no representation.
 */
const WAIVABLE_REASON_VALUES = values(RETAIL_WAIVABLE_REASONS as readonly RetailEligibilityReason[]);

/** ISO-3166-1 alpha-2, upper-cased. A real shape, not a length check. */
const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'must be an ISO-3166-1 alpha-2 country code')
  .transform((value) => value.toUpperCase());

/** A bounded, non-empty reason. Every mutating body carries one. */
const reason = z.string().trim().min(1).max(2_000);

/** A minor-unit amount within the representable ceiling — the money boundary rule. */
const minorUnits = z
  .number()
  .int()
  .positive()
  .superRefine((value, ctx) => {
    try {
      assertSafeMoneyAmount(value, 'retailEligibility.request');
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

/**
 * Drafting a new eligibility policy version.
 *
 * Read the field list as the answer to "what CAN an eligibility policy do":
 * permit destinations, origins, channels, currencies, methods and customer
 * types; require evidence kinds, identifier schemes and traceability facts;
 * bound quantity and order value; and decide whether manual exceptions exist at
 * all. Every list defaults to EMPTY, which permits nothing.
 */
export const retailEligibilityPolicyCreateSchema = z
  .object({
    policyKey: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2_000),
    effectiveStart: z.string().datetime(),
    effectiveEnd: z.string().datetime().optional(),
    permittedDestinationCountries: z.array(countryCode).max(250).optional(),
    permittedFulfilmentOriginCountries: z.array(countryCode).max(250).optional(),
    permittedChannels: z.array(z.enum(CHANNEL_VALUES)).max(10).optional(),
    permittedCurrencies: z.array(z.enum(CURRENCY_VALUES)).max(50).optional(),
    permittedFulfilmentMethods: z.array(z.enum(METHOD_VALUES)).max(10).optional(),
    permittedCustomerTypes: z.array(z.enum(CUSTOMER_TYPE_VALUES)).max(2).optional(),
    requiredResaleEvidenceKinds: z.array(z.enum(RESALE_KIND_VALUES)).max(20).optional(),
    requiredIdentifierSchemes: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    requireCountryOfOrigin: z.boolean().optional(),
    requireResponsibleOperator: z.boolean().optional(),
    requireDeterministicProductMatch: z.boolean().optional(),
    minimumMatchConfidence: z.number().min(0).max(1).optional(),
    maxQuantityPerOrder: z.number().int().min(1).max(10_000).optional(),
    // FLAT, not a nested `{ amount, currency }`: the retail-pricing schema's
    // `absorptionCapFloorMinor` / `absorptionCapFloorCurrency` precedent. A
    // nested object inside a `.strict()` zod schema infers its members as
    // OPTIONAL under this TypeScript configuration, which would let a
    // half-specified ceiling type-check its way to the repository.
    maxOrderValueMinor: minorUnits.optional(),
    maxOrderValueCurrency: z.enum(CURRENCY_VALUES).optional(),
    manualExceptionsPermitted: z.boolean().optional(),
    exceptionDualApprovalRequired: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine(
    (b) => (b.maxOrderValueMinor === undefined) === (b.maxOrderValueCurrency === undefined),
    { message: 'an order-value ceiling is an amount AND a currency, or neither' },
  );

/** Activating or retiring a version — an audited act, so a reason is mandatory. */
export const retailEligibilityPolicyDecisionSchema = z.object({ reason }).strict();

/** Recording one category's rule under one policy version. */
export const retailCategoryRuleSchema = z
  .object({
    policyId: z.string().trim().min(1),
    categoryKey: z.string().trim().min(1).max(200),
    admissibility: z.enum(ADMISSIBILITY_VALUES),
    requiredComplianceEvidenceKinds: z.array(z.enum(COMPLIANCE_KIND_VALUES)).max(30).optional(),
    requiresAgeAssurance: z.boolean().optional(),
    dangerousGoodsRestricted: z.boolean().optional(),
    requiresAuthorizedDealer: z.boolean().optional(),
    requiresBatchTraceability: z.boolean().optional(),
    reason,
  })
  .strict();

/** Recording one route's consumer, commercial and tax determination. */
export const retailMarketCapabilitySchema = z
  .object({
    policyId: z.string().trim().min(1),
    destinationCountry: countryCode,
    fulfilmentOriginCountry: countryCode,
    customerType: z.enum(CUSTOMER_TYPE_VALUES),
    cancellationBeforeFulfilmentSupported: z.boolean().optional(),
    statutoryWithdrawalSupported: z.boolean().optional(),
    legalGuaranteeSupported: z.boolean().optional(),
    returnsSupported: z.boolean().optional(),
    defectHandlingSupported: z.boolean().optional(),
    refundThroughOriginalRailSupported: z.boolean().optional(),
    invoiceIssuanceSupported: z.boolean().optional(),
    recallNotificationSupported: z.boolean().optional(),
    deliveryEstimateAvailable: z.boolean().optional(),
    supportLanguages: z.array(z.string().trim().min(2).max(35)).max(50).optional(),
    vatTreatment: z.enum(VAT_VALUES).optional(),
    sellerRegistrationRecorded: z.boolean().optional(),
    sellerRegistrationRef: z.string().trim().min(1).max(200).optional(),
    ossRelevant: z.boolean().optional(),
    iossRelevant: z.boolean().optional(),
    importerOfRecord: z.enum(RESPONSIBILITY_VALUES).optional(),
    dutyResponsibility: z.enum(RESPONSIBILITY_VALUES).optional(),
    priceFinality: z.enum(FINALITY_VALUES).optional(),
    /** FLAT — see `maxOrderValueMinor` on the policy schema above. */
    orderValueThresholdMinor: minorUnits.optional(),
    orderValueThresholdCurrency: z.enum(CURRENCY_VALUES).optional(),
    supplierInvoiceTaxNote: z.string().trim().max(2_000).optional(),
    customerInvoiceNote: z.string().trim().max(2_000).optional(),
    reason,
  })
  .strict()
  .refine(
    (b) =>
      (b.orderValueThresholdMinor === undefined) === (b.orderValueThresholdCurrency === undefined),
    { message: 'an order-value threshold is an amount AND a currency, or neither' },
  );

/** Where a document lives. At least one of the two, which the CHECK also demands. */
const documentRef = {
  oxyFileId: z.string().trim().min(1).max(200).optional(),
  documentUrl: z.string().trim().url().max(2_000).optional(),
  sha256: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};

/** Recording a piece of resale evidence. */
export const retailResaleEvidenceSchema = z
  .object({
    supplierId: z.string().trim().min(1),
    agreementId: z.string().trim().min(1).optional(),
    supplierAccountId: z.string().trim().min(1).optional(),
    kind: z.enum(RESALE_KIND_VALUES),
    scopeBrandKeys: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    scopeCategoryKeys: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    scopeSupplierSkus: z.array(z.string().trim().min(1).max(200)).max(1_000).optional(),
    scopeDestinationCountries: z.array(countryCode).max(250).optional(),
    issuedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    issuer: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(2_000).optional(),
    reason,
    ...documentRef,
  })
  .strict()
  .refine((body) => body.oxyFileId !== undefined || body.documentUrl !== undefined, {
    message: 'evidence must point at a stored file or a document location',
  });

/** Recording a compliance document. */
export const retailComplianceEvidenceSchema = z
  .object({
    supplierId: z.string().trim().min(1),
    canonicalProductId: z.string().trim().min(1).optional(),
    canonicalVariantId: z.string().trim().min(1).optional(),
    supplierSku: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(COMPLIANCE_KIND_VALUES),
    marketCountries: z.array(countryCode).max(250).optional(),
    documentVersion: z.string().trim().min(1).max(100).optional(),
    issuer: z.string().trim().min(1).max(200).optional(),
    issuedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    note: z.string().trim().max(2_000).optional(),
    reason,
    ...documentRef,
  })
  .strict()
  .refine((body) => body.oxyFileId !== undefined || body.documentUrl !== undefined, {
    message: 'evidence must point at a stored file or a document location',
  })
  .refine(
    (body) =>
      body.canonicalProductId !== undefined ||
      body.canonicalVariantId !== undefined ||
      body.supplierSku !== undefined,
    { message: 'a compliance document names a canonical product, a variant or a supplier SKU' },
  );

/** Verifying, rejecting or revoking a document — always with a reason. */
export const retailEvidenceDecisionSchema = z.object({ reason }).strict();

/** Raising a suppression, a recall included. */
export const retailSuppressionSchema = z
  .object({
    scope: z.enum(SUPPRESSION_SCOPE_VALUES),
    scopeRef: z.string().trim().min(1).max(200),
    kind: z.enum(SUPPRESSION_KIND_VALUES),
    severity: z.enum(SUPPRESSION_SEVERITY_VALUES),
    source: z.enum(SUPPRESSION_SOURCE_VALUES),
    externalReference: z.string().trim().min(1).max(200).optional(),
    effectiveFrom: z.string().datetime().optional(),
    reason,
  })
  .strict()
  // The CHECK refuses it too; refusing here says WHY, which a constraint error
  // never does: a recall that changes nothing is not a recall.
  .refine((body) => body.kind !== 'recall' || body.severity !== 'advisory', {
    message: 'a recall can never be advisory — it must stop sale',
  });

/** Lifting a suppression — the act that puts a product back on sale. */
export const retailSuppressionLiftSchema = z.object({ reason }).strict();

/** Requesting a manual exception. Only WAIVABLE reasons are on the wire. */
export const retailEligibilityExceptionSchema = z
  .object({
    policyId: z.string().trim().min(1),
    supplierId: z.string().trim().min(1),
    canonicalVariantId: z.string().trim().min(1).optional(),
    scopeDestinationCountries: z.array(countryCode).max(250).optional(),
    waivedReasons: z.array(z.enum(WAIVABLE_REASON_VALUES)).min(1).max(20),
    justification: z.string().trim().min(1).max(2_000),
    expiresAt: z.string().datetime(),
    reason,
  })
  .strict();

/** Approving, rejecting or revoking an exception — always with a reason. */
export const retailEligibilityExceptionDecisionSchema = z.object({ reason }).strict();

/**
 * The operator's what-if eligibility trace.
 *
 * The SAME contract `getRetailEligibility` takes, minus nothing: an operator
 * asking "why is this dark" must ask the exact question a buyer's checkout
 * would, or the answer is about a different combination. `.strict()` is what
 * stops a `force` or `bypass` field being smuggled in beside it.
 */
export const retailEligibilityTraceSchema = z
  .object({
    procurementOfferId: z.string().trim().min(1),
    canonicalVariantId: z.string().trim().min(1).optional(),
    channel: z.enum(CHANNEL_VALUES),
    destinationCountry: countryCode,
    currency: z.enum(CURRENCY_VALUES),
    quantity: z.number().int().min(1).max(10_000),
    /** FLAT — see `maxOrderValueMinor` on the policy schema above. */
    orderValueMinor: minorUnits.optional(),
    orderValueCurrency: z.enum(CURRENCY_VALUES).optional(),
    fulfilmentMethod: z.enum(METHOD_VALUES),
    customerType: z.enum(CUSTOMER_TYPE_VALUES),
    at: z.string().datetime().optional(),
  })
  .strict()
  .refine((b) => (b.orderValueMinor === undefined) === (b.orderValueCurrency === undefined), {
    message: 'an order value is an amount AND a currency, or neither',
  });

/**
 * The inferred body types.
 *
 * Exported so a controller states what it received instead of re-declaring the
 * shape — a hand-written duplicate of a schema is a second place for the two to
 * disagree, and the one that wins at runtime is the schema.
 */
export type RetailEligibilityPolicyCreateBody = z.infer<
  typeof retailEligibilityPolicyCreateSchema
>;
export type RetailCategoryRuleBody = z.infer<typeof retailCategoryRuleSchema>;
export type RetailMarketCapabilityBody = z.infer<typeof retailMarketCapabilitySchema>;
export type RetailResaleEvidenceBody = z.infer<typeof retailResaleEvidenceSchema>;
export type RetailComplianceEvidenceBody = z.infer<typeof retailComplianceEvidenceSchema>;
export type RetailSuppressionBody = z.infer<typeof retailSuppressionSchema>;
export type RetailEligibilityExceptionBody = z.infer<typeof retailEligibilityExceptionSchema>;
export type RetailEligibilityTraceBody = z.infer<typeof retailEligibilityTraceSchema>;
