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

// The PUBLIC P2P seller profile (#92) — the projection a seller page renders,
// the closed visibility/withholding vocabulary, the one follow kind a person
// may carry (`oxy.user`) and the forbidden kinds and fields that make "no
// Mercaria person identity" and "no contact, location or payment data" values a
// gate can fail the build on. PRECEDES `./listing`, which carries `Seller`.
export * from './seller-profile';

// Product variant DTO (ProductVariantDTO, VariantOptionValue).
export * from './variant';

// The item-condition taxonomy (#90): the nine stable keys, their segments, the
// evidence policy table, the source-mapping vocabulary and the v1 compatibility
// contract. Precedes `listing` and `offer`, both of which type their condition
// fields from it.
export * from './condition';

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

// Checkout contact + destination contract (CheckoutDestination,
// CheckoutAddressInput, CheckoutContactInput, OrderBuyerOrigin, …).
export * from './checkout';

// Payment + ledger vocabulary (PaymentProviderId, PaymentStatus, LedgerAccount, …).
// The closed value sets the payment domain's columns, CHECKs and guards all read.
export * from './payment';

// Provider-account DTOs (ProviderOnboardingState, ProviderAccountStatus, …) — a
// seller's standing with a payment rail, and the readiness native checkout gates on.
export * from './provider-account';

// Order buyer identity (OrderBuyer, OrderActorKind, MerchantBuyerLabel,
// BuyerContactProjection, …) — ADR 0003 D6/D13/D16, #106.
export * from './order-buyer';

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

// Merchant claiming — the flow that moves `merchants.claim_state` (#83, epic
// #40). Follows `./merchant` because every one of its DTOs is about a row in
// that layer, and it deliberately adds no second claim verdict beside D9's.
export * from './merchant-claim';

// Guest commerce identity DTOs (GuestSessionState, GuestSessionStatus, …) — ADR 0003, #103.
export * from './guest';

// The guest ORDER PORTAL — scopes, grant vocabulary, transactional message kinds
// and the operator trace (ADR 0003 D5/D17, #108). Follows `./guest` because every
// credential it describes is the one a guest session is NOT: a cart token names
// no order, and a portal grant names exactly one checkout group.
export * from './guest-portal';

// Procurement — suppliers, supply agreements, procurement offers, purchase orders (#118).
export * from './procurement';

// Referral-domain vocabulary and partner-safe DTOs (#142, ADR 0005) — programs,
// partners, instruments, touches, attributions, conversions.
export * from './referral';

// Marketplace fee vocabulary (#88): commercial modes, fee schedule value sets
// and the merchant-facing schedule/acceptance/preview/snapshot DTOs.
export * from './fees';

// Verified organization/brand/official-store relationships and their evidence
// (#55, ADR 0002 D10/D11/D17) — typed, scoped, temporal, evidence-backed claims,
// plus the public badge vocabulary a product or brand page may render.
export * from './relationship';

// Zero-margin landed-cost vocabulary for `mercaria_retail` (#120, ADR 0004 D3)
// — the allowed direct-cost components, the fourteen forbidden ones, the
// immutable cost quote and the eight accounting outputs. NOT the marketplace
// fee above: a `mercaria_retail` order pays no marketplace fee at all.
export * from './retail-pricing';

// Resale authorization, product compliance and market eligibility for
// `mercaria_retail` (#121, ADR 0004 D2.8–D2.10, D12.3–D12.4) — the three-valued
// verdict publication and checkout gate on, the disjoint evidence vocabularies
// that make an affiliate feed unable to authorize a resale, and the versioned
// policy every answer cites. FOLLOWS `./retail-pricing`, which consumes the
// verdict as its `marketSupported` input.
export * from './retail-eligibility';

// The provider-neutral supplier ORDER boundary (#124, ADR 0004 D4 steps 4–5 /
// D6.6 / D10) — the twelve order-side adapter capabilities, the seven order-side
// emulations nothing may manufacture, the normalized provider states a versioned
// adapter mapping targets, the draft/submission/state/shipment/tracking/
// cancellation/return/document types, and the six-class provider error
// vocabulary whose `afterWrite` flag is what makes a lost response AMBIGUOUS
// rather than failed. PRECEDES `./supplier-preflight`, which composes its
// capability and emulation tuples into the single adapter contract both halves
// are enforced against.
export * from './supplier-order';

// Live supplier stock, shipping, quote and reservation preflight (#122, ADR
// 0004 D4 step 1 / D5 / D9.3) — the twelve-member adapter capability contract,
// the disjoint set of commitments the orchestration may never emulate, the
// three-valued completeness that makes a provider timeout `unknown` rather than
// `in stock`, and the deterministic sourcing vocabulary that cannot read a
// commission or a ranking signal. FOLLOWS `./procurement` (whose supplier
// account and offer it quotes against) and `./retail-eligibility` (whose
// verdict gates whether a route may be preflighted at all).
export * from './supplier-preflight';

// Mercaria-retail native checkout (#123, ADR 0004 D4/D5/D7/D8) — why a retail
// line may be refused, the durable procurement intent a paid retail order
// triggers on, the five definitive procurement failures a compensating refund
// answers, and the reconciliation input #128 books. FOLLOWS every domain above:
// it consumes #121's verdict, #122's preflight, #120's locked quote and #124's
// orchestration, and adds no vocabulary any of them could have owned.
export * from './retail-checkout';

