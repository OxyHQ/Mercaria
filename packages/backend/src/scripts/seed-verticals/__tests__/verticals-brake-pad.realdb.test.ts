/**
 * The AUTOMOTIVE BRAKE-PAD reference vertical, end to end against a REAL
 * PostgreSQL server (#367 Workstream 14).
 *
 * ## The one thing it exists to prove
 *
 * **One SKU fits many vehicles without becoming many variants.** Everything
 * else here supports that sentence: the vehicle selector that finds the part,
 * the reverse list that answers "what does this fit", the exclusion that
 * removes one car from a generation-wide fit, the overlapping generations that
 * make a model year useless on its own, and the ambiguous supplier claims that
 * are kept rather than guessed at.
 *
 * ## The counts, and why BOTH of them are asserted
 *
 * "One SKU fits many vehicles" passes trivially against a fixture holding one
 * vehicle. So every case here asserts the VARIANT count and the VEHICLE count
 * together, and `verticals-package-controls.test.ts` carries the mutation that
 * reduces the fixture to a single vehicle and shows the vehicle count notices.
 *
 * The numbers: **2 canonical variants** (one per product, minted by
 * `createCanonicalProduct` for an axis-less product), **13 vehicle
 * configurations**, **11 fitment statements**. Of the thirteen configurations,
 * ten answer `applies` for VP-4410, one `partially_applies`, one
 * `does_not_apply` and one `unknown` — all four verdicts exercised, which is
 * what makes "the resolver decides at the narrowest scope" a measurement rather
 * than a description.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import {
  findVehicleAncestry,
  listVehicleConfigurations,
  listVehicleGenerations,
  listVehicleMakes,
  listVehicleModels,
} from '../../../db/compatibility/vehicleCatalogRepository.js';
import { listFitmentsForVehicle } from '../../../db/compatibility/automotiveFitmentRepository.js';
import { answerFitment, listVehiclesForPart } from '../../../services/compatibility/fitment.service.js';
import { listUnresolvedClaims } from '../../../db/compatibility/compatibilityClaimRepository.js';
import { resolveFacets } from '../../../services/facets/facet.service.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { BRAKE_PAD_PACKAGE } from '../brake-pad.js';
import { nsCategoryKey, nsKey, nsSlug, type VerticalNamespace } from '../apply.js';
import {
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from './vertical-fixture.js';

const TOKEN = verticalRunToken('bp');

const db: Database = await connectPostgres();
let seeded: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
/** The one canonical variant of VP-4410 — the SKU the whole file is about. */
let padVariantId: string;
/** The one canonical variant of VP-4411, which fits a strict subset. */
let sportVariantId: string;

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, BRAKE_PAD_PACKAGE, TOKEN);
  ns = seeded.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'braking.brake_pads'), db);
  if (!category) throw new Error('the brake-pad category did not resolve');
  categoryId = category.id;
  const pad = seeded.handles.variantIds.get('vp_4410_default');
  const sport = seeded.handles.variantIds.get('vp_4411_default');
  if (pad === undefined || sport === undefined) throw new Error('the pad variants did not resolve');
  padVariantId = pad;
  sportVariantId = sport;
}, 180_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 180_000);

/** Every vehicle key this package seeded, with its ids, keyed on the package's own key. */
async function vehicleIds(): Promise<{
  makes: Map<string, string>;
  models: Map<string, string>;
  generations: Map<string, string>;
  configurations: Map<string, string>;
}> {
  return {
    makes: seeded.handles.vehicleMakeIds as Map<string, string>,
    models: seeded.handles.vehicleModelIds as Map<string, string>,
    generations: seeded.handles.vehicleGenerationIds as Map<string, string>,
    configurations: seeded.handles.vehicleConfigurationIds as Map<string, string>,
  };
}

