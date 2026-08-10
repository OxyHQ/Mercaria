/**
 * Brand and product-family pages against a REAL PostgreSQL database (#72).
 *
 * The properties pinned here are the ones a mock cannot see: the temporal
 * relationship window is evaluated IN the statement, so a lapsed claim stops
 * producing a badge with no sweep having run; the merge tombstone chain is a
 * real self-referential foreign key; the keyset cursor is a real index walk;
 * and a product with two merchants' offers is one row because the statement
 * selects `canonical_products` and never joins `offers`.
 *
 * Acceptance criteria mapped to tests:
 *  1. "An Apple page can show the iPhone family, iPhone products and verified
 *     Apple Store channels without listing Amazon as Apple" — a merchant with
 *     offers on the brand's products and NO relationship appears in neither
 *     list.
 *  2. "An Amazon merchant page remains separate" — the brand page carries no
 *     merchant catalogue at all; a merchant appears only as the subject of a
 *     verified relationship.
 *  3. "Market-scoped official channels differ correctly between two test
 *     countries."
 *  4. "Revoking a relationship removes the badge and navigation after cache
 *     invalidation" — here, immediately, because the read is derived.
 *  5. "Products are deduplicated across merchants."
 *  6. "Brand and family routes survive merges through redirects."
 *  7. "Public fields and visual assets retain provenance and rights metadata" —
 *     plus a RUNTIME walk of a real emitted page for the forbidden fields.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every name, slug and id this file writes carries the
 * per-run suffix and teardown deletes exactly what it created. Nothing here
 * asserts a global count.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { brands, brandAliases, brandSourceLinks, organizations } from '../../db/schema/organizations.js';
import {
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariants,
} from '../../db/schema/canonicalCatalog.js';
import { commerceRelationships } from '../../db/schema/relationships.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { merchants } from '../../db/schema/merchants.js';
import { offers } from '../../db/schema/offers.js';
import { catalogReviewItems } from '../../db/schema/curation.js';
import { CATALOG_PAGE_FORBIDDEN_FIELDS } from '@mercaria/shared-types';
import { createBrand } from '../canonical/brand.service.js';
import { createProductFamily } from '../canonical/product-family.service.js';
import { createCanonicalProduct } from '../canonical/canonical-product.service.js';
import { createVariant } from '../canonical/canonical-variant.service.js';
import { createMerchant } from '../commerce-graph/merchant.service.js';
import { recordExternalOffer } from '../offers/offer.service.js';
import { readBrandPage, readBrandProducts } from '../catalog-pages/brand-page.service.js';
import {
  readProductFamilyPage,
  readProductFamilyProducts,
} from '../catalog-pages/family-page.service.js';
import { submitCatalogCorrection } from '../catalog-pages/correction.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdBrandIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdSourceIds: string[] = [];
const createdOrganizationIds: string[] = [];
const createdRelationshipIds: string[] = [];
const createdOfferIds: string[] = [];
const createdReviewItemIds: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db.delete(catalogReviewItems).where(inArray(catalogReviewItems.id, safeIds(createdReviewItemIds)));
  await db.delete(offers).where(inArray(offers.id, safeIds(createdOfferIds)));
  await db
    .delete(commerceRelationships)
    .where(inArray(commerceRelationships.id, safeIds(createdRelationshipIds)));
  // By PRODUCT, not by the variant ids this file tracked: a product with no
  // declared option axes gets a DEFAULT variant from `createCanonicalProduct`
  // itself, so a teardown keyed on the tracked ids leaves those behind and the
  // product delete fails on the foreign key. The real server caught it.
  await db
    .delete(canonicalVariants)
    .where(inArray(canonicalVariants.productId, safeIds(createdProductIds)));
  await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, safeIds(createdProductIds)));
  await db
    .delete(canonicalProductFamilies)
    .where(inArray(canonicalProductFamilies.id, safeIds(createdFamilyIds)));
  await db.delete(brandAliases).where(inArray(brandAliases.brandId, safeIds(createdBrandIds)));
  await db.delete(brandSourceLinks).where(inArray(brandSourceLinks.brandId, safeIds(createdBrandIds)));
  // Tombstones point at their winners, so the losers must go first.
  for (const id of [...createdBrandIds].reverse()) {
    await db.delete(brands).where(inArray(brands.id, [id]));
  }
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await db.delete(organizations).where(inArray(organizations.id, safeIds(createdOrganizationIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await closePostgres();
}, 120_000);

/** A displayable source registry row — no ingestion config, the #60 shape. */
async function mintSource(label: string, rights: { mayDisplay: boolean }): Promise<string> {
  const [row] = await db
    .insert(catalogSources)
    .values({
      kind: 'affiliate_network',
      name: `pages-${label}-${RUN}`,
      mayDisplay: rights.mayDisplay,
      mayStore: true,
      attributionRequired: true,
    })
    .returning({ id: catalogSources.id });
  if (!row) throw new Error('the catalog source was not written');
  createdSourceIds.push(row.id);
  return row.id;
}

