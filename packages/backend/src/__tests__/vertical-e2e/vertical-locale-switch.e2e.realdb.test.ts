/**
 * Switching locale mid-draft, and telling an ABSENT translation from a present
 * one that happens to read the same (#367 Workstream 18).
 *
 * ## What "locale switching mid-draft" turns out to mean here
 *
 * The epic asks for a locale switch mid-draft that leaves the draft's semantic
 * values intact. Measured against the schema rather than assumed: a draft's
 * `locale` is FROZEN at creation by
 * `catalog_authoring_drafts_pins_frozen` (ADR 0007 D5), and no service
 * signature, HTTP schema or `DraftPatch` member accepts a locale for an existing
 * draft. So the property is stronger than "the values survive a switch" — the
 * switch is unrepresentable, and what a merchant switching language actually
 * does is re-READ the same draft through a schema composed in the new locale.
 *
 * This file therefore asserts three things rather than one:
 *
 *  1. the database REFUSES to move a draft's locale, with a control that shows
 *     the same WHERE predicate reaching the row (a different SET clause on it
 *     succeeds), so the refusal is a refusal and not a predicate matching nothing;
 *  2. re-composing the schema in the second locale moves every STRING and no
 *     RULE — asserted in both directions, so it cannot pass against a composer
 *     that stopped localizing;
 *  3. the draft's stored values are byte-identical across the switch and the
 *     draft is still publishable, which is the epic's own "the draft's semantic
 *     values must survive".
 *
 * ## The fallback case, and the trap it is written against
 *
 * A test that asserts only the returned STRING cannot tell "there is no `fr`
 * translation, so you are reading English" from "there is a `fr` translation and
 * it happens to be the English words". Both answer the same `value`. The
 * discriminators are `effectiveLocale` and `step`, and this file drives the same
 * field through both states — inserting a `fr` row whose text EQUALS the base
 * string on purpose — and then removes it again to show the assertion notices.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { AuthoringSchema } from '@mercaria/shared-types';

import { connectPostgres, type Database } from '../../db/postgres.js';
import { findCategoryByKey } from '../../db/taxonomy/taxonomyRepository.js';
import { listDraftValues } from '../../db/catalogAuthoring/draftRepository.js';
import { upsertCategoryLocalization } from '../../db/catalogLocalization/categoryLocalizationRepository.js';
import { readLocalizedCategories } from '../../services/catalog-localization/read.service.js';
import { localeFallbackChain } from '../../services/catalog-localization/resolve.js';
import { createDraft, patchDraft, readDraft, validateStoreDraft } from '../../services/catalog-authoring/draft.service.js';
import { composeAuthoringSchemaForDefinitionId } from '../../services/catalog-authoring/schema.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../scripts/seed-verticals/apply.js';
import { FOOTWEAR_PACKAGE } from '../../scripts/seed-verticals/footwear.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import {
  E2E_PERMISSIONS,
  enumValueId,
  reportPopulation,
  semanticFingerprint,
  textFingerprint,
} from './journey.js';

/** The locale the draft is authored in, and the one the merchant switches to. */
const AUTHORED_LOCALE = 'en';
const SWITCHED_LOCALE = 'es';

/**
 * A language the footwear package translates NOTHING into.
 *
 * `fr` and not `de`: the package carries German category names, so a German
 * request would answer `exact` before this file wrote anything and the absent
 * half of the comparison would be unreachable.
 */
const UNTRANSLATED_LOCALE = 'fr';

/** The men's department's own base-locale name, which the seed states. */
const MENS_BASE_NAME = "Men's running shoes";

const TOKEN = verticalRunToken('ls');

