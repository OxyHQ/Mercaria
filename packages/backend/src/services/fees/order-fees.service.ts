/**
 * Building an order's fee snapshot at authoritative pricing time (#88).
 *
 * The seam checkout calls: it loads the active schedules ONCE per checkout,
 * resolves each seller group's snapshot plan, and hands the plan to
 * `insertOrder` so the snapshot commits WITH the order. Everything monetary is
 * `fee-calculation.ts` (pure); this module is the wiring — schedules from
 * Postgres, the seller's terms acceptance, and the three commercial modes that
 * never calculate at all.
 *
 * ## The commercial mode is decided here, before any fee arithmetic
 *
 * Every native checkout order today is a CONNECTED MARKETPLACE sale: the seller
 * is a connected merchant (store or P2P individual) and Mercaria brokers the
 * transaction. The other three modes exist in the vocabulary and in the
 * not-applicable path below, and each ARRIVES with its own issue (#67 referral,
 * #116/#120 mercaria_retail) — nothing here anticipates their order-creation
 * paths, but the boundary is already unambiguous: a mode that is not
 * `connected_marketplace` produces an explicit `not_applicable` snapshot with a
 * NULL fee, never a zero that could read as a schedule outcome.
 *
 * ## What the snapshot plan is deliberately blind to
 *
 * No function here takes the buyer. Selection facts are the seller type and the
 * presentment currency; the acceptance lookup takes the SELLER's identity. A
 * guest checkout (#107) will reach these functions with the same arguments an
 * authenticated one does, which is what makes fee equivalence structural.
 */

import type {
  CommercialMode,
  CurrencyCode,
  FeePreview,
  FeeScheduleSummary,
  Money,
  OrderFeeSummary,
  OrderSellerType,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findFeeScheduleAcceptance,
  listActiveFeeSchedules,
  type FeeScheduleRow,
} from '../../db/fees/feeScheduleRepository.js';
import type { NewOrderFeeSnapshot } from '../../db/orders/orderRepository.js';
import type { OrderFeeSnapshotRecord } from '../../db/fees/orderFeeSnapshotRepository.js';
import {
  calculateFee,
  formatMinor,
  selectFeeSchedule,
  type EffectiveFeeSchedule,
  type FeeBasisLine,
} from './fee-calculation.js';

/**
 * The schedules in force at one instant — loaded ONCE per checkout, then read
 * per seller group. `at` IS the authoritative pricing time every group in the
 * checkout shares, so two orders of one cart cannot straddle an activation.
 */
export interface FeeScheduleContext {
  at: Date;
  schedules: FeeScheduleRow[];
}

/** Load the schedules one checkout will select from. */
export async function loadFeeScheduleContext(at: Date = new Date()): Promise<FeeScheduleContext> {
  return { at, schedules: await listActiveFeeSchedules(getDb(), at) };
}

/** The seller-side facts one order's fee needs. Note: no buyer anywhere. */
export interface ConnectedMarketplaceFeeInput {
  context: FeeScheduleContext;
  sellerType: OrderSellerType;
  /** The store id or the P2P seller's Oxy user id — the acceptance owner. */
  sellerOwnerId: string;
  /** The order's presentment currency — the fee's one currency. */
  currency: CurrencyCode;
  /** Presentment-side line totals and their item-level discounts, in item order. */
  lines: readonly FeeBasisLine[];
}

/**
 * Resolve one connected-marketplace order's fee snapshot plan.
 *
 * Ambiguous configuration (two matching schedules) throws HERE — during
 * checkout's pricing loop, before any payment is opened (acceptance 6). No
 * active schedule is NOT an error: it is the honest zero-fee configuration,
 * recorded as `no_active_schedule` so it can never be confused with a schedule
 * that calculated zero.
 */
