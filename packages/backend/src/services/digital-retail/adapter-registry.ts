/**
 * The digital supplier adapter registry (#1016 Workstream 2).
 *
 * Keyed by `supplier_accounts.provider`, which is a lower-case machine slug with
 * its own CHECK — so the account row and the registry key are the same string and
 * cannot drift into a lookup that silently finds nothing.
 *
 * ## Resolution FAILS rather than falling back
 *
 * There is no default adapter. An account naming a provider nobody registered is
 * a configuration error, and the alternative — a no-op adapter, or the first
 * registered one — would mean an order routed to a supplier nobody chose. The
 * throw lands in the orchestrator, which records the attempt as `failed` with a
 * normalized kind rather than leaving a customer's order in limbo.
 *
 * ## Registration is explicit and happens at wiring time
 *
 * No filesystem scan, no dynamic import by name. An adapter reaches production
 * because somebody wrote its registration beside the others, which is also where
 * a reviewer looks to answer "what can this deployment buy from".
 */

import type { DigitalSupplierAdapter } from './adapter.js';
import { createSandboxAdapter } from './sandbox-adapter.js';

const adapters = new Map<string, DigitalSupplierAdapter>();

/** Register one adapter. Re-registering the same slug REPLACES it, loudly in tests. */
export function registerDigitalSupplierAdapter(adapter: DigitalSupplierAdapter): void {
  adapters.set(adapter.provider, adapter);
}

/** Forget one. Tests use it; nothing in production does. */
export function unregisterDigitalSupplierAdapter(provider: string): void {
  adapters.delete(provider);
}

/** Every registered slug, for the operator surface and the health sweep. */
export function registeredDigitalSupplierProviders(): string[] {
  return [...adapters.keys()].sort();
}

/**
 * Resolve the adapter for a provider slug, or throw.
 *
 * The message names the slug and what IS registered, because the failure is
 * almost always a typo in an account row rather than a missing integration.
 */
export function resolveDigitalSupplierAdapter(provider: string): DigitalSupplierAdapter {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new Error(
      `no digital supplier adapter registered for "${provider}" ` +
        `(registered: ${registeredDigitalSupplierProviders().join(', ') || 'none'})`,
    );
  }
  return adapter;
}

/**
 * Register the adapters this deployment ships.
 *
 * ONE today, and it is a conformance fixture rather than a pilot: ADR 0011 says
 * no named distributor integration lands before its account and exact commercial
 * terms have been verified, because the epic forbids coding against guessed
 * capabilities. The sandbox is registered so the conformance suite, the
 * exactly-once property and the ambiguity recovery are exercised against
 * something that behaves like a supplier — including one that times out after
 * having actually sold you a key.
 */
export function registerBuiltInDigitalSupplierAdapters(): void {
  registerDigitalSupplierAdapter(createSandboxAdapter());
}
