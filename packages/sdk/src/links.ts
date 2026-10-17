import type {
  MercariaCollection,
  MercariaCollectionRef,
  MercariaLocation,
  MercariaLocationRef,
  MercariaOffer,
  MercariaOfferAction,
  MercariaProductRef,
  MercariaProductSummary,
} from './contract';
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
 * - location:   `${web}/stores/${encodeURIComponent(storeHandle)}?location=${encodeURIComponent(locationId)}`
 *
 * A catalog product's `url` is built from its CURRENT slug, which no ref
 * carries, so there is no builder for it: use the `url` the body serves.
 * {@link MercariaLinks.offer} is the exception the other way round — an
 * outbound offer's body carries a path RELATIVE to the API origin, which only
 * the client knows.
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

/** A product as {@link MercariaLinks.product} accepts it: an id, a ref, or any product DTO. */
export type MercariaProductLinkTarget =
  | string
  | MercariaProductRef
  | Pick<MercariaProductSummary, 'ref'>;

/** A collection as {@link MercariaLinks.collection} accepts it: an id, a ref, or a collection DTO. */
export type MercariaCollectionLinkTarget =
  | string
  | MercariaCollectionRef
  | Pick<MercariaCollection, 'ref'>;

/** A location as {@link MercariaLinks.location} accepts it: an id, a ref, or a location DTO. */
export type MercariaLocationLinkTarget =
  | string
  | MercariaLocationRef
  | Pick<MercariaLocation, 'ref'>;

/**
 * An offer as {@link MercariaLinks.offer} accepts it: the offer, or its action.
 * Taken from the contract's own types (`Pick`), so it accepts exactly what a
 * read returned under any compiler setting — a consumer compiled with
 * `strict: false` infers every contract key optional, and a hand-written
 * `{ action: … }` would refuse the offer that consumer was just handed.
 */
export type MercariaOfferLinkTarget = MercariaOfferAction | Pick<MercariaOffer, 'action'>;

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
  collection(
    collection: MercariaCollectionLinkTarget,
    store: string | MercariaHandleSource,
  ): string;
  /**
   * A location on its store's page, which opens on it. A `MercariaLocation`
   * carries its store's current handle: `links.location(location, location.store)`.
   */
  location(location: MercariaLocationLinkTarget, store: string | MercariaHandleSource): string;
  /**
   * Where following a catalog offer goes, or `null` when there is nowhere: the
   * Mercaria redirect (on this client's API origin) for an outbound offer —
   * publish it with the action's `rel` and name its `destinationHost` beside
   * it — or the product page for a native one.
   */
  offer(offer: MercariaOfferLinkTarget): string | null;
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MercariaValidationError(`${what} must be a non-empty string`);
  }
  return value;
}

function refId(value: unknown, kind: 'product' | 'collection' | 'location'): string {
  if (typeof value === 'string') return nonEmpty(value, `${kind} id`);
  const direct = parseMercariaRef(value);
  if (direct?.kind === kind) return direct.id;
  if (typeof value === 'object' && value !== null && 'ref' in value) {
    const nested = parseMercariaRef((value as { ref: unknown }).ref);
    if (nested?.kind === kind) return nested.id;
  }
  throw new MercariaValidationError(
    `expected a ${kind} id, a ${kind} ref, or an object with a ${kind} ref`,
  );
}

function handleOf(value: unknown): string {
  if (typeof value === 'string') return nonEmpty(value, 'store handle');
  if (typeof value === 'object' && value !== null && 'handle' in value) {
    return nonEmpty((value as MercariaHandleSource).handle, 'store handle');
  }
  throw new MercariaValidationError('expected a store handle or an object carrying one');
}

function actionOf(value: unknown): MercariaOfferAction {
  const candidate =
    typeof value === 'object' && value !== null && 'action' in value
      ? (value as { action: unknown }).action
      : value;
  if (typeof candidate === 'object' && candidate !== null && 'kind' in candidate) {
    return candidate as MercariaOfferAction;
  }
  throw new MercariaValidationError('expected a catalog offer or its action');
}

export function createLinks(webBaseUrl: string, apiBaseUrl: string): MercariaLinks {
  return Object.freeze({
    product: (product: MercariaProductLinkTarget) =>
      `${webBaseUrl}/products/${encodeURIComponent(refId(product, 'product'))}`,
    store: (store: string | MercariaHandleSource) =>
      `${webBaseUrl}/stores/${encodeURIComponent(handleOf(store))}`,
    collection: (collection: MercariaCollectionLinkTarget, store: string | MercariaHandleSource) =>
      `${webBaseUrl}/stores/${encodeURIComponent(handleOf(store))}?collection=${encodeURIComponent(
        refId(collection, 'collection'),
      )}`,
    location: (location: MercariaLocationLinkTarget, store: string | MercariaHandleSource) =>
      `${webBaseUrl}/stores/${encodeURIComponent(handleOf(store))}?location=${encodeURIComponent(
        refId(location, 'location'),
      )}`,
    offer: (offer: MercariaOfferLinkTarget) => {
      const action = actionOf(offer);
      switch (action.kind) {
        case 'outbound':
          if (!/^\/out\/[A-Za-z0-9_.~-]+$/.test(action.path)) {
            throw new MercariaValidationError('not a Mercaria redirect path');
          }
          return `${apiBaseUrl}${action.path}`;
        case 'mercaria_checkout':
          return action.url;
        case 'none':
          return null;
        default:
          throw new MercariaValidationError('expected a catalog offer or its action');
      }
    },
  });
}
