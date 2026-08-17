/**
 * The full variant matrix a merchant publishes, and a genuinely new model
 * carried from a proposal all the way to a findable listing (#367 Workstream 18).
 *
 * ## Two things the existing suites stop one step short of
 *
 * **The matrix.** `verticals-footwear.realdb.test.ts` proves the CANONICAL matrix
 * is sparse and converges, and its duplicate case asks for one combination twice
 * in the SAME order. Order-independence is the property `typedVariantSignature`
 * exists for — it sorts the serialized `(definitionId, value)` pairs — and it is
 * what makes "reject duplicate combinations after normalization" true rather than
 * true-for-the-order-somebody-happened-to-type. So this file enters one
 * combination twice in DIFFERENT orders, at all three grains that carry a
 * signature: the pure digest, the draft's own unique, and the canonical variant's.
 * Then it publishes all eight seeded configurations as one listing, which is the
 * matrix at the merchant grain.
 *
 * **The new model.** `verticals-smartphone.realdb.test.ts` drives the proposal
 * through submission, review by a different operator, and resolution onto a
 * minted product — and stops there. A merchant's actual purpose is to SELL the
 * thing, so this file authors against the minted product, publishes, converges an
 * offer and asserts the new model is reachable by search and renders a product
 * page. It also asserts the direction that must NOT work: the proposal itself
 * minted nothing, so a draft could not have selected the product before the
 * operator created it.
 *
 * ## Every claim's control
 *
 * - The order-independence claim is paired with a SENSITIVITY claim: reversing
 *   the order must NOT change the digest, and changing one value MUST. Only the
 *   first would pass against a digest that ignored its input.
 * - The duplicate refusal asserts the mechanism BY NAME — the constraint or the
 *   validation code — because "it threw" is satisfied by any failure.
 * - The eight-variant publication counts variants, links, signatures and offers,
 *   all four against eight, and asserts the eight signatures are DISTINCT.
 * - The new model is asserted absent from search BEFORE it is minted, so
 *   "findable afterwards" is a change rather than a standing fact.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../db/postgres.js';
import { findCategoryByKey } from '../../db/taxonomy/taxonomyRepository.js';
import { listReviewEvents } from '../../db/catalogProposals/proposalRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../../services/catalog-authoring/draft.service.js';
import { publishDraft } from '../../services/catalog-authoring/publish.service.js';
import { createCanonicalProduct } from '../../services/canonical/canonical-product.service.js';
import { createVariant } from '../../services/canonical/canonical-variant.service.js';
import { submitProposal } from '../../services/catalog-proposals/proposal.service.js';
import { mergeProposalIntoExisting } from '../../services/catalog-proposals/review.service.js';
import { convergeNativeOffersForListing } from '../../services/offers/native-offer.service.js';
import { readCanonicalProductPage } from '../../services/product-page/product-page.service.js';
import { runCanonicalSearch } from '../../services/search/canonical-search.service.js';
import { previewVariantSignature } from '../../services/variant-axes/variant-axes.service.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';
import { nsCategoryKey, nsKey, nsSlug, type VerticalNamespace } from '../../scripts/seed-verticals/apply.js';
import { FOOTWEAR_PACKAGE } from '../../scripts/seed-verticals/footwear.js';
import { SMARTPHONE_PACKAGE } from '../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, countOne, enumValueId, reportPopulation } from './journey.js';

const TOKEN = verticalRunToken('mx');
/** The new model's name, and the term the search cases use. */
const NEW_MODEL_NAME = `Lumira Axon 10 Ultra ${TOKEN}`;

/**
 * The Trailwind 3 matrix, DERIVED from the package rather than retyped.
 *
 * `TRAILWIND_MATRIX` is private to `footwear.ts` and this file may not change
 * that, so the combinations are read off the package's own product value — the
 * same data the seed applies. A hand-copied list would drift the moment somebody
 * added a ninth combination, and it would drift in the direction that keeps this
 * test green.
 */
