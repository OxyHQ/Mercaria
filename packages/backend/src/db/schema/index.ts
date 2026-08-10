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
// The ranking policy register (#74) is the last export and references NOTHING —
// not an offer, not a merchant, not a source. That independence IS the domain's
// shape: a policy version says how to ORDER offers and never which ones exist,
// so nothing it holds can outlive or constrain a catalogue row. Its one
// cross-domain tie is a CHECK against #77's metric-key tuple, which is a
// shared-types value rather than a table.
export * from './ranking';
