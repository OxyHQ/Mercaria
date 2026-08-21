/**
 * The schema-level guarantees of the external-mapping domain, asserted against
 * the drizzle definitions (#367 Workstream 11).
 *
 * These are STATIC reads of `getTableConfig`, so they run in CI on every push
 * without a database. What they cannot tell you is whether a CHECK's SQL is
 * correct — only a real server settles that, and the realdb suite that does it
 * lands with the migration (see `docs/catalog-external-mappings.md` §"What the
 * realdb suite must cover"). What they DO settle is that each constraint EXISTS
 * and is named, which is the half that goes missing on a rebase: regeneration
 * drops every hand-written statement, and three of four branches in one measured
 * batch lost their triggers that way and would have applied cleanly while
 * enforcing nothing.
 *
 * The hand-written half is read from the MIGRATION that ships it, located by
 * content. Until #831 it was read from `catalogExternalMappings.pending.sql`, a
 * staging file whose header still said `NOT APPLIED` fifty-odd migrations after
 * the slot arrived — so the gate was keeping the stale copy alive rather than
 * catching it. See `handwrittenMigration()`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import {
  catalogExternalMappingReviews,
  catalogExternalMappingRunItems,
  catalogExternalMappingRuns,
  catalogExternalMappings,
  catalogExternalTokenObservations,
} from '../../../db/schema/catalogExternalMappings.js';

const TABLES: readonly PgTable[] = [
  catalogExternalMappings,
  catalogExternalMappingReviews,
  catalogExternalTokenObservations,
  catalogExternalMappingRuns,
  catalogExternalMappingRunItems,
];

const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');

/**
 * A `CREATE [OR REPLACE] FUNCTION` for one of THIS domain's functions.
 *
 * A DEFINITION, never a mention: a later migration that attaches an existing
 * function to a new table names it on its `EXECUTE FUNCTION` line and carries no
 * body, which is the mechanism being REUSED and is fine. A later migration that
 * re-declares the body is the second representation this gate exists to find,
 * and it is the drift a file citation cannot see — measured elsewhere in this
 * repo, where `0023` created a trigger freezing three columns and `0030`
 * silently replaced it with one freezing four
 * (`docs/catalog-migration-operations.md`). A bare-name match reports the safe
 * case and the dangerous one identically.
 */
