/**
 * Automotive fitment authoring and vehicle filtering, from a merchant's draft to
 * a shopper picking a car (#367 Workstream 18).
 *
 * ## What this adds to `verticals-brake-pad.realdb.test.ts`
 *
 * That file proves the MODELLING: one SKU, thirteen vehicle configurations,
 * eleven statements, an exclusion that bites, and nothing about a vehicle able
 * to become a variant axis or a facet. It creates no store, no listing and no
 * offer, because a reference vertical is a catalogue.
 *
 * This file closes the loop the epic actually asks for — "automotive fitment
 * authoring and vehicle filtering" — by publishing the part through the real
 * authoring service and then walking a shopper from `make` to a BUYABLE offer:
 *
 *  1. authoring a fitment REFERENCE records a merchant CLAIM and creates no
 *     `automotive_fitments` row, which is the epic's "keep seller claims separate
 *     from selected canonical facts" as a measurement rather than a principle;
 *  2. the published listing declares ZERO variant axes, so the part that fits
 *     thirteen cars is still one buyable thing at the LISTING grain too;
 *  3. make → model → generation → configuration → `answerFitment` → the
 *     canonical variant → a live offer → this store's listing, in one chain;
 *  4. the compatibility-scoped field is SUPPRESSED as a facet by name, with a
 *     control showing a non-compatibility attribute of the SAME part is not.
 *
 * ## The gap this file records rather than papers over
 *
 * There is no "which parts fit this vehicle" READ at any layer a route or a
 * service can reach. `SearchFilters` has no vehicle, fitment or compatibility
 * member; every `/compatibility` route requires exactly one SUBJECT; and the one
 * repository primitive that could answer it (`listFitmentsForVehicle` with the
 * subject omitted) is called by nothing, with its own docblock giving the reason.
 * So "vehicle filtering" today means `answerFitment` for a part a shopper is
 * already looking at, plus the selector walk — which is what this file drives.
 * A catalogue-wide vehicle filter is unbuilt, and a test asserting one would have
 * had to invent the read it was testing.
 *
 * ## Every claim's control
 *
 * - "One SKU, many vehicles" asserts BOTH counts — one canonical variant AND
 *   thirteen configurations — because with one vehicle in the fixture the claim
 *   passes trivially. `verticals-package-controls.test.ts` carries the mutation
 *   that reduces the fixture to a single vehicle and shows the assertion notices.
 * - The reverse-fitment list is asserted to be NEITHER empty NOR everything.
 * - The facet suppression is paired with an attribute that is NOT suppressed.
 * - The claim/fitment separation counts fitments before AND after publication.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../db/postgres.js';
import { findCategoryByKey } from '../../db/taxonomy/taxonomyRepository.js';
import {
  findVehicleAncestry,
  listVehicleConfigurations,
  listVehicleGenerations,
  listVehicleMakes,
  listVehicleModels,
} from '../../db/compatibility/vehicleCatalogRepository.js';
import { answerFitment, listPublishedVehiclesForPart } from '../../services/compatibility/fitment.service.js';
import { createDraft, patchDraft, validateStoreDraft } from '../../services/catalog-authoring/draft.service.js';
import { publishDraft } from '../../services/catalog-authoring/publish.service.js';
import { composeAuthoringSchema } from '../../services/catalog-authoring/schema.service.js';
import { resolveFacets } from '../../services/facets/facet.service.js';
import { convergeNativeOffersForListing } from '../../services/offers/native-offer.service.js';
import { runCanonicalSearch } from '../../services/search/canonical-search.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../scripts/seed-verticals/apply.js';
import { BRAKE_PAD_PACKAGE } from '../../scripts/seed-verticals/brake-pad.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, countOne, enumValueId, reportPopulation } from './journey.js';

const TOKEN = verticalRunToken('af');

/** What the package declares, read from the package rather than retyped. */
const DECLARED = BRAKE_PAD_PACKAGE.expect;

