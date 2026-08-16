/**
 * The Mercaria-side registries this domain resolves a mapping's target against,
 * for the two dimensions whose registry does not exist yet (#367 Workstream 11).
 *
 * Three of the five dimensions resolve against real tables or a real code
 * registry: `attribute` and `controlled_value` against #94's
 * `attribute_definitions` / `attribute_enum_values`, and `unit` against
 * `services/canonical/units.ts`. Two do not:
 *
 * - **`product_type`** — `product_type_definitions` is ADR 0007 D5's and lands
 *   at merge-order step 3. This branch was cut from a base that does not have
 *   it. Note that closing this seam does NOT give the target a foreign key:
 *   a mapping targets the stable KEY, and no unique constraint on `key` alone
 *   exists to point at.
 * - **`size_system`** — Mercaria has no size-system registry at all. ADR 0007 D4
 *   names `size_system` as one of the seven request-context dimensions and no
 *   issue has yet built the table, the key namespace or the conversion rules.
 *
 * ## Why a port whose default REFUSES, rather than a stub that agrees
 *
 * A default that answered "yes, that key exists" would make every mapping in
 * those two dimensions resolve against nothing, silently, in exactly the
 * deployments where the registry is missing. That is the shape #108 refused for
 * its message transport and #124 refused for its credential reader, and the
 * reasoning is the same: an unregistered dependency must fail like an
 * unconfigured one, visibly and with the row intact.
 *
 * So a `size_system` mapping is proposable, reviewable, versionable and
 * storable, and it resolves to `registry_unavailable` — which BLOCKS — until
 * somebody registers a reader. Closing either seam is one
 * `registerCatalogConceptRegistry` call and nothing else in this domain changes.
 *
 * ## The registry is a READER and nothing else
 *
 * `CatalogConceptRegistry` has one method and it answers a yes/no question about
 * a key. There is deliberately no "create this product type", no "find the
 * nearest match" and no "list every key": the first would let an external feed
 * mint a Mercaria concept (which `external-mapping-isolation.test.ts` forbids
 * outright), and the second is the nearest-match fallback this whole domain
 * exists to refuse.
 */

import type { CatalogExternalMappingDimension } from '@mercaria/shared-types';

/** The two dimensions with no Mercaria-side registry on this base. */
export type PortedConceptDimension = Extract<
  CatalogExternalMappingDimension,
  'product_type' | 'size_system'
>;

/** What a registry says about one key. A STRING discriminant — `strict: false`. */
export type ConceptExistence =
  | { readonly state: 'present' }
  | { readonly state: 'absent' }
  /** The registry itself is not available in this deployment. Blocks, never a soft no. */
  | { readonly state: 'unavailable'; readonly reason: string };

/**
 * A reader for one dimension's Mercaria-side registry.
 *
 * `version` is passed through so a mapping that deliberately pins a product-type
 * version can be checked against that version rather than against whichever is
 * current. `undefined` means "whichever version is current", which is what an
 * unpinned mapping means.
 */
export interface CatalogConceptRegistry {
  readonly dimension: PortedConceptDimension;
  conceptExists(key: string, version?: number): Promise<ConceptExistence>;
}

const REGISTRIES = new Map<PortedConceptDimension, CatalogConceptRegistry>();

/**
 * Register the reader for one dimension.
 *
 * Called once at boot by whoever owns the registry — ADR 0007 D5's product-type
 * issue for `product_type`, and whichever issue builds size systems for
 * `size_system`. Registering twice for one dimension is a programming error and
 * throws: two readers for one dimension are two answers to "does this concept
 * exist", and the one that answered would depend on import order.
 */
export function registerCatalogConceptRegistry(registry: CatalogConceptRegistry): void {
  if (REGISTRIES.has(registry.dimension)) {
    throw new Error(
      `A catalog concept registry for '${registry.dimension}' is already registered. ` +
        'Two readers for one dimension are two answers to one question.',
    );
  }
  REGISTRIES.set(registry.dimension, registry);
}

/** Test-only teardown. Production registers at boot and never unregisters. */
export function clearCatalogConceptRegistries(): void {
  REGISTRIES.clear();
}

/** Which dimensions currently have a reader. Read by the operator health surface. */
export function registeredConceptDimensions(): readonly PortedConceptDimension[] {
  return [...REGISTRIES.keys()].sort();
}

/**
 * Ask whether a Mercaria concept exists.
 *
 * The default — no registry — is `unavailable`, which the resolver turns into
 * `registry_unavailable` and which BLOCKS. It is deliberately not `absent`:
 * "Mercaria does not have this size system" and "Mercaria cannot currently
 * answer questions about size systems" lead an operator to opposite next
 * actions, and only one of them is worth opening a review for.
 */
export async function conceptExists(
  dimension: PortedConceptDimension,
  key: string,
  version?: number,
): Promise<ConceptExistence> {
  const registry = REGISTRIES.get(dimension);
  if (registry === undefined) {
    return {
      state: 'unavailable',
      reason:
        dimension === 'product_type'
          ? 'No product-type registry is registered. ADR 0007 D5 owns `product_type_definitions`.'
          : 'No size-system registry is registered. Mercaria has not built one.',
    };
  }
  return registry.conceptExists(key, version);
}