describe('one SKU, many vehicles', () => {
  it('has ONE canonical variant and no variant axis at all', async () => {
    const rows = await db.execute<{
      slug: string;
      variants: number;
      axes: number;
      declared: string[];
    }>(sql`
      select p.slug,
             count(distinct v.id)::int as variants,
             count(distinct a.attribute_key)::int as axes,
             p.variant_defining_attribute_keys as declared
      from canonical_products p
      join canonical_variants v on v.product_id = p.id
      left join canonical_variant_attributes a on a.variant_id = v.id
      where p.slug like ${`${ns.kebab}-%`}
      group by p.slug, p.variant_defining_attribute_keys
      order by p.slug
    `);
    const all = [...rows];
    // Vacuity floor: both products, or "every product has one variant" is a
    // statement about an empty set.
    expect(all).toHaveLength(2);
    for (const row of all) {
      expect(row.variants, `${row.slug} has more than one variant`).toBe(1);
      expect(row.axes, `${row.slug} carries a variant axis`).toBe(0);
      expect(row.declared, `${row.slug} declares a variant axis`).toEqual([]);
    }
  });

  it('answers for THIRTEEN vehicle configurations from ELEVEN statements', async () => {
    const rows = await db.execute<{ configurations: number; fitments: number }>(sql`
      select
        (select count(*)::int from vehicle_configurations c
           join vehicle_generations g on g.id = c.generation_id
           join vehicle_models m on m.id = g.model_id
           join vehicle_makes k on k.id = m.make_id
          where k.key like ${`${ns.snake}_%`}) as configurations,
        (select count(*)::int from automotive_fitments f
           join canonical_variants v on v.id = f.subject_variant_id
           join canonical_products p on p.id = v.product_id
          where p.slug like ${`${ns.kebab}-%`} and f.valid_to is null) as fitments
    `);
    const row = [...rows][0];
    expect(row?.configurations).toBe(13);
    expect(row?.fitments).toBe(11);
    // The headline as a ratio, with BOTH numbers already asserted above so the
    // ratio is not computed from something unmeasured.
    expect((row?.configurations ?? 0) / 2).toBeGreaterThan(5);
  });

  it('resolves a verdict for EVERY configuration, and exercises all four', async () => {
    const ids = await vehicleIds();
    const verdicts = new Map<string, string>();
    for (const [key, configurationId] of ids.configurations) {
      const ancestry = await findVehicleAncestry(configurationId, db);
      expect(ancestry, `${key} has no ancestry`).not.toBeNull();
      if (!ancestry) continue;
      const answer = await answerFitment({
        subject: { kind: 'canonical_variant', variantId: padVariantId },
        vehicle: {
          makeId: ancestry.make.id,
          modelId: ancestry.model.id,
          generationId: ancestry.generation.id,
          configurationId: ancestry.configuration.id,
        },
      });
      verdicts.set(
        key,
        answer.verdict.outcome === 'determined' ? answer.verdict.applicability : 'unknown',
      );
    }

    expect(verdicts.size).toBe(13);
    const tally = [...verdicts.values()].reduce<Record<string, number>>((counts, verdict) => {
      counts[verdict] = (counts[verdict] ?? 0) + 1;
      return counts;
    }, {});
    // All four, so the resolver is measured rather than described. A fixture
    // that only ever produced `applies` would prove the join and nothing about
    // the precedence rule.
    expect(tally).toEqual({
      applies: 10,
      partially_applies: 1,
      does_not_apply: 1,
      unknown: 1,
    });
    expect(verdicts.get('f30_320d_us')).toBe('does_not_apply');
    expect(verdicts.get('golf_mk7_gti')).toBe('partially_applies');
    expect(verdicts.get('g22_430i_us')).toBe('unknown');
  });
});

describe('a second apply is a genuine no-op', () => {
  it('creates NOTHING and leaves the census matching', async () => {
    // This case exists because the property it asserts was broken and nothing
    // caught it: `recordCompatibilityClaim` APPENDS — correctly, since a claim
    // is an observation and `compatibility_claims` carries no unique key over
    // its raw text — so convergence is the SEED's job, and the second apply
    // wrote two more claims until it did it. It was found by running the CLI
    // twice by hand, which is exactly the discovery a test should have made.
    const { applyVerticalPackage } = await import('../apply.js');
    const { censusVerticalPackage } = await import('../census.js');

    const { report } = await applyVerticalPackage(
      BRAKE_PAD_PACKAGE,
      { apply: true, namespace: TOKEN, actorOxyUserId: seeded.actorOxyUserId },
      db,
    );
    // Vacuity floor: the run examined the whole package, so `created === 0` is
    // a no-op rather than a run that did nothing at all.
    expect(report.steps.length).toBeGreaterThan(60);
    expect(
      report.created,
      `a re-apply created: ${report.steps
        .filter((step) => step.outcome === 'create')
        .map((step) => `${step.entity} ${step.identity}`)
        .join(', ')}`,
    ).toBe(0);
    expect(report.divergent).toBe(0);

    const verdict = await censusVerticalPackage(db, BRAKE_PAD_PACKAGE, ns);
    expect(verdict.outcome).toBe('matched');
  });
});

