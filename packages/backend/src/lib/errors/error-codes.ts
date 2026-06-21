/**
 * Mercaria Error Codes & Typed Error Class
 *
 * A small, generic application error with an HTTP status and a user-safe
 * message. These codes cover ordinary REST failures only.
 */

export type MercariaErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

const DEFAULT_HTTP_STATUS: Record<MercariaErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export interface MercariaErrorParams {
  code: MercariaErrorCode;
  /** User-facing message (safe to display). */
  message: string;
  httpStatus?: number;
  cause?: unknown;
}

export class MercariaError extends Error {
  readonly code: MercariaErrorCode;
  readonly httpStatus: number;

  constructor(params: MercariaErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = 'MercariaError';
    this.code = params.code;
    this.httpStatus = params.httpStatus ?? DEFAULT_HTTP_STATUS[params.code];
  }
}

export function isMercariaError(err: unknown): err is MercariaError {
  return err instanceof MercariaError;
}

/** Coerce an unknown thrown value into a MercariaError (defaults to INTERNAL). */
export function toMercariaError(err: unknown): MercariaError {
  if (isMercariaError(err)) return err;
  const message = err instanceof Error ? err.message : 'Internal server error';
  return new MercariaError({ code: 'INTERNAL', message, cause: err });
}
