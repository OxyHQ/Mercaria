import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index.js';

/**
 * The `jsonb` register, DERIVED over every table (#367 relational boundaries).
 *
 * `CONVENTIONS.md` states the policy — *"`jsonb` is for genuinely shape-less
 * data only"*, with the moderation payload as the legitimate case because a
 * published CrowdSource decision is deliberately loose and projecting it into
 * columns would silently drop whatever a newer version added. Several schema
 * layers then state *"Zero new `jsonb`. Nothing in this layer earned a register
 * row."*
 *
 * That is the policy. What was missing is the register itself: the enforcement
 * was per-MODULE exact-count censuses in a handful of files, so the population
 * was the modules somebody remembered. A new `jsonb` column in any of the
 * others passed every gate. **The population is every table, and the default
 * for a table nobody has thought about is ZERO** — which is the only shape that
 * makes a register mean anything.
 *
 * ## Derive the exclusion, never the inclusion
 *
 * {@link JSONB_REGISTER} lists only the tables that HAVE one. Every other table
 * is asserted to have none, so a new table starts at the strict value and a new
 * `jsonb` column anywhere fails the build until somebody adds a line here. That
 * line is the register row `CONVENTIONS.md` describes, and adding it is the
 * deliberate act it was always supposed to be.
 *
 * ## Read from the SCHEMA, not from the source text
 *
 * The counts come from `getTableColumns` and `columnType === 'PgJsonb'`, so a
 * `jsonb(` inside a comment, a docblock example or a string cannot move them,
 * and neither can a column declared through a helper. A text census over
 * `db/schema/*.ts` returns the same 22 today; it would stop agreeing the moment
 * anybody wrapped the builder.
 */

/** Every table with at least one `jsonb` column, and how many it has. */
const JSONB_REGISTER: Readonly<Record<string, number>> = {
  catalog_authoring_drafts: 1,
  catalog_governance_audit_events: 2,
  catalog_governance_change_requests: 1,
  catalog_governance_definition_snapshots: 1,
  catalog_revisions: 2,
  connections: 1,
  moderation_outboxes: 1,
  notifications: 2,
  payment_discrepancies: 1,
  payment_outboxes: 1,
  payment_provider_events: 2,
  payment_repairs: 1,
  procurement_outboxes: 1,
  product_type_fields: 1,
  shopping_agent_findings: 1,
  shopping_agents: 1,
  source_records: 1,
  supplier_provider_events: 1,
};

/**
 * How each registered `jsonb` column is BOUNDED — #367 line 918's other half.
 *
 * The table register above answers "may this column exist". This answers "how
 * large can it get", and they are different questions with different answers:
 * of the 22, **two** carry a size CHECK, one is bounded by a named service
 * constant, two bound SHAPE and not size, one has a bound that is misdescribed,
 * and the rest rest on nothing but what their current callers happen to write.
 *
 * ## Why a register and not a bound-checking gate
 *
 * The bound is a per-domain decision living in one of three layers — a database
 * CHECK, a service constant, an ingress schema — so no global check can say what
 * 32 KB or twenty keys should be for a column it knows nothing about. What a
 * gate CAN do is refuse silence. This turns "bounded" from a property nobody can
 * check globally into a DECISION that cannot be skipped, which is the
 * `merge-plan.ts` device: **untouched WITH A REASON is an accepted disposition
 * and silence is not.**
 *
 * ## `unbounded` is a correct entry, and inventing a bound to avoid it is not
 *
 * Sixteen entries below say `unbounded`. That is the measurement, not a gap in
 * this file: exactly two size CHECKs exist in the whole schema
 * (`octet_length(<col>::text)`, on the two named below), and **no repository
 * anywhere applies a byte guard before writing a jsonb column** — verified
 * against `db/**` with `Buffer.byteLength`/`octet_length`, positive control 8
 * service files carrying the pattern.
 *
 * ## Shape is not size, and collapsing them here would delete the finding
 *
 * `shape_bounded_only` exists as its own value because
 * `payment_provider_events.payload_summary` and its supplier twin bound depth,
 * array length and string length PER ELEMENT and nothing in total — depth 6 x
 * arrays of 20 x 256-byte strings admits gigabytes in the limit. They also
 * TRUNCATE (`slice` plus an ellipsis, and a "N more" marker) where
 * `source_records.payload` REFUSES, returning `null` above
 * `MAX_STORED_PAYLOAD_BYTES` because a truncated payload hashes differently on
 * every delivery and its convergence key would stop converging.
 */
