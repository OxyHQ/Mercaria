/**
 * Public integration surface controller (THIN) — `/public/v1` (#1017).
 *
 * One handler per operation in `@mercaria/contracts`' route registry, keyed by
 * `operationId`: the router (`routes/public-api.ts`) mounts exactly the
 * registry, so a registry entry without a handler here is a compile error.
 *
 * Every request is answered the same way, in `~/Oxy/docs/api-conventions.md`'s
 * shapes:
 *
 * - `params` and `query` are parsed with the route's contract schemas; a
 *   refusal is `bad_request` (shape) or `validation_failed` (value), with the
 *   offending field in `details.field`;
 * - the handler's value is parsed with the route's RESPONSE schema before it is
 *   sent, so the body on the wire is the contract — a projection that drifted
 *   is an `internal_error` in our logs, never a malformed body in a consumer;
 * - success is the bare value; failure is `{ error: { code, message, details? } }`.
 *
 * Only a `PublicApiError` reaches the wire with its own code and message.
 * Anything else is `internal_error` with a fixed generic message, so no
 * internal text reaches a foreign application.
 */

import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import {
  CONTRACT_SCHEMAS,
  MERCARIA_PUBLIC_ERROR_STATUS,
  MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT,
  classifyRequestIssues,
  mercariaErrorBody,
  mercariaPublicOpenApiDocument,
  type MERCARIA_PUBLIC_ROUTES,
  type MercariaErrorDetails,
  type MercariaProductSort,
  type MercariaPublicErrorCode,
  type MercariaPublicOperationId,
  type OpenApiDocument,
} from '@mercaria/contracts';
import { log } from '../lib/logger.js';
import { PublicApiError } from '../services/public-api/errors.js';
import {
  getPublicCollection,
  getPublicLocation,
  getPublicProduct,
  getPublicStore,
  listPublicCollectionProducts,
  listPublicLocationProducts,
  listPublicLocations,
  listPublicStoreCollections,
  listPublicStoreLocations,
  listPublicStoreProducts,
  lookupPublicStore,
  searchPublicProducts,
  type PublicPageParams,
  type PublicProductListParams,
} from '../services/public-api/public-api.service.js';

type PublicRoute = (typeof MERCARIA_PUBLIC_ROUTES)[number];
type RouteOf<Id extends MercariaPublicOperationId> = Extract<PublicRoute, { operationId: Id }>;
type ParamsOf<Id extends MercariaPublicOperationId> = RouteOf<Id>['params'] extends z.ZodType
  ? z.output<RouteOf<Id>['params']>
  : undefined;

/** What a handler is given: its parsed params and query, and the verified caller. */
interface PublicInput<Id extends MercariaPublicOperationId> {
  params: ParamsOf<Id>;
  query: z.output<RouteOf<Id>['query']>;
  /** The verified Oxy caller, or `undefined` for an anonymous read. */
  viewerId: string | undefined;
}

type PublicHandlers = {
  [Id in MercariaPublicOperationId]: (
    input: PublicInput<Id>,
  ) => Promise<z.output<(typeof CONTRACT_SCHEMAS)[RouteOf<Id>['response']]>>;
};

/** The only text an unexpected failure ever puts on the wire. */
const INTERNAL_ERROR_MESSAGE = 'Something went wrong';

/** Send a contract error body with its code's status. */
export function sendPublicError(
  res: Response,
  code: MercariaPublicErrorCode,
  message: string,
  details?: MercariaErrorDetails,
): void {
  res.status(MERCARIA_PUBLIC_ERROR_STATUS[code]).json(mercariaErrorBody(code, message, details));
}

/**
 * The page params the service takes — and the ONE place the defaults are
 * applied: `limit` to `MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT`, `sort` to
 * `relevance` with a query and `newest` without.
 *
 * Field by field rather than a cast: the backend compiles `strict: false`,
 * under which zod infers every key optional, so an `as` would assert a default
 * nobody applied.
 */
