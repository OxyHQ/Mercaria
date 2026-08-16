/**
 * Drizzle Schema Barrel
 *
 * This file is the single entry point `drizzle.config.ts` generates migrations
 * from AND the object `db/postgres.ts` hands to `drizzle()` for the relational
 * query API — a table that is not re-exported here is invisible to both, so it
 * gets neither a migration nor a typed query.
 *
 * Only TABLE modules belong here. `columns.ts` is schema support, imported
 * directly by the modules that need it; `deferredForeignKeys.ts`,
 * `protectedColumns.ts` and `expiryTargets.ts` live one directory up, beside the
 * gates that read them.
 *
 * The conventions every table follows — naming, ids, money, enums, timestamps,
 * foreign keys, expiry, protected columns — are in `CONVENTIONS.md`. Read it
 * before adding a table.
 *
 * The export order below is the DEPENDENCY order: `stores` is the root of most
 * foreign keys, `connectors` is referenced by the catalogue's provenance
 * columns, and everything else follows from those two. It is not alphabetical,
 * and reordering it into alphabetical order would create a cycle. `fees`
 * follows `orders` because its snapshot rows reference orders and order items.
 * `ledger` follows `payments` for the same reason — its transactions reference
 * a payment. `reconciliation` follows both: it is what NOTICED something wrong
 * with them, and its repair rows reference the discrepancies they answer.
 */
