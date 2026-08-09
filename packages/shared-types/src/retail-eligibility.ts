/**
 * Resale authorization, product compliance and market eligibility for
 * `mercaria_retail` (#121, ADR 0004 D2.8–D2.10, D12.3–D12.4).
 *
 * Mercaria is the SELLER on a `mercaria_retail` order (ADR 0004 D2.1). Before
 * one exists, Mercaria must be able to show it may resell that exact product
 * through that exact supplier into that exact market, and that it can meet the
 * product-safety, consumer, tax and operational obligations that come with
 * being the seller. This file is where those requirements stop being a checklist
 * and become a type system.
 *
 * ## The verdict is THREE-valued, and `unknown` is not a soft yes
 *
 * {@link RetailEligibilityVerdict} is `eligible | ineligible | unknown`, and
 * neither `ineligible` nor `unknown` may publish or check out. They are kept
 * apart because they call for different work: `ineligible` is a settled refusal
 * (an expired document, an excluded brand, a recall) and `unknown` is missing
 * evidence, which belongs in an operator queue. Collapsing them would either
 * hide a settled refusal in a backlog or make an unanswered question look like a
 * decision somebody made.
 *
 * ## An affiliate feed can never be resale authority, structurally
 *
 * {@link RetailResaleEvidenceKind} and {@link RetailForbiddenEvidenceKind} are
 * DISJOINT unions, exactly as `RetailCostComponentKind` and
 * `RetailForbiddenComponentKind` are in `./retail-pricing`. There is no column,
 * no DTO field and no request body that accepts a forbidden kind: the evidence
 * table's CHECK reads the allowed tuple, so an affiliate feed cannot be STORED
 * as resale evidence, let alone satisfy one. The forbidden union exists so a
 * REFUSAL can name what was attempted and why it proves nothing (ADR 0004
 * D2.10), rather than answering "unrecognized value".
 *
 * ## Expiry is derived from the clock, never stored
 *
 * {@link RetailEvidenceReviewState} is what a REVIEWER decided and is the only
 * thing stored. {@link RetailEvidenceState} adds `expired`, which is a function
 * of `expiresAt` and the clock — so an agreement or a certificate that ran out
 * overnight removes eligibility with no sweep having run (#121 acceptance 2),
 * and no stored state can disagree with the deadline beside it.
 *
 * ## What this file deliberately does NOT declare
 *
 * Any parameter, flag or field by which a caller could override a verdict. The
 * service contract takes facts and returns a verdict; the only thing that can
 * change one is DATA (an evidence row, a policy version, a recorded exception),
 * every piece of which is audited with a mandatory actor and reason.
 */

import type { CurrencyCode, Money } from './money';

/**
 * The verdict. Only `eligible` may publish a `mercaria_retail` offer or admit
 * one to checkout — `ineligible` and `unknown` both block (#121 acceptance 6).
 *
 *  - `eligible` — every dimension is answered affirmatively for this exact
 *    combination at this exact time.
 *  - `ineligible` — a dimension answered NO. A settled refusal.
 *  - `unknown` — a dimension could not be answered. Missing evidence, an
 *    unevaluated category, an unrecorded market capability.
 */
export type RetailEligibilityVerdict = 'eligible' | 'ineligible' | 'unknown';

/** {@link RetailEligibilityVerdict} as the tuple the column types and CHECKs read. */
export const RETAIL_ELIGIBILITY_VERDICTS: readonly RetailEligibilityVerdict[] = [
  'eligible',
  'ineligible',
  'unknown',
];

/**
 * How a customer receives the goods (#121 eligibility dimension 10). A policy
 * version names the methods it permits; a method outside that set is refused
 * before any cost is quoted.
 */
export type RetailFulfilmentMethod =
  | 'standard_delivery'
  | 'expedited_delivery'
  | 'freight_delivery'
  | 'collection_point';

/** {@link RetailFulfilmentMethod} as the tuple the element CHECKs read. */
export const RETAIL_FULFILMENT_METHODS: readonly RetailFulfilmentMethod[] = [
  'standard_delivery',
  'expedited_delivery',
  'freight_delivery',
  'collection_point',
];

/**
 * The customer distinction that has legal consequences (#121 dimension 11):
 * withdrawal rights, guarantee duration and VAT treatment all differ. Not a
 * marketing segment — the two values are the ones EU consumer law distinguishes.
 */
export type RetailCustomerType = 'consumer' | 'business';

/** {@link RetailCustomerType} as the tuple the element CHECKs read. */
export const RETAIL_CUSTOMER_TYPES: readonly RetailCustomerType[] = ['consumer', 'business'];

/* ------------------------------------------------------------------------- *
 * Resale authorization evidence
 * ------------------------------------------------------------------------- */

/**
 * What CAN evidence a right to resell (#121 "Resale authorization" 1–10).
 *
 * Every member is something a counterparty SIGNED, GRANTED or CONFIRMED in
 * writing. That is the property the set is built on, and it is why the
 * forbidden set below cannot simply be "the rest": a public product page and a
 * signed distributor authorization are not two strengths of one thing.
 *
 *  - `signed_supply_agreement` — the written supply contract itself (ADR 0004
 *    D2.10: nothing else can carry `mercaria_retail`).
 *  - `wholesale_account_confirmation` — the counterparty confirming a B2B
 *    account exists, with B2B invoicing.
 *  - `distributor_authorization` — an authorized-distributor statement.
 *  - `brand_authorization_letter` — the brand owner authorizing resale.
 *  - `dropship_addendum` — direct-to-customer fulfilment permission.
 *  - `blind_fulfilment_confirmation` — the supplier ships without its own
 *    invoice or pricing (ADR 0004 D2.3).
 *  - `marketplace_resale_permission` — permission to sell through Mercaria's
 *    own checkout and marketplace specifically.
 *  - `territory_grant` — destination and territory rights.
 *  - `brand_category_inclusion_schedule` — which brands, categories and SKUs
 *    are IN, as the contract schedules them.
 *  - `catalog_data_license` — image, description, specification and catalog
 *    data display rights.
 *  - `pricing_policy_acknowledgement` — the recorded resolution of a pricing
 *    restriction (MAP and similar).
 *  - `white_label_packing_confirmation` — packing-slip and invoice
 *    compatibility.
 */
