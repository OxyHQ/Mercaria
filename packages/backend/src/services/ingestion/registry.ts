/**
 * The adapter registry — which provider slugs this deployment can actually
 * fetch.
 *
 * ## The registry gates the LOOP, never the record
 *
 * A `catalog_source_configs` row may name a provider nobody has shipped an
 * adapter for. That is the `CROWDSOURCE_ENABLED` rule one layer down: the
 * durable configuration is accepted, the run refuses with `adapter_missing`,
 * and shipping the adapter drains the backlog instead of requiring somebody to
 * re-enter the configuration. `catalog_source_configs.provider` therefore
 * carries a shape CHECK and not a value CHECK, the `offers.provider` decision
 * for its reason.
 *
 * ## No adapter is registered by default, on purpose
 *
 * #62 is the framework; #63, #65 and #66 are the adapters. A deployment running
 * this code today can configure sources, review their policies, open runs and
 * see every one of them refuse for want of an adapter — which is a seam that
 * FAILS CLOSED and reports why, rather than a stub that pretends to fetch.
 *
 * The one adapter that exists is `adapters/fixture.ts`, and it is not
 * registered here: the contract suite and the end-to-end realdb test register
 * it themselves. A test-only provider auto-registered in production is exactly
 * the kind of thing that ends up ingesting into a live catalogue.
 */

import type { CatalogSourceAdapter } from './adapter.js';

const adapters = new Map<string, CatalogSourceAdapter>();

/**
 * Register an adapter for its provider slug.
 *
 * Refuses a SECOND registration for one slug rather than replacing it. Two
 * adapters answering for one provider is a wiring mistake with no correct
 * resolution — whichever registered last would silently own every source of
 * that provider — and a throw at module load is where that is cheapest to find.
 */
export function registerCatalogSourceAdapter(adapter: CatalogSourceAdapter): void {
  const existing = adapters.get(adapter.provider);
  if (existing !== undefined && existing !== adapter) {
    throw new Error(
      `A catalog source adapter is already registered for provider '${adapter.provider}'.`,
    );
  }
  adapters.set(adapter.provider, adapter);
}

/** The adapter for a provider slug, or `undefined` if none is shipped. */
export function resolveCatalogSourceAdapter(provider: string): CatalogSourceAdapter | undefined {
  return adapters.get(provider);
}

/** Every registered provider slug — the operator surface's capability read. */
export function registeredCatalogSourceProviders(): readonly string[] {
  return [...adapters.keys()].sort();
}

/**
 * Drop a registration.
 *
 * Exists for the contract suite, which registers a fixture adapter per case and
 * must not leak it into the next one. Production never calls it, and it is
 * exported rather than hidden behind a test-only import path because a second
 * module reaching into this one's `Map` would be the worse arrangement.
 */
export function unregisterCatalogSourceAdapter(provider: string): void {
  adapters.delete(provider);
}
