/**
 * Asking a supplier for a return authorization — the #124 seam, and it FAILS
 * CLOSED (#127 return rule 3).
 *
 * #124 built the whole contract: the `return_authorization` capability, the
 * `createReturn` / `readReturn` methods, `SupplierReturnInput` and
 * `SupplierReturn`, and `applyDeclaredCapabilities`' rule that a capability an
 * adapter did not declare has no representable success. It stopped there and
 * said so, because an RMA is a consequence of a CUSTOMER decision and the
 * procurement domain must not know one was made.
 *
 * This is the crossing, and it is deliberately NARROW: it takes ids and a
 * normalized reason and returns a provider-neutral answer, so no payment type,
 * no customer amount and no refund state crosses in either direction.
 *
 * ## Nothing is registered, so nothing is authorized
 *
 * No supplier adapter in this tree declares `return_authorization` — Printful
 * (#125) does not, and #119 §4 records why: Printful returns are a CLAIM process
 * rather than an API RMA. So every call answers `unavailable` with
 * `capability_not_declared`, the return case is opened in
 * `authorization_unavailable`, and the BUYER is told Mercaria is arranging it.
 *
 * That is the honest shape and it is the whole reason this is a port. A stub
 * that answered "authorized" with an invented reference would look exactly like
 * a working integration until a buyer posted a parcel to a warehouse expecting
 * nothing.
 *
 * ## The customer's refund does not wait for it
 *
 * ADR 0004 D8.5, and it is a property of the call graph rather than a rule: the
 * decision service commits the refund from `refund-bridge.ts` and calls this
 * afterwards, best-effort. There is no code path in which this function's answer
 * reaches a refund amount or a refund's timing — `retail-service-isolation.test.ts`
 * asserts that the refund bridge does not import this module.
 */

import type { SupplierReturnState } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';

/** What Mercaria asks a supplier for. No customer fact crosses. */
export interface SupplierRmaRequest {
  readonly purchaseOrderId: string;
  /** Mercaria's normalized reason. The supplier's own vocabulary is theirs. */
  readonly reasonCode: string;
  /** Mercaria's own purchase-order line ids and quantities. */
  readonly lines: readonly { readonly purchaseOrderLineId: string; readonly quantity: number }[];
  /** Deterministic, so a retry converges on the RMA that exists. */
  readonly idempotencyKey: string;
}

/**
 * What came back. A STRING discriminant, for `strict: false`'s sake — without
 * `strictNullChecks` TypeScript does not narrow on a boolean-literal one, and
 * the caller must act on the difference.
 */
export type SupplierRmaOutcome =
  | {
      readonly outcome: 'authorized';
      readonly state: SupplierReturnState;
      readonly providerReference: string;
      readonly supplierDeadlineAt?: Date;
    }
  | { readonly outcome: 'rejected'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string };

/** What a registered adapter bridge must satisfy. */
export interface SupplierRmaPort {
  requestAuthorization(request: SupplierRmaRequest): Promise<SupplierRmaOutcome>;
  readAuthorization(input: {
    purchaseOrderId: string;
    providerReference: string;
  }): Promise<SupplierRmaOutcome>;
}

/**
 * The default, and the shipped one.
 *
 * Answers `unavailable` unconditionally with the reason #124's chokepoint would
 * produce anyway. It is the same value the real path returns for an adapter that
 * declared nothing, so wiring one in changes what a supplier can do and does not
 * change what this domain does with the answer.
 */
const unregisteredSupplierRmaPort: SupplierRmaPort = {
  async requestAuthorization() {
    return {
      outcome: 'unavailable',
      reason: 'capability_not_declared',
    };
  },
  async readAuthorization() {
    return {
      outcome: 'unavailable',
      reason: 'capability_not_declared',
    };
  },
};

let registered: SupplierRmaPort | undefined;

/**
 * Register the bridge onto #124's orchestration.
 *
 * ONE function, and the one line that closes this seam. It belongs to whoever
 * gives a supplier adapter `return_authorization` — the bridge has to go through
 * `services/supplier-orders/provider-call.ts`, which is #124's single chokepoint
 * onto a provider and where the account state, the suppression, the capability
 * check, the credential and the rate lease all live.
 */
export function registerSupplierRmaPort(port: SupplierRmaPort): void {
  if (registered !== undefined) {
    throw new Error('a supplier RMA port is already registered');
  }
  registered = port;
  log.general.info({}, '[RetailService] a supplier RMA port was registered');
}

/** The registered port, or the refusing default. */
export function supplierRmaPort(): SupplierRmaPort {
  return registered ?? unregisteredSupplierRmaPort;
}

/** Test-only: forget the registration so a suite can register its own. */
export function resetSupplierRmaPortForTests(): void {
  registered = undefined;
}