type JsonbBound =
  /** A `CHECK` on `octet_length(<col>::text)`. The only bound `psql` cannot walk past. */
  | 'size_checked_in_database'
  /** A named service constant over the serialized form, applied before the write. */
  | 'size_bounded_in_service'
  /** Depth/array/string bounded PER ELEMENT. NOT a total-byte bound. */
  | 'shape_bounded_only'
  /** A bound is claimed and the claim does not hold. Cites the issue. */
  | 'bound_disputed'
  /** Nothing bounds it. Requires a reason and carries no mechanism. */
  | 'unbounded';

interface JsonbColumnBound {
  readonly bound: JsonbBound;
  /**
   * The symbol or constraint name that DOES the bounding, asserted to resolve
   * in the tree. Present exactly when the bound is not `unbounded` — a
   * disposition naming nothing resolvable is the `gate.length > 10` defect.
   */
  readonly mechanism?: string;
  readonly why: string;
}

const JSONB_COLUMN_BOUNDS: Readonly<Record<string, JsonbColumnBound>> = {
  'catalog_authoring_drafts.schemaSnapshot': {
    bound: 'size_checked_in_database',
    mechanism: 'catalog_authoring_drafts_snapshot_bounded_check',
    why: '256 KB via `octet_length(<col>::text)` (ADR 0007 D14), not `pg_column_size`, whose answer depends on TOAST.',
  },
  'product_type_fields.visibilityRule': {
    bound: 'size_checked_in_database',
    mechanism: 'PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES',
    why: 'The visibility AST is bounded in the schema for the same reason and by the same expression.',
  },
  'source_records.payload': {
    bound: 'size_bounded_in_service',
    mechanism: 'MAX_STORED_PAYLOAD_BYTES',
    why: '32 KB over the serialized projection, and it REFUSES rather than truncating — a truncated payload hashes differently every delivery, so the convergence key would stop converging.',
  },
  'payment_provider_events.payloadSummary': {
    bound: 'shape_bounded_only',
    mechanism: 'MAX_DEPTH',
    why: 'Depth 6, arrays of 20, strings of 256, applied PER ELEMENT and truncating. No total-byte bound exists; the product of the three is unbounded in practice.',
  },
  'supplier_provider_events.payloadSummary': {
    bound: 'shape_bounded_only',
    mechanism: 'SUPPLIER_EVENT_PAYLOAD_FIELDS',
    why: 'An allow-list of fields plus the same per-element shape bounds. Nested objects are NOT walked, which is where a provider puts an address, and no total-byte bound exists.',
  },
  'catalog_governance_change_requests.parameters': {
    bound: 'bound_disputed',
    mechanism: '#931',
    why: 'Its docblock claims "a flat object, at most twenty keys, so a caller cannot post a nested document"; the schema is `.record(z.string().max(64), z.unknown())`, so VALUES are unconstrained and one key may hold an arbitrarily deep document. Flatness claimed, not enforced, in front of a column with no CHECK and no repository guard. Tracked as #931 and deliberately NOT fixed here.',
  },

  // ── Compounding: these size with the row they copy ───────────────────────
  'catalog_governance_audit_events.before': {
    bound: 'unbounded',
    why: 'COMPOUNDING — a snapshot of the row being changed, so bounding it means bounding what it copies. No CHECK, no repository guard.',
  },
  'catalog_governance_audit_events.after': {
    bound: 'unbounded',
    why: 'COMPOUNDING — as `before`, one column over.',
  },
  'catalog_revisions.before': {
    bound: 'unbounded',
    why: 'COMPOUNDING — the revision trail copies the prior row wholesale.',
  },
  'catalog_revisions.after': {
    bound: 'unbounded',
    why: 'COMPOUNDING — as `before`, one column over.',
  },
  'catalog_governance_definition_snapshots.document': {
    bound: 'unbounded',
    why: 'COMPOUNDING — a whole definition version, so its size is the definition\u2019s size. Note `catalog_authoring_drafts.schema_snapshot` bounds a comparable document at 256 KB and this one does not.',
  },

  // ── The rest: bounded by what their callers happen to write ──────────────
  'connections.syncSettingsCollectionMapping': {
    bound: 'unbounded',
    why: 'A merchant-supplied collection mapping. Grows with the connected shop\u2019s collection count and nothing bounds it.',
  },
  'moderation_outboxes.payload': {
    bound: 'unbounded',
    why: 'The CrowdSource envelope, deliberately LOOSE (`CONVENTIONS.md` calls it the clearest legitimate jsonb) — but loose in SHAPE is not bounded in SIZE.',
  },
  'notifications.data': {
    bound: 'unbounded',
    why: 'Per-notification payload composed by many callers; no shared writer to guard.',
  },
  'notifications.deliveryStatus': {
    bound: 'unbounded',
    why: 'Grows with the number of delivery channels attempted; small in practice and bounded by nothing.',
  },
  'payment_discrepancies.detail': {
    bound: 'unbounded',
    why: 'Reconciliation evidence, composed per discrepancy kind. No CHECK, no repository guard.',
  },
  'payment_outboxes.payload': {
    bound: 'unbounded',
    why: 'The job payload. `payment_provider_events.payload_summary` beside it is redacted and shape-bounded; this one is not.',
  },
  'payment_provider_events.objectIds': {
    bound: 'unbounded',
    why: 'An array of provider object ids; length follows the provider event and nothing caps it.',
  },
  'payment_repairs.detail': {
    bound: 'unbounded',
    why: 'Operator-supplied repair detail on an append-only audit row.',
  },
  'procurement_outboxes.payload': {
    bound: 'unbounded',
    why: 'The job payload, as `payment_outboxes.payload`.',
  },
  'shopping_agent_findings.recordRefs': {
    bound: 'unbounded',
    why: 'References accumulated by one finding; grows with the run.',
  },
  'shopping_agents.constraintSet': {
    bound: 'shape_bounded_only',
    mechanism: 'MAX_CONSTRAINTS_PER_SET',
    why:
      'THIRTY-TWO constraints, at ingress: `createShoppingAgentSchema` and `updateShoppingAgentSchema` '
      + 'both carry `z.array(productConstraintSchema).max(MAX_CONSTRAINTS_PER_SET)`. A COUNT bound and '
      + 'not a size one — each element is itself unbounded — which is why this sits with the '
      + 'payload_summary columns rather than with the two size CHECKs. '
      + 'It binds every writer REACHABLE today and does so by reachability rather than by '
      + 'construction: `agent.service.ts` is the only module that writes this column, its two exported '
      + 'writers have exactly one caller each (`shopping-agents.controller.ts`), and both routes mount '
      + '`validateBody`. A second caller of `createShoppingAgent` would bypass the bound silently, so '
      + 'the completeness is a property of the current call graph and not of the column.',
  },
};