export type RetailResaleEvidenceKind =
  | 'signed_supply_agreement'
  | 'wholesale_account_confirmation'
  | 'distributor_authorization'
  | 'brand_authorization_letter'
  | 'dropship_addendum'
  | 'blind_fulfilment_confirmation'
  | 'marketplace_resale_permission'
  | 'territory_grant'
  | 'brand_category_inclusion_schedule'
  | 'catalog_data_license'
  | 'pricing_policy_acknowledgement'
  | 'white_label_packing_confirmation';

/** {@link RetailResaleEvidenceKind} as the tuple the column types and CHECKs read. */
export const RETAIL_RESALE_EVIDENCE_KINDS: readonly RetailResaleEvidenceKind[] = [
  'signed_supply_agreement',
  'wholesale_account_confirmation',
  'distributor_authorization',
  'brand_authorization_letter',
  'dropship_addendum',
  'blind_fulfilment_confirmation',
  'marketplace_resale_permission',
  'territory_grant',
  'brand_category_inclusion_schedule',
  'catalog_data_license',
  'pricing_policy_acknowledgement',
  'white_label_packing_confirmation',
];

/**
 * The FOURTEEN things that are never resale authority (#121 acceptance 1, ADR
 * 0004 D2.10).
 *
 * This union is NOT a set of values anything stores — no column, no DTO field
 * and no request body accepts one, because the evidence table's `kind` CHECK
 * reads {@link RETAIL_RESALE_EVIDENCE_KINDS} and the two unions are disjoint by
 * construction. It exists so a refusal can name the exact thing that was
 * offered and say why it proves nothing: an operator who submits "we have API
 * access" is told that an API key is possession of a credential, not a grant of
 * rights, and that `mercaria_retail` requires a written agreement.
 *
 * The reasoning behind each is ADR 0004 D2.10 verbatim: an affiliate agreement
 * grants linking and commission rights; a public retail API's terms typically
 * prohibit commercial resale and automated purchasing for others; a consumer
 * account transacts under consumer terms, with no B2B invoice, no product-safety
 * traceability obligations accepted by the counterparty, and terminable without
 * notice.
 */
export type RetailForbiddenEvidenceKind =
  | 'affiliate_program_membership'
  | 'affiliate_product_feed'
  | 'public_product_page'
  | 'public_api_access'
  | 'api_key_possession'
  | 'consumer_account_capability'
  | 'placed_consumer_order'
  | 'marketplace_seller_account'
  | 'price_comparison_feed'
  | 'supplier_category_label'
  | 'supplier_logo_or_branding'
  | 'unverified_self_declaration'
  | 'screenshot_of_listing'
  | 'verbal_assurance';

/** {@link RetailForbiddenEvidenceKind} as a tuple, for exhaustive iteration. */
export const RETAIL_FORBIDDEN_EVIDENCE_KINDS: readonly RetailForbiddenEvidenceKind[] = [
  'affiliate_program_membership',
  'affiliate_product_feed',
  'public_product_page',
  'public_api_access',
  'api_key_possession',
  'consumer_account_capability',
  'placed_consumer_order',
  'marketplace_seller_account',
  'price_comparison_feed',
  'supplier_category_label',
  'supplier_logo_or_branding',
  'unverified_self_declaration',
  'screenshot_of_listing',
  'verbal_assurance',
];

/**
 * Why each forbidden kind proves nothing about a right to resell. Used verbatim
 * in the refusal, so the answer teaches the policy rather than citing a schema.
 */
export const RETAIL_FORBIDDEN_EVIDENCE_LABELS: Record<RetailForbiddenEvidenceKind, string> = {
  affiliate_program_membership:
    'membership of an affiliate program — an affiliate agreement grants linking and commission rights, never the right to resell or to place orders for third parties (ADR 0004 D2.10)',
  affiliate_product_feed:
    'access to an affiliate product feed — a feed is a catalogue of things to link to, and carries no supply, invoicing or fulfilment right',
  public_product_page:
    'a public product page — anybody can read one, so reading it distinguishes Mercaria from no one and grants nothing',
  public_api_access:
    "access to a public API — a public retail API's terms typically prohibit commercial resale and automated purchasing for others",
  api_key_possession:
    'possession of an API key — a credential is the ability to make a request, never a grant of the rights that request would exercise',
  consumer_account_capability:
    'the ability to place a consumer order — a consumer account transacts under consumer terms: quantity caps, personal-use clauses, no B2B invoice and no accepted traceability obligations, terminable without notice',
  placed_consumer_order:
    'having placed a consumer order — completing a purchase proves the shop sells to the public, not that Mercaria may resell what it bought',
  marketplace_seller_account:
    "a seller account on somebody else's marketplace — it authorizes selling THERE, under that platform's terms, and says nothing about Mercaria's own checkout",
  price_comparison_feed:
    'a price-comparison or aggregator feed — an observation of what a retailer charges, with no counterparty and no grant',
  supplier_category_label:
    "a supplier's own category label — a taxonomy string the supplier chose; compliance is never inferred from it (#121 \"Do not infer compliance from a supplier category label or logo\")",
  supplier_logo_or_branding:
    'a supplier logo or brand mark — a picture, reproducible by anyone, asserting nothing a counterparty agreed to',
  unverified_self_declaration:
    'an unverified self-declaration — a claim Mercaria made about itself is not evidence Mercaria may act on',
  screenshot_of_listing:
    'a screenshot of a listing — an image of a public page, which is the public page with a worse provenance',
  verbal_assurance:
    'a verbal assurance — nothing durable exists to review, renew, scope or revoke, so it can neither expire nor be relied on',
};