const db: Database = await connectPostgres();
let seeded: SeededVertical;
let ns: VerticalNamespace;
let mensCategoryId: string;
let storeId: string;
let draftId: string;
let draftVersion: number;
let definitionId: string;

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, FOOTWEAR_PACKAGE, TOKEN);
  ns = seeded.ns;
  const mens = await findCategoryByKey(nsCategoryKey(ns, 'athletic.mens_running_shoes'), db);
  if (!mens) throw new Error('the seeded department did not resolve');
  mensCategoryId = mens.id;
  expect(mens.name).toBe(MENS_BASE_NAME);

  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Locale warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);

  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: seeded.actorOxyUserId,
    categoryId: mensCategoryId,
    productTypeKey: nsKey(ns, 'athletic_footwear'),
    flow: 'merchant',
    locale: AUTHORED_LOCALE,
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    idempotencyKey: null,
    title: 'Locale-switch fixture shoe',
  });

  const patched = await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'Authored in English, then read in Spanish.',
    fields: [
      {
        attributeKey: nsKey(ns, 'upper_material'),
        values: [{ enumValueId: await enumValueId(db, ns, 'upper_material', 'mesh') }],
      },
    ],
    variants: [
      {
        sku: `${TOKEN}-LS-42-BLACK`,
        inventoryAvailable: 2,
        price: { amount: 11900, currency: 'EUR' },
        axes: [
          {
            attributeKey: nsKey(ns, 'shoe_size_eu'),
            values: [{ enumValueId: await enumValueId(db, ns, 'shoe_size_eu', '42') }],
          },
          {
            attributeKey: nsKey(ns, 'footwear_color'),
            values: [{ enumValueId: await enumValueId(db, ns, 'footwear_color', 'black') }],
          },
          {
            attributeKey: nsKey(ns, 'shoe_width'),
            values: [{ enumValueId: await enumValueId(db, ns, 'shoe_width', 'standard') }],
          },
        ],
      },
    ],
  });
  draftId = patched.id;
  draftVersion = patched.version;
  definitionId = patched.productType.definitionId;
}, 300_000);

afterAll(async () => {
  // This file's own localization rows go first: the categories survive teardown
  // (they are retired, not deleted), so nothing would cascade them away.
  await db.execute(sql`
    delete from category_localizations
    where category_id = ${mensCategoryId} and locale = ${UNTRANSLATED_LOCALE}
  `);
  await teardownVertical(db, TOKEN);
}, 300_000);

/** The draft's stored answers, reduced to the columns that carry MEANING. */
async function semanticValues(): Promise<readonly string[]> {
  const rows = await listDraftValues(db, draftId);
  return rows
    .map((row) =>
      [
        row.fieldId,
        row.attributeDefinitionId,
        row.attributeKey,
        String(row.attributeDefinitionVersion),
        row.scope,
        String(row.ordinal),
        row.componentAxis ?? '-',
        row.kind,
        row.valueText ?? '-',
        row.valueNumber === null ? '-' : String(row.valueNumber),
        row.valueBoolean === null ? '-' : String(row.valueBoolean),
        row.valueEnumValueId ?? '-',
        row.canonicalRefKind ?? '-',
        row.canonicalRefId ?? '-',
        row.unit ?? '-',
      ].join('|'),
    )
    .sort();
}

/** Compose the draft's own pinned schema in one locale. */
async function composeIn(locale: string): Promise<AuthoringSchema> {
  const composed = await composeAuthoringSchemaForDefinitionId(db, definitionId, {
    categoryId: mensCategoryId,
    flow: 'merchant',
    requestedLocale: locale,
    market: 'ES',
    permissions: E2E_PERMISSIONS,
  });
  if (composed.outcome !== 'composed') {
    throw new Error(`composition refused in ${locale}: ${composed.detail}`);
  }
  return composed.schema;
}

