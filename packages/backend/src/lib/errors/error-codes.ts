/**
 * Marketplace Error Codes & Typed Error Class
 *
 * A small, generic application error with an HTTP status and a user-safe
 * message. These codes cover ordinary REST failures only.
 */

export type MarketplaceErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

const DEFAULT_HTTP_STATUS: Record<MarketplaceErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export interface MarketplaceErrorParams {
  code: MarketplaceErrorCode;
  /** User-facing message (safe to display). */
  message: string;
  httpStatus?: number;
  cause?: unknown;
}

export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;
  readonly httpStatus: number;

  constructor(params: MarketplaceErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = 'MarketplaceError';
    this.code = params.code;
    this.httpStatus = params.httpStatus ?? DEFAULT_HTTP_STATUS[params.code];
  }
}

export function isMarketplaceError(err: unknown): err is MarketplaceError {
  return err instanceof MarketplaceError;
}

/** Coerce an unknown thrown value into a MarketplaceError (defaults to INTERNAL). */
export function toMarketplaceError(err: unknown): MarketplaceError {
  if (isMarketplaceError(err)) return err;
  const message = err instanceof Error ? err.message : 'Internal server error';
  return new MarketplaceError({ code: 'INTERNAL', message, cause: err });
}
