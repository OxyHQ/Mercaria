/**
 * Does `composeAuthoringSchema` render an attribute definition differently once
 * its version is `deprecated` or `retired`? (issue #822, against a REAL server.)
 *
 * ## The question, and why it was open
 *
 * Two paths move an attribute definition version's lifecycle and only one bumps
 * the authoring-schema invalidation register:
 *
 * - `POST /internal/catalog-attributes/definitions/:key/versions/:version/deprecate`
 *   and `.../retire` call `deprecateAttributeDefinition`/`retireAttributeDefinition`
 *   and bump NOTHING;
 * - the governance `attribute_deprecate`/`attribute_retire` actions call the same
 *   two functions and then bump `attribute_values` (`catalog-governance/apply.ts`).
 *
 * `schemaInvalidationRepository.ts`'s header records that exactly this shape was
 * a real defect once (#655: a declared subject with no producer served an
 * approved translation stale until a restart) and warns that "neither half looks
 * incomplete on its own". So the asymmetry is worth settling rather than
 * shrugging at — but settling it means measuring the RENDER, because a bump is
 * owed only where a stale entry would be WRONG.
 *
 * ## The answer this file pins: it does not
 *
 * The composition reads the cited definition row by ID
 * (`listAttributeDefinitionsByIds`, no lifecycle predicate) and projects it
 * through `toValidation` plus its label and description. `lifecycle_state` is
 * not among the thirteen registry facts `AuthoringFieldValidation` carries,
 * `AuthoringField` has no lifecycle member at all, and the only `lifecycle` in
 * an `AuthoringSchema` is `productType.lifecycle` — the PRODUCT TYPE version's,
 * which is a different subject with its own `product_type` invalidation.
 * `transitionAttributeDefinition` writes `lifecycle_state` and `deprecated_at`
 * and nothing else, and `mercaria_attribute_definitions_localization_stale`
 * fires only on a `label`/`description` change, so a lifecycle move touches no
 * row this composition reads.
 *
 * That is a claim about code, and this file is the measurement of it. If a later
 * change makes the render lifecycle-dependent — a filter on `lifecycle_state`, a
 * `deprecated` flag on the field, a withdrawn controlled-value set — the first
 * two cases go RED, and the two routes then owe the bump `apply.ts` already
 * makes. Reading it as "the routes are fine" without this gate would be the
 * docblock-asserting-completeness shape the issue warns about.
 *
 * ## The controls, because "two schemas matched" is the easiest vacuous pass
 *
 * Three, and each rules out a different way this file could pass while measuring
 * nothing:
 *
 * 1. **Determinism.** Two compositions with the memo cleared between them are
 *    already equal. Without this, "equal after deprecating" could be a statement
 *    about a comparison that can never disagree.
 * 2. **The field is really there.** The schema is asserted to carry a field
 *    citing the exact definition under test, with a label and a controlled-value
 *    set. An attribute absent from the render trivially renders identically.
 * 3. **Sensitivity, in both halves of the answer.** A bump of the very subject
 *    the direct routes are accused of owing (`attribute_values` on this
 *    definition id) MUST change the schema — that is the positive control for
 *    the whole question, since it shows the comparison would have caught the
 *    bump had one been owed. And an edit to the definition's own
 *    `attribute_labels` row MUST change the composed field text, which shows the
 *    comparison reaches the attribute row itself and not merely the cache key.
 *
 * ## Why a real server
 *
 * The lifecycle move is a conditional `UPDATE` guarded by
 * `mercaria_attribute_definition_immutable`, the register is a table with an
 * `ON CONFLICT DO UPDATE` on it, and the memo key is built from a read of that
 * table. A mocked repository has none of the three, and a mocked `update`
 * accepts a statement the server would refuse.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AuthoringField, AuthoringSchema } from '@mercaria/shared-types';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { bumpAuthoringSchemaInvalidation } from '../../../db/catalogAuthoring/schemaInvalidationRepository.js';
import {
  deprecateAttributeDefinition,
  retireAttributeDefinition,
} from '../../attributes/definition-registry.service.js';
import { clearAuthoringSchemaMemo, composeAuthoringSchema } from '../schema.service.js';
import {
  nsCategoryKey,
  nsKey,
  type VerticalNamespace,
} from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS } from '../../../__tests__/vertical-e2e/journey.js';

const TOKEN = verticalRunToken('attrlc');
/**
 * Not the base locale, and the one the smartphone package authors attribute
 * labels in — so control 3b's label edit lands on a row the composition actually
 * reads rather than on a base string the chain never reaches.
 */
