/**
 * The marketplace fee domain (#88): `fee_schedules`, `fee_schedule_acceptances`,
 * `order_fee_snapshots`, `order_fee_snapshot_lines`.
 *
 * ## Versioned and immutable once active — and the database enforces it
 *
 * A schedule version is editable only while `draft`. From `active` onward every
 * economic column is frozen by the `fee_schedules_immutable_once_active` trigger
 * (hand-written in the migration, like the ledger's append-only triggers): only
 * `status`, `approved_by_oxy_user_id`, `activated_at` and `updated_at` may move.
 * Changing the policy means publishing a NEW version — trust rule 4 — and the
 * partial unique index `fee_schedules_one_active_per_key` is what makes "the
 * active version of a schedule" a single row rather than a query with a bug.
 *
 * ## What a schedule may scope on, and what it structurally cannot
 *
 * Scope is `eligible_seller_type` and `eligible_currency` — the two facts the
 * launch policy actually needs. Buyer authentication state, guest origin, Oxy
 * claim status, payment-method identity and contact data are NOT columns here
 * and must never become ones: a schedule that priced by any of them cannot be
 * written down, which is how guest and authenticated checkouts are guaranteed
 * the same fee (issue #88, invalid-scope rule).
 *
 * `eligible_currency` doubles as the fee's OWN currency wherever an absolute
 * amount appears: the fixed component and the min/max clamps are minor units of
 * a named currency, so the CHECKs below refuse a schedule that carries one
 * without pinning the currency, and refuse a fixed component in any currency
 * but the eligible one. A fee never mixes currencies — the mismatch is
 * unrepresentable, not validated.
 *
 * ## The order snapshot is append-only, like the ledger, and for the same reason
 *
 * `order_fee_snapshots` is the record BOTH the ledger's commission and the
 * seller's transfer are derived from, and the record every merchant view, buyer
 * view and refund reads (trust rule 3: one immutable snapshot, every reader).
 * Its rows refuse UPDATE and DELETE via trigger. A later schedule version, a
 * catalog change, an Oxy claim of a guest order — none of them can alter a
 * placed order's fee, because nothing at all can alter the snapshot.
 *
 * `created_at` IS the calculation time — the snapshot is written in the same
 * transaction as its order, at authoritative pricing time. There is no
 * `updated_at`: the absence is the append-only contract, exactly as
 * `order_status_history` states it.
 *
 * ## No FK from snapshots to `fee_schedules`
 *
 * The snapshot names its schedule by `(schedule_key, schedule_version)` VALUES,
 * the same way an order line freezes a title and a price: it is a snapshot, and
 * it must stay readable and meaningful whatever later happens to the schedule
 * row (which the immutability trigger protects anyway). The classification gate
 * only audits `*_id` columns; these are names, not ids, and that is deliberate.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { bigint } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  COMMERCIAL_MODES,
  FEE_BASES,
  FEE_CLAMPS,
  FEE_REFUND_POLICIES,
  FEE_SCHEDULE_STATUSES,
  FEE_SNAPSHOT_RESULTS,
  FEE_TAX_TREATMENTS,
  PROVIDER_ACCOUNT_OWNER_TYPES,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
  optionalMoney,
} from './columns';
import { ORDER_SELLER_TYPES, orderItems, orders } from './orders';

/**
 * A fee amount bound (min/max clamp), in minor units of the schedule's
 * `eligible_currency`. `bigint` for the same FAIR-precision reason every money
 * amount is (`CONVENTIONS.md` §Money); a bare amount rather than a `money()`
 * pair because its currency is the schedule's one pinned currency — a second
 * currency column would be a second representation of that fact.
 */
const feeBoundMinor = () => bigint({ mode: 'number' });

/**
 * `fee_schedules` — one VERSION of one commercial fee policy.
 *
 * `(schedule_key, version)` is the public name order snapshots carry forever;
 * the uuid primary key exists for the operator surface's addressing only and
 * never leaves the backend.
 */
