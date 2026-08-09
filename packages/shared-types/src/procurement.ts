/**
 * Procurement DTOs — the private supply side of Mercaria retail (#118).
 *
 * Every closed value set the procurement domain uses is declared HERE, once, as
 * a `readonly` tuple plus the union derived from it — the `payment.ts`
 * convention. The Postgres CHECK constraints, the drizzle column types and the
 * service-level guards all read these same tuples.
 *
 * ## The boundary this file exists to hold
 *
 * A supplier is a B2B counterparty Mercaria BUYS from (ADR 0004 D2.2). It is
 * never a customer-facing seller, never a payment counterparty of the customer
 * rail, and creating one grants no public merchant page and no official-brand
 * status (ADR 0002 keeps those in the canonical commerce graph, behind
 * evidence). Nothing in this file names a Stripe object, a payment status or a
 * customer identity — the payment domain and the procurement domain are
 * DECOUPLED by construction, and the two projection types at the bottom are the
 * only shapes that ever cross toward a public surface.
 *
 * ## What this file deliberately does NOT declare
 *
 * Full entity DTO interfaces (a `Supplier` DTO, a `PurchaseOrder` DTO). No HTTP
 * surface serves them in #118 — the domain is internal services over drizzle
 * row types — and a DTO nothing can produce or consume is the "value in
 * advance" trap `payment.ts` warns about. They arrive with the surface that
 * renders them. The two projections that DO exist here exist because their
 * SHAPE is the security property: a type with no cost field cannot leak one.
 */

/** What kind of supply relationship a supplier is (#118 supplier model 7). */
export type SupplierType =
  | 'wholesaler'
  | 'dropship_distributor'
  | 'manufacturer_direct'
  | 'print_on_demand'
  | 'fulfilment_partner';

/** {@link SupplierType} as the tuple the column types and CHECKs read. */
export const SUPPLIER_TYPES: readonly SupplierType[] = [
  'wholesaler',
  'dropship_distributor',
  'manufacturer_direct',
  'print_on_demand',
  'fulfilment_partner',
];

/**
 * A supplier's lifecycle. One stored verdict, no boolean beside it — the
 * `provider_accounts.onboarding_state` precedent.
 *
 * `merged` is a tombstone: the row survives with `mergedIntoId` pointing at the
 * winner, and historical purchase orders keep naming it (a merge can never
 * rewrite a historical PO — consistency rule 6).
 */
export type SupplierStatus = 'under_review' | 'active' | 'suspended' | 'deactivated' | 'merged';

/** {@link SupplierStatus} as the tuple the column types and CHECKs read. */
export const SUPPLIER_STATUSES: readonly SupplierStatus[] = [
  'under_review',
  'active',
  'suspended',
  'deactivated',
  'merged',
];

/** Operator risk assessment of a supplier — `unassessed` fails closed. */
export type SupplierRiskLevel = 'unassessed' | 'low' | 'medium' | 'high' | 'blocked';

/** {@link SupplierRiskLevel} as the tuple the column types and CHECKs read. */
export const SUPPLIER_RISK_LEVELS: readonly SupplierRiskLevel[] = [
  'unassessed',
  'low',
  'medium',
  'high',
  'blocked',
];

/** The four contact roles a supplier record carries (#118 supplier model 5). */
export type SupplierContactKind = 'support' | 'finance' | 'returns' | 'compliance';

/** {@link SupplierContactKind} as the tuple the column types and CHECKs read. */
export const SUPPLIER_CONTACT_KINDS: readonly SupplierContactKind[] = [
  'support',
  'finance',
  'returns',
  'compliance',
];

/** The append-only supplier history vocabulary (#118 supplier model 10). */
export type SupplierEventKind =
  | 'created'
  | 'updated'
  | 'activated'
  | 'suspended'
  | 'deactivated'
  | 'merged'
  | 'replaced';

/** {@link SupplierEventKind} as the tuple the column types and CHECKs read. */
export const SUPPLIER_EVENT_KINDS: readonly SupplierEventKind[] = [
  'created',
  'updated',
  'activated',
  'suspended',
  'deactivated',
  'merged',
  'replaced',
];

/** A supplier platform account's environment — their key spaces differ per mode. */
export type SupplierAccountEnvironment = 'test' | 'live';

/** {@link SupplierAccountEnvironment} as the tuple the column types and CHECKs read. */
export const SUPPLIER_ACCOUNT_ENVIRONMENTS: readonly SupplierAccountEnvironment[] = [
  'test',
  'live',
];

