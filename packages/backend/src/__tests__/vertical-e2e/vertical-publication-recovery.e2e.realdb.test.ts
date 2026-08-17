/**
 * Rollback and error recovery from a FAILED publication (#367 Workstream 18).
 *
 * `docs/catalog-authoring.md` lists this as deliberately deferred — "the
 * publication realdb case: one transaction end to end, and a forced failure
 * inside it leaving nothing". The Workstream 14 vertical suites publish
 * successfully and stop. This is that case.
 *
 * ## Two failures, and they are observably different
 *
 * Collapsing them would be the mistake: a merchant and a retrying client need
 * different next actions.
 *
 *  1. **A refusal, before anything is written.** `publishDraft` RETURNS
 *     `{outcome: 'refused'}` with findings. There is nothing to roll back, and
 *     the observable is a value rather than a throw.
 *  2. **A guard raised INSIDE the transaction, after the write.** A variant's
 *     selected canonical configuration belongs to a different product. The draft
 *     carries TWO variants and only the second is wrong, so the first has
 *     already had its `native_listing_links` row inserted when the guard fires —
 *     which is what makes the absence afterwards a rollback of real work rather
 *     than a pre-flight refusal. A half-published listing, one variant linked and
 *     one not, is the exact state a non-transactional implementation would leave.
 *
 * ## One hypothesis this file started with, and what it measured instead
 *
 * The obvious way to force a database-level failure mid-transaction is a
 * duplicate SKU. It does not fail, and that is deliberate rather than a gap:
 * `product_variants.sku` carries NO unique index at ANY scope (#296, recorded on
 * the column in `db/schema/catalog.ts`) — Shopify enforces no SKU uniqueness and
 * WooCommerce enforces it site-wide, so a connector has to import both. A case
 * below pins the duplicate PUBLISHING, because a reader who assumed otherwise
 * would write the same wrong test.
 *
 * ## Recovery is the same draft, not a new one
 *
 * After (2) the draft is still `open`, still at its own version, and still
 * carries every answer and every variant. The recovery case fixes the one
 * offending field and publishes — no re-entry. That is what makes a rollback a
 * recovery rather than a loss.
 *
 * ## And a retry that lost its response creates nothing
 *
 * The idempotency half: the same `Idempotency-Key` converges on the listing the
 * first attempt made, a DIFFERENT key on an already-published draft converges
 * too, and — the control — a different DRAFT under its own key produces its own
 * listing, so convergence is not "always answer with the first listing".
 *
 * The smartphone package is the fixture because it seeds TWO products of two
 * brands under one category, which is what makes the wrong-product selection
 * available without inventing a row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../db/postgres.js';
import { findCategoryByKey } from '../../db/taxonomy/taxonomyRepository.js';
import { listDraftValues, listDraftVariants } from '../../db/catalogAuthoring/draftRepository.js';
import { createDraft, patchDraft, readDraft, validateStoreDraft } from '../../services/catalog-authoring/draft.service.js';
import { publishDraft } from '../../services/catalog-authoring/publish.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, countOne, countStoreListings, enumValueId, reportPopulation } from './journey.js';

const TOKEN = verticalRunToken('pr');

/** The one SKU two listings deliberately share. See the duplicate-SKU case. */
const SHARED_SKU = `${TOKEN}-AXON-SHARED-SKU`;
/** The variant that is entirely correct in the rollback draft. */
const GOOD_SKU = `${TOKEN}-AXON-GOOD`;
/** The variant whose canonical selection names another brand's phone. */
const WRONG_SKU = `${TOKEN}-AXON-WRONG`;

const db: Database = await connectPostgres();
let seeded: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let storeId: string;
let axonProductId: string;
let axonVariantId: string;
/** A SECOND Axon configuration, so the corrected draft links two distinct ones. */
let axonSecondVariantId: string;
let veroVariantId: string;

/** The listing the first successful publication produced, read by later cases. */
let firstListingId = '';
/** The draft that collides, then recovers. */
let collidingDraftId = '';
let collidingDraftVersion = 0;

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = seeded.ns;
  const smartphones = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!smartphones) throw new Error('the seeded department did not resolve');
  categoryId = smartphones.id;

  const axon = seeded.handles.productIds.get('axon_9_pro');
  const axonVariant = seeded.handles.variantIds.get('axon-256GB-black-eu');
  const axonSecond = seeded.handles.variantIds.get('axon-512GB-blue-us');
  // A configuration of the OTHER brand's phone — the wrong-product selection.
  const veroVariant = seeded.handles.variantIds.get('vero-256GB-black');
  if (
    axon === undefined ||
    axonVariant === undefined ||
    axonSecond === undefined ||
    veroVariant === undefined
  ) {
    throw new Error('the seed did not mint both products and their configurations');
  }
  axonProductId = axon;
  axonVariantId = axonVariant;
  axonSecondVariantId = axonSecond;
  veroVariantId = veroVariant;

  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Recovery warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
}, 300_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 300_000);