// The versioned category-attribute registry and its normalized values (#94):
// value types, cardinality, unit families, lifecycle, evidence/display policy,
// and the source/public projections of one recorded attribute fact. PRECEDES
// `./canonical-product`, which cites this vocabulary rather than owning it.
export * from './attribute-registry';

// The provider-neutral constraint language (#94): the operators, the hard/
// preference distinction, bounded OR groups, validation results and explainable
// evaluation outcomes. ONE schema for deterministic filters, grounded
// comparison (#96) and natural-language interpretation (#95).
export * from './constraint';

// Canonical product layer DTOs and value sets (ProductFamily, CanonicalProduct,
// CanonicalVariant, ProductIdentifier, …) — issue #56, ADR 0002 D13–D16. NOT
// the same thing as ProductSummary in `./product`, which is a native-listing
// feed card projection.
export * from './canonical-product';

// The unified offer model (#57, ADR 0002 D7/D8/D18) — one seller/channel
// offering one canonical variant on specific terms, native or external, with
// the derivations that keep marketplace-ness, freshness, unknown delivery and
// native checkout eligibility out of stored columns.
export * from './offer';

// Source-aware freshness, refresh scheduling and catalogue health (#68).
// Follows `./offer` and `./ingestion` in the dependency order this list
// encodes: it types an offer's `freshness` field and reads the ingestion
// health vocabulary, and BOTH directions are type-only so the pair is not a
// module cycle. There is no global TTL in it, structurally — see its docblock.
export * from './offer-freshness';

// Merchant → native `Store` linkage (#84, ADR 0002 D4/D9) — the request that
// joins a verified merchant claim to exactly one native store, the candidate
// evidence vocabulary (which has NO name-match member), the adoptable profile
// fields, the deterministic offer-overlap rules and the impact preview.
export * from './store-linkage';
// Deterministic product and variant matching with explainable confidence (#58,
// ADR 0002 D14/D19) — the ordered pipeline stages, the outcome and blocker sets
// that make "a conflicting identifier never auto-merges" a CHECK, the closed
// feature set a candidate is scored on, and the benchmark metrics an automatic
// category gate has to cite.
export * from './matching';

// Discovery analytics and search-success measurement (#77) — the versioned
// event envelope, the closed event/reason/consent/traffic vocabularies, the
// search query-privacy constants, the metric definitions (as DATA, so a
// dashboard cannot render a number whose denominator, window, source and
// freshness are unstated) and the experimentation value sets. Deliberately
// carries no field for contact, payment, device or network identity, which is
// how ADR 0003 I12 is enforced rather than promised.
export * from './analytics';

// The flag-gated native-catalogue backfill (#60, ADR 0002 D23/D24) — the staged
// migration's own vocabulary: its ordered stages, its dry-run/apply modes, its
// cohort selectors, the per-record outcome and reason sets that make ambiguity a
// first-class result rather than a weak match, the two-way consistency findings,
// and the canonical read modes (`off | shadow | on`) every rollout lever reads.
export * from './backfill';
// Catalog review, merge, split and correction tooling (#59, ADR 0002 D12/D16)
// — the operator vocabulary for the canonical graph: the eight review-queue
// kinds, the ordered merge and split phases that make a partially completed job
// resumable, the conflict set that a merge must have decided BEFORE it commits,
// and the typed impact estimate an operator is shown before a high-impact
// action. Deliberately carries no value meaning "delete an entity" — a merge
// leaves a tombstone and a suppression hides without removing evidence.
export * from './curation';
// Canonical product saves and the listing-save migration (#80). Follows
// `condition` (a save may prefer a condition SEGMENT), `money` and `curation`
// (an ambiguous save names the split job that made it so). Carries exactly one
// visibility, a disjoint list of the ones it refuses, and a price-alert seam
// with only an UNSUPPORTED branch — so a public wishlist and an auto-created
// alert are both unrepresentable rather than merely unimplemented.
export * from './product-save';
// The external ingestion framework (#62, ADR 0002 D19/D22) — a source's
// configuration and lifecycle, its NINE versioned rights, the ten health
// classes one refresh may end in, the intake outcome partition that makes a run
// row's counters add up, the object pipeline state, and the normalized record
// every adapter must produce. Follows `./offer`, whose `OfferAvailability` the
// normalized record carries. Its payload allow-list is what stops a provider
// payload being stored wholesale.
export * from './ingestion';
// The universal product-feed importer (#63). Follows `./ingestion`, whose
// `NormalizedSourceRecord` every mapping produces and whose
// `CATALOG_SOURCE_RETIRING_OUTCOMES` rule its delivery modes feed rather than
// duplicate. Carries the five wire formats, the roles a column may be mapped
// onto, the closed transform set (disjoint from the evaluator kinds it refuses,
// so "the importer executes nothing a feed supplies" is checkable), the
// record-issue vocabulary a downloadable error report is built from, and the
// snapshot/delta distinction that decides whether an omitted row means anything
// at all.
export * from './feed-import';
// The eBay Browse catalog source (#65, the provider #64 selected) — the launch
// marketplaces and their markets, the discovery-query vocabulary, the two
// outbound destinations an eBay item may ever have (and the link operations
// that may never become a third), eBay's own condition-id enumeration with the
// #90 ruleset an operator publishes from it, the reconciliation findings, and
// the provider's documented pagination and quota limits. Follows `./condition`,
// whose taxonomy keys the recommended ruleset maps onto, and `./ingestion`,
// whose adapter contract it is written against.
export * from './ebay';