const db: Database = await connectPostgres();
let seeded: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let storeId: string;
let partVariantId: string;
let listingId = '';

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, BRAKE_PAD_PACKAGE, TOKEN);
  ns = seeded.ns;
  const pads = await findCategoryByKey(nsCategoryKey(ns, 'braking.brake_pads'), db);
  if (!pads) throw new Error('the seeded department did not resolve');
  categoryId = pads.id;

  const variant = seeded.handles.variantIds.get('vp_4410_default');
  if (variant === undefined) throw new Error('the seed minted no VP-4410 configuration');
  partVariantId = variant;

  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Parts warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
}, 300_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 300_000);

/** Every `automotive_fitments` row this namespace's own parts carry. */
async function namespaceFitmentCount(): Promise<number> {
  return countOne(
    db,
    sql`select count(*)::int as total from automotive_fitments f
        join canonical_variants v on v.id = f.subject_variant_id
        join canonical_products p on p.id = v.product_id
        where p.slug like ${`${ns.kebab}-%`}`,
  );
}

describe('one SKU, many vehicles — at the listing grain too', () => {
  it('has ONE canonical variant per part and THIRTEEN vehicle configurations', async () => {
    const variants = await countOne(
      db,
      sql`select count(*)::int as total from canonical_variants v
          join canonical_products p on p.id = v.product_id
          where p.slug like ${`${ns.kebab}-%`}`,
    );
    const configurations = await countOne(
      db,
      sql`select count(*)::int as total from vehicle_configurations c
          join vehicle_generations g on g.id = c.generation_id
          join vehicle_models m on m.id = g.model_id
          join vehicle_makes k on k.id = m.make_id
          where k.key like ${`${ns.snake}_%`}`,
    );
    const fitments = await namespaceFitmentCount();

    // BOTH counts, and both against the package's own declarations. Asserting
    // "one variant" alone passes with one vehicle in the fixture, and asserting
    // "many vehicles" alone passes with one variant per vehicle.
    expect(variants).toBe(DECLARED.variants);
    expect(configurations).toBe(DECLARED.vehicleConfigurations);
    expect(fitments).toBe(DECLARED.fitments);
    expect(configurations).toBeGreaterThan(variants);

    reportPopulation('the brake-pad catalogue', {
      canonicalVariants: variants,
      vehicleConfigurations: configurations,
      fitmentStatements: fitments,
    });
  });
});