describe("a draft's locale cannot be moved", () => {
  it('is REFUSED by the database, with its WHERE predicate proven to reach the row', async () => {
    // The control first, so the refusal below is a refusal rather than a
    // predicate that matched nothing. Same predicate, a SET clause the pins
    // trigger does not freeze — `title` is not one of the six frozen columns.
    const touched = await db.execute(sql`
      update catalog_authoring_drafts set title = ${'Locale-switch fixture shoe'}
      where id = ${draftId} returning id
    `);
    expect([...touched]).toHaveLength(1);

    let raised: unknown;
    try {
      await db.execute(sql`
        update catalog_authoring_drafts set locale = ${SWITCHED_LOCALE} where id = ${draftId}
      `);
    } catch (error) {
      raised = error;
    }
    expect(raised, 'the trigger permitted the locale to move').toBeDefined();
    // The trigger's own text lives on `cause`; drizzle's own message is the
    // `Failed query:` wrapper, so matching that would pass against ANY failure.
    const cause = raised instanceof Error ? raised.cause : undefined;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    expect(causeMessage).toContain('frozen at creation');
    expect(causeMessage).toContain('locale');

    // And the row is untouched, so the rest of the file reads the draft it built.
    const after = await readDraft(db, storeId, draftId);
    expect(after.locale).toBe(AUTHORED_LOCALE);
    expect(after.version).toBe(draftVersion);
  });

  it('offers no service, patch or route parameter that could move it either', async () => {
    // Stated as a shape rather than as a scan: `PatchDraftInput` has no locale
    // member, so this call is what a "switch the locale" patch would have to
    // look like, and it does not type-check with one. Re-patching the title
    // through the real service leaves the locale exactly where it was.
    const patched = await patchDraft(db, {
      storeId,
      draftId,
      expectedVersion: draftVersion,
      permissions: E2E_PERMISSIONS,
      title: 'Locale-switch fixture shoe',
    });
    expect(patched.locale).toBe(AUTHORED_LOCALE);
    expect(patched.market).toBe('ES');
    draftVersion = patched.version;
  });
});