export const feeSchedules = pgTable(
  'fee_schedules',
  {
    id: generatedId(),
    /** The stable logical id shared by every version (`connected-marketplace-standard`). */
    scheduleKey: text().notNull(),
    /** Monotonic per key, assigned by the operator creating the draft. */
    version: integer().notNull(),
    name: text().notNull(),
    /** The merchant-facing summary shown before terms acceptance. */
    merchantSummary: text().notNull(),
    /** The schedule selects only inside `[effective_start, effective_end)`. */
    effectiveStart: timestamptz().notNull(),
    /** NULL = open-ended. */
    effectiveEnd: timestamptz(),
    /** Scope: which seller kind. NULL = both stores and P2P sellers. */
    eligibleSellerType: text({ enum: asEnumValues(ORDER_SELLER_TYPES) }),
    /**
     * Scope: the ONE presentment currency this schedule applies to, and the
     * currency of every absolute amount it carries. NULL = any currency, which
     * the CHECKs below permit only for a pure-percentage schedule.
     */
    eligibleCurrency: text({ enum: CURRENCY_CODE_VALUES }),
    /** The percentage component in basis points (1000 = 10%). */
    percentageBps: integer().notNull(),
    /** The optional fixed component. Both columns present or absent together. */
    ...optionalMoney('fixedFee'),
    /** Optional floor on the calculated fee. */
    minFeeMinor: feeBoundMinor(),
    /** Optional ceiling on the calculated fee. */
    maxFeeMinor: feeBoundMinor(),
    taxTreatment: text({ enum: asEnumValues(FEE_TAX_TREATMENTS) })
      .notNull()
      .default('unknown'),
    refundPolicy: text({ enum: asEnumValues(FEE_REFUND_POLICIES) })
      .notNull()
      .default('proportional'),
    status: text({ enum: asEnumValues(FEE_SCHEDULE_STATUSES) }).notNull().default('draft'),
    /** The terms document version a merchant accepts alongside this schedule. */
    termsVersion: text().notNull(),
    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text().notNull(),
    /** The operator who activated it — the audit half of "publish a new version". */
    approvedByOxyUserId: text(),
    activatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('fee_schedules_status_check', t.status, FEE_SCHEDULE_STATUSES),
    checkOneOf('fee_schedules_tax_treatment_check', t.taxTreatment, FEE_TAX_TREATMENTS),
    checkOneOf('fee_schedules_refund_policy_check', t.refundPolicy, FEE_REFUND_POLICIES),
    checkOneOf('fee_schedules_eligible_seller_type_check', t.eligibleSellerType, ORDER_SELLER_TYPES),
    ...currencyChecks('fee_schedules', [t.eligibleCurrency, t.fixedFeeCurrency]),
    check('fee_schedules_version_check', sql`${t.version} >= 1`),
    // Trust rule 6: no negative fee outside supported policy — and none is
    // supported, so every component is non-negative at the type of the row.
    check(
      'fee_schedules_percentage_bps_check',
      sql`${t.percentageBps} between 0 and 10000`,
    ),
    check(
      'fee_schedules_fixed_fee_amount_check',
      sql`${t.fixedFeeAmount} is null or ${t.fixedFeeAmount} >= 0`,
    ),
    check(
      'fee_schedules_min_fee_check',
      sql`${t.minFeeMinor} is null or ${t.minFeeMinor} >= 0`,
    ),
    check(
      'fee_schedules_max_fee_check',
      sql`${t.maxFeeMinor} is null or ${t.maxFeeMinor} >= 0`,
    ),
    check(
      'fee_schedules_min_max_order_check',
      sql`${t.minFeeMinor} is null or ${t.maxFeeMinor} is null or ${t.minFeeMinor} <= ${t.maxFeeMinor}`,
    ),
    // A `Money` is present in both columns or in neither.
    check(
      'fee_schedules_fixed_fee_complete_check',
      sql`num_nonnulls(${t.fixedFeeAmount}, ${t.fixedFeeCurrency}) in (0, 2)`,
    ),
    // An absolute amount needs the schedule's currency pinned, and the fixed
    // component must be IN that currency — one currency per fee, unrepresentably.
    check(
      'fee_schedules_fixed_fee_scope_check',
      sql`${t.fixedFeeAmount} is null
          or (${t.eligibleCurrency} is not null and ${t.fixedFeeCurrency} = ${t.eligibleCurrency})`,
    ),
    check(
      'fee_schedules_clamp_scope_check',
      sql`(${t.minFeeMinor} is null and ${t.maxFeeMinor} is null)
          or ${t.eligibleCurrency} is not null`,
    ),
    check(
      'fee_schedules_effective_window_check',
      sql`${t.effectiveEnd} is null or ${t.effectiveEnd} > ${t.effectiveStart}`,
    ),
    // An active schedule carries its activation audit; nothing active is anonymous.
    check(
      'fee_schedules_activation_audit_check',
      sql`${t.status} not in ('active', 'superseded')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    uniqueIndex('fee_schedules_key_version_key').on(t.scheduleKey, t.version),
    // THE structural half of "active versions are immutable; publish a new
    // version": at most one active row per key, so activation must supersede.
    uniqueIndex('fee_schedules_one_active_per_key')
      .on(t.scheduleKey)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * `fee_schedule_acceptances` — an authorized owner accepted one schedule
 * version's terms, once. Append-only (trigger): the acceptance is an audit
 * record, and re-accepting the same version converges on the existing row via
 * the unique index rather than rewriting it.
 *
 * The owner is the POLYMORPHIC pair `provider_accounts` uses, for the same
 * reason it uses it: half the owners are Oxy accounts, whose key space is not
 * in this database (`CONVENTIONS.md`, documented exceptions).
 */
export const feeScheduleAcceptances = pgTable(
  'fee_schedule_acceptances',
  {
    id: generatedId(),
    scheduleKey: text().notNull(),
    scheduleVersion: integer().notNull(),
    /**
     * The terms version the owner actually saw and accepted — denormalized from
     * the schedule at acceptance time, snapshot semantics: the acceptance must
     * state what was agreed even if read apart from the schedule row.
     */
    termsVersion: text().notNull(),
    ownerType: text({ enum: asEnumValues(PROVIDER_ACCOUNT_OWNER_TYPES) }).notNull(),
    /** A store id or an Oxy account id, by `owner_type`. */
    ownerId: text().notNull(),
    /** The store member (or the P2P seller) who clicked accept. */
    acceptedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('fee_schedule_acceptances_owner_type_check', t.ownerType, PROVIDER_ACCOUNT_OWNER_TYPES),
    check('fee_schedule_acceptances_version_check', sql`${t.scheduleVersion} >= 1`),
    // One acceptance per owner per schedule version — a replayed accept
    // converges instead of duplicating the audit trail.
    uniqueIndex('fee_schedule_acceptances_owner_version_key').on(
      t.ownerType,
      t.ownerId,
      t.scheduleKey,
      t.scheduleVersion,
    ),
  ],
);

/**
 * `order_fee_snapshots` — one order's immutable fee record, written in the SAME
 * transaction as the order itself at authoritative pricing time.
 *
 * The three results shape the row via CHECKs rather than convention:
 *
 *  - `calculated` — schedule named, basis and fee present.
 *  - `no_active_schedule` — no schedule named, basis present, fee a REAL zero.
 *  - `not_applicable` — the commercial mode excludes a marketplace fee; the fee
 *    columns are NULL, never zero, so `mercaria_retail` can never be read as a
 *    zero-rate schedule outcome (#88 calculation rule 12).
 *
 * Deliberately NOT stored: buyer contact data, guest tokens, provider
 * customer/Link identity, payment credentials. None has a column, so none can
 * arrive (#88 snapshot rule).
 */
export const orderFeeSnapshots = pgTable(
  'order_fee_snapshots',
  {
    id: generatedId(),
    /**
     * `restrict`, like `refunds.order_id`: a fee snapshot without its order is
     * an unexplained commission record, and nothing deletes an order.
     */
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    commercialMode: text({ enum: asEnumValues(COMMERCIAL_MODES) }).notNull(),
    result: text({ enum: asEnumValues(FEE_SNAPSHOT_RESULTS) }).notNull(),
    scheduleKey: text(),
    scheduleVersion: integer(),
    /** The explicit fee base kind (`discounted_item_subtotal`). */
    basis: text({ enum: asEnumValues(FEE_BASES) }),
    /** The base the fee was computed FROM, presentment side. */
    ...optionalMoney('basisAmount'),
    /** The percentage component applied, as basis points. */
    percentageBps: integer(),
    /** The fixed component applied, in the fee's own currency's minor units. */
    fixedFeeMinor: bigint({ mode: 'number' }),
    /** Which schedule clamp bound the fee, when one did. */
    clampApplied: text({ enum: asEnumValues(FEE_CLAMPS) }),
    /** THE fee. Present iff the result is not `not_applicable`. */
    ...optionalMoney('fee'),
    /** What half-up rounding added to the truncated percentage component (0 or 1). */
    roundingAdjustmentMinor: bigint({ mode: 'number' }),
    /** The terms version the seller had accepted at placement, when any. */
    termsVersionAccepted: text(),
    /** The seller-type fact schedule selection read. */
    scopeSellerType: text({ enum: asEnumValues(ORDER_SELLER_TYPES) }),
    /** The currency fact schedule selection read (the order's presentment currency). */
    scopeCurrency: text({ enum: CURRENCY_CODE_VALUES }),
    /** The calculation time. No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('order_fee_snapshots_commercial_mode_check', t.commercialMode, COMMERCIAL_MODES),
    checkOneOf('order_fee_snapshots_result_check', t.result, FEE_SNAPSHOT_RESULTS),
    checkOneOf('order_fee_snapshots_basis_check', t.basis, FEE_BASES),
    checkOneOf('order_fee_snapshots_clamp_applied_check', t.clampApplied, FEE_CLAMPS),
    checkOneOf('order_fee_snapshots_scope_seller_type_check', t.scopeSellerType, ORDER_SELLER_TYPES),
    ...currencyChecks('order_fee_snapshots', [
      t.basisAmountCurrency,
      t.feeCurrency,
      t.scopeCurrency,
    ]),
    // `connected_marketplace` calculates (or honestly records that no schedule
    // was in force); every other mode is structurally not-applicable. The CHECK
    // makes the boundary a property of the row, not of the writer.
    check(
      'order_fee_snapshots_mode_result_check',
      sql`(${t.commercialMode} = 'connected_marketplace') = (${t.result} <> 'not_applicable')`,
    ),
    // A schedule is named exactly when one applied.
    check(
      'order_fee_snapshots_schedule_named_check',
      sql`(${t.result} = 'calculated')
          = (${t.scheduleKey} is not null and ${t.scheduleVersion} is not null)`,
    ),
    // The fee amount exists exactly when the fee is applicable — a
    // `not_applicable` row carries NULL, never zero (#88 calculation rule 12).
    // Two conjuncts, deliberately: "all six or none" PLUS "none exactly when
    // not applicable". A single biconditional against the AND of the six lets a
    // partially-filled row through on both sides (a not-applicable row carrying
    // a fee but no basis satisfies `false = false`) — found by the realdb test
    // that tries to smuggle exactly that row.
    check(
      'order_fee_snapshots_fee_presence_check',
      sql`num_nonnulls(${t.feeAmount}, ${t.basisAmountAmount}, ${t.basis}, ${t.scopeSellerType}, ${t.scopeCurrency}, ${t.roundingAdjustmentMinor}) in (0, 6)
          and (${t.result} = 'not_applicable')
            = (num_nonnulls(${t.feeAmount}, ${t.basisAmountAmount}, ${t.basis}, ${t.scopeSellerType}, ${t.scopeCurrency}, ${t.roundingAdjustmentMinor}) = 0)`,
    ),
    // Both `Money`s are complete or absent.
    check(
      'order_fee_snapshots_basis_amount_complete_check',
      sql`num_nonnulls(${t.basisAmountAmount}, ${t.basisAmountCurrency}) in (0, 2)`,
    ),
    check(
      'order_fee_snapshots_fee_complete_check',
      sql`num_nonnulls(${t.feeAmount}, ${t.feeCurrency}) in (0, 2)`,
    ),
    // The schedule components travel only with a calculated result.
    check(
      'order_fee_snapshots_components_check',
      sql`${t.result} = 'calculated'
          or (${t.percentageBps} is null and ${t.fixedFeeMinor} is null and ${t.clampApplied} is null)`,
    ),
    // Trust rule 6 again, at the snapshot: no negative fee, and the fee never
    // exceeds its own basis (the documented structural cap).
    check(
      'order_fee_snapshots_fee_amount_check',
      sql`${t.feeAmount} is null or ${t.feeAmount} >= 0`,
    ),
    check(
      'order_fee_snapshots_fee_within_basis_check',
      sql`${t.feeAmount} is null or ${t.feeAmount} <= ${t.basisAmountAmount}`,
    ),
    check(
      'order_fee_snapshots_rounding_adjustment_check',
      sql`${t.roundingAdjustmentMinor} is null or ${t.roundingAdjustmentMinor} in (0, 1)`,
    ),
    // ONE snapshot per order — the whole point of a snapshot.
    uniqueIndex('order_fee_snapshots_order_id_key').on(t.orderId),
  ],
);

/**
 * `order_fee_snapshot_lines` — the order fee allocated back across the order's
 * lines, largest-remainder, summing to the order fee EXACTLY. A child table and
 * not `jsonb`: the shape is entirely known, which is `CONVENTIONS.md`'s bar.
 *
 * Append-only with its parent (same trigger).
 */
export const orderFeeSnapshotLines = pgTable(
  'order_fee_snapshot_lines',
  {
    id: generatedId(),
    snapshotId: text()
      .notNull()
      .references(() => orderFeeSnapshots.id, { onDelete: 'cascade' }),
    /**
     * `restrict`: an allocation without its line is unexplained, and order
     * items only ever cascade away with their order — which the snapshot's own
     * `restrict` already refuses.
     */
    orderItemId: text()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    /** This line's share of the order fee, in the fee's currency. */
    amountMinor: bigint({ mode: 'number' }).notNull(),
    /** The line's position within the order, mirroring `order_items.position`. */
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('order_fee_snapshot_lines_amount_check', sql`${t.amountMinor} >= 0`),
    uniqueIndex('order_fee_snapshot_lines_snapshot_item_key').on(t.snapshotId, t.orderItemId),
    index('order_fee_snapshot_lines_snapshot_id_position_idx').on(t.snapshotId, t.position),
  ],
);
