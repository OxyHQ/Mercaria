/**
 * The schema-level guarantees of the typed-variant-axis domain, asserted against
 * the drizzle definitions and the migration's hand-written SQL (#367 step 4).
 *
 * These are STATIC reads of `getTableConfig` plus a walk of the
 * MIGRATION that carries this domain's hand-written statements, so they run in
 * CI on every push without a database.
 * What they cannot tell you is whether a CHECK's SQL is CORRECT — only a real
 * server settles that, and `db/__tests__/variant-axes.realdb.test.ts` does it. What they DO settle is that each constraint and each
 * trigger EXISTS and is named, which is the half that goes missing on a rebase:
 * regeneration drops every hand-written statement, and three of four branches in
 * one measured batch lost their triggers that way and would have applied cleanly
 * while enforcing nothing.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import {
  NATIVE_CLAIM_FORBIDDEN_TARGETS,
  NATIVE_CLAIM_SUBJECTS,
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
} from '@mercaria/shared-types';
import {
  nativeListingAttributeClaims,
  nativeListingVariantAxes,
  nativeVariantAttributeClaims,
  nativeVariantAxisAssignments,
  nativeVariantSignatures,
} from '../../../db/schema/variantAxes.js';

const TABLES: readonly PgTable[] = [
  nativeListingVariantAxes,
  nativeVariantAxisAssignments,
  nativeVariantSignatures,
  nativeListingAttributeClaims,
  nativeVariantAttributeClaims,
];

const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');

/**
 * The MIGRATION carrying this domain's hand-written statements, with a vacuity
 * floor.
 *
 * DISCOVERED rather than named, and the discovery is the assertion: exactly one
 * migration in the chain may own `mercaria_native_variant_axis_citation`. A
 * second one means somebody re-pasted the block into a later file (the triggers
 * would then be redefined out of order), and zero means a regeneration dropped
 * them — which is the measured failure three of four branches hit in one rebase
 * batch, all three applying cleanly and enforcing nothing.
 *
 * `variantAxes.pending.sql` is GONE, per `CONVENTIONS.md`'s two-copies rule: a
 * staging file that nothing applies is one somebody edits to no effect. This
 * file is what stands in its place, and it now reads the statements that will
 * actually run.
 */
