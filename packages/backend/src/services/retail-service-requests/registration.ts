/**
 * Wiring #127 into the two seams it consumes — called once at boot.
 *
 * ONE function, called unconditionally from `index.ts`. Unconditional because
 * neither registration gates a durable record and both are consequences rather
 * than capabilities: the dispute consumer answers "not a retail order" with a
 * no-op, and the reconciler reads its own lever.
 *
 * Registering from a module the payment domain does NOT import is what keeps the
 * dependency pointing one way — `services/payments/retail-dispute.port.ts` owns
 * the signature and this owns the body, so nothing in the payment domain ever
 * names this domain.
 */

import { registerRetailDisputeConsumer } from '../payments/retail-dispute.port.js';
import { coordinateRetailDispute } from './dispute-coordination.service.js';

/** Register #127's consumers. Idempotent — a second call replaces the same one. */
export function registerRetailServiceConsumers(): void {
  registerRetailDisputeConsumer({
    async coordinate(input) {
      // `coordinateRetailDispute` reads the order and returns immediately for a
      // non-retail one, so the payment domain may call this on EVERY dispute
      // without knowing which kind it is — which is what keeps the branch out
      // of the payment domain, where a retail concept has no business being.
      await coordinateRetailDispute(input);
    },
  });
}
