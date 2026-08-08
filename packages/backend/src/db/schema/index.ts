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
 * and reordering it into alphabetical order would create a cycle.
 */
export * from './stores';
export * from './connectors';
export * from './catalog';
export * from './merchandising';
export * from './orders';
export * from './pos';
export * from './buyers';
export * from './notifications';
export * from './moderation';
