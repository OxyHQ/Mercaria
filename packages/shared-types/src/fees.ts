/**
 * Marketplace fee vocabulary (#88) — the closed value sets the fee domain's
 * columns, CHECKs and guards all read, plus the merchant-facing DTOs.
 *
 * ## The commercial-mode boundary is the first fact of this file
 *
 * Mercaria earns its marketplace commission on CONNECTED MARKETPLACE sales and
 * on nothing else. The mode is SNAPSHOTTED onto the order before any fee is
 * calculated, so a later catalog or link change can never reclassify a placed
 * order into a different commercial model:
 *
 *  - `connected_marketplace` — the seller is a connected merchant (store or P2P
 *    individual); Mercaria's revenue is the FeeSchedule commission this file
 *    describes.
 *  - `external_referral` — an outbound referral; NO marketplace fee. Any
 *    affiliate economics live under #67 and never select this schedule.
 *  - `mercaria_retail` — Mercaria itself is the seller (#116/#120: zero markup,
 *    zero intended item profit). The marketplace fee is structurally NOT
 *    APPLICABLE — a calculation for this mode returns an explicit
 *    not-applicable result, never a zero-valued fee that could later be read as
 *    a schedule outcome.
 *  - `informational` — no transaction at all, so no fee.
 *
 * ## What is deliberately UNREPRESENTABLE as a schedule scope
 *
 * Buyer authentication state, guest origin, Oxy claim status, payment-method
 * identity and contact data are NOT valid schedule scopes. There is no field
 * for any of them anywhere in this vocabulary — the schedule scopes below are
 * the COMPLETE set — so a schedule that charged guests differently, or priced
 * by card fingerprint, cannot be written down. Equivalent authenticated and
 * guest checkouts with the same commercial facts therefore produce the same
 * fee by construction, not by policy.
 */

import type { CurrencyCode, Money } from './money';
import type { OrderSellerType } from './order';

/** The four commercial modes an order can be placed under. See file docblock. */
export type CommercialMode =
  | 'connected_marketplace'
  | 'external_referral'
  | 'mercaria_retail'
  | 'informational';

/** {@link CommercialMode} as the tuple the column types and CHECKs read. */
export const COMMERCIAL_MODES: readonly CommercialMode[] = [
  'connected_marketplace',
  'external_referral',
  'mercaria_retail',
  'informational',
];

/**
 * A fee schedule version's lifecycle. `draft` is the only editable state;
 * everything after it is immutable (trust rule 4: publish a new version, never
 * edit an active one).
 *
 *  - `draft` → editable, selects nothing.
 *  - `active` → selectable; at most ONE active version per schedule key.
 *  - `superseded` → replaced by a newer active version; kept because order
 *    snapshots name it forever.
 *  - `retired` → withdrawn without a replacement (or an abandoned draft).
 */
export type FeeScheduleStatus = 'draft' | 'active' | 'superseded' | 'retired';

/** {@link FeeScheduleStatus} as the tuple the column types and CHECKs read. */
export const FEE_SCHEDULE_STATUSES: readonly FeeScheduleStatus[] = [
  'draft',
  'active',
  'superseded',
  'retired',
];

/**
 * Tax treatment METADATA for the fee itself — recorded when known, `unknown`
 * honestly otherwise. Metadata only: nothing computes tax from it today.
 */
export type FeeTaxTreatment = 'unknown' | 'exclusive' | 'inclusive';

/** {@link FeeTaxTreatment} as the tuple the column types and CHECKs read. */
export const FEE_TAX_TREATMENTS: readonly FeeTaxTreatment[] = [
  'unknown',
  'exclusive',
  'inclusive',
];

/**
 * What happens to Mercaria's fee when an order is (partially) refunded.
 *
 * `proportional` — the commission on the refunded amount is returned (ADR 0001
 * D5), pro-rata to how much of the order came back. It is the only policy that
 * EXISTS: the settlement model prorates the seller's NET share cumulatively, so
 * the commission return falls out of the residual with no second code path.
 * Adding a `retain` policy would be a code change plus a CHECK widening under
 * its own review, not a value someone can quietly configure.
 */
export type FeeRefundPolicy = 'proportional';

/** {@link FeeRefundPolicy} as the tuple the column types and CHECKs read. */
export const FEE_REFUND_POLICIES: readonly FeeRefundPolicy[] = ['proportional'];

/**
 * The EXPLICIT fee base. One value exists: the presentment-side item subtotal
 * AFTER item-level discount allocations. Tax, delivery and shipping-targeted
 * discounts are excluded structurally — the calculator is handed line totals
 * and line discounts and nothing else, so no other amount can enter
 * accidentally. A different base is a new value here plus its own calculation
 * path, never a flag.
 */
export type FeeBasis = 'discounted_item_subtotal';

/** {@link FeeBasis} as the tuple the column types and CHECKs read. */
export const FEE_BASES: readonly FeeBasis[] = ['discounted_item_subtotal'];

/**
 * What one order's fee calculation concluded. Three answers, and they are NOT
 * interchangeable:
 *
 *  - `calculated` — a schedule applied and the snapshot carries its components
 *    and a fee amount (possibly zero, if the schedule says zero).
 *  - `no_active_schedule` — connected-marketplace order, no schedule in force
 *    for its facts. The fee is a REAL zero: the pre-#88 zero-rate reality, and
 *    a working configuration.
 *  - `not_applicable` — the commercial mode structurally excludes a marketplace
 *    fee (`mercaria_retail`, `external_referral`, `informational`). The
 *    snapshot carries NO fee amount at all — a NULL, not a zero — so nothing
 *    downstream can mistake it for a schedule outcome.
 */