export async function planConnectedMarketplaceFee(
  input: ConnectedMarketplaceFeeInput,
): Promise<NewOrderFeeSnapshot> {
  const facts = { sellerType: input.sellerType, currency: input.currency };
  const schedule = selectFeeSchedule({
    schedules: input.context.schedules,
    facts,
    at: input.context.at,
  });

  if (!schedule) {
    const basisMinor = input.lines.reduce((sum, line) => {
      const base = line.lineTotalMinor - line.discountMinor;
      return sum + (base > 0 ? base : 0);
    }, 0);
    return {
      commercialMode: 'connected_marketplace',
      result: 'no_active_schedule',
      basis: 'discounted_item_subtotal',
      basisAmount: { amount: basisMinor, currency: input.currency },
      fee: { amount: 0, currency: input.currency },
      roundingAdjustmentMinor: 0,
      scopeSellerType: input.sellerType,
      scopeCurrency: input.currency,
      lineAllocationsMinor: input.lines.map(() => 0),
    };
  }

  const calculation = calculateFee({ schedule, currency: input.currency, lines: input.lines });
  const acceptance = await findFeeScheduleAcceptance(getDb(), {
    ownerType: input.sellerType,
    ownerId: input.sellerOwnerId,
    scheduleKey: schedule.scheduleKey,
    scheduleVersion: schedule.version,
  });

  return {
    commercialMode: 'connected_marketplace',
    result: 'calculated',
    scheduleKey: schedule.scheduleKey,
    scheduleVersion: schedule.version,
    basis: 'discounted_item_subtotal',
    basisAmount: { amount: calculation.basisMinor, currency: input.currency },
    percentageBps: schedule.percentageBps,
    ...(schedule.fixedFeeAmount !== null ? { fixedFeeMinor: schedule.fixedFeeAmount } : {}),
    ...(calculation.clampApplied ? { clampApplied: calculation.clampApplied } : {}),
    fee: { amount: calculation.feeMinor, currency: input.currency },
    roundingAdjustmentMinor: calculation.roundingAdjustmentMinor,
    ...(acceptance ? { termsVersionAccepted: acceptance.termsVersion } : {}),
    scopeSellerType: input.sellerType,
    scopeCurrency: input.currency,
    lineAllocationsMinor: calculation.lineAllocationsMinor,
  };
}

/**
 * The explicit not-applicable snapshot for a commercial mode the marketplace
 * fee structurally excludes. NO fee amount — a NULL, never a zero — so a
 * `mercaria_retail` order can never be read as priced under a zero-rate
 * schedule (#88 calculation rule 12), and `external_referral` /
 * `informational` never post marketplace commission by the same construction.
 *
 * @throws For `connected_marketplace`, which must go through
 *   {@link planConnectedMarketplaceFee} — a caller reaching for the
 *   not-applicable shape on a marketplace sale is a commercial-mode bug, not a
 *   configuration.
 */
export function notApplicableFeeSnapshot(mode: CommercialMode): NewOrderFeeSnapshot {
  if (mode === 'connected_marketplace') {
    throw new Error(
      'A connected_marketplace order calculates its fee; the not-applicable snapshot is ' +
        'for the modes the marketplace fee structurally excludes.',
    );
  }
  return { commercialMode: mode, result: 'not_applicable' };
}

/** `fee_schedules` row → the merchant-facing DTO. */
export function toFeeScheduleSummary(row: FeeScheduleRow): FeeScheduleSummary {
  return {
    scheduleKey: row.scheduleKey,
    version: row.version,
    name: row.name,
    merchantSummary: row.merchantSummary,
    status: row.status,
    effectiveStart: row.effectiveStart.toISOString(),
    ...(row.effectiveEnd ? { effectiveEnd: row.effectiveEnd.toISOString() } : {}),
    ...(row.eligibleSellerType ? { eligibleSellerType: row.eligibleSellerType } : {}),
    ...(row.eligibleCurrency ? { eligibleCurrency: row.eligibleCurrency } : {}),
    percentageBps: row.percentageBps,
    ...(row.fixedFeeAmount !== null && row.fixedFeeCurrency !== null
      ? { fixedFee: { amount: row.fixedFeeAmount, currency: row.fixedFeeCurrency } }
      : {}),
    ...(row.minFeeMinor !== null ? { minFeeMinor: row.minFeeMinor } : {}),
    ...(row.maxFeeMinor !== null ? { maxFeeMinor: row.maxFeeMinor } : {}),
    taxTreatment: row.taxTreatment,
    refundPolicy: row.refundPolicy,
    termsVersion: row.termsVersion,
    createdAt: row.createdAt.toISOString(),
    ...(row.activatedAt ? { activatedAt: row.activatedAt.toISOString() } : {}),
  };
}

/**
 * The schedule currently applicable to one seller, for the dashboard's
 * pre-activation view. The same selection checkout runs, at "now".
 */
export async function findApplicableSchedule(input: {
  sellerType: OrderSellerType;
  currency: CurrencyCode;
  at?: Date;
}): Promise<FeeScheduleRow | undefined> {
  const at = input.at ?? new Date();
  const schedules = await listActiveFeeSchedules(getDb(), at);
  return selectFeeSchedule({
    schedules,
    facts: { sellerType: input.sellerType, currency: input.currency },
    at,
  });
}

/**
 * Preview the fee and the merchant's net on a hypothetical basis — the same
 * pure arithmetic checkout will apply, so what the preview promises is what an
 * order will get (merchant experience 3, trust rule 3).
 */
