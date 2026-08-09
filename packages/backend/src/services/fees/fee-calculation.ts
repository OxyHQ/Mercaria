/**
 * Marketplace fee selection and calculation (#88) — PURE.
 *
 * Money in, fee out: no database, no clock, no configuration. The same shape as
 * `ledger-postings.ts` and for the same reason — the commission is the part
 * that has to be right the first time, and a pure function is what lets every
 * rule below be table-tested against worked examples.
 *
 * ## The fee base is explicit, and nothing else can enter
 *
 * `discounted_item_subtotal`: the order's item line totals MINUS their
 * allocated item-level discounts, presentment side. The calculator is handed
 * exactly those two figures per line — tax, delivery, shipping-targeted
 * discounts and every other amount have no parameter, so they cannot enter
 * accidentally (#88 calculation rule 2). A negative per-line base is clamped to
 * zero (an over-allocated discount must not turn into a negative fee on a
 * sibling line).
 *
 * ## Rounding happens ONCE, and the rule is written down
 *
 * The percentage component is `basis × bps / 10000`, rounded HALF-UP once at
 * the ORDER level; the 0-or-1 unit that rounding added over truncation is
 * recorded as the snapshot's `roundingAdjustmentMinor`. The fixed component and
 * the min/max clamps are integer minor units and never round. Line allocations
 * then split the ROUNDED order fee by `apportion` — the settlement domain's own
 * largest-remainder rule — so they reconcile to the order fee exactly
 * (#88 calculation rules 3–4).
 *
 * ## One currency per fee
 *
 * The fee is denominated in the order's presentment currency, full stop. A
 * schedule carrying a fixed component or a clamp has that currency PINNED by
 * the database (`fee_schedules_fixed_fee_scope_check` / `_clamp_scope_check`),
 * and selection only matches such a schedule to orders in that currency — so a
 * cross-currency fixed fee is unrepresentable upstream, and the calculator
 * still refuses one defensively rather than converting (#88 rule 5: fail, never
 * mix).
 *
 * ## What is structurally ABSENT from every signature here
 *
 * Buyer identity, authentication state, guest origin, Oxy claim status,
 * payment-method identity, contact data. No parameter carries them, so a guest
 * checkout and an authenticated checkout with the same commercial facts reach
 * byte-identical fees (#88 rules 9–10), and no schedule can select on any of
 * them (trust rule 7).
 */

import type {
  CurrencyCode,
  FeeClamp,
  FeeRefundPolicy,
  FeeTaxTreatment,
  OrderSellerType,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount, CURRENCY_PRECISION } from '@mercaria/shared-types';
import { conflict } from '../../lib/errors/error-codes.js';
import { apportion } from '../payments/settlement-shares.js';

/**
 * One fee schedule version as the calculator consumes it — the policy columns
 * of a `fee_schedules` row, which satisfies this shape structurally.
 */
export interface EffectiveFeeSchedule {
  scheduleKey: string;
  version: number;
  name: string;
  effectiveStart: Date;
  effectiveEnd: Date | null;
  eligibleSellerType: OrderSellerType | null;
  eligibleCurrency: CurrencyCode | null;
  percentageBps: number;
  fixedFeeAmount: number | null;
  fixedFeeCurrency: CurrencyCode | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
  taxTreatment: FeeTaxTreatment;
  refundPolicy: FeeRefundPolicy;
  termsVersion: string;
}

/**
 * The commercial facts schedule selection reads — the COMPLETE set. These two
 * are what the snapshot records as `scope_seller_type` / `scope_currency`.
 */
export interface FeeSelectionFacts {
  sellerType: OrderSellerType;
  currency: CurrencyCode;
}

/**
 * Pick the schedule in force for one order's facts at one instant, or none.
 *
 * `at` is the AUTHORITATIVE PRICING TIME — checkout passes the moment it prices
 * the order (#88 calculation rule 7). A version activated later selects only
 * for later orders; the placed order keeps its snapshot whatever happens to the
 * schedule table (acceptance criterion 3).
 *
 * TWO schedules matching one set of facts is refused, loudly, BEFORE any money
 * moves (acceptance criterion 6): there is no tie-break that is not a silent
 * policy decision, and operators must scope active schedules disjointly. The
 * refusal is a `conflict` — the request is well formed and the deployment's
 * configuration cannot serve it.
 */
