/**
 * The "Sell yours" flow, against a REAL PostgreSQL database.
 *
 * Six properties live here and CANNOT live anywhere else, because every one of
 * them is a CHECK, a trigger, a partial unique or a row lock — none of which a
 * mocked drizzle handle has a counterpart for:
 *
 *  - **a publication is stamped exactly once**, so a repeated submit produces
 *    ONE listing and ONE offer (#91 acceptance 3);
 *  - **the match trail is append-only**, so changing an incorrect match leaves
 *    both answers behind (#91 acceptance 4);
 *  - **a borrowed photograph is refused by the SERVER**, whichever writer
 *    attempts it (#91 trust rule 2);
 *  - **a refusal must name a blocker**, which `cardinality(...) >= 1` holds and
 *    the `array_length` spelling would have admitted;
 *  - **a match state and its ids cannot disagree**, so a rejection cannot keep
 *    the product it rejected;
 *  - **an unmatched draft publishes a perfectly valid listing** (#91 acceptance
 *    5), which is the state a refused declaration also lands in.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every row this file writes carries a per-run suffix
 * and teardown deletes exactly what it created. A bare
 * `delete from seller_listing_drafts` would silently empty a sibling's fixtures
 * mid-run.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { categories, listings } from '../../../db/schema/catalog.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { sellerDraftImages, sellerListingDrafts } from '../../../db/schema/sellYours.js';
import {
  ensureSellerDraft,
  stampPublication,
  updateSellerDraft,
} from '../../../db/sellYours/draftRepository.js';
import {
  listSellerMatchAssertions,
  recordSellerMatchAssertion,
} from '../../../db/sellYours/matchAssertionRepository.js';
import { patchSellerDraft, startSellerDraft } from '../draft.service.js';
import { publishSellerDraft } from '../publish.service.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(0, 12);

const createdDraftIds: string[] = [];
const createdListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  const draftIds = createdDraftIds.splice(0);
  const listingIds = createdListingIds.splice(0);
  const categoryIds = createdCategoryIds.splice(0);
  if (draftIds.length > 0) {
    await db.delete(sellerListingDrafts).where(inArray(sellerListingDrafts.id, draftIds));
  }
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  if (categoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, categoryIds));
  }
  const productIds = createdProductIds.splice(0);
  if (productIds.length > 0) {
    // The variant FK is RESTRICT, not cascade — #56 refuses to let a product be
    // deleted out from under the configurations that define it — so the
    // children go first. The listings above are already gone, which is what
    // released the `native_listing_links` rows pointing at these variants.
    await deleteTestCanonicalRows(db, { productIds });
  }
});

/** A canonical product with one variant, owned by this file. */
async function makeCanonicalProduct(): Promise<{ productId: string; variantId: string }> {
  /**
   * The WHOLE uuid, not a prefix.
   *
   * A uuid v7's leading bits are a millisecond timestamp, so `slice(0, 8)`
   * collides for two products created in the same millisecond — which is what a
   * test that builds two fixtures in a row does. Measured here on the first run,
   * as a `canonical_products_slug_key` violation.
   */
  const slug = `sy-${RUN}-${uuidv7()}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({ slug, name: slug, normalizedName: slug })
    .returning();
  createdProductIds.push(product.id);
  // `canonical_variants_signature_shape_check` demands a sha-256 hex digest: a
  // signature this codebase did not produce would silently weaken the
  // uniqueness the column exists for.
  const signature = createHash('sha256').update(`${slug}:default`).digest('hex');
  const [variant] = await db
    .insert(canonicalVariants)
    .values({ productId: product.id, signature, isDefault: true })
    .returning();
  return { productId: product.id, variantId: variant.id };
}

/**
 * Assert a rejection whose CAUSE carries `pattern`.
 *
 * drizzle wraps a server error in a `Failed query: …` message and keeps the
 * server's own text on `cause`, so `rejects.toThrow(/…/)` matches the wrapper
 * and passes for ANY failed statement — a check that cannot tell the constraint
 * it is about from a typo in the SQL beside it.
 */
async function expectServerRefusal(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'the statement was accepted; the server was expected to refuse it').toBeDefined();
  const texts: string[] = [];
  let current: unknown = caught;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    texts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  expect(texts.join(' | ')).toMatch(pattern);
}

/** A category this file owns, so a condition restriction elsewhere cannot bite. */
async function makeCategory(): Promise<{ id: string; slug: string }> {
  const slug = `sell-yours-${RUN}-${uuidv7().slice(0, 8)}`;
  const [row] = await db
    .insert(categories)
    .values({ key: slug, name: slug, slug, ancestorSlugs: [] })
    .returning();
  createdCategoryIds.push(row.id);
  return { id: row.id, slug };
}

/** A draft that is READY to publish — every readiness block cleared. */
async function makeReadyDraft(oxyUserId: string): Promise<string> {
  const category = await makeCategory();
  const draft = await startSellerDraft(oxyUserId, {
    clientDraftKey: `key-${RUN}-${uuidv7().slice(0, 8)}`,
    entryPath: 'unmatched',
  });
  createdDraftIds.push(draft.id);

  await patchSellerDraft(oxyUserId, draft.id, {
    title: 'A used thing',
    description: 'It works.',
    category: category.slug,
    conditionKey: 'used_good',
    quantity: 1,
    price: { amount: 1_000, currency: 'EUR' },
    conditionDetails: [{ kind: 'cosmetic_wear', severity: 'light' }],
    defectsAcknowledged: true,
    images: [
      { fileId: `file-${RUN}-a-${uuidv7().slice(0, 8)}`, provenance: 'seller_captured' },
      { fileId: `file-${RUN}-b-${uuidv7().slice(0, 8)}`, provenance: 'seller_captured' },
    ],
  });
  return draft.id;
}

describe('a publication is stamped exactly once', () => {
  it('a repeated publish returns the SAME listing and creates nothing new', async () => {
    const oxyUserId = `seller-${RUN}-once`;
    const draftId = await makeReadyDraft(oxyUserId);

    const first = await publishSellerDraft(oxyUserId, draftId);
    createdListingIds.push(first.listingId);
    expect(first.created).toBe(true);

    const second = await publishSellerDraft(oxyUserId, draftId);
    expect(second.created).toBe(false);
    expect(second.listingId).toBe(first.listingId);

    const rows = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.oxyUserId, oxyUserId));
    expect(rows).toHaveLength(1);
  });

  it('the TRIGGER refuses a second listing id even when the CAS is bypassed', async () => {
    // The CAS in `stampPublication` is the service's guarantee; this is the
    // database's, and it is what holds against a writer that never came through
    // the service. Mutating the CAS away leaves the suite green without it.
    const oxyUserId = `seller-${RUN}-trigger`;
    const draftId = await makeReadyDraft(oxyUserId);
    const published = await publishSellerDraft(oxyUserId, draftId);
    createdListingIds.push(published.listingId);

    await expectServerRefusal(
      () =>
        db
          .update(sellerListingDrafts)
          .set({ publishedListingId: `some-other-listing-${RUN}` })
          .where(eq(sellerListingDrafts.id, draftId)),
      /already published/i,
    );
  });

  it('`stampPublication` reports FALSE on an already-stamped draft', async () => {
    const oxyUserId = `seller-${RUN}-cas`;
    const draftId = await makeReadyDraft(oxyUserId);
    const published = await publishSellerDraft(oxyUserId, draftId);
    createdListingIds.push(published.listingId);

    // The rowcount IS the answer: zero means somebody else published it, which
    // is what makes the service return THEIR listing rather than making one.
    await expect(stampPublication(draftId, published.listingId, new Date())).resolves.toBe(false);
  });
});

describe('the match trail is append-only', () => {
  it('UPDATE is refused, and so is a DELETE while the draft still exists', async () => {
    const oxyUserId = `seller-${RUN}-trail`;
    const draft = await ensureSellerDraft({
      oxyUserId,
      clientDraftKey: `key-${RUN}-trail`,
      entryPath: 'unmatched',
      canonicalProductId: null,
      canonicalVariantId: null,
      matchState: 'unmatched',
      matchActor: null,
    });
    createdDraftIds.push(draft.id);

    const assertion = await recordSellerMatchAssertion({
      draftId: draft.id,
      outcome: 'declared',
      actor: 'seller',
      actorOxyUserId: oxyUserId,
      canonicalProductId: null,
      canonicalVariantId: null,
      confidence: null,
      blockers: [],
      reasonCodes: ['entry_path:unmatched'],
    });

    await expectServerRefusal(
      () =>
        db.execute(
          sql`update seller_draft_match_assertions set outcome = 'confirmed' where id = ${assertion.id}`,
        ),
      /append-only/i,
    );
    await expectServerRefusal(
      () => db.execute(sql`delete from seller_draft_match_assertions where id = ${assertion.id}`),
      /append-only/i,
    );

    const trail = await listSellerMatchAssertions(draft.id);
    expect(trail).toHaveLength(1);
  });

  it('the CASCADE from a deleted draft still removes its trail', async () => {
    /**
     * The delete exception, measured rather than assumed.
     *
     * The FIRST version of this trigger refused every DELETE unconditionally,
     * which made a draft carrying any assertion undeletable — an erasure request
     * against it would fail at the database. The realdb suite caught it in this
     * file's TEARDOWN, not in an assertion, which is why the case now has one.
     */
    const oxyUserId = `seller-${RUN}-cascade`;
    const draft = await ensureSellerDraft({
      oxyUserId,
      clientDraftKey: `key-${RUN}-cascade`,
      entryPath: 'unmatched',
      canonicalProductId: null,
      canonicalVariantId: null,
      matchState: 'unmatched',
      matchActor: null,
    });
    await recordSellerMatchAssertion({
      draftId: draft.id,
      outcome: 'declared',
      actor: 'seller',
      actorOxyUserId: oxyUserId,
      canonicalProductId: null,
      canonicalVariantId: null,
      confidence: null,
      blockers: [],
      reasonCodes: ['entry_path:unmatched'],
    });

    await expect(
      db.delete(sellerListingDrafts).where(eq(sellerListingDrafts.id, draft.id)),
    ).resolves.toBeDefined();
    expect(await listSellerMatchAssertions(draft.id)).toEqual([]);
  });

  it('a refusal that names no blocker is unrepresentable', async () => {
    // `cardinality(...) >= 1`, never `array_length(...)`: the latter is NULL on
    // `{}` and a CHECK reads NULL as SATISFIED, so the obvious spelling admits
    // exactly the row it exists to refuse.
    const oxyUserId = `seller-${RUN}-blockers`;
    const draft = await ensureSellerDraft({
      oxyUserId,
      clientDraftKey: `key-${RUN}-blockers`,
      entryPath: 'unmatched',
      canonicalProductId: null,
      canonicalVariantId: null,
      matchState: 'unmatched',
      matchActor: null,
    });
    createdDraftIds.push(draft.id);

    await expect(
      recordSellerMatchAssertion({
        draftId: draft.id,
        outcome: 'gate_refused',
        actor: 'seller',
        actorOxyUserId: oxyUserId,
        canonicalProductId: null,
        canonicalVariantId: null,
        confidence: null,
        blockers: [],
        reasonCodes: [],
      }),
    ).rejects.toThrow();
  });
});

describe('a photograph must be the seller’s own', () => {
  it('a file another account’s listing already shows is refused by the SERVER', async () => {
    const owner = `seller-${RUN}-owner`;
    const thief = `seller-${RUN}-thief`;
    const borrowedFileId = `file-${RUN}-borrowed`;

    const ownerDraftId = await makeReadyDraft(owner);
    const published = await publishSellerDraft(owner, ownerDraftId);
    createdListingIds.push(published.listingId);
    // Give the published listing the file id the thief will try to reuse.
    await db.execute(
      sql`insert into listing_images (id, listing_id, file_id, position)
          values (${uuidv7()}, ${published.listingId}, ${borrowedFileId}, 0)`,
    );

    const thiefDraft = await ensureSellerDraft({
      oxyUserId: thief,
      clientDraftKey: `key-${RUN}-thief`,
      entryPath: 'unmatched',
      canonicalProductId: null,
      canonicalVariantId: null,
      matchState: 'unmatched',
      matchActor: null,
    });
    createdDraftIds.push(thiefDraft.id);

    await expectServerRefusal(
      () =>
        db.insert(sellerDraftImages).values({
          draftId: thiefDraft.id,
          fileId: borrowedFileId,
          provenance: 'seller_captured',
          position: 0,
        }),
      /another seller/i,
    );
  });

  it('the seller’s OWN listing image is allowed — relisting is not borrowing', async () => {
    const owner = `seller-${RUN}-relist`;
    const ownDraftId = await makeReadyDraft(owner);
    const published = await publishSellerDraft(owner, ownDraftId);
    createdListingIds.push(published.listingId);

    const ownFileId = `file-${RUN}-own`;
    await db.execute(
      sql`insert into listing_images (id, listing_id, file_id, position)
          values (${uuidv7()}, ${published.listingId}, ${ownFileId}, 0)`,
    );

    const relist = await ensureSellerDraft({
      oxyUserId: owner,
      clientDraftKey: `key-${RUN}-relist-2`,
      entryPath: 'unmatched',
      canonicalProductId: null,
      canonicalVariantId: null,
      matchState: 'unmatched',
      matchActor: null,
    });
    createdDraftIds.push(relist.id);

    await expect(
      db.insert(sellerDraftImages).values({
        draftId: relist.id,
        fileId: ownFileId,
        provenance: 'seller_captured',
        position: 0,
      }),
    ).resolves.toBeDefined();
  });
});

describe('a match state and its ids cannot disagree', () => {
  it('a rejection cannot keep the product it rejected', async () => {
    const oxyUserId = `seller-${RUN}-shape`;
    const draft = await ensureSellerDraft({
      oxyUserId,
      clientDraftKey: `key-${RUN}-shape`,
      entryPath: 'unmatched',
      canonicalProductId: null,
      canonicalVariantId: null,
      matchState: 'unmatched',
      matchActor: null,
    });
    createdDraftIds.push(draft.id);

    await expect(
      db.execute(
        sql`update seller_listing_drafts
               set match_state = 'seller_rejected',
                   canonical_product_id = ${'some-product-' + RUN}
             where id = ${draft.id}`,
      ),
    ).rejects.toThrow();
  });

  it('a proposed match with no product is unrepresentable', async () => {
    const oxyUserId = `seller-${RUN}-shape2`;
    const draft = await ensureSellerDraft({
      oxyUserId,
      clientDraftKey: `key-${RUN}-shape2`,
      entryPath: 'unmatched',
      canonicalProductId: null,
      canonicalVariantId: null,
      matchState: 'unmatched',
      matchActor: null,
    });
    createdDraftIds.push(draft.id);

    await expect(
      updateSellerDraft(draft.id, oxyUserId, { matchState: 'proposed' }),
    ).rejects.toThrow();
  });
});

describe('an unmatched item is fully publishable', () => {
  it('publishes an active listing with a variant and no attachment', async () => {
    const oxyUserId = `seller-${RUN}-unmatched`;
    const draftId = await makeReadyDraft(oxyUserId);
    const published = await publishSellerDraft(oxyUserId, draftId);
    createdListingIds.push(published.listingId);

    expect(published.match).toEqual({ state: 'unmatched' });

    const [listing] = await db
      .select({ status: listings.status, ownerType: listings.ownerType })
      .from(listings)
      .where(eq(listings.id, published.listingId));
    expect(listing.status).toBe('active');
    expect(listing.ownerType).toBe('user');

    const variants = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from product_variants where listing_id = ${published.listingId}`,
    );
    expect(Number([...variants][0].count)).toBe(1);

    const links = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from native_listing_links where listing_id = ${published.listingId}`,
    );
    expect(Number([...links][0].count)).toBe(0);
  });

  it('a draft that is not ready is refused and creates NO listing', async () => {
    const oxyUserId = `seller-${RUN}-notready`;
    const draft = await startSellerDraft(oxyUserId, {
      clientDraftKey: `key-${RUN}-notready`,
      entryPath: 'unmatched',
    });
    createdDraftIds.push(draft.id);

    await expect(publishSellerDraft(oxyUserId, draft.id)).rejects.toThrow(/cannot be published/i);

    const rows = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.oxyUserId, oxyUserId));
    expect(rows).toEqual([]);
  });
});

describe('a seller-declared match becomes an attachment', () => {
  it('publishes a `seller_declared` link with NULL confidence', async () => {
    /**
     * The positive control for the whole gate.
     *
     * Every other case here proves something is REFUSED, and a gate that
     * refused everything would pass all of them — which is the shape of a check
     * that cannot tell success from failure. This is the one that proves the
     * flow's point works: a seller who started from a product page ends up on
     * that product page.
     */
    const oxyUserId = `seller-${RUN}-attach`;
    const canonical = await makeCanonicalProduct();
    const category = await makeCategory();

    const draft = await startSellerDraft(oxyUserId, {
      clientDraftKey: `key-${RUN}-attach`,
      entryPath: 'canonical_variant',
      canonicalProductId: canonical.productId,
      canonicalVariantId: canonical.variantId,
    });
    createdDraftIds.push(draft.id);

    await patchSellerDraft(oxyUserId, draft.id, {
      title: 'My own copy',
      description: 'Works fine.',
      category: category.slug,
      conditionKey: 'used_good',
      price: { amount: 5_000, currency: 'EUR' },
      matchConfirmed: true,
      conditionDetails: [{ kind: 'cosmetic_wear', severity: 'light' }],
      defectsAcknowledged: true,
      images: [
        { fileId: `file-${RUN}-m1-${uuidv7().slice(0, 8)}`, provenance: 'seller_captured' },
        { fileId: `file-${RUN}-m2-${uuidv7().slice(0, 8)}`, provenance: 'seller_captured' },
      ],
    });

    const published = await publishSellerDraft(oxyUserId, draft.id);
    createdListingIds.push(published.listingId);
    expect(published.match).toEqual({
      state: 'attach',
      canonicalProductId: canonical.productId,
      canonicalVariantId: canonical.variantId,
    });

    const links = await db.execute<{ method: string; confidence: number | null }>(
      sql`select method, confidence from native_listing_links
           where listing_id = ${published.listingId} and status = 'active'`,
    );
    const rows = [...links];
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('seller_declared');
    // NULL like every non-`matcher` method: a person has no score.
    expect(rows[0].confidence).toBeNull();

    // …and the trail records that it was attached, beside the declaration.
    const trail = await listSellerMatchAssertions(draft.id);
    expect(trail.map((row) => row.outcome)).toContain('attached');
  });

  it('a declared PRODUCT with no variant is blocked rather than guessed at', async () => {
    // #58 rule 5: picking a configuration for somebody is the invention the
    // whole matching domain refuses. One tap fixes it, which is why it is worth
    // asking for rather than silently publishing unmatched.
    const oxyUserId = `seller-${RUN}-novariant`;
    const canonical = await makeCanonicalProduct();
    const category = await makeCategory();

    const draft = await startSellerDraft(oxyUserId, {
      clientDraftKey: `key-${RUN}-novariant`,
      entryPath: 'canonical_product',
      canonicalProductId: canonical.productId,
    });
    createdDraftIds.push(draft.id);

    await patchSellerDraft(oxyUserId, draft.id, {
      title: 'My own copy',
      description: 'Works fine.',
      category: category.slug,
      conditionKey: 'used_good',
      price: { amount: 5_000, currency: 'EUR' },
      conditionDetails: [{ kind: 'cosmetic_wear', severity: 'light' }],
      defectsAcknowledged: true,
      images: [
        { fileId: `file-${RUN}-n1-${uuidv7().slice(0, 8)}`, provenance: 'seller_captured' },
        { fileId: `file-${RUN}-n2-${uuidv7().slice(0, 8)}`, provenance: 'seller_captured' },
      ],
    });

    await expect(publishSellerDraft(oxyUserId, draft.id)).rejects.toThrow(
      /match_variant_missing/,
    );
  });
});

describe('an acknowledgement covers what was disclosed when it was given', () => {
  it('adding a defect afterwards CLEARS the acknowledgement', async () => {
    const oxyUserId = `seller-${RUN}-ack`;
    const category = await makeCategory();
    const draft = await startSellerDraft(oxyUserId, {
      clientDraftKey: `key-${RUN}-ack`,
      entryPath: 'unmatched',
    });
    createdDraftIds.push(draft.id);

    await patchSellerDraft(oxyUserId, draft.id, {
      title: 'A used thing',
      description: 'It works.',
      category: category.slug,
      conditionKey: 'used_good',
      price: { amount: 1_000, currency: 'EUR' },
      conditionDetails: [{ kind: 'cosmetic_wear', severity: 'light' }],
      defectsAcknowledged: true,
    });

    const acknowledged = await patchSellerDraft(oxyUserId, draft.id, {});
    expect(acknowledged.draft.defectsAcknowledgedAt).not.toBeNull();

    const afterNewDefect = await patchSellerDraft(oxyUserId, draft.id, {
      conditionDetails: [
        { kind: 'cosmetic_wear', severity: 'light' },
        { kind: 'functional_defect', severity: 'heavy', note: 'The hinge is broken.' },
      ],
    });
    expect(
      afterNewDefect.draft.defectsAcknowledgedAt,
      'a defect disclosed AFTER the acknowledgement cannot inherit it — #90 stores the instant ' +
        'precisely so "they agreed, to this" is answerable',
    ).toBeNull();
  });
});