/**
 * What a category or market requires as SAFETY and regulatory evidence (#121
 * "Safety and regulatory evidence" 1–9). A category rule names the kinds it
 * requires; nothing here is inferred from a supplier's own label.
 */
export type RetailComplianceEvidenceKind =
  | 'ce_marking_declaration'
  | 'eu_declaration_of_conformity'
  | 'gpsr_traceability_pack'
  | 'safety_warnings_and_instructions'
  | 'age_restriction_statement'
  | 'battery_compliance'
  | 'electrical_safety_report'
  | 'radio_equipment_conformity'
  | 'toy_safety_certificate'
  | 'cosmetic_product_information_file'
  | 'food_contact_declaration'
  | 'responsible_person_details'
  | 'dangerous_goods_classification'
  | 'market_language_labelling'
  | 'recall_procedure_confirmation'
  | 'country_of_origin_declaration'
  | 'manufacturer_identity_declaration'
  | 'test_report'
  | 'other_category_specific';

/** {@link RetailComplianceEvidenceKind} as the tuple the column types and CHECKs read. */
export const RETAIL_COMPLIANCE_EVIDENCE_KINDS: readonly RetailComplianceEvidenceKind[] = [
  'ce_marking_declaration',
  'eu_declaration_of_conformity',
  'gpsr_traceability_pack',
  'safety_warnings_and_instructions',
  'age_restriction_statement',
  'battery_compliance',
  'electrical_safety_report',
  'radio_equipment_conformity',
  'toy_safety_certificate',
  'cosmetic_product_information_file',
  'food_contact_declaration',
  'responsible_person_details',
  'dangerous_goods_classification',
  'market_language_labelling',
  'recall_procedure_confirmation',
  'country_of_origin_declaration',
  'manufacturer_identity_declaration',
  'test_report',
  'other_category_specific',
];

/**
 * What a REVIEWER decided about a piece of evidence — and the ONLY thing stored.
 *
 *  - `unknown` — recorded, never looked at. The default, and it blocks.
 *  - `pending` — under review. Blocks: a document nobody has verified is not
 *    evidence yet.
 *  - `verified` — a named reviewer accepted it at a recorded time.
 *  - `revoked` — it was verified and has since been withdrawn.
 *  - `rejected` — a reviewer looked and refused it.
 *
 * `expired` is deliberately ABSENT: see {@link RetailEvidenceState}.
 */
export type RetailEvidenceReviewState = 'unknown' | 'pending' | 'verified' | 'revoked' | 'rejected';

/** {@link RetailEvidenceReviewState} as the tuple the column types and CHECKs read. */
export const RETAIL_EVIDENCE_REVIEW_STATES: readonly RetailEvidenceReviewState[] = [
  'unknown',
  'pending',
  'verified',
  'revoked',
  'rejected',
];

/**
 * The EFFECTIVE state of a piece of evidence — what a gate reads. The six states
 * #121 names, of which only the five above are storable.
 *
 * `expired` is a function of `expiresAt` and the clock, so it can never disagree
 * with the deadline beside it and needs no sweep to become true. That is what
 * makes #121 acceptance 2 ("expired agreement or compliance evidence removes
 * eligibility automatically") a property of the derivation rather than of a
 * cron job somebody has to keep running — the `deriveOfferFreshness` (#118) and
 * `deriveNativeCheckoutEligibility` (#57) rule, applied to documents.
 */
export type RetailEvidenceState = RetailEvidenceReviewState | 'expired';

/** {@link RetailEvidenceState} as the tuple derivations and DTOs read. */
export const RETAIL_EVIDENCE_STATES: readonly RetailEvidenceState[] = [
  'unknown',
  'pending',
  'verified',
  'revoked',
  'rejected',
  'expired',
];

/* ------------------------------------------------------------------------- *
 * Category admissibility, market capability and suppression
 * ------------------------------------------------------------------------- */

/**
 * What a policy version says about one category (#121 "Prohibited and
 * restricted products").
 *
 * A category with NO rule row under the active version is not a member of this
 * union: it is unevaluated, which answers `unknown` and blocks (ADR 0004 D12.3
 * — an unevaluated category is ineligible by default; reporting it as `unknown`
 * is what routes it to the review queue instead of reading as a decision
 * somebody made).
 */
export type RetailCategoryAdmissibility = 'permitted' | 'prohibited' | 'requires_approval';

/** {@link RetailCategoryAdmissibility} as the tuple the column types and CHECKs read. */
export const RETAIL_CATEGORY_ADMISSIBILITIES: readonly RetailCategoryAdmissibility[] = [
  'permitted',
  'prohibited',
  'requires_approval',
];

/**
 * How the destination taxes this route (#121 "Tax and cross-border gate").
 * `not_determined` is a RECORDED finding — Mercaria looked and could not
 * conclude — and is different from having no row for the route at all. Both
 * block; only one of them means somebody has already tried.
 */
export type RetailVatTreatment =
  | 'destination_vat_oss'
  | 'domestic_vat'
  | 'reverse_charge'
  | 'zero_rated'
  | 'not_determined';

/** {@link RetailVatTreatment} as the tuple the column types and CHECKs read. */
export const RETAIL_VAT_TREATMENTS: readonly RetailVatTreatment[] = [
  'destination_vat_oss',
  'domestic_vat',
  'reverse_charge',
  'zero_rated',
  'not_determined',
];

/**
 * Who carries the import / duty obligation on this route. `undetermined` blocks;
 * `not_applicable` is the launch answer for an intra-EU route (ADR 0004 D2.9),
 * and it is a determination somebody recorded rather than an empty column.
 */
export type RetailCrossBorderResponsibility =
  | 'not_applicable'
  | 'mercaria'
  | 'customer'
  | 'supplier'
  | 'undetermined';

/** {@link RetailCrossBorderResponsibility} as the tuple the column types and CHECKs read. */
export const RETAIL_CROSS_BORDER_RESPONSIBILITIES: readonly RetailCrossBorderResponsibility[] = [
  'not_applicable',
  'mercaria',
  'customer',
  'supplier',
  'undetermined',
];

