/**
 * The FOOTWEAR reference vertical, end to end against a REAL PostgreSQL server
 * (#367 Workstream 14).
 *
 * ## What it drives
 *
 * The seed, then the real read surfaces in the order a shopper meets them:
 * taxonomy → localization → the attribute registry → facets and filters →
 * authoring → publication → the product page. Nothing here re-implements a
 * filter or a resolver: every assertion goes through the function the API calls,
 * because a test that re-implements the code under test measures the
 * re-implementation.
 *
 * ## Every claim has a control, and here is what each one is
 *
 * - The census refuses to hand back a half-applied fixture at all
 *   (`seedVerticalForTest`), so no case below can run against missing rows.
 * - The audience-scope case asserts the men's list CONTAINS the men's size AND
 *   EXCLUDES the women's, and that BOTH lists are non-empty — a scoping bug
 *   that returned nothing would otherwise satisfy the exclusion half.
 * - The brand-chart case asserts the unfiltered count FIRST, so "the filter
 *   matched one product" is a narrowing rather than an empty catalogue.
 * - The sparse-matrix case inserts the missing combination inside a
 *   ROLLED-BACK transaction and re-runs the same query, so the absence
 *   assertion is shown to notice presence.
 *
 * ## The shared database
 *
 * Every identity carries this file's own run token and every assertion and
 * delete is scoped by it. See `vertical-fixture.ts` for what the teardown
 * cannot remove and why.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryBreadcrumb, findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { readLocalizedCategories } from '../../../services/catalog-localization/read.service.js';
import { resolveDefinitionsForCategory } from '../../../services/attributes/definition-registry.service.js';
import { resolveFacets } from '../../../services/facets/facet.service.js';
import { readCanonicalProductPage } from '../../../services/product-page/product-page.service.js';
import { createDraft, patchDraft, validateStoreDraft } from '../../../services/catalog-authoring/draft.service.js';
import { publishDraft } from '../../../services/catalog-authoring/publish.service.js';
import { composeAuthoringSchema } from '../../../services/catalog-authoring/schema.service.js';
import { FOOTWEAR_PACKAGE, TRAILWIND_ABSENT_COMBINATIONS } from '../footwear.js';
import { nsCategoryKey, nsKey, nsSlug, type VerticalNamespace } from '../apply.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from './vertical-fixture.js';

const TOKEN = verticalRunToken('fw');
const PERMISSIONS = {
  canEditDraft: true,
  canPublish: true,
  canProposeValues: true,
  canSelectCanonicalEntity: true,
} as const;

const db: Database = await connectPostgres();
let seeded: SeededVertical;
let ns: VerticalNamespace;
let mensCategoryId: string;
let womensCategoryId: string;
let storeId: string;

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, FOOTWEAR_PACKAGE, TOKEN);
  ns = seeded.ns;
  const mens = await findCategoryByKey(nsCategoryKey(ns, 'athletic.mens_running_shoes'), db);
  const womens = await findCategoryByKey(nsCategoryKey(ns, 'athletic.womens_running_shoes'), db);
  if (!mens || !womens) throw new Error('the seeded departments did not resolve');
  mensCategoryId = mens.id;
  womensCategoryId = womens.id;
  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Fixture warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
}, 180_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 180_000);

/** Count the canonical products a facet selection admits, through the real filter. */
async function matchedProducts(
  categoryId: string,
  selection: Parameters<typeof resolveFacets>[0]['selection'],
): Promise<number> {
  const outcome = await resolveFacets(
    {
      scope: { kind: 'category', categoryId, includeDescendants: true },
      selection,
      locale: 'en',
      displayCurrency: 'EUR',
    },
    db,
  );
  return outcome.response.matchedProductCount;
}

