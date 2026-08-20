/**
 * `attribute_definition` keeps a revision trail like every other member of the
 * family, against a REAL PostgreSQL server (#94, #367).
 *
 * ## Why this is a behavioural test and not a census
 *
 * `catalog-localization.test.ts` now counts `RETURNS trigger` functions against
 * `EXECUTE FUNCTION` references, which catches a function nobody attached. It
 * cannot catch a trigger that is attached and writes the WRONG rows — the wrong
 * entity kind, the wrong entity id, a field key the pair CHECK admits for some
 * other domain. Only running it can.
 *
 * ## The failure it exists for
 *
 * `rollbackLocalizationRevision` reads the revision written for an UPDATE. With
 * no trigger it finds none and returns `undefined`, whose contract means "the
 * rollback would change nothing". A rollback that DID change the live text while
 * reporting that it changed nothing is the worst answer this domain can give, so
 * an absent trail is not a missing feature — it is a wrong answer from a
 * function that looks like it worked.
 *
 * That is why the first case asserts the trigger EXISTS by name before anything
 * else runs. Its absence must fail loudly here rather than leave the later cases
 * quietly asserting nothing about a table nobody is recording.
 *
 * ## Scoping, because this database is SHARED
 *
 * One attribute definition per run, kept `draft` so its labels stay writable and
 * the row is deletable, and every revision read is keyed on its id.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';

import { connectPostgres, type Database } from '../postgres.js';
import {
  insertAttributeDefinition,
  upsertAttributeLabel,
  type AttributeDefinitionRow,
} from '../attributes/definitionRepository.js';

const RUN = uuidv7().slice(-12);
const KEY = `zz_rev_${RUN}`;
const OPERATOR = `rev-${RUN}`;

let db: Database;
let definition: AttributeDefinitionRow;

/**
 * A `type` alias and not an `interface`, deliberately.
 *
 * `db.execute<T>` constrains `T` to `Record<string, unknown>`, and an interface
 * has no implicit index signature while a type alias does — so the interface
 * spelling fails to satisfy the constraint. `completenessRepository.ts` records
 * the same trap beside its own row type.
 */
type RevisionRow = {
  id: string;
  action: string;
  entity_kind: string;
  entity_id: string;
  locale: string;
  field_key: string;
  value: string | null;
  status: string;
  provenance: string;
};

async function revisions(): Promise<RevisionRow[]> {
  const rows = await db.execute<RevisionRow>(sql`
    select id, action, entity_kind, entity_id, locale, field_key, value, status, provenance
      from catalog_localization_revisions
     where entity_id = ${definition.id}
     order by field_key, id
  `);
  return [...rows];
}

/**
 * The rows this step added, by ID DIFFERENCE and never by `slice(before.length)`.
 *
 * The read is ordered by `field_key`, so a new `…description` revision sorts
 * BEFORE the existing `…label` ones and a positional slice returns the wrong
 * rows — which is what the first draft of this file did, and it failed by
 * reporting a stale row's status rather than by looking obviously wrong.
 *
 * An id diff is also the only correct form here for a second reason: `@oxyhq/db`
 * mints uuid v7, which is NOT monotonic within a millisecond, so "the newest N
 * by id" is not reliable either.
 */
function addedSince(before: readonly RevisionRow[], after: readonly RevisionRow[]): RevisionRow[] {
  const seen = new Set(before.map((row) => row.id));
  return after.filter((row) => !seen.has(row.id));
}

beforeAll(async () => {
  db = await connectPostgres();
  definition = await insertAttributeDefinition(db, {
    key: KEY,
    version: 1,
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
    createdByOxyUserId: OPERATOR,
  });
}, 180_000);

