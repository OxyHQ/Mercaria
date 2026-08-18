/**
 * An approved translation must be served WITHOUT a restart (issue #655),
 * against a REAL PostgreSQL server.
 *
 * ## The defect this file is the gate for
 *
 * `catalog_authoring_schema_invalidations` declares a `localization` subject,
 * `invalidationRefs` folds it into the memo key AND the ETag, and — until this
 * fix — **nothing bumped it**. Every production call of
 * `bumpAuthoringSchemaInvalidation` named `category`, `product_type` or
 * `attribute_values`; `reviewLocalization`, which upserts the translation and
 * its audit event in one transaction, called nothing at all.
 *
 * So an operator approved a translation, the revision did not move, the cache
 * key did not change, and every task that had already composed that schema went
 * on serving the previous text until it restarted. Reachable by the ordinary
 * path: `db/schema/productTypes.ts` states outright that translations stay
 * mutable after the version freezes, which is the point of separating them from
 * the frozen contract.
 *
 * ## The control that stops this test being vacuous
 *
 * "The text changed after the review" passes trivially if the memo never
 * engaged — two uncached compositions both read the database and both see the
 * new row. So every case here FIRST composes twice and asserts the second call
 * returned **the same object reference**, which only a memo hit can produce.
 * The invalidation assertion is then a statement about the memo rather than
 * about Postgres.
 *
 * Without that control this file would pass against the unfixed code the moment
 * anything perturbed the key.
 *
 * ## Why a real server
 *
 * The revision register is a table with an `ON CONFLICT DO UPDATE` on it, the
 * translation is an upsert under a unique index, and the memo key is built from
 * a read of the first. A mocked repository has none of the three, and the bug is
 * precisely that one real write did not happen.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { AuthoringSchema } from '@mercaria/shared-types';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { findPublishedProductTypeDefinition } from '../../../db/productTypes/productTypeRepository.js';
import { readAuthoringSchemaRevisions } from '../../../db/catalogAuthoring/schemaInvalidationRepository.js';
import { governanceActor, type CatalogGovernanceActor } from '../../catalog-governance/actor.js';
import { reviewLocalization } from '../../catalog-governance/review.service.js';
import { clearAuthoringSchemaMemo, composeAuthoringSchema } from '../schema.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS } from '../../../__tests__/vertical-e2e/journey.js';

const TOKEN = verticalRunToken('l10ninv');
const OPERATOR = `${TOKEN}-operator`;
/** Not the base locale, so a translation is what answers rather than the fallback. */
const LOCALE = 'es';

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let productTypeKey: string;
let productTypeDefinitionId: string;

/** An actor holding exactly the roles named — the idiom this domain already uses. */
function actorWith(...roles: Parameters<typeof governanceActor>[1]): CatalogGovernanceActor {
  return governanceActor({ userId: OPERATOR } as unknown as Request, roles);
}

/** One composition, or a failure naming the refusal rather than reading `undefined`. */
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
 * Compose TWICE and assert the memo served the second call.
 *
 * The identity check is the whole control: `toBe` on two results of one
 * function passes only when the same object came back, which nothing but a memo
 * hit produces here — a fresh composition builds a new one every time.
 */
async function composeAndProveMemoized(what: string): Promise<AuthoringSchema> {
  const first = await compose();
  const second = await compose();
  expect(
    second,
    `${what}: the second composition was not served from the memo, so this case would ` +
      'pass against an un-invalidated cache — it would be measuring Postgres, not the memo.',
  ).toBe(first);
  return first;
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;

  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  productTypeKey = nsKey(ns, 'smartphone');

  const definition = await findPublishedProductTypeDefinition(db, productTypeKey);
  if (definition === null) throw new Error('the seeded smartphone product type is not published');
  productTypeDefinitionId = definition.id;
}, 300_000);

afterAll(async () => {
  // `teardownVertical` retires the category and cannot delete the product-type
  // version (it is published and frozen), so the translations this file wrote
  // are removed by id here rather than left behind pointing at rows this run
  // owns. The invalidation register rows are keyed on those same ids and are
  // left: they are a counter, not a fact about anything a sibling reads.
  await db.execute(sql`
    delete from product_type_localizations
     where product_type_definition_id = ${productTypeDefinitionId} and locale = ${LOCALE}
  `);
  await db.execute(sql`
    delete from category_localizations where category_id = ${categoryId} and locale = ${LOCALE}
  `);
  await teardownVertical(db, TOKEN);
}, 300_000);

beforeEach(() => {
  // Process state shared with every other file in this worker. Cleared BEFORE
  // each case so a sibling's entries cannot satisfy the identity control, and
  // never between the two composes inside a case, which is what the control
  // measures.
  clearAuthoringSchemaMemo();
});

describe('approving a PRODUCT TYPE translation', () => {
  it('changes the served text without a restart', async () => {
    const before = await composeAndProveMemoized('product type');
    const previousName = before.text.productTypeName?.value;

    const approved = `Teléfono ${TOKEN}`;
    // The premise: the text this review installs is not already what is served,
    // so "it changed" is a statement about the review rather than about nothing.
    expect(previousName, 'the fixture already served the text under review').not.toBe(approved);

    await reviewLocalization(db, actorWith('translate'), {
      entity: 'product_type',
      entityId: productTypeDefinitionId,
      locale: LOCALE,
      status: 'approved',
      name: approved,
      reason: 'the translation reads correctly and is approved',
    });

    const after = await compose();
    expect(
      after.text.productTypeName?.value,
      'the approved translation is not served; the memo returned the previous composition',
    ).toBe(approved);
    // The ETag moves with it, which is what stops a conditional request 304ing
    // a client onto the old copy.
    expect(after.etag).not.toBe(before.etag);
  }, 120_000);

  it('moved the localization revision, which is the mechanism', async () => {
    // Stated separately from the behaviour above, because the two fail
    // differently: a bump on the WRONG subject or the wrong id would leave the
    // text stale with a revision that moved, and reading only the register
    // would call that a pass.
    const revisions = await readAuthoringSchemaRevisions(db, [
      { subject: 'localization', subjectId: productTypeDefinitionId },
    ]);
    expect(
      revisions.get(`localization:${productTypeDefinitionId}`) ?? 0,
      'reviewLocalization bumped no localization revision for the product type',
    ).toBeGreaterThan(0);
  });
});

describe('approving a CATEGORY translation', () => {
  it('changes the served category name without a restart', async () => {
    const before = await composeAndProveMemoized('category');
    const previousName = before.text.categoryName?.value;

    const approved = `Móviles ${TOKEN}`;
    expect(previousName, 'the fixture already served the text under review').not.toBe(approved);

    await reviewLocalization(db, actorWith('translate'), {
      entity: 'category',
      entityId: categoryId,
      locale: LOCALE,
      status: 'approved',
      name: approved,
      reason: 'the category translation reads correctly and is approved',
    });

    const after = await compose();
    expect(
      after.text.categoryName?.value,
      'the approved category translation is not served; the memo returned the previous composition',
    ).toBe(approved);
    expect(after.etag).not.toBe(before.etag);
  }, 120_000);
});
