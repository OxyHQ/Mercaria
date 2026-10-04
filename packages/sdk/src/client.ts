import type { z } from 'zod';
import {
  MercariaCollectionPageSchema,
  MercariaCollectionSchema,
  MercariaLocationListQuerySchema,
  MercariaLocationPageSchema,
  MercariaLocationProductPageSchema,
  MercariaLocationProductsQuerySchema,
  MercariaLocationSchema,
  MercariaPageQuerySchema,
  MercariaProductSchema,
  MercariaProductSearchQuerySchema,
  MercariaProductSummaryPageSchema,
  MercariaStoreLookupQuerySchema,
  MercariaStoreProductsQuerySchema,
  MercariaStoreSchema,
  classifyRequestIssues,
} from './contract';
import type {
  MercariaCollection,
  MercariaCollectionRef,
  MercariaLocation,
  MercariaLocationProduct,
  MercariaLocationRef,
  MercariaPage,
  MercariaProduct,
  MercariaProductRef,
  MercariaProductSort,
  MercariaProductSummary,
  MercariaPurchaseOption,
  MercariaStore,
  MercariaStoreRef,
  MercariaVariantRef,
} from './contract';
import { MercariaBadRequestError, MercariaNotFoundError, MercariaValidationError } from './errors';
import { createLinks, type MercariaLinks } from './links';
import { parseMercariaRef } from './refs';
import type { MercariaAbortSignal, MercariaFetch } from './runtime';
import {
  pathSegment,
  request,
  type MercariaAccessTokenGetter,
  type QueryValue,
  type TransportConfig,
} from './transport';

/** The public API origin a client talks to unless told otherwise. */
export const DEFAULT_MERCARIA_API_BASE_URL = 'https://api.mercaria.co';
/** The web origin links are built on unless told otherwise. */
export const DEFAULT_MERCARIA_WEB_BASE_URL = 'https://mercaria.co';
/** How long one request may take, token acquisition and body included. */
export const DEFAULT_MERCARIA_TIMEOUT_MS = 15_000;

export interface MercariaClientOptions {
  /** The API origin. Defaults to {@link DEFAULT_MERCARIA_API_BASE_URL}. */
  apiBaseUrl?: string;
  /** The web origin links are built on. Defaults to {@link DEFAULT_MERCARIA_WEB_BASE_URL}. */
  webBaseUrl?: string;
  /**
   * A `fetch` implementation. Defaults to the runtime's global `fetch`, looked
   * up on each request (so a polyfill installed after the client is created is
   * still used).
   */
  fetch?: MercariaFetch;
  /**
   * Supplies the current Oxy access token. Called before EVERY request and
   * never cached, stored or logged by the SDK — the host's Oxy auth package
   * owns the session and its refresh, and a copy held here would go stale.
   * Return `null`/`undefined` (or `''`) for an anonymous request. An error it
   * throws is passed through unchanged.
   */
  getAccessToken?: MercariaAccessTokenGetter;
  /**
   * The default locale (a BCP 47 tag such as `es` or `pt-BR`) for the list
   * reads that accept one — `products.search`, `stores.products` and
   * `locations.products`. Each of
   * those calls can override it. Locale is presentation: it never changes which
   * entity a ref names. Detail reads take no locale.
   */
  locale?: string;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_MERCARIA_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Extra, NON-auth headers sent with every request (e.g. a tracing id).
   * `Authorization` and `Accept` are owned by the SDK and rejected here; auth
   * goes through `getAccessToken`.
   */
  headers?: Readonly<Record<string, string>>;
}

/** Options every read accepts. */
export interface MercariaRequestOptions {
  /** Cancels the request; the promise rejects with `MercariaAbortError`. */
  signal?: MercariaAbortSignal;
}

/** Cursor pagination for list reads. */
export interface MercariaPageOptions extends MercariaRequestOptions {
  /** Page size, 1 to 50. The server's default is 20. */
  limit?: number;
  /** The opaque `nextCursor` of the previous page, verbatim. */
  cursor?: string;
}

