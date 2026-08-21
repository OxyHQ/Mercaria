/**
 * THE POLYMORPHIC CENSUS — the half of #59 merge invariant 2 that has no
 * foreign key to walk (#654), with the derivation a SYNONYM used to defeat
 * entirely (#720).
 *
 * `merge-plan-census.test.ts` derives its population from drizzle FOREIGN KEYS
 * and asserts the rehoming plan covers exactly that set. A polymorphic
 * reference — an id column whose target TABLE is decided by a sibling
 * discriminator — carries no foreign key, because there is nothing for one to
 * point at. So that census cannot see it, and neither can its gate: for a
 * polymorphic reference the "a new table fails the build until somebody
 * decides" property CANNOT FIRE. That is the blind spot, and it is the same
 * silent miss the FK census exists to prevent, arriving through the one door it
 * does not watch.
 *
 * ## Why the population is derived TWICE
 *
 * The original derivation asked whether a column's drizzle `enumValues` shares
 * a value with `MERGEABLE_ENTITY_TYPES`. That is a test of VOCABULARY, not of
 * meaning, and #720 measured what it costs: `attribute_value_reviews` and
 * `attribute_reindex_requests` are polymorphic over a canonical product or
 * variant and spell it `['product', 'variant']`. Zero set intersection, tables
 * absent from the population, gate cannot fire. Two teams naming one entity
 * differently is the normal case rather than an edge case, so the miss was a
 * DEFAULT outcome — and, unlike a bare column, nothing about such a table looks
 * unfinished. It carries a real `text({ enum: … })` with a real `checkOneOf`
 * CHECK, so a reviewer asking "is this covered?" sees a discriminator sitting
 * right there and stops looking. **The visible enum reads as coverage**, which
 * makes it worse than the bare column #695 filed.
 *
 * It also refutes the natural remedy. "Give the column a discriminator so the
 * census can see it" does not work: these columns have one.
 *
 * So the population is the UNION of two derivations, and the second one reads
 * no vocabulary at all:
 *
 *  - **{@link deriveByVocabulary}** — the original rule. Kept, because it alone
 *    reaches a table whose discriminator names an entity while its reference is
 *    FK'd (`reviews`) or carries no ledger entry.
 *  - **{@link deriveByShape}** — a table carrying a closed value set AND a bare
 *    reference column the id ledger classifies under a reason that is not one
 *    of the five FOREIGN key spaces. Both halves are properties of SHAPE and of
 *    an add-gated register; **no member of this derivation depends on how a
 *    discriminator spells anything**, so a synonym cannot defeat it.
 *
 * The shape half is anchored on a gate that already runs: `findIdColumnViolations`
 * refuses any unclassified `_id` column, so a new bare id cannot be added
 * without a ledger entry, and a ledger entry outside `FOREIGN_KEY_SPACE_ID_REASONS`
 * on a table with any discriminator cannot be added without an entry here. Two
 * derived gates in a chain, and the decision lands on the person adding the
 * reference.
 *
 * ## The exclusion, and why it is the only one
 *
 * `FOREIGN_KEY_SPACE_ID_REASONS` is subtracted STRUCTURALLY: an Oxy account, an
 * Oxy file, a connected commerce platform's object, a payment provider's object
 * and a supplier's object are in another system's key space, and no merge in
 * this database can act on one. Everything else stays in the population —
 * including the 138 ledger entries written under a BESPOKE reason, which is
 * where BOTH known #720 instances live. Narrowing to the six shared
 * `MERCARIA_ROW_ID_REASONS` constants was measured first and REJECTED: it
 * yields a tidy 26-table population that misses `attribute_value_reviews` and
 * `attribute_reindex_requests`, i.e. it fails this file's own positive control
 * while looking like a tighter instrument.
 *
 * ## What neither census reaches, stated rather than left to be discovered
 *
 * A bare entity id with NO discriminator beside it and no ledger entry — an
 * array of ids (`_ids` is not `_id`, so the ledger never demanded one), an id
 * inside a composite string (`catalog_backfill_records.subject_key` is
 * `<kind>:<id>`), or one inside `jsonb`. Those are #695's finding and are
 * declared in `BARE_ENTITY_REFERENCES` and pinned by name in
 * `bare-entity-census.test.ts`; they are NOT add-gated, there and here. A new
 * array of merchant ids will not fail this build.
 *
 * The defences `~/Oxy/AGENTS.md` prescribes are all here: VACUITY FLOORS on the
 * schema, the ledger and each derivation independently, POSITIVE CONTROLS for
 * both #654's named tables and #720's synonym instances, reconciliation in BOTH
 * directions, a NEGATIVE control, and MUTATION SELF-TESTS that plant a
 * synonym-spelled table and confirm the comparison refuses it BY NAME.
 */