const DOMAIN_FUNCTION_DEFINITION =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+mercaria_catalog_external\w*\s*\(/m;

/**
 * The migration that carries this domain's hand-written statements.
 *
 * Located by CONTENT across the WHOLE chain and asserted to be found exactly
 * once — never by a hardcoded path, and no longer from a staging file.
 *
 * `db/schema/catalogExternalMappings.pending.sql` held these statements as plain
 * text while ADR 0007 D11 serialised `db:generate` across the parallel #367
 * branches. The slot arrived: they are in `0094_dizzy_makkari.sql`, applied, and
 * the staging file was deleted under CONVENTIONS' two-copies rule (#831) — the
 * same close its three siblings got (`catalogLocalization` → `0091`,
 * `catalogProposals` → `0100`, `catalogGovernance` → `0102`).
 *
 * Reading the shipped migration is strictly stronger than reading the staging
 * copy, in two directions. The staging file could have been correct while the
 * paste dropped a function — the whole failure mode here is a migration that
 * applies cleanly and enforces nothing. And the staging copy could not go stale
 * loudly: it was byte-identical to `0094` on the day it was deleted, and nothing
 * would have said so once a later `CREATE OR REPLACE` moved the live body.
 */
function handwrittenMigration(): { name: string; text: string } {
  const found = readdirSync(DRIZZLE_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => ({ name: entry, text: readFileSync(join(DRIZZLE_DIR, entry), 'utf8') }))
    .filter((file) => DOMAIN_FUNCTION_DEFINITION.test(file.text));

  // The floor and the ceiling in one. ZERO means a regeneration dropped the
  // whole hand-written half — which applies cleanly and enforces nothing. TWO
  // means a later migration re-declared a body, so the assertions below are
  // measuring whichever copy this scan happened to reach while the LAST one in
  // journal order is what a from-zero apply actually installs.
  expect(
    found.map((file) => file.name),
    'the hand-written statements must live in exactly one migration',
  ).toHaveLength(1);
  return found[0];
}

/**
 * The migration's hand-written REGION — its first begin marker to its last end
 * marker, inclusive.
 *
 * Everything above it is drizzle-generated DDL, and reading that as the
 * hand-written half is how a scanner ends up measuring the wrong thing
 * confidently.
 */
function statementRegion(): string {
  const lines = handwrittenMigration().text.split('\n');
  // ANCHORED at column 0, and the anchor is load-bearing: prose explaining this
  // convention quotes the marker inline (a `grep -c '^-- oxy:handwritten-begin='`
  // self-check, this very docblock), so a substring search starts the region in
  // a comment and drags `$$` prose in with it. The control below caught exactly
  // that. The real gate greps anchored for the same reason.
  const start = lines.findIndex((line) => line.startsWith('-- oxy:handwritten-begin='));
  // A reverse scan rather than `findLastIndex`: this package's `lib` predates
  // ES2023, and vitest transpiles the call happily while `tsc` rejects it — the
  // house rule that a green suite is not a substitute for a typecheck, met here
  // rather than by widening `lib` for one convenience.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? '').startsWith('-- oxy:handwritten-end=')) {
      end = i;
      break;
    }
  }
  expect(start, 'no column-0 begin marker in the migration').toBeGreaterThan(-1);
  expect(end, 'no column-0 end marker after the first begin').toBeGreaterThan(start);
  const region = lines.slice(start, end + 1).join('\n');
  // A vacuity floor on the SLICE, not on the file: the generated half alone is
  // tens of kilobytes, so a whole-file floor is satisfied by a migration whose
  // hand-written half was dropped entirely.
  expect(region.length, 'the hand-written region looks too short to be real').toBeGreaterThan(5000);
  // The control that makes the slice safe: no COMMENT inside the region may
  // carry a `$$`, or the walks below would toggle on prose again.
  for (const line of region.split('\n')) {
    if (!line.trimStart().startsWith('--')) continue;
    expect(line.includes('$$'), `a comment in the statement region carries $$: ${line}`).toBe(false);
  }
  return region;
}

function checkNames(table: PgTable): readonly string[] {
  return getTableConfig(table).checks.map((entry) => entry.name);
}

function indexNames(table: PgTable): readonly string[] {
  return getTableConfig(table).indexes.map((entry) => entry.config.name);
}