function pageParams(parsed: { limit?: number; cursor?: string }): PublicPageParams {
  return {
    limit: parsed.limit ?? MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
}

function productListParams(parsed: {
  limit?: number;
  cursor?: string;
  q?: string;
  locale?: string;
  inStock?: boolean;
  sort?: MercariaProductSort;
}): PublicProductListParams {
  return {
    ...pageParams(parsed),
    ...(parsed.q === undefined ? {} : { q: parsed.q }),
    ...(parsed.locale === undefined ? {} : { locale: parsed.locale }),
    ...(parsed.inStock === undefined ? {} : { inStock: parsed.inStock }),
    sort: parsed.sort ?? (parsed.q === undefined ? 'newest' : 'relevance'),
  };
}

/** Built once, on first request: the document is a pure function of the contract. */
let openApiDocument: OpenApiDocument | undefined;

export const publicApiHandlers: PublicHandlers = {
  searchProducts: ({ query }) =>
    searchPublicProducts({
      ...productListParams(query),
      ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
      ...(query.collectionId === undefined ? {} : { collectionId: query.collectionId }),
    }),
  getProduct: ({ params, viewerId }) => getPublicProduct(params.id, viewerId),
  lookupStore: ({ query }) => lookupPublicStore(query.handle),
  getStore: ({ params }) => getPublicStore(params.id),
  listStoreProducts: ({ params, query }) =>
    listPublicStoreProducts(params.id, productListParams(query)),
  listStoreCollections: ({ params, query }) =>
    listPublicStoreCollections(params.id, pageParams(query)),
  listStoreLocations: ({ params, query }) => listPublicStoreLocations(params.id, pageParams(query)),
  getCollection: ({ params }) => getPublicCollection(params.id),
  listCollectionProducts: ({ params, query }) =>
    listPublicCollectionProducts(params.id, pageParams(query)),
  listLocations: ({ query }) => listPublicLocations(query.goWayPlaceId, pageParams(query)),
  getLocation: ({ params }) => getPublicLocation(params.id),
  listLocationProducts: ({ params, query }) =>
    listPublicLocationProducts(params.id, productListParams(query)),
  getOpenApiDocument: async () => (openApiDocument ??= mercariaPublicOpenApiDocument()),
};

/** Parse one part of the request, or throw the classified refusal. */
function parseRequestPart(schema: z.ZodType | null, value: unknown): unknown {
  if (schema === null) return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const refusal = classifyRequestIssues(parsed.error.issues);
  throw new PublicApiError(refusal.code, refusal.message, refusal.details);
}

function viewerOf(req: Request): string | undefined {
  const id = req.user?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** The Express handler for one registry entry. */
export function publicApiRoute(route: PublicRoute): RequestHandler {
  // The registry ties each operationId to its own params, query and response;
  // this is the one place a handler is reached through the union.
  const handler = publicApiHandlers[route.operationId] as (input: {
    params: unknown;
    query: unknown;
    viewerId: string | undefined;
  }) => Promise<unknown>;
  const responseSchema: z.ZodType = CONTRACT_SCHEMAS[route.response];

  return async (req: Request, res: Response) => {
    try {
      const value = await handler({
        params: parseRequestPart(route.params, req.params),
        query: parseRequestPart(route.query, req.query),
        viewerId: viewerOf(req),
      });
      res.status(200).json(responseSchema.parse(value));
    } catch (err) {
      if (err instanceof PublicApiError) {
        // A 400/404/410 is an ordinary answer on a surface foreign callers probe
        // with persisted references; only an unexpected failure is logged.
        sendPublicError(res, err.code, err.message, err.details);
        return;
      }
      log.general.error(
        { err, path: req.path, operationId: route.operationId },
        '[public-api] unexpected failure',
      );
      sendPublicError(res, 'internal_error', INTERNAL_ERROR_MESSAGE);
    }
  };
}
