/**
 * The route registry — every operation `/public/v1` serves, as DATA.
 *
 * Three things are derived from this one list and from nothing else:
 *
 * - the backend router (`packages/backend/src/routes/public-api.ts`), which
 *   mounts each entry in ORDER against a handler keyed by `operationId` — a
 *   missing handler is a compile error, and a mounted path the registry does
 *   not name cannot exist;
 * - the request validation in the backend controller (`params`, `query`) and
 *   the response it serializes (`response`);
 * - the OpenAPI document (`openapi.ts`), committed as
 *   `packages/contracts/openapi.json` and served at `/public/v1/openapi.json`.
 *
 * Order matters: Express matches in registration order, so
 * `/stores/lookup` sits before `/stores/{id}` or `lookup` would be read as an
 * id. Paths are OpenAPI templates relative to {@link MERCARIA_PUBLIC_API_BASE_PATH}.
 *
 * Adding a list is a cursor kind in `pagination.ts`, its page schema in
 * `json-schema.ts`, an entry here and a handler in the backend — the compiler
 * and the freshness gate name every place that is missed.
 */

import type { z } from 'zod';
import type { ContractJsonSchemaName } from './json-schema';
import type { MercariaPublicErrorCode } from './errors';
import type { MercariaPublicCursorKind } from './pagination';
import {
  MercariaIdParamsSchema,
  MercariaLocationListQuerySchema,
  MercariaLocationProductsQuerySchema,
  MercariaNoQuerySchema,
  MercariaPageQuerySchema,
  MercariaProductSearchQuerySchema,
  MercariaStoreLookupQuerySchema,
  MercariaStoreProductsQuerySchema,
} from './requests';

/** The path every public integration route is mounted under. */
export const MERCARIA_PUBLIC_API_BASE_PATH = '/public/v1' as const;

/** The version the OpenAPI document states. Bumped with any contract change. */
export const MERCARIA_PUBLIC_API_VERSION = '1.0.0' as const;

/** The production origin the OpenAPI document names as its server. */
export const MERCARIA_PUBLIC_API_ORIGIN = 'https://api.mercaria.co' as const;

export const MERCARIA_PUBLIC_ROUTE_TAGS = [
  'products',
  'stores',
  'collections',
  'locations',
  'meta',
] as const;
export type MercariaPublicRouteTag = (typeof MERCARIA_PUBLIC_ROUTE_TAGS)[number];

/** One operation. */
export interface MercariaPublicRoute {
  /** Unique, stable; the generated client's method name and the backend's handler key. */
  readonly operationId: string;
  readonly method: 'get';
  /** OpenAPI path template relative to the base path, e.g. `/products/{id}`. */
  readonly path: `/${string}`;
  readonly tag: MercariaPublicRouteTag;
  readonly summary: string;
  readonly description: string;
  /** Path parameters, or `null` for a route that has none. */
  readonly params: z.ZodObject | null;
  /** The query string. Strict: a parameter it does not name is `bad_request`. */
  readonly query: z.ZodType<Record<string, unknown>, Record<string, unknown>>;
  /** The named schema the 200 body is. */
  readonly response: ContractJsonSchemaName;
  /** The list this route pages through, for a list route. */
  readonly cursorKind: MercariaPublicCursorKind | null;
  /**
   * The codes this operation answers with BEYOND the ones every operation can
   * (`bad_request`, `rate_limited`, `internal_error`).
   */
  readonly errors: readonly MercariaPublicErrorCode[];
}

/** Codes every operation can answer with, whatever it reads. */
export const MERCARIA_PUBLIC_UNIVERSAL_ERRORS = [
  'bad_request',
  'rate_limited',
  'internal_error',
] as const;

const ENTITY_ERRORS = ['not_found', 'gone'] as const;

/**
 * A location read asks GoWay whether the location's place still names it back
 * (Mercaria ADR 0013). When GoWay cannot answer and nothing recent is cached,
 * the answer is `service_unavailable` — never `gone`, which a consumer may act
 * on by discarding a reference that is still good.
 */
const LOCATION_ERRORS = [...ENTITY_ERRORS, 'service_unavailable'] as const;