describe('the category PATH', () => {
  it('is a path, and only its leaves are selectable', async () => {
    const breadcrumb = await findCategoryBreadcrumb(mensCategoryId, db);
    expect(breadcrumb.map((step) => step.key)).toEqual([
      nsCategoryKey(ns, 'shoes'),
      nsCategoryKey(ns, 'athletic'),
      nsCategoryKey(ns, 'athletic.mens_running_shoes'),
    ]);

    const rows = await db.execute<{ key: string; selectable: boolean }>(sql`
      select key, selectable from categories where key like ${`${ns.kebab}.%`} order by key
    `);
    const bySelectable = new Map([...rows].map((row) => [row.key, row.selectable]));
    expect(bySelectable.get(nsCategoryKey(ns, 'shoes'))).toBe(false);
    expect(bySelectable.get(nsCategoryKey(ns, 'athletic'))).toBe(false);
    expect(bySelectable.get(nsCategoryKey(ns, 'athletic.mens_running_shoes'))).toBe(true);
    expect(bySelectable.get(nsCategoryKey(ns, 'athletic.womens_running_shoes'))).toBe(true);
  });

  it('refuses a canonical product filed under a structural node', async () => {
    // `mercaria_category_assignment_selectable`. A department is not a shelf,
    // and that is a trigger rather than a convention.
    const structural = await findCategoryByKey(nsCategoryKey(ns, 'athletic'), db);
    expect(structural).not.toBeNull();
    let raised: unknown;
    try {
      await db.execute(sql`
        update canonical_products set category_id = ${structural?.id}
        where slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
      `);
    } catch (error) {
      raised = error;
    }
    expect(raised, 'a structural category accepted a product').toBeDefined();
    // And the product is untouched — the refusal is a refusal, not a partial write.
    const after = await db.execute<{ category_id: string }>(sql`
      select category_id from canonical_products where slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    expect([...after][0]?.category_id).toBe(mensCategoryId);
  });
});

describe('a second apply is a genuine no-op', () => {
  it('creates NOTHING and leaves the census matching', async () => {
    // Idempotency is what the whole seed's posture rests on: it is insert-only,
    // it has no destructive mode, and a run interrupted halfway is resumed by
    // running it again. The brake-pad file carries the same case, because that
    // is where the property was measured broken.
    const { applyVerticalPackage } = await import('../apply.js');
    const { censusVerticalPackage } = await import('../census.js');

    const { report } = await applyVerticalPackage(
      FOOTWEAR_PACKAGE,
      { apply: true, namespace: TOKEN, actorOxyUserId: seeded.actorOxyUserId },
      db,
    );
    expect(report.steps.length).toBeGreaterThan(100);
    expect(
      report.created,
      `a re-apply created: ${report.steps
        .filter((step) => step.outcome === 'create')
        .map((step) => `${step.entity} ${step.identity}`)
        .join(', ')}`,
    ).toBe(0);
    expect(report.divergent).toBe(0);
    expect((await censusVerticalPackage(db, FOOTWEAR_PACKAGE, ns)).outcome).toBe('matched');
  });

  it('REPORTS a hand-edited row as divergent rather than correcting it', async () => {
    // The other half of the posture: the seed's authority is to add what is
    // missing, never to overwrite a decision somebody made in the database. A
    // silent correction is how a hand-applied fix comes back.
    const { applyVerticalPackage } = await import('../apply.js');
    const ROLLBACK = 'vertical-fixture: intentional rollback';
    let divergent: string[] = [];
    let edited = 0;
    try {
      await db.transaction(async (tx) => {
        const updated = await tx.execute<{ id: string }>(sql`
          update categories set name = 'Hand edited'
          where key = ${nsCategoryKey(ns, 'athletic.mens_running_shoes')}
          returning id
        `);
        edited = [...updated].length;
        // A DRY run, so the case measures the detector and writes nothing even
        // before the rollback.
        const { report } = await applyVerticalPackage(
          FOOTWEAR_PACKAGE,
          { apply: false, namespace: TOKEN, actorOxyUserId: seeded.actorOxyUserId },
          tx as unknown as Database,
        );
        divergent = report.steps
          .filter((step) => step.outcome === 'divergent')
          .map((step) => step.identity);
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    }
    // Assert the mutation LANDED before asserting the detector fired.
    expect(edited, 'the category was never edited, so the control measured nothing').toBe(1);
    expect(divergent).toEqual([nsCategoryKey(ns, 'athletic.mens_running_shoes')]);
  });
});

describe('localized labels and the fallback chain', () => {
  it('serves Spanish for a Spanish request', async () => {
    const [presentation] = await readLocalizedCategories([mensCategoryId], 'es', db);
    expect(presentation?.name.outcome).toBe('resolved');
    if (presentation?.name.outcome !== 'resolved') return;
    expect(presentation.name.value).toBe('Zapatillas de running de hombre');
    expect(presentation.name.effectiveLocale).toBe('es');
  });

  it('falls back from a REGIONAL locale to its language, and says which it used', async () => {
    const [presentation] = await readLocalizedCategories([mensCategoryId], 'es-ES', db);
    expect(presentation?.name.outcome).toBe('resolved');
    if (presentation?.name.outcome !== 'resolved') return;
    // The step is what makes the fallback debuggable rather than invisible.
    expect(presentation.name.effectiveLocale).toBe('es');
    expect(presentation.name.step).toBe('language');
    expect(presentation.name.value).toBe('Zapatillas de running de hombre');
  });

  it('reports a field with NO translation as unavailable rather than inventing one', async () => {
    const [presentation] = await readLocalizedCategories([mensCategoryId], 'es', db);
    // The package translates the name and not the description. The unavailable
    // branch carries no `value` at all, so a renderer cannot show a blank
    // string believing it was translated.
    expect(presentation?.description.outcome).toBe('unavailable');
  });

  it('falls back to the base locale for a language nobody translated', async () => {
    const [presentation] = await readLocalizedCategories([mensCategoryId], 'ja', db);
    expect(presentation?.name.outcome).toBe('resolved');
    if (presentation?.name.outcome !== 'resolved') return;
    expect(presentation.name.effectiveLocale).toBe('en');
    expect(presentation.name.value).toBe("Men's running shoes");
  });
});

describe('the size systems are not collapsed, and the audience is the scope', () => {
  it("offers the men's US system in the men's department and NOT the women's", async () => {
    const mens = (await resolveDefinitionsForCategory(db, mensCategoryId)).map((d) => d.row.key);
    const womens = (await resolveDefinitionsForCategory(db, womensCategoryId)).map((d) => d.row.key);

    // Vacuity floor first: an empty list satisfies every "does not contain"
    // below and is exactly what a broken scope query returns.
    expect(mens.length).toBeGreaterThan(5);
    expect(womens.length).toBeGreaterThan(5);

    expect(mens).toContain(nsKey(ns, 'shoe_size_us_mens'));
    expect(mens).not.toContain(nsKey(ns, 'shoe_size_us_womens'));
    expect(womens).toContain(nsKey(ns, 'shoe_size_us_womens'));
    expect(womens).not.toContain(nsKey(ns, 'shoe_size_us_mens'));

    // The unscoped-in-this-package systems reach BOTH, which is the control
    // that shows the two exclusions above are about the SCOPE and not about
    // the two departments being disconnected.
    for (const shared of ['shoe_size_eu', 'shoe_size_uk', 'shoe_size_cm', 'footwear_color']) {
      expect(mens).toContain(nsKey(ns, shared));
      expect(womens).toContain(nsKey(ns, shared));
    }
  });

  it('gives each system its OWN facet, with no bucket reaching another', async () => {
    const outcome = await resolveFacets(
      {
        scope: { kind: 'category', categoryId: mensCategoryId, includeDescendants: true },
        selection: [],
        locale: 'en',
        displayCurrency: 'EUR',
      },
      db,
    );
    const keys = outcome.response.facets.map((facet) => facet.key);
    expect(keys).toContain(nsKey(ns, 'shoe_size_eu'));
    expect(keys).toContain(nsKey(ns, 'shoe_size_us_mens'));
    expect(keys).toContain(nsKey(ns, 'shoe_size_uk'));
    expect(keys).toContain(nsKey(ns, 'shoe_size_cm'));

    // Two systems, two facets, and the buckets of one carry values the other's
    // never do — `42` is an EU size and `8` is a UK size, and nothing in the
    // domain could map one onto the other.
    const eu = outcome.response.facets.find((facet) => facet.key === nsKey(ns, 'shoe_size_eu'));
    const uk = outcome.response.facets.find((facet) => facet.key === nsKey(ns, 'shoe_size_uk'));
    const bucketKeys = (facet: typeof eu): string[] =>
      facet?.values.shape === 'buckets' ? facet.values.buckets.map((bucket) => bucket.key) : [];
    expect(bucketKeys(eu)).toContain('42');
    expect(bucketKeys(uk)).not.toContain('42');
    expect(bucketKeys(uk).length).toBeGreaterThan(0);
  });
});

describe('the brand size charts disagree, which no universal table could', () => {
  it('narrows to ONE brand for a US size the other brand puts on a different EU size', async () => {
    // The unfiltered count first. "The filter matched one product" means
    // nothing without the number it narrowed FROM.
    const unfiltered = await matchedProducts(mensCategoryId, []);
    expect(unfiltered).toBe(2);

    const usNine = await matchedProducts(mensCategoryId, [
      { origin: 'attribute', facetKey: nsKey(ns, 'shoe_size_us_mens'), values: ['9'] },
    ]);
    expect(usNine).toBe(1);

    // And the SAME US size that both brands publish reaches both, which is what
    // rules out "the filter simply never matches more than one".
    const usEightAndAHalf = await matchedProducts(mensCategoryId, [
      { origin: 'attribute', facetKey: nsKey(ns, 'shoe_size_us_mens'), values: ['8.5'] },
    ]);
    expect(usEightAndAHalf).toBe(2);
  });

  it('puts one brand EU 42 at US 9 and the other at US 8.5, on the same variant row', async () => {
    const charts = await db.execute<{ slug: string; us: string; uk: string; mm: number }>(sql`
      select p.slug,
             max(us.normalized_text) as us,
             max(uk.normalized_text) as uk,
             max(cm.normalized_number) as mm
      from canonical_products p
      join canonical_variants v on v.product_id = p.id
      join canonical_variant_attributes eu
        on eu.variant_id = v.id and eu.attribute_key = ${nsKey(ns, 'shoe_size_eu')}
       and eu.normalized_value = '42'
      left join canonical_attribute_values us
        on us.variant_id = v.id and us.attribute_key = ${nsKey(ns, 'shoe_size_us_mens')}
      left join canonical_attribute_values uk
        on uk.variant_id = v.id and uk.attribute_key = ${nsKey(ns, 'shoe_size_uk')}
      left join canonical_attribute_values cm
        on cm.variant_id = v.id and cm.attribute_key = ${nsKey(ns, 'shoe_size_cm')}
      where p.slug in (${nsSlug(ns, 'kestrel-trailwind-3')}, ${nsSlug(ns, 'nordvik-fjord-runner')})
      group by p.slug order by p.slug
    `);
    const rows = [...charts];
    // Vacuity floor: two rows, or "they differ" is two absences differing.
    expect(rows).toHaveLength(2);
    const kestrel = rows.find((row) => row.slug === nsSlug(ns, 'kestrel-trailwind-3'));
    const nordvik = rows.find((row) => row.slug === nsSlug(ns, 'nordvik-fjord-runner'));
    expect(kestrel?.us).toBe('9');
    expect(nordvik?.us).toBe('8.5');
    expect(kestrel?.uk).toBe('8');
    expect(nordvik?.uk).toBe('7.5');
    // The measurement basis is the one fact that IS comparable across brands,
    // and it is stored in the family's base unit rather than in `cm`.
    expect(Number(kestrel?.mm)).toBe(265);
    expect(Number(nordvik?.mm)).toBe(268);
  });
});

describe('the colour family and the commercial colourway are different facts', () => {
  it('buckets two commercial names under ONE family, and shows both', async () => {
    const outcome = await resolveFacets(
      {
        scope: { kind: 'category', categoryId: mensCategoryId, includeDescendants: true },
        selection: [],
        locale: 'en',
        displayCurrency: 'EUR',
      },
      db,
    );
    const colour = outcome.response.facets.find(
      (facet) => facet.key === nsKey(ns, 'footwear_color'),
    );
    expect(colour?.values.shape).toBe('buckets');
    if (colour?.values.shape !== 'buckets') return;
    const black = colour.values.buckets.find((bucket) => bucket.key === 'black');
    expect(black, 'the black family bucket is missing').toBeDefined();
    // ONE bucket, and the two commercial names it observed beside it. Kestrel
    // writes `Jet Black` and Nordvik writes `Midnight`; a catalogue that read
    // the marketing string as the value would show two buckets here.
    expect([...(black?.observedLabels ?? [])].sort()).toEqual(['Jet Black', 'Midnight']);
  });

  it('preserves the source words beside the normalized family on every row', async () => {
    const rows = await db.execute<{ source_display_value: string; normalized_text: string }>(sql`
      select distinct source_display_value, normalized_text
      from canonical_attribute_values
      where attribute_key = ${nsKey(ns, 'footwear_color')}
      order by source_display_value
    `);
    const pairs = [...rows];
    expect(pairs.length).toBeGreaterThanOrEqual(4);
    for (const pair of pairs) {
      // Every row normalized — an `unparsed` row would carry a NULL
      // `normalized_text`, which is what an unmapped commercial name produces.
      expect(pair.normalized_text).not.toBeNull();
      expect(pair.source_display_value).not.toBe(pair.normalized_text);
    }
    expect(pairs.filter((pair) => pair.normalized_text === 'black').map((p) => p.source_display_value).sort()).toEqual(
      ['Jet Black', 'Midnight'],
    );
  });

  it('refuses the colourway as a facet, naming the reason', async () => {
    const outcome = await resolveFacets(
      {
        scope: { kind: 'category', categoryId: mensCategoryId, includeDescendants: true },
        selection: [],
        locale: 'en',
        displayCurrency: 'EUR',
      },
      db,
    );
    const suppression = outcome.response.suppressed.find(
      (entry) => entry.facetKey === nsKey(ns, 'footwear_colorway'),
    );
    expect(suppression?.reason).toBe('not_filterable');
    expect(outcome.response.facets.map((facet) => facet.key)).not.toContain(
      nsKey(ns, 'footwear_colorway'),
    );
  });
});

describe('the multi-axis matrix is sparse, and provably so', () => {
  /** Whether a (size, colour, width) combination has a canonical variant. */
  async function combinationExists(
    handle: Database,
    size: string,
    colour: string,
    width: string,
  ): Promise<boolean> {
    const rows = await handle.execute<{ total: number }>(sql`
      select count(*)::int as total
      from canonical_variants v
      join canonical_products p on p.id = v.product_id
      join canonical_variant_attributes a1 on a1.variant_id = v.id
        and a1.attribute_key = ${nsKey(ns, 'shoe_size_eu')} and a1.normalized_value = ${size}
      join canonical_variant_attributes a2 on a2.variant_id = v.id
        and a2.attribute_key = ${nsKey(ns, 'footwear_color')} and a2.normalized_value = ${colour}
      join canonical_variant_attributes a3 on a3.variant_id = v.id
        and a3.attribute_key = ${nsKey(ns, 'shoe_width')} and a3.normalized_value = ${width}
      where p.slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    return ([...rows][0]?.total ?? 0) > 0;
  }

  it('seeds eight of the twelve combinations its three axes describe', async () => {
    const rows = await db.execute<{ variants: number; axes: number }>(sql`
      select count(distinct v.id)::int as variants,
             count(distinct a.attribute_key)::int as axes
      from canonical_variants v
      join canonical_products p on p.id = v.product_id
      join canonical_variant_attributes a on a.variant_id = v.id
      where p.slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    const row = [...rows][0];
    expect(row?.variants).toBe(8);
    expect(row?.axes).toBe(3);
  });

  it('leaves four combinations genuinely absent, each of whose VALUES exists', async () => {
    for (const absent of TRAILWIND_ABSENT_COMBINATIONS) {
      expect(
        await combinationExists(db, absent.size, absent.color, absent.width),
        `${absent.size}/${absent.color}/${absent.width} was seeded after all`,
      ).toBe(false);
    }

    // The control that makes the four absences mean something. Each value
    // appears on SOME variant, so the combination is unavailable rather than
    // the value being unknown — which a fixture that simply forgot `wide`
    // would not distinguish.
    const present = await db.execute<{ attribute_key: string; normalized_value: string }>(sql`
      select distinct a.attribute_key, a.normalized_value
      from canonical_variant_attributes a
      join canonical_variants v on v.id = a.variant_id
      join canonical_products p on p.id = v.product_id
      where p.slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    const values = new Map<string, Set<string>>();
    for (const row of present) {
      const set = values.get(row.attribute_key) ?? new Set<string>();
      set.add(row.normalized_value);
      values.set(row.attribute_key, set);
    }
    for (const absent of TRAILWIND_ABSENT_COMBINATIONS) {
      expect(values.get(nsKey(ns, 'shoe_size_eu'))).toContain(absent.size);
      expect(values.get(nsKey(ns, 'footwear_color'))).toContain(absent.color);
      expect(values.get(nsKey(ns, 'shoe_width'))).toContain(absent.width);
    }
  });

  it('NOTICES the missing combination when it is inserted', async () => {
    // The mutation control the sparse case needs: prove the query above
    // distinguishes "absent" from "unqueried". It runs inside a transaction
    // that is rolled back, so the catalogue is unchanged afterwards — and the
    // final assertion re-reads OUTSIDE the transaction to say so.
    const absent = TRAILWIND_ABSENT_COMBINATIONS[0];
    expect(absent).toBeDefined();
    if (!absent) return;

    const productRows = await db.execute<{ id: string }>(sql`
      select id from canonical_products where slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    const productId = [...productRows][0]?.id;
    expect(productId).toBeDefined();
    if (productId === undefined) return;

    const ROLLBACK = 'vertical-fixture: intentional rollback';
    let sawItDuringTheMutation = false;
    try {
      await db.transaction(async (tx) => {
        const variantId = `${TOKEN}-mutant`;
        // A signature that satisfies `canonical_variants_signature_shape_check`
        // and collides with nothing — the case is about the axis rows, not
        // about the digest.
        await tx.execute(sql`
          insert into canonical_variants (id, product_id, signature, is_default, status)
          values (${variantId}, ${productId}, ${'f'.repeat(64)}, false, 'active')
        `);
        // `canonical_variant_attributes.id` carries no server-side default —
        // the drizzle column generates it in the application — so a raw insert
        // has to supply one.
        let ordinal = 0;
        for (const [key, value] of [
          [nsKey(ns, 'shoe_size_eu'), absent.size],
          [nsKey(ns, 'footwear_color'), absent.color],
          [nsKey(ns, 'shoe_width'), absent.width],
        ] as const) {
          await tx.execute(sql`
            insert into canonical_variant_attributes
              (id, variant_id, attribute_key, display_value, normalized_value, normalization_state, position)
            values (${`${variantId}-${ordinal}`}, ${variantId}, ${key}, ${value}, ${value}, 'normalized', ${ordinal})
          `);
          ordinal += 1;
        }
        // Assert the mutation LANDED before asserting the detector fired.
        sawItDuringTheMutation = await combinationExists(
          tx as unknown as Database,
          absent.size,
          absent.color,
          absent.width,
        );
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    }

    expect(sawItDuringTheMutation, 'the absence query did not notice a seeded combination').toBe(
      true,
    );
    expect(await combinationExists(db, absent.size, absent.color, absent.width)).toBe(false);
  });

  it('converges rather than duplicating when one combination is asked for twice', async () => {
    // `UNIQUE(product_id, signature)` is what makes the matrix a set. Two
    // requests for one configuration are one row, which is the property a
    // re-run of the seed rests on.
    const before = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from canonical_variants v
      join canonical_products p on p.id = v.product_id
      where p.slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    const { createVariant } = await import('../../../services/canonical/canonical-variant.service.js');
    const productRows = await db.execute<{ id: string }>(sql`
      select id from canonical_products where slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    const productId = [...productRows][0]?.id;
    if (productId === undefined) throw new Error('the Trailwind product did not resolve');
    const again = await createVariant({
      productId,
      options: [
        { key: nsKey(ns, 'shoe_size_eu'), value: '42' },
        { key: nsKey(ns, 'footwear_color'), value: 'black' },
        { key: nsKey(ns, 'shoe_width'), value: 'standard' },
      ],
    });
    expect(again.created).toBe(false);
    const after = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from canonical_variants v
      join canonical_products p on p.id = v.product_id
      where p.slug = ${nsSlug(ns, 'kestrel-trailwind-3')}
    `);
    expect([...after][0]?.total).toBe([...before][0]?.total);
  });
});

describe('authoring → publication → the product page', () => {
  it('composes a schema for the seeded category and product type', async () => {
    const composed = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(ns, 'athletic_footwear'),
      categoryId: mensCategoryId,
      flow: 'merchant',
      requestedLocale: 'es',
      market: 'ES',
      permissions: PERMISSIONS,
    });
    expect(composed.outcome).toBe('composed');
    if (composed.outcome !== 'composed') return;
    // Ten fields in the merchant flow — the P2P three are a different flow and
    // must not leak into this one.
    expect(composed.schema.fields).toHaveLength(10);
    expect(composed.schema.text.productTypeName.value).toBe('Calzado deportivo');
    const axes = composed.schema.fields.filter((field) => field.variantCapable);
    expect(axes.map((field) => field.key).sort()).toEqual(
      [nsKey(ns, 'footwear_color'), nsKey(ns, 'shoe_size_eu'), nsKey(ns, 'shoe_width')].sort(),
    );
  });

  it('asks for LESS in the P2P flow, on the same version', async () => {
    const composed = await composeAuthoringSchema(db, {
      productTypeKey: nsKey(ns, 'athletic_footwear'),
      categoryId: mensCategoryId,
      flow: 'p2p',
      requestedLocale: 'en',
      market: 'ES',
      permissions: PERMISSIONS,
    });
    expect(composed.outcome).toBe('composed');
    if (composed.outcome !== 'composed') return;
    expect(composed.schema.fields).toHaveLength(3);
    // The width is `recommended` for a merchant and `optional` for a person
    // selling one pair — the only axis a flow may vary.
    const width = composed.schema.fields.find((field) => field.key === nsKey(ns, 'shoe_width'));
    expect(width?.requirement).toBe('optional');
  });

  it('publishes a merchant listing whose variants carry TYPED axes', async () => {
    const enumId = async (attributeKey: string, value: string): Promise<string> => {
      const rows = await db.execute<{ id: string }>(sql`
        select v.id from attribute_enum_values v
        join attribute_definitions d on d.id = v.attribute_definition_id
        where d.key = ${nsKey(ns, attributeKey)} and v.value = ${value}
      `);
      const id = [...rows][0]?.id;
      if (id === undefined) throw new Error(`no enum value ${attributeKey}=${value}`);
      return id;
    };

    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: seeded.actorOxyUserId,
      categoryId: mensCategoryId,
      productTypeKey: nsKey(ns, 'athletic_footwear'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: PERMISSIONS,
      ttlSeconds: 3600,
      idempotencyKey: null,
      title: 'Fixture running shoe',
    });

    const patched = await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: PERMISSIONS,
      description: 'Seeded by the footwear reference vertical.',
      fields: [
        { attributeKey: nsKey(ns, 'upper_material'), values: [{ enumValueId: await enumId('upper_material', 'mesh') }] },
      ],
      variants: [
        {
          sku: `${TOKEN}-SKU-1`,
          inventoryAvailable: 4,
          price: { amount: 12900, currency: 'EUR' },
          axes: [
            { attributeKey: nsKey(ns, 'shoe_size_eu'), values: [{ enumValueId: await enumId('shoe_size_eu', '42') }] },
            { attributeKey: nsKey(ns, 'footwear_color'), values: [{ enumValueId: await enumId('footwear_color', 'black') }] },
            { attributeKey: nsKey(ns, 'shoe_width'), values: [{ enumValueId: await enumId('shoe_width', 'standard') }] },
          ],
        },
      ],
    });
    expect(patched.version).toBe(draft.version + 1);

    const validation = await validateStoreDraft(db, {
      storeId,
      draftId: draft.id,
      permissions: PERMISSIONS,
    });
    expect(
      validation.publishable,
      `the draft is not publishable: ${JSON.stringify(validation.findings)}`,
    ).toBe(true);

    const publication = await publishDraft(db, {
      storeId,
      draftId: draft.id,
      actorOxyUserId: seeded.actorOxyUserId,
      permissions: PERMISSIONS,
      idempotencyKey: null,
    });
    expect(publication.outcome).toBe('published');
    if (publication.outcome === 'refused') return;

    const axes = await db.execute<{ attribute_key: string; position: number }>(sql`
      select attribute_key, position from native_listing_variant_axes
      where listing_id = ${publication.listingId} order by position
    `);
    expect([...axes].map((row) => row.attribute_key)).toEqual([
      nsKey(ns, 'shoe_size_eu'),
      nsKey(ns, 'footwear_color'),
      nsKey(ns, 'shoe_width'),
    ]);

    const assignments = await db.execute<{ attribute_key: string; normalized_value: string }>(sql`
      select a.attribute_key, a.normalized_value
      from native_variant_axis_assignments a
      join product_variants pv on pv.id = a.variant_id
      where pv.listing_id = ${publication.listingId}
      order by a.attribute_key
    `);
    // The values are the CANONICAL ones, not the labels a form displayed.
    expect([...assignments].map((row) => row.normalized_value).sort()).toEqual([
      '42',
      'black',
      'standard',
    ]);
  });

  it('renders the canonical product page with every seeded configuration', async () => {
    const result = await readCanonicalProductPage({
      handle: nsSlug(ns, 'kestrel-trailwind-3'),
      comparisonCurrency: 'EUR',
      limit: 20,
      offerComparisonPermitted: true,
    });
    expect(result, 'the product page did not resolve').toBeDefined();
    if (!result) return;
    expect(result.page.product.name).toBe('Kestrel Trailwind 3');
    expect(result.page.variants).toHaveLength(8);
  });
});