/**
 * Whether the displayed price can be claimed FINAL on this route (#121: "Do not
 * publish `all taxes included` or `no additional fees` unless the exact route
 * supports it").
 *
 * `additional_charges_possible` does NOT block — it is a determination, and a
 * route where charges may apply is sellable as long as that is disclosed. What
 * it forbids is the CLAIM, which is why the value travels on the verdict for
 * #129 to render rather than being folded into the boolean.
 */
export type RetailPriceFinality = 'final' | 'additional_charges_possible' | 'undetermined';

/** {@link RetailPriceFinality} as the tuple the column types and CHECKs read. */
export const RETAIL_PRICE_FINALITIES: readonly RetailPriceFinality[] = [
  'final',
  'additional_charges_possible',
  'undetermined',
];

/** What a suppression covers (#121 "Recall and emergency controls" 7). */
export type RetailSuppressionScope =
  | 'supplier'
  | 'supplier_account'
  | 'canonical_product'
  | 'canonical_variant'
  | 'supplier_sku'
  | 'category'
  | 'market'
  | 'brand';

/** {@link RetailSuppressionScope} as the tuple the column types and CHECKs read. */
export const RETAIL_SUPPRESSION_SCOPES: readonly RetailSuppressionScope[] = [
  'supplier',
  'supplier_account',
  'canonical_product',
  'canonical_variant',
  'supplier_sku',
  'category',
  'market',
  'brand',
];

/** Why a suppression exists. A `recall` can never be advisory — a CHECK holds it. */
export type RetailSuppressionKind = 'recall' | 'safety_notice' | 'kill_switch' | 'policy_exclusion';

/** {@link RetailSuppressionKind} as the tuple the column types and CHECKs read. */
export const RETAIL_SUPPRESSION_KINDS: readonly RetailSuppressionKind[] = [
  'recall',
  'safety_notice',
  'kill_switch',
  'policy_exclusion',
];

/** Who raised it — an authority notice and an operator hunch are not one fact. */
export type RetailSuppressionSource = 'supplier' | 'authority' | 'operator' | 'internal_monitoring';

/** {@link RetailSuppressionSource} as the tuple the column types and CHECKs read. */
export const RETAIL_SUPPRESSION_SOURCES: readonly RetailSuppressionSource[] = [
  'supplier',
  'authority',
  'operator',
  'internal_monitoring',
];

/**
 * How hard a suppression bites.
 *
 *  - `advisory` — recorded, visible, and does NOT block. A safety notice that
 *    is not a stop-sale must not silently delist a catalogue.
 *  - `stop_sale` — no new publication and no new checkout, immediately.
 *  - `stop_sale_and_recover` — the above, plus in-flight orders and purchase
 *    orders need operator action (#127 owns the recovery itself).
 *
 * A `recall` may never be `advisory`, by CHECK: the one combination that would
 * turn "recorded a recall" into "changed nothing" is unrepresentable.
 */
export type RetailSuppressionSeverity = 'advisory' | 'stop_sale' | 'stop_sale_and_recover';

/** {@link RetailSuppressionSeverity} as the tuple the column types and CHECKs read. */
export const RETAIL_SUPPRESSION_SEVERITIES: readonly RetailSuppressionSeverity[] = [
  'advisory',
  'stop_sale',
  'stop_sale_and_recover',
];

/** The severities that STOP a sale — read by the derivation, not re-listed there. */
export const RETAIL_BLOCKING_SUPPRESSION_SEVERITIES: readonly RetailSuppressionSeverity[] = [
  'stop_sale',
  'stop_sale_and_recover',
];

/* ------------------------------------------------------------------------- *
 * Reasons, actions and their verdict mapping
 * ------------------------------------------------------------------------- */

/**
 * Why a combination is not eligible — the closed, explainable reason set every
 * verdict carries, sorted and deduped so two derivations of one situation are
 * byte-identical (the moderation-envelope determinism rule, applied to a gate).
 *
 * Grouped by the #121 dimension each belongs to. Every member appears in
 * {@link RETAIL_ELIGIBILITY_REASON_VERDICT} and in
 * {@link RETAIL_ELIGIBILITY_REASON_ACTION}, and a test fails the build if one
 * does not — a reason with no verdict contribution could silently drop out of
 * the answer.
 */
export type RetailEligibilityReason =
  // Policy scope and supply chain
  | 'policy_missing'
  | 'supply_chain_ineligible'
  | 'destination_not_permitted'
  | 'fulfilment_origin_not_permitted'
  | 'channel_not_permitted'
  | 'currency_not_permitted'
  | 'customer_type_not_permitted'
  | 'fulfilment_method_not_permitted'
  | 'quantity_above_limit'
  | 'order_value_above_limit'
  // Resale authorization
  | 'resale_evidence_missing'
  | 'resale_evidence_unverified'
  | 'resale_evidence_expired'
  | 'resale_evidence_revoked'
  | 'resale_evidence_rejected'
  | 'resale_evidence_out_of_scope'
  | 'catalog_data_rights_missing'
  | 'pricing_restriction_unresolved'
  | 'brand_excluded_by_agreement'
  | 'category_excluded_by_agreement'
  | 'sku_excluded_by_agreement'
  // Product identity and traceability
  | 'product_mapping_missing'
  | 'product_mapping_ambiguous'
  | 'product_identifier_missing'
  | 'brand_identity_missing'
  | 'country_of_origin_missing'
  | 'responsible_operator_missing'
  | 'traceability_capability_missing'
  // Safety and regulatory evidence
  | 'compliance_evidence_missing'
  | 'compliance_evidence_unverified'
  | 'compliance_evidence_expired'
  | 'compliance_evidence_revoked'
  | 'compliance_evidence_rejected'
  | 'compliance_evidence_market_mismatch'
  // Prohibited and restricted products
  | 'category_not_evaluated'
  | 'category_prohibited'
  | 'category_requires_approval'
  | 'age_assurance_unavailable'
  | 'dangerous_goods_restricted'
  | 'product_recalled'
  | 'product_suppressed'
  | 'supplier_suppressed'
  | 'category_suppressed'
  | 'market_suppressed'
  | 'brand_suppressed'
  // Consumer and commercial capability
  | 'market_capability_unknown'
  | 'cancellation_unsupported'
  | 'withdrawal_unsupported'
  | 'guarantee_unsupported'
  | 'returns_unsupported'
  | 'defect_handling_unsupported'
  | 'support_language_unavailable'
  | 'refund_rail_unavailable'
  | 'invoice_issuance_unavailable'
  | 'recall_notification_unavailable'
  | 'delivery_estimate_unavailable'
  // Tax and cross-border
  | 'tax_treatment_unknown'
  | 'tax_registration_missing'
  | 'importer_of_record_unresolved'
  | 'duty_responsibility_unresolved';