describe('the vehicle selector', () => {
  it('walks make → model → generation → configuration and reaches the part', async () => {
    const makes = (await listVehicleMakes(db)).filter((make) =>
      make.key.startsWith(`${ns.snake}_`),
    );
    expect(makes.map((make) => make.name).sort()).toEqual(['BMW', 'SEAT', 'Volkswagen']);

    const bmw = makes.find((make) => make.name === 'BMW');
    expect(bmw).toBeDefined();
    if (!bmw) return;

    const models = await listVehicleModels(bmw.id, db);
    expect(models.map((model) => model.name).sort()).toEqual(['3 Series', '4 Series']);

    const threeSeries = models.find((model) => model.name === '3 Series');
    if (!threeSeries) return;
    const generations = await listVehicleGenerations(threeSeries.id, db);
    expect(generations.map((generation) => generation.name).sort()).toEqual(['F30', 'G20']);

    const g20 = generations.find((generation) => generation.name === 'G20');
    if (!g20) return;
    const configurations = await listVehicleConfigurations(g20.id, null, db);
    expect(configurations).toHaveLength(3);

    // The fifth level: this vehicle's parts.
    const configuration = configurations[0];
    if (!configuration) return;
    const fitments = await listFitmentsForVehicle(
      {
        makeId: bmw.id,
        modelId: threeSeries.id,
        generationId: g20.id,
        configurationId: configuration.id,
      },
      {},
      db,
    );
    const subjects = new Set(fitments.map((fitment) => fitment.subjectVariantId));
    // BOTH parts fit a G20 — which is what makes the reverse case below a
    // narrowing rather than a list of everything.
    expect(subjects).toContain(padVariantId);
    expect(subjects).toContain(sportVariantId);
  });

  it('narrows by YEAR, which is a configuration property and never an option', async () => {
    const ids = await vehicleIds();
    const mk7 = ids.generations.get('golf_mk7');
    const mk8 = ids.generations.get('golf_mk8');
    expect(mk7).toBeDefined();
    expect(mk8).toBeDefined();
    if (mk7 === undefined || mk8 === undefined) return;

    // 2019 is inside BOTH generations' windows, which is the overlapping case:
    // a model year alone cannot select a generation.
    const mk7In2019 = await listVehicleConfigurations(mk7, 2019, db);
    const mk8In2019 = await listVehicleConfigurations(mk8, 2019, db);
    expect(mk7In2019.length).toBeGreaterThan(0);
    expect(mk8In2019.length).toBeGreaterThan(0);

    // And a year outside one of them narrows it away — the control that shows
    // the year filter does something.
    const mk8In2013 = await listVehicleConfigurations(mk8, 2013, db);
    expect(mk8In2013).toHaveLength(0);
    const mk7In2013 = await listVehicleConfigurations(mk7, 2013, db);
    expect(mk7In2013.length).toBeGreaterThan(0);
  });

  it('keeps two generations of one model overlapping in production years', async () => {
    const rows = await db.execute<{ name: string; from_year: number; to_year: number }>(sql`
      select g.name, g.produced_from_year as from_year, g.produced_to_year as to_year
      from vehicle_generations g
      join vehicle_models m on m.id = g.model_id
      join vehicle_makes k on k.id = m.make_id
      where k.key like ${`${ns.snake}_%`} and m.name = 'Golf'
      order by g.produced_from_year
    `);
    const [earlier, later] = [...rows];
    expect(earlier).toBeDefined();
    expect(later).toBeDefined();
    if (!earlier || !later) return;
    expect(later.from_year).toBeLessThanOrEqual(earlier.to_year);
  });
});

describe('reverse fitment', () => {
  it('lists what the part fits, and it is NOT everything', async () => {
    const pad = await listVehiclesForPart({ kind: 'canonical_variant', variantId: padVariantId });
    const sport = await listVehiclesForPart({
      kind: 'canonical_variant',
      variantId: sportVariantId,
    });
    expect(pad).toHaveLength(9);
    expect(sport).toHaveLength(2);

    // The discriminator: the second part is a STRICT SUBSET, so "this part's
    // vehicles" is a different set from "every vehicle" — which a fixture with
    // one part could not show.
    const padGenerations = new Set(pad.map((row) => row.vehicleGenerationId).filter(Boolean));
    const sportGenerations = new Set(sport.map((row) => row.vehicleGenerationId).filter(Boolean));
    expect(sportGenerations.size).toBeGreaterThan(0);
    for (const generation of sportGenerations) expect(padGenerations).toContain(generation);
    expect(padGenerations.size).toBeGreaterThan(sportGenerations.size);
  });

  it('reports the exclusion beside the fit it overrides, rather than hiding it', async () => {
    const pad = await listVehiclesForPart({ kind: 'canonical_variant', variantId: padVariantId });
    const negative = pad.filter((row) => row.applicability === 'does_not_apply');
    expect(negative).toHaveLength(1);
    expect(negative[0]?.scope).toBe('vehicle_configuration');
    // A `partially_applies` row carries what makes it partial —
    // `automotive_fitments_partial_condition_check` refuses one with nothing to
    // explain it, so an unexplained "sort of" has no row shape.
    const partial = pad.filter((row) => row.applicability === 'partially_applies');
    expect(partial).toHaveLength(1);
    expect(
      (partial[0]?.qualifiers ?? []).length > 0 || partial[0]?.conditionNote !== null,
    ).toBe(true);
  });
});

