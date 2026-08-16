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

// Product/store browse/feed DTOs (ProductSummary, StoreSummary, FeedSection, Feed).
// `StoreSummary` was `MerchantSummary` until #36/#38 — the word `Merchant` is
// reserved for `./merchant`'s canonical entity (ADR 0002, entity glossary).
export * from './product';

// Tax DTOs (TaxRate, TaxLine, TaxRegion, TaxSettings, Create/UpdateTaxRateInput, …).
export * from './tax';

// Discount DTOs (Discount, DiscountAllocation, DiscountMethod, DiscountValueType, …).
export * from './discount';

// Store (shop) admin-facing DTOs (Store, StoreMember, StoreRole, StorePermission).
export * from './store';

// Location DTOs (Location, LocationType, LocationAddress, Create/UpdateLocationInput).
export * from './location';

// Location-aware inventory, nearby discovery and pickup (#93). Separate from
// `./location` on purpose: that file is the STORE-ADMIN inventory location — an
// operational address staff work at — and this one is what a merchant chooses
// to publish about it, which is a different object with a different audience.
// Carries the two prohibitions stated as values: the forbidden geocode
// provenances, and a P2P area that has cell INDICES and no coordinate field.
export * from './pickup';

// Collection DTOs (Collection, CollectionType, CollectionSortOrder, CollectionRule, …).
export * from './collection';

// Inventory DTOs (InventoryLevelDTO).
export * from './inventory';

// Category taxonomy tree DTO (CategoryNode).
export * from './category';

// The universal catalogue taxonomy (#367, ADR 0007 D1/D2/D13): the category
// lifecycle, alias, redirect and external-mapping vocabularies, the machine-key
// shape, and the projections `db/taxonomy/taxonomyRepository.ts` emits. FOLLOWS
// `./category`, which holds the v1 tree DTO this extends rather than replaces.
export * from './taxonomy';

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

// Buyer post-purchase requests (cancellations, returns, support threads) —
// #110. A buyer files a REQUEST; a seller decides it; the decision drives the
// existing order and refund services.
export * from './buyer-request';

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

// The connector field-pin vocabulary (#416/#419) and the partition a merchant
// surface renders it through (#420). Follows `./integration`, whose
// `SyncSettings.conflictPolicy` decides whether these pins are honoured at all.
// Here rather than in the backend because `Listing.overriddenFields` puts these
// keys on the wire, and a dashboard that must turn one into a sentence cannot
// import a service module.
export * from './connector-pins';

// The unified sales-channel catalog, readiness, onboarding and disconnect
// vocabulary (#87). Follows `./integration`, whose `ConnectorProviderId` and
// `SyncResourceDirection` it types against — a channel TYPE is broader than a
// connector provider id, and two of its members have no provider at all.
export * from './channel-catalog';

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
// — issue #54, ADR 0002. NOT the same thing as StoreSummary in `./product`,
// which is a native-store feed card projection and is named for what it is
// since #36/#38.
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

// Claiming a guest checkout group into an Oxy account (ADR 0003 D14, #109).
// Follows `./guest-portal` because the credential half of the claim's two-sided
// proof is one of its grants, and the claim exists to END emailed access.
export * from './guest-claim';

// Whether a guest may buy from an individual seller (#112, ADR 0003 D18 / ADR
// 0006 G18). Follows the three guest modules because it is a POLICY over them
// and adds no credential, no identity and no order concept of its own. Its
// criterion tuples are DISJOINT from its forbidden-input tuple, which is what
// makes "a card fingerprint, a reusable buyer handle or paid placement can
// never make a seller guest-eligible" a property of the vocabulary rather than
// of whoever writes the next rule.
export * from './guest-p2p';

// Procurement — suppliers, supply agreements, procurement offers, purchase orders (#118).
export * from './procurement';

// Referral-domain vocabulary and partner-safe DTOs (#142, ADR 0005) — programs,
// partners, instruments, touches, attributions, conversions.
export * from './referral';