/** {@link RetailEligibilityReason} as the tuple the column types and CHECKs read. */
export const RETAIL_ELIGIBILITY_REASONS: readonly RetailEligibilityReason[] = [
  'policy_missing',
  'supply_chain_ineligible',
  'destination_not_permitted',
  'fulfilment_origin_not_permitted',
  'channel_not_permitted',
  'currency_not_permitted',
  'customer_type_not_permitted',
  'fulfilment_method_not_permitted',
  'quantity_above_limit',
  'order_value_above_limit',
  'resale_evidence_missing',
  'resale_evidence_unverified',
  'resale_evidence_expired',
  'resale_evidence_revoked',
  'resale_evidence_rejected',
  'resale_evidence_out_of_scope',
  'catalog_data_rights_missing',
  'pricing_restriction_unresolved',
  'brand_excluded_by_agreement',
  'category_excluded_by_agreement',
  'sku_excluded_by_agreement',
  'product_mapping_missing',
  'product_mapping_ambiguous',
  'product_identifier_missing',
  'brand_identity_missing',
  'country_of_origin_missing',
  'responsible_operator_missing',
  'traceability_capability_missing',
  'compliance_evidence_missing',
  'compliance_evidence_unverified',
  'compliance_evidence_expired',
  'compliance_evidence_revoked',
  'compliance_evidence_rejected',
  'compliance_evidence_market_mismatch',
  'category_not_evaluated',
  'category_prohibited',
  'category_requires_approval',
  'age_assurance_unavailable',
  'dangerous_goods_restricted',
  'product_recalled',
  'product_suppressed',
  'supplier_suppressed',
  'category_suppressed',
  'market_suppressed',
  'brand_suppressed',
  'market_capability_unknown',
  'cancellation_unsupported',
  'withdrawal_unsupported',
  'guarantee_unsupported',
  'returns_unsupported',
  'defect_handling_unsupported',
  'support_language_unavailable',
  'refund_rail_unavailable',
  'invoice_issuance_unavailable',
  'recall_notification_unavailable',
  'delivery_estimate_unavailable',
  'tax_treatment_unknown',
  'tax_registration_missing',
  'importer_of_record_unresolved',
  'duty_responsibility_unresolved',
];

/**
 * What each reason CONTRIBUTES to the verdict — a TABLE, not a switch, the
 * `claim-methods.ts` device (#83).
 *
 * The distinction is exactly one question: did Mercaria establish a NO, or did
 * it fail to establish a YES? Everything expired, revoked, rejected, excluded,
 * prohibited, recalled, suppressed, ambiguous or over a limit is a settled
 * refusal. Everything missing, unverified, unevaluated, unresolved or
 * unavailable is an unanswered question.
 *
 * Both block. They are kept apart because they route differently: an `unknown`
 * belongs in the evidence queue (#121 operations 2), an `ineligible` belongs in
 * a report of what Mercaria has decided not to sell.
 */
export const RETAIL_ELIGIBILITY_REASON_VERDICT: Record<
  RetailEligibilityReason,
  Exclude<RetailEligibilityVerdict, 'eligible'>
> = {
  policy_missing: 'unknown',
  supply_chain_ineligible: 'ineligible',
  destination_not_permitted: 'ineligible',
  fulfilment_origin_not_permitted: 'ineligible',
  channel_not_permitted: 'ineligible',
  currency_not_permitted: 'ineligible',
  customer_type_not_permitted: 'ineligible',
  fulfilment_method_not_permitted: 'ineligible',
  quantity_above_limit: 'ineligible',
  order_value_above_limit: 'ineligible',
  resale_evidence_missing: 'unknown',
  resale_evidence_unverified: 'unknown',
  resale_evidence_expired: 'ineligible',
  resale_evidence_revoked: 'ineligible',
  resale_evidence_rejected: 'ineligible',
  resale_evidence_out_of_scope: 'ineligible',
  catalog_data_rights_missing: 'ineligible',
  pricing_restriction_unresolved: 'unknown',
  brand_excluded_by_agreement: 'ineligible',
  category_excluded_by_agreement: 'ineligible',
  sku_excluded_by_agreement: 'ineligible',
  product_mapping_missing: 'unknown',
  product_mapping_ambiguous: 'ineligible',
  product_identifier_missing: 'unknown',
  brand_identity_missing: 'unknown',
  country_of_origin_missing: 'unknown',
  responsible_operator_missing: 'unknown',
  traceability_capability_missing: 'unknown',
  compliance_evidence_missing: 'unknown',
  compliance_evidence_unverified: 'unknown',
  compliance_evidence_expired: 'ineligible',
  compliance_evidence_revoked: 'ineligible',
  compliance_evidence_rejected: 'ineligible',
  compliance_evidence_market_mismatch: 'ineligible',
  category_not_evaluated: 'unknown',
  category_prohibited: 'ineligible',
  category_requires_approval: 'unknown',
  age_assurance_unavailable: 'ineligible',
  dangerous_goods_restricted: 'ineligible',
  product_recalled: 'ineligible',
  product_suppressed: 'ineligible',
  supplier_suppressed: 'ineligible',
  category_suppressed: 'ineligible',
  market_suppressed: 'ineligible',
  brand_suppressed: 'ineligible',
  market_capability_unknown: 'unknown',
  cancellation_unsupported: 'ineligible',
  withdrawal_unsupported: 'ineligible',
  guarantee_unsupported: 'ineligible',
  returns_unsupported: 'ineligible',
  defect_handling_unsupported: 'ineligible',
  support_language_unavailable: 'ineligible',
  refund_rail_unavailable: 'ineligible',
  invoice_issuance_unavailable: 'ineligible',
  recall_notification_unavailable: 'ineligible',
  delivery_estimate_unavailable: 'ineligible',
  tax_treatment_unknown: 'unknown',
  tax_registration_missing: 'unknown',
  importer_of_record_unresolved: 'unknown',
  duty_responsibility_unresolved: 'unknown',
};

