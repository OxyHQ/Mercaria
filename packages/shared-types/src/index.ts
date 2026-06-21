/**
 * @marketplace/shared-types
 *
 * TypeScript types shared between the Marketplace frontend (`@marketplace/frontend`)
 * and backend (`@marketplace/backend`) to keep the API contract in one place.
 */

// Common API envelope, pagination and utility types.
export * from './common';

// Money DTO.
export * from './money';

// Seller DTO.
export * from './seller';

// Listing domain entity, enums and request payloads.
export * from './listing';
