/**
 * The schema gates for catalog proposals (#367 step 6, ADR 0007 D9).
 *
 * Three kinds of check, and the third is the one that keeps working after
 * everybody who wrote this has moved on:
 *
 * 1. The VOCABULARY censuses — the mintable and link-only tuples are disjoint
 *    and their union is exactly `CATALOG_PROPOSAL_TYPES`, and the forbidden
 *    submitter fields are disjoint from the permitted ones.
 * 2. The `.pending.sql` gate — every trigger this domain claims exists in the
 *    staging file, the count is EXACT, and the generated column is not compared
 *    inside a `BEFORE UPDATE` body.
 * 3. The DECLARED PARTITION censuses — every column of the two tables a trigger
 *    enumerates is either named in that trigger or declared MUTABLE with a
 *    reason, and the union is exactly the table's real column set. A
 *    hand-maintained column list beside a real table has nothing measuring the
 *    two, and it enforces whatever somebody last remembered to type while looking
 *    identical either way.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import {
  CATALOG_PROPOSAL_BLOCKING_DETECTORS,
  CATALOG_PROPOSAL_DUPLICATE_DETECTORS,
  CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS,
  CATALOG_PROPOSAL_LINK_ONLY_TYPES,
  CATALOG_PROPOSAL_MINTABLE_TYPES,
  CATALOG_PROPOSAL_OPEN_STATES,
  CATALOG_PROPOSAL_RESOLVED_STATES,
  CATALOG_PROPOSAL_STATES,
  CATALOG_PROPOSAL_SUBMITTER_FIELDS,
  CATALOG_PROPOSAL_TYPES,
} from '@mercaria/shared-types';
import {
  catalogProposalReferences,
  catalogProposals,
} from '../../../db/schema/catalogProposals.js';

/**
 * The MIGRATION, not a staging file.
 *
 * `db/schema/catalogProposals.pending.sql` held these statements while ADR 0007
 * D11 serialised `db:generate` across the parallel #367 branches; it was deleted
 * in the commit that took the slot, under CONVENTIONS' two-copies rule — a second
 * copy that nothing applies is one somebody edits to no effect.
 *
 * So this gate reads the file that actually SHIPS. That is strictly stronger:
 * the staging file could have been correct while the paste dropped a function,
 * and the whole failure mode here is a migration that applies cleanly and
 * enforces nothing.
 */
const MIGRATION_SQL = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'drizzle',
  '0100_same_iron_man.sql',
);

function pendingSql(): string {
  return readFileSync(MIGRATION_SQL, 'utf8');
}

/**
 * The statement REGION — everything from the first begin marker on.
 *
 * Anchored at column 0, never a substring search: the file's header explains the
 * marker convention and mentions both markers in prose, and an unanchored slice
 * would drag the header in and compare against text that is not SQL.
 */
function statementRegion(): string {
  const source = pendingSql();
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('-- oxy:handwritten-begin='));
  expect(start, 'no column-0 begin marker in the migration').toBeGreaterThan(-1);
  return lines.slice(start).join('\n');
}

