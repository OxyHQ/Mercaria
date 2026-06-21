/**
 * Marketplace Error System
 *
 * Generic typed error class + user-facing sanitization helpers.
 */

export {
  MarketplaceError,
  isMarketplaceError,
  toMarketplaceError,
  type MarketplaceErrorCode,
  type MarketplaceErrorParams,
} from './error-codes.js';

export {
  sanitizeMessage,
  sanitizeError,
  getSafeErrorMessage,
} from './sanitize.js';