/**
 * Activation and kill-switch state of one supplier account, as ONE verdict.
 *
 * `killed` is the operator emergency stop — distinct from `inactive` because an
 * account that was killed must not be quietly re-activated by the same toggle
 * that turns an unfinished one on; it carries a mandatory reason.
 */
export type SupplierAccountState = 'inactive' | 'active' | 'killed';

/** {@link SupplierAccountState} as the tuple the column types and CHECKs read. */
export const SUPPLIER_ACCOUNT_STATES: readonly SupplierAccountState[] = [
  'inactive',
  'active',
  'killed',
];

/** Where the account's CREDENTIAL REFERENCE currently stands — never the secret itself. */
export type SupplierCredentialStatus = 'unconfigured' | 'valid' | 'invalid' | 'expired' | 'revoked';

/** {@link SupplierCredentialStatus} as the tuple the column types and CHECKs read. */
export const SUPPLIER_CREDENTIAL_STATUSES: readonly SupplierCredentialStatus[] = [
  'unconfigured',
  'valid',
  'invalid',
  'expired',
  'revoked',
];

/** What a supplier account's API can do — the #124 adapter capability set. */
export type SupplierApiCapability =
  | 'catalog_feed'
  | 'stock_query'
  | 'shipping_quote'
  | 'order_submit'
  | 'order_cancel'
  | 'order_status'
  | 'callback_events'
  | 'reservation';

/** {@link SupplierApiCapability} as the tuple the element CHECK reads. */
export const SUPPLIER_API_CAPABILITIES: readonly SupplierApiCapability[] = [
  'catalog_feed',
  'stock_query',
  'shipping_quote',
  'order_submit',
  'order_cancel',
  'order_status',
  'callback_events',
  'reservation',
];

/**
 * A supply agreement version's approval lifecycle. `approved` is the ONLY state
 * in which anything downstream may derive eligibility (#118: "no public retail
 * offer may be eligible outside the active scope of an approved agreement").
 */
export type AgreementApprovalState =
  | 'draft'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'terminated';

/** {@link AgreementApprovalState} as the tuple the column types and CHECKs read. */
export const AGREEMENT_APPROVAL_STATES: readonly AgreementApprovalState[] = [
  'draft',
  'under_review',
  'approved',
  'rejected',
  'superseded',
  'terminated',
];

/** The channels an agreement can permit (#118 agreement item 3). */
export type AgreementChannel = 'mercaria_marketplace' | 'mercaria_branded_checkout';

/** {@link AgreementChannel} as the tuple the element CHECK reads. */
export const AGREEMENT_CHANNELS: readonly AgreementChannel[] = [
  'mercaria_marketplace',
  'mercaria_branded_checkout',
];

/**
 * How Mercaria pays this supplier — ADR 0004 D6: a prefunded balance is the
 * launch mechanism, invoice terms the ONE sanctioned alternative. Nothing else
 * (no cards, no wallets, no crypto) is an approved B2B mechanism, so nothing
 * else is representable.
 */
export type AgreementPaymentTermsKind = 'prepaid_balance' | 'invoice_net';

/** {@link AgreementPaymentTermsKind} as the tuple the column types and CHECKs read. */
export const AGREEMENT_PAYMENT_TERMS_KINDS: readonly AgreementPaymentTermsKind[] = [
  'prepaid_balance',
  'invoice_net',
];

/** What a piece of agreement evidence is (#118 agreement items 14–15). */
export type AgreementEvidenceKind =
  | 'contract_document'
  | 'insurance_certificate'
  | 'compliance_certificate'
  | 'authorization_letter'
  | 'price_list'
  | 'other';

/** {@link AgreementEvidenceKind} as the tuple the column types and CHECKs read. */
export const AGREEMENT_EVIDENCE_KINDS: readonly AgreementEvidenceKind[] = [
  'contract_document',
  'insurance_certificate',
  'compliance_certificate',
  'authorization_letter',
  'price_list',
  'other',
];

/** The Incoterms 2020 rules — a genuinely closed international vocabulary. */
export type Incoterm =
  | 'EXW'
  | 'FCA'
  | 'CPT'
  | 'CIP'
  | 'DAP'
  | 'DPU'
  | 'DDP'
  | 'FAS'
  | 'FOB'
  | 'CFR'
  | 'CIF';