describe('re-reading the draft in the second locale', () => {
  it('moves every STRING and no RULE', async () => {
    const authored = await composeIn(AUTHORED_LOCALE);
    const switched = await composeIn(SWITCHED_LOCALE);

    // Both directions. Equality alone would pass against a composer that had
    // stopped localizing; difference alone would pass against one that had
    // started varying a requirement, a value set or a visibility rule by locale.
    expect(semanticFingerprint(authored)).toBe(semanticFingerprint(switched));
    expect(textFingerprint(authored)).not.toBe(textFingerprint(switched));

    // The identities behind the fingerprint, named, so a reader can see WHICH
    // things are being held equal.
    expect(switched.fields.map((field) => field.id)).toEqual(
      authored.fields.map((field) => field.id),
    );
    expect(switched.fields.map((field) => field.requirement)).toEqual(
      authored.fields.map((field) => field.requirement),
    );
    const colourKey = nsKey(ns, 'footwear_color');
    const authoredColour = authored.fields.find((field) => field.key === colourKey);
    const switchedColour = switched.fields.find((field) => field.key === colourKey);
    expect(authoredColour).toBeDefined();
    expect(switchedColour).toBeDefined();
    if (!authoredColour || !switchedColour) return;
    // The controlled VALUES are the same ids and the same stable values; only
    // their labels move, and those live in `text.values` keyed by the same ids.
    expect(switchedColour.controlledValues.map((value) => `${value.id}:${value.value}`)).toEqual(
      authoredColour.controlledValues.map((value) => `${value.id}:${value.value}`),
    );
    const blackId = authoredColour.controlledValues.find((value) => value.value === 'black')?.id;
    expect(blackId).toBeDefined();
    if (blackId === undefined) return;
    expect(authored.text.values[blackId]?.label?.value).toBe('Black');
    expect(switched.text.values[blackId]?.label?.value).toBe('Negro');

    reportPopulation('the locale switch', {
      fields: switched.fields.length,
      colourValues: switchedColour.controlledValues.length,
      localizedFieldLabels: Object.keys(switched.text.fields).length,
      localizedValueLabels: Object.keys(switched.text.values).length,
    });
  });

  it("leaves the draft's stored answers byte-identical, and still publishable", async () => {
    const before = await semanticValues();
    // A vacuity floor: an empty snapshot would compare equal to another empty
    // one and the whole case would measure nothing.
    expect(before.length).toBeGreaterThanOrEqual(4);

    await composeIn(SWITCHED_LOCALE);
    const after = await semanticValues();
    expect(after).toEqual(before);

    // Every stored answer cites an ID, not a label — which is WHY the switch
    // cannot disturb them. Asserted rather than described: the colour answer
    // names the `black` controlled value's id and carries no Spanish string.
    const rows = await listDraftValues(db, draftId);
    const colourRow = rows.find((row) => row.attributeKey === nsKey(ns, 'footwear_color'));
    expect(colourRow).toBeDefined();
    expect(colourRow?.kind).toBe('controlled_value');
    expect(colourRow?.valueEnumValueId).toBeDefined();
    expect(colourRow?.valueText).toBeNull();

    const validation = await validateStoreDraft(db, {
      storeId,
      draftId,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the draft stopped being publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);
  });

  it('keeps the buyer-side identity of the category across the same switch', async () => {
    const [inEnglish] = await readLocalizedCategories([mensCategoryId], AUTHORED_LOCALE, db);
    const [inSpanish] = await readLocalizedCategories([mensCategoryId], SWITCHED_LOCALE, db);
    expect(inEnglish?.categoryId).toBe(mensCategoryId);
    expect(inSpanish?.categoryId).toBe(mensCategoryId);
    if (inEnglish?.name.outcome !== 'resolved' || inSpanish?.name.outcome !== 'resolved') {
      throw new Error('the category name did not resolve in one of the two locales');
    }
    // One identity, two presentations — #367's "support locale switching without
    // changing stored product/category/value identity".
    expect(inSpanish.name.value).not.toBe(inEnglish.name.value);
    expect(inEnglish.name.value).toBe(MENS_BASE_NAME);
    expect(inSpanish.name.value).toBe('Zapatillas de running de hombre');
  });
});

describe('the two fingerprints the locale claim rests on', () => {
  /**
   * The mutation self-test.
   *
   * `semanticFingerprint(a) === semanticFingerprint(b)` is the load-bearing
   * assertion of this whole file, and a digest that ignored what it hashes would
   * satisfy it forever. So each digest is shown to NOTICE a change in its own
   * half and to IGNORE a change in the other's — which is the property that makes
   * the pair able to separate a rule from a string at all.
   */
  it('notices a rule change and ignores a label change, and the reverse', async () => {
    const schema = await composeIn(AUTHORED_LOCALE);
    const [firstField] = schema.fields;
    expect(firstField, 'the schema declares no field to mutate').toBeDefined();
    if (firstField === undefined) return;

    const requirementMoved: AuthoringSchema = {
      ...schema,
      fields: [
        { ...firstField, requirement: firstField.requirement === 'required' ? 'optional' : 'required' },
        ...schema.fields.slice(1),
      ],
    };
    expect(semanticFingerprint(requirementMoved)).not.toBe(semanticFingerprint(schema));
    expect(textFingerprint(requirementMoved)).toBe(textFingerprint(schema));

    const labelMoved: AuthoringSchema = {
      ...schema,
      text: {
        ...schema.text,
        productTypeName: { value: 'mutated', effectiveLocale: 'en', step: 'exact', status: 'approved' },
      },
    };
    expect(textFingerprint(labelMoved)).not.toBe(textFingerprint(schema));
    expect(semanticFingerprint(labelMoved)).toBe(semanticFingerprint(schema));

    // And a key ORDER change moves neither: the digest sorts, so two locales
    // whose composer visited the same fields in a different order are not
    // reported as disagreeing about a rule.
    // A floor first: reversing one entry, or none, is a no-op, so without this
    // the key-order arm would pass while mutating nothing.
    expect(Object.keys(schema.text.fields).length).toBeGreaterThan(1);
    const reordered: AuthoringSchema = {
      ...schema,
      text: { ...schema.text, fields: Object.fromEntries(Object.entries(schema.text.fields).reverse()) },
    };
    expect(textFingerprint(reordered)).toBe(textFingerprint(schema));
  });
});

describe('an ABSENT translation and a present one that reads the same', () => {
  it('answer the same STRING and are still told apart', async () => {
    // The chain is asserted, not assumed: `fr` is a language Mercaria supports
    // and the footwear package translates nothing into, so the request falls
    // through to the base locale.
    expect([...localeFallbackChain(UNTRANSLATED_LOCALE, 'language_then_base')]).toEqual([
      'fr',
      'en',
    ]);

    const absent = await resolveName(UNTRANSLATED_LOCALE);
    expect(absent.value).toBe(MENS_BASE_NAME);
    expect(absent.effectiveLocale).toBe('en');
    expect(absent.step).toBe('base');

    // Now a REAL `fr` row whose text is EXACTLY the base string. This is the
    // case a test asserting only `value` cannot distinguish, and the reason this
    // whole case exists.
    await upsertCategoryLocalization(
      {
        categoryId: mensCategoryId,
        locale: UNTRANSLATED_LOCALE,
        status: 'approved',
        provenance: 'professional',
        name: MENS_BASE_NAME,
        sourceLocale: 'en',
        reviewedByOxyUserId: seeded.actorOxyUserId,
        reviewedAt: new Date(),
      },
      db,
    );

    const identical = await resolveName(UNTRANSLATED_LOCALE);
    // The same string, which is the point.
    expect(identical.value).toBe(absent.value);
    // And three independent discriminators, none of which is the string.
    expect(identical.effectiveLocale).toBe('fr');
    expect(identical.step).toBe('exact');
    expect(identical.basis).toBe('localization_row');
    expect(identical.provenance).toBe('professional');
    // The third discriminator was `provenance: 'mercaria'` until the base branch
    // stopped claiming an author it cannot know. `basis` replaces it and is
    // strictly stronger: an explicit statement of WHERE the answer came from,
    // rather than a provenance inferred from a constant the resolver filled in.
    expect(absent.basis).toBe('authored_base_text');
    expect(absent.provenance).toBeUndefined();

    reportPopulation('the fallback discriminators', {
      chainLength: localeFallbackChain(UNTRANSLATED_LOCALE, 'language_then_base').length,
      differingFields: [
        identical.effectiveLocale === absent.effectiveLocale ? 0 : 1,
        identical.step === absent.step ? 0 : 1,
        identical.basis === absent.basis ? 0 : 1,
      ].reduce((sum, flag) => sum + flag, 0),
      identicalStrings: identical.value === absent.value ? 1 : 0,
    });
  });

  it('flips back when the row is removed — so the assertion above notices', async () => {
    const present = await resolveName(UNTRANSLATED_LOCALE);
    expect(present.step).toBe('exact');

    const removed = await db.execute(sql`
      delete from category_localizations
      where category_id = ${mensCategoryId} and locale = ${UNTRANSLATED_LOCALE}
      returning locale
    `);
    // The mutation applied — an UPDATE or DELETE that matched nothing is
    // indistinguishable from one that was survived.
    expect([...removed]).toHaveLength(1);

    const again = await resolveName(UNTRANSLATED_LOCALE);
    expect(again.step).toBe('base');
    expect(again.effectiveLocale).toBe('en');
    expect(again.value).toBe(present.value);
  });

  it('walks PAST a row that exists but carries no servable text', async () => {
    // `missing` is a real stored status and it is NOT servable, so a row in this
    // state must read exactly like no row at all — which is a third case the
    // string alone cannot separate from either of the first two.
    await upsertCategoryLocalization(
      {
        categoryId: mensCategoryId,
        locale: UNTRANSLATED_LOCALE,
        status: 'missing',
        provenance: 'mercaria',
        name: null,
      },
      db,
    );
    const rows = await db.execute<{ status: string }>(sql`
      select status from category_localizations
      where category_id = ${mensCategoryId} and locale = ${UNTRANSLATED_LOCALE}
    `);
    // The row is really there, which is what makes "walks past it" a claim.
    expect([...rows].map((row) => row.status)).toEqual(['missing']);

    const answered = await resolveName(UNTRANSLATED_LOCALE);
    expect(answered.step).toBe('base');
    expect(answered.effectiveLocale).toBe('en');
    expect(answered.value).toBe(MENS_BASE_NAME);
  });
});

/** The men's department's localized name, or a thrown failure naming the locale. */
async function resolveName(locale: string): Promise<{
  readonly value: string;
  readonly effectiveLocale: string;
  readonly step: string;
  readonly basis: string;
  /**
   * Present ONLY when a localization row answered.
   *
   * A base answer has no translator to name, so the resolver reports none —
   * which is why `basis` is what this test discriminates on.
   */
  readonly provenance: string | undefined;
}> {
  const [presentation] = await readLocalizedCategories([mensCategoryId], locale, db);
  if (presentation === undefined || presentation.name.outcome !== 'resolved') {
    throw new Error(`the category name did not resolve in ${locale}`);
  }
  return {
    value: presentation.name.value,
    effectiveLocale: presentation.name.effectiveLocale,
    step: presentation.name.step,
    basis: presentation.name.basis,
    provenance:
      presentation.name.basis === 'localization_row' ? presentation.name.provenance : undefined,
  };
}
