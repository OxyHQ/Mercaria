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

// Tax DTOs (TaxRate, TaxLine, TaxRegion, TaxSettings, Create/UpdateTaxRateInput, …).
export * from './tax';

// Discount DTOs (Discount, DiscountAllocation, DiscountMethod, DiscountValueType, …).
export * from './discount';

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

// Payment + ledger vocabulary (PaymentProviderId, PaymentStatus, LedgerAccount, …).
// The closed value sets the payment domain's columns, CHECKs and guards all read.
export * from './payment';

// Provider-account DTOs (ProviderOnboardingState, ProviderAccountStatus, …) — a
// seller's standing with a payment rail, and the readiness native checkout gates on.
export * from './provider-account';

// Order DTOs (Order, OrderItem, OrderStatus, CheckoutInput, CheckoutResult, …).
export * from './order';

// Customer DTOs (Customer, CreateCustomerInput, UpdateCustomerInput).
export * from './customer';

// Draft order DTOs (DraftOrder, DraftOrderLineItem, DraftOrderStatus, POS inputs).
export * from './draft-order';

// Refund/Return DTOs (Refund, RefundLineItem, RefundStatus, CreateRefundInput).
export * from './refund';

// Review DTOs (Review, ReviewTargetType, CreateReviewInput, RatingAggregate, …).
export * from './review';

// FX rate DTO (FxRates) — rates for the display and checkout conversion boundaries.
export * from './fx';

// Consumer dual-display currency preference (CurrencyPreference, UpdateCurrencyPreferenceInput).
export * from './user-preference';

// Store report/analytics DTOs (ReportSummary, SalesReportPoint, TopProduct, …).
export * from './report';

// Connector/integration DTOs (Connection, SyncSettings, SyncRun, ConnectorProviderId, …).
export * from './integration';

// Abuse-report + CrowdSource moderation DTOs (AbuseReport, ModerationEnforcementAction, …).
// NOTE: unrelated to `./report` above, which is the store SALES ANALYTICS surface.
export * from './moderation';

// Payment reconciliation, discrepancy and operator-repair vocabulary (#50).
export * from './reconciliation';

// Canonical-graph provenance vocabulary (CatalogSourceKind, SourceLinkMethod, …) — ADR 0002 D19.
export * from './provenance';

// Canonical Organization and Brand DTOs (Organization, Brand, CanonicalAlias, AliasResolution).
export * from './organization';

// Canonical merchant/storefront graph DTOs (Merchant, Storefront, NativeStoreLink, …)
// — issue #54, ADR 0002. NOT the same thing as MerchantSummary in `./product`,
// which is a native-store feed card projection.
export * from './merchant';

// Guest commerce identity DTOs (GuestSessionState, GuestSessionStatus, …) — ADR 0003, #103.
export * from './guest';

// Procurement — suppliers, supply agreements, procurement offers, purchase orders (#118).
export * from './procurement';