// Versioned referral reward rules, the closed funding-source set and the
// disjoint set of things that may never fund a reward (#144, ADR 0005).
export * from './referral-reward';

// The referral ATTRIBUTION EDGE (#143) — redirect dispositions, the binding
// vocabulary, the client-safe state view, and the disjoint sets of identity
// signals and redirect inputs that may never influence attribution.
export * from './referral-attribution';

// The referral EARNINGS ledger (#145, ADR 0005 "Ledger representability") — the
// two referral accounts and the disjoint set of accounts a referral posting may
// never name, payout batches, the derived payability verdict and the derived
// partner balance.
export * from './referral-earnings';

// The referral partner TAX QUESTIONNAIRE (#146, ADR 0005 D15 gate 2) — the
// participant/VAT vocabulary, the published questionnaire versions and the
// fields a tax profile may never carry. No withholding rate and no tax
// identifier is representable anywhere in it; see the file for why.
export * from './referral-tax';

// Referral partner ENROLLMENT (#146 increment 2, ADR 0005 D2/D15) — the eight
// enrollment modes and their per-mode rule table, the application's own
// lifecycle, the closed partner-facing rejection vocabulary, the two terms
// scopes and the versioned partner agreement. The registry mapping each of
// #146's ten application items to where it is actually collected lives here
// too, so "which of them did we skip" is a census rather than a claim.
export * from './referral-enrollment';

// Referral INTEGRITY (#148, ADR 0005 D7/D17/D18/R6–R8) — the sixteen prohibited
// conduct kinds, the fourteen behavioural risk signals and the eighteen
// identifiers disjoint from them, the six self-referral evidence kinds and what
// each is WORTH, the twelve scoped enforcement actions with their financial
// effects derived from one exhaustive table, the disclosure surfaces and the
// twelve retention classes with their policy.
export * from './referral-integrity';

// The referral partner DASHBOARD and operator program management (#147, under
// ADR 0005 A5/D19) — the disclosure floor a per-dimension breakdown is subject
// to, the metric definitions every published figure names, the composed
// partner-safe dashboard, and the operator's own program view. The six
// performance dimensions are six rather than #147's nine, and the file says
// which section answers the other three.
export * from './referral-dashboard';

// The BOUNDED REFERRAL PILOTS (#149, ADR 0005 "Rollout and rollback" phase 2) —
// the two launched pilot subjects and the four excluded by name, the cohort
// lifecycle, the twelve stop metrics with their units and scopes, the nine
// INTERNAL admission refusals, and the thirty measure definitions #149's
// "Pilot metrics" and "Unit economics" sections ask to be stated exactly.
export * from './referral-pilot';

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

// The bounded retail PILOT (#125): the audience ladder, the thirteen stop
// thresholds and their units and scopes, the supplier-funding sources, and the
// admission verdict a retail checkout is gated on. FOLLOWS `./retail-checkout`,
// which it gates, and owns nothing any of #120–#124 could have owned — it
// answers "how much of this is Mercaria willing to do today", which none of
// them asks.
export * from './retail-pilot';

// Zero-profit cost RECONCILIATION for `mercaria_retail` (#128, ADR 0004
// D7/D8): the twelve separately represented accounting components and the
// fourteen forbidden ones, the reconciliation evidence kinds, the four
// interpretations of a cost variance, the customer-adjustment lifecycle, the
// supplier-credit classification, the currency-aware tolerance bounds and the
// ten metrics. LAST of the retail chain: it consumes #120's quote, #123's
// procurement intent, #124's purchase orders and documents and #125's stop
// thresholds, and is the only one of them that BOOKS anything.
export * from './retail-reconciliation';

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

// Transparent offer eligibility, ranking and comparison labels (#74). Follows
// `./offer` and `./offer-freshness` for the same dependency reason: it types an
// eligible offer, its converted cost and its labels from both. The two
// vocabularies it adds are deliberately separate — an exclusion reason belongs
// to eligibility and a signal belongs to ranking, and no weight can reach a
// reason.
export * from './offer-ranking';