/** Filters shared by the product list reads. */
export interface MercariaProductListOptions extends MercariaPageOptions {
  /** Full-text query. Blank is treated as absent. */
  query?: string;
  /**
   * `true` restricts the page to products that can be bought now. `false` and
   * absent are the same: no availability filter (there is no "only out of
   * stock" filter), so `false` is not sent.
   */
  inStock?: boolean;
  /** Ordering. `relevance` requires `query`. */
  sort?: MercariaProductSort;
  /** Overrides the client's default locale for this call. */
  locale?: string;
  /**
   * The opaque `nextCursor` of the previous page. A cursor is bound to the
   * filters, sort and list that produced it: pass it back with the SAME
   * `query`, `inStock`, `sort`, `locale` and store/collection, or the server
   * refuses it (`MercariaBadRequestError`). Changing `limit` between pages is
   * allowed.
   */
  cursor?: string;
}

/** Input to {@link MercariaProductsApi.search}. */
export interface MercariaProductSearchInput extends MercariaProductListOptions {
  /**
   * Restrict to one store, by ref or id. A store that does not exist or is no
   * longer public rejects the search with `MercariaNotFoundError` or
   * `MercariaGoneError` rather than returning an empty page.
   */
  store?: MercariaStoreRef | string;
  /** Restrict to one collection, by ref or id. Missing or gone rejects as for `store`. */
  collection?: MercariaCollectionRef | string;
}

/** A variant resolved through its product. */
export interface MercariaResolvedVariant {
  product: MercariaProduct;
  option: MercariaPurchaseOption;
}

export interface MercariaProductsApi {
  /**
   * Current product detail, by id or product ref. Detail reads accept no
   * locale (the server refuses any query parameter on them).
   */
  get(product: MercariaProductRef | string, options?: MercariaRequestOptions): Promise<MercariaProduct>;
  /** Hydrate a persisted product ref. */
  resolveRef(ref: MercariaProductRef, options?: MercariaRequestOptions): Promise<MercariaProduct>;
  /**
   * Hydrate a persisted variant ref: its product, and the purchase option it
   * names. Rejects with `MercariaNotFoundError` when the product no longer has
   * that option.
   */
  resolveVariant(ref: MercariaVariantRef, options?: MercariaRequestOptions): Promise<MercariaResolvedVariant>;
  /** Search the public catalogue. */
  search(input?: MercariaProductSearchInput): Promise<MercariaPage<MercariaProductSummary>>;
}

export interface MercariaStoresApi {
  /** A public storefront, by id or store ref. */
  get(store: MercariaStoreRef | string, options?: MercariaRequestOptions): Promise<MercariaStore>;
  /** Hydrate a persisted store ref. */
  resolveRef(ref: MercariaStoreRef, options?: MercariaRequestOptions): Promise<MercariaStore>;
  /** Find a storefront by its CURRENT handle. Persist the returned `ref`, not the handle. */
  lookup(input: { handle: string } & MercariaRequestOptions): Promise<MercariaStore>;
  /** One page of a store's products. */
  products(
    store: MercariaStoreRef | string,
    options?: MercariaProductListOptions,
  ): Promise<MercariaPage<MercariaProductSummary>>;
  /** One page of a store's published collections. */
  collections(
    store: MercariaStoreRef | string,
    options?: MercariaPageOptions,
  ): Promise<MercariaPage<MercariaCollection>>;
  /**
   * One page of a store's public locations (shop fronts). Read each one's
   * place facts — name, address, hours, photos — from GoWay with its
   * `goWayPlaceId`.
   */
  locations(store: MercariaStoreRef | string, options?: MercariaPageOptions): Promise<MercariaPage<MercariaLocation>>;
}

export interface MercariaCollectionsApi {
  /** A published collection, by id or collection ref. */
  get(collection: MercariaCollectionRef | string, options?: MercariaRequestOptions): Promise<MercariaCollection>;
  /** Hydrate a persisted collection ref. */
  resolveRef(ref: MercariaCollectionRef, options?: MercariaRequestOptions): Promise<MercariaCollection>;
  /** One page of a collection's products. */
  products(
    collection: MercariaCollectionRef | string,
    options?: MercariaPageOptions,
  ): Promise<MercariaPage<MercariaProductSummary>>;
}

/** Input to {@link MercariaLocationsApi.list}. */
export interface MercariaLocationListInput extends MercariaPageOptions {
  /** The GoWay place whose Mercaria locations to list. Required: there is no list of every location. */
  goWayPlaceId: string;
}

