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
 * and reordering it into alphabetical order would create a cycle. `ledger`
 * follows `payments` for the same reason — its transactions reference a payment.
 * `reconciliation` follows both: it is what NOTICED something wrong with them,
 * and its repair rows reference the discrepancies they answer.
 */
export * from './stores';
export * from './connectors';
export * from './catalog';
export * from './merchandising';
export * from './orders';
export * from './payments';
export * from './ledger';
export * from './reconciliation';
export * from './pos';
export * from './buyers';
// `guests` follows `buyers` deliberately: #104 gives `carts` a
// `guest_session_id` foreign key, so the session table must exist beside the
// cart it will own. Nothing references guests today.
export * from './guests';
export * from './notifications';
export * from './moderation';
// Canonical commerce graph (ADR 0002). `provenance` precedes `organizations`
// and `merchants` for the same dependency reason as above: alias and
// source-link tables reference `source_records`. `canonicalSupport.ts` is
// schema support like `columns.ts` and is deliberately NOT exported here.
export * from './provenance';
export * from './organizations';
export * from './merchants';
// Procurement (#118) follows `organizations`: `suppliers.organization_id`
// references the canonical graph's organizations table.
export * from './procurement';