/** One Axon variant's three axes, as draft answers. */
async function axonAxes(entry: {
  readonly storageGb: number;
  readonly color: string;
  readonly region: string;
}): Promise<
  readonly { readonly attributeKey: string; readonly values: readonly { readonly enumValueId?: string; readonly number?: number; readonly unit?: string }[] }[]
> {
  return [
    { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: entry.storageGb, unit: 'GB' }] },
    {
      attributeKey: nsKey(ns, 'phone_color'),
      values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', entry.color) }],
    },
    {
      attributeKey: nsKey(ns, 'device_region'),
      values: [{ enumValueId: await enumValueId(db, ns, 'device_region', entry.region) }],
    },
  ];
}

/** A complete, publishable Axon draft. `sku` and `title` are the caller's. */
async function openAxonDraft(options: {
  readonly title: string;
  readonly sku: string;
  readonly canonicalVariantId?: string | null;
}): Promise<{ readonly id: string; readonly version: number }> {
  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: seeded.actorOxyUserId,
    categoryId,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    title: options.title,
  });
  const patched = await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'A publication-recovery fixture listing.',
    selectedCanonicalProductId: axonProductId,
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.7, unit: 'in' }] },
    ],
    variants: [
      {
        sku: options.sku,
        inventoryAvailable: 2,
        price: { amount: 129900, currency: 'EUR' },
        ...(options.canonicalVariantId === undefined
          ? {}
          : { selectedCanonicalVariantId: options.canonicalVariantId }),
        axes: [
          { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 256, unit: 'GB' }] },
          {
            attributeKey: nsKey(ns, 'phone_color'),
            values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', 'black') }],
          },
          {
            attributeKey: nsKey(ns, 'device_region'),
            values: [{ enumValueId: await enumValueId(db, ns, 'device_region', 'eu') }],
          },
        ],
      },
    ],
  });
  return { id: patched.id, version: patched.version };
}

/** The store's own `product_count`, which only the POST-COMMIT half moves. */
async function storeProductCount(): Promise<number> {
  return countOne(
    db,
    sql`select coalesce(product_count, 0)::int as total from stores where id = ${storeId}`,
  );
}

/** The message a Postgres error actually carries — on `cause`, never on the wrapper. */
function causeMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message;
  if (cause !== undefined) return String(cause);
  return error instanceof Error ? error.message : String(error);
}

describe('a refusal, before anything is written', () => {
  it('RETURNS findings rather than throwing, and writes no listing', async () => {
    const before = await countStoreListings(db, storeId);
    // A draft with no variant at all. `no_variant_declared` is an error-severity
    // finding, so the draft is unpublishable and the transaction never opens a
    // write — a genuinely different observable from the two failures below.
    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: seeded.actorOxyUserId,
      categoryId,
      productTypeKey: nsKey(ns, 'smartphone'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: 'A draft with nothing in it',
    });

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    expect(publication.outcome).toBe('refused');
    if (publication.outcome !== 'refused') return;
    expect(publication.validation.publishable).toBe(false);
    expect(publication.validation.findings.map((finding) => finding.code)).toContain(
      'no_variant_declared',
    );

    expect(await countStoreListings(db, storeId)).toBe(before);
    const after = await readDraft(db, storeId, draft.id);
    expect(after.status).toBe('open');
    // `?? null` because the projection carries the column's NULL through rather
    // than omitting the field; asserting `toBeUndefined` fails on a correct row.
    expect(after.publishedListingId ?? null).toBeNull();
  });
});

describe('the first publication succeeds, and is the fixture the collision needs', () => {
  it('publishes and bumps the store count', async () => {
    const countBefore = await storeProductCount();
    const draft = await openAxonDraft({
      title: 'Lumira Axon 9 Pro — first',
      sku: SHARED_SKU,
      canonicalVariantId: axonVariantId,
    });

    const validation = await validateStoreDraft(db, {
      storeId,
      draftId: draft.id,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the fixture draft is not publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: `${TOKEN}-first-key`,
    });
    if (publication.outcome !== 'published') {
      throw new Error(`the fixture publication did not publish: ${publication.outcome}`);
    }
    firstListingId = publication.listingId;
    expect(await countStoreListings(db, storeId)).toBe(1);
    // The post-commit half ran, which is what makes its ABSENCE meaningful below.
    expect(await storeProductCount()).toBe(countBefore + 1);
  });
});