import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable, pgTable, text } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import { MERGEABLE_ENTITY_TYPES } from '@mercaria/shared-types';
import * as schema from '../../../db/schema/index.js';
import {
  FOREIGN_KEY_SPACE_ID_REASONS,
  ID_COLUMNS_WITHOUT_FOREIGN_KEY,
} from '../../../db/deferredForeignKeys.js';
import {
  BARE_ENTITY_REFERENCES,
  POLYMORPHIC_ENTITY_REFERENCES,
  type PolymorphicEntityReference,
} from '../merge-plan.js';

/** Every drizzle table the barrel exports — the set drizzle-kit emits DDL for. */
const tables = Object.values(schema).flatMap((value) => (is(value, PgTable) ? [value] : []));

const MERGEABLE = new Set<string>(MERGEABLE_ENTITY_TYPES as readonly string[]);

/** The ledger's own row shape, so a mutation can pass a planted register. */
type IdLedgerEntry = { readonly column: string; readonly reason: string };

/** A column's closed value set, or `undefined` when it has none. */
function enumValuesOf(column: unknown): readonly string[] | undefined {
  const values = (column as { enumValues?: readonly string[] }).enumValues;
  return values && values.length > 0 ? values : undefined;
}

/**
 * DERIVATION A — the tables carrying a column whose closed value set shares at
 * least one value with `MERGEABLE_ENTITY_TYPES`, with the columns that do.
 *
 * `enumValues` is drizzle's own reflection of the tuple it renders the CHECK
 * from, so this cannot disagree with the DDL the way a grep over source could.
 * It is deliberately OVER-WIDE — a table whose enum merely shares a word
 * (`orders.source_channel`) is ticked off once as `not_an_entity_reference`,
 * which is not noise but what makes the next one impossible to miss.
 *
 * Its LIMIT is #720: it sees only what spells an entity the way this tuple
 * does.
 */
function deriveByVocabulary(pool: readonly PgTable[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const table of pool) {
    const hits: string[] = [];
    for (const column of getTableConfig(table).columns) {
      const values = enumValuesOf(column);
      if (!values) continue;
      if (values.some((value) => MERGEABLE.has(value))) hits.push(sqlColumnName(column));
    }
    if (hits.length > 0) found.set(getTableName(table), hits);
  }
  return found;
}

/**
 * DERIVATION B — the tables carrying BOTH a closed value set and a bare
 * reference the id ledger classifies outside the five foreign key spaces.
 *
 * **This function never inspects a discriminator's VALUES.** It asks only
 * whether a discriminator exists at all, and whether the table holds an id the
 * ledger says belongs to this database. That is what makes it survive a synonym
 * — and it is the whole of #720's repair.
 *
 * Reported per table as the ledgered columns, because those are what a reader
 * has to go and decide about.
 */
function deriveByShape(
  pool: readonly PgTable[],
  ledger: readonly IdLedgerEntry[],
): Map<string, string[]> {
  const domestic = new Map<string, string[]>();
  for (const entry of ledger) {
    // `startsWith`, not equality: several entries append a sentence to a shared
    // reason constant, and an identity test would drop them back into the
    // population as unclassified.
    if (FOREIGN_KEY_SPACE_ID_REASONS.some((reason) => entry.reason.startsWith(reason))) continue;
    const separator = entry.column.indexOf('.');
    const table = entry.column.slice(0, separator);
    const column = entry.column.slice(separator + 1);
    domestic.set(table, [...(domestic.get(table) ?? []), column]);
  }

  const found = new Map<string, string[]>();
  for (const table of pool) {
    const name = getTableName(table);
    const columns = domestic.get(name);
    if (!columns) continue;
    const hasDiscriminator = getTableConfig(table).columns.some((column) => enumValuesOf(column));
    if (hasDiscriminator) found.set(name, [...columns].sort());
  }
  return found;
}