async function mintSourceRecord(sourceId: string, externalId: string): Promise<string> {
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      externalType: 'offer',
      externalId: `${externalId}-${RUN}`,
      contentHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
      observedAt: new Date(),
      payload: { price: 1_999 },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  return record.id;
}

async function mintBrand(label: string, extras: { logoFileId?: string } = {}): Promise<string> {
  const brand = await createBrand({
    name: `Pages ${label} ${RUN}`,
    ...(extras.logoFileId === undefined ? {} : { logoFileId: extras.logoFileId }),
  });
  createdBrandIds.push(brand.id);
  return brand.id;
}

async function mintProduct(input: {
  label: string;
  brandId: string;
  familyId?: string;
  releasedAt?: Date;
}): Promise<string> {
  const product = await createCanonicalProduct({
    name: `Pages ${input.label} ${RUN}`,
    brandId: input.brandId,
    ...(input.familyId === undefined ? {} : { familyId: input.familyId }),
    ...(input.releasedAt === undefined ? {} : { releasedAt: input.releasedAt }),
  });
  createdProductIds.push(product.id);
  return product.id;
}

async function mintVariant(productId: string): Promise<string> {
  const result = await createVariant({ productId, options: [], isDefault: true });
  createdVariantIds.push(result.variant.id);
  return result.variant.id;
}