afterAll(async () => {
  // The revisions are deliberately NOT deleted. `catalog_localization_revisions`
  // refuses DELETE by trigger — "the trail is what a translator and a reviewer
  // are accountable to; a row that can be rewritten is not a record" — and that
  // refusal is a property this domain relies on, so a teardown that removed the
  // rows would have to switch off the trigger every other file depends on.
  // `catalog-governance.realdb.test.ts` leaves its audit rows for the same
  // reason. They are keyed to this run's own definition id and reference it by a
  // polymorphic column with no foreign key, so nothing blocks the deletes below
  // and nothing else can see them.
  await db.execute(sql`delete from attribute_labels where attribute_definition_id = ${definition.id}`);
  await db.execute(sql`delete from attribute_definitions where id = ${definition.id}`);
}, 180_000);

describe('the revision trigger is attached at all', () => {
  it('exists on attribute_labels, by name', async () => {
    // FIRST, and loud. If the migration did not land, every case below would
    // assert things about an empty table and read as "no revisions were owed"
    // rather than "nothing is recording". A skip would read the same way.
    const rows = await db.execute<{ tgname: string }>(sql`
      select t.tgname
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
         and c.relname = 'attribute_labels'
         and t.tgname = 'mercaria_attribute_labels_localization_revision'
    `);
    expect(
      [...rows],
      'the revision trigger is NOT attached — rollbackLocalizationRevision would find no ' +
        'revision for an update and report that the rollback would change nothing',
    ).toHaveLength(1);
  });
});

describe('writing a label writes its revisions', () => {
  it('records a `create` per field on the first write', async () => {
    await upsertAttributeLabel(db, {
      attributeDefinitionId: definition.id,
      locale: 'es',
      label: 'Puerto de carga',
      description: 'El conector por el que se carga',
      settlement: {
        status: 'reviewed',
        provenance: 'mercaria',
        reviewedByOxyUserId: OPERATOR,
        reviewedAt: new Date(),
      },
    });

    const rows = await revisions();
    expect(rows).toHaveLength(2);
    // The entity KIND and the field keys are what the widened CHECKs admit, and
    // the pair CHECK would refuse a mismatched combination outright — so these
    // assertions are about the trigger naming the right domain, not about the
    // constraint.
    for (const row of rows) {
      expect(row.entity_kind).toBe('attribute_definition');
      expect(row.entity_id).toBe(definition.id);
      expect(row.locale).toBe('es');
      expect(row.action).toBe('create');
      expect(row.status).toBe('reviewed');
      expect(row.provenance).toBe('mercaria');
    }
    expect(rows.map((row) => row.field_key)).toEqual([
      'attribute_definition.description',
      'attribute_definition.label',
    ]);
    expect(rows.map((row) => row.value)).toEqual([
      'El conector por el que se carga',
      'Puerto de carga',
    ]);
  }, 60_000);

  it('records an `update` only for the field that MOVED', async () => {
    const before = await revisions();

    await db.execute(sql`
      update attribute_labels set label = 'Conector de carga'
       where attribute_definition_id = ${definition.id} and locale = 'es'
    `);

    const added = addedSince(before, await revisions());
    // ONE row, not two. The trigger's `WHERE f.v IS DISTINCT FROM f.o` is what
    // keeps a trail readable: a revision per unchanged field on every edit would
    // make the history mostly noise, and a reviewer looking for what changed
    // would have to diff it themselves.
    expect(
      added,
      'the trigger recorded a revision for a field whose value did not move',
    ).toHaveLength(1);
    expect(added[0]?.field_key).toBe('attribute_definition.label');
    expect(added[0]?.action).toBe('update');
    expect(added[0]?.value).toBe('Conector de carga');
  }, 60_000);

  it('records an `update` when only the STATUS moves, text unchanged', async () => {
    // The other half of the same `WHERE`: a settlement change is a revision even
    // though no text moved, because "somebody approved this" is exactly the kind
    // of fact a trail exists to carry. Without the status/provenance clauses the
    // trigger would silently drop it.
    const before = await revisions();
    await db.execute(sql`
      update attribute_labels set status = 'approved'
       where attribute_definition_id = ${definition.id} and locale = 'es'
    `);
    const added = addedSince(before, await revisions());
    expect(added.length, 'a status-only change recorded nothing').toBeGreaterThan(0);
    for (const row of added) expect(row.status).toBe('approved');
  }, 60_000);
});