export function selectFeeSchedule<T extends EffectiveFeeSchedule>(input: {
  schedules: readonly T[];
  facts: FeeSelectionFacts;
  at: Date;
}): T | undefined {
  const { schedules, facts, at } = input;
  const matching = schedules.filter(
    (schedule) =>
      schedule.effectiveStart.getTime() <= at.getTime() &&
      (schedule.effectiveEnd === null || schedule.effectiveEnd.getTime() > at.getTime()) &&
      (schedule.eligibleSellerType === null || schedule.eligibleSellerType === facts.sellerType) &&
      (schedule.eligibleCurrency === null || schedule.eligibleCurrency === facts.currency),
  );
  if (matching.length > 1) {
    const names = matching.map((s) => `${s.scheduleKey} v${String(s.version)}`).join(', ');
    throw conflict(
      `More than one fee schedule matches this order (${names}). Marketplace fee ` +
        'configuration is ambiguous; no order can be placed under it until the ' +
        'schedules are scoped disjointly.',
    );
  }
  return matching[0];
}

/** One order line's contribution to the fee base, presentment side. */
export interface FeeBasisLine {
  /** The line total (`unit price × quantity`), in minor units. */
  lineTotalMinor: number;
  /** The item-level discount allocated to this line, in minor units. */
  discountMinor: number;
}

/** What one order's fee calculation concluded — everything the snapshot stores. */
export interface FeeCalculation {
  basisMinor: number;
  feeMinor: number;
  /** What half-up rounding added over truncation: 0 or 1 minor unit. */
  roundingAdjustmentMinor: number;
  /** Which schedule clamp bound the fee, when one did. */
  clampApplied?: FeeClamp;
  /** The order fee split across the lines, summing to `feeMinor` EXACTLY. */
  lineAllocationsMinor: number[];
  /** The audit line a merchant preview and an operator trace both show. */
  explanation: string;
}

/**
 * Calculate one connected-marketplace order's fee under one schedule.
 *
 * Deterministic in its arguments alone — no clock, no randomness — which is
 * what makes an idempotent checkout replay produce a byte-identical snapshot
 * (#88 calculation rule 8).
 *
 * The fee is CAPPED at its own basis (a `min_fee` larger than a tiny order's
 * items takes the whole basis and no more), so a seller's net item revenue
 * never goes negative and the settlement clamp downstream is a defence rather
 * than a policy. The cap is also a CHECK on the snapshot row
 * (`order_fee_snapshots_fee_within_basis_check`).
 */
