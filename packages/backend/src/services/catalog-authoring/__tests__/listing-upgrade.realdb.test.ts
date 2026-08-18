/**
 * Moving a PUBLISHED listing to a newer product-type version, against a REAL
 * PostgreSQL server (#587, #367 box 12).
 *
 * ## Why a real server, specifically
 *
 * Everything load-bearing here is a property of the DATABASE and a mocked
 * repository has none of it:
 *
 * - `mercaria_listing_product_type_pin_not_cleared` is what decides whether the
 *   write is even possible. It permits `NULL → value` and `value → value` and
 *   refuses `value → NULL`, and migration 0109 says the second is permitted
 *   "precisely so #367 box 12's published-listing migration has somewhere to
 *   land". A mocked `update` accepts all three, so a mocked suite would be green
 *   against a schema that refused the operation.
 * - `mercaria_native_variant_axis_frozen` is why the axis blocker refuses
 *   rather than repairing: an axis's cited version is immutable, so the axes
 *   cannot follow the listing. This file asserts that refusal directly.
 * - The listing itself is written through the sanctioned repository statement,
 *   so its `updated_at` stamp and its CAS are real.
 *
 * ## What "never silently rewrite" is measured as
 *
 * Not as an absence in the diff — as a READ-BACK. The apply case records every
 * claim's settled attribute version and every axis's cited product-type version
 * BEFORE the move and asserts they are byte-identical afterwards, so a future
 * "tidy up the stale citations" would fail here rather than in production.
 *
 * ## Scoping, because this database is SHARED
 *
 * One vertical namespace token, one store, listings this file published, and
 * every read keyed on ids it minted. The product-type versions it creates stay
 * DRAFT or are published under its own namespaced key, so no sibling's
 * `findPublishedProductTypeDefinition` can see them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findListingById } from '../../../db/catalog/listingRepository.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import {
  findPublishedProductTypeDefinition,
  insertProductTypeDefinition,
  setProductTypeLifecycleIfIn,
  type ProductTypeDefinitionRow,
} from '../../../db/productTypes/productTypeRepository.js';
import {
  insertProductTypeCategoryScope,
  insertProductTypeField,
  listProductTypeFields,
} from '../../../db/productTypes/productTypeFieldRepository.js';
import { listVariantAxesForListing } from '../../../db/variantAxes/variantAxisRepository.js';
import { listListingAttributeClaims } from '../../../db/variantAxes/attributeClaimRepository.js';
import { createStoreProduct } from '../../catalog-write.service.js';
import { createDraft, patchDraft, validateStoreDraft } from '../draft.service.js';
import { publishDraft } from '../publish.service.js';
import {
  applyListingProductTypeUpgrade,
  previewListingProductTypeUpgrade,
} from '../listing-upgrade.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, enumValueId } from '../../../__tests__/vertical-e2e/journey.js';

const TOKEN = verticalRunToken('lstup');

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let storeId: string;
let categoryId: string;
let categorySlug: string;
/** The version the listings are published under. */
let v1: ProductTypeDefinitionRow;
/** A listing WITH declared variant axes, published under v1. */
let axisListingId: string;
/** A listing with product-scope answers and NO variant axes, published under v1. */
let plainListingId: string;

/** The axis answers for the named keys, in the shape `patchDraft` takes. */
async function axisAnswers(
  keys: readonly ('storage_capacity' | 'phone_color')[],
): Promise<{ attributeKey: string; values: { number?: number; unit?: string; enumValueId?: string }[] }[]> {
  const answers: { attributeKey: string; values: { number?: number; unit?: string; enumValueId?: string }[] }[] = [];
  for (const key of keys) {
    if (key === 'storage_capacity') {
      answers.push({ attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 256, unit: 'GB' }] });
      continue;
    }
    answers.push({
      attributeKey: nsKey(ns, 'phone_color'),
      values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', 'black') }],
    });
  }
  return answers;
}

