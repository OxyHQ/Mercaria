import type { MercariaCollectionRef, MercariaProductRef } from './contract';
import { MercariaValidationError } from './errors';
import { parseMercariaRef } from './refs';

/**
 * Canonical Mercaria web URLs.
 *
 * These are the SAME strings the server writes into each DTO's `url`, built by
 * the same rules — a contract test asserts the equality:
 *
 * - product:    `${web}/products/${encodeURIComponent(productId)}`
 * - store:      `${web}/stores/${encodeURIComponent(storeHandle)}`
 * - collection: `${web}/stores/${encodeURIComponent(storeHandle)}?collection=${encodeURIComponent(collectionId)}`
 *
 * A store URL is built from the store's HANDLE, which a merchant can change,
 * so it cannot be built from a store ref alone: hydrate the store (or use the
 * `handle` a product's store seller carries) first. A link is presentation,
 * never identity — persist the ref, rebuild the link.
 */

/** Anything carrying a current store handle: a `MercariaStore`, a store seller, or `{ handle }`. */
export interface MercariaHandleSource {
  handle: string;
}

/** A product as {@link MercariaLinks.product} accepts it. */
export type MercariaProductLinkTarget = string | MercariaProductRef | { ref: MercariaProductRef };

/** A collection as {@link MercariaLinks.collection} accepts it. */
export type MercariaCollectionLinkTarget = string | MercariaCollectionRef | { ref: MercariaCollectionRef };

/** The link builders on a client. */
export interface MercariaLinks {
  /** The product page, from an id, a product ref, or any object with a product `ref`. */
  product(product: MercariaProductLinkTarget): string;
  /** The storefront, from a handle or anything carrying one. */
  store(store: string | MercariaHandleSource): string;
  /**
   * A collection within its storefront. Needs the store's current handle as
   * well as the collection, because a collection names its store by id only.
   */
  collection(collection: MercariaCollectionLinkTarget, store: string | MercariaHandleSource): string;
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MercariaValidationError(`${what} must be a non-empty string`);
  }
  return value;
}

function refId(value: unknown, kind: 'product' | 'collection'): string {
  if (typeof value === 'string') return nonEmpty(value, `${kind} id`);
  const direct = parseMercariaRef(value);
  if (direct?.kind === kind) return direct.id;
  if (typeof value === 'object' && value !== null && 'ref' in value) {
    const nested = parseMercariaRef((value as { ref: unknown }).ref);
    if (nested?.kind === kind) return nested.id;
  }
  throw new MercariaValidationError(`expected a ${kind} id, a ${kind} ref, or an object with a ${kind} ref`);
}

function handleOf(value: unknown): string {
  if (typeof value === 'string') return nonEmpty(value, 'store handle');
  if (typeof value === 'object' && value !== null && 'handle' in value) {
    return nonEmpty((value as MercariaHandleSource).handle, 'store handle');
  }
  throw new MercariaValidationError('expected a store handle or an object carrying one');
}

export function createLinks(webBaseUrl: string): MercariaLinks {
  return Object.freeze({
    product: (product: MercariaProductLinkTarget) =>
      `${webBaseUrl}/products/${encodeURIComponent(refId(product, 'product'))}`,
    store: (store: string | MercariaHandleSource) => `${webBaseUrl}/stores/${encodeURIComponent(handleOf(store))}`,
    collection: (collection: MercariaCollectionLinkTarget, store: string | MercariaHandleSource) =>
      `${webBaseUrl}/stores/${encodeURIComponent(handleOf(store))}?collection=${encodeURIComponent(
        refId(collection, 'collection'),
      )}`,
  });
}
