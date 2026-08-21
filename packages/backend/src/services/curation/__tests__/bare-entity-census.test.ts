/**
 * THE BARE-REFERENCE CENSUS — the third door into #59 merge invariant 2 (#695).
 *
 * `merge-plan-census.test.ts` derives from drizzle FOREIGN KEYS.
 * `polymorphic-entity-census.test.ts` derives from drizzle `enumValues`. A
 * column that is a mergeable entity id by convention alone is in neither
 * population, so neither gate can fire for it — and the miss is silent in the
 * way both of those files exist to prevent.
 *
 * ## The population is DERIVED, through an existing gate
 *
 * `MERCARIA_ROW_ID_REASONS` names the six `ID_COLUMNS_WITHOUT_FOREIGN_KEY`
 * reasons that describe a row in THIS database. That ledger's completeness over
 * `_id`-shaped columns is already enforced by `findIdColumnViolations`
 * (`db/__tests__/schema-conventions.test.ts`), so the chain is:
 *
 *   a new bare `*_id` column  ⇒  a ledger entry is owed (existing gate)
 *   a ledger entry under one of the six  ⇒  a merge disposition is owed (here)
 *
 * which puts the decision on the person adding the reference, at the moment
 * they add it. The five reasons naming a FOREIGN key space (`OXY_ACCOUNT`,
 * `OXY_FILE`, `EXTERNAL_PLATFORM`, `PROVIDER_OBJECT`, `SUPPLIER_PLATFORM`) are
 * excluded structurally rather than by judgement: no merge in this database can
 * act on another system's primary key.
 *
 * ## What this gate CANNOT do, stated because a reader would otherwise assume it
 *
 * Four of the five doors #695 measured have no derivation at all, and pretending
 * otherwise is worse than saying so:
 *
 *  - a discriminator whose tuple spells the same entity differently
 *    (`entity_kind: ['product', 'variant']`);
 *  - a column whose name does not end in `_id`, which the ledger never demands;
 *  - a `text[]` of entity ids, which can carry no foreign key at all;
 *  - an `_id` column ledgered under a BESPOKE reason rather than one of the six
 *    shared constants. 118 of the ledger's 527 entries are written that way,
 *    which makes this the largest of the four and the easiest to overlook,
 *    because such a column looks fully classified from the ledger's own side.
 *
 * Their fifteen entries are DECLARED in `BARE_ENTITY_REFERENCES` and pinned BY NAME
 * below, so the reading already done cannot be dropped. A new sibling of any of
 * them will not fail this build. That residual is #695's own finding — the
 * issue's three candidate third derivations were all measured and rejected —
 * and it belongs in the issue rather than in a gate that cannot fire.
 *
 * Every defence `~/Oxy/AGENTS.md` prescribes is here: vacuity floors on the
 * schema, the ledger and the derived set; a POSITIVE CONTROL that the
 * derivation finds #695's own named column; reconciliation in BOTH directions;
 * a structural proof that each declared column really is invisible to the other
 * two censuses; and a MUTATION SELF-TEST per detector.
 */

import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { MERGEABLE_ENTITY_TYPES } from '@mercaria/shared-types';
import * as schema from '../../../db/schema/index.js';
import {
  ID_COLUMNS_WITHOUT_FOREIGN_KEY,
  MERCARIA_ROW_ID_REASONS,
} from '../../../db/deferredForeignKeys.js';
import {
  BARE_ENTITY_REFERENCES,
  BARE_REFERENCES_NO_DERIVATION_REACHES,
  POLYMORPHIC_ENTITY_REFERENCES,
  type BareEntityReference,
} from '../merge-plan.js';

/** Every drizzle table the barrel exports — the set drizzle-kit emits DDL for. */
const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

/** `table.column` for every column in the schema, by its SQL names. */
const allColumns = new Set<string>();
/** `table.column` for every column that already carries a real foreign key. */
const foreignKeyed = new Set<string>();
/** `table.column` for every PRIMARY KEY column. */
const primaryKeys = new Set<string>();