export function calculateFee(input: {
  schedule: EffectiveFeeSchedule;
  currency: CurrencyCode;
  lines: readonly FeeBasisLine[];
}): FeeCalculation {
  const { schedule, currency, lines } = input;

  // Defence in depth: the schema CHECKs make a fixed component or clamp in any
  // currency but the pinned one unrepresentable, and selection only matches the
  // pinned currency. Reaching here with a mismatch means one of those broke —
  // refuse rather than convert, because a converted fee is a second FX authority.
  if (schedule.fixedFeeAmount !== null && schedule.fixedFeeCurrency !== currency) {
    throw conflict(
      `Fee schedule ${schedule.scheduleKey} v${String(schedule.version)} carries a fixed ` +
        `component in ${String(schedule.fixedFeeCurrency)} but the order is priced in ` +
        `${currency}; a fee never mixes currencies.`,
    );
  }
  if (
    (schedule.minFeeMinor !== null || schedule.maxFeeMinor !== null) &&
    schedule.eligibleCurrency !== currency
  ) {
    throw conflict(
      `Fee schedule ${schedule.scheduleKey} v${String(schedule.version)} clamps in ` +
        `${String(schedule.eligibleCurrency)} but the order is priced in ${currency}; ` +
        'a fee never mixes currencies.',
    );
  }

  const lineBases = lines.map((line, index) => {
    assertSafeMoneyAmount(line.lineTotalMinor, `fee.line[${String(index)}].lineTotal`);
    assertSafeMoneyAmount(line.discountMinor, `fee.line[${String(index)}].discount`);
    const base = line.lineTotalMinor - line.discountMinor;
    return base > 0 ? base : 0;
  });
  const basisMinor = lineBases.reduce((sum, base) => sum + base, 0);
  assertSafeMoneyAmount(basisMinor, 'fee.basis');

  // The percentage component, in bigint so `basis × bps` cannot lose precision,
  // rounded HALF-UP once. `roundingAdjustment` is what rounding added over
  // truncation — the figure the snapshot records so the arithmetic is auditable.
  const scaled = BigInt(basisMinor) * BigInt(schedule.percentageBps);
  const truncated = scaled / 10_000n;
  const remainder = scaled % 10_000n;
  const roundedUp = remainder * 2n >= 10_000n;
  const percentageMinor = Number(truncated) + (roundedUp ? 1 : 0);
  const roundingAdjustmentMinor = roundedUp ? 1 : 0;

  let feeMinor = percentageMinor + (schedule.fixedFeeAmount ?? 0);
  let clampApplied: FeeClamp | undefined;
  if (schedule.minFeeMinor !== null && feeMinor < schedule.minFeeMinor) {
    feeMinor = schedule.minFeeMinor;
    clampApplied = 'min';
  }
  if (schedule.maxFeeMinor !== null && feeMinor > schedule.maxFeeMinor) {
    feeMinor = schedule.maxFeeMinor;
    clampApplied = 'max';
  }
  const cappedAtBasis = feeMinor > basisMinor;
  if (cappedAtBasis) {
    feeMinor = basisMinor;
  }
  assertSafeMoneyAmount(feeMinor, 'fee.amount');

  const lineAllocationsMinor = apportion({
    totalMinor: BigInt(feeMinor),
    weights: lineBases.map((base) => BigInt(base)),
  }).map((part, index) => {
    const asNumber = Number(part);
    assertSafeMoneyAmount(asNumber, `fee.lineAllocation[${String(index)}]`);
    return asNumber;
  });

  return {
    basisMinor,
    feeMinor,
    roundingAdjustmentMinor,
    ...(clampApplied ? { clampApplied } : {}),
    lineAllocationsMinor,
    explanation: explain({
      schedule,
      currency,
      basisMinor,
      percentageMinor,
      roundingAdjustmentMinor,
      feeMinor,
      clampApplied,
      cappedAtBasis,
    }),
  };
}

/** `12345` in EUR → `"123.45 EUR"`, at the currency's own precision. */
export function formatMinor(amountMinor: number, currency: CurrencyCode): string {
  const precision = CURRENCY_PRECISION[currency];
  if (precision === 0) return `${String(amountMinor)} ${currency}`;
  const scale = 10 ** precision;
  const sign = amountMinor < 0 ? '-' : '';
  const magnitude = Math.abs(amountMinor);
  const major = Math.floor(magnitude / scale);
  const fraction = String(magnitude % scale).padStart(precision, '0');
  return `${sign}${String(major)}.${fraction} ${currency}`;
}

/** The audit sentence — composed from the SAME figures the snapshot stores. */
function explain(input: {
  schedule: EffectiveFeeSchedule;
  currency: CurrencyCode;
  basisMinor: number;
  percentageMinor: number;
  roundingAdjustmentMinor: number;
  feeMinor: number;
  clampApplied: FeeClamp | undefined;
  cappedAtBasis: boolean;
}): string {
  const { schedule, currency } = input;
  const parts: string[] = [
    `${(schedule.percentageBps / 100).toFixed(2)}% of ${formatMinor(input.basisMinor, currency)} ` +
      `item subtotal after discounts = ${formatMinor(input.percentageMinor, currency)}` +
      (input.roundingAdjustmentMinor > 0 ? ' (rounded half-up, +1 minor unit)' : ''),
  ];
  if (schedule.fixedFeeAmount !== null) {
    parts.push(`plus fixed ${formatMinor(schedule.fixedFeeAmount, currency)}`);
  }
  if (input.clampApplied === 'min' && schedule.minFeeMinor !== null) {
    parts.push(`raised to the schedule minimum ${formatMinor(schedule.minFeeMinor, currency)}`);
  }
  if (input.clampApplied === 'max' && schedule.maxFeeMinor !== null) {
    parts.push(`capped at the schedule maximum ${formatMinor(schedule.maxFeeMinor, currency)}`);
  }
  if (input.cappedAtBasis) {
    parts.push('capped at the fee basis (a marketplace fee never exceeds the items it is charged on)');
  }
  parts.push(
    `= ${formatMinor(input.feeMinor, currency)} under schedule ${schedule.scheduleKey} ` +
      `v${String(schedule.version)} (${schedule.name})`,
  );
  return parts.join('; ');
}