// The canonical product page (#71) — the composed read a product page renders:
// #56's identity, #74's ranked comparison, #57's offers, #55's verified
// channels and the seller identity behind each row. Follows all of them in this
// list because it types nothing of its own that they do not already define; it
// adds the PARTITION (one offer, one group), the withheld-offers branch and the
// outbound seam that fails closed.
export * from './product-page';

// Currency-safe offer price history and product-level trends (#78, ADR 0002
// D18's price-history seam). Follows `./offer` and `./condition`: an
// observation is what a source said, a point is a derived answer that names
// the observation it came from, and a converted amount cannot be expressed
// without the quote that produced it.
export * from './price-history';

// Trustworthy price signals and merchant competitiveness (#82). Follows
// `./price-history` and `./offer-ranking`, whose immutable observations and
// eligible offers are its only two inputs: a signal is a CLAIM about a price,
// so `unmeasured` is a state rather than a missing number, `not_present` is a
// measured negative, and every published figure keeps #78's FX basis.
export * from './price-signals';

// Grounded product comparison and multi-merchant basket optimization (#96).
// Follows `./offer-ranking`, `./constraint` and `./condition` in this list
// because it composes all three and defines none of them again: a comparison is
// #74's ranked, currency-safe offers under #94's validated constraints, with an
// opaque record reference behind every fact so a generated explanation can be
// checked rather than trusted. The two vocabularies it adds are the recommendation
// inputs and their DISJOINT prohibitions, and the basket's own reason codes.
export * from './comparison-basket';

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