/** Publish one listing through the real authoring flow, under whatever is published now. */
async function publishListing(
  title: string,
  axisKeys: readonly ('storage_capacity' | 'phone_color')[],
): Promise<string> {
  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: phones.actorOxyUserId,
    categoryId,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    title,
  });
  await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'A phone whose schema version an operator may move forward.',
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
    ],
    variants: [
      {
        sku: `${TOKEN}-${title.replace(/\W/gu, '')}-256`,
        inventoryAvailable: 2,
        price: { amount: 99900, currency: 'EUR' },
        axes: await axisAnswers(axisKeys),
      },
    ],
  });
  const validation = await validateStoreDraft(db, {
    storeId,
    draftId: draft.id,
    permissions: E2E_PERMISSIONS,
  });
  expect(validation.publishable, `${title} was not publishable: ${JSON.stringify(validation)}`).toBe(
    true,
  );
  const published = await publishDraft(db, {
    storeId,
    draftId: draft.id,
    actorOxyUserId: phones.actorOxyUserId,
    permissions: E2E_PERMISSIONS,
    idempotencyKey: null,
  });
  // A STRING discriminant, narrowed explicitly: the backend compiles with
  // `strict: false`, so nothing here narrows on truthiness and a bare
  // `published.listingId` does not type-check against the refused branch.
  if (published.outcome === 'refused') {
    throw new Error(`${title} was refused at publish: ${JSON.stringify(published.validation)}`);
  }
  return published.listingId;
}

/**
 * Publish a NEW version of the smartphone product type.
 *
 * Built field by field rather than by copying v1, so each case says exactly
 * which fields the target declares — which is the whole input to both the change
 * list and the axis blocker.
 */
async function publishNextVersion(
  fields: readonly { key: string; scope: 'product' | 'variant'; variantCapable: boolean }[],
): Promise<ProductTypeDefinitionRow> {
  const incumbent = await findPublishedProductTypeDefinition(db, nsKey(ns, 'smartphone'));
  if (incumbent === null) throw new Error('no published smartphone version to succeed');

  const next = await insertProductTypeDefinition(db, {
    key: nsKey(ns, 'smartphone'),
    version: incumbent.version + 1,
    name: `Smartphone v${incumbent.version + 1} (${TOKEN})`,
    createdByOxyUserId: phones.actorOxyUserId,
  });
  createdDefinitionIds.push(next.id);
  await insertProductTypeCategoryScope(db, {
    productTypeDefinitionId: next.id,
    categoryId,
  });
  for (const field of fields) {
    const attributeId = phones.handles.attributeIds.get(field.key);
    const attributeVersion = phones.handles.attributeVersions.get(field.key);
    if (attributeId === undefined || attributeVersion === undefined) {
      throw new Error(`the smartphone package did not seed "${field.key}"`);
    }
    await insertProductTypeField(db, {
      productTypeDefinitionId: next.id,
      attributeDefinitionId: attributeId,
      attributeKey: nsKey(ns, field.key),
      attributeDefinitionVersion: attributeVersion,
      scope: field.scope,
      flow: 'merchant',
      requirement: 'optional',
      valuePolicy: field.key === 'screen_size' ? 'typed_scalar' : 'controlled_value',
      variantCapable: field.variantCapable,
    });
  }
  // Deprecate the incumbent FIRST — `product_type_definitions_one_published_per_key`
  // refuses the other order, which is the same sequence `publishProductTypeVersion`
  // takes and the reason this file writes it out rather than calling that
  // service (it would refuse a version with no fields in some flows).
  await setProductTypeLifecycleIfIn(db, incumbent.id, ['published'], 'deprecated', {
    deprecatedAt: new Date(),
  });
  const published = await setProductTypeLifecycleIfIn(db, next.id, ['draft'], 'published', {
    publishedByOxyUserId: phones.actorOxyUserId,
    publishedAt: new Date(),
  });
  if (published === null) throw new Error('the successor version did not publish');
  return published;
}

const createdDefinitionIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;

  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  categorySlug = category.slug;
  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Upgrade warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);

  const published = await findPublishedProductTypeDefinition(db, nsKey(ns, 'smartphone'));
  if (published === null) throw new Error('the seeded smartphone product type is not published');
  v1 = published;

  // Both axes, because the package's v1 makes them required. The listing whose
  // axes a later version CAN authorise is published under v2, where they are
  // optional — see that describe's own setup.
  axisListingId = await publishListing(`Axis phone ${TOKEN}`, ['storage_capacity', 'phone_color']);
}, 300_000);