describe('authoring the part, and what the fitment answer becomes', () => {
  it('records a merchant CLAIM and creates no fitment', async () => {
    const fitmentsBefore = await namespaceFitmentCount();

    const composed = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(ns, 'brake_pad'),
      categoryId,
      flow: 'merchant',
      requestedLocale: 'en',
      market: 'DE',
      permissions: E2E_PERMISSIONS,
    });
    expect(composed.outcome).toBe('composed');
    if (composed.outcome !== 'composed') return;
    // The fitment field is offered at `compatibility` scope, and no field of this
    // product type is variant-capable — which is why the listing below declares
    // no axis.
    const fitmentField = composed.schema.fields.find(
      (field) => field.key === nsKey(ns, 'fitment_reference'),
    );
    expect(fitmentField?.scope).toBe('compatibility');
    expect(composed.schema.fields.filter((field) => field.variantCapable)).toHaveLength(0);

    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: seeded.actorOxyUserId,
      categoryId,
      productTypeKey: nsKey(ns, 'brake_pad'),
      flow: 'merchant',
      locale: 'en',
      market: 'DE',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      title: 'Voltek VP-4410 front brake pad set',
    });
    await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: E2E_PERMISSIONS,
      description: 'Front axle pad set, listed against the seeded catalogue part.',
      selectedCanonicalProductId: seeded.handles.productIds.get('vp_4410') ?? null,
      fields: [
        {
          attributeKey: nsKey(ns, 'brake_pad_material'),
          values: [{ enumValueId: await enumValueId(db, ns, 'brake_pad_material', 'ceramic') }],
        },
        {
          attributeKey: nsKey(ns, 'axle_position'),
          values: [{ enumValueId: await enumValueId(db, ns, 'axle_position', 'front') }],
        },
        // `required` in the merchant flow, so the draft is unpublishable without
        // it. Left in rather than routed around: the requirement is the product
        // type doing its job.
        { attributeKey: nsKey(ns, 'pack_count'), values: [{ number: 4 }] },
        // The compatibility-scoped answer. A merchant typing a manufacturer's
        // application reference is making a CLAIM.
        {
          attributeKey: nsKey(ns, 'fitment_reference'),
          values: [{ text: 'VOLTEK-APP-2026-04' }],
        },
      ],
      variants: [
        {
          sku: `${TOKEN}-VP-4410`,
          inventoryAvailable: 6,
          price: { amount: 5900, currency: 'EUR' },
          selectedCanonicalVariantId: partVariantId,
          // A part with no axes at all. `axes: []` is a first-class answer here,
          // not an omission — it is what "one SKU" means.
          axes: [],
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
      `the draft is not publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    if (publication.outcome === 'refused') {
      throw new Error(`publication refused: ${JSON.stringify(publication.validation.findings)}`);
    }
    listingId = publication.listingId;

    // The claim exists, resolved, with the merchant named as its source.
    const claims = await db.execute<{
      raw_name: string;
      raw_value: string;
      provenance: string;
      attribute_resolution: string;
    }>(sql`
      select raw_name, raw_value, provenance, attribute_resolution
      from native_listing_attribute_claims
      where listing_id = ${listingId} and kind = 'attribute_value'
    `);
    const fitmentClaim = [...claims].find((row) => row.raw_name === nsKey(ns, 'fitment_reference'));
    expect(fitmentClaim, 'the fitment answer left no claim').toBeDefined();
    expect(fitmentClaim?.raw_value).toBe('VOLTEK-APP-2026-04');
    expect(fitmentClaim?.provenance).toBe('merchant_declared');
    expect(fitmentClaim?.attribute_resolution).toBe('resolved');

    // And it created NO applicability statement. A claim is what a seller says;
    // a fitment is what Mercaria has accepted, and only the second decides
    // whether a car reaches this part.
    expect(await namespaceFitmentCount()).toBe(fitmentsBefore);

    // Zero declared axes at the listing grain, and one variant.
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from native_listing_variant_axes where listing_id = ${listingId}`,
      ),
    ).toBe(0);
    expect(
      await countOne(
        db,
        sql`select count(*)::int as total from product_variants where listing_id = ${listingId}`,
      ),
    ).toBe(1);

    const converged = await convergeNativeOffersForListing(listingId);
    expect(converged.materialized).toBe(1);

    // The axis count is deliberately absent from this report: it is ZERO by
    // design, and `reportPopulation` refuses a zero because a zero population is
    // the vacuity it exists to catch. It is asserted above instead, where the
    // zero is the claim rather than a size.
    reportPopulation('the published part', {
      listingVariants: 1,
      merchantClaims: [...claims].length,
      offersConverged: converged.materialized,
      fitmentsUnchanged: fitmentsBefore,
    });
  });
});

