/**
 * `attribute_labels` really is a member of the localization family now, against
 * a REAL PostgreSQL server (#94, ADR 0007 D4).
 *
 * ## What was false before this, and why no test could have caught it
 *
 * `mercaria_localization_machine_write_guard` reads `NEW.provenance` and
 * `OLD.status`. `attribute_labels` had neither column, so the guard could not be
 * ATTACHED to it — not "was not attached", could not be. Four tables executed
 * it and this one could not, which made *"prevent machine translation from
 * overwriting reviewed or approved human content"* structurally false for this
 * member. A census of the table's declaration returned zero for both columns;
 * that is the shape of a guarantee with a hole in it that no behavioural test
 * can reach, because there is no write to refuse.
 *
 * ## Why a real server
 *
 * Every property here belongs to the database: a trigger's refusal, a CHECK's
 * refusal, and an `AFTER UPDATE ... WHEN` clause firing on a source edit. A
 * mocked repository accepts all of them and would report this file green
 * against the schema that has the hole.
 *
 * ## The helper is the part worth reading
 *
 * `expectRefusal` fails when the statement SUCCEEDS. That is not defensive
 * padding: a test that only asserts "an error was thrown" passes identically
 * against a trigger that fired and against a fixture whose INSERT was invalid
 * for an unrelated reason, and a test that never asserts the negative case
 * passes against a guard that was silently dropped. It also reads the message
 * off `error.cause` — drizzle WRAPS the driver error, so `error.message` is only
 * ever `Failed query: …` and a `.rejects.toThrow(/…/)` matches the wrapper and
 * passes against a trigger that never fired.
 *
 * ## Scoping, because this database is SHARED
 *
 * One attribute definition per run, every row keyed to it, and the definition
 * stays `draft` so the value vocabulary is writable and the row is deletable.
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
const KEY = `zz_family_${RUN}`;
const OPERATOR = `family-${RUN}`;

let db: Database;
let definition: AttributeDefinitionRow;

/**
 * Assert a statement was refused BY THE DATABASE, matching its own words.
 *
 * Throws when the statement was accepted, and reads `cause` rather than
 * `message`. See the file header for why both halves matter.
 */
async function expectRefusal(run: Promise<unknown>, pattern: RegExp, what: string): Promise<void> {
  let raised: unknown;
  try {
    await run;
  } catch (error) {
    raised = error;
  }
  expect(raised, `${what}: the statement SUCCEEDED — nothing refused it`).toBeDefined();
  const cause = String(((raised as { cause?: { message?: string } }).cause ?? {}).message ?? '');
  expect(cause, `${what}: refused, but not by the expected rule (cause: ${cause})`).toMatch(pattern);
}

/** Write one label directly, bypassing the repository's settlement contract. */
async function writeLabel(
  locale: string,
  label: string,
  status: string,
  provenance: string,
  reviewer: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into attribute_labels
      (id, attribute_definition_id, locale, label, status, provenance,
       reviewed_by_oxy_user_id, reviewed_at)
    values (${uuidv7()}, ${definition.id}, ${locale}, ${label}, ${status}, ${provenance},
            ${reviewer}, ${reviewer === null ? null : sql`now()`})
  `);
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
  await db.execute(sql`delete from attribute_labels where attribute_definition_id = ${definition.id}`);
  await db.execute(sql`delete from attribute_definitions where id = ${definition.id}`);
}, 180_000);

describe('the family columns are really there', () => {
  it('carries all seven, with status and provenance NOT NULL', async () => {
    const rows = await db.execute<{ column_name: string; is_nullable: string }>(sql`
      select column_name, is_nullable
        from information_schema.columns
       where table_name = 'attribute_labels'
         and column_name in ('locale', 'status', 'provenance', 'source_locale',
                             'source_revision', 'reviewed_by_oxy_user_id', 'reviewed_at')
       order by column_name
    `);
    const found = [...rows];
    // The floor: seven, by name. A column list that came back short would make
    // every refusal below fail for the wrong reason.
    expect(found.map((row) => row.column_name).sort()).toEqual([
      'locale',
      'provenance',
      'reviewed_at',
      'reviewed_by_oxy_user_id',
      'source_locale',
      'source_revision',
      'status',
    ]);
    const notNull = found.filter((row) => row.is_nullable === 'NO').map((row) => row.column_name);
    expect(notNull.sort()).toEqual(['locale', 'provenance', 'status']);
  });

  it('does NOT narrow locale, which is the deferred half stated as a fact', async () => {
    // Deliberate, and asserted so the omission is visible rather than assumed:
    // narrowing `locale` to SUPPORTED_LOCALES validates against every existing
    // row and can abort a deploy. If somebody adds it, this case fails and
    // points at the counting query that has to run first.
    const rows = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint
       where conrelid = 'attribute_labels'::regclass
         and conname in ('attribute_labels_locale_check', 'attribute_labels_locale_not_base_check')
    `);
    expect([...rows]).toHaveLength(0);
  });
});