for (const table of tables) {
  const config = getTableConfig(table);
  for (const column of config.columns) {
    const key = `${config.name}.${sqlColumnName(column)}`;
    allColumns.add(key);
    if (column.primary) primaryKeys.add(key);
  }
  for (const foreignKey of config.foreignKeys) {
    const reference = foreignKey.reference();
    for (const column of reference.columns) {
      foreignKeyed.add(`${config.name}.${sqlColumnName(column)}`);
    }
  }
}

/**
 * The derived population: ledger entries whose reason names a Mercaria row.
 *
 * Reason STRINGS rather than a per-entry flag, because that is how the ledger
 * already classifies itself — 409 of its entries share twelve constants — and a
 * classification derived from what is written beats a second field somebody has
 * to remember to set.
 */
const mercariaRowReasons = new Set(MERCARIA_ROW_ID_REASONS);
const derived = ID_COLUMNS_WITHOUT_FOREIGN_KEY.filter((entry) =>
  mercariaRowReasons.has(entry.reason),
).map((entry) => entry.column);

/**
 * The entries covering the four doors no derivation reaches.
 *
 * MOVED to `merge-plan.ts` by #720, because a second census now reads it:
 * `polymorphic-entity-census.test.ts` uses it to check that a
 * `covered_by_bare_entity_census` disposition cites a column this file really
 * re-checks. Two copies could disagree, and the direction they would disagree
 * in is a hand-off pointing at coverage that no longer exists.
 */
const UNDERIVABLE = BARE_REFERENCES_NO_DERIVATION_REACHES;

/** The comparison both directions run against. */
function reconcile(
  population: readonly string[],
  declared: readonly BareEntityReference[],
): { readonly undeclared: string[]; readonly stale: string[] } {
  const declaredColumns = new Set(declared.map((entry) => entry.column));
  const inPopulation = new Set(population);
  const undeclarable = new Set<string>(UNDERIVABLE);
  return {
    undeclared: population.filter((column) => !declaredColumns.has(column)).sort(),
    // An entry outside the derived population is only legitimate when it is one
    // of the `UNDERIVABLE` columns the docblock accounts for; anything else is a
    // declaration this gate can never re-check, which is the exemption that
    // cannot fire.
    stale: declared
      .map((entry) => entry.column)
      .filter((column) => !inPopulation.has(column) && !undeclarable.has(column))
      .sort(),
  };
}

const MERGEABLE = new Set<string>(MERGEABLE_ENTITY_TYPES as readonly string[]);