describe('the vehicle walk reaches a BUYABLE part', () => {
  it('goes make → model → generation → configuration → verdict → offer → listing', async () => {
    expect(listingId, 'the authoring case did not run').not.toBe('');

    // The walk, one rung at a time, through the reads the selector calls.
    const makes = (await listVehicleMakes(db)).filter((make) =>
      make.key.startsWith(`${ns.snake}_`),
    );
    expect(makes.length).toBeGreaterThanOrEqual(3);
    const bmw = makes.find((make) => make.key === nsKey(ns, 'bmw'));
    expect(bmw, 'the seeded make did not resolve').toBeDefined();
    if (!bmw) return;

    const models = await listVehicleModels(bmw.id, db);
    expect(models.length).toBeGreaterThanOrEqual(2);
    const threeSeries = models.find((model) => model.name === '3 Series');
    expect(threeSeries).toBeDefined();
    if (!threeSeries) return;

    const generations = await listVehicleGenerations(threeSeries.id, db);
    expect(generations.length).toBeGreaterThanOrEqual(2);
    const g20 = generations.find((generation) => generation.name === 'G20');
    expect(g20).toBeDefined();
    if (!g20) return;

    const configurations = await listVehicleConfigurations(g20.id, null, db);
    expect(configurations.length).toBeGreaterThanOrEqual(3);
    const petrol = configurations.find((configuration) => configuration.name === '320i');
    expect(petrol).toBeDefined();
    if (!petrol) return;

    // The ancestry read is what a breadcrumb uses, and it agrees with the walk.
    const ancestry = await findVehicleAncestry(petrol.id, db);
    expect(ancestry?.make.id).toBe(bmw.id);
    expect(ancestry?.model.id).toBe(threeSeries.id);
    expect(ancestry?.generation.id).toBe(g20.id);

    const verdict = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: partVariantId },
      vehicle: { configurationId: petrol.id },
    });
    expect(verdict.verdict.outcome).toBe('determined');
    if (verdict.verdict.outcome !== 'determined') return;
    expect(verdict.verdict.applicability).toBe('applies');
    // Decided at the GENERATION, which is the scope the seeded statement carries.
    expect(verdict.verdict.decidedAtScope).toBe('vehicle_generation');
    expect(verdict.statements.length).toBeGreaterThan(0);

    // …and the part the verdict names is on sale, from this store's listing.
    const offers = await db.execute<{ offer_id: string; listing_id: string; status: string }>(sql`
      select o.id as offer_id, o.listing_id, o.status
      from offers o
      where o.canonical_variant_id = ${partVariantId} and o.status = 'active' and o.kind = 'native'
    `);
    const ours = [...offers].filter((row) => row.listing_id === listingId);
    expect(ours).toHaveLength(1);

    reportPopulation('the vehicle walk', {
      makes: makes.length,
      models: models.length,
      generations: generations.length,
      configurations: configurations.length,
      statementsBehindTheVerdict: verdict.statements.length,
      liveOffersOnThePart: ours.length,
    });
  });

  it('lists what the part fits, and it is neither empty nor everything', async () => {
    const published = await listPublishedVehiclesForPart(
      { kind: 'canonical_variant', variantId: partVariantId },
      100,
    );
    // Non-empty first, then bounded. Either half alone is satisfiable by a bug:
    // an empty list satisfies "not everything", and a list of every vehicle in
    // the database satisfies "not empty".
    expect(published.fitments.length).toBeGreaterThan(0);
    expect(published.fitments.length).toBeLessThan(DECLARED.vehicleConfigurations);
    expect(published.truncated).toBe(false);
  });

  it('refuses the excluded car while its EU sibling still fits', async () => {
    const excluded = seeded.handles.vehicleConfigurationIds.get('f30_320d_us');
    const sibling = seeded.handles.vehicleConfigurationIds.get('f30_320d_eu');
    expect(excluded).toBeDefined();
    expect(sibling).toBeDefined();
    if (excluded === undefined || sibling === undefined) return;

    const refused = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: partVariantId },
      vehicle: { configurationId: excluded },
    });
    expect(refused.verdict.outcome).toBe('determined');
    if (refused.verdict.outcome !== 'determined') return;
    expect(refused.verdict.applicability).toBe('does_not_apply');
    // The narrower scope decided, which is what makes an exclusion able to
    // override a generation-wide `applies`.
    expect(refused.verdict.decidedAtScope).toBe('vehicle_configuration');

    // The control: the same generation's EU car is unaffected. Without it, a
    // verdict function that refused everything would satisfy the case above.
    const permitted = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: partVariantId },
      vehicle: { configurationId: sibling },
    });
    expect(permitted.verdict.outcome).toBe('determined');
    if (permitted.verdict.outcome !== 'determined') return;
    expect(permitted.verdict.applicability).toBe('applies');
  });
});