describe('the exclusion, and the asymmetry that makes it bite immediately', () => {
  it('lets a CANDIDATE negative publish while a candidate positive would not', async () => {
    const ids = await vehicleIds();
    const rows = await db.execute<{ verification: string; applicability: string }>(sql`
      select f.verification, f.applicability
      from automotive_fitments f
      where f.subject_variant_id = ${padVariantId}
        and f.vehicle_configuration_id = ${ids.configurations.get('f30_320d_us')}
    `);
    const exclusion = [...rows][0];
    expect(exclusion).toBeDefined();
    // Stored as a CANDIDATE, and it still decides — `NEGATIVE_VERIFICATIONS`
    // admits `candidate` where `POSITIVE_VERIFICATIONS` does not.
    expect(exclusion?.verification).toBe('candidate');
    expect(exclusion?.applicability).toBe('does_not_apply');

    const ancestry = await findVehicleAncestry(
      ids.configurations.get('f30_320d_us') ?? '',
      db,
    );
    expect(ancestry).not.toBeNull();
    if (!ancestry) return;
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: padVariantId },
      vehicle: {
        makeId: ancestry.make.id,
        modelId: ancestry.model.id,
        generationId: ancestry.generation.id,
        configurationId: ancestry.configuration.id,
      },
    });
    expect(answer.verdict.outcome).toBe('determined');
    if (answer.verdict.outcome !== 'determined') return;
    expect(answer.verdict.applicability).toBe('does_not_apply');
    // It was decided at the NARROWER scope, over a generation-wide `applies`
    // that is genuinely present in the same answer.
    expect(answer.verdict.decidedAtScope).toBe('vehicle_configuration');
    expect(answer.statements).toHaveLength(2);
    expect(answer.statements.map((statement) => statement.applicability).sort()).toEqual([
      'applies',
      'does_not_apply',
    ]);
  });

  it('leaves the EU sibling of the excluded car fitting', async () => {
    // The control: the exclusion is about ONE configuration, not about the
    // generation. Without this, an exclusion that accidentally removed the
    // whole generation would satisfy the case above.
    const ids = await vehicleIds();
    const ancestry = await findVehicleAncestry(ids.configurations.get('f30_320d_eu') ?? '', db);
    expect(ancestry).not.toBeNull();
    if (!ancestry) return;
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: padVariantId },
      vehicle: {
        makeId: ancestry.make.id,
        modelId: ancestry.model.id,
        generationId: ancestry.generation.id,
        configurationId: ancestry.configuration.id,
      },
    });
    expect(answer.verdict.outcome).toBe('determined');
    if (answer.verdict.outcome !== 'determined') return;
    expect(answer.verdict.applicability).toBe('applies');
    expect(answer.verdict.decidedAtScope).toBe('vehicle_generation');
  });

  it('distinguishes the two MARKETS by a column, not by a name', async () => {
    const rows = await db.execute<{ key: string; market: string; engine_code: string }>(sql`
      select c.key, c.market, c.engine_code
      from vehicle_configurations c
      join vehicle_generations g on g.id = c.generation_id
      where g.key = ${nsKey(ns, 'f30')} and c.name like '320d%'
      order by c.market
    `);
    const all = [...rows];
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.market)).toEqual(['DE', 'US']);
    // Two configurations of one nameplate, told apart by market AND engine
    // code — the fact a `320d` string alone cannot carry.
    expect(new Set(all.map((row) => row.engine_code)).size).toBe(2);
  });
});