const TRAILWIND_COMBINATIONS: readonly {
  readonly key: string;
  readonly size: string;
  readonly color: string;
  readonly width: string;
}[] = (() => {
  const product = FOOTWEAR_PACKAGE.products.find((entry) => entry.key === 'trailwind_3');
  if (product === undefined) throw new Error('the footwear package declares no `trailwind_3`');
  return product.variants.map((variant) => {
    const optionOf = (key: string): string => {
      const option = variant.options.find((entry) => entry.key === key);
      if (option === undefined) {
        throw new Error(`variant ${variant.key} declares no '${key}' option`);
      }
      return option.value;
    };
    return {
      key: variant.key,
      size: optionOf('shoe_size_eu'),
      color: optionOf('footwear_color'),
      width: optionOf('shoe_width'),
    };
  });
})();

const db: Database = await connectPostgres();
let footwear: SeededVertical;
let phones: SeededVertical;
let fwNs: VerticalNamespace;
let phNs: VerticalNamespace;
let mensCategoryId: string;
let phoneCategoryId: string;
let storeId: string;
let mintedProductId = '';

beforeAll(async () => {
  footwear = await seedVerticalForTest(db, FOOTWEAR_PACKAGE, `${TOKEN}f`);
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, `${TOKEN}p`);
  fwNs = footwear.ns;
  phNs = phones.ns;

  const mens = await findCategoryByKey(nsCategoryKey(fwNs, 'athletic.mens_running_shoes'), db);
  const smartphones = await findCategoryByKey(nsCategoryKey(phNs, 'phones.smartphones'), db);
  if (!mens || !smartphones) throw new Error('the seeded departments did not resolve');
  mensCategoryId = mens.id;
  phoneCategoryId = smartphones.id;

  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Matrix warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
}, 300_000);