export const MERCARIA_PUBLIC_ROUTES = [
  {
    operationId: 'searchProducts',
    method: 'get',
    path: '/products',
    tag: 'products',
    summary: 'Search publicly live products',
    description:
      'Every publicly live product, optionally scoped to one store or collection. A `storeId` or ' +
      '`collectionId` naming an entity that is not public answers 404 or 410, never an empty page.',
    params: null,
    query: MercariaProductSearchQuerySchema,
    response: 'MercariaProductSummaryPage',
    cursorKind: 'products',
    errors: ['validation_failed', ...ENTITY_ERRORS],
  },
  {
    operationId: 'getProduct',
    method: 'get',
    path: '/products/{id}',
    tag: 'products',
    summary: 'Read one product',
    description:
      'A product’s current detail. A sold one-off product is a 200 with availability `sold`; an ' +
      'archived, withdrawn or no-longer-public one is a 410.',
    params: MercariaIdParamsSchema,
    query: MercariaNoQuerySchema,
    response: 'MercariaProduct',
    cursorKind: null,
    errors: ENTITY_ERRORS,
  },
  {
    operationId: 'lookupStore',
    method: 'get',
    path: '/stores/lookup',
    tag: 'stores',
    summary: 'Find a store by its current handle',
    description: 'Persist the returned `ref`, never the handle: a merchant can rename a store.',
    params: null,
    query: MercariaStoreLookupQuerySchema,
    response: 'MercariaStore',
    cursorKind: null,
    errors: ['validation_failed', ...ENTITY_ERRORS],
  },
  {
    operationId: 'getStore',
    method: 'get',
    path: '/stores/{id}',
    tag: 'stores',
    summary: 'Read one store',
    description: 'A public storefront. A suspended or closed store is a 410.',
    params: MercariaIdParamsSchema,
    query: MercariaNoQuerySchema,
    response: 'MercariaStore',
    cursorKind: null,
    errors: ENTITY_ERRORS,
  },
  {
    operationId: 'listStoreProducts',
    method: 'get',
    path: '/stores/{id}/products',
    tag: 'stores',
    summary: 'List a store’s products',
    description: 'One live store’s publicly live products.',
    params: MercariaIdParamsSchema,
    query: MercariaStoreProductsQuerySchema,
    response: 'MercariaProductSummaryPage',
    cursorKind: 'store-products',
    errors: ['validation_failed', ...ENTITY_ERRORS],
  },
  {
    operationId: 'listStoreCollections',
    method: 'get',
    path: '/stores/{id}/collections',
    tag: 'stores',
    summary: 'List a store’s published collections',
    description: 'Published collections only.',
    params: MercariaIdParamsSchema,
    query: MercariaPageQuerySchema,
    response: 'MercariaCollectionPage',
    cursorKind: 'store-collections',
    errors: ['validation_failed', ...ENTITY_ERRORS],
  },
  {
    operationId: 'listStoreLocations',
    method: 'get',
    path: '/stores/{id}/locations',
    tag: 'stores',
    summary: 'List a store’s locations',
    description:
      'One live store’s public shop fronts: published, live, unrestricted, and named back by their ' +
      'GoWay place. Read each one’s place facts from GoWay with `goWayPlaceId`.',
    params: MercariaIdParamsSchema,
    query: MercariaPageQuerySchema,
    response: 'MercariaLocationPage',
    cursorKind: 'store-locations',
    errors: ['validation_failed', ...LOCATION_ERRORS],
  },
  {
    operationId: 'getCollection',
    method: 'get',
    path: '/collections/{id}',
    tag: 'collections',
    summary: 'Read one collection',
    description: 'A published collection of a live store.',
    params: MercariaIdParamsSchema,
    query: MercariaNoQuerySchema,
    response: 'MercariaCollection',
    cursorKind: null,
    errors: ENTITY_ERRORS,
  },
  {
    operationId: 'listCollectionProducts',
    method: 'get',
    path: '/collections/{id}/products',
    tag: 'collections',
    summary: 'List a collection’s products',
    description: 'In the collection’s own sort order.',
    params: MercariaIdParamsSchema,
    query: MercariaPageQuerySchema,
    response: 'MercariaProductSummaryPage',
    cursorKind: 'collection-products',
    errors: ['validation_failed', ...ENTITY_ERRORS],
  },
  {
    operationId: 'listLocations',
    method: 'get',
    path: '/locations',
    tag: 'locations',
    summary: 'List the Mercaria locations at a GoWay place',
    description:
      'The public shop fronts trading from one GoWay place — what a map shows "products at this store" ' +
      'from. A place that names no live location answers an empty page, never 404.',
    params: null,
    query: MercariaLocationListQuerySchema,
    response: 'MercariaLocationPage',
    cursorKind: 'locations',
    errors: ['validation_failed', 'service_unavailable'],
  },
  {
    operationId: 'getLocation',
    method: 'get',
    path: '/locations/{id}',
    tag: 'locations',
    summary: 'Read one location',
    description:
      'A shop front’s Mercaria half: its store, its collection terms and whether discovery routes ' +
      'shoppers to it. A withdrawn, restricted or no-longer-linked location, or one whose store is ' +
      'not live, is a 410; one never published is a 404.',
    params: MercariaIdParamsSchema,
    query: MercariaNoQuerySchema,
    response: 'MercariaLocation',
    cursorKind: null,
    errors: LOCATION_ERRORS,
  },
  {
    operationId: 'listLocationProducts',
    method: 'get',
    path: '/locations/{id}/products',
    tag: 'locations',
    summary: 'List the products at a location',
    description:
      'The store’s publicly live products stocked at this location, each with a bounded availability ' +
      'there. The location’s own gate applies first.',
    params: MercariaIdParamsSchema,
    query: MercariaLocationProductsQuerySchema,
    response: 'MercariaLocationProductPage',
    cursorKind: 'location-products',
    errors: ['validation_failed', ...LOCATION_ERRORS],
  },
  {
    operationId: 'getOpenApiDocument',
    method: 'get',
    path: '/openapi.json',
    tag: 'meta',
    summary: 'This document',
    description: 'The OpenAPI 3.1 description of `/public/v1`, generated from the contract.',
    params: null,
    query: MercariaNoQuerySchema,
    response: 'MercariaOpenApiDocument',
    cursorKind: null,
    errors: [],
  },
] as const satisfies readonly MercariaPublicRoute[];

export type MercariaPublicOperationId = (typeof MERCARIA_PUBLIC_ROUTES)[number]['operationId'];

/** The Express spelling of a registry path: `/products/{id}` → `/products/:id`. */
export function expressRoutePath(path: string): string {
  return path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, ':$1');
}
