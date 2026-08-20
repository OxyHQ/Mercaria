/**
 * Publishing a product-type version carries its predecessor's translations —
 * at BOTH grains — against a REAL Postgres server (#650, ADR 0007 D5/D10).
 *
 * ## What was wrong, and why nothing reported it
 *
 * `copyForwardProductTypeLocalizations` existed, was tested, and had ZERO
 * production callers: its own docblock said "runs in the caller's transaction
 * so it commits with the publish that caused it" about a caller that did not
 * exist. `publishProductTypeVersion` deprecated the incumbent, flipped the new
 * version live, and copied nothing. A v2 shipped every market untranslated,
 * with every surface reporting success.
 *
 * The per-field grain was worse, because it had no copy forward at all:
 * `product_type_field_localizations` hangs off a `product_type_fields` ROW,
 * a new version's fields are NEW ROWS, and the foreign key is `ON DELETE
 * cascade` — so a merchant's authoring copy in Catalan simply ceased to exist.
 *
 * ## Why a real server, and why through the SERVICE
 *
 * A mocked repository accepts any statement, and every property here is one the
 * database holds: the two localization tables' unique indexes are what makes a
 * retry converge, `mercaria_product_type_child_frozen` is what decides whether
 * these rows may be written for a version that has just gone live, and the
 * `_missing_text_check` / `_reviewed_audit_check` pair is what decides whether a
 * carried row is representable at all. And it is driven through
 * `publishProductTypeVersion` rather than by calling the two repositories,
 * because "the function exists" and "the publish calls it" is exactly the
 * distinction this issue is about — a test that called the repository directly
 * would have been green for the whole time the bug was live.
 *
 * ## The premise every case rests on
 *
 * `v2`'s field rows have DIFFERENT ids from `v1`'s. Without asserting that, a
 * copy forward that joined on the row id would pass every assertion below. It
 * is asserted explicitly rather than assumed.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite across parallel workers, so
 * every key here carries a per-run suffix and teardown deletes exactly what this
 * file created — `product-type.realdb.test.ts`'s discipline, including its
 * ordering ruling: unpublish FIRST, because the child freeze refuses to delete
 * a published version's fields.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories } from '../../db/schema/catalog.js';
import { attributeDefinitions } from '../../db/schema/attributeRegistry.js';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
  productTypeFieldGroups,
  productTypeFields,
} from '../../db/schema/productTypes.js';
import {
  productTypeFieldLocalizations,
  productTypeLocalizations,
} from '../../db/schema/catalogLocalization.js';
import { publishProductTypeVersion } from '../product-types/product-type.service.js';
import { copyForwardProductTypeFieldLocalizations } from '../../db/catalogLocalization/productTypeFieldLocalizationRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

/**
 * A version number this file owns.
 *
 * `attribute_definitions` is unique on `(key, version)` and the keys below are
 * plausible ones for a sibling to define at version 1, so this file works high
 * up where nothing else does.
 */
const ATTR_VERSION = 700_000 + (Number.parseInt(RUN.slice(-4), 36) % 90_000);

const createdDefinitionIds: string[] = [];
const createdAttributeIds: string[] = [];
const createdCategoryIds: string[] = [];

const OPERATOR = `oxy_op_${RUN}`;

/** A product-type key this file owns, in the shape the key CHECK requires. */
function typeKey(name: string): string {
  return `ptl_${name}_${RUN}`.toLowerCase().replace(/[^a-z0-9_]/gu, '_');
}

/**
 * Assert a refusal, reading `cause` — and FAIL when the call was accepted.
 *
 * A drizzle error's message is its `Failed query:` wrapper, so a bare
 * `rejects.toThrow(/…/)` passes for a fixture typo or any other constraint. The
 * accepted branch is asserted first, because "nothing threw" is the outcome a
 * refusal test most needs to be loud about.
 */
async function expectRefusal(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a refusal, but the call was ACCEPTED').toBeDefined();
  const cause = (thrown as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? (thrown as { message?: string }).message ?? thrown)).toMatch(
    pattern,
  );
}

interface Attribute {
  readonly id: string;
  readonly key: string;
  readonly version: number;
}

async function makeAttribute(key: string, version = ATTR_VERSION): Promise<Attribute> {
  const [row] = await db
    .insert(attributeDefinitions)
    .values({
      key,
      version,
      lifecycleState: 'draft',
      label: `Attribute ${key}`,
      valueType: 'string',
    })
    .returning();
  createdAttributeIds.push(row.id);
  return { id: row.id, key: row.key, version: row.version };
}