/** {@link Incoterm} as the tuple the column types and CHECKs read. */
export const INCOTERMS: readonly Incoterm[] = [
  'EXW',
  'FCA',
  'CPT',
  'CIP',
  'DAP',
  'DPU',
  'DDP',
  'FAS',
  'FOB',
  'CFR',
  'CIF',
];

/** A procurement offer's stock/availability state as the source last reported it. */
export type ProcurementAvailability =
  | 'in_stock'
  | 'out_of_stock'
  | 'limited'
  | 'discontinued'
  | 'unknown';

/** {@link ProcurementAvailability} as the tuple the column types and CHECKs read. */
export const PROCUREMENT_AVAILABILITY_STATES: readonly ProcurementAvailability[] = [
  'in_stock',
  'out_of_stock',
  'limited',
  'discontinued',
  'unknown',
];

/**
 * A procurement offer's lifecycle. Freshness is NOT a status: "expired" and
 * "stale" are DERIVED from `expiresAt` / `lastConfirmedAt` + quote TTL, so they
 * can never disagree with the clock (the ADR 0002 D18 `stale_at` reasoning).
 */
export type ProcurementOfferStatus = 'active' | 'retired';

/** {@link ProcurementOfferStatus} as the tuple the column types and CHECKs read. */
export const PROCUREMENT_OFFER_STATUSES: readonly ProcurementOfferStatus[] = [
  'active',
  'retired',
];

/** Where an offer's facts came from — the provenance grain #118 item 14 asks for. */
export type ProcurementProvenance = 'feed' | 'api' | 'manual' | 'import';

/** {@link ProcurementProvenance} as the tuple the column types and CHECKs read. */
export const PROCUREMENT_PROVENANCES: readonly ProcurementProvenance[] = [
  'feed',
  'api',
  'manual',
  'import',
];

/**
 * Why a procurement offer is NOT eligible — the closed, explainable reason set
 * the derived-eligibility verdict carries. Fail-closed: an unknown condition is
 * a reason, never a pass.
 */
export type ProcurementIneligibilityReason =
  | 'supplier_not_active'
  | 'supplier_risk_blocked'
  | 'account_not_active'
  | 'account_kill_switched'
  | 'agreement_missing'
  | 'agreement_not_approved'
  | 'agreement_not_effective'
  | 'agreement_expired'
  | 'agreement_rights_insufficient'
  | 'destination_not_permitted'
  | 'channel_not_permitted'
  | 'offer_retired'
  | 'offer_expired'
  | 'offer_quote_stale'
  | 'offer_unmapped'
  | 'offer_out_of_stock';

/** {@link ProcurementIneligibilityReason} as the tuple guards and tests read. */
export const PROCUREMENT_INELIGIBILITY_REASONS: readonly ProcurementIneligibilityReason[] = [
  'supplier_not_active',
  'supplier_risk_blocked',
  'account_not_active',
  'account_kill_switched',
  'agreement_missing',
  'agreement_not_approved',
  'agreement_not_effective',
  'agreement_expired',
  'agreement_rights_insufficient',
  'destination_not_permitted',
  'channel_not_permitted',
  'offer_retired',
  'offer_expired',
  'offer_quote_stale',
  'offer_unmapped',
  'offer_out_of_stock',
];

/**
 * The derived eligibility verdict. Deliberately NEVER stored as a column — a
 * stored flag beside the facts it derives from is two representations of one
 * fact, and the place they must not disagree is a checkout gate (#118 offer
 * item 15: "publication and procurement eligibility as derived state").
 */
export interface ProcurementEligibility {
  eligible: boolean;
  /** Empty exactly when `eligible` is true. Sorted, deduped, explainable. */
  reasons: ProcurementIneligibilityReason[];
}

/**
 * The purchase-order state machine of ADR 0004 D9.2, verbatim and binding:
 * `draft → submitted → accepted → shipped → delivered`, exits
 * `rejected | expired | cancelled`, with `cancel_requested` as the overlay
 * between a cancellation ask and the supplier's answer.
 *
 * The issue's "allocation, return and credit states" are deliberately NOT
 * statuses: allocation is `allocatedAt` (a supplier fact that does not move the
 * machine), returns are #127's RMA flows, and credits are `supplierCreditNoteRef`
 * (#128's reconciliation seam) — the ADR's machine is the closed set.
 */