describe('ambiguous supplier claims are kept, never guessed', () => {
  it('records both claims unresolved, with a reason and the raw words', async () => {
    const claims = (await listUnresolvedClaims(seeded.handles.sourceId, 50, db)).filter(
      (claim) => claim.subjectVariantId === padVariantId,
    );
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(claim.state).toBe('unresolved');
      expect(claim.unresolvedReason).toBe('ambiguous_target');
      // The source's own words, verbatim and frozen by
      // `mercaria_compatibility_claims_raw_freeze`.
      expect(claim.rawTargetText).toMatch(/^fits /u);
      // And they resolved to NOTHING — a claim that had quietly been attached
      // to one of the two candidates would carry an id here.
      expect(claim.relationId).toBeNull();
      expect(claim.fitmentId).toBeNull();
    }
    expect(claims.map((claim) => claim.rawTargetText).sort()).toEqual([
      'fits BMW 320d',
      'fits Golf 2019',
    ]);
  });

  it('is ambiguous against THIS fixture, which is why it was not resolved', async () => {
    // The control. "Ambiguous" is a claim about the catalogue, so the catalogue
    // must actually hold more than one candidate — otherwise the reason is a
    // label somebody typed.
    const threeTwentyD = await db.execute<{ total: number }>(sql`
      select count(*)::int as total
      from vehicle_configurations c
      join vehicle_generations g on g.id = c.generation_id
      join vehicle_models m on m.id = g.model_id
      join vehicle_makes k on k.id = m.make_id
      where k.key like ${`${ns.snake}_%`} and c.name like '320d%'
    `);
    expect([...threeTwentyD][0]?.total).toBeGreaterThan(1);

    const golf2019 = await db.execute<{ total: number }>(sql`
      select count(distinct g.id)::int as total
      from vehicle_generations g
      join vehicle_models m on m.id = g.model_id
      join vehicle_makes k on k.id = m.make_id
      where k.key like ${`${ns.snake}_%`} and m.name = 'Golf'
        and g.produced_from_year <= 2019 and g.produced_to_year >= 2019
    `);
    expect([...golf2019][0]?.total).toBeGreaterThan(1);
  });

  it('refuses to rewrite a claim’s raw words', async () => {
    // Append-only in the direction that matters: the evidence survives whatever
    // a reviewer later decides, so a wrong resolution is correctable and the
    // words it was made from are still there.
    let raised: unknown;
    try {
      await db.execute(sql`
        update compatibility_claims set raw_target_text = 'fits everything'
        where subject_variant_id = ${padVariantId}
      `);
    } catch (error) {
      raised = error;
    }
    expect(raised, 'a claim let its raw words be rewritten').toBeDefined();
  });
});

