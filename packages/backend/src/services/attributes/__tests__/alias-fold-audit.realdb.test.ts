/**
 * The #632 detection pass, against a REAL PostgreSQL server.
 *
 * Two things are under test and they fail differently.
 *
 * ## 1. The audit's SQL fold agrees with the reader's JS fold
 *
 * The load-bearing one, and it is the same class of defect the audit exists to
 * measure. `normalizeOptionValue` folds with `trim()`, collapse `\s+`,
 * lowercase; the audit reproduces that in SQL to decide which rows would
 * collide. Two spellings of one rule that disagree make the count wrong — and
 * the dangerous direction is an UNDER-count, which reports the migration safe
 * when it is not.
 *
 * The case table is not decoration. The obvious SQL — `btrim` plus
 * `regexp_replace(x, '\s+', ' ', 'g')` — was MEASURED against it and disagrees
 * on two of the thirteen: PostgreSQL's `\s` is the POSIX space class and does
 * not contain U+00A0 NO-BREAK SPACE or U+FEFF ZERO WIDTH NO-BREAK SPACE, both
 * of which JavaScript's `\s` under `u` does. `READ_SIDE_FOLD_SQL` names them
 * explicitly for that reason.
 *
 * ## 2. The detector actually detects
 *
 * Every count is a DELTA against a baseline taken in the same case, over rows
 * this file planted. A detector that returned zero for everything would satisfy
 * "no collisions" perfectly — and that is exactly the answer that would send
 * somebody to run a migration that aborts mid-deploy.
 *
 * ## Scoping, because this database is SHARED
 *
 * The audit is GLOBAL by design: an operator asks whether the migration is
 * safe, not whether it is safe for one namespace. So exact assertions are
 * deltas and absolute assertions are floors. A sibling seeding an alias moves
 * the baseline and breaks nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import {
  insertAttributeDefinition,
  insertAttributeEnumValue,
  insertAttributeValueAlias,
  type AttributeDefinitionRow,
} from '../../../db/attributes/definitionRepository.js';
import { auditAliasFold, readSideFold, type AliasFoldAudit } from '../alias-fold-audit.js';
import { normalizeOptionValue } from '../../canonical/variant-signature.js';

const RUN = uuidv7().slice(-12);
const KEY = `zz_audit_${RUN}`;

let db: Database;
let definition: AttributeDefinitionRow;
let usbCId: string;
let thunderboltId: string;

/**
 * The spellings the two folds are compared over.
 *
 * ESCAPES and never literal characters: a NO-BREAK SPACE pasted into a source
 * file is invisible in every diff and every review, which is the defect one
 * layer up. Two of them — U+00A0 NO-BREAK SPACE and U+FEFF ZERO WIDTH
 * NO-BREAK SPACE — are the ones the obvious SQL gets wrong, so dropping them
 * would make this case pass against the fold that under-counts.
 */
const FOLD_CASES: readonly string[] = [
  'USB C',
  'USB  C',
  'USB C\t',
  '\tUSB C',
  'USB\nC',
  'USB\r\nC',
  '  USB C  ',
  'USB\u00a0C',
  'USB\u2003C',
  'USB\u3000C',
  'USB\ufeffC',
  'usb c',
  'USBC',
];

/** The audit's fold applied to one bound value — the driver binds it, not a literal. */
async function foldInSql(input: string): Promise<string> {
  const rows = await db.execute<{ folded: string }>(sql`
    with s(v) as (values (${input}::text))
    select ${sql.raw(readSideFold('s.v'))} as folded from s
  `);
  const [row] = [...rows];
  if (row === undefined) throw new Error('the fold query returned no row');
  return row.folded;
}

async function audit(): Promise<AliasFoldAudit> {
  return auditAliasFold(db);
}