function readMigrationSql(): string {
  const owning = readdirSync(DRIZZLE_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .filter((entry) =>
      readFileSync(join(DRIZZLE_DIR, entry), 'utf8').includes(
        'FUNCTION mercaria_native_variant_axis_citation()',
      ),
    );
  expect(
    owning,
    'exactly one migration must carry this domain’s hand-written statements',
  ).toHaveLength(1);
  const sql = readFileSync(join(DRIZZLE_DIR, owning[0] ?? ''), 'utf8');
  expect(sql.length, 'the migration looks empty — did it move?').toBeGreaterThan(4000);
  return sql;
}

/** One reader every case below shares, so they cannot assert against different files. */
const readPendingSql = readMigrationSql;

/**
 * The migration from its first marker on — the hand-written region.
 *
 * ANCHORED at a line start, which is load-bearing rather than tidy: an
 * unanchored search matches the marker quoted inside a comment and starts the
 * region early, dragging prose (and its `$$`) into every walk below.
 */
function statementRegion(): string {
  const pending = readPendingSql();
  const match = /^-- oxy:handwritten-begin=/m.exec(pending);
  expect(match, 'no marker block found in the migration').not.toBeNull();
  const region = pending.slice(match?.index ?? 0);
  // The control that makes the slice safe: no COMMENT inside the region may
  // carry a `$$`, or the dollar-quote walks below would toggle on prose.
  for (const line of region.split('\n')) {
    if (!line.trimStart().startsWith('--')) continue;
    expect(line.includes('$$'), `a comment in the statement region carries $$: ${line}`).toBe(false);
  }
  return region;
}

function checkNames(table: PgTable): readonly string[] {
  return getTableConfig(table).checks.map((entry) => entry.name);
}

/**
 * Flatten a drizzle `SQL` into readable text.
 *
 * `JSON.stringify` cannot be used: a chunk holding a column holds the table,
 * which holds the column, and the structure is circular — measured here, on the
 * first run. This walks the chunks instead, taking the literal string fragments
 * and each column's SQL name, so an assertion about a predicate is an assertion
 * about what will be EMITTED rather than about the object graph that emits it.
 */
function renderSql(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(renderSql).join(' ');
  if (typeof node !== 'object') return String(node);

  const record = node as Record<string, unknown>;
  // A `StringChunk` carries `value: string[]`.
  if (Array.isArray(record['value'])) return (record['value'] as unknown[]).map(renderSql).join('');
  // A `Column`. Rendered through `sqlColumnName`, never `column.name`: the
  // latter is the TypeScript property, because `@oxyhq/db` applies the casing at
  // query time.
  if (typeof record['name'] === 'string' && record['table'] !== undefined) {
    return sqlColumnName(node as PgColumn);
  }
  if (Array.isArray(record['queryChunks'])) return renderSql(record['queryChunks']);
  return '';
}

function indexNames(table: PgTable): readonly string[] {
  return getTableConfig(table).indexes.map((entry) => entry.config.name);
}

describe('the five tables and their names', () => {
  it('exports exactly five tables, with the SQL names the migration will create', () => {
    // The floor and the ceiling. A sixth table arriving without a decision is as
    // much a problem as one going missing.
    expect(TABLES).toHaveLength(5);
    expect(TABLES.map((table) => getTableConfig(table).name)).toEqual([
      'native_listing_variant_axes',
      'native_variant_axis_assignments',
      'native_variant_signatures',
      'native_listing_attribute_claims',
      'native_variant_attribute_claims',
    ]);
  });

  it('adds NO jsonb column anywhere, so ADR 0007 D14’s register is unchanged', () => {
    const jsonbColumns: string[] = [];
    for (const table of TABLES) {
      for (const column of Object.values(getTableColumns(table))) {
        if ((column as PgColumn).columnType.toLowerCase().includes('json')) {
          jsonbColumns.push(`${getTableConfig(table).name}.${sqlColumnName(column as PgColumn)}`);
        }
      }
    }
    expect(jsonbColumns).toEqual([]);
  });

  it('references NO canonical, brand, organization or merchant table', () => {
    // ADR 0007 D7's separation as a property of the foreign keys. A claim
    // reaching a canonical identity is a claim that became a canonical fact by
    // being written, skipping #56's selection and provenance machinery.
    const forbidden = new Set([
      'canonical_products',
      'canonical_variants',
      'canonical_product_families',
      'brands',
      'organizations',
      'merchants',
      'storefronts',
    ]);
    const offending: string[] = [];
    for (const table of TABLES) {
      for (const fk of getTableConfig(table).foreignKeys) {
        const target = getTableConfig(fk.reference().foreignTable).name;
        if (forbidden.has(target)) offending.push(`${getTableConfig(table).name} -> ${target}`);
      }
    }
    expect(offending).toEqual([]);
    // The vacuity floor: the walk has to be able to SEE foreign keys, or the
    // assertion above is satisfied by a reader that found none at all.
    const total = TABLES.reduce(
      (sum, table) => sum + getTableConfig(table).foreignKeys.length,
      0,
    );
    expect(total, 'the foreign-key walk found nothing — did it work?').toBeGreaterThanOrEqual(10);
  });

  it('targets no MERGEABLE entity, which is why it needs no merge-plan entry', () => {
    // `services/curation/merge-plan.ts`'s census walks foreign keys onto the
    // seven mergeable entities. Every target here is a native listing, a native
    // variant, an attribute definition, an enum value, a connection or a product
    // type version — none of which a merge can act on.
    const targets = new Set<string>();
    for (const table of TABLES) {
      for (const fk of getTableConfig(table).foreignKeys) {
        targets.add(getTableConfig(fk.reference().foreignTable).name);
      }
    }
    expect([...targets].sort()).toEqual([
      'attribute_definitions',
      'attribute_enum_values',
      'connections',
      'listings',
      'native_listing_variant_axes',
      'product_type_definitions',
      'product_variants',
    ]);
  });
});

describe('the constraints each table owes', () => {
  it('an axis carries its citation shape and the forbidden-key prohibition', () => {
    expect(checkNames(nativeListingVariantAxes)).toEqual(
      expect.arrayContaining([
        'native_listing_variant_axes_attribute_key_shape_check',
        'native_listing_variant_axes_attribute_version_check',
        'native_listing_variant_axes_position_check',
        'native_listing_variant_axes_forbidden_key_check',
      ]),
    );
    expect(indexNames(nativeListingVariantAxes)).toEqual(
      expect.arrayContaining(['native_listing_variant_axes_listing_attribute_key']),
    );
  });

  it('the forbidden-key CHECK is rendered from the PRODUCT-TYPE tuple, not a copy', () => {
    // Two tables, one list. #94 widening the reserved offer facts widens both,
    // and a second copy here is what would let them disagree in the permissive
    // direction — which is the only direction that matters.
    const rendered = getTableConfig(nativeListingVariantAxes)
      .checks.filter((entry) => entry.name === 'native_listing_variant_axes_forbidden_key_check')
      .map((entry) => renderSql(entry.value))
      .join(' ');
    expect(rendered, 'the CHECK rendered to nothing — did the walk work?').toContain('attribute_key');
    for (const key of PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS) {
      expect(rendered, `${key} is missing from the rendered CHECK`).toContain(key);
    }
    expect(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS.length).toBeGreaterThanOrEqual(20);
  });

  it('an assignment carries one value per axis, and a unit needs a magnitude', () => {
    expect(checkNames(nativeVariantAxisAssignments)).toEqual(
      expect.arrayContaining([
        'native_variant_axis_assignments_attribute_key_shape_check',
        'native_variant_axis_assignments_normalized_shape_check',
        'native_variant_axis_assignments_unit_check',
      ]),
    );
    expect(indexNames(nativeVariantAxisAssignments)).toEqual(
      expect.arrayContaining(['native_variant_axis_assignments_variant_axis_key']),
    );
  });

  it('a signature is a sha-256 digest and is unique per listing — the collision gate', () => {
    expect(checkNames(nativeVariantSignatures)).toEqual(
      expect.arrayContaining([
        'native_variant_signatures_signature_shape_check',
        'native_variant_signatures_axis_count_check',
      ]),
    );
    expect(indexNames(nativeVariantSignatures)).toEqual(
      expect.arrayContaining([
        'native_variant_signatures_variant_key',
        'native_variant_signatures_listing_signature_key',
      ]),
    );
  });

  it('every claim resolution rule is a BICONDITIONAL, at both grains', () => {
    // The safety property, and the reason it is stated twice: a one-way
    // `resolved ⇒ value present` still admits a BLOCKED claim carrying a
    // normalized value, which is "we could not tell, so we stored our best
    // guess" — the false merge ADR 0007 D6 names #58's shape for.
    for (const table of ['native_listing_attribute_claims', 'native_variant_attribute_claims']) {
      const drizzleTable =
        table === 'native_listing_attribute_claims'
          ? nativeListingAttributeClaims
          : nativeVariantAttributeClaims;
      expect(checkNames(drizzleTable)).toEqual(
        expect.arrayContaining([
          `${table}_attribute_refusal_shape_check`,
          `${table}_value_refusal_shape_check`,
          `${table}_attribute_operator_refusal_check`,
          `${table}_value_operator_refusal_check`,
          `${table}_attribute_resolved_check`,
          `${table}_attribute_version_check`,
          `${table}_value_resolved_check`,
          `${table}_enum_value_check`,
          `${table}_value_depends_on_attribute_check`,
          `${table}_resolver_audit_check`,
          `${table}_operator_refusal_audit_check`,
          `${table}_provenance_check`,
          `${table}_connector_provenance_check`,
          `${table}_legacy_provenance_check`,
        ]),
      );
    }
  });

  it('the refusal pairs are TWO biconditionals, never one over their conjunction', () => {
    // `(a = x) = (b is not null)` conjoined with `(a = y) = (c is not null)` is
    // satisfied by a row where every side is false, which admits exactly the row
    // the rule exists to refuse. Measured twice already in this schema
    // (`retail_delivery_promises`, `watchlist_snapshot_items`), both times by a
    // real server. Two SEPARATE named CHECKs is what makes it impossible to
    // write the collapsed form by accident.
    for (const drizzleTable of [nativeListingAttributeClaims, nativeVariantAttributeClaims]) {
      const table = getTableConfig(drizzleTable).name;
      const refusalChecks = checkNames(drizzleTable).filter((name) =>
        name.endsWith('_refusal_shape_check'),
      );
      expect(refusalChecks, `${table} collapsed its two refusal biconditionals`).toHaveLength(2);
    }
  });

  it('a listing claim discriminates its kind, and an axis declaration settles no value', () => {
    expect(checkNames(nativeListingAttributeClaims)).toEqual(
      expect.arrayContaining([
        'native_listing_attribute_claims_kind_check',
        'native_listing_attribute_claims_kind_shape_check',
        'native_listing_attribute_claims_declaration_value_check',
        'native_listing_attribute_claims_raw_name_check',
      ]),
    );
  });

  it('both claim tables converge on the CONTENT, value included', () => {
    // The value is in the identity key deliberately: a party renaming `Black` to
    // `Jet Black` has made a NEW assertion and ADR 0007 D7 retains both. What
    // converges is the SAME sentence arriving twice.
    expect(indexNames(nativeListingAttributeClaims)).toEqual(
      expect.arrayContaining([
        'native_listing_attribute_claims_identity_key',
        'native_listing_attribute_claims_queue_idx',
      ]),
    );
    expect(indexNames(nativeVariantAttributeClaims)).toEqual(
      expect.arrayContaining([
        'native_variant_attribute_claims_identity_key',
        'native_variant_attribute_claims_queue_idx',
      ]),
    );
  });

  it('generates the lookup keys rather than trusting a writer to fold them', () => {
    for (const drizzleTable of [nativeListingAttributeClaims, nativeVariantAttributeClaims]) {
      const columns = getTableColumns(drizzleTable);
      for (const name of ['rawNameNormalized', 'rawValueKey']) {
        const column = columns[name] as PgColumn | undefined;
        expect(column, `${getTableConfig(drizzleTable).name}.${name} is missing`).toBeDefined();
        expect(column?.generated?.type).toBe('always');
      }
    }
  });
});

describe('the prohibition lists are DISJOINT from the positive ones', () => {
  it('a claim can never be about a canonical identity', () => {
    const subjects = new Set<string>(NATIVE_CLAIM_SUBJECTS);
    for (const forbidden of NATIVE_CLAIM_FORBIDDEN_TARGETS) {
      expect(subjects.has(forbidden), `${forbidden} is in both lists`).toBe(false);
    }
    // Floors on both, so a list emptied by a bad merge fails here rather than
    // making the disjointness trivially true.
    expect(NATIVE_CLAIM_SUBJECTS.length).toBe(2);
    expect(NATIVE_CLAIM_FORBIDDEN_TARGETS.length).toBeGreaterThanOrEqual(6);
  });
});

/** The axis table's declared-mutable half, shared by the census and its self-test. */
const AXIS_MUTABLE: Readonly<Record<string, string>> = {
  position: 'display order, and deliberately not an input to the signature',
  id: 'the primary key',
  createdAt: 'row birthday',
  updatedAt: 'moves on every write by definition',
};

describe('the hand-written statements the migration carries', () => {
  it('names every trigger and function, exactly once each', () => {
    const pending = readPendingSql();

    const functions = [
      'mercaria_native_variant_axis_citation',
      'mercaria_native_variant_axis_frozen',
      'mercaria_native_variant_axis_assignment_scope',
      'mercaria_native_variant_signature_scope',
      'mercaria_native_variant_signature_agrees',
      'mercaria_native_listing_claim_frozen',
      'mercaria_native_variant_claim_frozen',
      'mercaria_native_claim_no_delete',
    ];
    for (const name of functions) {
      // Case-insensitive: the DDL keywords are upper-cased to match the house
      // style, while the plpgsql bodies stay lower-case. A case-sensitive census
      // would go red on a re-style rather than on a missing trigger.
      expect(
        new RegExp(`create or replace function ${name}\\(\\)`, 'i').test(pending),
        `${name} has no function body`,
      ).toBe(true);
    }

    const triggers = [
      'mercaria_native_variant_axis_citation',
      'mercaria_native_variant_axis_frozen',
      'mercaria_native_variant_axis_assignment_scope',
      'mercaria_native_variant_signature_scope',
      'mercaria_native_listing_claim_frozen',
      'mercaria_native_variant_claim_frozen',
      'mercaria_native_listing_claim_no_delete',
      'mercaria_native_variant_claim_no_delete',
    ];
    for (const name of triggers) {
      expect(
        new RegExp(`create trigger ${name}\\b`, 'i').test(pending),
        `${name} has no trigger`,
      ).toBe(true);
    }
    expect(pending.match(/^CREATE TRIGGER /gim) ?? []).toHaveLength(triggers.length);

    // The deferred pair, which is a DIFFERENT statement kind and would be
    // invisible to the count above.
    expect(pending.match(/^CREATE CONSTRAINT TRIGGER /gim) ?? []).toHaveLength(2);
    expect(pending).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  it('every NEW./OLD. reference names a real column of a table in this domain', () => {
    // plpgsql does not validate a record field at CREATE FUNCTION time, so a
    // typo'd column name in ANY of the eight bodies applies cleanly and raises
    // the first time the trigger fires — in production, on a write nobody
    // expected to fail. The freeze census below covers only the three triggers
    // that enumerate a frozen SET; this covers the other five, which reference
    // columns without enumerating them.
    const region = statementRegion();
    const known = new Set<string>();
    for (const table of TABLES) {
      for (const column of Object.values(getTableColumns(table))) {
        known.add(sqlColumnName(column as PgColumn));
      }
    }

    const referenced = new Set(
      [...region.matchAll(/\b(?:new|old)\.([a-z_]+)/g)].map((match) => match[1] ?? ''),
    );
    // The vacuity floor: a walk that matched nothing would satisfy the
    // assertion below by having nothing to check.
    expect(referenced.size, 'no NEW./OLD. references found — did the walk work?')
      .toBeGreaterThanOrEqual(12);
    expect([...referenced].filter((name) => !known.has(name)).sort()).toEqual([]);
  });

  it('never compares a STORED GENERATED column inside a BEFORE UPDATE trigger', () => {
    // A stored generated column is computed AFTER the trigger runs, so
    // `NEW.raw_name_normalized` is NULL there and any comparison raises on every
    // update. This cost a real bug in #59.
    const pending = readPendingSql();
    expect(pending).not.toContain('new.raw_name_normalized');
    expect(pending).not.toContain('new.raw_value_key');
    // The positive control: the trigger does compare the columns the generation
    // READS, so the assertion above is not passing because nothing is compared.
    expect(pending).toContain('new.raw_name is distinct from');
    expect(pending).toContain('new.raw_value is distinct from');
  });

  /**
   * Assert a freeze trigger's hand-written column list against the REAL table.
   *
   * The `merge-plan.ts` device. Every column is declared FROZEN (named in the
   * trigger) or MUTABLE with a reason, and the union must be EXACTLY the table's
   * column set — so a column added later fails the build until somebody decides
   * which it is. Finding fewer columns and there BEING fewer look identical
   * without it.
   *
   * Generalized over the trigger and the table, because the hole it closes is
   * not specific to one: ANY trigger in this schema whose body enumerates
   * columns has a hand-maintained list with nothing measuring it, and enforces
   * whatever somebody last remembered to type while looking identical either way.
   */
  function freezePartition(input: {
    readonly functionName: string;
    readonly table: PgTable;
    readonly mutable: Readonly<Record<string, string>>;
    readonly region?: string;
  }): { unclassified: string[]; frozen: number; stale: string[] } {
    const region = input.region ?? statementRegion();
    const from = region.indexOf(`${input.functionName}()`);
    const to = region.indexOf(`-- oxy:handwritten-end=${input.functionName}`);
    expect(from, `could not find ${input.functionName}`).toBeGreaterThan(-1);
    expect(to, `could not find the end marker for ${input.functionName}`).toBeGreaterThan(from);
    const body = region.slice(from, to);
    // A vacuity floor on the slice: an empty body would report every column
    // unclassified, which is loud, but a SHORT one could silently match a few.
    expect(body.length, `${input.functionName}'s body looks too short`).toBeGreaterThan(400);

    const columns = getTableColumns(input.table);
    const unclassified: string[] = [];
    let frozen = 0;
    for (const column of Object.keys(columns)) {
      if (column in input.mutable) continue;
      const sqlName = sqlColumnName(columns[column] as PgColumn);
      // Both terminators, because a long comparison legitimately wraps onto the
      // next line — the shape that made one mutation silently no-op.
      if (body.includes(`new.${sqlName} `) || body.includes(`new.${sqlName}\n`)) {
        frozen += 1;
        continue;
      }
      unclassified.push(`${column} (${sqlName})`);
    }
    // A declaration naming a column the table does not have is a stale entry
    // that silently exempts nothing — the `ID_COLUMNS_WITHOUT_FOREIGN_KEY`
    // ledger's own failure mode.
    const stale = Object.keys(input.mutable).filter((name) => columns[name] === undefined);
    return { unclassified, frozen, stale };
  }

  function assertFreezePartition(input: {
    readonly functionName: string;
    readonly table: PgTable;
    readonly mutable: Readonly<Record<string, string>>;
    readonly minimumFrozen: number;
  }): void {
    const { unclassified, frozen, stale } = freezePartition(input);
    expect(
      unclassified,
      `${input.functionName}: these columns are neither frozen by the trigger nor declared mutable`,
    ).toEqual([]);
    expect(stale, `${input.functionName}: these mutable declarations name no column`).toEqual([]);
    expect(
      frozen,
      `${input.functionName}: the freeze list matched no columns — did the slice work?`,
    ).toBeGreaterThanOrEqual(input.minimumFrozen);
  }

  it('the axis freeze trigger names EVERY identity column — a declared partition', () => {
    assertFreezePartition({
      functionName: 'mercaria_native_variant_axis_frozen',
      table: nativeListingVariantAxes,
      minimumFrozen: 6,
      mutable: AXIS_MUTABLE,
    });
  });

  it('the listing-claim freeze trigger names EVERY assertion column', () => {
    assertFreezePartition({
      functionName: 'mercaria_native_listing_claim_frozen',
      table: nativeListingAttributeClaims,
      minimumFrozen: 8,
      mutable: {
        // The resolution — everything settling a claim moves.
        attributeResolution: 'the resolver settles it; the assertion is untouched',
        attributeRefusal: 'named when the resolver or a person refuses',
        valueResolution: 'the resolver settles it',
        valueRefusal: 'named when the resolver or a person refuses',
        attributeDefinitionId: 'written when the attribute half resolves',
        attributeDefinitionVersion: 'travels with the definition id',
        enumValueId: 'written when the value resolves to a controlled value',
        normalizedValue: 'written when the value half resolves',
        resolvedByOxyUserId: 'stamped when a PERSON settles or refuses it',
        resolvedAt: 'stamped when a person settles or refuses it',
        // Structural.
        id: 'the primary key',
        rawNameNormalized:
          'GENERATED — NULL inside a BEFORE UPDATE trigger, so it cannot be compared',
        rawValueKey: 'GENERATED — NULL inside a BEFORE UPDATE trigger, so it cannot be compared',
        createdAt: 'row birthday',
        updatedAt: 'moves on every write by definition',
      },
    });
  });

  it('the variant-claim freeze trigger names EVERY assertion column', () => {
    assertFreezePartition({
      functionName: 'mercaria_native_variant_claim_frozen',
      table: nativeVariantAttributeClaims,
      minimumFrozen: 7,
      mutable: {
        attributeResolution: 'the resolver settles it; the assertion is untouched',
        attributeRefusal: 'named when the resolver or a person refuses',
        valueResolution: 'the resolver settles it',
        valueRefusal: 'named when the resolver or a person refuses',
        attributeDefinitionId: 'written when the attribute half resolves',
        attributeDefinitionVersion: 'travels with the definition id',
        enumValueId: 'written when the value resolves to a controlled value',
        normalizedValue: 'written when the value half resolves',
        resolvedByOxyUserId: 'stamped when a PERSON settles or refuses it',
        resolvedAt: 'stamped when a person settles or refuses it',
        id: 'the primary key',
        rawNameNormalized:
          'GENERATED — NULL inside a BEFORE UPDATE trigger, so it cannot be compared',
        rawValueKey: 'GENERATED — NULL inside a BEFORE UPDATE trigger, so it cannot be compared',
        createdAt: 'row birthday',
        updatedAt: 'moves on every write by definition',
      },
    });
  });

  it('the census goes RED when a frozen column is dropped from a trigger body', () => {
    // The mutation self-test, and the ORDER is the point: assert the mutation
    // LANDED before asserting the detector fires. A replacement that never
    // applied is indistinguishable from one that survived, and it reports green.
    //
    // A replacer FUNCTION rather than a replacement string, because `$` is an
    // escape in the latter — a mutation written with `$$` in a replacement never
    // applies and the test then measures the unmutated file.
    const region = statementRegion();
    const target = '     or new.legacy_option_name is distinct from old.legacy_option_name\n';
    expect(region.includes(target), 'the mutation target is not in the file').toBe(true);
    const mutated = region.replace(target, () => '');
    expect(mutated.includes('new.legacy_option_name'), 'the mutation did not land').toBe(false);
    expect(mutated.length).toBeLessThan(region.length);

    const before = freezePartition({
      functionName: 'mercaria_native_variant_axis_frozen',
      table: nativeListingVariantAxes,
      mutable: AXIS_MUTABLE,
      region,
    });
    expect(before.unclassified, 'the unmutated file should be clean').toEqual([]);

    const after = freezePartition({
      functionName: 'mercaria_native_variant_axis_frozen',
      table: nativeListingVariantAxes,
      mutable: AXIS_MUTABLE,
      region: mutated,
    });
    expect(after.unclassified).toEqual(['legacyOptionName (legacy_option_name)']);
  });

  it('the census goes RED when a mutable declaration names no column', () => {
    const { stale } = freezePartition({
      functionName: 'mercaria_native_variant_axis_frozen',
      table: nativeListingVariantAxes,
      mutable: { ...AXIS_MUTABLE, thereIsNoSuchColumn: 'a stale exemption' },
    });
    expect(stale).toEqual(['thereIsNoSuchColumn']);
  });

  it('wraps every hand-written statement in a NAMED marker pair, with no name reused', () => {
    const pending = readPendingSql();
    const begins = [...pending.matchAll(/^-- oxy:handwritten-begin=(.+)$/gm)].map((m) => m[1]);
    const ends = [...pending.matchAll(/^-- oxy:handwritten-end=(.+)$/gm)].map((m) => m[1]);

    // Eight blocks, not ten: `mercaria_native_claim_no_delete` is ONE function
    // mounted on TWO tables and `mercaria_native_variant_signature_agrees` is one
    // mounted on two more, so each is a single block. Two blocks would have to
    // share a name, and a repeated name is what makes a marker stack unable to
    // say which `end` closes which `begin`.
    expect(begins).toHaveLength(8);
    expect(ends).toEqual(begins);
    expect(new Set(begins).size, 'a marker name is reused in the file').toBe(begins.length);

    for (const line of pending.split('\n')) {
      if (!/^CREATE (OR REPLACE FUNCTION|TRIGGER|CONSTRAINT TRIGGER)/.test(line)) continue;
      const before = pending.slice(0, pending.indexOf(line));
      const openBegins = (before.match(/^-- oxy:handwritten-begin=/gm) ?? []).length;
      const openEnds = (before.match(/^-- oxy:handwritten-end=/gm) ?? []).length;
      expect(openBegins - openEnds, `unwrapped statement: ${line}`).toBe(1);
    }
  });

  it('separates statements with breakpoints, and never inside a dollar-quoted body', () => {
    const region = statementRegion();
    expect(region).toContain('--> statement-breakpoint');

    let insideBody = false;
    let lineNumber = 0;
    let bodiesSeen = 0;
    for (const line of region.split('\n')) {
      lineNumber += 1;
      // A separator inside a `$$ … $$` body is cut before anything is parsed, so
      // the function is halved and both halves fail — presenting as a syntax
      // error in our own SQL rather than as a separator problem.
      const toggles = (line.match(/\$\$/g) ?? []).length;
      // A line carrying a `$$` is the body's OPENER or its CLOSER, and neither is
      // "inside" it. Checking before the toggle flags `$$;--> statement-breakpoint`
      // — the correct, required placement — as the very violation being hunted.
      if (toggles % 2 === 1) {
        if (!insideBody) bodiesSeen += 1;
        insideBody = !insideBody;
        continue;
      }
      if (insideBody) {
        expect(
          line.includes('--> statement-breakpoint'),
          `breakpoint inside a $$ body at region line ${lineNumber}: ${line}`,
        ).toBe(false);
      }
    }
    expect(insideBody, 'an unterminated $$ body — the quoting is unbalanced').toBe(false);
    // A vacuity floor on the walk itself: a region the scanner never entered a
    // body in would satisfy the assertion above by never testing anything.
    expect(bodiesSeen, 'no dollar-quoted bodies found — did the walk work?').toBe(8);
  });

  it('every complete statement is either broken or block-final', () => {
    const lines = statementRegion().split('\n');
    let insideBody = false;
    let separated = 0;
    let blockFinal = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] ?? '').trimEnd();
      const toggles = (line.match(/\$\$/g) ?? []).length;
      if (toggles % 2 === 1) insideBody = !insideBody;
      // A statement ends where a `;` sits OUTSIDE a body — which for a function
      // is the `$$;` that closes it, never the semicolons within.
      if (insideBody) continue;
      if (!/;(\s*--> statement-breakpoint)?$/.test(line)) continue;

      if (line.includes('--> statement-breakpoint')) {
        separated += 1;
        continue;
      }
      const next = (lines[i + 1] ?? '').trim();
      expect(
        next.startsWith('-- oxy:handwritten-end='),
        `statement at region line ${i + 1} is neither broken nor block-final: ${line}`,
      ).toBe(true);
      blockFinal += 1;
    }

    // Eighteen statements: eight functions and ten triggers. Exactly one per
    // block is block-final — the last statement before its `end` marker — and
    // the other ten are separated inline. Pinned rather than floored, because a
    // walk that matched nothing would satisfy a floor of zero.
    expect(blockFinal).toBe(8);
    expect(separated).toBe(10);
  });
});