export * from './stores';
export * from './connectors';
export * from './catalog';
// The condition domain (#90) follows `catalog`: every one of its listing-side
// tables references `listings`, and `condition_category_policies` references
// `categories`. It PRECEDES `offers`, whose mapping provenance column is a real
// foreign key onto `condition_mapping_rulesets` — the dependency this list
// encodes, not an alphabetical accident.
export * from './condition';
export * from './merchandising';
export * from './orders';
export * from './fees';
export * from './payments';
export * from './ledger';
export * from './reconciliation';
export * from './pos';
// `guests` PRECEDES `buyers` since #104: `carts.guest_session_id` is a real
// foreign key onto `guest_sessions`, so the session table is the parent and
// belongs on the parent side of the dependency order this list encodes. It was
// placed after `buyers` while nothing referenced it, which the #103 comment
// said in as many words; that condition ended when the cart gained its owner.
export * from './guests';
// The guest order PORTAL (#108) follows `guests` for the same dependency
// reason: `guest_order_access_grants.guest_checkout_id` and
// `guest_portal_messages.guest_checkout_id` are real foreign keys onto
// `guest_checkouts`, so the contact table is the parent.
export * from './guestPortal';
// Guest order CLAIMING (#109) follows `guestPortal` for the same dependency
// reason once more: `guest_order_claims.guest_checkout_id` is a real foreign
// key onto `guest_checkouts`, and the credential its `source_grant_id` records
// is one of the portal's grants.
export * from './guestClaims';
export * from './buyers';
// Buyer post-purchase requests (#110) follow `guestPortal` AND `orders`: a
// request's requester triple references `guest_order_access_grants`, and every
// request, thread and message hangs off `orders`/`refunds`. `orders` is
// exported further up with the commerce core, so this is the later of the two
// parents and the correct position.
export * from './buyerRequests';
export * from './notifications';
// Canonical commerce graph (ADR 0002). `provenance` precedes `organizations`
// and `merchants` for the same dependency reason as above: alias and
// source-link tables reference `source_records`. `canonicalSupport.ts` is
// schema support like `columns.ts` and is deliberately NOT exported here.
export * from './provenance';
// The TAXONOMY module (#367, ADR 0007 D1/D2) sits here and not beside
// `catalog`, because `category_external_mappings` references `catalog_sources`
// while its two siblings reference only `categories`. `categories` itself stays
// in `catalog` — D2 extends the one category table in place rather than adding a
// second one, so there is nothing to move.
//
// THAT REASON IS LOAD-BEARING AND IT CAN GO STALE. The order in this file is the
// DEPENDENCY order, not alphabetical, and reordering it creates a cycle — so a
// reason that has quietly stopped being true is an invitation to move an export
// that must not move. This one nearly did: a branch that withdrew
// `category_external_mappings` left the module importing `./catalog` alone, and
// the comment above would have gone on naming a dependency it no longer had.
// Before moving any export here, re-read that module's own import list rather
// than the comment above it. Nothing gates these comments; only reading does.
export * from './taxonomy';
export * from './organizations';
export * from './merchants';
// The versioned attribute REGISTRY (#94) precedes the canonical product layer:
// `canonical_attribute_values` and `canonical_variant_attributes` both reference
// `attribute_definitions`, and its own scope/alias/mapping children reference
// `categories` (from `catalog`) and `catalog_sources` (from `provenance`).
export * from './attributeRegistry';
// The canonical PRODUCT layer (#56) follows `organizations` (families and
// products reference `brands`) and `catalog` (both reference `categories`).
export * from './canonicalCatalog';
// `relationships` (#55) follows all of the above: a commerce relationship
// references organizations, brands, merchants, storefronts and — for an
// `organization_manufactures` claim — a canonical product family, and its
// evidence references `source_records`.
export * from './relationships';
// The review domain (#76) follows BOTH `merchants` and `canonicalCatalog`: a
// scoped review, its eligibility and its aggregate each reference a canonical
// product or a merchant by foreign key. It also has to precede `moderation`,
// whose enforcement table types its previous-state column from `REVIEW_STATUSES`
// — which is why `moderation` moved down from beside `notifications`.
export * from './reviews';
export * from './moderation';
// Merchant claiming (#83) follows `merchants`: every one of its tables
// references a merchant, and `merchant_claims.native_store_id` also reaches
// back to `stores`, which is already the first export above.
export * from './merchantClaims';
// Procurement (#118) follows `organizations`: `suppliers.organization_id`
// references the canonical graph's organizations table. It now also follows
// `canonicalCatalog`: `procurement_offers` maps to canonical products and
// variants, which were a DEFERRED foreign key until #56 landed those tables.
export * from './procurement';
// Retail pricing (#120, ADR 0004 D3) follows `procurement`: a cost quote names
// the supplier, account and agreement it was sourced under by foreign key.
export * from './retailPricing';
// Retail eligibility (#121, ADR 0004 D2.8–D2.10) follows `procurement` for the
// same reason and additionally `canonicalCatalog` and `organizations`:
// compliance evidence and suppressions reference a canonical product, a
// canonical variant and a brand. It is the domain that decides whether a
// `mercaria_retail` offer may exist at all, and `retailPricing` above consumes
// its verdict as `marketSupported`.
export * from './retailEligibility';
// Referrals (#142, ADR 0005): their tables reference nothing outside their own
// domain, and their subject/actor references are deliberately opaque.
export * from './referrals';
// Referral reward rules, budgets, rewards and reversals (#144, ADR 0005)
// FOLLOW `referrals`: a reward references a conversion, an attribution, a
// partner and a program version, so every one of its parents is above it.
export * from './referralRewards';
// The referral EARNINGS ledger (#145, ADR 0005 "Ledger representability")
// FOLLOWS `referralRewards` and `ledger` both: a posting references a reward,
// an adjustment and the `ledger_transactions` row it booked, and a payout batch
// item references a reward. `ledger` is far above, beside `payments`.
export * from './referralEarnings';
// Referral INTEGRITY (#148, ADR 0005 D7/D17/D18) — the conduct policy, the risk
// signals, the scoped enforcement actions, their appeals and the disclosure
// requirements. FOLLOWS `referrals`: every one of them references a partner and
// nothing else outside its own domain — deliberately, because an enforcement
// record that could reference an order would be one that could name a buyer.
export * from './referralIntegrity';
// The BOUNDED REFERRAL PILOTS (#149) FOLLOW `referrals` and `referralRewards`:
// a cohort version pins one program version and one reward rule version, and
// its allow-list names partners. It references nothing outside the referral
// domain, deliberately — a pilot bound that could name an order would be one
// that could name a buyer.
export * from './referralPilot';
// Offers (#57, ADR 0002 D18) come last of the graph layers because they sit
// downstream of ALL of them: an offer references a canonical variant (#56), a
// merchant and a storefront (#54), a source record (#53), and — for the native
// projection — the pre-existing `listings` and `product_variants` (`catalog`,
// the first exports above).
export * from './offers';
// Merchant → native store linkage (#84, ADR 0002 D4) is the last export of all,
// because it is downstream of every one above it AND of `merchantClaims`: a
// linkage request references the merchant, the verified claim that authorizes
// it, the native store on both sides, the `native_store_links` row it produces,
// and — for its offer-overlap findings — a canonical variant and two offers.
export * from './storeLinkage';
// Deterministic matching (#58, ADR 0002 D14/D19) comes after `offers` because
// it is downstream of everything the graph has: a decision names a canonical
// product and variant (#56), a source record (#53) and a native `product_variants`
// row (`catalog`), and its whole purpose is to write the `native_listing_links`
// attachment #57 defined and deliberately left unwritten.
export * from './matching';
// Catalog curation (#59, ADR 0002 D12/D16) follows `matching` because it is
// downstream of the WHOLE graph: a review item points at a `match_decisions`
// row and a `match_policy_versions` row, a merge conflict names a
// `product_identifiers`, `canonical_variants`, `commerce_relationships` or
// `offers` row, and every revision may cite the observation and the policy the
// act was taken under. It is the last graph layer for the same reason `offers`
// was the last before `matching`: nothing in the graph references IT.
export * from './curation';
// Canonical product saves (#80) follow `curation`, and that is a real
// dependency rather than an ordering preference: an ambiguous save carries a
// foreign key onto `catalog_split_jobs`, because a split is the only thing that
// can make one ambiguous and the job is the only record of what the two
// candidates were. It also follows `canonicalCatalog`, `merchants`, `buyers`
// (a migration record names the `favorites` row it read) and `catalog`.
export * from './productSaves';
// Private watchlists (#81) follow `productSaves` for the same dependencies —
// `canonicalCatalog`, `merchants` and `curation`, whose split job an ambiguous
// item names — and are exported beside them because the two are read together
// on the same buyer surfaces. They share no row, no counter and no aggregate: a
// watchlist is a GROUPING with a purpose, not a second answer to "did this
// buyer save this product".
export * from './watchlists';
// Discovery analytics (#77) comes last and references NOTHING: every entity id
// it carries is correlation text with no foreign key, because these rows are
// swept on their own retention clock and every entity they name outlives them.
// That independence is the point — an analytics table able to block a delete
// would make telemetry a constraint on commerce.
export * from './analytics';
// The native-catalogue backfill (#60, ADR 0002 D23/D24) is the LAST export,
// because it is downstream of every graph layer above it and of the native
// catalogue below them: a report row names a canonical product and variant
// (#56), and its subjects are stores, listings and native variants. It adds
// NOTHING to any existing table — the whole migration is additive scaffolding,
// which is what makes rollback a flag flip.
export * from './backfill';
// Live supplier preflight (#122, ADR 0004 D4 step 1 / D5 / D9.3) comes after
// `procurement`, whose supplier accounts and offers every quote is taken
// against, and after the retail domains whose policy versions a quote
// snapshots. It references NOTHING in the canonical graph: a quote is evidence
// of what one supplier said at one instant, so its catalogue columns are
// snapshots that must survive an offer refreshing in place and a canonical
// entity merging — the `purchase_order_lines` rule.
export * from './supplierPreflight';
// The supplier ORDER orchestration (#124, ADR 0004 D4 steps 4–5) follows the
// preflight for the same reason the preflight follows `procurement`: every one
// of its seven tables hangs off a `purchase_orders` row, a
// `purchase_order_lines` row, a `purchase_order_shipments` row or a
// `supplier_accounts` row, and none of them is referenced by anything above.
// It reaches NOTHING in the payment domain — a supplier acceptance is not a
// payment fact and a Stripe success is not a procurement one (ADR 0004 D1), and
// a static gate fails the build if that changes.
export * from './supplierOrders';
// Mercaria-retail native checkout (#123, ADR 0004 D4/D5/D8) is LAST of the
// retail chain, because it is the only one of them that reaches back into
// `orders`, `product_variants` AND every supply-side table above: a binding
// names a catalogue variant and a procurement offer, an intent names an order,
// an acceptance, a quote and a purchase order, and a variance record names an
// order and an acceptance. Placing it earlier would make five of its foreign
// keys forward references.
export * from './retailCheckout';
// The bounded retail PILOT (#125) follows `retailCheckout`, and could not
// precede it: a cohort names a supplier and a supplier account, a SKU
// allow-list entry names a procurement offer, and the whole domain exists to
// gate the checkout above it. It reaches back into nothing else — a stop pauses
// ENTRY and never fulfilment, so there is no purchase order, order or payment
// reference here to make a forward one.
export * from './retailPilot';
// The external ingestion framework (#62) follows all of them and is the last
// export for a stronger reason than the backfill's: it is downstream of FIVE
// layers at once. Its config binds a merchant and a storefront, its objects
// point at a `match_decisions` row and at an `offers` row, and everything it
// writes hangs off `catalog_sources` and `source_records`. Placing it earlier
// would close a module cycle, which is also why a source's merchant binding
// lives on `catalog_source_configs` and not on `catalog_sources` itself —
// `merchants.ts` already imports `provenance.ts` for its source links.
export * from './ingestion';

