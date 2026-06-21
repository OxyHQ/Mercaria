/**
 * Mercaria Error System
 *
 * Generic typed error class + user-facing sanitization helpers.
 */

export {
  MercariaError,
  isMercariaError,
  toMercariaError,
  type MercariaErrorCode,
  type MercariaErrorParams,
} from './error-codes.js';

export {
  sanitizeMessage,
  sanitizeError,
  getSafeErrorMessage,
} from './sanitize.js';