/**
 * What has to happen next, as a bounded value rather than a sentence (#121
 * service contract: "the response includes … next required action").
 *
 * `not_available` is the honest terminal answer: nothing an operator can do
 * makes this combination sellable under the current policy — a prohibited
 * category, a destination the policy does not cover, a supplier the agreement
 * excludes. Reporting it as "collect more evidence" would send somebody looking
 * for a document that would change nothing.
 */
export type RetailEligibilityAction =
  | 'none'
  | 'collect_resale_evidence'
  | 'verify_resale_evidence'
  | 'renew_resale_evidence'
  | 'collect_compliance_evidence'
  | 'verify_compliance_evidence'
  | 'renew_compliance_evidence'
  | 'resolve_product_match'
  | 'record_product_traceability'
  | 'evaluate_category'
  | 'record_market_capability'
  | 'determine_tax_treatment'
  | 'lift_suppression'
  | 'operator_review'
  | 'not_available';

/** {@link RetailEligibilityAction} as the tuple the column types and CHECKs read. */
export const RETAIL_ELIGIBILITY_ACTIONS: readonly RetailEligibilityAction[] = [
  'none',
  'collect_resale_evidence',
  'verify_resale_evidence',
  'renew_resale_evidence',
  'collect_compliance_evidence',
  'verify_compliance_evidence',
  'renew_compliance_evidence',
  'resolve_product_match',
  'record_product_traceability',
  'evaluate_category',
  'record_market_capability',
  'determine_tax_treatment',
  'lift_suppression',
  'operator_review',
  'not_available',
];

/**
 * The action each reason calls for. A TABLE for the same reason the verdict map
 * is one: the mapping is policy, and policy in a `switch` drifts from policy in
 * a document.
 */
export const RETAIL_ELIGIBILITY_REASON_ACTION: Record<
  RetailEligibilityReason,
  RetailEligibilityAction
> = {
  policy_missing: 'operator_review',
  supply_chain_ineligible: 'operator_review',
  destination_not_permitted: 'not_available',
  fulfilment_origin_not_permitted: 'not_available',
  channel_not_permitted: 'not_available',
  currency_not_permitted: 'not_available',
  customer_type_not_permitted: 'not_available',
  fulfilment_method_not_permitted: 'not_available',
  quantity_above_limit: 'not_available',
  order_value_above_limit: 'not_available',
  resale_evidence_missing: 'collect_resale_evidence',
  resale_evidence_unverified: 'verify_resale_evidence',
  resale_evidence_expired: 'renew_resale_evidence',
  resale_evidence_revoked: 'collect_resale_evidence',
  resale_evidence_rejected: 'collect_resale_evidence',
  resale_evidence_out_of_scope: 'collect_resale_evidence',
  catalog_data_rights_missing: 'collect_resale_evidence',
  pricing_restriction_unresolved: 'collect_resale_evidence',
  brand_excluded_by_agreement: 'not_available',
  category_excluded_by_agreement: 'not_available',
  sku_excluded_by_agreement: 'not_available',
  product_mapping_missing: 'resolve_product_match',
  product_mapping_ambiguous: 'resolve_product_match',
  product_identifier_missing: 'record_product_traceability',
  brand_identity_missing: 'record_product_traceability',
  country_of_origin_missing: 'record_product_traceability',
  responsible_operator_missing: 'record_product_traceability',
  traceability_capability_missing: 'record_product_traceability',
  compliance_evidence_missing: 'collect_compliance_evidence',
  compliance_evidence_unverified: 'verify_compliance_evidence',
  compliance_evidence_expired: 'renew_compliance_evidence',
  compliance_evidence_revoked: 'collect_compliance_evidence',
  compliance_evidence_rejected: 'collect_compliance_evidence',
  compliance_evidence_market_mismatch: 'collect_compliance_evidence',
  category_not_evaluated: 'evaluate_category',
  category_prohibited: 'not_available',
  category_requires_approval: 'operator_review',
  age_assurance_unavailable: 'not_available',
  dangerous_goods_restricted: 'not_available',
  product_recalled: 'lift_suppression',
  product_suppressed: 'lift_suppression',
  supplier_suppressed: 'lift_suppression',
  category_suppressed: 'lift_suppression',
  market_suppressed: 'lift_suppression',
  brand_suppressed: 'lift_suppression',
  market_capability_unknown: 'record_market_capability',
  cancellation_unsupported: 'record_market_capability',
  withdrawal_unsupported: 'record_market_capability',
  guarantee_unsupported: 'record_market_capability',
  returns_unsupported: 'record_market_capability',
  defect_handling_unsupported: 'record_market_capability',
  support_language_unavailable: 'record_market_capability',
  refund_rail_unavailable: 'record_market_capability',
  invoice_issuance_unavailable: 'record_market_capability',
  recall_notification_unavailable: 'record_market_capability',
  delivery_estimate_unavailable: 'record_market_capability',
  tax_treatment_unknown: 'determine_tax_treatment',
  tax_registration_missing: 'determine_tax_treatment',
  importer_of_record_unresolved: 'determine_tax_treatment',
  duty_responsibility_unresolved: 'determine_tax_treatment',
};