afterAll(async () => {
  // The listings and the store are `teardownVertical`'s. The versions this file
  // PUBLISHED cannot be deleted (`product_type_definitions_immutable_once_published`),
  // which is why the fixture retires rather than deletes; the ones still draft
  // are removed with their children.
  // `mercaria_product_type_child_frozen` refuses a delete of the fields or
  // scopes of a version that has left `draft` — which every version this file
  // published has. They are retired in place, exactly as the vertical fixture
  // retires its own, and the namespaced key means no sibling can see them.
  for (const id of createdDefinitionIds) {
    const rows = await db.execute<{ lifecycle: string }>(
      sql`select lifecycle from product_type_definitions where id = ${id}`,
    );
    if ([...rows][0]?.lifecycle !== 'draft') continue;
    await db.execute(sql`delete from product_type_fields where product_type_definition_id = ${id}`);
    await db.execute(
      sql`delete from product_type_category_scopes where product_type_definition_id = ${id}`,
    );
    await db.execute(sql`delete from product_type_definitions where id = ${id}`);
  }
  await teardownVertical(db, TOKEN);
}, 300_000);

describe('the premise', () => {
  it('publishes listings that are pinned to the version they were authored under', async () => {
    const axis = await findListingById(axisListingId, db);
    // The positive control for everything below: without a real pin, "the
    // upgrade moved it" and "there was nothing to move" are the same green.
    expect(axis?.productTypeDefinitionId, 'the axis listing was published with no pin').toBe(v1.id);

    const axes = await listVariantAxesForListing(db, axisListingId);
    expect(axes.map((entry) => entry.attributeKey).sort()).toEqual(
      [nsKey(ns, 'phone_color'), nsKey(ns, 'storage_capacity')].sort(),
    );
    // Every axis cites the version that authorised it, which is what the apply
    // must leave alone.
    for (const entry of axes) expect(entry.productTypeDefinitionId).toBe(v1.id);
  });

  it('reports up_to_date while the pinned version is still the published one', async () => {
    const preview = await previewListingProductTypeUpgrade(db, storeId, axisListingId);
    expect(preview.outcome).toBe('up_to_date');
  });

  it('answers 404 for a listing another store owns, not 403', async () => {
    await expect(
      previewListingProductTypeUpgrade(db, `${TOKEN}-not-my-store`, axisListingId),
    ).rejects.toThrow(/No such listing/u);
  });
});

