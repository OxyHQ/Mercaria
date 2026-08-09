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
export * from './buyers';
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
