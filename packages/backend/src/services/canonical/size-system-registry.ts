/**
 * Publishing the size-system table to the external-mapping resolver
 * (#367 Workstream 11).
 *
 * `concept-registry.port.ts` promised that closing this seam is "one
 * `registerCatalogConceptRegistry` call and nothing else in this domain
 * changes". This is that call, and nothing in
 * `services/catalog-external-mappings/` moved to accommodate it.
 *
 * ## Why the adapter is its own module
 *
 * `size-systems.ts` is PURE — a table, a derivation and a lookup, importing one
 * type. Registering from inside it would make every importer of the table a
 * writer of a process-global registry, including a test that only wanted to
 * check a key and the migration runner that wanted neither. #62's rule about
 * adapters, one layer down: a registration is a CALL somebody makes at boot,
 * never a module side effect.
 *
 * ## The three answers, and why none of them is a soft yes
 *
 * `ConceptExistence` is three-valued and this registry can produce all three:
 *
 * - `present` — the table holds the key.
 * - `absent` — it does not. The resolver turns this into `target_unresolvable`,
 *   which BLOCKS and opens a review. Answering `present` to a key nobody
 *   declared is the whole failure the unregistered port was protecting against,
 *   and it would arrive silently in the deployments least able to notice.
 * - `unavailable` — a caller pinned a VERSION. See below.
 *
 * ## A pinned version is `unavailable`, not `present`
 *
 * The port passes `version` through "so a mapping that deliberately pins a
 * product-type version can be checked against that version". A code table has
 * no version history: it ships exactly one revision, the one this image was
 * built from. So the three candidate answers are a lie (`present` — we did not
 * check the version), a different lie (`absent` — Mercaria has the system) and
 * the truth: Mercaria cannot answer a question about a size system AS OF some
 * other version. That is precisely what `unavailable` means in this port, and
 * it blocks.
 *
 * No caller passes a version today — `resolution.service.ts` and
 * `preview.service.ts` both call `conceptExists(dimension, key)` with two
 * arguments and say why. The branch is therefore defensive, which is exactly
 * why it is TESTED: a defensive branch nobody drives is a claim, not a
 * behaviour.
 *
 * ## It cannot throw
 *
 * A registry that threw would propagate out of `verifyTarget`, out of
 * `computeResolution` and into whichever ingestion pass asked — turning one
 * unknown key into a failed run over a whole feed. There is nothing here to
 * throw: no database, no I/O, no parse, and a `Map` lookup behind a `typeof`
 * guard.
 */

import {
  registerCatalogConceptRegistry,
  type CatalogConceptRegistry,
  type ConceptExistence,
} from '../catalog-external-mappings/concept-registry.port.js';
import { resolveSizeSystem } from './size-systems.js';

/** The reader `conceptExists('size_system', …)` dispatches to once registered. */
export const sizeSystemConceptRegistry: CatalogConceptRegistry = {
  dimension: 'size_system',
  // Deliberately NOT `async`. The interface is asynchronous because the two
  // registries the port was written for read tables; this one reads a `Map`,
  // and an `async` body with nothing to await would only add a microtask to
  // every resolution. `Promise.resolve` states that plainly.
  conceptExists(key: string, version?: number): Promise<ConceptExistence> {
    if (version !== undefined) {
      return Promise.resolve({
        state: 'unavailable',
        reason:
          'The size-system registry is a code table with no version history, so a pinned ' +
          'version cannot be checked against it. Resolve without a version, or model the ' +
          'system as a versioned definition first.',
      });
    }
    return Promise.resolve(
      resolveSizeSystem(key) === null ? { state: 'absent' } : { state: 'present' },
    );
  },
};

/**
 * Publish the reader. Called once, at boot, from `index.ts`.
 *
 * Registering twice throws — the port's own decision, because two readers for
 * one dimension are two answers to one question and which one answered would
 * depend on import order.
 */
export function registerSizeSystemConceptRegistry(): void {
  registerCatalogConceptRegistry(sizeSystemConceptRegistry);
}