describe('a newer version that keeps every field', () => {
  let v2: ProductTypeDefinitionRow;

  beforeAll(async () => {
    v2 = await publishNextVersion([
      { key: 'chipset', scope: 'product', variantCapable: false },
      { key: 'screen_size', scope: 'product', variantCapable: false },
      { key: 'storage_capacity', scope: 'variant', variantCapable: true },
      { key: 'phone_color', scope: 'variant', variantCapable: true },
    ]);
    // The control for the axis blocker two describes down: a listing whose ONLY
    // axis a later version still authorises. It is published here rather than in
    // the top-level setup because the package's v1 makes both axes required, so
    // a one-axis listing is not publishable under it — this version makes them
    // optional, which is the first moment such a listing can exist.
    plainListingId = await publishListing(`Single axis phone ${TOKEN}`, ['storage_capacity']);
  }, 180_000);

  it('offers the upgrade and names the target', async () => {
    const preview = await previewListingProductTypeUpgrade(db, storeId, axisListingId);
    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.currentVersion).toBe(v1.version);
    expect(preview.targetVersion).toBe(v2.version);
    expect(preview.targetDefinitionId).toBe(v2.id);
    // The vacuity floor: an empty change list would satisfy every assertion
    // about what is NOT in it.
    expect(preview.changes.length, `${String(preview.changes.length)} changes`).toBeGreaterThan(0);
    expect(preview.losesAnswers, 'nothing was removed, so nothing is lost').toBe(false);
  });

  it('moves the pin and REWRITES NOTHING ELSE', async () => {
    const before = await findListingById(axisListingId, db);
    const claimsBefore = await listListingAttributeClaims(db, axisListingId);
    const axesBefore = await listVariantAxesForListing(db, axisListingId);

    const result = await applyListingProductTypeUpgrade(db, {
      storeId,
      listingId: axisListingId,
      targetDefinitionId: v2.id,
    });

    expect(result.fromDefinitionId).toBe(v1.id);
    expect(result.toDefinitionId).toBe(v2.id);
    expect(result.toVersion).toBe(v2.version);

    const after = await findListingById(axisListingId, db);
    expect(after?.productTypeDefinitionId).toBe(v2.id);
    // Everything else on the row is untouched. `updated_at` is the ONE declared
    // side effect — the pin genuinely changed — so it is excluded by name
    // rather than by not being looked at.
    expect(after?.status).toBe(before?.status);
    expect(after?.categoryId).toBe(before?.categoryId);
    expect(after?.title).toBe(before?.title);
    expect(after?.publishedAt?.toISOString()).toBe(before?.publishedAt?.toISOString());

    // THE headline. Every claim keeps the attribute version it was settled
    // under, and every axis keeps the product-type version that authorised it.
    const claimsAfter = await listListingAttributeClaims(db, axisListingId);
    const axesAfter = await listVariantAxesForListing(db, axisListingId);
    expect(claimsAfter.length, 'a claim disappeared').toBe(claimsBefore.length);
    expect(
      claimsAfter.map((c) => `${c.id}:${String(c.attributeDefinitionVersion)}:${c.attributeResolution}`).sort(),
    ).toEqual(
      claimsBefore.map((c) => `${c.id}:${String(c.attributeDefinitionVersion)}:${c.attributeResolution}`).sort(),
    );
    expect(
      axesAfter.map((a) => `${a.attributeKey}:${String(a.productTypeDefinitionId)}`).sort(),
      'an axis citation followed the listing; it must not, and the DB freezes it',
    ).toEqual(
      axesBefore.map((a) => `${a.attributeKey}:${String(a.productTypeDefinitionId)}`).sort(),
    );
    // Stated positively too, so the equality above cannot pass by both sides
    // having moved: the axes still cite v1, which is the version that really
    // did authorise them.
    for (const axis of axesAfter) expect(axis.productTypeDefinitionId).toBe(v1.id);
  }, 60_000);

  it('is up_to_date afterwards, and applying again is refused', async () => {
    expect((await previewListingProductTypeUpgrade(db, storeId, axisListingId)).outcome).toBe(
      'up_to_date',
    );
    await expect(
      applyListingProductTypeUpgrade(db, {
        storeId,
        listingId: axisListingId,
        targetDefinitionId: v2.id,
      }),
    ).rejects.toThrow(/already current/u);
  });

  it('refuses a target that is not the published version', async () => {
    await expect(
      applyListingProductTypeUpgrade(db, {
        storeId,
        listingId: plainListingId,
        targetDefinitionId: v1.id,
      }),
    ).rejects.toThrow(/moved on while you were reading|already current/u);
  });
});

