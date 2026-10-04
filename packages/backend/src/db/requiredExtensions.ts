/**
 * The extensions Mercaria's migration chain depends on.
 *
 * Its own module, rather than a constant inside `migrate.ts`, so the one other
 * caller of the migrator — `testDatabase.ts`, building a database that stops
 * partway along the chain — ensures exactly the same list. `migrate.ts` runs
 * its `main()` on import and so cannot be imported for a constant.
 */

import type { RequiredExtension } from '@oxy.so/db/migrate';

/**
 * The extensions Mercaria's schema depends on, ensured before any migration is
 * applied rather than inside a numbered one.
 *
 * A migration that names a `geography` column fails outright on a database
 * where PostGIS is absent, and only on a FRESH one — the shape that passes on a
 * warm developer machine and then fails in CI or on a newly provisioned RDS
 * database. Making it a precondition of the MIGRATOR means the ordering cannot
 * be got wrong by renumbering, squashing or regenerating the sequence.
 *
 * `IF NOT EXISTS` (which `ensureExtensions` uses) short-circuits BEFORE the
 * privilege check, so this is a no-op for the unprivileged application role on
 * an already-prepared database. It is NOT a fallback that installs PostGIS
 * where it is missing: a new target database still needs a privileged role to
 * run `CREATE EXTENSION` once. `mercaria` on the shared `oxy-postgres` instance
 * has already had that done.
 */
export const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [
  {
    name: 'postgis',
    reason:
      'The migration chain names `geography` columns (listings from 0000, location ' +
      'publications from 0076) that 0161 later dropped when place facts moved to GoWay ' +
      '(ADR 0013), so a FRESH database replaying the chain needs the type. Nothing ' +
      'reads PostGIS at runtime any more.',
  },
  {
    name: 'pg_trgm',
    reason:
      'The canonical graph (ADR 0002 D21) does typo-tolerant alias and ' +
      'candidate-name lookup through trigram GIN indexes ' +
      '(`gin_trgm_ops` on the normalized alias/name columns). Unlike PostGIS ' +
      'this is a TRUSTED extension, so the application role can create it ' +
      'itself — no privileged provisioning step.',
  },
];