/**
 * Flatten a drizzle `SQL` into readable text.
 *
 * `JSON.stringify` cannot be used: a chunk holding a column holds the table,
 * which holds the column, and the structure is circular. This walks the chunks
 * instead, taking the literal string fragments and each column's SQL name — so
 * an assertion about a predicate is an assertion about what will be EMITTED,
 * not about the object graph that emits it.
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
  // query time — so an assertion against `column.name` would be an assertion
  // about the editor rather than about the emitted DDL.
  if (typeof record['name'] === 'string' && record['table'] !== undefined) {
    return sqlColumnName(node as PgColumn);
  }
  if (Array.isArray(record['queryChunks'])) return renderSql(record['queryChunks']);
  return '';
}

describe('the five tables and their names', () => {
  it('exports exactly five tables, with the SQL names the migration will create', () => {
    // The floor and the ceiling. A sixth table arriving without a decision is as
    // much a problem as one going missing.
    expect(TABLES).toHaveLength(5);
    expect(TABLES.map((table) => getTableConfig(table).name)).toEqual([
      'catalog_external_mappings',
      'catalog_external_mapping_reviews',
      'catalog_external_token_observations',
      'catalog_external_mapping_runs',
      'catalog_external_mapping_run_items',
    ]);
  });

  it('adds NO jsonb column anywhere, so ADR 0007 D14’s register is unchanged', () => {
    for (const table of TABLES) {
      for (const column of getTableConfig(table).columns) {
        expect(
          column.getSQLType().toLowerCase().includes('json'),
          `${getTableConfig(table).name}.${column.name} is jsonb; D14 permits three uses and this is none of them`,
        ).toBe(false);
      }
    }
  });
});

describe('the one-to-many refusal is an INDEX, not a service comparison', () => {
  it('the live primary key is a partial unique whose predicate excludes a fan-out', () => {
    const config = getTableConfig(catalogExternalMappings);
    const live = config.indexes.find(
      (entry) => entry.config.name === 'catalog_external_mappings_live_primary_key',
    );
    expect(live, 'the live-primary-key index is missing').toBeDefined();
    expect(live?.config.unique).toBe(true);
    // The predicate is what makes it a fan-out gate rather than a flat "one
    // mapping per token": without `fan_out_approved_at is null` a reviewed
    // second target would be refused, and the review would be pointless.
    expect(live?.config.where).toBeDefined();
    const predicate = renderSql(live?.config.where);
    // A control on the renderer itself: an empty string would satisfy neither
    // assertion below by containing nothing, so the length floor is what stops
    // this passing on a predicate the walker failed to read.
    expect(predicate.length, 'the predicate rendered empty').toBeGreaterThan(20);
    expect(predicate).toContain('fan_out_approved_at');
    expect(predicate).toContain('valid_to');
    expect(predicate).toContain('approved');
  });

  it('a fan-out needs two operators, by CHECK', () => {
    const names = checkNames(catalogExternalMappings);
    expect(names).toContain('catalog_external_mappings_fan_out_triple_check');
    expect(names).toContain('catalog_external_mappings_fan_out_four_eyes_check');
  });

  it('every version of a decision about one token is unique', () => {
    expect(indexNames(catalogExternalMappings)).toContain(
      'catalog_external_mappings_version_key',
    );
  });
});

describe('the constraints each table owes', () => {
  it('the mapping carries its discriminated target shape and its governance CHECKs', () => {
    const names = new Set(checkNames(catalogExternalMappings));
    for (const required of [
      'catalog_external_mappings_target_shape_check',
      'catalog_external_mappings_confidence_range_check',
      'catalog_external_mappings_validity_order_check',
      'catalog_external_mappings_approval_pair_check',
      'catalog_external_mappings_approved_audited_check',
      'catalog_external_mappings_unapproved_clean_check',
      'catalog_external_mappings_rejection_check',
      'catalog_external_mappings_external_key_shape_check',
      // Provenance is confined to the one dimension it means anything for. A
      // unit mapping carrying a product-type version would leave a reader
      // deciding what that meant.
      'catalog_external_mappings_reviewed_definition_scope_check',
    ]) {
      expect(names, `${required} is missing`).toContain(required);
    }
  });

  it('the review queue holds one OPEN row per token and audits its own settlement', () => {
    expect(indexNames(catalogExternalMappingReviews)).toContain(
      'catalog_external_mapping_reviews_open_key',
    );
    const names = new Set(checkNames(catalogExternalMappingReviews));
    expect(names).toContain('catalog_external_mapping_reviews_resolution_check');
    expect(names).toContain('catalog_external_mapping_reviews_resolved_mapping_check');
    expect(names).toContain('catalog_external_mapping_reviews_candidates_check');
  });

  it('the observation states resolution as TWO biconditionals, not one conjunction', () => {
    // The single spelling — `(outcome = 'resolved') = (mapping is not null and
    // reason is null)` — is SATISFIED by an `unresolved` row carrying a mapping
    // id, because both sides evaluate false. #126 and #81 each hit it.
    const names = new Set(checkNames(catalogExternalTokenObservations));
    expect(names).toContain('catalog_external_token_observations_resolved_shape_check');
    expect(names).toContain('catalog_external_token_observations_unresolved_shape_check');
    expect(names).toContain('catalog_external_token_observations_claim_check');
  });

  it('a run’s counters SUM to `scanned` by equality — the vacuity floor', () => {
    const names = new Set(checkNames(catalogExternalMappingRuns));
    expect(names).toContain('catalog_external_mapping_runs_counters_total_check');
    expect(names).toContain('catalog_external_mapping_runs_counters_sign_check');
    expect(names).toContain('catalog_external_mapping_runs_finished_check');
    expect(names).toContain('catalog_external_mapping_runs_failure_check');
    expect(indexNames(catalogExternalMappingRuns)).toContain(
      'catalog_external_mapping_runs_active_key',
    );
  });

  it('a run item’s outcome word has to match its pointers', () => {
    expect(checkNames(catalogExternalMappingRunItems)).toContain(
      'catalog_external_mapping_run_items_outcome_shape_check',
    );
    // The idempotency and resumability key, in one index.
    expect(indexNames(catalogExternalMappingRunItems)).toContain(
      'catalog_external_mapping_run_items_subject_key',
    );
  });
});

describe('the normalized lookup key is GENERATED, on every table that holds a token', () => {
  it('all three token-bearing tables generate `external_key_normalized`', () => {
    for (const table of [
      catalogExternalMappings,
      catalogExternalMappingReviews,
      catalogExternalTokenObservations,
    ]) {
      const columns = getTableColumns(table);
      const generated = columns['externalKeyNormalized'];
      expect(
        generated,
        `${getTableConfig(table).name} has no externalKeyNormalized column`,
      ).toBeDefined();
      // Generated rather than written by the service: the stored spelling and
      // the lookup key cannot disagree, which is the
      // `attribute_value_aliases.normalized_alias` device.
      expect(generated?.generated, 'externalKeyNormalized is not generated').toBeDefined();
      expect(columns['externalKey'], 'the verbatim token column is missing').toBeDefined();
    }
  });
});

describe('the hand-written statements the migration carries', () => {
  it('lives in exactly one migration, and no later one re-declares a body', () => {
    // `handwrittenMigration()` already refuses anything but one file; this case
    // exists so the refusal is a NAMED failure rather than a confusing one
    // surfacing inside an assertion about column lists, and so the file it
    // resolved to is printed by a passing run.
    const migration = handwrittenMigration();
    expect(migration.name).toMatch(/^\d{4}_.+\.sql$/);

    // The self-test. Three green cases below are indistinguishable from a
    // locator that matches nothing, so prove the predicate can tell a
    // DEFINITION from a mention in both directions on text this test owns.
    const attachesOnly = [
      'CREATE TRIGGER mercaria_catalog_external_review_no_delete',
      'BEFORE DELETE ON catalog_external_mapping_reviews',
      'FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_no_delete();',
    ].join('\n');
    expect(
      DOMAIN_FUNCTION_DEFINITION.test(attachesOnly),
      'an attachment with no body must NOT read as a definition',
    ).toBe(false);
    expect(
      DOMAIN_FUNCTION_DEFINITION.test(
        'CREATE OR REPLACE FUNCTION mercaria_catalog_external_mapping_freeze()',
      ),
      'a re-declaration MUST read as a definition',
    ).toBe(true);
    // And that it is scoped to this domain: a sibling domain re-declaring its
    // own function must not make this gate report two copies of ours.
    expect(
      DOMAIN_FUNCTION_DEFINITION.test(
        'CREATE OR REPLACE FUNCTION mercaria_product_type_child_frozen()',
      ),
      "another domain's function must not match",
    ).toBe(false);
  });

  it('the hand-written region names every trigger and function, exactly once each', () => {
    // Regeneration DROPS every hand-written statement, so this region is the
    // list a rebase is checked against. Asserting the COUNT as well as the
    // presence is what catches a half-restored file.
    //
    // Over the REGION rather than the whole migration: the generated half above
    // it creates the same tables and indexes, so a whole-file census could be
    // satisfied by DDL that enforces none of this.
    const pending = statementRegion();

    const functions = [
      'mercaria_catalog_external_mapping_freeze',
      'mercaria_catalog_external_mapping_state',
      'mercaria_catalog_external_no_delete',
      'mercaria_catalog_external_review_subject_frozen',
      'mercaria_catalog_external_run_item_immutable',
    ];
    for (const name of functions) {
      // Case-insensitive: the DDL keywords are upper-cased to match the house
      // style in `0083`–`0088`, while the plpgsql bodies stay lower-case. A
      // case-sensitive census here would go red on a re-style rather than on a
      // missing trigger, which is the opposite of what it is for.
      expect(
        new RegExp(`create or replace function ${name}\\(\\)`, 'i').test(pending),
        `${name} has no function body`,
      ).toBe(true);
    }

    const triggers = [
      'mercaria_catalog_external_mapping_freeze',
      'mercaria_catalog_external_mapping_state',
      'mercaria_catalog_external_mapping_no_delete',
      'mercaria_catalog_external_review_no_delete',
      'mercaria_catalog_external_run_item_no_delete',
      'mercaria_catalog_external_review_subject_frozen',
      'mercaria_catalog_external_run_item_immutable',
    ];
    for (const name of triggers) {
      expect(
        new RegExp(`create trigger ${name}\\b`, 'i').test(pending),
        `${name} has no trigger`,
      ).toBe(true);
    }
    expect(pending.match(/^CREATE TRIGGER /gim) ?? []).toHaveLength(triggers.length);

    // The trap this domain exists to remember: a BEFORE UPDATE trigger must not
    // compare the STORED GENERATED column, which is NULL at that point. Over the
    // region, because the generated half legitimately names the column in its
    // CREATE TABLE and its indexes — only a `new.` prefix is a trigger body.
    expect(pending).not.toContain('new.external_key_normalized');
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
   * Generalized to take the trigger and the table, because the hole it closes is
   * not specific to one trigger: ANY trigger in this schema whose body
   * enumerates columns has a hand-maintained list with nothing measuring it, and
   * enforces whatever somebody last remembered to type while looking identical
   * either way.
   */
  function assertFreezePartition(input: {
    readonly functionName: string;
    readonly table: PgTable;
    readonly mutable: Readonly<Record<string, string>>;
    readonly minimumFrozen: number;
  }): void {
    const region = statementRegion();
    const from = region.indexOf(`${input.functionName}()`);
    const to = region.indexOf(`-- oxy:handwritten-end=${input.functionName}`);
    expect(from, `could not find ${input.functionName}`).toBeGreaterThan(-1);
    expect(to, `could not find the end marker for ${input.functionName}`).toBeGreaterThan(from);
    const body = region.slice(from, to);
    // A vacuity floor on the slice: an empty body would report every column
    // unclassified, which is loud, but a SHORT one could silently match a few.
    expect(body.length, `${input.functionName}'s body looks too short to be real`).toBeGreaterThan(400);

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
    expect(
      unclassified,
      `${input.functionName}: these columns are neither frozen by the trigger nor declared mutable`,
    ).toEqual([]);
    expect(
      frozen,
      `${input.functionName}: the freeze list matched no columns — did the slice work?`,
    ).toBeGreaterThanOrEqual(input.minimumFrozen);
    // A declaration naming a column the table does not have is a stale entry
    // that silently exempts nothing — the `ID_COLUMNS_WITHOUT_FOREIGN_KEY`
    // ledger's own failure mode.
    for (const declared of Object.keys(input.mutable)) {
      expect(columns[declared], `${input.functionName}: '${declared}' is not a column`).toBeDefined();
    }
  }

  it('the mapping freeze trigger names EVERY semantic column — a declared partition', () => {
    // Found by mutation-testing the file: deleting `target_category_id` from the
    // freeze list changed NOTHING. It also immediately caught two columns that
    // were wrong — `evidence_source_record_id` and `proposed_by_oxy_user_id`
    // were editable after approval, which means the record of a decision could
    // be repointed at something other than what was decided on.
    assertFreezePartition({
      functionName: 'mercaria_catalog_external_mapping_freeze',
      table: catalogExternalMappings,
      minimumFrozen: 16,
      mutable: {
        // The lifecycle. Everything a decision moves.
        state: 'the state machine trigger governs these moves',
        reviewedByOxyUserId: 'stamped when a reviewer acts',
        reviewedAt: 'stamped when a reviewer acts',
        approvedByOxyUserId: 'stamped on approval',
        approvedAt: 'stamped on approval',
        rejectedReason: 'stamped on rejection',
        fanOutApprovedByOxyUserId: 'the second operator signs later, by design',
        fanOutApprovedAt: 'the second operator signs later, by design',
        fanOutRationale: 'the second operator signs later, by design',
        validTo: 'NULL -> a value exactly once; the trigger refuses a second move',
        // Descriptive echoes of what the source published, which a re-crawl may
        // legitimately restate. None is read by resolution.
        externalLabel: "the source's own display text; not identity",
        externalPath: "the source's own path; not identity",
        externalLocale: "the locale of the source's label; not identity",
        evidenceNote: 'a free-text note for a reviewer',
        // Structural.
        id: 'the primary key',
        externalKeyNormalized:
          'GENERATED — NULL inside a BEFORE UPDATE trigger, so it cannot be compared',
        createdAt: 'row birthday',
        updatedAt: 'moves on every write by definition',
      },
    });
  });

  it('the review subject trigger names EVERY subject column — the same partition', () => {
    // The hole I left open after the mapping census: this trigger enumerates
    // columns too, so it has exactly the same unmeasured list. A subject column
    // added later and forgotten here is editable after a reviewer answered —
    // meaning `resolved_mapping_id` answers a question nobody can see any more.
    assertFreezePartition({
      functionName: 'mercaria_catalog_external_review_subject_frozen',
      table: catalogExternalMappingReviews,
      minimumFrozen: 6,
      mutable: {
        // The disposition — what settling a review moves.
        state: 'the trigger refuses only the reopen; the rest is the disposition',
        resolvedMappingId: 'stamped when the review is resolved',
        resolvedByOxyUserId: 'stamped when the review is settled',
        resolvedAt: 'stamped when the review is settled',
        // What a fresh sighting of the same token updates, in SQL, on the
        // upsert's conflict branch.
        occurrences: 'incremented by the upsert on every fresh sighting',
        lastObservedAt: 'moved to the later instant by the upsert',
        priority: 'raised by the upsert when a later sighting is more urgent',
        // Descriptive and derived.
        externalLabel: "the source's own display text; not the question",
        externalPath: "the source's own path; not the question",
        candidateMappingIds: 'the choice set a reviewer is shown; may grow',
        reason: 'a later sighting may reclassify why the token is unanswerable',
        summary: 'display copy for the queue, derived from `reason`',
        // Structural.
        id: 'the primary key',
        externalKeyNormalized:
          'GENERATED — NULL inside a BEFORE UPDATE trigger, so it cannot be compared',
        createdAt: 'row birthday',
        updatedAt: 'moves on every write by definition',
      },
    });
  });

  it('wraps every hand-written statement in a NAMED marker pair, with no name reused', () => {
    // The WHOLE migration here, not the region — deliberately. The region begins
    // at the first marker, so slicing to it makes "every statement is inside a
    // block" true by construction. Over the whole file the walk can still find a
    // hand-written statement sitting in the generated half with no block at all,
    // which is the shape a careless re-paste after a regeneration produces.
    const pending = handwrittenMigration().text;
    const begins = [...pending.matchAll(/^-- oxy:handwritten-begin=(.+)$/gm)].map((m) => m[1]);
    const ends = [...pending.matchAll(/^-- oxy:handwritten-end=(.+)$/gm)].map((m) => m[1]);

    // Five blocks, not seven: `mercaria_catalog_external_no_delete` is ONE
    // function mounted on THREE tables, so it is one block containing four
    // statements. Three blocks would have to share a name, and a repeated name
    // is what makes a marker stack unable to say which `end` closes which
    // `begin`.
    expect(begins).toHaveLength(5);
    expect(ends).toEqual(begins);
    expect(new Set(begins).size, 'a marker name is reused in the file').toBe(begins.length);

    // Every function and trigger sits INSIDE a block. A statement outside one is
    // exactly what the gate on the generated migration refuses.
    for (const line of pending.split('\n')) {
      if (!/^CREATE (OR REPLACE FUNCTION|TRIGGER|CONSTRAINT TRIGGER)/.test(line)) continue;
      const before = pending.slice(0, pending.indexOf(line));
      const openBegins = (before.match(/^-- oxy:handwritten-begin=/gm) ?? []).length;
      const openEnds = (before.match(/^-- oxy:handwritten-end=/gm) ?? []).length;
      expect(openBegins - openEnds, `unwrapped statement: ${line}`).toBe(1);
    }
  });

  it('separates statements with breakpoints, and never inside a dollar-quoted body', () => {
    // The walk runs over the STATEMENT REGION only — everything from the first
    // marker on. The file's header explains the `$$` rule in prose, and one of
    // those sentences carries a single `$$`; counting it toggles the scanner
    // into a body it is not in, and every assertion after that point is measured
    // against the wrong state. Slicing is safer than a comment filter, because a
    // filter has to keep breakpoint lines (which start with `--`) visible while
    // dropping prose, and that distinction is one edit from being wrong.
    const region = statementRegion();

    // The migrator splits on `--> statement-breakpoint`. Note what this does
    // NOT assert: an un-separated paste does not fail at apply — `sql.raw`
    // reaches postgres.js as `client.unsafe(query, [])`, and with no parameters
    // that is the SIMPLE protocol, which accepts multiple commands in one
    // string (measured: un-separated 1/1 green). The separators are robustness
    // — a failure names ONE statement rather than a block of twelve, and the
    // file stops leaning on a fallback a bound parameter would remove.
    expect(region).toContain('--> statement-breakpoint');

    let insideBody = false;
    let lineNumber = 0;
    let bodiesSeen = 0;
    for (const line of region.split('\n')) {
      lineNumber += 1;
      // THE half that is a real defect, and the only one this file is exposed
      // to: a separator inside a `$$ … $$` body is cut before anything is
      // parsed, so the function is halved and both halves fail — presenting as
      // a syntax error in our own SQL rather than as a separator problem. Every
      // function body here contains semicolons, so "one after every `;`" is
      // precisely the wrong heuristic.
      const toggles = (line.match(/\$\$/g) ?? []).length;
      // A line carrying a `$$` is the body's OPENER or its CLOSER, and neither
      // is "inside" it. Checking before the toggle flags `$$;--> statement-breakpoint`
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
    expect(bodiesSeen, 'no dollar-quoted bodies found — did the walk work?').toBe(5);
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

    // Twelve statements: five functions and seven triggers. Exactly one per
    // block is block-final — the last statement before its `end` marker, which
    // is itself followed by a breakpoint — and the other seven are separated
    // inline. Pinned rather than floored, because a walk that matched nothing
    // reads exactly like a file with nothing wrong.
    expect(blockFinal, 'expected one block-final statement per marker block').toBe(5);
    expect(separated + blockFinal, 'expected 5 functions + 7 triggers').toBe(12);
  });
});
