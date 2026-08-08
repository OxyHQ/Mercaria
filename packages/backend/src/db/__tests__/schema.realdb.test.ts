/**
 * The two schema gates that need a MIGRATED database, finally wired.
 *
 * `schema-conventions.test.ts` next door reads the drizzle definitions —
 * TypeScript, in memory. These two read the real Postgres CATALOGUE, which is a
 * different question and the one that matters: what the migrations actually
 * created, rather than what the schema files were meant to produce. A hand-edited
 * migration, a `text({ enum })` that emits no DDL, a dropped index — none of them
 * is visible from the TypeScript side.
 *
 * `CONVENTIONS.md` recorded both as "not yet wired" because they needed a
 * Postgres harness the suite did not have. The payment domain brought one
 * (`vitest.pg.globalSetup.ts` is now in `vitest.config.ts`), so they run.
 *
 * ## The expiry gate is the one with teeth right now
 *
 * `EXPIRY_TARGETS` gained two entries with the payment domain, and the sweep
 * deletes with `column <= now() - retention`. Without a leading btree on that
 * column it is a full table scan every time the sweep runs — the exact cost a
 * Mongo TTL index hid, now paid on a schedule instead of never. The convention
 * ("index the column you register") does not notice a later migration dropping
 * the index, and this does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { findSchemaInvariantViolations, findUnsupportedExpiryColumns } from '@oxyhq/db/assert';
import { EXPIRY_TARGETS } from '../expiryTargets.js';
import type { Database } from '../postgres.js';

/**
 * Traversal floors. Fewer than this is a broken catalogue query, not a clean
 * schema — a gate that examines nothing passes silently, which is the failure
 * these numbers exist to make impossible.
 *
 * RAISE them with the schema, exactly as `SCHEMA_TABLE_COUNT` is raised.
 */
const MINIMUM_TABLES = 57;
const MINIMUM_COLUMNS = 700;

/**
 * `''`-default columns that predate this gate and are fixed by a sibling
 * branch's migration, not by this one.
 *
 * Listed by `table.column`. Delete an entry when its default goes; delete the
 * constant when it is empty.
 */
const KNOWN_EMPTY_STRING_DEFAULTS: readonly string[] = [
  'stores.description',
  'listings.description',
];

let db: Database;
let closePostgres: typeof import('../postgres.js').closePostgres;

beforeAll(async () => {
  const postgres = await import('../postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

describe('schema conventions (against the migrated database)', () => {
  it('breaks no schema-wide invariant beyond a known, shrinking allow-list', async () => {
    // snake_case tables and columns, a primary key on every table, every
    // timestamp `timestamptz`, no `''` default, and no `_id`/`__v` left over
    // from Mongoose.
    //
    // ## Two violations are ALLOWED, and the allow-list is written to expire
    //
    // `stores.description` and `listings.description` carry a `''` DEFAULT,
    // which `CONVENTIONS.md` forbids — an empty string is a VALUE, so it says
    // "the seller wrote nothing" where NULL would say "the seller has not
    // written anything yet", and only one of those can be told apart from a
    // description someone deliberately cleared.
    //
    // They arrived with the initial schema. A sibling branch's migration
    // (`drop_empty_string_defaults`) removes both, and it is not merged yet — so
    // this gate has to pass on BOTH sides of that merge, in either order.
    //
    // Hence a SUBSET assertion rather than an exact one. Pinning the exact set
    // would have been a landmine: it passes today and fails the moment the
    // sibling lands, in a file that has nothing to do with either change. This
    // form fails on any NEW violation anywhere in the 57 tables, tolerates these
    // two while they exist, and needs no edit when they go — at which point
    // `KNOWN_EMPTY_STRING_DEFAULTS` is empty and can be deleted outright.
    const violations = await findSchemaInvariantViolations(db, {
      minimumTables: MINIMUM_TABLES,
      minimumColumns: MINIMUM_COLUMNS,
    });

    const unexpected = violations.filter(
      (violation) =>
        !(
          violation.check === 'empty_string_default' &&
          KNOWN_EMPTY_STRING_DEFAULTS.includes(violation.subject)
        ),
    );
    expect(unexpected).toEqual([]);

    // …and the allow-list may only SHRINK. An entry that no longer fires is a
    // fixed column whose exemption is now dead weight claiming a violation
    // exists — the stale-ledger failure every other registry in this schema is
    // checked for.
    expect(violations.length).toBeLessThanOrEqual(KNOWN_EMPTY_STRING_DEFAULTS.length);
  });

  it('supports every expiry-swept column with a leading btree index', async () => {
    expect(await findUnsupportedExpiryColumns(db, EXPIRY_TARGETS)).toEqual([]);
  });

  it('registers every expiry target the schema needs', () => {
    // The anti-vacuity floor for the gate above: it reports nothing for an
    // EMPTY target list, so a registry that lost an entry would pass it. Five
    // targets today — three ported TTL indexes plus the payment outbox and the
    // provider-event store, which were born in Postgres.
    expect(EXPIRY_TARGETS).toHaveLength(5);
  });
});