describe('nothing about a vehicle can become a variant axis or a facet', () => {
  it('declares the fitment field at `compatibility` scope, which cannot be an axis', async () => {
    const rows = await db.execute<{ attribute_key: string; scope: string; variant_capable: boolean }>(
      sql`
        select f.attribute_key, f.scope, f.variant_capable
        from product_type_fields f
        join product_type_definitions t on t.id = f.product_type_definition_id
        where t.key = ${nsKey(ns, 'brake_pad')} and f.scope = 'compatibility'
      `,
    );
    const all = [...rows];
    expect(all).toHaveLength(1);
    expect(all[0]?.attribute_key).toBe(nsKey(ns, 'fitment_reference'));
    expect(all[0]?.variant_capable).toBe(false);
  });

  it('refuses to make that field variant-capable, at the DATABASE', async () => {
    // `product_type_fields_variant_axis_check` requires `scope = 'variant'`,
    // so this holds for a key nowhere in the forbidden list — which is the wall
    // that covers an attribute nobody thought to forbid.
    let raised: unknown;
    try {
      await db.execute(sql`
        update product_type_fields set variant_capable = true
        where scope = 'compatibility'
          and product_type_definition_id = (
            select id from product_type_definitions where key = ${nsKey(ns, 'brake_pad')})
      `);
    } catch (error) {
      raised = error;
    }
    expect(raised, 'a compatibility-scoped field was made variant-capable').toBeDefined();
  });

  it('suppresses the compatibility-scoped field as a facet, naming the reason', async () => {
    const outcome = await resolveFacets(
      {
        scope: { kind: 'category', categoryId, includeDescendants: true },
        selection: [],
        locale: 'en',
        displayCurrency: 'EUR',
      },
      db,
    );
    // Vacuity floor: the surface produced facets, so "this one is missing" is a
    // suppression rather than an empty answer.
    expect(outcome.response.facets.length).toBeGreaterThan(0);
    expect(outcome.response.matchedProductCount).toBe(2);
    expect(outcome.response.facets.map((facet) => facet.key)).not.toContain(
      nsKey(ns, 'fitment_reference'),
    );
    const suppression = outcome.response.suppressed.find(
      (entry) => entry.facetKey === nsKey(ns, 'fitment_reference'),
    );
    expect(suppression?.reason).toBe('compatibility_scope');
  });

  it('still filters the PART’s own properties, which are not vehicle facts', async () => {
    const outcome = await resolveFacets(
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
    // One of the two pads is ceramic and the other semi-metallic, so this is a
    // narrowing from the two the previous case counted.
    expect(outcome.response.matchedProductCount).toBe(1);
  });
});

describe('the part’s own facts', () => {
  it('records dimensions as three named axes in the base unit', async () => {
    const rows = await db.execute<{
      component_axis: string;
      position: number;
      normalized_number: number;
      normalized_unit: string;
      source_display_value: string;
    }>(sql`
      select a.component_axis, a.position, a.normalized_number, a.normalized_unit, a.source_display_value
      from canonical_attribute_values a
      join canonical_variants v on v.id = a.variant_id
      join canonical_products p on p.id = v.product_id
      where a.attribute_key = ${nsKey(ns, 'pad_dimensions')}
        and p.slug = ${nsSlug(ns, 'voltek-vp-4410')}
      order by a.position
    `);
    let all = [...rows];
    if (all.length === 0) {
      // The package records dimensions at PRODUCT grain, not variant grain.
      const productRows = await db.execute<{
        component_axis: string;
        position: number;
        normalized_number: number;
        normalized_unit: string;
        source_display_value: string;
      }>(sql`
        select a.component_axis, a.position, a.normalized_number, a.normalized_unit, a.source_display_value
        from canonical_attribute_values a
        join canonical_products p on p.id = a.product_id
        where a.attribute_key = ${nsKey(ns, 'pad_dimensions')}
          and p.slug = ${nsSlug(ns, 'voltek-vp-4410')}
        order by a.position
      `);
      all = [...productRows];
    }
    // ONE declaration, THREE rows — each naming its own axis, in the declared
    // order, so a comparison cannot put a height beside a depth.
    expect(all).toHaveLength(3);
    expect(all.map((row) => row.component_axis)).toEqual(['height', 'width', 'depth']);
    expect(all.map((row) => row.normalized_unit)).toEqual(['mm', 'mm', 'mm']);
    expect(all.map((row) => Number(row.normalized_number))).toEqual([155.1, 63.5, 17.2]);
    // The trailing unit belonged to the last component and applied to all
    // three, and the source's own text is kept per component.
    expect(all[0]?.source_display_value).toBe('155.1');
    expect(all[2]?.source_display_value).toBe('17.2 mm');
  });

  it('resolves a Spanish source spelling onto the controlled value', async () => {
    const rows = await db.execute<{ source_display_value: string; normalized_text: string }>(sql`
      select a.source_display_value, a.normalized_text
      from canonical_attribute_values a
      join canonical_products p on p.id = a.product_id
      where a.attribute_key = ${nsKey(ns, 'brake_pad_material')}
        and p.slug = ${nsSlug(ns, 'voltek-vp-4410')}
    `);
    const row = [...rows][0];
    expect(row, 'the material fact is missing').toBeDefined();
    // `Cerámica` is an alias of `ceramic`. The source's own accented word is
    // kept, and the normalized value is what a filter matches.
    expect(row?.source_display_value).toBe('Cerámica');
    expect(row?.normalized_text).toBe('ceramic');
  });

  it('carries an MPN and a GTIN on the one variant', async () => {
    const rows = await db.execute<{ scheme: string; normalized_value: string; canonical_value: string | null }>(
      sql`
        select scheme, normalized_value, canonical_value
        from product_identifiers where variant_id = ${padVariantId} order by scheme
      `,
    );
    const all = [...rows];
    expect(all.map((row) => row.scheme).sort()).toEqual(['ean', 'mpn']);
    const ean = all.find((row) => row.scheme === 'ean');
    // A GTIN normalizes into ONE comparison space, zero-padded to fourteen, so
    // a UPC and the EAN that pads to the same number cannot name two variants.
    expect(ean?.canonical_value).toMatch(/^0[0-9]{13}$/u);
    const mpn = all.find((row) => row.scheme === 'mpn');
    // An MPN has no canonical form: it is unique only within a manufacturer.
    expect(mpn?.canonical_value).toBeNull();
  });
});
