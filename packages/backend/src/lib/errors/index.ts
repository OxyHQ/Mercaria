/**
 * Mercaria Error System
 *
 * Generic typed error class + user-facing sanitization helpers.
 */

export {
  MercariaError,
  isMercariaError,
  toMercariaError,
  notFound,
  forbidden,
  conflict,
  validationError,
  outOfStock,
  respondWithError,
  type MercariaErrorCode,
  type MercariaErrorParams,
} from './error-codes.js';

export {
  sanitizeMessage,
  sanitizeError,
  getSafeErrorMessage,
} from './sanitize.js';
