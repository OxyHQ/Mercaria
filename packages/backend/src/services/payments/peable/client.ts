/**
 * Mercaria's one way to reach the Peable gateway.
 *
 * The payment rail and the merchant-billing cohort both speak to Peable as
 * Mercaria's own Oxy identity (the task role on ECS) — never a Peable
 * credential — and both under the same transport rules, so they are written
 * once.
 */

import { type Peable, peableForOxyService } from '@peable.to/sdk';
import { requiredOxyServiceClient } from '../../../capabilities/oxy-service-client.js';
import { config } from '../../../config/index.js';

/**
 * How every Mercaria call to Peable is made.
 *
 * ONE attempt per call, bounded. Retrying belongs to Mercaria's caller — the
 * payment outbox, or the billing intent the merchant retries — under the
 * durable key it derived (ADR 0001 D11), and each caller decides from a
 * failure's `retryable` classification. A second retry layer inside the SDK
 * would hide those failures from that decision, turn a lost response into a
 * silent success the caller never observed as unknown, and stack its backoff
 * onto a checkout request.
 *
 * Exported so a suite that builds its client against a fixture gateway builds
 * it the way production does.
 */
export const PEABLE_TRANSPORT = { timeout: 20_000, maxNetworkRetries: 0 } as const;

export function createPeableClient(): Peable {
  return peableForOxyService({
    oxy: requiredOxyServiceClient(),
    baseURL: config.payments.peable.baseUrl,
    ...PEABLE_TRANSPORT,
  });
}