/**
 * The order the next required action is picked in, most actionable FIRST.
 *
 * A combination usually fails several ways at once, and an operator can only do
 * one thing next. Reporting `not_available` while a document is merely missing
 * would end the investigation; reporting `collect_compliance_evidence` while
 * the category is prohibited would waste it. So the order runs from "this is
 * settled and no work changes it" through the concrete collection tasks —
 * except that `not_available` is picked FIRST, because when it applies nothing
 * else is worth doing.
 */
export const RETAIL_ELIGIBILITY_ACTION_PRIORITY: readonly RetailEligibilityAction[] = [
  'not_available',
  'lift_suppression',
  'resolve_product_match',
  'evaluate_category',
  'renew_resale_evidence',
  'renew_compliance_evidence',
  'verify_resale_evidence',
  'verify_compliance_evidence',
  'collect_resale_evidence',
  'collect_compliance_evidence',
  'record_product_traceability',
  'determine_tax_treatment',
  'record_market_capability',
  'operator_review',
  'none',
];

/* ------------------------------------------------------------------------- *
 * The service contract
 * ------------------------------------------------------------------------- */

/**
 * The exact combination being asked about — #121's twelve eligibility
 * dimensions, in one value.
 *
 * Every field is a FACT about the question, and there is deliberately no
 * `force`, `skip`, `assumeEligible` or `overrideReasons` member: a client
 * cannot override the answer because there is nothing on the wire that could
 * (#121 service contract: "Clients cannot override it").
 */
export interface RetailEligibilityQuery {
  /** Dimensions 1–3: the supplier offer, which names supplier, account and agreement. */
  procurementOfferId: string;
  /** Dimension 3, restated by the caller — a mismatch with the offer's own mapping is refused. */
  canonicalVariantId?: string;
  /** Dimension 7: which Mercaria channel the offer would surface on. */
  channel: string;
  /** Dimension 6: ISO-3166-1 alpha-2 customer destination. */
  destinationCountry: string;
  /** Dimension 8: the presentment currency the buyer would be charged in. */
  currency: CurrencyCode;
  /** Dimension 9: how many units. */
  quantity: number;
  /** Dimension 9: the order value, when the caller already knows it (#120's quote). */
  orderValue?: Money;
  /** Dimension 10. */
  fulfilmentMethod: RetailFulfilmentMethod;
  /** Dimension 11. */
  customerType: RetailCustomerType;
  /** Dimension 12: the effective time. Defaults to now; a policy version is picked for it. */
  at?: string;
}

/**
 * One piece of evidence the verdict RESTED on — the reference #121's service
 * contract requires beside the reasons.
 *
 * Carries the state and the deadline, never the document: a verdict is read by
 * surfaces that have no business seeing a signed contract, and a type with no
 * document field cannot leak one (the `RetailOfferSourcingSeam` device).
 */
export interface RetailEligibilityEvidenceRef {
  /** `resale` or `compliance` — which registry the row lives in. */
  registry: 'resale' | 'compliance';
  id: string;
  kind: RetailResaleEvidenceKind | RetailComplianceEvidenceKind;
  /** The EFFECTIVE state, expiry included — see {@link RetailEvidenceState}. */
  state: RetailEvidenceState;
  /** ISO-8601. Absent = no deadline. */
  expiresAt?: string;
}

/**
 * The tax and cross-border determination the verdict was made under, carried so
 * #120's quote and #129's presentation state the same thing the gate did.
 */
export interface RetailTaxDetermination {
  vatTreatment: RetailVatTreatment;
  importerOfRecord: RetailCrossBorderResponsibility;
  dutyResponsibility: RetailCrossBorderResponsibility;
  priceFinality: RetailPriceFinality;
  /** Whether Mercaria holds the registration this route needs. */
  sellerRegistrationRecorded: boolean;
}

/**
 * The authoritative answer. Publication (#57/#129), search, cart and checkout
 * (#123) all read THIS, and none of them may compose their own.
 *
 * `policyId` + `policyKey` + `policyVersion` are what make the answer
 * reproducible (#121 acceptance 7): re-running the derivation against the same
 * policy version and the same evidence rows yields the same verdict, and
 * `contentHash` pins the composition so a later read can prove it.
 */
export interface RetailEligibilityResult {
  verdict: RetailEligibilityVerdict;
  /** Sorted and deduped. Empty exactly when the verdict is `eligible`. */
  reasons: RetailEligibilityReason[];
  /** What to do next. `none` exactly when the verdict is `eligible`. */
  nextRequiredAction: RetailEligibilityAction;
  /** Every evidence row the verdict rested on, in a stable order. */
  evidence: RetailEligibilityEvidenceRef[];
  /** #118's own explainable supply-side reasons, verbatim — never restated here. */
  supplyReasons: string[];
  /** The policy version this answer was derived under. Absent = no active version. */
  policyId?: string;
  policyKey?: string;
  policyVersion?: number;
  /** The tax determination, when a market-capability row answered the route. */
  tax?: RetailTaxDetermination;
  /** ISO-8601 — the instant the derivation read the clock at. */
  evaluatedAt: string;
  /** sha-256 over the canonical composition of query, policy and outcome. */
  contentHash: string;
}

/**
 * One versioned eligibility policy, as the operator surface shows it.
 *
 * Note what is absent: no `bypass`, no `default_verdict`, no "treat unknown as
 * eligible" lever. The only levers widen or narrow what is PERMITTED, and every
 * one of them starts closed — an empty destination list permits no destination,
 * which is the `supplier_agreements` grant semantics rather than
 * `commerce_relationships`' scoped-down one.
 */