beforeAll(async () => {
  db = await connectPostgres();
  definition = await insertAttributeDefinition(db, {
    key: KEY,
    version: 1,
    // DRAFT throughout: `mercaria_attribute_enum_frozen` refuses a write to the
    // value vocabulary once a definition leaves draft, and an active definition
    // cannot be deleted at teardown. Nothing under test reads the lifecycle.
    lifecycleState: 'draft',
    label: 'Charging port',
    valueType: 'enum',
    cardinality: 'single',
    objectivity: 'objective',
    variantDefining: false,
    filterable: true,
    sortable: false,
    comparable: true,
    hardConstraintCapable: true,
    displayPolicy: 'public',
    evidencePolicy: 'source_required',
    createdByOxyUserId: `audit-${RUN}`,
  });

  const usbC = await insertAttributeEnumValue(db, definition.id, 'usb_c', 'USB-C', 0);
  const thunderbolt = await insertAttributeEnumValue(
    db,
    definition.id,
    'usb_c_thunderbolt',
    'USB-C (Thunderbolt)',
    1,
  );
  if (usbC === undefined || thunderbolt === undefined) {
    throw new Error('the fixture enum values were not inserted');
  }
  usbCId = usbC.id;
  thunderboltId = thunderbolt.id;

  // One well-formed alias, so the population floor has something to measure
  // before any case plants a defect. Without it that floor asserts `> 0` at a
  // moment when the fixture has written no alias at all, which is a failure of
  // ordering rather than of the audit.
  await insertAttributeValueAlias(db, {
    attributeDefinitionId: definition.id,
    enumValueId: usbCId,
    alias: 'Baseline Port',
  });
}, 180_000);

afterAll(async () => {
  await db.execute(sql`
    delete from attribute_value_aliases where attribute_definition_id = ${definition.id}
  `);
  await db.execute(sql`
    delete from attribute_enum_values where attribute_definition_id = ${definition.id}
  `);
  await db.execute(sql`delete from attribute_definitions where id = ${definition.id}`);
}, 180_000);

describe('the audit folds the way the reader folds', () => {
  it('agrees with normalizeOptionValue on every spelling', async () => {
    // The vacuity floor. `FOLD_CASES` is a `const` somebody could shorten, and a
    // loop over an empty list asserts nothing while passing.
    expect(FOLD_CASES.length, `${String(FOLD_CASES.length)} spellings compared`).toBeGreaterThan(10);

    const mismatches: string[] = [];
    for (const input of FOLD_CASES) {
      const inSql = await foldInSql(input);
      const inJs = normalizeOptionValue(input);
      if (inSql !== inJs) {
        mismatches.push(`${JSON.stringify(input)}: sql=${JSON.stringify(inSql)} js=${JSON.stringify(inJs)}`);
      }
    }
    expect(
      mismatches,
      'the audit fold and the reader fold disagree, so the collision count is wrong — and an ' +
        'UNDER-count reports the #632 migration safe when it would abort',
    ).toEqual([]);
  }, 60_000);

  it('is not the obvious POSIX fold, and this is why', async () => {
    // The negative control for the case above. Without it, "they agree" would be
    // satisfied by any fold at all, including the one that silently misses two
    // whitespace characters — and the case table would look like decoration.
    const posix = async (input: string): Promise<string> => {
      const rows = await db.execute<{ folded: string }>(sql`
        with s(v) as (values (${input}::text))
        select lower(regexp_replace(btrim(s.v), '\\s+', ' ', 'g')) as folded from s
      `);
      return [...rows][0]?.folded ?? '';
    };
    expect(await posix('USB\u00a0C'), 'POSIX \\s now matches a NO-BREAK SPACE').not.toBe(
      normalizeOptionValue('USB\u00a0C'),
    );
    expect(await foldInSql('USB\u00a0C')).toBe(normalizeOptionValue('USB\u00a0C'));
  }, 60_000);
});