describe('a duplicate SKU is NOT a failure path', () => {
  it('publishes, because `product_variants.sku` carries no unique index (#296)', async () => {
    const listingsBefore = await countStoreListings(db, storeId);

    // The same SKU the first listing already holds. It publishes: the column's
    // own docblock records that both the table-wide and the partial unique were
    // REMOVED, because one product legitimately carries two variants sharing a
    // SKU on Shopify while WooCommerce enforces it site-wide, and a connector
    // has to import both. Pinned here so a later reader does not reach for a
    // duplicate SKU to force a rollback, as this file first did.
    const draft = await openAxonDraft({
      title: 'Lumira Axon 9 Pro — duplicate SKU',
      sku: SHARED_SKU,
      canonicalVariantId: axonVariantId,
    });
    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: `${TOKEN}-duplicate-sku-key`,
    });
    expect(publication.outcome).toBe('published');
    if (publication.outcome === 'refused') return;
    expect(publication.listingId).not.toBe(firstListingId);
    expect(await countStoreListings(db, storeId)).toBe(listingsBefore + 1);

    // Two variants on two listings sharing one SKU — the state the removed index
    // would have refused.
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from product_variants where sku = ${SHARED_SKU}`,
      ),
    ).toBe(2);
  });
});

describe('a guard raised INSIDE the transaction leaves nothing behind', () => {
  it('rolls back the work of the variant that was FINE, not only the one that was not', async () => {
    const listingsBefore = await countStoreListings(db, storeId);
    const countBefore = await storeProductCount();
    const linksBefore = await countOne(
      db,
      sql`select count(*)::int as total from native_listing_links l
          join listings s on s.id = l.listing_id where s.store_id = ${storeId}`,
    );

    /**
     * TWO variants, and only the second is wrong.
     *
     * `publish.service.ts` walks the declared variants in position order and, for
     * each, resolves the selection, checks `canonicalVariantBelongsToProduct` and
     * inserts the `native_listing_links` row — so variant 0's link has ALREADY
     * been written when variant 1's check raises. That is what makes the
     * absences below a rollback of real work: a half-published listing carrying
     * one link and not the other is precisely the state a non-transactional
     * implementation leaves, and it is the one a merchant would never find.
     */
    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: seeded.actorOxyUserId,
      categoryId,
      productTypeKey: nsKey(ns, 'smartphone'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: 'Lumira Axon 9 Pro — one good variant and one wrong',
    });
    const patched = await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: E2E_PERMISSIONS,
      description: 'A publication-recovery fixture listing.',
      selectedCanonicalProductId: axonProductId,
      fields: [
        {
          attributeKey: nsKey(ns, 'chipset'),
          values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
        },
        { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.7, unit: 'in' }] },
      ],
      variants: [
        // Position 0 — entirely correct.
        {
          sku: GOOD_SKU,
          inventoryAvailable: 2,
          price: { amount: 129900, currency: 'EUR' },
          selectedCanonicalVariantId: axonVariantId,
          axes: await axonAxes({ storageGb: 256, color: 'black', region: 'eu' }),
        },
        // Position 1 — a configuration of the OTHER brand's phone.
        {
          sku: WRONG_SKU,
          inventoryAvailable: 2,
          price: { amount: 149900, currency: 'EUR' },
          selectedCanonicalVariantId: veroVariantId,
          axes: await axonAxes({ storageGb: 512, color: 'blue', region: 'us' }),
        },
      ],
    });
    collidingDraftId = patched.id;
    collidingDraftVersion = patched.version;

    // It VALIDATES: nothing about the draft's own shape is wrong. The refusal is
    // a fact about the catalogue it is being written against, which is exactly
    // why it has to be a rollback rather than a validation finding.
    const validation = await validateStoreDraft(db, {
      storeId,
      draftId: patched.id,
      permissions: E2E_PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the draft was refused before publication: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    let raised: unknown;
    try {
      await publishDraft(db, {
        storeId,
        draftId: patched.id,
        actorOxyUserId: seeded.actorOxyUserId,
        permissions: E2E_PERMISSIONS,
        idempotencyKey: `${TOKEN}-wrong-product-key`,
      });
    } catch (error) {
      raised = error;
    }
    expect(raised, 'the wrong-configuration publication did not fail').toBeDefined();
    // WHICH guard, by its own words. A bare "it threw" would pass against a
    // validation refusal, a connection failure or any other accident.
    expect(causeMessage(raised)).toContain('belongs to a different catalogue product');
    /**
     * And WHICH variant — the positive evidence that work was undone.
     *
     * The guard names `variant.position + 1`, and in `publish.service.ts` the
     * `native_listing_links` insert sits in the SAME loop iteration immediately
     * after the check. So a message naming variant TWO means the loop completed
     * position 0, link included. Without this line every assertion below would be
     * an absence, and absences alone cannot tell a rollback from a publication
     * that refused before writing anything. The case beneath this one shows the
     * number tracks the position rather than being a constant.
     */
    expect(causeMessage(raised)).toContain('variant 2');

    // Nothing survives: not the listing, not either variant, not the link the
    // GOOD variant had already been given, and not the store's own counter.
    expect(await countStoreListings(db, storeId)).toBe(listingsBefore);
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from product_variants
            where sku in (${GOOD_SKU}, ${WRONG_SKU})`,
      ),
    ).toBe(0);
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from native_listing_links l
            join listings s on s.id = l.listing_id where s.store_id = ${storeId}`,
      ),
    ).toBe(linksBefore);
    expect(await storeProductCount()).toBe(countBefore);

    // And the draft is intact and recoverable: open, at its own version, with
    // every answer and both variants still there.
    const after = await readDraft(db, storeId, patched.id);
    expect(after.status).toBe('open');
    expect(after.version).toBe(collidingDraftVersion);
    expect(after.publishedListingId ?? null).toBeNull();
    const values = await listDraftValues(db, patched.id);
    const variants = await listDraftVariants(db, patched.id);
    expect(values.length).toBeGreaterThanOrEqual(8);
    expect(variants).toHaveLength(2);
    expect(variants.map((row) => row.sku).sort()).toEqual([GOOD_SKU, WRONG_SKU].sort());

    reportPopulation('the rolled-back publication', {
      listingsBefore,
      listingsAfter: await countStoreListings(db, storeId),
      draftValuesIntact: values.length,
      draftVariantsIntact: variants.length,
      linksUnchanged: linksBefore,
      storeProductCount: await storeProductCount(),
    });
  });

  it('names variant ONE when the wrong variant is first — so the number is not a constant', async () => {
    // The control on the line above. If the guard's message carried a fixed
    // number, `toContain('variant 2')` would pass while proving nothing about
    // how far the loop got.
    const listingsBefore = await countStoreListings(db, storeId);
    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: seeded.actorOxyUserId,
      categoryId,
      productTypeKey: nsKey(ns, 'smartphone'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: 'Lumira Axon 9 Pro — wrong variant first',
    });
    await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: E2E_PERMISSIONS,
      description: 'A publication-recovery fixture listing.',
      selectedCanonicalProductId: axonProductId,
      fields: [
        {
          attributeKey: nsKey(ns, 'chipset'),
          values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
        },
        { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.7, unit: 'in' }] },
      ],
      variants: [
        {
          sku: `${TOKEN}-AXON-WRONG-FIRST`,
          inventoryAvailable: 2,
          price: { amount: 149900, currency: 'EUR' },
          selectedCanonicalVariantId: veroVariantId,
          axes: await axonAxes({ storageGb: 512, color: 'blue', region: 'us' }),
        },
        {
          sku: `${TOKEN}-AXON-GOOD-SECOND`,
          inventoryAvailable: 2,
          price: { amount: 129900, currency: 'EUR' },
          selectedCanonicalVariantId: axonVariantId,
          axes: await axonAxes({ storageGb: 256, color: 'black', region: 'eu' }),
        },
      ],
    });

    let raised: unknown;
    try {
      await publishDraft(db, {
        storeId,
        draftId: draft.id,
        actorOxyUserId: seeded.actorOxyUserId,
        permissions: E2E_PERMISSIONS,
        idempotencyKey: null,
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeDefined();
    expect(causeMessage(raised)).toContain('variant 1');
    expect(causeMessage(raised)).not.toContain('variant 2');
    expect(await countStoreListings(db, storeId)).toBe(listingsBefore);
  });

  it('publishes the SAME draft once the wrong selection is corrected — no data re-entry', async () => {
    expect(collidingDraftId, 'the rollback case did not run').not.toBe('');
    const listingsBefore = await countStoreListings(db, storeId);
    const countBefore = await storeProductCount();

    // ONE field moves: variant 1's canonical selection. The description, the
    // chipset, the screen size, the product selection and variant 0 are all what
    // the failed attempt already stored, and are not re-sent.
    const repaired = await patchDraft(db, {
      storeId,
      draftId: collidingDraftId,
      expectedVersion: collidingDraftVersion,
      permissions: E2E_PERMISSIONS,
      variants: [
        {
          sku: GOOD_SKU,
          inventoryAvailable: 2,
          price: { amount: 129900, currency: 'EUR' },
          selectedCanonicalVariantId: axonVariantId,
          axes: await axonAxes({ storageGb: 256, color: 'black', region: 'eu' }),
        },
        {
          sku: WRONG_SKU,
          inventoryAvailable: 2,
          price: { amount: 149900, currency: 'EUR' },
          selectedCanonicalVariantId: axonSecondVariantId,
          axes: await axonAxes({ storageGb: 512, color: 'blue', region: 'us' }),
        },
      ],
    });
    expect(repaired.description).toBe('A publication-recovery fixture listing.');
    expect(repaired.selectedCanonicalProductId).toBe(axonProductId);

    const publication = await publishDraft(db, {
      storeId,
      draftId: collidingDraftId,
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      // The SAME key the failed attempt sent. It claimed nothing, because the
      // transaction that would have recorded it rolled back — so the retry
      // publishes rather than converging on a listing that does not exist.
      idempotencyKey: `${TOKEN}-wrong-product-key`,
    });
    expect(publication.outcome).toBe('published');
    if (publication.outcome === 'refused') return;
    expect(publication.listingId).not.toBe(firstListingId);
    expect(await countStoreListings(db, storeId)).toBe(listingsBefore + 1);
    expect(await storeProductCount()).toBe(countBefore + 1);
    // Both variants linked this time — the work the rollback undid, redone whole.
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from native_listing_links
            where listing_id = ${publication.listingId} and status = 'active'`,
      ),
    ).toBe(2);
  });
});