async function mintMerchant(label: string): Promise<string> {
  const merchant = await createMerchant({ name: `Pages ${label} ${RUN}` });
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

/** A VERIFIED relationship written directly — #55 owns the gates on verifying. */
async function mintVerifiedRelationship(input: {
  kind: 'merchant_official_channel_for_brand' | 'merchant_authorized_reseller_for_brand' | 'organization_owns_brand';
  brandId: string;
  merchantId?: string;
  organizationId?: string;
  territories?: string[];
  validTo?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(commerceRelationships)
    .values({
      kind: input.kind,
      brandId: input.brandId,
      merchantId: input.merchantId ?? null,
      organizationId: input.organizationId ?? null,
      territories: input.territories ?? [],
      languages: [],
      validFrom: new Date(Date.now() - 86_400_000),
      validTo: input.validTo ?? null,
      status: 'verified',
      // `commerce_relationships_verified_state_check` requires all three
      // together — a verdict, a method and an actor. The real server refused
      // the first version of this fixture, which is the whole reason these
      // cases run against one.
      verificationMethod: 'brand_statement',
      verifiedAt: new Date(Date.now() - 3_600_000),
      verifiedByOxyUserId: `pages-operator-${RUN}`,
      assertedByKind: 'platform_verification',
    })
    .returning({ id: commerceRelationships.id });
  if (!row) throw new Error('the relationship was not written');
  createdRelationshipIds.push(row.id);
  return row.id;
}

/** One current external offer for a variant. */
async function mintOffer(input: {
  sourceId: string;
  merchantId: string;
  variantId: string;
  externalOfferId: string;
  amount: number;
}): Promise<string> {
  const observedAt = new Date();
  const offerId = await recordExternalOffer(
    {
      kind: 'external',
      canonicalVariantId: input.variantId,
      merchantId: input.merchantId,
      sourceRecordId: await mintSourceRecord(input.sourceId, input.externalOfferId),
      provider: `pages-${RUN}`,
      externalOfferId: `${input.externalOfferId}-${RUN}`,
      destinationUrl: `https://example.test/${input.externalOfferId}`,
      price: { amount: input.amount, currency: 'EUR' },
      availability: 'in_stock',
      observedAt,
      staleAt: new Date(observedAt.getTime() + 86_400_000),
    },
    observedAt,
    db,
  );
  createdOfferIds.push(offerId);
  return offerId;
}

// ── Acceptances 1, 2 and 5 ──────────────────────────────────────────────────

describe('acceptance 1, 2 and 5 — a brand page lists channels, never sellers', () => {
  it('shows the verified store, leaves the ordinary retailer out of both lists, and shows one card per product', async () => {
    const brandId = await mintBrand('apple');
    const familyId = (await createProductFamily({ name: `Pages Phone ${RUN}`, brandId })).id;
    createdFamilyIds.push(familyId);

    const productId = await mintProduct({ label: 'phone-a', brandId, familyId });
    const variantId = await mintVariant(productId);

    const officialMerchantId = await mintMerchant('official-store');
    const ordinaryMerchantId = await mintMerchant('big-retailer');
    await mintVerifiedRelationship({
      kind: 'merchant_official_channel_for_brand',
      brandId,
      merchantId: officialMerchantId,
    });

    // The ordinary retailer sells the brand's product — twice over, from two
    // merchants — and holds no relationship at all. That is the NORMAL state
    // (ADR 0002 D10) and the whole of acceptance 1.
    const sourceId = await mintSource('offers', { mayDisplay: true });
    await mintOffer({ sourceId, merchantId: ordinaryMerchantId, variantId, externalOfferId: 'o1', amount: 99_900 });
    await mintOffer({ sourceId, merchantId: officialMerchantId, variantId, externalOfferId: 'o2', amount: 109_900 });

    const page = await readBrandPage({ handle: brandId, offerContext: 'included' }, db);
    expect(page).toBeDefined();
    if (!page) return;

    expect(page.channels.officialStores.map((entry) => entry.merchantId)).toEqual([
      officialMerchantId,
    ]);
    expect(page.channels.authorizedResellers).toEqual([]);
    // Acceptance 1: the retailer with the offers is in NEITHER list.
    const listed = [...page.channels.officialStores, ...page.channels.authorizedResellers];
    expect(listed.some((entry) => entry.merchantId === ordinaryMerchantId)).toBe(false);
    // Acceptance 2: a brand page has no merchant catalogue to be mistaken for.
    expect(page).not.toHaveProperty('listings');
    expect(page).not.toHaveProperty('inventory');
    expect(page.families.map((family) => family.familyId)).toContain(familyId);

    // Acceptance 5: two merchants' offers on one product are ONE card.
    const browse = await readBrandProducts(
      { handle: brandId, filters: {}, offerContext: 'included' },
      db,
    );
    expect(browse).toBeDefined();
    if (!browse) return;
    const cards = browse.products.filter((card) => card.canonicalProductId === productId);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.offers?.summary.currentOfferCount).toBe(2);
    // The representative price is the CHEAPEST of the two, in its own currency.
    expect(cards[0]?.offers?.summary.lowestPrice).toEqual({ amount: 99_900, currency: 'EUR' });
  });
});

// ── Acceptance 3 ────────────────────────────────────────────────────────────

describe('acceptance 3 — market-scoped channels differ between two countries', () => {
  it('answers a market-scoped claim only for its own market, and an unscoped claim everywhere', async () => {
    const brandId = await mintBrand('markets');
    const spanishMerchantId = await mintMerchant('es-store');
    const germanMerchantId = await mintMerchant('de-store');
    const globalMerchantId = await mintMerchant('global-reseller');

    await mintVerifiedRelationship({
      kind: 'merchant_official_channel_for_brand',
      brandId,
      merchantId: spanishMerchantId,
      territories: ['ES'],
    });
    await mintVerifiedRelationship({
      kind: 'merchant_official_channel_for_brand',
      brandId,
      merchantId: germanMerchantId,
      territories: ['DE'],
    });
    // An EMPTY territory array is `commerce_relationships`' own "unrestricted",
    // not "no markets" — so this one answers in both.
    await mintVerifiedRelationship({
      kind: 'merchant_authorized_reseller_for_brand',
      brandId,
      merchantId: globalMerchantId,
      territories: [],
    });

    const spain = await readBrandPage({ handle: brandId, market: 'ES', offerContext: 'included' }, db);
    const germany = await readBrandPage({ handle: brandId, market: 'DE', offerContext: 'included' }, db);

    expect(spain?.channels.officialStores.map((entry) => entry.merchantId)).toEqual([
      spanishMerchantId,
    ]);
    expect(germany?.channels.officialStores.map((entry) => entry.merchantId)).toEqual([
      germanMerchantId,
    ]);
    expect(spain?.channels.authorizedResellers.map((entry) => entry.merchantId)).toEqual([
      globalMerchantId,
    ]);
    expect(germany?.channels.authorizedResellers.map((entry) => entry.merchantId)).toEqual([
      globalMerchantId,
    ]);
    // #72 official-channel rule 4: a market-scoped claim carries its scope, so a
    // client never renders a global badge from one country's authorization.
    expect(spain?.channels.officialStores[0]?.territories).toEqual(['ES']);
    expect(spain?.channels.authorizedResellers[0]?.territories).toEqual([]);
    expect(spain?.channels.market).toBe('ES');
  });
});

// ── Acceptance 4 ────────────────────────────────────────────────────────────

describe('acceptance 4 — a lapsed or revoked claim stops producing a badge', () => {
  it('drops the channel the moment the window closes, with no sweep having run', async () => {
    const brandId = await mintBrand('lapsing');
    const merchantId = await mintMerchant('lapsing-store');
    const relationshipId = await mintVerifiedRelationship({
      kind: 'merchant_official_channel_for_brand',
      brandId,
      merchantId,
    });

    const before = await readBrandPage({ handle: brandId, offerContext: 'included' }, db);
    expect(before?.channels.officialStores.map((entry) => entry.merchantId)).toEqual([merchantId]);

    // Close the window in the PAST and run NO sweep. The public read requires
    // the window as well as the status, so the badge goes with the statement
    // that applies the change rather than with a queue.
    await db
      .update(commerceRelationships)
      .set({ validTo: new Date(Date.now() - 1_000) })
      .where(inArray(commerceRelationships.id, [relationshipId]));

    const after = await readBrandPage({ handle: brandId, offerContext: 'included' }, db);
    expect(after?.channels.officialStores).toEqual([]);
    expect(after?.channels.authorizedResellers).toEqual([]);
  });

  it('shows an owning organization only while its ownership claim stands', async () => {
    const brandId = await mintBrand('owned');
    // The brand needs a product, or the page is `thin` and emits no structured
    // data at all — which would make the JSON-LD assertion below pass for the
    // wrong reason.
    await mintProduct({ label: 'owned-product', brandId });
    const [organization] = await db
      .insert(organizations)
      .values({ name: `Pages Holdings ${RUN}`, slug: `pages-holdings-${RUN}`, normalizedName: `pages holdings ${RUN}` })
      .returning({ id: organizations.id });
    if (!organization) throw new Error('the organization was not written');
    createdOrganizationIds.push(organization.id);

    const relationshipId = await mintVerifiedRelationship({
      kind: 'organization_owns_brand',
      brandId,
      organizationId: organization.id,
    });

    const owned = await readBrandPage({ handle: brandId, offerContext: 'included' }, db);
    expect(owned?.owningOrganization?.organizationId).toBe(organization.id);
    expect(owned?.owningOrganization?.evidence).toBe('verified_relationship');
    // The JSON-LD may assert a legal entity ONLY from that verified claim.
    expect(owned?.structuredData.kind).toBe('organization');

    await db
      .update(commerceRelationships)
      // `commerce_relationships_revoked_state_check` requires all three: a
      // revocation is attributable, dated AND closes the window. A revoked row
      // with an open window would still satisfy the temporal predicate.
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        revokedByOxyUserId: `pages-operator-${RUN}`,
        validTo: new Date(),
      })
      .where(inArray(commerceRelationships.id, [relationshipId]));

    const unowned = await readBrandPage({ handle: brandId, offerContext: 'included' }, db);
    expect(unowned?.owningOrganization).toBeUndefined();
    expect(unowned?.structuredData.kind).not.toBe('organization');
  });
});