describe('the detector detects', () => {
  it('examines a non-empty population', async () => {
    const report = await audit();
    // `0 collisions` over `0 rows` and over 40,000 are the same number and
    // opposite facts. This is the floor that tells them apart.
    expect(
      report.aliases.population,
      `the audit examined ${String(report.aliases.population)} alias rows`,
    ).toBeGreaterThan(0);
    expect(
      report.enumValues.population,
      `the audit examined ${String(report.enumValues.population)} enum values`,
    ).toBeGreaterThan(0);
  }, 60_000);

  it('finds two aliases that fold together, and flags the catalogue judgement', async () => {
    const before = await audit();

    // Two spellings one whitespace apart, pointing at DIFFERENT canonical
    // values. Today's unique index does not collide them — that is the defect —
    // so both insert and the audit is what has to see it.
    await insertAttributeValueAlias(db, {
      attributeDefinitionId: definition.id,
      enumValueId: usbCId,
      alias: 'Fast Port',
    });
    await insertAttributeValueAlias(db, {
      attributeDefinitionId: definition.id,
      enumValueId: thunderboltId,
      alias: 'Fast  Port',
    });

    const after = await audit();
    expect(
      after.aliases.collisionRows - before.aliases.collisionRows,
      'the audit did not see two aliases folding to one key',
    ).toBe(2);
    // The subset that needs a person: the two rows resolve to two different
    // canonical values, so no migration can decide which survives.
    expect(
      after.aliases.ambiguousGroups - before.aliases.ambiguousGroups,
      'the audit did not flag the group as ambiguous',
    ).toBe(1);
    // Monotone: planting a collision can only make this false, whatever the
    // baseline was.
    expect(after.migrationSafe, 'the audit reports the migration safe with a collision present').toBe(
      false,
    );

    const group = after.aliases.collisionGroups.find(
      (entry) => entry.attributeDefinitionId === definition.id && entry.foldedKey === 'fast port',
    );
    expect(group, 'the colliding group is not named in the sample').toBeDefined();
    expect(group?.spellings.slice().sort()).toEqual(['Fast  Port', 'Fast Port']);
    expect(group?.distinctTargets).toBe(2);
  }, 60_000);

  it('finds an alias the reader can never look up, collision or not', async () => {
    const before = await audit();

    // Folds to `type c`, is indexed under `type  c`. It collides with nothing —
    // which is the point: this row is broken TODAY and does not block the
    // migration, so counting it with the collisions would make "safe to run"
    // and "nothing is broken" one claim.
    await insertAttributeValueAlias(db, {
      attributeDefinitionId: definition.id,
      enumValueId: usbCId,
      alias: 'Type  C',
    });

    const after = await audit();
    expect(
      after.aliases.unreachableRows - before.aliases.unreachableRows,
      'the audit did not see an alias stored under a key the reader cannot produce',
    ).toBe(1);
    expect(after.aliases.collisionRows - before.aliases.collisionRows, 'it collided with something').toBe(
      0,
    );

    const row = after.aliases.unreachable.find(
      (entry) => entry.attributeDefinitionId === definition.id && entry.stored === 'Type  C',
    );
    expect(row, 'the unreachable alias is not named in the sample').toBeDefined();
    expect(row?.storedKey).toBe('type  c');
    expect(row?.readerKey).toBe('type c');
  }, 60_000);

  it('finds a canonical VALUE the reader can never look up (#632 third instance)', async () => {
    const before = await audit();

    // `attribute_enum_values_normalized_check` is `value = lower(btrim(value))`,
    // which admits this — while the comment above it claims values are
    // "whitespace-collapsed". A canonical value is its own alias, so this lands
    // on the value every assignment stores.
    const planted = await insertAttributeEnumValue(db, definition.id, 'usb  micro', 'USB micro', 9);
    expect(planted, 'the CHECK now refuses an interior run; this case measures a rule that changed').toBeDefined();

    const after = await audit();
    expect(
      after.enumValues.unreachableRows - before.enumValues.unreachableRows,
      'the audit did not see a canonical value stored under a key the reader cannot produce',
    ).toBe(1);

    const row = after.enumValues.unreachable.find(
      (entry) => entry.attributeDefinitionId === definition.id && entry.stored === 'usb  micro',
    );
    expect(row, 'the unreachable enum value is not named in the sample').toBeDefined();
    expect(row?.readerKey).toBe('usb micro');
  }, 60_000);
});
