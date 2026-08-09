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
 */

import type { SupplierPreflightAdapter } from './adapter.js';

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
