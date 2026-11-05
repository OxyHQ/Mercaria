/**
 * A Peable settlement figure, in Mercaria's vocabulary: what one movement came
 * to on the platform balance, and the rate that produced it.
 *
 * Peable reads it live from the acquirer (`GET /v1/refunds/{id}/settlement`,
 * `GET /v1/disputes/{id}/settlement`) and answers `null` figures with a
 * `status` when it has none — never `0`. This module keeps that distinction:
 * no figure is `undefined`, and the caller decides what an absent figure means
 * (a refund retries; a dispute without a withdrawal is an inquiry).
 *
 * `gross` is the MAGNITUDE of the movement in the SETTLEMENT currency, which
 * is what Mercaria books (ADR 0001 D7: a refund converts at the refund-time
 * rate, captured from the rail's own record and never derived from the
 * charge). The processor fee is not booked here, exactly as a Peable charge
 * books none yet (`event-router.ts`, "The fee gap").
 */

import {
  ALL_CURRENCY_CODES,
  type CurrencyCode,
  type FxRateSnapshot,
  type Money,
} from '@mercaria/shared-types';
import type { Peable } from '@peable.to/sdk';
import type { PaymentProviderStage } from '../provider.js';
import { fromGatewayAmount } from './amounts.js';

/** The gateway's `settlement` object, as its SDK answers it (one shape for all three reads). */
type Settlement = Awaited<ReturnType<Peable['refunds']['refundSettlement']>>;

/** A settled movement: the amount on the platform balance and how it got there. */
export interface SettledMovement {
  amount: Money;
  /** The fee on this movement, as the rail signs it — positive when charged. */
  feeMinor: number;
  rate: FxRateSnapshot;
}

function isCurrencyCode(value: string): value is CurrencyCode {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(value);
}

/**
 * The movement a settlement describes, or `undefined` when Peable has no figure
 * that can be booked: `unknown`, a figure missing, a currency Mercaria does not
 * keep, or a conversion without its rate (a contradiction this code refuses to
 * resolve by guessing a rate of 1).
 *
 * @param from The currency the movement was MADE in — the refund's or the
 *   dispute's own — which the rate converts from.
 * @throws {PaymentProviderError} (permanent) for a gross that is not a safe
 *   integer of minor units — no retry makes it representable.
 */
export function settledMovement(
  settlement: Settlement,
  from: CurrencyCode,
  stage: PaymentProviderStage,
): SettledMovement | undefined {
  if (settlement.status === 'unknown') return undefined;
  const { gross, currency, exchange_rate: exchangeRate } = settlement;
  if (gross === null || currency === null || !isCurrencyCode(currency)) return undefined;
  if (exchangeRate === null && currency !== from) return undefined;
  const fee = settlement.fee === null ? 0 : Number(settlement.fee);
  if (!Number.isSafeInteger(fee)) return undefined;
  return {
    amount: { amount: fromGatewayAmount(gross, stage), currency },
    feeMinor: fee,
    rate: {
      from,
      to: currency,
      rate: exchangeRate ?? 1,
      provider: exchangeRate === null ? 'identity' : 'peable',
      asOf: new Date().toISOString(),
    },
  };
}
