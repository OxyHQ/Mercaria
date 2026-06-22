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

// Product variant DTO (ProductVariantDTO, VariantOptionValue).
export * from './variant';

// Listing domain entity, enums and request payloads.
export * from './listing';

// Product/merchant browse/feed DTOs (ProductSummary, MerchantSummary, FeedSection, Feed).
export * from './product';

// Store (shop) admin-facing DTOs (Store, StoreMember, StoreRole, StorePermission).
export * from './store';

// Location DTOs (Location, LocationType, LocationAddress, Create/UpdateLocationInput).
export * from './location';

// Collection DTOs (Collection, CollectionType, CollectionSortOrder, CollectionRule, …).
export * from './collection';

// Inventory DTOs (InventoryLevelDTO).
export * from './inventory';

// Category taxonomy tree DTO (CategoryNode).
export * from './category';

// Cart DTOs (Cart, CartItemDTO, AddCartItemInput, UpdateCartItemInput).
export * from './cart';

// Address DTOs (Address, CreateAddressInput, UpdateAddressInput).
export * from './address';

// Order DTOs (Order, OrderItem, OrderStatus, CheckoutInput, CheckoutResult, …).
export * from './order';

// Review DTOs (Review, ReviewTargetType, CreateReviewInput, RatingAggregate, …).
export * from './review';