describe('the machine-write guard, which this table could not execute before', () => {
  it('refuses a machine write landing on approved text', async () => {
    await writeLabel('es', 'Puerto de carga', 'approved', 'mercaria', OPERATOR);
    await expectRefusal(
      db.execute(sql`
        update attribute_labels
           set provenance = 'machine', status = 'machine_translated', label = 'Puerto USB',
               reviewed_by_oxy_user_id = null, reviewed_at = null
         where attribute_definition_id = ${definition.id} and locale = 'es'
      `),
      /Machine translation may not replace approved text/u,
      'a machine write onto approved text',
    );
  });

  it('refuses one landing on reviewed text', async () => {
    await writeLabel('de', 'Ladeanschluss', 'reviewed', 'mercaria', OPERATOR);
    await expectRefusal(
      db.execute(sql`
        update attribute_labels
           set provenance = 'machine', status = 'machine_translated',
               reviewed_by_oxy_user_id = null, reviewed_at = null
         where attribute_definition_id = ${definition.id} and locale = 'de'
      `),
      /Machine translation may not replace reviewed text/u,
      'a machine write onto reviewed text',
    );
  });

  it('ACCEPTS a machine write onto stale text — the positive control', async () => {
    // Without this the two refusals above are satisfied by a guard that refuses
    // every machine write, which is a different and wrong rule.
    // `HUMAN_SETTLED_LOCALIZATION_STATUSES` deliberately excludes `stale`: a
    // stale row is human text that no longer describes the source, so a fresh
    // machine translation of the NEW source is a legitimate replacement.
    await writeLabel('fr', 'Port de charge', 'stale', 'mercaria', OPERATOR);
    await db.execute(sql`
      update attribute_labels
         set provenance = 'machine', status = 'machine_translated',
             reviewed_by_oxy_user_id = null, reviewed_at = null
       where attribute_definition_id = ${definition.id} and locale = 'fr'
    `);
    const rows = await db.execute<{ status: string; provenance: string }>(sql`
      select status, provenance from attribute_labels
       where attribute_definition_id = ${definition.id} and locale = 'fr'
    `);
    expect([...rows][0]).toEqual({ status: 'machine_translated', provenance: 'machine' });
  });
});

describe('the CHECKs the guard cannot see', () => {
  it('refuses an INSERT claiming machine provenance on approved text', async () => {
    // The trigger fires on UPDATE only, so an INSERT never gives it a chance.
    // This is the other half of the pair, and neither covers the other.
    await expectRefusal(
      writeLabel('pt', 'Porta de carregamento', 'approved', 'machine', null),
      /attribute_labels_machine_status_check/u,
      'an INSERT claiming machine provenance on approved text',
    );
  });

  it('refuses settled text with no reviewer', async () => {
    await expectRefusal(
      writeLabel('ru', 'Разъем', 'approved', 'mercaria', null),
      /attribute_labels_reviewed_audit_check/u,
      'approved text with nobody named',
    );
  });
});

describe('a source-semantics change marks the translations stale', () => {
  it('fires on a label edit and leaves the text in place', async () => {
    await writeLabel('ja', 'ポート', 'approved', 'mercaria', OPERATOR);
    await db.execute(sql`
      update attribute_definitions set label = 'Charging connector' where id = ${definition.id}
    `);

    const rows = await db.execute<{ status: string; label: string }>(sql`
      select status, label from attribute_labels
       where attribute_definition_id = ${definition.id} and locale = 'ja'
    `);
    const row = [...rows][0];
    expect(row?.status, 'the source label changed and the translation stayed approved').toBe(
      'stale',
    );
    // It does NOT blank the text. A stale translation is still the best text
    // available; withdrawing it would show a raw key to a shopper, which is the
    // failure the whole family exists to prevent.
    expect(row?.label).toBe('ポート');
  }, 60_000);

  it('fires on a DESCRIPTION edit too, which the category trigger does not', async () => {
    // The deliberate departure from mercaria_categories_localization_stale,
    // which watches its name column alone. That blind spot is declared in
    // LOCALIZATION_STALENESS_DETECTIONS and published by the completeness desk
    // as a caveat; copying the WHEN clause across would have made it a family
    // trait. attribute_labels translates attribute_definitions.description, so
    // a source description edit leaves it describing something else exactly as
    // a label edit does.
    await writeLabel('hi', 'पोर्ट', 'approved', 'mercaria', OPERATOR);
    await db.execute(sql`
      update attribute_definitions set description = 'The connector a device charges through'
       where id = ${definition.id}
    `);
    const rows = await db.execute<{ status: string }>(sql`
      select status from attribute_labels
       where attribute_definition_id = ${definition.id} and locale = 'hi'
    `);
    expect([...rows][0]?.status, 'a source DESCRIPTION edit left the translation settled').toBe(
      'stale',
    );
  }, 60_000);
});

describe('the repository writer states what it is writing', () => {
  it('re-settles on conflict rather than rewriting text under a stale verdict', async () => {
    await upsertAttributeLabel(db, {
      attributeDefinitionId: definition.id,
      locale: 'ca',
      label: 'Port de càrrega',
      settlement: {
        status: 'approved',
        provenance: 'mercaria',
        reviewedByOxyUserId: OPERATOR,
        reviewedAt: new Date(),
      },
    });

    // The same locale again with DIFFERENT text and a different settlement. The
    // old writer set label/description only, which would have left this row
    // `approved` by the first call while carrying the second call's text.
    await upsertAttributeLabel(db, {
      attributeDefinitionId: definition.id,
      locale: 'ca',
      label: 'Connector de càrrega',
      settlement: { status: 'stale', provenance: 'mercaria' },
    });

    const rows = await db.execute<{ status: string; label: string; reviewer: string | null }>(sql`
      select status, label, reviewed_by_oxy_user_id as reviewer from attribute_labels
       where attribute_definition_id = ${definition.id} and locale = 'ca'
    `);
    const row = [...rows][0];
    expect(row?.label).toBe('Connector de càrrega');
    expect(row?.status, 'the conflict branch left the previous verdict on new text').toBe('stale');
    expect(row?.reviewer, 'the previous reviewer stayed on text they never saw').toBeNull();
  }, 60_000);
});