// Guest-commerce governance (#111) — the sixteen-class data inventory, the
// thirteen-class retention schedule, the abuse vocabulary (whose permitted axes
// and FORBIDDEN signals are disjoint tuples a test checks, so "no device
// fingerprinting" is a build failure rather than a promise), the security
// signal register with its runbooks and safe correlation handles, the
// feature-gate register naming the lever that answers each capability, and the
// staged rollout with its fourteen launch gates. Follows `./analytics` because
// its payment-method categories are the bounded ids that domain's event
// contract demands, and its metrics extend that domain's registry.
export * from './guest-governance';

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
// Private watchlists and currency-safe basket tracking (#81). Follows
// `./money`, `./offer`, `./offer-ranking` (a basket is priced through #74's
// comparison and carries its policy version) and `./product-save`, whose
// one-member visibility and price-alert seam it repeats rather than reinvents.
// A total names ONE currency and ONE basis; an item that could not be priced is
// reported with a reason instead of dropped; and a multi-store optimum is
// unrepresentable, because #42 owns the optimization this sum deliberately does
// not perform.
export * from './watchlist';
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
// The Awin retailer-network source (#66, selected by #64). Follows
// `./ingestion` and `./feed-import`, whose framework and parsing stack it
// consumes rather than forking. Carries the two lifecycles a NETWORK needs and
// #62 cannot express — what Awin says about a programme and what Mercaria
// decided about it — the closed set of network redirector hosts that is the
// whole of what a tracking link may point at, the verdict vocabulary that says
// WHICH thing a refused deep link got wrong, and the claims a feed's contents
// may never establish about a retailer (disjoint from every fact this domain
// can record, so #55 stays the only route to a badge).
export * from './awin';
// Affiliate outbound redirects, click records and commission reconciliation
// (#67, part of #37). Follows `./offer`, `./ebay` and `./awin`: it SPENDS what
// they store rather than adding to it — the destination is the provider's own
// URL, unmodified, and nothing here composes one. Three vocabularies that must
// not collapse into each other: where a buyer may be sent (a token with no
// destination member, and a closed set of admitted hosts), what is recorded
// about having sent them (an allow-list of typed facts, disjoint from the
// identifying ones a request carries), and what a network later reports about
// money (the network's own five states, of which only two may reach the
// ledger). Deliberately carries no click-to-conversion rate, because a report
// is revisable for weeks and a click is not.
export * from './affiliate-outbound';
// Supplier-fulfilled Mercaria-retail fulfilment (#126). Downstream of
// `./retail-checkout` and `./supplier-order`: it names the fulfilment intent a
// frozen procurement intent becomes and the destination a purchase order's
// redacted snapshot supplies, and it adds nothing to either. It carries no
// carrier, package, label or scan vocabulary at all — that is #126 acceptance 2
// and the absence is stated as prohibitions rather than left implicit.
export * from './retail-fulfilment';
// Canonical multi-entity product discovery (#70). Follows `./offer` and
// `./offer-freshness`, whose `ProductOfferSummary` a product result carries
// rather than re-deriving, and `./condition`, whose SEGMENTS are the only
// new/used vocabulary a filter may name. Its two relevance-signal tuples are
// DISJOINT, which is what makes "a commission cannot change organic ranking" a
// property of the vocabulary rather than of whoever writes the next scorer, and
// it deliberately has no `variant` result kind — variant-level intent is
// reported as the matched configuration of a PRODUCT, so one phone is one row.
export * from './search';
// Product and variant price alerts (#79). Follows `./condition` (an alert is
// scoped to a condition SEGMENT), `./money` (a target names its currency and a
// trigger retains the quote that converted into it) and `./offer-ranking`,
// whose eligible set is the only thing an evaluation may consider. It carries
// no contact field of any kind — the transactional channel is Oxy's own
// notification service — and its trigger key names the observed-price VERSION,
// which is what makes one qualifying observation one notification.
export * from './price-alert';
// Natural-language shopping intent (#95). LAST, and downstream of everything a
// parse must resolve against: `./constraint` (the language an interpretation
// produces), `./search` (the filters retrieval is actually given),
// `./attribute-registry`, `./condition`, `./money` and `./offer`. It defines no
// vocabulary any of them already owns — an interpretation names #94's attribute
// keys, #90's condition SEGMENTS and #70's filter fields, so a query parser
// cannot become a second, quieter definition of what a requirement means. Its
// candidate type has no product, merchant or offer id and no price,
// availability or specification value, which is what makes "a model cannot
// invent one" a property of the shape rather than of a validation step.
export * from './search-intent';
// The merchant page and its catalogue browse (#73). Follows `./merchant`,
// `./merchant-claim`, `./offer`, `./relationship` and `./review`, composing
// what each already publishes rather than restating any of it. Its shapes exist
// to keep four things apart that a page is forever tempted to collapse — a
// MERCHANT, a STOREFRONT, a native Mercaria STORE and a BRAND — so a channel
// entry names its operator, a native store appears as a link and never as an
// embedded experience, a brand has three relationship states rather than a
// badge and its absence, and a catalogue card has no rating field at all.
export * from './merchant-page';
// Retail cancellations, returns, warranties, supplier RMAs and customer refunds
// (#127). Downstream of `./retail-fulfilment` and `./supplier-order`: it names
// the order whose role snapshot supplies the four consumer windows and the
// purchase order a recovery is claimed against, and it adds nothing to either.
// Its two halves — what Mercaria owes a BUYER and what it may recover from a
// SUPPLIER — share no amount, no state and no field, which is ADR 0004 D8.5
// held by the types rather than by whoever writes the next decision service.
export * from './retail-service-request';
// Public routing and the search-engine surface (#75). After everything it
// describes an ADDRESS for, because it is the only module that says what a
// public URL for one of the entities above IS: the route registry, the
// redirect vocabulary, the indexability policy's operator-facing reasons, and
// the visible-fact projection both the rendered `<head>` and the JSON-LD are
// built from. Its two query-parameter tuples are DISJOINT, which is what stops
// a tracking parameter minting a second canonical address, and its
// offer-checkout union carries a URL on ONE branch, which is what stops an
// external offer being described as purchasable on Mercaria.
export * from './seo';
// Merchant demand analytics and the acquisition pipeline (#86). Follows
// `./analytics` — whose merchant cohort floor it REUSES rather than inventing a
// second one for the same question — and `./money`, since three of its metrics
// are amounts and each names its own currency. Its four money/demand LABELS are
// separate kinds precisely so nothing can add them, there is no total field
// anywhere in it, and every figure is a three-way union whose unavailable
// branch has no number to read: a merchant demand figure of zero and one that
// cannot be measured mean opposite things.
export * from './merchant-demand';
// Brand and product-family PAGES (#72). Follows `./provenance`, `./relationship`,
// `./offer-freshness` and `./search`: it composes what those already publish —
// catalogue identity, a verified relationship inside its window, a current
// offer summary — and adds no fact of its own. Its two official-channel tuples
// are DISJOINT, which is what makes "a matching name, logo or domain cannot
// produce a badge" a property of the vocabulary rather than of whoever writes
// the next composer, and its asset/text unions carry the RIGHTS a fact is shown
// under so a description copied out of a feed cannot be rendered without them.
export * from './catalog-page';
// The canonical "Sell yours" flow (#91). Downstream of `./condition` (the
// seller-owned taxonomy a draft carries verbatim), `./offer` (the attachment a
// publication may write) and `./price-history` (the observations guidance is
// read from). Its two field tuples are DISJOINT — what a canonical product may
// prefill and what only the seller may state — so "a specification is not
// evidence about the item" is a property of the vocabulary rather than of
// whoever writes the next screen, and its guidance shape carries no field a
// client could read as a price to submit.
export * from './sell-yours';
// Merchant plans, entitlements and optional subscription billing (#89). Last,
// and it references NOTHING above it except `./money` — which is the domain's
// shape: an entitlement says what a merchant may DO and never what a listing,
// an offer or an order IS, so nothing it holds can reach the catalogue. Its two
// capability tuples are DISJOINT, which is what makes "catalogue, orders,
// refunds, financial records and data export can never become paid-only" a
// property of the vocabulary rather than a rule in a service.
export * from './merchant-plan';
// What a buyer is told about who is selling, who is paid and what rights come
// with the purchase (#129). Downstream of `./fees` (whose `CommercialMode`
// tuple it reads rather than duplicating — one vocabulary, two readers: the
// fee snapshot and the buyer's disclosure), `./retail-pricing` (whose
// `presentation` and `blockReasons` it renders) and `./retail-eligibility`
// (whose price-finality determination it carries verbatim). Its union has no
// common field, so a surface must switch on the mode and cannot put
// `Sold by Mercaria` on somebody else's sale.
export * from './commercial-presentation';
// Merchant activation readiness and native-checkout onboarding (#85). LAST,
// because it reads almost everything above it: #46's payment readiness, #55/#83
// claiming, #84 linkage, #87 channel readiness, #88's fee schedules, #105-#110's
// guest surfaces and #112's P2P decision. Its two requirement registries are
// DISJOINT — native and guest ask different questions, and #85 says twice that
// guest readiness may not be inferred from native — so `guest is a stronger
// native` is not expressible in the vocabulary.
export * from './merchant-activation';
// Saved shopping-agent jobs (#97). LAST, and downstream of everything a saved
// objective is evaluated against: `./constraint` (the authoritative stored
// input), `./comparison-basket` (the deterministic solver that answers it),
// `./offer-ranking`, `./condition` and `./money`. It defines no vocabulary any
// of them owns — an agent's channel policy, price basis and condition segments
// are the ones the solver already reads, so a saved objective cannot become a
// second, quieter definition of what a plan costs. Its job-kind tuple is
// DISJOINT from a list of sixteen forbidden ACTIONS, and no type here has a
// field that could hold an order, a payment method, a merchant message or a
// merchant's terms, which is what makes "this issue does not authorize
// autonomous purchases" a property of the shapes rather than a rule somebody
// follows.
export * from './shopping-agent';
// Versioned product types (#367, ADR 0007 D5). Downstream of
// `./attribute-registry`, whose `RESERVED_OFFER_FACT_KEYS` it reads rather than
// restates — a product-type field cites an attribute version and describes none
// of its meaning, so the two can never disagree about what a value is.
export * from './product-type';
// Navigation trees and the merchandising separation (#367 step 7, ADR 0007 D3).
// LAST, and it defines no vocabulary any domain above it owns: a node POINTS at
// `./condition`'s groups, `./offer`'s kinds and availability and `./money`'s
// currency inside a saved query, and at a category, brand, family, product type
// or collection by that entity's own id or stable key. It has no field for a
// sort, a weight, a policy version or a sponsored slot — ordering is #74's — and
// no field that could carry a category's name, lifecycle or parent, which is
// what makes "nothing in navigation may write to `categories`" (ADR 0007 D3) a
// property of the shapes rather than a rule somebody follows.
export * from './navigation';
// Catalog localization (ADR 0007 D4, #367). It defines no vocabulary any
// catalog domain owns: a localization names an entity's id and a locale and
// carries text, so nothing here can say what a category IS. Its two fallback
// policies are derived from a field's CLASS and from nothing a caller supplies,
// which is what makes "legal and seller-authored text never falls back across
// markets" a property of the field rather than a discipline every reader has to
// remember.
export * from './catalog-localization';
// Compatibility and automotive fitment (#367 step 8, ADR 0007 D8). LAST, and it
// depends on nothing above it — the domain is a relationship between catalogue
// identities and defines no money, no offer and no ranking vocabulary. Its
// applicability tuple has FOUR members because `does_not_apply` and `unknown`
// are different answers a shopper acts on differently, its verification methods
// have no `title_similarity` member so two names looking alike can never
// establish a fit, and `COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS` states the
// epic's own acceptance scenario as a VALUE: one brake-pad SKU fits a thousand
// vehicles and stays ONE variant.
export * from './compatibility';
// External taxonomy, attribute and value mappings (#367 Workstream 11) are the
// LAST export and depend on nothing above them. The five dimensions name
// Mercaria concepts by id or by stable machine KEY, never by a DTO, so this
// vocabulary cannot become a second description of a product type, an attribute
// or a unit. CATEGORY is deliberately not among them: `./navigation` and the
// taxonomy module own that concept and `category_external_mappings` already
// maps it, so a sixth member here would be the rival table the epic exists to
// remove (#410 tracks consolidating the two).
//
// What it adds is the governance the registry has no room for — a version, a
// confidence, a review state, a provenance and a validity window per mapping —
// plus two DISJOINT prohibition lists: nine bases on which a mapping may never
// be established (`name_match` first among them, ADR 0007 D1) and ten
// transformation shapes that would let a source supply executable behaviour.
export * from './catalog-external-mapping';
// Facets, filters and the same-variant / same-offer semantics (#367 Workstream
// 10) depend only on the attribute registry, the
// constraint vocabulary, the localization statuses and `Money` — never on
// search, ranking or any commercial domain. `FACET_COMMERCE_DIMENSIONS` is a
// SUBSET of `./constraint`'s `COMMERCE_FACETS` rather than a second list, so a
// facet a shopper picks and a hard constraint the evaluator answers cannot come
// apart; `FACET_ORDERING_INPUTS` and `FACET_FORBIDDEN_ORDERING_INPUTS` are
// DISJOINT, which is what makes "a commercial payment may never influence facet
// ordering" a vocabulary property rather than a review note.
export * from './facets';
// Typed variant axes and retained seller claims (#367 step 4, ADR 0007 D6/D7)
// are the LAST export. They depend on nothing above them and deliberately
// RESTATE nothing: `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS` (`./product-type`)
// stays the one list of attribute keys that may never be an axis, and this
// module consumes it rather than growing a second copy that could disagree in
// the permissive direction.
//
// What it adds is the separation ADR 0007 D7 exists for — what a party SAID
// (raw, provenanced, retained whether or not it ever resolves) is a different
// row from what a product's axes ARE (typed, citing a definition and its exact
// version). `NATIVE_CLAIM_FORBIDDEN_TARGETS` names the six canonical identities
// a claim may never reach as VALUES, disjoint from `NATIVE_CLAIM_SUBJECTS` by a
// test, so a claim becoming a canonical fact by being written has no vocabulary
// to be written in.
export * from './variant-axis';