afterAll(async () => {
  // The proposal trail first, and it is not optional:
  // `catalog_proposals.store_id` is `ON DELETE restrict`, so a store this file
  // owns cannot be deleted while a proposal names it. `catalog_review_events`
  // refuses DELETE by trigger and its `proposal_id` is `restrict` too, so the
  // events genuinely have to go before the proposals. ONE table inside the
  // trigger window, which `advisory-lock-census.test.ts` requires.
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table catalog_review_events disable trigger mercaria_catalog_review_event_append_only`,
    );
    await tx.execute(
      sql`delete from catalog_review_events where proposal_id in (select id from catalog_proposals where store_id like ${`${TOKEN}%`})`,
    );
    await tx.execute(
      sql`alter table catalog_review_events enable trigger mercaria_catalog_review_event_append_only`,
    );
  });
  await db.execute(
    sql`delete from catalog_proposal_duplicate_candidates where proposal_id in (select id from catalog_proposals where store_id like ${`${TOKEN}%`})`,
  );
  await db.execute(sql`delete from catalog_proposals where store_id like ${`${TOKEN}%`}`);

  await teardownVertical(db, TOKEN);

  // The minted product's rows, AFTER the store's listings have gone.
  //
  // Order measured, not guessed: this file's own listing declares a
  // `native_listing_links` row onto the minted CONFIGURATION, and that foreign
  // key is `ON DELETE restrict`. Deleting the canonical rows first fails `23503`
  // naming that table — which is the teardown doing its job loudly rather than
  // swallowing it. The `teardownVertical` call ABOVE removes this store's
  // listings (and their links and offers cascade with them), so the canonical
  // rows are only free once it has run.
  if (mintedProductId !== '') {
    await db.execute(
      sql`delete from canonical_product_aliases where product_id = ${mintedProductId}`,
    );
    const variantIds = [
      ...(await db.execute<{ id: string }>(
        sql`select id from canonical_variants where product_id = ${mintedProductId}`,
      )),
    ].map((row) => row.id);
    await db.execute(
      sql`delete from canonical_variant_attributes where variant_id in (select id from canonical_variants where product_id = ${mintedProductId})`,
    );
    if (variantIds.length > 0) await deleteTestCanonicalRows(db, { variantIds });
    await deleteTestCanonicalRows(db, { productIds: [mintedProductId] });
  }

  await teardownVertical(db, `${TOKEN}f`);
  await teardownVertical(db, `${TOKEN}p`);
}, 300_000);

/** One Trailwind combination's three axis answers, in the order given. */
async function trailwindAxes(
  entry: { readonly size: string; readonly color: string; readonly width: string },
  order: readonly ('size' | 'color' | 'width')[] = ['size', 'color', 'width'],
): Promise<readonly { readonly attributeKey: string; readonly values: readonly { readonly enumValueId: string }[] }[]> {
  const byName = {
    size: {
      attributeKey: nsKey(fwNs, 'shoe_size_eu'),
      values: [{ enumValueId: await enumValueId(db, fwNs, 'shoe_size_eu', entry.size) }],
    },
    color: {
      attributeKey: nsKey(fwNs, 'footwear_color'),
      values: [{ enumValueId: await enumValueId(db, fwNs, 'footwear_color', entry.color) }],
    },
    width: {
      attributeKey: nsKey(fwNs, 'shoe_width'),
      values: [{ enumValueId: await enumValueId(db, fwNs, 'shoe_width', entry.width) }],
    },
  };
  return order.map((name) => byName[name]);
}

describe('a variant signature ignores the order the axes were typed in', () => {
  it('digests the same value from a reversed assignment list, and NOT from a changed one', () => {
    const forward = [
      { attributeDefinitionId: 'aaaaaaaa-0000-0000-0000-000000000001', normalizedValue: '42' },
      { attributeDefinitionId: 'bbbbbbbb-0000-0000-0000-000000000002', normalizedValue: 'black' },
      { attributeDefinitionId: 'cccccccc-0000-0000-0000-000000000003', normalizedValue: 'standard' },
    ];
    const reversed = [...forward].reverse();
    expect(previewVariantSignature(reversed)).toBe(previewVariantSignature(forward));

    // The sensitivity control. Without it, the equality above would pass against
    // a digest that ignored its input entirely.
    const changed = [
      forward[0],
      { attributeDefinitionId: 'bbbbbbbb-0000-0000-0000-000000000002', normalizedValue: 'blue' },
      forward[2],
    ];
    expect(previewVariantSignature(changed)).not.toBe(previewVariantSignature(forward));

    // The digest does NOT fold: it ASSERTS its input is already normalized and
    // throws otherwise. That is what stops a caller storing the raw value in the
    // column and the folded one in the digest, which produces a row whose
    // signature nothing can recompute — invisible until two variants stop
    // colliding. Asserted rather than described, because a folding digest would
    // pass every other case in this file.
    expect(() =>
      previewVariantSignature([
        { attributeDefinitionId: forward[1].attributeDefinitionId, normalizedValue: 'Black' },
      ]),
    ).toThrow(/not normalized/u);
  });

  it('converges a canonical variant asked for in a DIFFERENT axis order', async () => {
    const productId = footwear.handles.productIds.get('trailwind_3');
    if (productId === undefined) throw new Error('the seed minted no Trailwind 3');
    const before = await countOne(
      db,
      sql`select count(*)::int as total from canonical_variants where product_id = ${productId}`,
    );
    expect(before).toBe(TRAILWIND_COMBINATIONS.length);

    // The seed created this combination as (size, colour, width). Asking for it
    // as (width, colour, size) must reach the SAME row — the half the Workstream
    // 14 duplicate case does not cover, since it repeats the seed's own order.
    const again = await createVariant({
      productId,
      options: [
        { key: nsKey(fwNs, 'shoe_width'), value: 'standard' },
        { key: nsKey(fwNs, 'footwear_color'), value: 'black' },
        { key: nsKey(fwNs, 'shoe_size_eu'), value: '42' },
      ],
    });
    expect(again.created).toBe(false);
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from canonical_variants where product_id = ${productId}`,
      ),
    ).toBe(before);
  });

  it('REFUSES two draft variants that are one combination in two orders, by name', async () => {
    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: footwear.actorOxyUserId,
      categoryId: mensCategoryId,
      productTypeKey: nsKey(fwNs, 'athletic_footwear'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: 'A draft with one combination twice',
    });

    const entry = { size: '42', color: 'black', width: 'standard' };
    let raised: unknown;
    try {
      await patchDraft(db, {
        storeId,
        draftId: draft.id,
        expectedVersion: draft.version,
        permissions: E2E_PERMISSIONS,
        description: 'Two variants, one configuration, two typing orders.',
        variants: [
          {
            sku: `${TOKEN}-ORDER-A`,
            inventoryAvailable: 1,
            price: { amount: 12900, currency: 'EUR' },
            axes: await trailwindAxes(entry, ['size', 'color', 'width']),
          },
          {
            sku: `${TOKEN}-ORDER-B`,
            inventoryAvailable: 1,
            price: { amount: 12900, currency: 'EUR' },
            // The same three answers, listed the other way round.
            axes: await trailwindAxes(entry, ['width', 'color', 'size']),
          },
        ],
      });
    } catch (error) {
      raised = error;
    }
    expect(raised, 'the draft accepted one combination twice').toBeDefined();
    // BY NAME — the draft's own partial unique on `(draft_id, axis_signature)`.
    // "It threw" would be satisfied by a bad enum id or a price error.
    const cause = raised instanceof Error ? raised.cause : undefined;
    const detail = `${raised instanceof Error ? raised.message : String(raised)} ${
      cause instanceof Error ? cause.message : String(cause ?? '')
    }`;
    expect(detail).toContain('catalog_authoring_draft_variants_signature_key');

    // Nothing was stored: `replaceDraftVariants` is one statement set inside the
    // patch's transaction, so a refusal leaves the draft's matrix untouched.
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from catalog_authoring_draft_variants where draft_id = ${draft.id}`,
      ),
    ).toBe(0);
  });
});

describe('the whole eight-configuration matrix, published as one listing', () => {
  it('carries eight variants, eight links, eight DISTINCT signatures and eight offers', async () => {
    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: footwear.actorOxyUserId,
      categoryId: mensCategoryId,
      productTypeKey: nsKey(fwNs, 'athletic_footwear'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: 'Kestrel Trailwind 3 — the whole matrix',
    });

    const variants = await Promise.all(
      TRAILWIND_COMBINATIONS.map(async (entry) => ({
        sku: `${TOKEN}-M-${entry.size}-${entry.color}-${entry.width}`,
        inventoryAvailable: 2,
        price: { amount: 12900, currency: 'EUR' as const },
        selectedCanonicalVariantId:
          footwear.handles.variantIds.get(entry.key) ?? null,
        axes: await trailwindAxes(entry),
      })),
    );
    // The fixture is the matrix, so its size is the claim's own denominator.
    expect(variants).toHaveLength(8);
    expect(variants.every((variant) => variant.selectedCanonicalVariantId !== null)).toBe(true);

    await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: E2E_PERMISSIONS,
      description: 'Every seeded configuration, on one listing.',
      selectedCanonicalProductId: footwear.handles.productIds.get('trailwind_3') ?? null,
      fields: [
        {
          attributeKey: nsKey(fwNs, 'upper_material'),
          values: [{ enumValueId: await enumValueId(db, fwNs, 'upper_material', 'mesh') }],
        },
      ],
      variants,
    });

    const validation = await validateStoreDraft(db, {
      storeId,
      draftId: draft.id,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the matrix draft is not publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: footwear.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    if (publication.outcome === 'refused') {
      throw new Error(`publication refused: ${JSON.stringify(publication.validation.findings)}`);
    }

    const productVariants = await countOne(
      db,
      sql`select count(*)::int as total from product_variants where listing_id = ${publication.listingId}`,
    );
    const links = await countOne(
      db,
      sql`select count(*)::int as total from native_listing_links
          where listing_id = ${publication.listingId} and status = 'active'`,
    );
    const signatures = await db.execute<{ signature: string; axis_count: number }>(sql`
      select signature, axis_count from native_variant_signatures
      where listing_id = ${publication.listingId}
    `);
    const signatureRows = [...signatures];
    const converged = await convergeNativeOffersForListing(publication.listingId);

    expect(productVariants).toBe(8);
    expect(links).toBe(8);
    expect(signatureRows).toHaveLength(8);
    expect(converged.materialized).toBe(8);
    // DISTINCT, which is the property the matrix rests on: eight combinations
    // that all digested to one value would satisfy every count above.
    expect(new Set(signatureRows.map((row) => row.signature)).size).toBe(8);
    expect(signatureRows.every((row) => row.axis_count === 3)).toBe(true);

    // Three axes, declared once for the listing rather than once per variant.
    const axes = await db.execute<{ attribute_key: string }>(sql`
      select attribute_key from native_listing_variant_axes
      where listing_id = ${publication.listingId} order by position
    `);
    expect([...axes].map((row) => row.attribute_key)).toEqual([
      nsKey(fwNs, 'shoe_size_eu'),
      nsKey(fwNs, 'footwear_color'),
      nsKey(fwNs, 'shoe_width'),
    ]);

    reportPopulation('the published matrix', {
      seededCombinations: TRAILWIND_COMBINATIONS.length,
      listingVariants: productVariants,
      declaredLinks: links,
      distinctSignatures: new Set(signatureRows.map((row) => row.signature)).size,
      declaredAxes: [...axes].length,
      offersConverged: converged.materialized,
    });
  });
});

describe('a genuinely NEW model, from proposal to a listing somebody can find', () => {
  it('is unfindable before it exists', async () => {
    const found = await runCanonicalSearch(
      { term: NEW_MODEL_NAME, kinds: ['product'], filters: {}, limit: 20 },
      db,
    );
    // Asserted BEFORE the mint, so "findable afterwards" is a change this file
    // caused rather than a fact that was always true.
    expect(
      found.response.results.some(
        (entry) => entry.kind === 'product' && entry.name === NEW_MODEL_NAME,
      ),
    ).toBe(false);
  });

  it('is proposed, reviewed by a DIFFERENT operator, minted, published and found', async () => {
    const submission = await submitProposal(db, {
      type: 'canonical_product',
      storeId,
      submittedByOxyUserId: `${TOKEN}-merchant`,
      proposedLabel: NEW_MODEL_NAME,
      sourceLocale: 'en',
      proposedDescription: 'A model Mercaria does not carry yet.',
      submitterNote: 'Announced this week; stock arriving.',
      categoryId: phoneCategoryId,
      productTypeDefinitionId: null,
      attributeDefinitionId: null,
      attributeDefinitionVersion: null,
      draftId: null,
      draftValueId: null,
    });
    expect(submission.outcome).toBe('created');
    expect(submission.proposal.state).toBe('submitted');
    // The duplicate scan RAN over a non-empty population, so "no duplicate" is
    // about the label rather than about an empty catalogue.
    expect(submission.scan.population).toBeGreaterThan(0);

    // The proposal minted NOTHING — which is what keeps a merchant request from
    // becoming globally trusted data. Asserted, because it is the half a reader
    // would assume worked the other way.
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from canonical_products where name = ${NEW_MODEL_NAME}`,
      ),
    ).toBe(0);

    const minted = await createCanonicalProduct({
      name: NEW_MODEL_NAME,
      slug: nsSlug(phNs, 'lumira-axon-10-ultra'),
      brandId: phones.handles.brandIds.get('lumira') ?? '',
      familyId: phones.handles.familyIds.get('axon') ?? '',
      categoryId: phoneCategoryId,
      variantDefiningAttributeKeys: [nsKey(phNs, 'storage_capacity'), nsKey(phNs, 'phone_color')],
      actorOxyUserId: `${TOKEN}-operator-2`,
    });
    mintedProductId = minted.id;

    const resolved = await mergeProposalIntoExisting(
      db,
      // A DIFFERENT Oxy id from the submitter: `catalog_proposals_decider_distinct_check`
      // refuses the same one, so nobody approves their own request.
      { proposalId: submission.proposal.id, operatorOxyUserId: `${TOKEN}-operator-2` },
      { resolvedEntityId: minted.id, reason: 'Minted on the canonical catalogue and linked.' },
    );
    expect(resolved.state).toBe('merged');
    expect(resolved.resolvedEntityId).toBe(minted.id);
    const events = await listReviewEvents(db, submission.proposal.id);
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['submitted', 'merged_into_existing']),
    );

    // And now the step the Workstream 14 suite stops before: the merchant sells
    // it. `createCanonicalProduct` minted no variant for these two axes, so the
    // configuration is created here — which is what a merchant listing the first
    // unit of a brand-new model actually causes.
    const configuration = await createVariant({
      productId: minted.id,
      options: [
        { key: nsKey(phNs, 'storage_capacity'), value: '512 GB' },
        { key: nsKey(phNs, 'phone_color'), value: 'black' },
      ],
    });
    expect(configuration.created).toBe(true);

    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: phones.actorOxyUserId,
      categoryId: phoneCategoryId,
      productTypeKey: nsKey(phNs, 'smartphone'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: `${NEW_MODEL_NAME} — first listing`,
    });
    await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: E2E_PERMISSIONS,
      description: 'The first unit of a model Mercaria minted this minute.',
      selectedCanonicalProductId: minted.id,
      fields: [
        {
          attributeKey: nsKey(phNs, 'chipset'),
          values: [{ enumValueId: await enumValueId(db, phNs, 'chipset', 'snapdragon_8_gen_4') }],
        },
        { attributeKey: nsKey(phNs, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
      ],
      variants: [
        {
          sku: `${TOKEN}-AXON10-512-BLK`,
          inventoryAvailable: 1,
          price: { amount: 149900, currency: 'EUR' },
          selectedCanonicalVariantId: configuration.variant.id,
          axes: [
            { attributeKey: nsKey(phNs, 'storage_capacity'), values: [{ number: 512, unit: 'GB' }] },
            {
              attributeKey: nsKey(phNs, 'phone_color'),
              values: [{ enumValueId: await enumValueId(db, phNs, 'phone_color', 'black') }],
            },
          ],
        },
      ],
    });

    const validation = await validateStoreDraft(db, {
      storeId,
      draftId: draft.id,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the new-model draft is not publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: phones.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    if (publication.outcome === 'refused') {
      throw new Error(`publication refused: ${JSON.stringify(publication.validation.findings)}`);
    }
    const converged = await convergeNativeOffersForListing(publication.listingId);
    expect(converged.materialized).toBe(1);

    // Findable now, by the name that reached nothing before the mint.
    const found = await runCanonicalSearch(
      { term: NEW_MODEL_NAME, kinds: ['product'], filters: {}, limit: 20 },
      db,
    );
    const hit = found.response.results.find(
      (entry) => entry.kind === 'product' && entry.canonicalProductId === minted.id,
    );
    expect(hit, 'the newly minted model was not reachable by its own name').toBeDefined();

    // And it has a product page with its one configuration on it.
    const page = await readCanonicalProductPage({
      handle: nsSlug(phNs, 'lumira-axon-10-ultra'),
      comparisonCurrency: 'EUR',
      limit: 20,
      offerComparisonPermitted: true,
    });
    expect(page).toBeDefined();
    if (!page) return;
    expect(page.page.product.id).toBe(minted.id);
    expect(page.page.variants).toHaveLength(1);

    reportPopulation('the new model', {
      duplicateScanPopulation: submission.scan.population,
      reviewEvents: events.length,
      canonicalVariants: page.page.variants.length,
      offersConverged: converged.materialized,
      searchHits: found.response.results.filter(
        (entry) => entry.kind === 'product' && entry.canonicalProductId === minted.id,
      ).length,
    });
  });

  it('refuses to re-decide the proposal it already resolved', async () => {
    const rows = await db.execute<{ id: string }>(sql`
      select id from catalog_proposals where store_id = ${storeId} and state = 'merged' limit 1
    `);
    const proposalId = [...rows][0]?.id;
    expect(proposalId, 'the merged proposal did not resolve').toBeDefined();
    if (proposalId === undefined) return;
    await expect(
      mergeProposalIntoExisting(
        db,
        { proposalId, operatorOxyUserId: `${TOKEN}-operator-3` },
        { resolvedEntityId: mintedProductId, reason: 'A second decision.' },
      ),
    ).rejects.toThrow();
  });
});