export interface RetailEligibilityPolicySummary {
  policyKey: string;
  version: number;
  name: string;
  summary: string;
  status: 'draft' | 'active' | 'superseded' | 'retired';
  effectiveStart: string;
  effectiveEnd?: string;
  permittedDestinationCountries: string[];
  permittedFulfilmentOriginCountries: string[];
  permittedChannels: string[];
  permittedCurrencies: CurrencyCode[];
  permittedFulfilmentMethods: RetailFulfilmentMethod[];
  permittedCustomerTypes: RetailCustomerType[];
  requiredResaleEvidenceKinds: RetailResaleEvidenceKind[];
  requiredIdentifierSchemes: string[];
  requireCountryOfOrigin: boolean;
  requireResponsibleOperator: boolean;
  requireDeterministicProductMatch: boolean;
  /** Below this, a machine-matched mapping is AMBIGUOUS and routes to #59. */
  minimumMatchConfidence: number;
  maxQuantityPerOrder: number;
  maxOrderValue?: Money;
  manualExceptionsPermitted: boolean;
  exceptionDualApprovalRequired: boolean;
  createdAt: string;
  activatedAt?: string;
}

/** {@link RetailEligibilityPolicySummary.status} as the tuple the CHECKs read. */
export const RETAIL_ELIGIBILITY_POLICY_STATUSES: readonly RetailEligibilityPolicySummary['status'][] =
  ['draft', 'active', 'superseded', 'retired'];

/**
 * What an audited eligibility act WAS (#121 operations 3: "Audit every approval,
 * rejection and override"). Append-only, one row per attempt, with a mandatory
 * actor and reason — the `payment_repairs` shape.
 */
export type RetailEligibilityAuditAction =
  | 'policy_drafted'
  | 'policy_activated'
  | 'policy_retired'
  | 'category_rule_recorded'
  | 'market_capability_recorded'
  | 'resale_evidence_recorded'
  | 'resale_evidence_verified'
  | 'resale_evidence_rejected'
  | 'resale_evidence_revoked'
  | 'compliance_evidence_recorded'
  | 'compliance_evidence_verified'
  | 'compliance_evidence_rejected'
  | 'compliance_evidence_revoked'
  | 'suppression_raised'
  | 'suppression_lifted'
  | 'exception_requested'
  | 'exception_approved'
  | 'exception_rejected'
  | 'exception_revoked';

/** {@link RetailEligibilityAuditAction} as the tuple the column types and CHECKs read. */
export const RETAIL_ELIGIBILITY_AUDIT_ACTIONS: readonly RetailEligibilityAuditAction[] = [
  'policy_drafted',
  'policy_activated',
  'policy_retired',
  'category_rule_recorded',
  'market_capability_recorded',
  'resale_evidence_recorded',
  'resale_evidence_verified',
  'resale_evidence_rejected',
  'resale_evidence_revoked',
  'compliance_evidence_recorded',
  'compliance_evidence_verified',
  'compliance_evidence_rejected',
  'compliance_evidence_revoked',
  'suppression_raised',
  'suppression_lifted',
  'exception_requested',
  'exception_approved',
  'exception_rejected',
  'exception_revoked',
];

/**
 * The lifecycle of a manual exception (#121 operations 4).
 *
 * `approved` is the only state that changes a verdict, and reaching it needs
 * two DISTINCT operators whenever the policy version says so — held by a
 * partial unique index on the approval rows, not by a service comparison (the
 * `relationship_reviews` four-eyes device).
 */
export type RetailExceptionState = 'requested' | 'approved' | 'rejected' | 'revoked' | 'expired';

/** The exception states that are STORED — `expired` is derived from the clock. */
export const RETAIL_EXCEPTION_STORED_STATES: readonly Exclude<
  RetailExceptionState,
  'expired'
>[] = ['requested', 'approved', 'rejected', 'revoked'];

/** {@link RetailExceptionState} as the tuple derivations and DTOs read. */
export const RETAIL_EXCEPTION_STATES: readonly RetailExceptionState[] = [
  'requested',
  'approved',
  'rejected',
  'revoked',
  'expired',
];

/**
 * The reasons an approved exception may waive. Deliberately a SUBSET of
 * {@link RetailEligibilityReason}, and deliberately not all of them: no
 * exception can waive a recall, a suppression, a prohibited category or an
 * unresolved product match, because those are the refusals a person under
 * pressure would most want to wave through.
 */
export const RETAIL_WAIVABLE_REASONS: readonly RetailEligibilityReason[] = [
  'category_requires_approval',
  'pricing_restriction_unresolved',
  'product_identifier_missing',
  'country_of_origin_missing',
  'responsible_operator_missing',
  'traceability_capability_missing',
  'delivery_estimate_unavailable',
];

/**
 * The reasons NO exception may ever waive — stated positively so the refusal
 * can name them, and disjoint from {@link RETAIL_WAIVABLE_REASONS} by a test.
 *
 * The set is chosen by consequence, not by severity: waiving any of these
 * either puts an unsafe product in a buyer's hands, sells something Mercaria
 * has no right to sell, or charges for obligations Mercaria cannot meet.
 */
export const RETAIL_UNWAIVABLE_REASONS: readonly RetailEligibilityReason[] = [
  'product_recalled',
  'product_suppressed',
  'supplier_suppressed',
  'category_suppressed',
  'market_suppressed',
  'brand_suppressed',
  'category_prohibited',
  'product_mapping_ambiguous',
  'resale_evidence_missing',
  'resale_evidence_expired',
  'resale_evidence_revoked',
  'resale_evidence_rejected',
  'resale_evidence_out_of_scope',
  'compliance_evidence_missing',
  'compliance_evidence_expired',
  'compliance_evidence_revoked',
  'compliance_evidence_rejected',
  'compliance_evidence_market_mismatch',
  'age_assurance_unavailable',
  'dangerous_goods_restricted',
  'brand_excluded_by_agreement',
  'category_excluded_by_agreement',
  'sku_excluded_by_agreement',
  'supply_chain_ineligible',
  'tax_treatment_unknown',
  'refund_rail_unavailable',
  'withdrawal_unsupported',
  'guarantee_unsupported',
  'returns_unsupported',
];