describe('a vehicle is not a catalogue filter, and the part still is filterable', () => {
  it('SUPPRESSES the compatibility-scoped field and keeps a real attribute', async () => {
    const outcome = await resolveFacets(
      {
        scope: { kind: 'category', categoryId, includeDescendants: true },
        selection: [],
        locale: 'en',
        displayCurrency: 'EUR',
      },
      db,
    );

    const suppressed = outcome.response.suppressed.find(
      (entry) => entry.facetKey === nsKey(ns, 'fitment_reference'),
    );
    expect(suppressed, 'the fitment field was not suppressed at all').toBeDefined();
    // BY NAME. A count of suppressions would be satisfied by any suppression, and
    // "not filterable" and "compatibility scope" are different decisions with
    // different remedies.
    expect(suppressed?.reason).toBe('compatibility_scope');
    expect(
      outcome.response.facets.some((facet) => facet.key === nsKey(ns, 'fitment_reference')),
    ).toBe(false);

    // The control: an attribute of the part that is NOT compatibility-scoped is
    // a live facet with buckets. Without this the case above would pass against
    // a facet planner that had stopped producing anything for this category.
    const material = outcome.response.facets.find(
      (facet) => facet.key === nsKey(ns, 'brake_pad_material'),
    );
    expect(material, 'no non-compatibility attribute became a facet').toBeDefined();
    if (material === undefined) return;
    expect(material.values.shape).toBe('buckets');
    if (material.values.shape !== 'buckets') return;
    expect(material.values.buckets.length).toBeGreaterThanOrEqual(2);

    const narrowed = await resolveFacets(
      {
        scope: { kind: 'category', categoryId, includeDescendants: true },
        selection: [
          { origin: 'attribute', facetKey: nsKey(ns, 'brake_pad_material'), values: ['ceramic'] },
        ],
        locale: 'en',
        displayCurrency: 'EUR',
      },
      db,
    );
    // A real narrowing, counted against the unfiltered figure taken first.
    expect(outcome.response.matchedProductCount).toBe(DECLARED.products);
    expect(narrowed.response.matchedProductCount).toBeGreaterThan(0);
    expect(narrowed.response.matchedProductCount).toBeLessThan(
      outcome.response.matchedProductCount,
    );

    reportPopulation('the part’s own facets', {
      liveFacets: outcome.response.facets.length,
      suppressed: outcome.response.suppressed.length,
      materialBuckets: material.values.buckets.length,
      unfilteredProducts: outcome.response.matchedProductCount,
      ceramicProducts: narrowed.response.matchedProductCount,
    });
  });

  it('is findable by NAME, which is the only catalogue-wide read that reaches it', async () => {
    const productId = seeded.handles.productIds.get('vp_4410');
    expect(productId).toBeDefined();
    if (productId === undefined) return;

    const found = await runCanonicalSearch(
      { term: 'Voltek VP-4410', kinds: ['product'], filters: {}, limit: 50 },
      db,
    );
    const mine = found.response.results.find(
      (entry) => entry.kind === 'product' && entry.canonicalProductId === productId,
    );
    expect(mine, 'the part was not reachable by its own name').toBeDefined();

    /**
     * The control, and its first spelling was itself nearly vacuous.
     *
     * `zzzz-no-such-brake-pad-zzzz` REACHED the part — correctly, through the
     * fuzzy trigram stage, because it shares `brake` and `pad` with the
     * catalogue. A nonsense term has to share no trigram with anything, or the
     * control passes only for products whose names happen to avoid the words the
     * tester reached for. Measured, not assumed.
     */
    const absent = await runCanonicalSearch(
      { term: 'qxzj wvnk plfh', kinds: ['product'], filters: {}, limit: 50 },
      db,
    );
    expect(
      absent.response.results.some(
        (entry) => entry.kind === 'product' && entry.canonicalProductId === productId,
      ),
    ).toBe(false);
  });
});
