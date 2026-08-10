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
import type {
  ApiResponse,
  PaginatedResponse,
  Pagination,
} from '@mercaria/shared-types';

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
export function sendError(
  res: Response,
  error: string,
  message: string,
  status = 500,
): void {
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
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /**
   * The guest-session issuance kill switch is thrown
   * (`GUEST_SESSION_ISSUANCE_ENABLED=false`, ADR 0003). Existing sessions
   * keep working; only NEW ones are refused, so clients retry later rather
   * than discarding their state.
   */
  GUEST_ISSUANCE_DISABLED: 'GUEST_ISSUANCE_DISABLED',
  /**
   * A signed-out caller tried to write to a cart on a deployment where guest
   * carts are switched off (`GUEST_CART_ENABLED=false`, or guest commerce off
   * entirely — #104). Distinct from `UNAUTHORIZED` on purpose: the client's
   * correct response is to offer sign-in, not to retry with a credential.
   */
  GUEST_CART_DISABLED: 'GUEST_CART_DISABLED',
  /**
   * Claiming a guest checkout group is switched off on this deployment
   * (`GUEST_CLAIM_ENABLED=false`, #109). The `GUEST_CART_DISABLED` precedent
   * and for its reason: the client's correct response is to hide the offer and
   * carry on, not to retry with a different credential or to tell somebody
   * their proof was rejected. It is deliberately distinct from `FORBIDDEN`,
   * which a client should read as "this credential cannot do that".
   */
  GUEST_CLAIM_DISABLED: 'GUEST_CLAIM_DISABLED',
  /**
   * `BUYER_REQUESTS_ENABLED=false` — the #110 incident lever.
   *
   * A 503 rather than a 403, and the difference is the client's correct
   * response: this deployment DOES do cancellations and returns, it has
   * temporarily stopped taking NEW ones, and every request already filed is
   * still readable and still decidable. Retrying later is right; giving up is
   * not — which is why it does not share `GUEST_CART_DISABLED`'s 403.
   */
  BUYER_REQUESTS_DISABLED: 'BUYER_REQUESTS_DISABLED',
} as const;

/** Union of the supported error code literals. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