/** A draft version of one key, scoped to this file's category. */
async function makeVersion(
  key: string,
  version: number,
  overrides: Partial<typeof productTypeDefinitions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(productTypeDefinitions)
    .values({
      key,
      version,
      name: `Product type ${key} v${String(version)}`,
      lifecycle: 'draft',
      ...overrides,
    })
    .returning();
  createdDefinitionIds.push(row.id);
  await db
    .insert(productTypeCategoryScopes)
    .values({ productTypeDefinitionId: row.id, categoryId: category });
  return row.id;
}

async function addField(
  definitionId: string,
  attribute: Attribute,
  overrides: Partial<typeof productTypeFields.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(productTypeFields)
    .values({
      productTypeDefinitionId: definitionId,
      attributeDefinitionId: attribute.id,
      attributeKey: attribute.key,
      attributeDefinitionVersion: attribute.version,
      scope: 'product',
      flow: 'merchant',
      requirement: 'optional',
      valuePolicy: 'typed_scalar',
      ...overrides,
    })
    .returning();
  return row.id;
}

async function publish(definitionId: string): Promise<void> {
  const result = await publishProductTypeVersion(db, {
    definitionId,
    publishedByOxyUserId: OPERATOR,
  });
  // Never `expect(result.outcome).toBe('published')` alone: a refusal carries a
  // `detail` that says WHICH check refused, and losing it turns every fixture
  // mistake into the same opaque red.
  expect(
    result.outcome === 'published' ? 'published' : `refused: ${result.detail}`,
    'the fixture could not be published',
  ).toBe('published');
}

let category: string;
let storage: Attribute;
let colour: Attribute;

beforeAll(async () => {
  db = await connectPostgres();

  const [row] = await db
    .insert(categories)
    .values({
      key: `ptl_cat_${RUN}`.toLowerCase(),
      name: `Product type localization ${RUN}`,
      slug: `ptl-cat-${RUN}`,
    })
    .returning();
  createdCategoryIds.push(row.id);
  category = row.id;

  storage = await makeAttribute(`ptl_storage_${RUN}`.toLowerCase());
  colour = await makeAttribute(`ptl_colour_${RUN}`.toLowerCase());
}, 120_000);

afterAll(async () => {
  if (!db) return;
  if (createdDefinitionIds.length > 0) {
    // Unpublish FIRST: `mercaria_product_type_child_frozen` refuses to delete a
    // field belonging to a published version — the trigger doing its job, in a
    // teardown. Field localizations follow their field by cascade, and version
    // localizations follow their definition the same way.
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'draft', publishedAt: null, publishedByOxyUserId: null, deprecatedAt: null })
      .where(inArray(productTypeDefinitions.id, createdDefinitionIds));
    await db
      .delete(productTypeFields)
      .where(inArray(productTypeFields.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeFieldGroups)
      .where(inArray(productTypeFieldGroups.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeCategoryScopes)
      .where(inArray(productTypeCategoryScopes.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeDefinitions)
      .where(inArray(productTypeDefinitions.id, createdDefinitionIds));
  }
  if (createdAttributeIds.length > 0) {
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, createdAttributeIds));
  }
  if (createdCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
}, 120_000);

/** Every version-level localization row a version holds. */
async function versionRows(definitionId: string) {
  return db
    .select()
    .from(productTypeLocalizations)
    .where(eq(productTypeLocalizations.productTypeDefinitionId, definitionId));
}

/** Every per-field localization row a version's fields hold, with the field. */
async function fieldRows(definitionId: string) {
  return db
    .select({
      locale: productTypeFieldLocalizations.locale,
      status: productTypeFieldLocalizations.status,
      label: productTypeFieldLocalizations.label,
      helpText: productTypeFieldLocalizations.helpText,
      placeholder: productTypeFieldLocalizations.placeholder,
      reviewedByOxyUserId: productTypeFieldLocalizations.reviewedByOxyUserId,
      fieldId: productTypeFields.id,
      attributeKey: productTypeFields.attributeKey,
    })
    .from(productTypeFieldLocalizations)
    .innerJoin(
      productTypeFields,
      eq(productTypeFieldLocalizations.productTypeFieldId, productTypeFields.id),
    )
    .where(eq(productTypeFields.productTypeDefinitionId, definitionId));
}