// ── Acceptance 6 ────────────────────────────────────────────────────────────

describe('acceptance 6 — brand and family routes survive a merge', () => {
  it('answers an old brand handle with the winner and reports the redirect', async () => {
    const winnerId = await mintBrand('merge-winner');
    const loserId = await mintBrand('merge-loser');
    const loser = await db.select().from(brands).where(inArray(brands.id, [loserId]));
    const loserSlug = loser[0]?.slug ?? '';

    await db
      .update(brands)
      .set({ status: 'merged', mergedIntoId: winnerId })
      .where(inArray(brands.id, [loserId]));

    const page = await readBrandPage({ handle: loserSlug, offerContext: 'included' }, db);
    expect(page?.brandId).toBe(winnerId);
    expect(page?.redirect).toEqual({ from: loserSlug, reason: 'merged' });
    // A tombstone is a hop, not a destination — so nothing puts it in a sitemap.
    expect(page?.canonicalPath).not.toContain(loserSlug);
  });

  it('answers an old family handle with the winner', async () => {
    const brandId = await mintBrand('family-merge');
    const winner = await createProductFamily({ name: `Pages Fam Winner ${RUN}`, brandId });
    const loser = await createProductFamily({ name: `Pages Fam Loser ${RUN}`, brandId });
    createdFamilyIds.push(winner.id, loser.id);

    await db
      .update(canonicalProductFamilies)
      .set({ status: 'merged', mergedIntoId: winner.id })
      .where(inArray(canonicalProductFamilies.id, [loser.id]));

    const page = await readProductFamilyPage(
      { handle: loser.slug, currency: 'EUR', offerContext: 'included' },
      db,
    );
    expect(page?.familyId).toBe(winner.id);
    expect(page?.redirect?.reason).toBe('merged');
  });
});