export function previewFee(input: {
  schedule: EffectiveFeeSchedule | undefined;
  basisMinor: number;
  currency: CurrencyCode;
}): FeePreview {
  const basisAmount: Money = { amount: input.basisMinor, currency: input.currency };
  if (!input.schedule) {
    return {
      result: 'no_active_schedule',
      basis: 'discounted_item_subtotal',
      basisAmount,
      fee: { amount: 0, currency: input.currency },
      net: basisAmount,
      explanation:
        'No marketplace fee schedule is currently active for these facts; the marketplace ' +
        'fee is zero.',
    };
  }

  const calculation = calculateFee({
    schedule: input.schedule,
    currency: input.currency,
    lines: [{ lineTotalMinor: input.basisMinor, discountMinor: 0 }],
  });
  return {
    result: 'calculated',
    schedule: {
      scheduleKey: input.schedule.scheduleKey,
      version: input.schedule.version,
      name: input.schedule.name,
      termsVersion: input.schedule.termsVersion,
    },
    basis: 'discounted_item_subtotal',
    basisAmount,
    fee: { amount: calculation.feeMinor, currency: input.currency },
    net: { amount: input.basisMinor - calculation.feeMinor, currency: input.currency },
    explanation: calculation.explanation,
  };
}

/**
 * A stored snapshot, projected for the merchant order view and the operator
 * trace. Every figure comes off the ROW — never a live schedule — so the view
 * describes the order as it was priced (trust rule 3), and a `not_applicable`
 * row projects with NO fee field at all, exactly as it is stored.
 */
export function toOrderFeeSummary(row: OrderFeeSnapshotRecord): OrderFeeSummary {
  return {
    commercialMode: row.commercialMode,
    result: row.result,
    ...(row.scheduleKey !== null ? { scheduleKey: row.scheduleKey } : {}),
    ...(row.scheduleVersion !== null ? { scheduleVersion: row.scheduleVersion } : {}),
    ...(row.basis !== null ? { basis: row.basis } : {}),
    ...(row.basisAmountAmount !== null && row.basisAmountCurrency !== null
      ? { basisAmount: { amount: row.basisAmountAmount, currency: row.basisAmountCurrency } }
      : {}),
    ...(row.percentageBps !== null ? { percentageBps: row.percentageBps } : {}),
    ...(row.fixedFeeMinor !== null ? { fixedFeeMinor: row.fixedFeeMinor } : {}),
    ...(row.clampApplied !== null ? { clampApplied: row.clampApplied } : {}),
    ...(row.feeAmount !== null && row.feeCurrency !== null
      ? { fee: { amount: row.feeAmount, currency: row.feeCurrency } }
      : {}),
    ...(row.roundingAdjustmentMinor !== null
      ? { roundingAdjustmentMinor: row.roundingAdjustmentMinor }
      : {}),
    ...(row.termsVersionAccepted !== null
      ? { termsVersionAccepted: row.termsVersionAccepted }
      : {}),
    calculatedAt: row.createdAt.toISOString(),
    explanation: explainSnapshot(row),
  };
}

/**
 * Re-compose a stored snapshot's audit explanation from ITS OWN figures — the
 * stored components, never a live schedule — so the explanation an operator or
 * merchant reads describes the order as it was priced, whatever the schedule
 * table says today.
 */
export function explainSnapshot(row: OrderFeeSnapshotRecord): string {
  if (row.result === 'not_applicable') {
    const why: Record<Exclude<CommercialMode, 'connected_marketplace'>, string> = {
      mercaria_retail:
        'Mercaria is the seller on this order (mercaria_retail): the marketplace fee is ' +
        'structurally not applicable — there is no fee, not a zero-valued one.',
      external_referral:
        'This is an external referral: no marketplace fee applies. Any affiliate ' +
        'economics are recorded elsewhere and never through the fee schedule.',
      informational:
        'This record is informational: no transaction, no fee.',
    };
    return row.commercialMode === 'connected_marketplace'
      ? 'Not applicable.'
      : why[row.commercialMode];
  }
  if (row.result === 'no_active_schedule') {
    return (
      'No marketplace fee schedule was active for this order at pricing time; the ' +
      'marketplace fee is zero.'
    );
  }
  const currency = (row.feeCurrency ?? row.scopeCurrency ?? 'FAIR') as CurrencyCode;
  const parts: string[] = [
    `${((row.percentageBps ?? 0) / 100).toFixed(2)}% of ` +
      `${formatMinor(row.basisAmountAmount ?? 0, currency)} item subtotal after discounts` +
      ((row.roundingAdjustmentMinor ?? 0) > 0 ? ' (rounded half-up, +1 minor unit)' : ''),
  ];
  if (row.fixedFeeMinor !== null) {
    parts.push(`plus fixed ${formatMinor(row.fixedFeeMinor, currency)}`);
  }
  if (row.clampApplied === 'min') parts.push('raised to the schedule minimum');
  if (row.clampApplied === 'max') parts.push('capped at the schedule maximum');
  parts.push(
    `= ${formatMinor(row.feeAmount ?? 0, currency)} under schedule ` +
      `${row.scheduleKey ?? '?'} v${String(row.scheduleVersion ?? 0)}`,
  );
  return parts.join('; ');
}