export type PurchaseOrderStatus =
  | 'draft'
  | 'submitted'
  | 'accepted'
  | 'cancel_requested'
  | 'shipped'
  | 'delivered'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/** {@link PurchaseOrderStatus} as the tuple the column types and CHECKs read. */
export const PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = [
  'draft',
  'submitted',
  'accepted',
  'cancel_requested',
  'shipped',
  'delivered',
  'rejected',
  'expired',
  'cancelled',
];

/** The terminal states — nothing transitions out of these. */
export const PURCHASE_ORDER_TERMINAL_STATUSES: readonly PurchaseOrderStatus[] = [
  'delivered',
  'rejected',
  'expired',
  'cancelled',
];

/**
 * Normalized supplier-response reason codes (#118 PO item 11). The supplier's
 * own message is stored REDACTED beside the code; the code is what operator
 * queues and tests filter on, so it is a closed set with `other` as the honest
 * fallback — never a sentence.
 */
export type PurchaseOrderReasonCode =
  | 'out_of_stock'
  | 'price_changed'
  | 'moq_not_met'
  | 'sku_unknown'
  | 'destination_not_served'
  | 'address_invalid'
  | 'acceptance_timeout'
  | 'supplier_error'
  | 'customer_cancelled'
  | 'supplier_cancelled'
  | 'operator_cancelled'
  | 'other';

/** {@link PurchaseOrderReasonCode} as the tuple the column types and CHECKs read. */
export const PURCHASE_ORDER_REASON_CODES: readonly PurchaseOrderReasonCode[] = [
  'out_of_stock',
  'price_changed',
  'moq_not_met',
  'sku_unknown',
  'destination_not_served',
  'address_invalid',
  'acceptance_timeout',
  'supplier_error',
  'customer_cancelled',
  'supplier_cancelled',
  'operator_cancelled',
  'other',
];

/**
 * Who caused a purchase-order transition. Supplier cancellation and customer
 * cancellation are SEPARATE events that converge through orchestration
 * (consistency rule 8) — the initiator on the append-only transition row is
 * what keeps them structurally distinct rather than distinguishable by prose.
 */
export type PurchaseOrderInitiator = 'system' | 'customer' | 'supplier' | 'operator';

/** {@link PurchaseOrderInitiator} as the tuple the column types and CHECKs read. */
export const PURCHASE_ORDER_INITIATORS: readonly PurchaseOrderInitiator[] = [
  'system',
  'customer',
  'supplier',
  'operator',
];

/**
 * The customer-relevant fulfilment vocabulary (consistency rule 9). A public
 * order surface never sees a PO status, a supplier identity or a cost — it sees
 * this, derived per PO by the projection service.
 */
export type PurchaseOrderFulfilmentState =
  | 'preparing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

/** {@link PurchaseOrderFulfilmentState} as the tuple projections and tests read. */
export const PURCHASE_ORDER_FULFILMENT_STATES: readonly PurchaseOrderFulfilmentState[] = [
  'preparing',
  'shipped',
  'delivered',
  'cancelled',
];

/**
 * The customer-safe fulfilment projection of one purchase order.
 *
 * STRUCTURALLY unable to leak: no supplier id, no account, no agreement, no
 * cost, no destination copy — the type has no such properties, so a serializer
 * that tried to ship one fails `tsc`. Tracking numbers are included because the
 * buyer is the person the parcel is for.
 */
export interface PurchaseOrderFulfilmentView {
  state: PurchaseOrderFulfilmentState;
  trackingNumbers: string[];
  estimatedDeliveryDaysMin?: number;
  estimatedDeliveryDaysMax?: number;
}

/**
 * The seam toward the future public `mercaria_retail` offer (#57).
 *
 * #57's unified offer domain is NOT built yet, so #118 exposes sourcing facts
 * through this projection instead of extending a table that does not exist.
 * When #57 lands, its `mercaria_retail` offer kind composes over this shape.
 *
 * What is deliberately ABSENT is the point: no wholesale cost, no currency of
 * cost, no credential reference, no agreement terms — a public offer surface
 * reading this type cannot leak what it cannot see (#118: "must never leak
 * wholesale cost, supplier credentials or contract terms to public product
 * APIs").
 */
export interface RetailOfferSourcingSeam {
  procurementOfferId: string;
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  availability: ProcurementAvailability;
  eligibility: ProcurementEligibility;
  estimatedDeliveryDaysMin: number | null;
  estimatedDeliveryDaysMax: number | null;
}