const LOCALE = 'es';

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let productTypeKey: string;

/** The field under test, and the definition version whose lifecycle will move. */
let subject: AuthoringField;
let subjectDefinitionId: string;
let subjectAttributeKey: string;
let subjectAttributeVersion: number;
/** What the `es` label row said before control 3b touched it, so it can be put back. */
let originalLabel: string | undefined;

async function compose(): Promise<AuthoringSchema> {
  const composition = await composeAuthoringSchema(db, {
    productTypeKey,
    categoryId,
    flow: 'merchant',
    requestedLocale: LOCALE,
    market: 'ES',
    permissions: E2E_PERMISSIONS,
  });
  if (composition.outcome !== 'composed') {
    throw new Error(`the schema refused: ${composition.refusal} — ${composition.detail}`);
  }
  return composition.schema;
}

/**
 * Compose with the memo emptied first.
 *
 * Every case here wants a FRESH render: the question is what the composition
 * builds, and a memo hit would answer with what it built before the lifecycle
 * moved — which would make the first two cases pass whatever the render does.
 */
async function composeFresh(): Promise<AuthoringSchema> {
  clearAuthoringSchemaMemo();
  return compose();
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;

  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  productTypeKey = nsKey(ns, 'smartphone');

  const schema = await composeFresh();
  // A controlled-value set makes the comparison carry the richest thing an
  // attribute contributes; a NON variant-capable field keeps this file's
  // lifecycle move away from the axes the seeded products are built on.
  const candidate =
    schema.fields.find((field) => field.controlledValues.length > 0 && !field.variantCapable) ??
    schema.fields.find((field) => field.controlledValues.length > 0);
  if (candidate === undefined) {
    throw new Error('the seeded schema declares no field with a controlled-value set');
  }
  subject = candidate;
  subjectDefinitionId = candidate.attributeDefinitionId;
  subjectAttributeKey = candidate.key;
  subjectAttributeVersion = candidate.attributeVersion;

  const rows = await db.execute<{ label: string }>(sql`
    select label from attribute_labels
     where attribute_definition_id = ${subjectDefinitionId} and locale = ${LOCALE}
  `);
  originalLabel = [...rows][0]?.label;
}, 300_000);

afterAll(async () => {
  if (originalLabel !== undefined) {
    await db.execute(sql`
      update attribute_labels set label = ${originalLabel}
       where attribute_definition_id = ${subjectDefinitionId} and locale = ${LOCALE}
    `);
  }
  // The definition version stays `retired`. `mercaria_attribute_definition_immutable`
  // refuses to delete a version that has left `draft`, which is why
  // `vertical-fixture.ts` retains attribute definitions at all; this file leaves
  // one of its OWN namespace's thirteen in a stricter state than it found it, and
  // every read that could reach it is scoped to this run's deprecated category.
  await teardownVertical(db, TOKEN);
}, 300_000);

beforeEach(() => {
  // Process state shared with every other file in this worker.
  clearAuthoringSchemaMemo();
});

describe('the composition reads the attribute under test', () => {
  it('renders it as a field with text and controlled values', async () => {
    // Control 2. An attribute that is not in the render renders identically
    // whatever its lifecycle, so this is the floor under both lifecycle cases.
    const schema = await composeFresh();
    const field = schema.fields.find(
      (entry) => entry.attributeDefinitionId === subjectDefinitionId,
    );
    expect(field, 'the schema no longer carries the field this file measures').toBeDefined();
    expect(
      field === undefined ? 0 : field.controlledValues.length,
      'the field under test lost its controlled values',
    ).toBeGreaterThan(0);
    expect(
      schema.text.fields[subject.id]?.label?.value,
      'the field under test carries no label, so a label comparison would measure nothing',
    ).toBeTruthy();
  }, 120_000);

  it('composes deterministically, so an equality assertion can disagree', async () => {
    // Control 1.
    const first = await composeFresh();
    const second = await composeFresh();
    expect(
      second,
      'two fresh compositions of one input already differ, so nothing below is a measurement',
    ).toEqual(first);
  }, 120_000);
});