// ── Acceptance 7 ────────────────────────────────────────────────────────────

describe('acceptance 7 — public fields carry provenance and rights', () => {
  it('withholds a logo whose source may not be displayed, and shows one that may', async () => {
    const permissiveSourceId = await mintSource('permissive', { mayDisplay: true });
    const refusingSourceId = await mintSource('refusing', { mayDisplay: false });

    const shownBrandId = await mintBrand('logo-shown', { logoFileId: `file-shown-${RUN}` });
    const hiddenBrandId = await mintBrand('logo-hidden', { logoFileId: `file-hidden-${RUN}` });
    await db
      .update(brands)
      .set({ logoSourceRecordId: await mintSourceRecord(permissiveSourceId, 'logo-shown') })
      .where(inArray(brands.id, [shownBrandId]));
    await db
      .update(brands)
      .set({ logoSourceRecordId: await mintSourceRecord(refusingSourceId, 'logo-hidden') })
      .where(inArray(brands.id, [hiddenBrandId]));

    const shown = await readBrandPage({ handle: shownBrandId, offerContext: 'included' }, db);
    const hidden = await readBrandPage({ handle: hiddenBrandId, offerContext: 'included' }, db);

    expect(shown?.logo.state).toBe('displayable');
    if (shown?.logo.state === 'displayable') {
      expect(shown.logo.rightsBasis).toBe('source_licensed');
      expect(shown.logo.provenance?.sourceKind).toBe('affiliate_network');
      // Attribution is required on this source, so the page carries the name it
      // must be attributed to rather than showing the asset unattributed.
      expect(shown.logo.provenance?.attribution).toContain(`pages-permissive-${RUN}`);
      expect(shown.logo.provenance?.observedAt).toBeDefined();
    }

    // The fixture that matters: an asset Mercaria HOLDS and may not show.
    expect(hidden?.logo.state).toBe('withheld');
    if (hidden?.logo.state === 'withheld') {
      expect(hidden.logo.reason).toBe('no_display_right');
    }
    // …and a page whose facts a source refuses to have indexed is not indexable.
    expect(hidden?.structuredData).toEqual({ kind: 'none' });
  });

  it('emits no forbidden field on a real page — the runtime walk', async () => {
    const brandId = await mintBrand('walk');
    const page = await readBrandPage({ handle: brandId, offerContext: 'included' }, db);
    expect(page).toBeDefined();
    const serialized = JSON.stringify(page);
    // A vacuity floor: an empty response would satisfy every `not.toContain`.
    expect(serialized.length).toBeGreaterThan(200);
    for (const field of CATALOG_PAGE_FORBIDDEN_FIELDS) {
      expect(serialized, `a real brand page emitted ${field}`).not.toContain(`"${field}"`);
    }
  });
});

