/**
 * Which adapter serves which supplier platform (#122, and the seam #124 fills).
 *
 * The `services/payments/registry.ts` shape: a module-level map, populated at
 * startup, read on the request path. It is EMPTY in this repository — no
 * provider-specific adapter is written here, which is #124's work — and an
 * unregistered provider is not an error but an ANSWER: `unknown` availability
 * with `provider_unconfigured`, which blocks checkout. A deployment that has
 * not integrated a supplier can therefore run this whole domain and refuse
 * every sale from it, which is the correct behaviour and the one a stub
 * returning optimistic defaults would destroy.
 *
 * ## Registration validates the declaration against the implementation
 *
 * An adapter that declares `inventory_reservation` but cannot release one is
 * refused at registration. A hold nobody can hand back is a leak with a
 * supplier's stock in it, and the sweep that exists to release lapsed holds
 * would silently do nothing for that provider forever — the kind of gap that is
 * invisible until a supplier asks why their availability keeps dropping.
 *
 * #124 extends that check to the ORDER capabilities, one row per pair in
 * {@link CAPABILITY_METHODS}. The consequence there is larger and in the same
 * direction: an adapter declaring `order_cancellation` with no `cancelOrder`
 * puts a cancel path in front of a buyer that nothing could ever send, and an
 * adapter declaring `order_reference_lookup` with no
 * `findOrderByClientReference` promises the ambiguity converger a lookup it
 * does not have — which is exactly the promise that decides whether a lost
 * response becomes a second supplier order.
 */

import type { SupplierAdapterCapability } from '@mercaria/shared-types';
import type { SupplierPreflightAdapter } from './adapter.js';

/**
 * Which declared capability requires which method on the adapter object.
 *
 * A TABLE rather than a chain of `if`s, so adding a capability without deciding
 * what implements it is a visible omission. Two capabilities are deliberately
 * absent because they license CONTENT other methods return rather than a call
 * of their own: `order_partial_acceptance` (line outcomes) and `tracking_events`
 * (carrier scans) are enforced at the capability boundary, not here.
 */
const CAPABILITY_METHODS: Readonly<Partial<Record<SupplierAdapterCapability, readonly string[]>>> = {
  inventory_reservation: ['releaseReservation'],
  order_draft_submission: ['submitOrder'],
  order_state_read: ['readOrder'],
  order_reference_lookup: ['findOrderByClientReference'],
  order_cancellation: ['cancelOrder'],
  shipment_read: ['readShipments'],
  invoice_retrieval: ['readInvoice'],
  credit_note_retrieval: ['readCreditNotes'],
  return_authorization: ['createReturn', 'readReturn'],
  order_webhooks: ['verifyWebhook'],
  order_polling: ['pollChanges'],
};

/** Provider slug → adapter. Populated at startup; empty in this repository. */
const adapters = new Map<string, SupplierPreflightAdapter>();

/**
 * Register one adapter, refusing a declaration the implementation cannot honour.
 *
 * Re-registering the same slug REPLACES, deliberately: startup ordering across
 * lazily-imported modules is not something a registry should have an opinion
 * about, and a duplicate registration is a configuration mistake that shows up
 * as the wrong adapter answering rather than as a boot failure. What is refused
 * is the shape that would be silently broken.
 */
export function registerSupplierAdapter(adapter: SupplierPreflightAdapter): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(adapter.provider)) {
    throw new Error(
      `Supplier adapter provider \`${adapter.provider}\` is not a machine slug. It must match ` +
        "`supplier_accounts.provider`'s own CHECK, which the account rows are keyed on.",
    );
  }
  if (adapter.capabilities.includes('inventory_reservation') && !adapter.releaseReservation) {
    throw new Error(
      `Supplier adapter \`${adapter.provider}\` declares \`inventory_reservation\` but ` +
        'implements no `releaseReservation`. A hold nobody can hand back is a leak with a ' +
        'supplier’s stock in it, and the release sweep would silently do nothing for it.',
    );
  }
  // The declaration is checked against the implementation for every capability
  // that names one. `Reflect.get` rather than a cast, because the order-side
  // methods live on `SupplierOrderAdapter` (which extends this interface) and
  // the registry deliberately accepts the base one — a preflight-only supplier
  // is a legitimate registration.
  for (const capability of adapter.capabilities) {
    for (const method of CAPABILITY_METHODS[capability] ?? []) {
      const implementation: unknown = Reflect.get(adapter, method);
      if (typeof implementation !== 'function') {
        throw new Error(
          `Supplier adapter \`${adapter.provider}\` declares \`${capability}\` but implements ` +
            `no \`${method}\`. A declared capability with no implementation is a promise the ` +
            'orchestration acts on: it will route work to this adapter that nothing can ' +
            'perform, and the failure surfaces as a stuck purchase order rather than as a ' +
            'configuration mistake.',
        );
      }
    }
  }
  adapters.set(adapter.provider, adapter);
}

/** The adapter for one provider slug, or nothing. */
export function findSupplierAdapter(provider: string): SupplierPreflightAdapter | undefined {
  return adapters.get(provider);
}

/** Every registered provider slug — the operator surface's capability report. */
export function listRegisteredSupplierProviders(): readonly string[] {
  return [...adapters.keys()].sort();
}

/**
 * Empty the registry.
 *
 * Exists for tests, which register a fake adapter and must not leak it into the
 * next file — the module-level map is process-wide, and vitest shares a process
 * across the tests in one file.
 */
export function clearSupplierAdapters(): void {
  adapters.clear();
}