describe('DEPRECATING the cited attribute definition version', () => {
  it('renders exactly the same authoring schema, ETag included', async () => {
    const before = await composeFresh();

    const deprecated = await deprecateAttributeDefinition(
      subjectAttributeKey,
      subjectAttributeVersion,
    );
    // The premise: the lifecycle really moved. Without this the case passes by
    // comparing two renders of an unchanged row.
    expect(
      deprecated.lifecycleState,
      'the definition version did not reach `deprecated`, so nothing was measured',
    ).toBe('deprecated');

    const after = await composeFresh();
    expect(
      after,
      "the authoring schema now depends on an attribute definition version's lifecycle. " +
        'The two direct routes (deprecateDefinitionHandler / retireDefinitionHandler) therefore ' +
        "owe bumpAuthoringSchemaInvalidation({ subject: 'attribute_values', subjectId }), " +
        'symmetrically with catalog-governance/apply.ts. See issue #822.',
    ).toEqual(before);
  }, 120_000);
});

describe('RETIRING the cited attribute definition version', () => {
  it('renders exactly the same authoring schema, ETag included', async () => {
    const before = await composeFresh();

    const retired = await retireAttributeDefinition(subjectAttributeKey, subjectAttributeVersion);
    expect(
      retired.lifecycleState,
      'the definition version did not reach `retired`, so nothing was measured',
    ).toBe('retired');

    const after = await composeFresh();
    expect(
      after,
      "the authoring schema now depends on an attribute definition version's lifecycle. " +
        'The two direct routes therefore owe the bump catalog-governance/apply.ts makes. ' +
        'See issue #822.',
    ).toEqual(before);
  }, 120_000);
});

describe('the comparison above CAN disagree', () => {
  it('a bump of `attribute_values` on this definition changes the schema', async () => {
    // Control 3a, and the positive control for the whole issue: this is exactly
    // the write the direct routes are accused of omitting. If the comparison
    // could not see it, "identical after deprecating" would say nothing about
    // whether a bump is owed.
    const before = await composeFresh();
    await bumpAuthoringSchemaInvalidation(db, {
      subject: 'attribute_values',
      subjectId: subjectDefinitionId,
    });
    const after = await composeFresh();
    expect(
      after.etag,
      'bumping `attribute_values` left the ETag unchanged, so the two lifecycle cases above ' +
        'are comparing something that cannot move',
    ).not.toBe(before.etag);
    expect(after, 'bumping `attribute_values` left the whole schema unchanged').not.toEqual(before);
  }, 120_000);

  it('an edit to the definition label row changes the composed field text', async () => {
    // Control 3b: the comparison reaches the ATTRIBUTE row's contribution to the
    // BODY, not only the cache key. `attribute_labels` is deliberately outside
    // `mercaria_attribute_definition_immutable`'s frozen column set, so this is
    // an ordinary write rather than a fixture violation.
    if (originalLabel === undefined) {
      throw new Error(`the seed wrote no ${LOCALE} label for the attribute under test`);
    }
    const before = await composeFresh();
    const edited = `${originalLabel} ${TOKEN}`;
    await db.execute(sql`
      update attribute_labels set label = ${edited}
       where attribute_definition_id = ${subjectDefinitionId} and locale = ${LOCALE}
    `);

    const after = await composeFresh();
    expect(
      after.text.fields[subject.id]?.label?.value,
      "the composed field label did not follow the attribute's own label row, so the " +
        'equality assertions above are not reading the attribute definition at all',
    ).toBe(edited);
    expect(after.text.fields[subject.id]?.label?.value).not.toBe(
      before.text.fields[subject.id]?.label?.value,
    );
  }, 120_000);
});