describe('publishing a product-type version carries its predecessor translations', () => {
  it('carries BOTH grains onto the successor, joined on the attribute key', async () => {
    const key = typeKey('both_grains');
    const v1 = await makeVersion(key, 1);
    const v1Field = await addField(v1, storage, { label: 'Storage', helpText: 'How much space' });
    await publish(v1);

    // Seeded AFTER publication, which is the realistic order and the split the
    // schema makes deliberately: the CONTRACT is frozen, its wording in Spanish
    // is still a translator's to finish once it is live.
    await db.insert(productTypeLocalizations).values({
      productTypeDefinitionId: v1,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      name: 'Telefono',
      description: 'Un telefono',
      reviewedByOxyUserId: OPERATOR,
      reviewedAt: new Date(),
    });
    await db.insert(productTypeFieldLocalizations).values({
      productTypeFieldId: v1Field,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      label: 'Almacenamiento',
      helpText: 'Cuanto espacio',
      reviewedByOxyUserId: OPERATOR,
      reviewedAt: new Date(),
    });

    const v2 = await makeVersion(key, 2);
    const v2Field = await addField(v2, storage, { label: 'Storage', helpText: 'How much space' });

    // THE PREMISE. A copy forward joining on the row id would satisfy every
    // assertion below if these were equal, so the join being a real one is
    // asserted rather than assumed.
    expect(v2Field, 'a new version reuses its predecessor field row id').not.toBe(v1Field);

    await publish(v2);

    const version = await versionRows(v2);
    expect(version, 'the version-level text did not reach v2').toHaveLength(1);
    expect(version[0].name).toBe('Telefono');
    // The reviewer travels with the text, so a queue can say who settled it.
    expect(version[0].reviewedByOxyUserId).toBe(OPERATOR);

    const fields = await fieldRows(v2);
    expect(fields, 'the per-field authoring copy did not reach v2').toHaveLength(1);
    expect(fields[0].label).toBe('Almacenamiento');
    expect(fields[0].fieldId).toBe(v2Field);
    // Nothing moved: the wording of this question is byte-identical in v2, so
    // the carried row is still settled work rather than a review task.
    expect(fields[0].status).toBe('approved');
  });

  it('stales a field translation whose base wording moved, and only that one', async () => {
    const key = typeKey('field_stale');
    const v1 = await makeVersion(key, 1);
    const rewritten = await addField(v1, storage, {
      label: 'Storage',
      helpText: 'How much space',
      placeholder: 'e.g. 128 GB',
    });
    const untouched = await addField(v1, colour, { label: 'Colour' });
    await publish(v1);

    await db.insert(productTypeFieldLocalizations).values([
      {
        productTypeFieldId: rewritten,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        label: 'Almacenamiento',
        helpText: 'Cuanto espacio',
        reviewedByOxyUserId: OPERATOR,
        reviewedAt: new Date(),
      },
      {
        // Holds NO help text, so a rewritten help text says nothing about it.
        productTypeFieldId: rewritten,
        locale: 'fr',
        status: 'approved',
        provenance: 'professional',
        label: 'Stockage',
        reviewedByOxyUserId: OPERATOR,
        reviewedAt: new Date(),
      },
      {
        productTypeFieldId: untouched,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        label: 'Color',
        reviewedByOxyUserId: OPERATOR,
        reviewedAt: new Date(),
      },
    ]);

    const v2 = await makeVersion(key, 2);
    await addField(v2, storage, {
      label: 'Storage',
      // The question moved. The label did not.
      helpText: 'Usable space after the operating system',
      placeholder: 'e.g. 128 GB',
    });
    await addField(v2, colour, { label: 'Colour' });
    await publish(v2);

    const fields = await fieldRows(v2);
    expect(fields).toHaveLength(3);
    const es = fields.find((row) => row.attributeKey === storage.key && row.locale === 'es');
    const fr = fields.find((row) => row.attributeKey === storage.key && row.locale === 'fr');
    const other = fields.find((row) => row.attributeKey === colour.key);

    // Holds help text for a help text that was rewritten.
    expect(es.status).toBe('stale');
    // Stale never blanks: the Spanish is still the best text available.
    expect(es.helpText).toBe('Cuanto espacio');
    // Holds NO help text, so nothing it carries stopped being true. A naive
    // "any column changed => stale the field" would report this one stale and
    // fill the translation queue with work nobody owes.
    expect(fr.status).toBe('approved');
    // A different field entirely. Untouched.
    expect(other.status).toBe('approved');
  });

  it('stales a field translation whose base text ARRIVED where there was none', async () => {
    // NULL -> text is the case a `both non-null and different` comparison
    // misses: absent means "use the cited attribute's own wording", so a field
    // that gained an override is asking a different question in the same box.
    const key = typeKey('override_added');
    const v1 = await makeVersion(key, 1);
    const field = await addField(v1, storage, { label: 'Storage' });
    await publish(v1);
    await db.insert(productTypeFieldLocalizations).values({
      productTypeFieldId: field,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      label: 'Almacenamiento',
      placeholder: 'p. ej. 128 GB',
      reviewedByOxyUserId: OPERATOR,
      reviewedAt: new Date(),
    });

    const v2 = await makeVersion(key, 2);
    await addField(v2, storage, { label: 'Storage', placeholder: 'e.g. 128 GB' });
    await publish(v2);

    const [row] = await fieldRows(v2);
    expect(row.status).toBe('stale');
    expect(row.placeholder).toBe('p. ej. 128 GB');
  });

  it('stales version text holding help text, and leaves a name that did not move settled', async () => {
    // The discriminator between the derived change and `{ kind: 'unknown' }`.
    // `product_type_definitions` has no `help_text` column, so a publish cannot
    // know whether the version-level help text still describes the version and
    // must report it changed. It CAN read `name`, so a locale holding only a
    // name that demonstrably did not move stays `approved` — which `unknown`
    // would have staled.
    const key = typeKey('version_grain');
    const v1 = await makeVersion(key, 1, { name: 'Smartphone', description: 'A phone' });
    await addField(v1, storage);
    await publish(v1);
    await db.insert(productTypeLocalizations).values([
      {
        productTypeDefinitionId: v1,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        name: 'Telefono',
        helpText: 'Rellena la ficha',
        reviewedByOxyUserId: OPERATOR,
        reviewedAt: new Date(),
      },
      {
        productTypeDefinitionId: v1,
        locale: 'fr',
        status: 'approved',
        provenance: 'professional',
        name: 'Telephone',
        reviewedByOxyUserId: OPERATOR,
        reviewedAt: new Date(),
      },
    ]);

    const v2 = await makeVersion(key, 2, { name: 'Smartphone', description: 'A phone' });
    await addField(v2, storage);
    await publish(v2);

    const rows = await versionRows(v2);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.locale === 'es').status).toBe('stale');
    expect(rows.find((row) => row.locale === 'fr').status).toBe('approved');
  });

  it('carries nothing for a field the new version dropped, and leaves an added one empty', async () => {
    const key = typeKey('shape_change');
    const v1 = await makeVersion(key, 1);
    const dropped = await addField(v1, colour, { label: 'Colour' });
    await addField(v1, storage, { label: 'Storage' });
    await publish(v1);
    await db.insert(productTypeFieldLocalizations).values({
      productTypeFieldId: dropped,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      label: 'Color',
      reviewedByOxyUserId: OPERATOR,
      reviewedAt: new Date(),
    });

    const v2 = await makeVersion(key, 2);
    await addField(v2, storage, { label: 'Storage' });
    await publish(v2);

    // A field the new version does not declare has nowhere for its text to go,
    // and one it added has no text to receive. Neither is an error and neither
    // invents a row.
    expect(await fieldRows(v2)).toHaveLength(0);
  });

  it('copies nothing on a FIRST publication, where there is no predecessor', async () => {
    const key = typeKey('first_publish');
    const v1 = await makeVersion(key, 1);
    await addField(v1, storage);
    await publish(v1);
    expect(await versionRows(v1)).toHaveLength(0);
    expect(await fieldRows(v1)).toHaveLength(0);
  });

  it('never overwrites a translation somebody already wrote against the successor', async () => {
    // The copy forward is `ON CONFLICT DO NOTHING` because a publish path may be
    // retried, and by the second attempt a translator may have written the new
    // version's Spanish. Driven at the repository, because the publication CAS
    // makes a second publish of one version unreachable — which is exactly why
    // the repository has to hold the property on its own.
    const key = typeKey('retry_converges');
    const v1 = await makeVersion(key, 1);
    const oldField = await addField(v1, storage, { label: 'Storage' });
    await publish(v1);
    await db.insert(productTypeFieldLocalizations).values({
      productTypeFieldId: oldField,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      label: 'Almacenamiento',
      reviewedByOxyUserId: OPERATOR,
      reviewedAt: new Date(),
    });

    const v2 = await makeVersion(key, 2);
    const newField = await addField(v2, storage, { label: 'Storage' });
    await publish(v2);
    // The publish already carried it, so a re-run has nothing to write.
    const again = await copyForwardProductTypeFieldLocalizations(v1, v2, db);
    expect(again).toEqual({ copied: 0, staleOnArrival: 0, skippedExisting: 1 });

    const [row] = await fieldRows(v2);
    expect(row.fieldId).toBe(newField);
    expect(row.label).toBe('Almacenamiento');
  });

  it('refuses a copy forward whose target field identity is ambiguous', async () => {
    // Two fields in one flow AND one scope citing two versions of ONE attribute
    // key. `product_type_fields_flow_attribute_key` is unique on the attribute
    // DEFINITION id rather than on its key, so the shape is representable — and
    // there is no non-arbitrary answer to which of the two a translation
    // belongs on. A loud refusal beats moving somebody's text onto a question
    // they did not translate.
    const key = typeKey('ambiguous');
    const other = await makeAttribute(storage.key, ATTR_VERSION + 1);
    const v1 = await makeVersion(key, 1);
    await addField(v1, storage, { label: 'Storage' });
    const v2 = await makeVersion(key, 2);
    await addField(v2, storage, { label: 'Storage' });
    await addField(v2, other, { label: 'Storage again' });

    await expectRefusal(/declares "merchant:product:.+" twice/u, () =>
      copyForwardProductTypeFieldLocalizations(v1, v2, db),
    );
  });

  it('does not resurrect a withdrawn field translation onto a new meaning', async () => {
    const key = typeKey('withdrawn');
    const v1 = await makeVersion(key, 1);
    const field = await addField(v1, storage, { label: 'Storage' });
    await publish(v1);
    await db.insert(productTypeFieldLocalizations).values({
      productTypeFieldId: field,
      locale: 'es',
      status: 'deprecated',
      provenance: 'community_reviewed',
      label: 'Almacenamiento retirado',
    });

    const v2 = await makeVersion(key, 2);
    await addField(v2, storage, { label: 'Storage' });
    await publish(v2);

    // A withdrawal was a decision about the old wording. The successor simply
    // having no row reads correctly as "not translated".
    expect(await fieldRows(v2)).toHaveLength(0);
  });

  it('carries a `missing` field row without staling it', async () => {
    const key = typeKey('missing_row');
    const v1 = await makeVersion(key, 1);
    const field = await addField(v1, storage, { label: 'Storage' });
    await publish(v1);
    await db.insert(productTypeFieldLocalizations).values({
      productTypeFieldId: field,
      locale: 'es',
      status: 'missing',
      provenance: 'mercaria',
    });

    const v2 = await makeVersion(key, 2);
    // The wording moved, which would stale a row that held text.
    await addField(v2, storage, { label: 'Onboard storage' });
    await publish(v2);

    const [row] = await fieldRows(v2);
    // A `missing` row holds nothing to be stale, and
    // `product_type_field_localizations_missing_text_check` ties `missing` to a
    // NULL label — so staling it would be REFUSED by the server rather than
    // merely misleading.
    expect(row.status).toBe('missing');
    expect(row.label).toBeNull();
  });
});

describe('the fixtures this file relies on', () => {
  it('leaves each published version pointing at the category it was scoped to', async () => {
    // The vacuity floor. Every case above asserts on rows reached through
    // `product_type_fields.product_type_definition_id`, so a fixture that
    // silently created nothing would satisfy the `toHaveLength(0)` cases and
    // make the `toHaveLength(1)` ones the only thing holding the file up.
    const scopes = await db
      .select({ id: productTypeCategoryScopes.id })
      .from(productTypeCategoryScopes)
      .where(
        and(
          inArray(productTypeCategoryScopes.productTypeDefinitionId, createdDefinitionIds),
          eq(productTypeCategoryScopes.categoryId, category),
        ),
      );
    expect(createdDefinitionIds.length, 'this file created no product-type version').toBeGreaterThan(
      10,
    );
    expect(scopes.length).toBe(createdDefinitionIds.length);
  });
});