describe('a retry that lost its response creates nothing', () => {
  it('converges on the listing the first attempt made, under the same key', async () => {
    const listingsBefore = await countStoreListings(db, storeId);

    const again = await publishDraft(db, {
      storeId,
      // The draft the FIRST case published, whose response a client might have lost.
      draftId: await firstPublishedDraftId(),
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: `${TOKEN}-first-key`,
    });
    expect(again.outcome).toBe('converged');
    if (again.outcome === 'refused') return;
    expect(again.listingId).toBe(firstListingId);
    expect(await countStoreListings(db, storeId)).toBe(listingsBefore);
  });

  it('converges under a DIFFERENT key too, because the draft is already published', async () => {
    const listingsBefore = await countStoreListings(db, storeId);
    const again = await publishDraft(db, {
      storeId,
      draftId: await firstPublishedDraftId(),
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: `${TOKEN}-some-other-key`,
    });
    expect(again.outcome).toBe('converged');
    if (again.outcome === 'refused') return;
    // Convergence step 1 reads the draft's own `published_listing_id`, whatever
    // key arrived — a client that retried with a fresh key still gets its listing
    // rather than a second one.
    expect(again.listingId).toBe(firstListingId);
    expect(await countStoreListings(db, storeId)).toBe(listingsBefore);
  });

  it('does NOT converge a different draft onto that listing — the control', async () => {
    const listingsBefore = await countStoreListings(db, storeId);
    const draft = await openAxonDraft({
      title: 'Lumira Axon 9 Pro — independent',
      sku: `${TOKEN}-AXON-INDEPENDENT`,
      canonicalVariantId: axonVariantId,
    });
    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: `${TOKEN}-independent-key`,
    });
    expect(publication.outcome).toBe('published');
    if (publication.outcome === 'refused') return;
    // Without this, the two convergences above would also pass against a service
    // that answered every publish with the store's first listing.
    expect(publication.listingId).not.toBe(firstListingId);
    expect(await countStoreListings(db, storeId)).toBe(listingsBefore + 1);

    reportPopulation('publication recovery', {
      storeListings: await countStoreListings(db, storeId),
      publishedDrafts: await countOne(
        db,
        sql`select count(*)::int as total from catalog_authoring_drafts
            where store_id = ${storeId} and status = 'published'`,
      ),
      openDrafts: await countOne(
        db,
        sql`select count(*)::int as total from catalog_authoring_drafts
            where store_id = ${storeId} and status = 'open'`,
      ),
      storeProductCount: await storeProductCount(),
    });
  });
});

/** The draft id behind `firstListingId`, resolved rather than carried. */
async function firstPublishedDraftId(): Promise<string> {
  expect(firstListingId, 'the first publication did not run').not.toBe('');
  const rows = await db.execute<{ id: string }>(sql`
    select id from catalog_authoring_drafts
    where store_id = ${storeId} and published_listing_id = ${firstListingId}
  `);
  const id = [...rows][0]?.id;
  if (id === undefined) throw new Error('no draft names the first listing');
  return id;
}