describe('catalog proposal vocabularies', () => {
  it('mintable and link-only types are DISJOINT and cover every type exactly', () => {
    const mintable = new Set<string>(CATALOG_PROPOSAL_MINTABLE_TYPES);
    const linkOnly = new Set<string>(Object.keys(CATALOG_PROPOSAL_LINK_ONLY_TYPES));

    // Disjoint. A type in both would mean "this may be minted AND must be
    // linked", and whichever branch ran first would decide.
    for (const type of mintable) {
      expect(linkOnly.has(type), `${type} is both mintable and link-only`).toBe(false);
    }
    // …and their union is EXACTLY the type tuple, so a proposal type added later
    // fails this test until somebody decides whether an approval may mint it.
    // Without the equality, a new type would silently be neither — which the
    // service reads as "not mintable" and which is the SAFE direction, but a
    // safe default nobody chose is exactly the decision this census exists to
    // force.
    expect([...mintable, ...linkOnly].sort()).toEqual([...CATALOG_PROPOSAL_TYPES].sort());

    // Every link-only entry NAMES the surface that owns creating one. An empty
    // reason turns the refusal into "you cannot do that here" with nowhere to go.
    for (const [type, owner] of Object.entries(CATALOG_PROPOSAL_LINK_ONLY_TYPES)) {
      expect(owner.trim().length, `${type} names no owning surface`).toBeGreaterThan(20);
    }
  });

  it('exactly one type may be minted, and it is the controlled value', () => {
    // A vacuity floor on the census above: `mintable` being EMPTY would satisfy
    // disjointness and would make the union check fail loudly — but a future
    // widening to three or four would satisfy both while quietly making this
    // domain a writer of the canonical graph.
    expect(CATALOG_PROPOSAL_MINTABLE_TYPES).toEqual(['controlled_value']);
  });

  it('the forbidden submitter fields are disjoint from the permitted ones', () => {
    const permitted = new Set<string>(CATALOG_PROPOSAL_SUBMITTER_FIELDS);
    for (const field of CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS) {
      expect(permitted.has(field), `${field} is both permitted and forbidden`).toBe(false);
    }
    // The four that carry the whole rule, named explicitly so a refactor that
    // dropped one fails here rather than in production.
    for (const field of ['key', 'slug', 'resolvedEntityId', 'attributeDefinitionVersion']) {
      expect(CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS).toContain(field);
    }
  });

  it('no submitter-facing field is named `key` or `slug` in either direction', () => {
    // The structural half: a submission has NO field that could carry identity
    // (ADR 0007 D1). Asserted over the permitted list rather than over the type,
    // because a type is erased at runtime and this list is what the schema and
    // the middleware are written against.
    expect(CATALOG_PROPOSAL_SUBMITTER_FIELDS).not.toContain('key');
    expect(CATALOG_PROPOSAL_SUBMITTER_FIELDS).not.toContain('slug');
  });

  it('open and resolved states partition sensibly and neither is empty', () => {
    const open = new Set<string>(CATALOG_PROPOSAL_OPEN_STATES);
    const resolved = new Set<string>(CATALOG_PROPOSAL_RESOLVED_STATES);
    expect(open.size).toBeGreaterThan(0);
    expect(resolved.size).toBeGreaterThan(0);
    for (const state of resolved) {
      expect(open.has(state), `${state} is both open and resolved`).toBe(false);
    }
    for (const state of [...open, ...resolved]) {
      expect(CATALOG_PROPOSAL_STATES).toContain(state);
    }
    // `deferred` is OPEN, which is the one a reader gets wrong: an operator
    // saying "not now" has not decided, and a draft waiting on a deferred
    // proposal is still waiting on an unanswered question.
    expect(CATALOG_PROPOSAL_OPEN_STATES).toContain('deferred');
  });

  it('only the two FACT detectors may refuse a submission', () => {
    for (const detector of CATALOG_PROPOSAL_BLOCKING_DETECTORS) {
      expect(CATALOG_PROPOSAL_DUPLICATE_DETECTORS).toContain(detector);
    }
    // A SCORE must never refuse a submission: a merchant with a legitimately
    // similar name would be told their concept already exists, with no remedy.
    expect(CATALOG_PROPOSAL_BLOCKING_DETECTORS).not.toContain('trigram_similarity');
  });
});

describe('the staging SQL carries every trigger this domain claims', () => {
  const functions = [
    'mercaria_catalog_proposal_freeze',
    'mercaria_catalog_proposal_state',
    'mercaria_catalog_review_event_append_only',
    'mercaria_catalog_proposal_candidate_immutable',
    'mercaria_catalog_proposal_reference_backfill_once',
  ];

  it('names every function and every trigger, and no sixth', () => {
    const source = pendingSql();
    for (const name of functions) {
      expect(
        new RegExp(`create or replace function ${name}\\(\\)`, 'i').test(source),
        `${name} has no function body`,
      ).toBe(true);
      expect(new RegExp(`create trigger ${name}\\b`, 'i').test(source), `${name} has no trigger`).toBe(
        true,
      );
    }
    // EXACT, not containment. A list that only ever grows would let a trigger be
    // added with nothing saying what it enforces — and the count is what makes
    // the paste self-checkable against the header's own `grep -c`.
    expect(source.match(/^CREATE TRIGGER /gim) ?? []).toHaveLength(functions.length);
    expect(source.match(/^-- oxy:handwritten-begin=/gm) ?? []).toHaveLength(functions.length);
    expect(source.match(/^-- oxy:handwritten-end=/gm) ?? []).toHaveLength(functions.length);
    // EXACTLY ONE deploy-phase marker, and it is `pre`: every statement in this
    // migration is additive and the previous image never reads these tables.
    // `db:migrate` refuses an unmarked file before any DDL runs, and a SECOND
    // marker is the failure an unanchored paste produces — it drags the staging
    // header in, which carries one of its own.
    expect(source.match(/^-- oxy:deploy-phase=/gm) ?? []).toHaveLength(1);
    expect(source).toContain('-- oxy:deploy-phase=pre');
    // And the drizzle half is still there: a gate that only counted triggers
    // would pass on a file whose CREATE TABLEs had been lost.
    expect(source.match(/^CREATE TABLE /gm) ?? []).toHaveLength(4);
  });

  it('never compares the STORED GENERATED column inside a BEFORE UPDATE body', () => {
    // The trap the file exists to remember: a stored generated column is computed
    // AFTER a `BEFORE UPDATE` trigger runs, so `NEW.convergence_key` is NULL
    // inside one of these functions and any comparison against it raises on every
    // update. Cost a real bug in #59 and again in Workstream 11.
    expect(statementRegion()).not.toContain('new.convergence_key');
    // …and the five RAW components the generation reads ARE compared, so the
    // freeze is not merely avoiding the generated column but covering what it is
    // derived from.
    const region = statementRegion();
    for (const column of [
      'new.type',
      'new.attribute_definition_id',
      'new.category_id',
      'new.product_type_definition_id',
      'new.normalized_label',
    ]) {
      expect(region, `${column} is not frozen`).toContain(column);
    }
  });

  it('puts no statement separator inside a dollar-quoted body', () => {
    // A separator inside a `$$ … $$` body is cut before anything is parsed, so
    // the function is halved and both halves fail.
    //
    // The walk is CHARACTER-wise and not line-wise, and that is the correction
    // this test needed on its first run: `$$;--> statement-breakpoint` is one
    // line carrying the CLOSING delimiter and then the separator, so a line-wise
    // check that reads the state at the start of the line reports the correct
    // file as broken. The state has to be evaluated at the separator's own
    // OFFSET.
    //
    // Comment lines are skipped OUTSIDE a body, because this file's header
    // mentions `$$` in prose and would otherwise flip the state and make every
    // later comment read as body text — the trap Workstream 11's own gate hit
    // twice while being written.
    const region = statementRegion();
    const bodyAt = new Array<boolean>(region.length).fill(false);
    let inBody = false;
    let offset = 0;
    for (const line of region.split('\n')) {
      const isComment = line.trimStart().startsWith('--');
      for (let i = 0; i < line.length; i += 1) {
        bodyAt[offset + i] = inBody;
        if (!inBody && isComment) continue;
        if (line.startsWith('$$', i)) {
          inBody = !inBody;
          bodyAt[offset + i] = false;
          bodyAt[offset + i + 1] = false;
          i += 1;
        }
      }
      offset += line.length + 1;
    }
    expect(inBody, 'the migration leaves a dollar-quoted body open').toBe(false);

    const separators = [...region.matchAll(/--> statement-breakpoint/g)];
    // A vacuity floor: a region with no separators at all would pass the loop
    // below by measuring nothing.
    expect(separators.length, 'no statement separators found — did the slice work?').toBeGreaterThan(
      3,
    );
    for (const match of separators) {
      expect(
        bodyAt[match.index],
        `a statement separator sits inside a $$ body at offset ${match.index}`,
      ).toBe(false);
    }
  });
});