// Source-aware freshness, refresh scheduling and catalogue health (#68) is now
// the last export, and it follows `./ingestion` for the same reason ingestion
// follows everything else: it is downstream of it. Its quarantines reference a
// `catalog_source_runs` row, its policies and leases reference
// `catalog_sources`, and its tasks reference `offers`. It sits after ingestion
// rather than inside it because #62 owns "how a record becomes an offer" and
// this owns "how long that offer is worth showing and when it is re-read" —
// two lifecycles over one graph, and merging the files would put a scheduler's
// lease table beside a rights policy.
export * from './offerFreshness';
// Currency-safe offer price history (#78) follows `offerFreshness`, which is
// its immediate upstream and not an alphabetical accident: an observation cites
// an `offers` row, a `source_records` row and a `catalog_source_runs` row, and
// the derivation reads #68's freshness verdict and #68's run quarantines to
// decide what may enter a chart. It adds no column to any of them.
export * from './priceHistory';
// Trustworthy price signals (#82) follows `priceHistory`, whose observations are
// one of its two inputs, and `merchants`, which its correction reports name. It
// adds no column to either: a signal is DERIVED at read time from tables this
// domain does not own, and what it stores is the versioned policy that decides
// what a claim means plus the sweep that measures how often one can be made.
export * from './priceSignals';
// The universal product-feed importer (#63) follows `ingestion`, which is not
// alphabetical and not preference: a feed configuration binds a
// `catalog_sources` row (so the whole provenance chain must precede it) and a
// `stores` row (the tenant boundary `channels:write` is checked against). It
// adds NOTHING to any table above it — the whole migration is additive, which
// is what makes turning the importer off a flag flip and never a data change.
export * from './feedImport';
// The eBay Browse catalog source (#65) is the very last export, downstream of
// `ingestion` itself: its tables reference `catalog_sources` and nothing else,
// and they exist for the three things eBay's own contract demands that no
// provider-neutral framework could anticipate — a per-APPLICATION daily call
// budget, a search-driven discovery cohort (eBay publishes no catalogue export
// at all), and the record of a live re-read disagreeing with what Mercaria
// serves. No observation, offer, match or rights column lives here.
export * from './ebay';
// The Awin retailer-network source (#66) is last, and follows `./ingestion`
// for the same reason `./feedImport` does plus one more: an Awin advertiser IS
// a `catalog_sources` row (that is the structural decision the whole domain
// follows from), its quality snapshots cite a `catalog_source_runs` row, and
// its network lease is #68's source lease raised to the publisher ACCOUNT —
// which #68's cannot be, because it is keyed on `source_id` and every
// advertiser has its own. It adds no column to any table above it.
export * from './awin';
// Supplier-fulfilled Mercaria-retail fulfilment (#126) is last, downstream of
// `./retailCheckout` (whose frozen procurement intent each fulfilment intent
// names), `./orders` (whose items its allocations point at) and `./procurement`
// (whose agreement supplies the permitted mode). It adds ONE nullable,
// defaulted column to `supplier_agreements` and nothing else to any table above
// it, which is what makes turning supplier-fulfilled retail off a flag flip
// rather than a data change. There is deliberately no carrier, package, label
// or scan table here at all — Moovo owns those, and the absence is asserted.
export * from './retailFulfilment';
// Affiliate outbound redirects, click records and commission reconciliation
// (#67) is downstream of `./offers` (whose stored destination is the ONLY thing
// it may send a buyer to), `./provenance` (whose source scopes the destination
// allow-list, the one table here that decides anything) and `./ledger` (which
// its commission postings name). It adds NO column to any of them: the offer
// already carries the destination and the routing metadata #62 recorded, and a
// second copy of either would be a second answer to where a buyer goes. There
// is deliberately no order, no buyer and no actor column in any of the six
// tables — an affiliate conversion is somebody else's sale to somebody Mercaria
// does not identify.
export * from './affiliateOutbound';
// Retail cancellations, returns, warranties, supplier RMAs and customer refunds
// (#127) follows `./retailFulfilment` because it is downstream of everything
// that one is: `./orders` and `./payments` (a request names an order, a refund
// and a dispute), `./procurement` (a recovery and an RMA name a purchase
// order), `./guestPortal` (a requester's grant) and `./catalog` (a policy
// exception names a category). Its twelve tables carry NO ledger account and no
// ledger pointer at all — #128 books what this domain classifies, the division
// `retail_cost_variance_records` already holds.
export * from './retailServiceRequests';
// The ranking policy register (#74) is the last export and references NOTHING —
// not an offer, not a merchant, not a source. That independence IS the domain's
// shape: a policy version says how to ORDER offers and never which ones exist,
// so nothing it holds can outlive or constrain a catalogue row. Its one
// cross-domain tie is a CHECK against #77's metric-key tuple, which is a
// shared-types value rather than a table.
export * from './ranking';
// Price alerts (#79) are the last export, and they are downstream of nearly
// everything above: an alert names a `canonical_products` row, a trigger names
// an `offers` row AND the immutable `offer_price_snapshots` row behind its
// price (#78), and a delivery record names the `notifications` row it produced.
// That dependency direction is the domain's shape — this reads the catalogue,
// the observation log and the notification feed and writes to none of them, so
// nothing here can change what a shopper is shown or what a source published.
export * from './priceAlerts';
// Natural-language shopping intent (#95) is, like `./ranking`, a domain that
// references almost nothing: one foreign key onto `guest_sessions` (so purging a
// guest credential purges the clarification state derived from it) and nothing
// else in the graph. That independence is the domain's shape — an interpretation
// is a QUERY, so nothing it holds may outlive or constrain a catalogue row, and
// there is deliberately no column anywhere here for a raw query, a product, a
// merchant or an offer.
export * from './searchIntent';
// Merchant demand analytics and the acquisition pipeline (#86) is an
// export downstream of `./merchants` (a snapshot is ABOUT a canonical
// merchant), `./canonicalCatalog` (a product row names a canonical product) and
// nothing else. It adds no column to any table above it and holds no claim
// verdict, no contact value and no ranking input — a snapshot is a RECORDING of
// what demand was at an instant, and the acquisition pipeline records what
// people decided about it.
export * from './merchantDemand';
// Zero-profit cost reconciliation (#128) is the last export of the retail
// chain and the most downstream table set among them: a reconciliation names
// an `orders` row, its components cite the `retail_cost_quotes` composition
// through #123's procurement intent, its supplier credits name a
// `purchase_orders` row and a `purchase_order_documents` reference, its
// adjustments name a `refunds` row, and its recognitions name a
// `ledger_transactions` row. Everything it points at already exists above it and
// nothing above it points back — which is the domain's shape, because a
// reconciliation that could be reached by the things it reconciles would be able
// to change them.
export * from './retailReconciliation';
// The "Sell yours" seller draft (#91) is downstream of `./canonicalCatalog`
// (the product a seller declares), `./catalog` (the listing a draft becomes and
// the category it is filed under) and `./condition` (whose disclosure
// vocabulary its staged details reuse verbatim rather than forking). It adds NO
// column to any table above it: a draft references the graph and copies none of
// it, which is what keeps a merge or a catalogue correction from leaving a
// half-finished listing describing a product under its old name.
export * from './sellYours';
// Guest-commerce governance (#111) is last of the guest domains and downstream
// of all of them: it names the tables #103–#110 write in its data inventory,
// and its retention policy versions state what each of their sweeps is FOR. It
// adds NO column to any of them — the whole domain is nine tables of its own,
// which is what makes turning the governance surface off a mount decision
// rather than a data change. It references nothing: every id it holds is a
// shared checkout-group token, a Mercaria-minted handle that authorizes
// nothing, or a keyed digest, all registered in `db/deferredForeignKeys.ts`.
export * from './guestGovernance';
// Merchant plans, entitlements and subscription billing (#89) is the last
// export and references only `./stores` (whose merchant the plan is a
// relationship with) and `./ledger` (whose balanced posting a settled invoice
// names). It deliberately references `./payments` NOT AT ALL: a Connect account
// and a subscription billing customer are two objects in two key spaces that
// mean opposite things, and acceptance 2 asks that they cannot be cross-linked
// — two tables with no relation between them is how. It adds no column to any
// table above it, which is what makes turning billing off a flag flip.
export * from './merchantPlans';
// Channel onboarding and the channel audit trail (#87) are the last export,
// downstream of `./connectors` (the connection a session creates), `./feedImport`
// (the feed configuration a `product_feed` session creates) and `./merchants`
// (the verified merchant and exact storefront a session binds to). It adds four
// nullable columns to `connections` — two pause instants and the disconnect
// decision — and nothing to any other table above it. There is deliberately NO
// credential column on a session, which is what makes "credentials are collected
// only through the provider's own flow" a property of the schema.
export * from './channels';
// Location publication, nearby discovery and collection (#93) is downstream of
// everything it touches without adding a column to any of them: `./stores` (the
// operational `locations` it publishes and the store that owns them),
// `./catalog` (the listing a P2P seller opts into local discovery for),
// `./orders` (the order a collection belongs to). The operational location and
// its `inventory_levels` stay exactly what they were — this is the PUBLIC face
// of a place plus everything a handover needs, which is why it is a separate
// publication row rather than nine more columns on `locations`.
export * from './pickup';
// Merchant activation readiness (#85) is the last export, and it references only
// `./stores`. That short list IS the design: activation reads eleven tables in
// eight domains and stores a verdict for none of them, so the only foreign key
// it owns is the store whose switches, support contact and audit trail these
// three tables hold. A column on `connections`, `provider_accounts` or
// `fee_schedules` would be a second answer to a question those tables already
// answer.
export * from './merchantActivation';
// Saved shopping-agent jobs (#97) are the last export and are downstream of
// nearly everything above: an agent's LINES name `canonical_products` and
// `canonical_variants`, a finding cites the `offers` #74 ranked and the
// `merchants` behind them, and a delivery record names the `notifications` row
// it produced. That direction is the domain's shape — it reads the catalogue,
// the comparison and the notification feed and writes to none of them, so
// nothing here can change what a shopper is shown, what a source published or
// what anything costs. There is no column in any of its eight tables for an
// order, a cart, a checkout group, a payment method or a merchant's terms,
// which is what makes "an agent cannot buy anything" a fact about the schema.
export * from './shoppingAgents';
// Versioned product types (#367, ADR 0007 D5) are downstream of `./catalog`
// (the `categories` a version is scoped to) and `./attributeRegistry` (the
// definition version every field CITES). They add no column to either, and no
// table here holds a value type, a unit family or a validation rule — #94 is the
// one registry and this is the authoring contract composed over it, which is
// what makes "two descriptions of one attribute" unrepresentable rather than
// merely discouraged.
export * from './productTypes';
// Navigation trees and the merchandising separation (#367 step 7, ADR 0007 D3).
// LAST, and it is downstream of everything a menu can point at without adding a
// column to any of them: `./catalog` (the category a node targets and never
// writes), `./merchandising` (the collection it links, which stays
// merchandising), `./organizations` (the brand) and `./canonicalCatalog` (the
// product family). That direction is the domain's whole shape — it READS the
// classification tree and the merchandising groupings and writes to neither, so
// nothing here can change what a category means or publish a collection by
// linking it. There is no column in any of its five tables for a category's
// name, parent, lifecycle or ancestry, and none for a rank, weight or sponsored
// slot, which is what makes ADR 0007 D3's two prohibitions properties of the
// schema rather than rules somebody follows.
export * from './navigation';
// ADR 0007 D4's catalog localization family (#367), and its short import list
// is the design: it references `./catalog`, `./attributeRegistry` and
// `./productTypes` and nothing else, because a localization is a facet of a
// concept somebody else owns and may never become a second answer to what that
// concept IS. It localizes a product-type VERSION rather than a key — D5 freezes
// a published version's meaning and a translation is of a meaning — and
// `attribute_labels` stays where #94 put it, adopted as this family's fourth
// text member rather than copied into a fifth table, which is the whole reason a
// polymorphic localization table was refused.
export * from './catalogLocalization';
// Compatibility and automotive fitment (#367 step 8, ADR 0007 D8) points
// only at `./canonicalCatalog` and `./provenance`. That short
// list is the design: "does this fit" is a relationship between two catalogue
// identities plus its provenance, and NOTHING here references `./catalog` —
// there is no import of `listing_options` or `product_variant_option_values`
// anywhere in the domain, which is what makes "a year range, a make or a model
// may never be stored as a variant option" a fact about the import graph rather
// than a rule somebody follows. It is deliberately NOT built on
// `./relationships` either: a brand relationship mints a badge and grants
// standing, while a compatibility claim is asserted routinely by parties with
// authority over neither product, so sharing that vocabulary would make
// `verified` mean two things.
export * from './compatibility';
// External taxonomy, attribute and value mappings (#367 Workstream 11) are the
// last export, and this module imports exactly `./columns`, `./provenance` and
// `./productTypes` — the `catalog_sources` a mapping is scoped to, the
// `source_records` that evidence it, and the product-type VERSION a mapping
// records having been reviewed against. Nothing else.
//
// `./productTypes` arrived on the rebase, not in the original design: that
// column was `DEFERRED_FOREIGN_KEYS`' only entry, and the id-column gate failed
// the build the moment the table landed. Adding it here is what the deferral was
// for.
//
// It does NOT import `./catalog`, and that is the correction #411 warns about
// rather than a coincidence: an earlier revision carried a `category` dimension
// with a real foreign key onto `categories`, and when that dimension went back
// to the taxonomy module the import went with it while this comment did not.
// Both halves of this list are verified against the module's own imports, not
// remembered — which is the only way the sentence stays true.
//
// It also does NOT reference `attribute_definitions`, deliberately: an
// attribute's identity is `(key, version)` and each row is ONE version, so an
// id-valued target would bind a reviewed governance decision to a version that
// will be deprecated — and there is no unique on `key` alone to point at
// anyway, because the one-live-version index is PARTIAL. The target is a stable
// machine KEY resolved against the active version at read time, which is the
// choice #94's own `attribute_source_mappings.attribute_key` already made.
//
// Nothing here writes to any table above it, and no module in the domain can
// reach a canonical write service or the matcher — so an external mapping can
// never mint a canonical entity, which is what keeps source records idempotent.
export * from './catalogExternalMappings';
// Typed variant axes and retained seller claims (#367 step 4, ADR 0007 D6/D7)
// are the last export, and this module imports exactly `./columns`,
// `./attributeRegistry`, `./catalog`, `./connectors` and `./productTypes` — the
// registry VERSION an axis cites, the listing and variant an axis and a claim
// are about, the connection a connector claim came from, and the product type
// version a declaration was made under. Nothing else.
//
// It does NOT import `./canonicalCatalog`, and that is the load-bearing absence
// rather than a coincidence: ADR 0007 D7 makes a merchant's claim and Mercaria's
// selected canonical fact different rows, both retained, and a column reaching
// `canonical_products` or `canonical_variants` from here would let a claim
// become a canonical fact by being written — skipping the selection and
// provenance machinery #56 owns. `NATIVE_CLAIM_FORBIDDEN_TARGETS` states the six
// prohibited identities as VALUES and `variant-axis-isolation.test.ts` scans for
// them, so the absence is measured rather than merely true today.
//
// It is also why these five tables need no `services/curation/merge-plan.ts`
// entry: the merge census walks foreign keys targeting a MERGEABLE entity, and
// every foreign key here targets a native listing, a native variant, an
// attribute definition, an enum value, a connection or a product type version.
export * from './variantAxes';
