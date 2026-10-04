/**
 * The public surface's refusals (#1017), in the contract's own codes.
 *
 * `/public/v1` speaks `~/Oxy/docs/api-conventions.md` — snake_case codes from
 * `@mercaria/contracts`' closed list — while the internal API still speaks the
 * `MercariaError` envelope (`lib/errors/error-codes.ts`). The two vocabularies
 * are deliberately separate types, so nothing here can throw an internal code
 * onto the public wire, and the controller maps exactly ONE class to a public
 * answer: anything else is `internal_error`.
 */

import {
  MERCARIA_PUBLIC_ERROR_STATUS,
  type MercariaErrorDetails,
  type MercariaPublicErrorCode,
} from '@mercaria/contracts';

export class PublicApiError extends Error {
  readonly code: MercariaPublicErrorCode;
  readonly status: number;
  readonly details: MercariaErrorDetails | undefined;

  constructor(code: MercariaPublicErrorCode, message: string, details?: MercariaErrorDetails) {
    super(message);
    this.name = 'PublicApiError';
    this.code = code;
    this.status = MERCARIA_PUBLIC_ERROR_STATUS[code];
    this.details = details;
  }
}

/** 404 — never existed, or the id is malformed. */
export function notFound(message: string): PublicApiError {
  return new PublicApiError('not_found', message);
}

/** 410 — existed, and is no longer publicly available. The message must not say WHY. */
export function gone(message: string): PublicApiError {
  return new PublicApiError('gone', message);
}

/** 400 — the request is not well-formed (a foreign cursor included). */
export function badRequest(message: string, details?: MercariaErrorDetails): PublicApiError {
  return new PublicApiError('bad_request', message, details);
}
