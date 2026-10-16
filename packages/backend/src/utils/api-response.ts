/**
 * Mercaria API response envelope helpers.
 *
 * These emit the CANONICAL Mercaria envelope defined in
 * `@mercaria/shared-types` (`ApiResponse<T> = { success; message?; error?; data? }`),
 * where `error` is a machine-readable STRING code — NOT Mention's nested
 * `{ code, message }` shape. Routing all responses through these helpers keeps
 * `/feed`, `/listings` and every future endpoint on one consistent contract.
 */

import type { Response } from 'express';
import type { ApiResponse, PaginatedResponse, Pagination } from '@mercaria/shared-types';

/** Send a success response carrying `data`. */
export function sendSuccess<T>(res: Response, data: T, status = 200): void {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
}

/**
 * Send a paginated success response (the `PaginatedResponse<T>` shape), with an
 * optional envelope EXTENSION beside `data` and `pagination`.
 *
 * `extra` exists for the case #76 introduced and it is narrow on purpose: a page
 * whose reader needs a figure derived from the WHOLE set, not from the page. A
 * scoped review page ships its aggregate there, because a client that averaged
 * the twelve reviews it received would display a number that is not the target's
 * rating — and #75's structured data has to mirror the number the page shows.
 *
 * It is not a general metadata bag. Anything a caller can compute from `data`
 * belongs in `data`.
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  pagination: Pagination,
  extra?: Readonly<Record<string, unknown>>,
  status = 200,
): void {
  const body: PaginatedResponse<T> = { data, pagination };
  res.status(status).json(extra ? { ...body, ...extra } : body);
}

/**
 * Send an error response. `error` is the machine-readable string code (see
 * `ErrorCodes`); `message` is the human-readable explanation.
 */
export function sendError(res: Response, error: string, message: string, status = 500): void {
  const body: ApiResponse<never> = { success: false, error, message };
  res.status(status).json(body);
}

/**
 * Machine-readable error codes carried in `ApiResponse.error`. Clients switch
 * on these; the accompanying `message` is for humans only.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  /**
   * The entity EXISTED and is no longer publicly available — archived, withdrawn
   * by moderation, unpublished after publication, or its store closed or
   * suspended (#1017).
   *
   * Emitted by the public integration surface (`/public/v1`), whose contract
   * (`MERCARIA_PUBLIC_ERROR_CODES`) makes it distinct from `NOT_FOUND` so a
   * foreign application holding a persisted reference can say "no longer
   * available" rather than "broken link". It deliberately carries no reason: why
   * a listing left the catalogue is the seller's and moderation's business, not
   * a fact another application may read.
   */
  GONE: 'GONE',
  /**
   * The request named a path or method the public integration surface
   * (`/public/v1`) does not serve (#1017). Distinct from `NOT_FOUND` so that a
   * client/server route mismatch can never be read as "this entity does not
   * exist" by a consumer holding a persisted reference.
   */
  UNKNOWN_ROUTE: 'UNKNOWN_ROUTE',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /**
   * A NEW guest session was refused because guest commerce is off on this
   * deployment (ADR 0003) — the defence-in-depth gate inside
   * `issueGuestSession`. Existing state is untouched, so clients retry later
   * rather than discarding it.
   */
  GUEST_ISSUANCE_DISABLED: 'GUEST_ISSUANCE_DISABLED',
  /**
   * A signed-out caller tried to write to a cart on a deployment where guest
   * commerce is off (#104). Distinct from `UNAUTHORIZED` on purpose: the client's
   * correct response is to offer sign-in, not to retry with a credential.
   */
  GUEST_CART_DISABLED: 'GUEST_CART_DISABLED',
  /**
   * A watchlist mutation carried a stale `expectedVersion` (#81 acceptance 4).
   *
   * Its own code rather than a bare `CONFLICT`, because the client's correct
   * behaviour is specific and automatable: re-read the list, re-apply the edit
   * against what it now says, and retry. A generic conflict leaves a client
   * either giving up or matching on message text, and message text is not a
   * contract.
   */
  WATCHLIST_VERSION_CONFLICT: 'WATCHLIST_VERSION_CONFLICT',
  /**
   * A dependency the answer needs is unreachable, so the request was refused
   * rather than answered without it — the Oxy account graph behind every
   * store-authorization decision (ADR 0012) is the case that introduced it.
   * Authorization FAILS CLOSED: a store request is never served on a guess
   * about who belongs to the owning account. Retrying later is correct.
   */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

/** Union of the supported error code literals. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
