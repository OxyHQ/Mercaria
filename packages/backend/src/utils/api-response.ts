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

/** Send a paginated success response (the `PaginatedResponse<T>` shape). */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  pagination: Pagination,
  status = 200,
): void {
  const body: PaginatedResponse<T> = { data, pagination };
  res.status(status).json(body);
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
} as const;

/** Union of the supported error code literals. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