/**
 * Assert a freeze trigger's hand-written column list against the REAL table.
 *
 * The `merge-plan.ts` device, taken from `external-mapping-schema.test.ts`. Every
 * column is declared FROZEN (named in the trigger) or MUTABLE with a reason, and
 * the union must be EXACTLY the table's column set — so a column added later
 * fails the build until somebody decides which it is. Finding fewer columns and
 * there BEING fewer look identical without it.
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
  // A vacuity floor on the SLICE: an empty body would report every column
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
  // A declaration naming a column the table does not have is a stale entry that
  // silently exempts nothing — the `ID_COLUMNS_WITHOUT_FOREIGN_KEY` failure mode.
  for (const declared of Object.keys(input.mutable)) {
    expect(columns[declared], `${input.functionName}: '${declared}' is not a column`).toBeDefined();
  }
}

describe('the column-enumerating triggers are DECLARED PARTITIONS', () => {
  it('the proposal freeze names every column of the request', () => {
    assertFreezePartition({
      functionName: 'mercaria_catalog_proposal_freeze',
      table: catalogProposals,
      minimumFrozen: 16,
      mutable: {
        // The disposition — everything a decision moves, each guarded further by
        // `mercaria_catalog_proposal_state` and by the row's own CHECKs.
        state: 'the state machine trigger governs these moves',
        decidedByOxyUserId: 'stamped when an operator decides',
        decidedAt: 'stamped when an operator decides',
        decisionReason: 'stamped when an operator decides',
        rejectionReason: 'stamped on rejection',
        resolvedEntityId: 'stamped on approval or merge; the resolution CHECK ties it to the state',
        redirectedToProposalId: 'stamped on a redirect; the redirect CHECK ties it to the state',
        deferredUntil: 'set on a deferral and cleared on the way out, per the deferred CHECK',
        // Structural.
        id: 'the primary key',
        convergenceKey:
          'GENERATED — NULL inside a BEFORE UPDATE trigger, so it cannot be compared; ' +
          'its five raw components are frozen instead',
        createdAt: 'row birthday',
        updatedAt: 'moves on every write by definition',
      },
    });
  });

  it('the reference trigger names every column a backfill must not move', () => {
    assertFreezePartition({
      functionName: 'mercaria_catalog_proposal_reference_backfill_once',
      table: catalogProposalReferences,
      minimumFrozen: 5,
      mutable: {
        backfilledAt: 'NULL -> a value exactly once; the trigger refuses a second move',
        id: 'the primary key',
        createdAt: 'row birthday',
      },
    });
  });
});