describe('every bare reference to a mergeable entity has a decision (#695)', () => {
  it('is not vacuous: the schema, the ledger and the derived set are all large', () => {
    // The schema floor catches a broken barrel import. The ledger floor catches
    // a renamed export resolving to an empty array, which would make the
    // derived set empty and BOTH reconciliation directions pass against
    // nothing. The derived floor catches a traversal that matched no reason at
    // all.
    //
    // What NONE of them catches, measured rather than assumed: REWORDING a
    // reason constant. `MERCARIA_ROW_ID_REASONS` and the ledger entries read
    // the same binding, so an edit moves both sides together and every check
    // here stays green — two derived representations of one fact cannot
    // disagree. That is fine, because a rewording changes no membership; the
    // failure that would matter is an entry LEAVING a constant, and the `stale`
    // direction below catches that (also measured: one entry moved to an inline
    // string turns this file red and names the column).
    expect(tables.length).toBeGreaterThanOrEqual(170);
    expect(ID_COLUMNS_WITHOUT_FOREIGN_KEY.length).toBeGreaterThanOrEqual(400);
    expect(derived.length).toBeGreaterThanOrEqual(50);
  });

  it('finds a column under each of the six reasons — the derivation is not one constant', () => {
    // Without this, five of the six could fall out of USE entirely — every
    // entry under them moved to an inline string — and the floor above would
    // still pass on `COMMERCE_SNAPSHOT` alone, leaving a listed reason that
    // derives nothing. Measured: moving all twelve `ANALYTICS_CORRELATION`
    // entries off the constant turns this file red here and in both
    // reconciliation directions.
    for (const reason of MERCARIA_ROW_ID_REASONS) {
      const covered = ID_COLUMNS_WITHOUT_FOREIGN_KEY.filter((entry) => entry.reason === reason);
      expect(covered.length, `no ledger entry carries this reason any more: ${reason}`)
        .toBeGreaterThan(0);
    }
  });

  it('finds the column #695 named — the positive control', () => {
    // The known answer. A derivation that missed it would agree with a register
    // that also missed it, and the pair would look correct.
    expect(derived).toContain('catalog_authoring_drafts.selected_canonical_product_id');
  });

  it('declares every derived column, and declares nothing it cannot re-check', () => {
    const { undeclared, stale } = reconcile(derived, BARE_ENTITY_REFERENCES);

    expect(
      undeclared,
      'these columns are ledgered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` under a reason that names ' +
        'a row in THIS database, and `BARE_ENTITY_REFERENCES` does not say what a merge does ' +
        'with them. Add an entry to `merge-plan.ts`: `not_a_mergeable_entity` if the target is ' +
        'not one of the seven, `covered_by_polymorphic_census` if the table is declared there, ' +
        'or `untouched`/`rehomed`/`unresolved` with `targetEntities` named.',
    ).toEqual([]);

    expect(
      stale,
      'these entries are declared and are outside the derived population, so nothing can ever ' +
        're-check them. Three things produce it: the ledger entry they mirror was REMOVED (delete ' +
        'this one too); it DRIFTED off its shared reason constant onto an inline string (put it ' +
        'back on the constant, or add the new reason to `MERCARIA_ROW_ID_REASONS`); or a new ' +
        'underivable door was added, which belongs in `UNDERIVABLE` beside a docblock saying why ' +
        'no derivation reaches it.',
    ).toEqual([]);
  });

  it('pins the six entries no derivation reaches, so the reading already done cannot be dropped', () => {
    // These are exactly the columns the add-direction gate CANNOT protect. If
    // this file only checked the derived population, deleting any of them would
    // be green — which is the shape of the gap #695 filed.
    // The floor first: emptying `UNDERIVABLE` would satisfy the loop below
    // vacuously and delete this file's only hold on four of the five doors.
    expect(UNDERIVABLE.length).toBeGreaterThanOrEqual(15);

    const declared = new Set(BARE_ENTITY_REFERENCES.map((entry) => entry.column));
    for (const column of UNDERIVABLE) {
      expect(declared.has(column), `${column} lost its entry and no derivation would notice`).toBe(
        true,
      );
    }
  });

  it('names a real table and a real column in every entry', () => {
    // The ledger is keyed by SQL names. Get either wrong and the entry protects
    // NOTHING — an unmatched key is not an error, it is a column with no entry.
    const missing = BARE_ENTITY_REFERENCES.map((entry) => entry.column).filter(
      (column) => !allColumns.has(column),
    );
    expect(missing).toEqual([]);
  });

  it('declares only columns that really are invisible to the other two censuses', () => {
    // The structural proof, and the one that stops this register drifting into
    // a place to record any column at all. A foreign-keyed column belongs to
    // `merge-plan-census.test.ts`, and a primary key is the entity itself.
    const constrained = BARE_ENTITY_REFERENCES.map((entry) => entry.column).filter(
      (column) => foreignKeyed.has(column) || primaryKeys.has(column),
    );
    expect(
      constrained,
      'these carry a real foreign key or are a primary key, so the FK census already forces a ' +
        'decision on them. An entry here would be a second answer to a question that is already ' +
        'answered, and two answers can disagree.',
    ).toEqual([]);
  });

  it('hands a column to the polymorphic census only when that census really owns its table', () => {
    const polymorphicTables = new Set(POLYMORPHIC_ENTITY_REFERENCES.map((entry) => entry.table));
    const wrong = BARE_ENTITY_REFERENCES.filter(
      (entry) =>
        entry.disposition === 'covered_by_polymorphic_census' &&
        !polymorphicTables.has(entry.column.split('.')[0] ?? ''),
    ).map((entry) => entry.column);

    // A hand-off to a census that does not cover the table is an entry claiming
    // somebody else decided. Nobody did, and both files would read as complete.
    expect(wrong).toEqual([]);
  });

  it('gives every `rehomed` entry a statement, and names the same column twice over', () => {
    // `rehomed` without a `rehome` payload is the defect this register exists to
    // catch, wearing the register's own vocabulary: `bareArrayRehomesFor` derives
    // the runner's work from these entries, so an entry with no payload declares
    // a move that nothing performs — which is exactly what
    // `shopping_agents.excluded_merchant_ids`'s schema comment did for as long
    // as it existed.
    const claimedWithoutStatement = BARE_ENTITY_REFERENCES.filter(
      (entry) => entry.disposition === 'rehomed' && entry.rehome === undefined,
    ).map((entry) => entry.column);
    expect(claimedWithoutStatement).toEqual([]);

    const payloadOnANonRehome = BARE_ENTITY_REFERENCES.filter(
      (entry) => entry.disposition !== 'rehomed' && entry.rehome !== undefined,
    ).map((entry) => entry.column);
    expect(payloadOnANonRehome).toEqual([]);

    // And the string and the drizzle column must name ONE column. They are two
    // representations of one fact and can drift; the string is what the census
    // reconciles against the schema, the column is what the UPDATE writes, so a
    // disagreement moves a different column than the register says.
    const disagreeing = BARE_ENTITY_REFERENCES.filter((entry) => entry.rehome).map((entry) => {
      const rehome = entry.rehome as NonNullable<BareEntityReference['rehome']>;
      const actual = `${getTableName(rehome.column.table)}.${sqlColumnName(rehome.column)}`;
      return actual === entry.column ? null : `${entry.column} declares ${actual}`;
    });
    expect(disagreeing.filter((entry) => entry !== null)).toEqual([]);

    // A floor: this whole case is vacuous the day nothing is `rehomed`, and it
    // would go vacuous silently — every assertion above passes over an empty
    // set. #716 is the first entry; a later change that removes the last one has
    // to come here and say so.
    expect(
      BARE_ENTITY_REFERENCES.filter((entry) => entry.disposition === 'rehomed').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('names the target entities exactly when the disposition is about a mergeable one', () => {
    const wrong = BARE_ENTITY_REFERENCES.filter((entry) => {
      const needsTargets =
        entry.disposition === 'untouched' ||
        entry.disposition === 'rehomed' ||
        entry.disposition === 'unresolved';
      const hasTargets = (entry.targetEntities?.length ?? 0) > 0;
      return needsTargets !== hasTargets;
    }).map((entry) => `${entry.column} (${entry.disposition})`);

    // An entry claiming a merge leaves a reference alone has to say WHICH
    // entity, or it is a sentence rather than a decision; and one claiming the
    // target is not mergeable must not name any, or the two stop meaning
    // different things.
    expect(wrong).toEqual([]);
  });

  it('names only real mergeable entity types', () => {
    const wrong = BARE_ENTITY_REFERENCES.flatMap((entry) =>
      (entry.targetEntities ?? [])
        .filter((target) => !MERGEABLE.has(target))
        .map((target) => `${entry.column} -> ${target}`),
    );
    expect(wrong).toEqual([]);
  });

  it('gives every entry a real reason', () => {
    const thin = BARE_ENTITY_REFERENCES.filter((entry) => entry.reason.trim().length < 40).map(
      (entry) => entry.column,
    );
    expect(thin).toEqual([]);
  });

  it('declares each column exactly once', () => {
    const columns = BARE_ENTITY_REFERENCES.map((entry) => entry.column);
    expect(columns.length).toBe(new Set(columns).size);
  });

  describe('the self-tests — each detector is shown to fail', () => {
    it('refuses a NEW ledger entry under a Mercaria-row reason BY NAME', () => {
      // The mutation the whole file exists for: somebody adds a bare
      // `canonical_product_id`, ledgers it as a snapshot, and never says what a
      // merge does with it. It runs against the real derivation over the real
      // ledger plus one planted entry.
      const planted = 'mercaria_planted_table.canonical_product_id';
      const withPlanted = [...derived, planted];

      const { undeclared, stale } = reconcile(withPlanted, BARE_ENTITY_REFERENCES);
      expect(undeclared).toEqual([planted]);
      expect(stale).toEqual([]);
    });

    it('refuses a STALE declaration BY NAME', () => {
      const withGhost: BareEntityReference[] = [
        ...BARE_ENTITY_REFERENCES,
        {
          column: 'mercaria_table_that_no_longer_exists.merchant_id',
          disposition: 'not_a_mergeable_entity',
          reason: 'a declaration outside the derived population, planted by this test',
        },
      ];
      const { undeclared, stale } = reconcile(derived, withGhost);
      expect(stale).toEqual(['mercaria_table_that_no_longer_exists.merchant_id']);
      expect(undeclared).toEqual([]);
    });

    it('would NOT derive a ledger entry under a foreign-key-space reason — the negative control', () => {
      // Without this, "the derivation found my planted entry" would also be
      // satisfied by a derivation that returns the whole ledger. An Oxy account
      // id must stay OUT: no merge in this database can act on one.
      const oxyAccount = ID_COLUMNS_WITHOUT_FOREIGN_KEY.find((entry) =>
        entry.reason.startsWith('An Oxy account id.'),
      );
      expect(oxyAccount).toBeDefined();
      expect(derived).not.toContain(oxyAccount?.column);
      expect(derived.length).toBeLessThan(ID_COLUMNS_WITHOUT_FOREIGN_KEY.length);
    });

    it('refuses an entry that names no target while claiming a merge decision', () => {
      const withUntargeted: BareEntityReference[] = [
        {
          column: 'analytics_events.canonical_product_id',
          disposition: 'untouched',
          reason: 'an entry claiming a decision without saying about which entity',
        },
      ];
      const wrong = withUntargeted.filter(
        (entry) => (entry.targetEntities?.length ?? 0) === 0 && entry.disposition === 'untouched',
      );
      expect(wrong).toHaveLength(1);
    });

    it('refuses a hand-off to the polymorphic census for a table it does not cover', () => {
      const polymorphicTables = new Set(POLYMORPHIC_ENTITY_REFERENCES.map((entry) => entry.table));
      // A PLANTED name rather than a real table. This fixture used
      // `analytics_events` until #720 widened the polymorphic census from 39
      // tables to 130 and declared it — at which point the premise silently
      // became false and this detector was measuring nothing. A synthetic name
      // cannot be adopted by that register, so the guard stays true however far
      // the population grows.
      expect(polymorphicTables.has('mercaria_table_no_census_covers')).toBe(false);
      const withBadHandoff: BareEntityReference[] = [
        {
          column: 'mercaria_table_no_census_covers.merchant_id',
          disposition: 'covered_by_polymorphic_census',
          reason: 'a hand-off to a census that does not cover this table, planted by this test',
        },
      ];
      const wrong = withBadHandoff.filter(
        (entry) =>
          entry.disposition === 'covered_by_polymorphic_census' &&
          !polymorphicTables.has(entry.column.split('.')[0] ?? ''),
      );
      expect(wrong).toHaveLength(1);
    });
  });
});