export interface MercariaLocationsApi {
  /**
   * The public locations trading from one GoWay place — what a map renders
   * "products at this store" from. A place nobody trades from is an empty page.
   */
  list(input: MercariaLocationListInput): Promise<MercariaPage<MercariaLocation>>;
  /**
   * A location's Mercaria half, by id or location ref: its store, its
   * collection terms and whether discovery routes shoppers there. Rejects with
   * `MercariaGoneError` once it is withdrawn or its place stops naming it, and
   * with `MercariaUnavailableError` when Mercaria could not ask GoWay — which
   * is NOT a reason to discard the ref.
   */
  get(location: MercariaLocationRef | string, options?: MercariaRequestOptions): Promise<MercariaLocation>;
  /** Hydrate a persisted location ref. */
  resolveRef(ref: MercariaLocationRef, options?: MercariaRequestOptions): Promise<MercariaLocation>;
  /**
   * One page of the store's products stocked at this location, each with a
   * bounded availability there. `inStock: true` keeps what is on this shelf now.
   */
  products(
    location: MercariaLocationRef | string,
    options?: MercariaProductListOptions,
  ): Promise<MercariaPage<MercariaLocationProduct>>;
}

export interface MercariaClient {
  readonly products: MercariaProductsApi;
  readonly stores: MercariaStoresApi;
  readonly collections: MercariaCollectionsApi;
  readonly locations: MercariaLocationsApi;
  readonly links: MercariaLinks;
}

// ── Option validation (programmer errors → TypeError, at creation) ──────────

const BASE_URL = /^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i;

function baseUrl(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !BASE_URL.test(value)) {
    throw new TypeError(`${name} must be an absolute http(s) URL without a query or fragment`);
  }
  return value.replace(/\/+$/, '');
}

/** A BCP 47-shaped tag. The server decides which locales it serves. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

function isLocale(value: unknown): value is string {
  return typeof value === 'string' && LOCALE.test(value);
}

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SDK_OWNED_HEADERS = ['authorization', 'accept'];

function extraHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('headers must be an object of header names to string values');
  }
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name) || typeof headerValue !== 'string') {
      throw new TypeError('headers must be an object of header names to string values');
    }
    if (SDK_OWNED_HEADERS.includes(name.toLowerCase())) {
      throw new TypeError(
        `headers may not set ${name}; the SDK owns it (pass getAccessToken for authorization)`,
      );
    }
    result[name] = headerValue;
  }
  return Object.freeze(result);
}

// ── Input validation (→ MercariaValidationError, no request sent) ───────────

type EntityKind = 'product' | 'store' | 'collection' | 'location';

function idOf(value: unknown, kind: EntityKind): string {
  if (typeof value === 'string') return pathSegment(value, `${kind} id`);
  const ref = parseMercariaRef(value);
  if (ref !== null && ref.kind === kind) return pathSegment(ref.id, `${kind} id`);
  throw new MercariaValidationError(`expected a ${kind} id or a ${kind} ref`);
}

function refIdOf(value: unknown, kind: EntityKind): string {
  const ref = parseMercariaRef(value);
  if (ref === null || ref.kind !== kind) throw new MercariaValidationError(`expected a ${kind} ref`);
  return pathSegment(ref.id, `${kind} id`);
}

function queryIdOf(value: unknown, kind: EntityKind): unknown {
  if (value === undefined || typeof value === 'string') return value;
  const ref = parseMercariaRef(value);
  if (ref !== null && ref.kind === kind) return ref.id;
  throw new MercariaValidationError(`${kind} must be a ${kind} ref or an id`);
}

function localeFor(override: unknown, fallback: string | undefined): string | undefined {
  if (override === undefined) return fallback;
  if (!isLocale(override)) throw new MercariaValidationError('locale must be a BCP 47 language tag');
  return override;
}

/** A query value as it goes on the wire; anything that is not a string is sent as one, for the schema to refuse. */
function wire(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

/**
 * The query to send, checked by the SAME contract schema the server validates
 * it with — so a request the server would refuse is refused here, with the
 * same classification: `MercariaBadRequestError` for a malformed one,
 * `MercariaValidationError` for refused values, `status: null` because nothing
 * was sent.
 */
function checkedQuery(schema: z.ZodType, query: Record<string, string | undefined>): Record<string, QueryValue> {
  const present = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const refusal = classifyRequestIssues(parsed.error.issues);
    const ErrorClass = refusal.code === 'bad_request' ? MercariaBadRequestError : MercariaValidationError;
    throw new ErrorClass(refusal.message, { details: refusal.details ?? null });
  }
  return present;
}