/**
 * The anti-vacuity floor.
 *
 * A `>=` rather than an exact count, deliberately: `schema-conventions.test.ts`
 * owns the EXACT population pin (`SCHEMA_TABLE_COUNT`), and two files carrying
 * the same number is two places to update and one of them to forget. What this
 * file needs is only the guarantee that it traversed a real schema — because
 * "every table outside the register has zero jsonb columns" is satisfied
 * perfectly by traversing no tables at all.
 */
const MINIMUM_TABLES = 400;

const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/** How many `jsonb` columns one table declares. */
function jsonbColumnCount(table: PgTable): number {
  let count = 0;
  for (const column of Object.values(getTableColumns(table))) {
    if ((column as { columnType?: string }).columnType === 'PgJsonb') count += 1;
  }
  return count;
}

/** `table.column` for every `jsonb` column the schema declares. */
function jsonbColumnKeys(): string[] {
  const keys: string[] = [];
  for (const table of tables) {
    for (const column of Object.values(getTableColumns(table))) {
      if ((column as { columnType?: string }).columnType === 'PgJsonb') {
        keys.push(`${getTableName(table)}.${(column as { name: string }).name}`);
      }
    }
  }
  return keys.sort();
}

/** Every production `.ts` under a source root, tests excluded. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

const SOURCE = [
  join(__dirname, '..', '..'),
  join(__dirname, '..', '..', '..', '..', 'shared-types', 'src'),
].flatMap((root) => sourceFiles(root));

/** Does this symbol or constraint name appear anywhere in production source? */
function resolvesInTree(symbol: string): boolean {
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9_])`, 'u');
  return SOURCE.some((file) => pattern.test(readFileSync(file, 'utf8')));
}

describe('every registered jsonb column states how it is bounded', () => {
  it('the column walk and the source walk both found something', () => {
    // Two floors, because there are two populations and either being empty
    // makes a different set of assertions vacuous.
    expect(jsonbColumnKeys().length, 'no jsonb columns found at all').toBeGreaterThanOrEqual(20);
    expect(SOURCE.length, 'the source walk found almost nothing').toBeGreaterThanOrEqual(500);
  });

  it('the bound register names EXACTLY the jsonb columns that exist', () => {
    // Both directions. A new jsonb column fails until somebody states how it is
    // bounded — which is the whole mechanism — and a removed one fails too, so
    // the register cannot rot into naming columns that are gone.
    expect(Object.keys(JSONB_COLUMN_BOUNDS).sort()).toEqual(jsonbColumnKeys());
  });

  it('every key resolves to a real column of a real table', () => {
    // The `line 99` binding, one grain finer: a renamed column must fail rather
    // than pass as a string that matches nothing.
    const actual = new Set(jsonbColumnKeys());
    for (const key of Object.keys(JSONB_COLUMN_BOUNDS)) {
      expect(actual.has(key), `the bound register names "${key}", which is not a jsonb column`).toBe(
        true,
      );
    }
  });

  it('a mechanism is present exactly when the column is bounded', () => {
    // A biconditional rather than two checks: an `unbounded` entry carrying a
    // mechanism is claiming a bound it does not have, and a bounded entry
    // without one is the disposition-that-names-nothing defect.
    for (const [key, entry] of Object.entries(JSONB_COLUMN_BOUNDS)) {
      expect(entry.mechanism !== undefined, `${key}: mechanism vs bound`).toBe(
        entry.bound !== 'unbounded',
      );
      expect(entry.why.length, `${key} has no reason`).toBeGreaterThan(40);
    }
  });

  it('every named mechanism RESOLVES — a symbol in the tree, or an issue', () => {
    // The `gate.length > 10` lesson: a disposition meaning "something else
    // handles this" must resolve the something else. A constant that was
    // renamed, or a CHECK that was dropped, fails here instead of reading as
    // care.
    for (const [key, entry] of Object.entries(JSONB_COLUMN_BOUNDS)) {
      if (entry.mechanism === undefined) continue;
      if (entry.bound === 'bound_disputed') {
        expect(entry.mechanism, `${key}: a disputed bound must cite an issue`).toMatch(/^#\d+$/u);
        continue;
      }
      expect(resolvesInTree(entry.mechanism), `${key}: "${entry.mechanism}" resolves nowhere`).toBe(
        true,
      );
    }
  });

  it('the resolver can tell a real symbol from an invented one', () => {
    // Both directions, because "every mechanism resolves" is satisfied by a
    // resolver that returns true for everything.
    expect(resolvesInTree('MAX_STORED_PAYLOAD_BYTES')).toBe(true);
    expect(resolvesInTree('ZZ_MECHANISM_THAT_DOES_NOT_EXIST')).toBe(false);
  });

  it('shape-bounded is not recorded as size-bounded', () => {
    // The finding this vocabulary exists to preserve. These two bound depth,
    // array length and string length PER ELEMENT and nothing in total, so
    // recording them as size-bounded would delete the distinction that makes
    // them worth knowing about.
    for (const key of [
      'payment_provider_events.payloadSummary',
      'supplier_provider_events.payloadSummary',
    ]) {
      expect(JSONB_COLUMN_BOUNDS[key]?.bound, `${key} lost its shape-only bound`).toBe(
        'shape_bounded_only',
      );
    }
  });
});

describe('the jsonb register covers every table', () => {
  it('traversed a real schema', () => {
    expect(
      tables.length,
      'the barrel exported almost nothing — a broken import makes every assertion below vacuous',
    ).toBeGreaterThanOrEqual(MINIMUM_TABLES);
  });

  it('every register entry names a real table', () => {
    // An entry that matches nothing excuses nothing while looking like care —
    // the rule `ID_COLUMNS_WITHOUT_FOREIGN_KEY` and every isolation gate here
    // states about its own exemptions.
    const names = new Set(tables.map((table) => getTableName(table)));
    for (const name of Object.keys(JSONB_REGISTER)) {
      expect(names.has(name), `the register names "${name}", which is not a table`).toBe(true);
    }
  });

  it('no table outside the register declares a jsonb column', () => {
    const unregistered = tables
      .filter((table) => jsonbColumnCount(table) > 0)
      .map((table) => getTableName(table))
      .filter((name) => !(name in JSONB_REGISTER))
      .sort();
    expect(
      unregistered,
      'a jsonb column landed on a table with no register row. `CONVENTIONS.md` says jsonb is for '
        + 'genuinely shape-less data only — a price, an address or a set of totals is not. If this '
        + 'one earned it, add the table and its count above; that line IS the register row.',
    ).toEqual([]);
  });

  it('every registered table declares exactly the stated number', () => {
    // Exact, not a floor: a SECOND jsonb column on a table that already earned
    // one is the likeliest way this policy erodes, and a `>= 1` would never see
    // it.
    for (const [name, expected] of Object.entries(JSONB_REGISTER)) {
      const table = tables.find((candidate) => getTableName(candidate) === name);
      expect(table, `${name} disappeared from the barrel`).toBeDefined();
      if (table === undefined) continue;
      expect(jsonbColumnCount(table), `${name} no longer declares ${String(expected)}`).toBe(
        expected,
      );
    }
  });

  it('the detector can see a jsonb column at all — the mutation self-test', () => {
    // Every assertion above is an absence over unregistered tables, and an
    // absence check whose detector cannot match reports the same clean pass
    // forever. This proves `jsonbColumnCount` returns a non-zero for a table
    // that genuinely has one.
    const registered = tables.find(
      (table) => getTableName(table) === 'moderation_outboxes',
    );
    expect(registered, 'the control table is gone; pick another register entry').toBeDefined();
    if (registered !== undefined) expect(jsonbColumnCount(registered)).toBeGreaterThan(0);
    // And that it returns ZERO for one that does not, so the count is reading
    // the column type rather than answering non-zero for everything.
    const plain = tables.find((table) => jsonbColumnCount(table) === 0);
    expect(plain, 'every table has a jsonb column, which cannot be right').toBeDefined();
  });
});
