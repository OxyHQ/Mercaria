/**
 * Money across the Peable boundary — the ONE conversion in each direction.
 *
 * Mercaria's `Money.amount` is a JS `number` of minor units; the gateway's
 * contract is a canonical integer `string`, because it works in unbounded
 * `bigint`. Both directions REFUSE anything that is not a safe non-negative
 * integer rather than rounding: an amount that silently loses precision is a
 * charge, a refund or a payout nobody authorised. Refused as PERMANENT, because
 * no retry makes a number representable.
 */

import type { Money } from '@mercaria/shared-types';
import { PaymentProviderError, type PaymentProviderStage } from '../provider.js';

function unusable(stage: PaymentProviderStage, what: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'peable',
    stage,
    message: `${what} is not a safe non-negative integer of minor units`,
    retryable: false,
  });
}

/** A `Money` as the gateway's canonical integer string. */
export function toGatewayAmount(money: Money, stage: PaymentProviderStage): string {
  if (!Number.isSafeInteger(money.amount) || money.amount < 0) {
    throw unusable(stage, String(money.amount));
  }
  return String(money.amount);
}

/** A gateway amount string as Mercaria's minor-unit number. */
export function fromGatewayAmount(value: string, stage: PaymentProviderStage): number {
  const amount = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(amount)) {
    throw unusable(stage, `the gateway's '${value}'`);
  }
  return amount;
}