/** The population every reconciliation runs against: the union of both halves. */
function derivePopulation(
  pool: readonly PgTable[],
  ledger: readonly IdLedgerEntry[],
): Set<string> {
  return new Set([...deriveByVocabulary(pool).keys(), ...deriveByShape(pool, ledger).keys()]);
}

/** The comparison both directions run against. */
function reconcile(
  derived: Set<string>,
  declared: readonly PolymorphicEntityReference[],
): { readonly undeclared: string[]; readonly stale: string[] } {
  const declaredNames = new Set(declared.map((entry) => entry.table));
  return {
    undeclared: [...derived].filter((name) => !declaredNames.has(name)).sort(),
    stale: declared.map((entry) => entry.table).filter((name) => !derived.has(name)).sort(),
  };
}

describe('every polymorphic reference to a mergeable entity has a decision (#654, #720)', () => {
  const byVocabulary = deriveByVocabulary(tables);
  const byShape = deriveByShape(tables, ID_COLUMNS_WITHOUT_FOREIGN_KEY);
  const population = derivePopulation(tables, ID_COLUMNS_WITHOUT_FOREIGN_KEY);

  it('is not vacuous: the schema, the ledger and BOTH derivations are large', () => {
    // The schema floor catches a broken barrel import — the derived sets would
    // then be empty and BOTH reconciliation directions would pass against
    // nothing. The per-derivation floors are separate on purpose: a union floor
    // alone is satisfied by either half collapsing to zero, which is exactly
    // how #720's repair would rot back into the gate it replaced.
    expect(tables.length).toBeGreaterThanOrEqual(170);
    expect(ID_COLUMNS_WITHOUT_FOREIGN_KEY.length).toBeGreaterThanOrEqual(400);
    expect(byVocabulary.size).toBeGreaterThanOrEqual(30);
    expect(byShape.size).toBeGreaterThanOrEqual(80);
    expect(population.size).toBeGreaterThanOrEqual(110);
  });

  it('finds each of the three tables #654 named — the positive control', () => {
    // These are the known answers. A derivation that missed one would agree
    // with a register that also missed it, and the pair would look correct.
    // `catalog_review_items` is the load-bearing one: its discriminator is the
    // WIDER `CURATION_SUBJECT_TYPES`, so it is exactly what a subset rule drops.
    expect(byVocabulary.get('catalog_merge_jobs')).toContain('entity_type');
    expect(byVocabulary.get('catalog_split_jobs')).toContain('entity_type');
    expect(byVocabulary.get('catalog_review_items')).toContain('subject_type');
    expect(byVocabulary.get('catalog_review_items')).toContain('counterpart_type');
  });

  it('finds both #720 synonym instances — and the VOCABULARY half still cannot', () => {
    // The regression test for this issue, and it is written as a PAIR
    // deliberately. The first half alone would pass against a derivation that
    // returns every table; the second half is what shows the shape rule is the
    // thing that caught them, and it would fail on the pre-#720 gate.
    for (const table of ['attribute_value_reviews', 'attribute_reindex_requests']) {
      expect(byShape.get(table), `${table} must be reachable by SHAPE`).toContain('entity_id');
      expect(byVocabulary.has(table), `${table} is invisible to the vocabulary rule`).toBe(false);
      expect(population.has(table)).toBe(true);
    }

    // …and the reason it is invisible: the tuple names the same two entities in
    // different words. Asserted rather than described, so normalising the
    // vocabulary later (issue option 3) fails here and gets read.
    const entityKind = getTableConfig(
      tables.find((table) => getTableName(table) === 'attribute_value_reviews')!,
    ).columns.find((column) => sqlColumnName(column) === 'entity_kind');
    expect(enumValuesOf(entityKind)).toEqual(['product', 'variant']);
    expect(enumValuesOf(entityKind)!.some((value) => MERGEABLE.has(value))).toBe(false);
  });

  it('keeps the derivation over-wide, so a coincidence of vocabulary is ticked off rather than filtered', () => {
    // Deliberate, and asserted so nobody "fixes" it into a subset rule: these
    // two share a word and reference nothing. Their presence is what makes the
    // population complete; their DISPOSITION is what makes them harmless.
    expect(byVocabulary.has('orders')).toBe(true);
    expect(byVocabulary.has('product_type_fields')).toBe(true);
    const byTable = new Map(POLYMORPHIC_ENTITY_REFERENCES.map((entry) => [entry.table, entry]));
    expect(byTable.get('orders')?.disposition).toBe('not_an_entity_reference');
    expect(byTable.get('product_type_fields')?.disposition).toBe('not_an_entity_reference');
  });

  it('excludes a FOREIGN key space structurally, and nothing else', () => {
    // The one subtraction the shape rule makes. Without this the population
    // would carry every Oxy account id in the schema, which is the derivation
    // "returning the whole ledger" that #695's own negative control refused.
    expect(FOREIGN_KEY_SPACE_ID_REASONS.length).toBe(5);
    const excluded = ID_COLUMNS_WITHOUT_FOREIGN_KEY.filter((entry) =>
      FOREIGN_KEY_SPACE_ID_REASONS.some((reason) => entry.reason.startsWith(reason)),
    );
    expect(excluded.length).toBeGreaterThanOrEqual(300);

    // A table whose ONLY ledgered id is an Oxy account id is not in the
    // population — the vacuity floor for the exclusion itself.
    const shapeTables = new Set(byShape.keys());
    expect(shapeTables.has('attribute_definitions')).toBe(false);
  });

  it('declares every derived table, and declares no table that is no longer derived', () => {
    const { undeclared, stale } = reconcile(population, POLYMORPHIC_ENTITY_REFERENCES);

    expect(
      undeclared,
      'these tables carry a discriminator beside a reference this database owns, and ' +
        'POLYMORPHIC_ENTITY_REFERENCES does not say what a merge does with them. Add an entry to ' +
        '`merge-plan.ts`: `not_an_entity_reference` if no column here names one of the seven, ' +
        '`discriminates_foreign_keys` if the real reference is FK\'d and the FK census owns it, ' +
        '`covered_by_bare_entity_census` if BARE_ENTITY_REFERENCES already decided it, ' +
        'or `untouched`/`rehomed` with the id columns named.',
    ).toEqual([]);

    expect(
      stale,
      'these tables are declared here and neither derivation finds them. A stale ' +
        'declaration is an exemption that can never fire — the shape this domain has already ' +
        'paid for once — so remove the entry rather than leaving it to look like coverage.',
    ).toEqual([]);
  });

  it('names the id columns exactly when the disposition is about a real reference', () => {
    const needsColumns = new Set(['untouched', 'rehomed', 'covered_by_bare_entity_census']);
    const wrong = POLYMORPHIC_ENTITY_REFERENCES.filter((entry) => {
      const hasColumns = (entry.idColumns?.length ?? 0) > 0;
      return needsColumns.has(entry.disposition) !== hasColumns;
    }).map((entry) => `${entry.table} (${entry.disposition})`);

    // An entry claiming a merge leaves a reference alone has to say WHICH
    // reference, or it is a sentence rather than a decision; and one claiming
    // there is no reference must not name columns, or the two dispositions stop
    // meaning different things.
    expect(wrong).toEqual([]);
  });

  it('VERIFIES every citation of the bare-entity census rather than trusting it', () => {
    // `covered_by_bare_entity_census` defers a decision to another register.
    // Unchecked, that is the cheapest possible way to make a table look
    // decided — so every column named here must really be declared there, for
    // this table. Without this assertion the disposition would be a sentence.
    const declaredThere = new Set(BARE_ENTITY_REFERENCES.map((entry) => entry.column));
    const dangling: string[] = [];
    let cited = 0;
    for (const entry of POLYMORPHIC_ENTITY_REFERENCES) {
      if (entry.disposition !== 'covered_by_bare_entity_census') continue;
      for (const column of entry.idColumns ?? []) {
        cited += 1;
        if (!declaredThere.has(`${entry.table}.${column}`)) dangling.push(`${entry.table}.${column}`);
      }
    }
    expect(dangling).toEqual([]);
    // The vacuity floor: with no citations the loop above proves nothing.
    expect(cited).toBeGreaterThanOrEqual(30);
  });

  it('refuses a CIRCULAR deferral, where each census says the other decides', () => {
    // The failure this pairing makes possible and nothing else would catch.
    // `BARE_ENTITY_REFERENCES` may hand a table to this census
    // (`covered_by_polymorphic_census`) and this census may hand one back
    // (`covered_by_bare_entity_census`). If both ever name the same table, the
    // column is declared TWICE and decided ZERO times — and each register reads
    // as complete from its own side, which is the exact shape of the gap #720
    // was filed about.
    const deferredToBare = new Set(
      POLYMORPHIC_ENTITY_REFERENCES.filter(
        (entry) => entry.disposition === 'covered_by_bare_entity_census',
      ).map((entry) => entry.table),
    );
    const deferredToPolymorphic = BARE_ENTITY_REFERENCES.filter(
      (entry) => entry.disposition === 'covered_by_polymorphic_census',
    );
    // Both floors, or an empty register on either side makes the check vacuous.
    expect(deferredToBare.size).toBeGreaterThanOrEqual(20);
    expect(deferredToPolymorphic.length).toBeGreaterThanOrEqual(5);

    const circular = deferredToPolymorphic
      .filter((entry) => deferredToBare.has(entry.column.split('.')[0] ?? ''))
      .map((entry) => entry.column);
    expect(circular).toEqual([]);
  });

  it('gives every entry a real reason', () => {
    const thin = POLYMORPHIC_ENTITY_REFERENCES.filter(
      (entry) => entry.reason.trim().length < 40,
    ).map((entry) => entry.table);
    expect(thin).toEqual([]);
  });

  it('declares each table exactly once', () => {
    const names = POLYMORPHIC_ENTITY_REFERENCES.map((entry) => entry.table);
    expect(names.length).toBe(new Set(names).size);
  });

  describe('the self-tests — each detector is shown to fail', () => {
    /** A table nobody has declared, carrying a discriminator over a mergeable type. */
    const planted = pgTable('mercaria_planted_polymorphic_table', {
      id: text().primaryKey(),
      subjectKind: text({ enum: ['canonical_product', 'something_else'] }).notNull(),
      subjectRef: text().notNull(),
    });

    /**
     * The #720 table: a real discriminator whose tuple shares NOTHING with
     * `MERGEABLE_ENTITY_TYPES` while naming exactly two of them, plus a bare id
     * the ledger classifies as this database's.
     */
    const synonym = pgTable('mercaria_planted_synonym_table', {
      id: text().primaryKey(),
      entityKind: text({ enum: ['product', 'variant'] }).notNull(),
      entityId: text().notNull(),
    });
    const synonymLedger: readonly IdLedgerEntry[] = [
      ...ID_COLUMNS_WITHOUT_FOREIGN_KEY,
      {
        column: 'mercaria_planted_synonym_table.entity_id',
        reason:
          'Planted by this test: polymorphic by entity_kind over a canonical product or variant.',
      },
    ];

    it('refuses a NEW polymorphic table BY NAME', () => {
      // The mutation the whole file exists for. It runs against the real
      // derivation over the real schema plus one planted table, so what is
      // measured is the code that runs in CI rather than a reimplementation.
      const withPlanted = derivePopulation([...tables, planted], ID_COLUMNS_WITHOUT_FOREIGN_KEY);
      expect(withPlanted.has('mercaria_planted_polymorphic_table')).toBe(true);

      const { undeclared, stale } = reconcile(withPlanted, POLYMORPHIC_ENTITY_REFERENCES);
      expect(undeclared).toEqual(['mercaria_planted_polymorphic_table']);
      expect(stale).toEqual([]);
    });

    it('refuses a SYNONYM-spelled table BY NAME — the #720 mutation', () => {
      // The mutation that fails on the pre-#720 gate. The vocabulary half is
      // asserted BLIND to it in the same test, so this cannot pass by the old
      // rule having quietly widened.
      expect(deriveByVocabulary([...tables, synonym]).has('mercaria_planted_synonym_table')).toBe(
        false,
      );
      expect(deriveByShape([...tables, synonym], synonymLedger).get('mercaria_planted_synonym_table')).toEqual(
        ['entity_id'],
      );

      const withSynonym = derivePopulation([...tables, synonym], synonymLedger);
      const { undeclared, stale } = reconcile(withSynonym, POLYMORPHIC_ENTITY_REFERENCES);
      expect(undeclared).toEqual(['mercaria_planted_synonym_table']);
      expect(stale).toEqual([]);
    });

    it('refuses a STALE declaration BY NAME', () => {
      const withGhost = [
        ...POLYMORPHIC_ENTITY_REFERENCES,
        {
          table: 'mercaria_table_that_no_longer_exists',
          disposition: 'not_an_entity_reference',
          reason: 'a declaration whose table the derivation no longer finds, planted by this test',
        } satisfies PolymorphicEntityReference,
      ];
      const { undeclared, stale } = reconcile(population, withGhost);
      expect(stale).toEqual(['mercaria_table_that_no_longer_exists']);
      expect(undeclared).toEqual([]);
    });

    it('would NOT find a table whose enum shares nothing and whose id is unledgered', () => {
      // Without this, "the derivation found my planted table" would also be
      // satisfied by a derivation that returns every table it is handed.
      const unrelated = pgTable('mercaria_planted_unrelated_table', {
        id: text().primaryKey(),
        kind: text({ enum: ['alpha', 'beta'] }).notNull(),
      });
      const withUnrelated = derivePopulation(
        [...tables, unrelated],
        ID_COLUMNS_WITHOUT_FOREIGN_KEY,
      );
      expect(withUnrelated.has('mercaria_planted_unrelated_table')).toBe(false);
      expect(reconcile(withUnrelated, POLYMORPHIC_ENTITY_REFERENCES).undeclared).toEqual([]);
    });

    it('would NOT find a table whose only ledgered id is in a FOREIGN key space', () => {
      // The exclusion's own mutation. A planted table carrying a discriminator
      // and an Oxy account id must stay OUT, or the population grows by every
      // actor column in the schema and the register becomes unreadable — which
      // is how a gate stops being read and starts being rubber-stamped.
      const foreign = pgTable('mercaria_planted_foreign_table', {
        id: text().primaryKey(),
        kind: text({ enum: ['alpha', 'beta'] }).notNull(),
        actorOxyUserId: text().notNull(),
      });
      const foreignLedger: readonly IdLedgerEntry[] = [
        ...ID_COLUMNS_WITHOUT_FOREIGN_KEY,
        {
          column: 'mercaria_planted_foreign_table.actor_oxy_user_id',
          reason: FOREIGN_KEY_SPACE_ID_REASONS[0],
        },
      ];
      expect(deriveByShape([...tables, foreign], foreignLedger).has('mercaria_planted_foreign_table')).toBe(
        false,
      );

      // …and the control that the table WOULD have been found had the reason
      // been a domestic one, so the assertion above is about the EXCLUSION
      // rather than about the planted table being unreachable for some other
      // reason.
      const domesticLedger: readonly IdLedgerEntry[] = [
        ...ID_COLUMNS_WITHOUT_FOREIGN_KEY,
        {
          column: 'mercaria_planted_foreign_table.actor_oxy_user_id',
          reason: 'Planted by this test: a row in THIS database, under a bespoke reason.',
        },
      ];
      expect(deriveByShape([...tables, foreign], domesticLedger).has('mercaria_planted_foreign_table')).toBe(
        true,
      );
    });
  });
});
