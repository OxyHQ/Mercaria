/**
 * @mercaria/shared-types
 *
 * TypeScript types shared between the Mercaria frontend (`@mercaria/frontend`)
 * and backend (`@mercaria/backend`) to keep the API contract in one place.
 */

// Common API envelope, pagination and utility types.
export * from './common';

// Money DTO.
export * from './money';

// Seller DTO.
export * from './seller';

// Listing domain entity, enums and request payloads.
export * from './listing';

// Product/merchant browse/feed DTOs (ProductSummary, MerchantSummary, FeedSection, Feed).
export * from './product';