function pageQuery(options: MercariaPageOptions): Record<string, string | undefined> {
  return { limit: wire(options.limit), cursor: wire(options.cursor) };
}

function productListQuery(
  options: MercariaProductListOptions,
  defaultLocale: string | undefined,
): Record<string, string | undefined> {
  const { query, inStock } = options;
  return {
    ...pageQuery(options),
    // Blank is absent, and the query is sent trimmed: one page, one URL.
    q: typeof query === 'string' ? query.trim() || undefined : wire(query),
    // `inStock=false` filters nothing server-side, so only `true` is sent: the
    // same page must never have two URLs.
    inStock: inStock === true ? 'true' : inStock === false ? undefined : wire(inStock),
    sort: wire(options.sort),
    locale: localeFor(options.locale, defaultLocale),
  };
}

// ── The client ──────────────────────────────────────────────────────────────

/**
 * Create a Mercaria client. Every option is optional; with none, the client
 * reads anonymously from the production API.
 */
export function createMercariaClient(options: MercariaClientOptions = {}): MercariaClient {
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new TypeError('fetch must be a function');
  }
  if (options.getAccessToken !== undefined && typeof options.getAccessToken !== 'function') {
    throw new TypeError('getAccessToken must be a function');
  }
  if (options.locale !== undefined && !isLocale(options.locale)) {
    throw new TypeError('locale must be a BCP 47 language tag');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_MERCARIA_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('timeoutMs must be a positive integer number of milliseconds');
  }

  const config: TransportConfig = Object.freeze({
    apiBaseUrl: baseUrl(options.apiBaseUrl, 'apiBaseUrl', DEFAULT_MERCARIA_API_BASE_URL),
    fetch: options.fetch,
    getAccessToken: options.getAccessToken,
    timeoutMs,
    headers: extraHeaders(options.headers),
  });
  const webBaseUrl = baseUrl(options.webBaseUrl, 'webBaseUrl', DEFAULT_MERCARIA_WEB_BASE_URL);
  const defaultLocale = options.locale;

  // Detail reads send NO query parameters: the server refuses any it does not
  // name with a 400, the locale included.
  const getProduct = async (id: string, callOptions: MercariaRequestOptions = {}) =>
    request(config, `/products/${id}`, {}, MercariaProductSchema, callOptions.signal);

  const products: MercariaProductsApi = Object.freeze({
    get: async (product: MercariaProductRef | string, callOptions?: MercariaRequestOptions) =>
      getProduct(idOf(product, 'product'), callOptions),

    resolveRef: async (ref: MercariaProductRef, callOptions?: MercariaRequestOptions) =>
      getProduct(refIdOf(ref, 'product'), callOptions),

    resolveVariant: async (ref: MercariaVariantRef, callOptions?: MercariaRequestOptions) => {
      const parsed = parseMercariaRef(ref);
      if (parsed === null || parsed.kind !== 'variant') throw new MercariaValidationError('expected a variant ref');
      const product = await getProduct(pathSegment(parsed.productId, 'product id'), callOptions);
      const option = product.purchaseOptions.find((candidate) => candidate.ref.variantId === parsed.variantId);
      if (!option) {
        throw new MercariaNotFoundError('The product no longer has this purchase option', { status: null });
      }
      return { product, option };
    },

    search: async (input: MercariaProductSearchInput = {}) =>
      request(
        config,
        '/products',
        checkedQuery(MercariaProductSearchQuerySchema, {
          ...productListQuery(input, defaultLocale),
          storeId: wire(queryIdOf(input.store, 'store')),
          collectionId: wire(queryIdOf(input.collection, 'collection')),
        }),
        MercariaProductSummaryPageSchema,
        input.signal,
      ),
  });

  const getStore = async (id: string, callOptions: MercariaRequestOptions = {}) =>
    request(config, `/stores/${id}`, {}, MercariaStoreSchema, callOptions.signal);

  const stores: MercariaStoresApi = Object.freeze({
    get: async (store: MercariaStoreRef | string, callOptions?: MercariaRequestOptions) =>
      getStore(idOf(store, 'store'), callOptions),

    resolveRef: async (ref: MercariaStoreRef, callOptions?: MercariaRequestOptions) =>
      getStore(refIdOf(ref, 'store'), callOptions),

    lookup: async (input: { handle: string } & MercariaRequestOptions) => {
      const handle = (input as { handle?: unknown } | undefined)?.handle;
      return request(
        config,
        '/stores/lookup',
        checkedQuery(MercariaStoreLookupQuerySchema, { handle: wire(handle) }),
        MercariaStoreSchema,
        input?.signal,
      );
    },

    products: async (store: MercariaStoreRef | string, callOptions: MercariaProductListOptions = {}) =>
      request(
        config,
        `/stores/${idOf(store, 'store')}/products`,
        checkedQuery(MercariaStoreProductsQuerySchema, productListQuery(callOptions, defaultLocale)),
        MercariaProductSummaryPageSchema,
        callOptions.signal,
      ),

    collections: async (store: MercariaStoreRef | string, callOptions: MercariaPageOptions = {}) =>
      request(
        config,
        `/stores/${idOf(store, 'store')}/collections`,
        checkedQuery(MercariaPageQuerySchema, pageQuery(callOptions)),
        MercariaCollectionPageSchema,
        callOptions.signal,
      ),

    locations: async (store: MercariaStoreRef | string, callOptions: MercariaPageOptions = {}) =>
      request(
        config,
        `/stores/${idOf(store, 'store')}/locations`,
        checkedQuery(MercariaPageQuerySchema, pageQuery(callOptions)),
        MercariaLocationPageSchema,
        callOptions.signal,
      ),
  });

  const getCollection = async (id: string, callOptions: MercariaRequestOptions = {}) =>
    request(config, `/collections/${id}`, {}, MercariaCollectionSchema, callOptions.signal);

  const collections: MercariaCollectionsApi = Object.freeze({
    get: async (collection: MercariaCollectionRef | string, callOptions?: MercariaRequestOptions) =>
      getCollection(idOf(collection, 'collection'), callOptions),

    resolveRef: async (ref: MercariaCollectionRef, callOptions?: MercariaRequestOptions) =>
      getCollection(refIdOf(ref, 'collection'), callOptions),

    products: async (collection: MercariaCollectionRef | string, callOptions: MercariaPageOptions = {}) =>
      request(
        config,
        `/collections/${idOf(collection, 'collection')}/products`,
        checkedQuery(MercariaPageQuerySchema, pageQuery(callOptions)),
        MercariaProductSummaryPageSchema,
        callOptions.signal,
      ),
  });

  const getLocation = async (id: string, callOptions: MercariaRequestOptions = {}) =>
    request(config, `/locations/${id}`, {}, MercariaLocationSchema, callOptions.signal);

  const locations: MercariaLocationsApi = Object.freeze({
    list: async (input: MercariaLocationListInput) => {
      const goWayPlaceId = (input as { goWayPlaceId?: unknown } | undefined)?.goWayPlaceId;
      return request(
        config,
        '/locations',
        checkedQuery(MercariaLocationListQuerySchema, {
          ...pageQuery(input ?? {}),
          goWayPlaceId: typeof goWayPlaceId === 'string' ? goWayPlaceId.trim() : wire(goWayPlaceId),
        }),
        MercariaLocationPageSchema,
        input?.signal,
      );
    },

    get: async (location: MercariaLocationRef | string, callOptions?: MercariaRequestOptions) =>
      getLocation(idOf(location, 'location'), callOptions),

    resolveRef: async (ref: MercariaLocationRef, callOptions?: MercariaRequestOptions) =>
      getLocation(refIdOf(ref, 'location'), callOptions),

    products: async (location: MercariaLocationRef | string, callOptions: MercariaProductListOptions = {}) =>
      request(
        config,
        `/locations/${idOf(location, 'location')}/products`,
        checkedQuery(MercariaLocationProductsQuerySchema, productListQuery(callOptions, defaultLocale)),
        MercariaLocationProductPageSchema,
        callOptions.signal,
      ),
  });

  return Object.freeze({ products, stores, collections, locations, links: createLinks(webBaseUrl) });
}