// ── The offer lever, and the empty state it must stay distinguishable from ──

describe('#72 brand rule 10 — an empty state that says which emptiness it is', () => {
  it('reports `withdrawn` when the offer lever is off, and `included` with no offers', async () => {
    const brandId = await mintBrand('empty-states');
    const productId = await mintProduct({ label: 'unsold', brandId });
    await mintVariant(productId);

    const withdrawn = await readBrandProducts(
      { handle: brandId, filters: {}, offerContext: 'withdrawn' },
      db,
    );
    expect(withdrawn?.offerContext).toBe('withdrawn');
    expect(withdrawn?.products.find((card) => card.canonicalProductId === productId)?.offers).toBeUndefined();

    // #72 product-browse rule 4: a product with NO offer still appears when it
    // has meaningful canonical data — its absence of a summary is the answer.
    const included = await readBrandProducts(
      { handle: brandId, filters: {}, offerContext: 'included' },
      db,
    );
    expect(included?.offerContext).toBe('included');
    const card = included?.products.find((entry) => entry.canonicalProductId === productId);
    expect(card).toBeDefined();
    expect(card?.offers).toBeUndefined();
  });
});

// ── Family ordering and the price range ────────────────────────────────────

describe('#72 family rules 4 and 6 — ordering and the named price range', () => {
  it('orders by release only when EVERY generation states one, and names the range currency', async () => {
    const brandId = await mintBrand('generations');
    const family = await createProductFamily({ name: `Pages Gen ${RUN}`, brandId });
    createdFamilyIds.push(family.id);

    // Two generations WITH release dates, and one without. A mixed family must
    // not be ordered by release — wherever the undated one landed would read as
    // a claim about when it came out.
    const oldId = await mintProduct({
      label: 'gen-1',
      brandId,
      familyId: family.id,
      releasedAt: new Date('2022-01-01T00:00:00.000Z'),
    });
    const newId = await mintProduct({
      label: 'gen-2',
      brandId,
      familyId: family.id,
      releasedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const undatedId = await mintProduct({ label: 'gen-x', brandId, familyId: family.id });

    const mixed = await readProductFamilyProducts(
      { handle: family.id, filters: {}, offerContext: 'included' },
      db,
    );
    expect(mixed?.ordering).toBe('catalog_name');

    // Remove the undated one from the family; now every member states a release
    // date and the ordering may be chronological.
    await db
      .update(canonicalProducts)
      .set({ familyId: null })
      .where(inArray(canonicalProducts.id, [undatedId]));

    const dated = await readProductFamilyProducts(
      { handle: family.id, filters: {}, offerContext: 'included' },
      db,
    );
    expect(dated?.ordering).toBe('release_desc');
    expect(dated?.products.map((card) => card.canonicalProductId)).toEqual([newId, oldId]);

    // The price range names its currency, and is ABSENT when nothing is priced.
    const page = await readProductFamilyPage(
      { handle: family.id, currency: 'EUR', offerContext: 'included' },
      db,
    );
    expect(page?.priceRange).toBeUndefined();
    expect(page?.publishable).toBe(true);

    const sourceId = await mintSource('family-offers', { mayDisplay: true });
    const merchantId = await mintMerchant('family-seller');
    await mintOffer({
      sourceId,
      merchantId,
      variantId: await mintVariant(newId),
      externalOfferId: 'fam-1',
      amount: 120_000,
    });
    await mintOffer({
      sourceId,
      merchantId,
      variantId: await mintVariant(oldId),
      externalOfferId: 'fam-2',
      amount: 80_000,
    });

    const priced = await readProductFamilyPage(
      { handle: family.id, currency: 'EUR', offerContext: 'included' },
      db,
    );
    expect(priced?.priceRange?.currency).toBe('EUR');
    expect(priced?.priceRange?.lowest).toEqual({ amount: 80_000, currency: 'EUR' });
    expect(priced?.priceRange?.highest).toEqual({ amount: 120_000, currency: 'EUR' });
    expect(priced?.priceRange?.productCount).toBe(2);
  });
});

// ── Keyset paging ──────────────────────────────────────────────────────────

describe('#72 product-browse rule 6 — the cursor is stable', () => {
  it('walks a brand without repeating or skipping a product', async () => {
    const brandId = await mintBrand('paging');
    const ids = new Set<string>();
    for (const index of ['a', 'b', 'c', 'd', 'e']) {
      ids.add(await mintProduct({ label: `page-${index}`, brandId }));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await readBrandProducts(
        {
          handle: brandId,
          filters: {},
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
          offerContext: 'withdrawn',
        },
        db,
      );
      if (!result) break;
      seen.push(...result.products.map((card) => card.canonicalProductId));
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }

    expect(seen).toHaveLength(ids.size);
    expect(new Set(seen).size).toBe(ids.size);
    for (const id of ids) expect(seen).toContain(id);
  });
});

// ── Corrections ────────────────────────────────────────────────────────────

describe('#72 identity rule 2 — a correction enters the review queue and edits nothing', () => {
  it('raises one review item and converges on a second submission', async () => {
    const brandId = await mintBrand('corrections');
    const before = await db.select().from(brands).where(inArray(brands.id, [brandId]));

    const first = await submitCatalogCorrection(
      { subject: 'brand', handle: brandId, field: 'logo' },
      db,
    );
    expect(first).toBeDefined();
    if (first) createdReviewItemIds.push(first.reviewItemId);
    expect(first?.converged).toBe(false);

    const second = await submitCatalogCorrection(
      { subject: 'brand', handle: brandId, field: 'description' },
      db,
    );
    // The SAME item, because #59's dedupe key is grained per subject — stated
    // in `correction.service.ts` as the limitation it is.
    expect(second?.reviewItemId).toBe(first?.reviewItemId);
    expect(second?.converged).toBe(true);

    const items = await db
      .select()
      .from(catalogReviewItems)
      .where(inArray(catalogReviewItems.id, [first?.reviewItemId ?? '__none__']));
    expect(items[0]?.detector).toBe('public_correction');
    expect(items[0]?.reasonCodes).toEqual(['public_correction_submitted']);
    expect(items[0]?.detectionCount).toBe(2);
    // The queue records the dispute and NOT the disputer.
    expect(items[0]?.assignedToOxyUserId).toBeNull();

    // And nothing about the brand moved. Submitting a correction confers no
    // edit — there is no write path from this domain to the entity at all.
    const after = await db.select().from(brands).where(inArray(brands.id, [brandId]));
    expect(after[0]?.name).toBe(before[0]?.name);
    expect(after[0]?.updatedAt.getTime()).toBe(before[0]?.updatedAt.getTime());
  });

  it('answers undefined for a handle that resolves to nothing', async () => {
    expect(
      await submitCatalogCorrection(
        { subject: 'brand', handle: `no-such-brand-${RUN}`, field: 'name' },
        db,
      ),
    ).toBeUndefined();
  });
});