export type FeeSnapshotResult = 'calculated' | 'no_active_schedule' | 'not_applicable';

/** {@link FeeSnapshotResult} as the tuple the column types and CHECKs read. */
export const FEE_SNAPSHOT_RESULTS: readonly FeeSnapshotResult[] = [
  'calculated',
  'no_active_schedule',
  'not_applicable',
];

/** Which clamp bound a calculated fee, when one did. */
export type FeeClamp = 'min' | 'max';

/** {@link FeeClamp} as the tuple the column types and CHECKs read. */
export const FEE_CLAMPS: readonly FeeClamp[] = ['min', 'max'];

/**
 * One fee schedule version, as the merchant dashboard shows it.
 *
 * Everything here is merchant-safe: the schedule is the public commercial
 * offer, and it deliberately carries no operator identity and no internal row
 * id — `scheduleKey` + `version` IS its name everywhere, including on order
 * snapshots.
 */
export interface FeeScheduleSummary {
  /** The stable logical id shared by every version of one schedule. */
  scheduleKey: string;
  /** Monotonic per key. A new policy is a new version, never an edit. */
  version: number;
  name: string;
  /** The merchant-facing summary of what this schedule charges and why. */
  merchantSummary: string;
  status: FeeScheduleStatus;
  /** ISO-8601. The schedule selects only inside `[effectiveStart, effectiveEnd)`. */
  effectiveStart: string;
  effectiveEnd?: string;
  /** Scope: which seller kind it applies to. Absent = both. */
  eligibleSellerType?: OrderSellerType;
  /**
   * Scope: the ONE presentment currency it applies to. Absent = any (a pure
   * percentage works in any currency). REQUIRED whenever the schedule carries a
   * fixed component or a min/max clamp, because those are amounts in a named
   * currency and a fee never mixes currencies.
   */
  eligibleCurrency?: CurrencyCode;
  /** The percentage component, in basis points (1000 = 10%). */
  percentageBps: number;
  /** The optional fixed component, in the schedule's own named currency. */
  fixedFee?: Money;
  /** Optional floor on the calculated fee, minor units of `eligibleCurrency`. */
  minFeeMinor?: number;
  /** Optional ceiling on the calculated fee, minor units of `eligibleCurrency`. */
  maxFeeMinor?: number;
  taxTreatment: FeeTaxTreatment;
  refundPolicy: FeeRefundPolicy;
  /** The terms document version a merchant accepts alongside this schedule. */
  termsVersion: string;
  createdAt: string;
  activatedAt?: string;
}

/** A recorded terms acceptance, as the dashboard shows it. */
export interface FeeScheduleAcceptanceSummary {
  scheduleKey: string;
  scheduleVersion: number;
  termsVersion: string;
  /** The store member who accepted — an authorized owner (`store:manage`). */
  acceptedByOxyUserId: string;
  acceptedAt: string;
}

/** What `GET /admin/stores/:storeId/fees/schedule` answers. */
export interface StoreFeeScheduleView {
  /** The schedule currently applicable to this store, or absent when none is. */
  schedule?: FeeScheduleSummary;
  /** This store's acceptance of that exact version, when one exists. */
  acceptance?: FeeScheduleAcceptanceSummary;
}

/** Accept the current schedule's terms. Echoes what the owner saw, so a stale screen is refused. */
export interface AcceptFeeScheduleInput {
  scheduleKey: string;
  version: number;
  termsVersion: string;
}

/** Preview a fee against the store's current schedule. */
export interface FeePreviewInput {
  /** The hypothetical discounted item subtotal, in minor units. */
  basisAmount: number;
  currency: CurrencyCode;
}

/** What a fee preview answers — the same arithmetic checkout will apply. */
export interface FeePreview {
  result: FeeSnapshotResult;
  schedule?: Pick<FeeScheduleSummary, 'scheduleKey' | 'version' | 'name' | 'termsVersion'>;
  basis: FeeBasis;
  basisAmount: Money;
  /** The marketplace fee on that basis. Zero when no schedule is active. */
  fee: Money;
  /** What the merchant keeps of the basis after the marketplace fee. */
  net: Money;
  /** The human-readable audit line — the same text an operator trace shows. */
  explanation: string;
}

/**
 * An order's immutable fee snapshot, projected for the merchant dashboard and
 * the operator trace. Carries NO buyer identity, guest token, provider customer
 * id or payment credential — the snapshot never stored any.
 */
export interface OrderFeeSummary {
  commercialMode: CommercialMode;
  result: FeeSnapshotResult;
  scheduleKey?: string;
  scheduleVersion?: number;
  basis?: FeeBasis;
  basisAmount?: Money;
  percentageBps?: number;
  fixedFeeMinor?: number;
  clampApplied?: FeeClamp;
  /** Absent exactly when `result` is `not_applicable`. */
  fee?: Money;
  roundingAdjustmentMinor?: number;
  /** The terms version the seller had accepted when the order was placed. */
  termsVersionAccepted?: string;
  /** ISO-8601 — when the fee was calculated (the snapshot's creation time). */
  calculatedAt: string;
  explanation: string;
}