describe('a newer version that no longer authorises a declared axis', () => {
  let v3: ProductTypeDefinitionRow;

  beforeAll(async () => {
    // `phone_color` becomes a PRODUCT-scope field, so it can no longer authorise
    // a variant axis — which is exactly what
    // `mercaria_native_variant_axis_citation` refuses when an axis row names it.
    v3 = await publishNextVersion([
      { key: 'chipset', scope: 'product', variantCapable: false },
      { key: 'screen_size', scope: 'product', variantCapable: false },
      { key: 'storage_capacity', scope: 'variant', variantCapable: true },
      { key: 'phone_color', scope: 'product', variantCapable: false },
    ]);
  }, 120_000);

  it('is a version the database really would refuse an axis under', async () => {
    // The premise, measured rather than asserted: v3 declares no variant-capable
    // variant-scope field for `phone_color`. Without this the blocker below
    // could be firing on a condition that does not exist.
    const fields = await listProductTypeFields(db, v3.id, 'merchant');
    const authorised = fields.filter(
      (field) => field.scope === 'variant' && field.variantCapable === true,
    );
    expect(authorised.map((field) => field.attributeKey)).not.toContain(nsKey(ns, 'phone_color'));
    expect(authorised.length, 'v3 authorises no axis at all, so the case proves nothing').toBeGreaterThan(0);
  });

  it('BLOCKS a listing whose axis it cannot authorise, naming the attribute', async () => {
    const preview = await previewListingProductTypeUpgrade(db, storeId, axisListingId);
    expect(preview.outcome).toBe('blocked');
    if (preview.outcome !== 'blocked') return;
    // No `targetDefinitionId` on this branch, which is the structural half: a
    // client holding only a blocked preview has no id to send.
    expect('targetDefinitionId' in preview).toBe(false);
    expect(preview.blockers.map((entry) => entry.blocker)).toContain('variant_axis_not_authorised');
    expect(
      preview.blockers.find((entry) => entry.blocker === 'variant_axis_not_authorised')
        ?.attributeKey,
    ).toBe(nsKey(ns, 'phone_color'));
    // It still says what the move WOULD have done — an operator deciding what to
    // fix first needs that.
    expect(preview.changes.length).toBeGreaterThan(0);
  });

  it('refuses the apply even when a caller names the target anyway', async () => {
    await expect(
      applyListingProductTypeUpgrade(db, {
        storeId,
        listingId: axisListingId,
        targetDefinitionId: v3.id,
      }),
    ).rejects.toThrow(/variant-capable/u);

    // And nothing moved.
    const listing = await findListingById(axisListingId, db);
    expect(listing?.productTypeDefinitionId).not.toBe(v3.id);
  });

  it('still offers the upgrade to a listing with NO axes', async () => {
    // The control for the blocker: the same target version, a listing the rule
    // does not apply to. Without it, "blocked" could be a property of v3 rather
    // than of the axis.
    const preview = await previewListingProductTypeUpgrade(db, storeId, plainListingId);
    expect(preview.outcome).toBe('upgrade_available');
    if (preview.outcome !== 'upgrade_available') return;
    expect(preview.targetDefinitionId).toBe(v3.id);
  });
});

describe('a listing under moderation', () => {
  it('is blocked, because moving a pin is an edit', async () => {
    await db.execute(sql`update listings set status = 'restricted' where id = ${plainListingId}`);
    try {
      const preview = await previewListingProductTypeUpgrade(db, storeId, plainListingId);
      expect(preview.outcome).toBe('blocked');
      if (preview.outcome !== 'blocked') return;
      expect(preview.blockers.map((entry) => entry.blocker)).toContain('listing_not_editable');

      await expect(
        applyListingProductTypeUpgrade(db, {
          storeId,
          listingId: plainListingId,
          targetDefinitionId: (await findPublishedProductTypeDefinition(db, nsKey(ns, 'smartphone')))
            ?.id as string,
        }),
      ).rejects.toThrow(/restricted/u);
    } finally {
      await db.execute(sql`update listings set status = 'active' where id = ${plainListingId}`);
    }
  }, 60_000);
});

describe('a listing that is pinned to nothing', () => {
  it('answers not_pinned rather than inventing a first pin', async () => {
    // A row with a NULL pin is every P2P listing and every store product created
    // outside the authoring flow. `mercaria_listing_product_type_pin_not_cleared`
    // would permit NULL -> value, so this refusal is the SERVICE's decision:
    // a first pin is a different act from moving one, and it would be this
    // surface claiming a contract the seller never answered.
    // Created through the REAL store-product writer with no pin, which is the
    // production path an unpinned store product actually takes — a hand-written
    // INSERT would be this file's idea of the row rather than the row.
    const listingId = await createStoreProduct(storeId, {
      title: `Unpinned phone ${TOKEN}`,
      description: 'A store product created outside the authoring flow.',
      category: categorySlug,
      imageFileIds: [],
      options: [],
      variants: [
        {
          sku: `${TOKEN}-unpinned`,
          price: { amount: 1000, currency: 'EUR' },
          optionValues: [],
          inventory: { available: 1 },
        },
      ],
    });
    try {
      const preview = await previewListingProductTypeUpgrade(db, storeId, listingId);
      expect(preview.outcome).toBe('not_pinned');
      await expect(
        applyListingProductTypeUpgrade(db, {
          storeId,
          listingId,
          targetDefinitionId: v1.id,
        }),
      ).rejects.toThrow(/pinned to no product type version/u);
    } finally {
      await db.execute(sql`delete from listings where id = ${listingId}`);
    }
  }, 60_000);
});
