/**
 * The SMARTPHONE reference vertical, end to end against a REAL PostgreSQL server
 * (#367 Workstream 14).
 *
 * ## What it drives
 *
 * The brand → family → product → variant chain; the line between a variant AXIS
 * and a typed FACT, asserted from BOTH sides (three axes that are, ten facts
 * that are refused); a merchant selecting an existing canonical product and
 * publishing against it by DIRECT LINK; a genuinely new model arriving through
 * the proposal and review flow; localized search aliases; and same-variant
 * filter semantics.
 *
 * ## The controls
 *
 * - The alias case asserts the `exact_alias` STAGE rather than the result
 *   count, and removes the alias inside a rolled-back transaction to show the
 *   stage disappears. A count would not move: the token stage matches the same
 *   product for the same query, so a fixture whose alias never worked would
 *   report the same number.
 * - The same-variant case asserts each half of the conjunction matches
 *   something ALONE before asserting the conjunction matches nothing —
 *   otherwise "no product has both" is satisfied by a filter that matches
 *   nothing at all.
 * - The axis refusals are driven against the real CHECK and the real trigger,
 *   and each asserts its OWN constraint name off the error's CAUSE CHAIN. A
 *   `toThrow(/name/)` matches drizzle's `Failed query: <sql>` wrapper, which
 *   contains the table name and would pass for the wrong constraint.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { resolveFacets } from '../../../services/facets/facet.service.js';
import { runCanonicalSearch } from '../../../services/search/canonical-search.service.js';
import { readCanonicalProductPage } from '../../../services/product-page/product-page.service.js';
import { assessVariantAxis } from '../../../services/product-types/variant-axis.js';
import { createDraft, patchDraft, validateStoreDraft } from '../../../services/catalog-authoring/draft.service.js';
import { publishDraft } from '../../../services/catalog-authoring/publish.service.js';
import { createCanonicalProduct } from '../../../services/canonical/canonical-product.service.js';
import { submitProposal } from '../../../services/catalog-proposals/proposal.service.js';
import { mergeProposalIntoExisting } from '../../../services/catalog-proposals/review.service.js';
import { listReviewEvents } from '../../../db/catalogProposals/proposalRepository.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { SMARTPHONE_PACKAGE } from '../smartphone.js';
import { nsCategoryKey, nsKey, nsSlug, type VerticalNamespace } from '../apply.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from './vertical-fixture.js';

const TOKEN = verticalRunToken('sp');
const PERMISSIONS = {
  canEditDraft: true,
  canPublish: true,
  canProposeValues: true,
  canSelectCanonicalEntity: true,
} as const;

const db: Database = await connectPostgres();
let seeded: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let storeId: string;
/** A bare listing the axis-refusal cases write against. */
let probeListingId: string;
/** The canonical product a proposal approval mints, for the teardown. */
let proposedProductId: string | null = null;

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = seeded.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the smartphone category did not resolve');
  categoryId = category.id;
  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Fixture warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
  probeListingId = `${TOKEN}-probe-listing`;
  await db.execute(sql`
    insert into listings (id, owner_type, store_id, title, description, condition, condition_assertion, status)
    values (${probeListingId}, 'store', ${storeId}, 'Axis probe', 'Axis probe', 'new', 'seller_declared', 'draft')
    on conflict (id) do nothing
  `);
}, 180_000);

afterAll(async () => {
  // The proposal trail first: `catalog_review_events` refuses DELETE by
  // trigger and its `proposal_id` is `restrict`, so the events genuinely have
  // to go before the proposals do. ONE table in the window.
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
  if (proposedProductId !== null) {
    await db.execute(
      sql`delete from canonical_product_aliases where product_id = ${proposedProductId}`,
    );
    await deleteTestCanonicalRows(db, { productIds: [proposedProductId] });
  }
  await teardownVertical(db, TOKEN);
}, 180_000);

/** Whether the statement was refused by the NAMED constraint, read off the CAUSE chain. */
async function refusedBy(statement: ReturnType<typeof sql>, constraint: string): Promise<void> {
  let raised: unknown;
  try {
    await db.execute(statement);
  } catch (error) {
    raised = error;
  }
  expect(raised, 'the statement was accepted, and it must be refused').toBeDefined();
  const chain: string[] = [];
  for (let error = raised; error !== undefined && error !== null; ) {
    if (error instanceof Error) {
      chain.push(error.message);
      error = error.cause;
      continue;
    }
    chain.push(String(error));
    break;
  }
  expect(chain.join(' | ')).toContain(constraint);
}

async function matchedProducts(
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

async function enumValueId(attributeKey: string, value: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    select v.id from attribute_enum_values v
    join attribute_definitions d on d.id = v.attribute_definition_id
    where d.key = ${nsKey(ns, attributeKey)} and v.value = ${value}
  `);
  const id = [...rows][0]?.id;
  if (id === undefined) throw new Error(`no enum value ${attributeKey}=${value}`);
  return id;
}

describe('brand → family → product → variant', () => {
  it('is four real foreign keys and not a naming convention', async () => {
    const rows = await db.execute<{
      brand: string;
      family: string;
      product: string;
      variants: number;
    }>(sql`
      select b.name as brand, f.name as family, p.name as product, count(v.id)::int as variants
      from canonical_products p
      join brands b on b.id = p.brand_id
      join canonical_product_families f on f.id = p.family_id
      join canonical_variants v on v.product_id = p.id
      where p.slug = ${nsSlug(ns, 'lumira-axon-9-pro')}
      group by b.name, f.name, p.name
    `);
    const row = [...rows][0];
    expect(row, 'the chain did not resolve — one of the four joins found nothing').toBeDefined();
    expect(row?.brand).toBe('Lumira');
    expect(row?.family).toBe('Axon');
    expect(row?.product).toBe('Lumira Axon 9 Pro');
    expect(row?.variants).toBe(8);
  });

  it('puts two products of two brands under the same category through two families', async () => {
    const rows = await db.execute<{ families: number; brands: number; products: number }>(sql`
      select count(distinct p.family_id)::int as families,
             count(distinct p.brand_id)::int as brands,
             count(distinct p.id)::int as products
      from canonical_products p where p.slug like ${`${ns.kebab}-%`}
    `);
    expect([...rows][0]).toEqual({ families: 2, brands: 2, products: 2 });
  });
});

describe('the axis / typed-fact line', () => {
  it('marks exactly three definitions variant-defining, and ten not', async () => {
    const rows = await db.execute<{ key: string; variant_defining: boolean }>(sql`
      select key, variant_defining from attribute_definitions
      where key like ${`${ns.snake}_%`} and lifecycle_state = 'active' order by key
    `);
    const all = [...rows];
    expect(all).toHaveLength(13);
    expect(all.filter((row) => row.variant_defining).map((row) => row.key).sort()).toEqual([
      nsKey(ns, 'device_region'),
      nsKey(ns, 'phone_color'),
      nsKey(ns, 'storage_capacity'),
    ].sort());
    expect(all.filter((row) => !row.variant_defining)).toHaveLength(10);
  });

  it('refuses a variant-capable field whose scope is not `variant` (pure)', () => {
    expect(
      assessVariantAxis({ scope: 'product', attributeKey: 'chipset', variantCapable: true }),
    ).toEqual({ outcome: 'refused', refusal: 'scope_is_not_variant', attributeKey: 'chipset' });
    // The control: the same attribute at `variant` scope is permitted, so the
    // refusal is about the SCOPE and not about the attribute.
    expect(
      assessVariantAxis({ scope: 'variant', attributeKey: 'chipset', variantCapable: true }),
    ).toEqual({ outcome: 'permitted' });
  });

  it('refuses a compatibility target as an axis whatever its scope (pure)', () => {
    for (const key of ['vehicle_make', 'year_range', 'fitment', 'compatible_with']) {
      expect(assessVariantAxis({ scope: 'variant', attributeKey: key, variantCapable: true })).toEqual(
        { outcome: 'refused', refusal: 'attribute_may_not_be_an_axis', attributeKey: key },
      );
    }
  });

  it('refuses a vehicle key as a listing axis — by the CITATION trigger, first', async () => {
    // Measured, and worth recording rather than working around: the citation
    // trigger is the FIRST wall, not the forbidden-key CHECK. A row may only
    // name the key its cited definition carries, so `vehicle_make` is refused
    // before the CHECK is ever evaluated — and reaching the CHECK would need a
    // definition literally named `vehicle_make`, which is the thing nobody
    // should create. A test that claimed to drive the CHECK here would be
    // describing a wall that nothing reaches first.
    const definition = await db.execute<{ id: string; version: number }>(sql`
      select id, version from attribute_definitions where key = ${nsKey(ns, 'phone_color')}
    `);
    const row = [...definition][0];
    expect(row).toBeDefined();
    if (!row) return;
    await refusedBy(
      sql`
        insert into native_listing_variant_axes
          (id, listing_id, attribute_definition_id, attribute_key, attribute_definition_version, position)
        values (${`${TOKEN}-bad-axis`}, ${probeListingId}, ${row.id}, 'vehicle_make', ${row.version}, 0)
      `,
      'disagrees with definition',
    );
  });

  it('carries the forbidden-key CHECK behind that trigger, naming the vehicle keys', async () => {
    // The SECOND wall, asserted where it lives. It is the one that holds for a
    // listing citing no product type at all, and for a database somebody
    // reaches with `psql`, so its absence must be noticed even though the
    // trigger above gets there first.
    const rows = await db.execute<{ conname: string; expression: string }>(sql`
      select conname, pg_get_constraintdef(oid) as expression
      from pg_constraint
      where conname in (
        'native_listing_variant_axes_forbidden_key_check',
        'product_type_fields_variant_axis_check'
      )
      order by conname
    `);
    const found = [...rows];
    // Vacuity floor: two constraints, or a query that found nothing would
    // satisfy every `toContain` below by never running one.
    expect(found.map((row) => row.conname)).toEqual([
      'native_listing_variant_axes_forbidden_key_check',
      'product_type_fields_variant_axis_check',
    ]);
    for (const row of found) {
      for (const key of ['vehicle_make', 'vehicle_generation', 'year_range', 'fitment']) {
        expect(row.expression, `${row.conname} does not name ${key}`).toContain(key);
      }
      // And the offer facts, from the other half of the same tuple.
      expect(row.expression).toContain('condition');
      expect(row.expression).toContain('price');
    }
    // The product-type CHECK additionally requires the variant SCOPE, which is
    // what holds for a key nobody thought to forbid.
    const productTypeCheck = found.find(
      (row) => row.conname === 'product_type_fields_variant_axis_check',
    );
    expect(productTypeCheck?.expression).toContain("scope = 'variant'");
  });

  it('refuses an axis citing a definition that is not variant-defining, at the DATABASE', async () => {
    const definition = await db.execute<{ id: string; version: number }>(sql`
      select id, version from attribute_definitions where key = ${nsKey(ns, 'chipset')}
    `);
    const row = [...definition][0];
    expect(row).toBeDefined();
    if (!row) return;
    await refusedBy(
      sql`
        insert into native_listing_variant_axes
          (id, listing_id, attribute_definition_id, attribute_key, attribute_definition_version, position)
        values (${`${TOKEN}-fact-axis`}, ${probeListingId}, ${row.id}, ${nsKey(ns, 'chipset')}, ${row.version}, 0)
      `,
      'variant_defining',
    );

    // The control: the SAME statement with a variant-defining definition is
    // accepted, so the refusal is about the flag and not about the shape.
    const axis = await db.execute<{ id: string; version: number }>(sql`
      select id, version from attribute_definitions where key = ${nsKey(ns, 'phone_color')}
    `);
    const axisRow = [...axis][0];
    if (!axisRow) return;
    await db.execute(sql`
      insert into native_listing_variant_axes
        (id, listing_id, attribute_definition_id, attribute_key, attribute_definition_version, position)
      values (${`${TOKEN}-ok-axis`}, ${probeListingId}, ${axisRow.id}, ${nsKey(ns, 'phone_color')}, ${axisRow.version}, 0)
    `);
    const written = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from native_listing_variant_axes where id = ${`${TOKEN}-ok-axis`}
    `);
    expect([...written][0]?.total).toBe(1);
  });
});

describe('a measurement axis collapses two spellings of one capacity', () => {
  it('gives `256 GB` and `256GB` the same stored axis value on two products', async () => {
    const rows = await db.execute<{ slug: string; display_value: string; normalized_value: string }>(
      sql`
        select distinct p.slug, a.display_value, a.normalized_value
        from canonical_variant_attributes a
        join canonical_variants v on v.id = a.variant_id
        join canonical_products p on p.id = v.product_id
        where a.attribute_key = ${nsKey(ns, 'storage_capacity')}
        order by p.slug, a.display_value
      `,
    );
    const all = [...rows];
    // Vacuity floor: both spellings must be present, or "they agree" is one
    // value agreeing with itself.
    const spellings = new Set(all.map((row) => row.display_value));
    expect(spellings).toContain('256 GB');
    expect(spellings).toContain('256GB');

    const normalizedFor = (display: string): string[] =>
      [...new Set(all.filter((row) => row.display_value === display).map((row) => row.normalized_value))];
    expect(normalizedFor('256 GB')).toEqual(normalizedFor('256GB'));
    expect(normalizedFor('256 GB')).toHaveLength(1);
    // Stored in the family's BASE unit, so it is comparable and sortable rather
    // than a string that happens to match.
    expect(normalizedFor('256 GB')[0]).toBe('256000000000B');
    // The control: a genuinely different capacity does NOT collapse onto it.
    expect(normalizedFor('512 GB')).not.toEqual(normalizedFor('256 GB'));
  });
});

describe('selecting an existing canonical product and publishing by DIRECT LINK', () => {
  it('records a `merchant_declared` link with no confidence at all', async () => {
    const productRows = await db.execute<{ id: string }>(sql`
      select id from canonical_products where slug = ${nsSlug(ns, 'lumira-axon-9-pro')}
    `);
    const productId = [...productRows][0]?.id;
    expect(productId).toBeDefined();
    if (productId === undefined) return;

    const variantRows = await db.execute<{ id: string }>(sql`
      select v.id from canonical_variants v
      join canonical_variant_attributes s on s.variant_id = v.id
        and s.attribute_key = ${nsKey(ns, 'storage_capacity')} and s.normalized_value = '256000000000B'
      join canonical_variant_attributes c on c.variant_id = v.id
        and c.attribute_key = ${nsKey(ns, 'phone_color')} and c.normalized_value = 'black'
      join canonical_variant_attributes r on r.variant_id = v.id
        and r.attribute_key = ${nsKey(ns, 'device_region')} and r.normalized_value = 'eu'
      where v.product_id = ${productId}
    `);
    const canonicalVariantId = [...variantRows][0]?.id;
    expect(canonicalVariantId, 'the 256 GB / black / EU configuration did not resolve').toBeDefined();
    if (canonicalVariantId === undefined) return;

    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: seeded.actorOxyUserId,
      categoryId,
      productTypeKey: nsKey(ns, 'smartphone'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: PERMISSIONS,
      ttlSeconds: 3600,
      idempotencyKey: null,
      title: 'Lumira Axon 9 Pro — fixture listing',
    });

    await patchDraft(db, {
      storeId,
      draftId: draft.id,
      expectedVersion: draft.version,
      permissions: PERMISSIONS,
      description: 'Published against an existing canonical product.',
      // The product half of the direct link.
      selectedCanonicalProductId: productId,
      fields: [
        { attributeKey: nsKey(ns, 'chipset'), values: [{ enumValueId: await enumValueId('chipset', 'snapdragon_8_gen_4') }] },
        { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.7, unit: 'in' }] },
      ],
      variants: [
        {
          sku: `${TOKEN}-AXON-256-BLK-EU`,
          inventoryAvailable: 2,
          price: { amount: 129900, currency: 'EUR' },
          // The configuration half. Both are needed: a product selection alone
          // says which model, and this says which exact buyable thing.
          selectedCanonicalVariantId: canonicalVariantId,
          axes: [
            { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 256, unit: 'GB' }] },
            { attributeKey: nsKey(ns, 'phone_color'), values: [{ enumValueId: await enumValueId('phone_color', 'black') }] },
            { attributeKey: nsKey(ns, 'device_region'), values: [{ enumValueId: await enumValueId('device_region', 'eu') }] },
          ],
        },
      ],
    });

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

    const links = await db.execute<{
      method: string;
      match_rule: string;
      confidence: number | null;
      status: string;
      canonical_variant_id: string;
    }>(sql`
      select method, match_rule, confidence, status, canonical_variant_id
      from native_listing_links where listing_id = ${publication.listingId}
    `);
    const link = [...links];
    expect(link).toHaveLength(1);
    expect(link[0]?.method).toBe('merchant_declared');
    expect(link[0]?.match_rule).toBe('authoring.merchant_declared');
    // NULL and not zero: `native_listing_links_confidence_check` admits a number
    // only for the `matcher` method, so a merchant's own declaration cannot be
    // scored as if a heuristic had produced it.
    expect(link[0]?.confidence).toBeNull();
    expect(link[0]?.status).toBe('active');
    expect(link[0]?.canonical_variant_id).toBe(canonicalVariantId);
  });
});

describe('a genuinely NEW model through the proposal and review flow', () => {
  it('is submitted, reviewed by a DIFFERENT operator, and resolved onto a minted product', async () => {
    const submission = await submitProposal(db, {
      type: 'canonical_product',
      storeId,
      submittedByOxyUserId: `${TOKEN}-merchant`,
      proposedLabel: 'Lumira Axon 10 Ultra',
      sourceLocale: 'en',
      proposedDescription: 'A model Mercaria does not carry yet.',
      submitterNote: 'Announced this week; we have stock arriving.',
      categoryId,
      productTypeDefinitionId: null,
      attributeDefinitionId: null,
      attributeDefinitionVersion: null,
      draftId: null,
      draftValueId: null,
    });
    expect(submission.outcome).toBe('created');
    const proposal = submission.proposal;
    expect(proposal.state).toBe('submitted');
    // The duplicate scan RAN, and says how much it looked at. A scan over an
    // empty population would report no duplicates for a reason that is not
    // about the label.
    expect(submission.scan.population).toBeGreaterThan(0);

    // Approval does NOT mint a canonical product: `mintForProposal` refuses
    // every link-only type by name. The operator creates it on the canonical
    // surface and RESOLVES the proposal onto it, which is what keeps a merchant
    // request from becoming globally trusted data by itself.
    const minted = await createCanonicalProduct({
      name: `Lumira Axon 10 Ultra ${TOKEN}`,
      slug: nsSlug(ns, 'lumira-axon-10-ultra'),
      brandId: seeded.handles.brandIds.get('lumira') ?? '',
      familyId: seeded.handles.familyIds.get('axon') ?? '',
      categoryId,
      variantDefiningAttributeKeys: [nsKey(ns, 'storage_capacity'), nsKey(ns, 'phone_color')],
      actorOxyUserId: `${TOKEN}-operator-2`,
    });
    proposedProductId = minted.id;

    const resolved = await mergeProposalIntoExisting(
      db,
      // A DIFFERENT Oxy id from the submitter — `catalog_proposals_decider_distinct_check`
      // refuses the same one, so nobody approves their own request.
      { proposalId: proposal.id, operatorOxyUserId: `${TOKEN}-operator-2` },
      { resolvedEntityId: minted.id, reason: 'Minted on the canonical catalogue and linked.' },
    );
    expect(resolved.state).toBe('merged');
    expect(resolved.resolvedEntityId).toBe(minted.id);

    // The trail is append-only and carries both acts.
    const events = await listReviewEvents(db, proposal.id);
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['submitted', 'merged_into_existing']),
    );
  });

  it('refuses to re-decide a decided proposal', async () => {
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
        { resolvedEntityId: proposedProductId ?? '', reason: 'A second decision.' },
      ),
    ).rejects.toThrow();
  });
});

describe('localized search aliases', () => {
  /** The retrieval stages the query reached this product through. */
  async function stagesFor(term: string, handle: Database = db): Promise<string[]> {
    const outcome = await runCanonicalSearch(
      { term, kinds: ['product'], filters: {}, limit: 10 },
      handle,
    );
    const hit = outcome.response.results.find(
      (result) => result.kind === 'product' && result.slug === nsSlug(ns, 'lumira-axon-9-pro'),
    );
    return hit?.kind === 'product' ? [...hit.matchStages] : [];
  }

  it('reaches the product by its Spanish, Mexican and English aliases', async () => {
    for (const term of [
      'móvil Lumira Axon 9 Pro',
      'celular Lumira Axon 9 Pro',
      'Lumira Axon 9 Pro mobile',
    ]) {
      const stages = await stagesFor(term);
      expect(stages, `'${term}' did not reach the product at all`).not.toHaveLength(0);
      // The ALIAS stage specifically. A result that arrived only by token or
      // fuzzy matching says nothing about the alias row.
      expect(stages, `'${term}' did not match through the alias stage`).toContain('exact_alias');
    }
  });

  it('reaches it by an accent-FOLDED search token too, which is a different stage', async () => {
    const stages = await stagesFor('movil');
    expect(stages).toContain('token');
    // And not through the alias stage: `movil` unaccented is not an alias row,
    // which is why both mechanisms are seeded.
    expect(stages).not.toContain('exact_alias');
  });

  it('LOSES the alias stage when the alias row is removed', async () => {
    // The control. A count would not move — the token stage matches the same
    // product for the same query — so the assertion is about the STAGE, and
    // this proves the stage is the alias row's doing.
    const ROLLBACK = 'vertical-fixture: intentional rollback';
    let stagesWithoutTheAlias: string[] = [];
    let removed = 0;
    try {
      await db.transaction(async (tx) => {
        // Scoped to THIS run's product, and that is load-bearing rather than
        // tidy: the seed namespaces keys, slugs and handles and NOT alias text,
        // so every sibling file that applies the smartphone package holds a row
        // with this same `normalized_alias`. Deleting by text alone removed
        // theirs too and the `toBe(1)` below failed — measured on CI as
        // `expected 2 to be 1` once #367 Workstream 18's journeys began seeding
        // the package as well. `canonical_products.slug` is unique and
        // namespaced, and `canonical_product_aliases` is unique on
        // `(product_id, normalized_alias)`, so the scoped delete can only ever
        // match one row. The control that caught it stays exactly as it was.
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from canonical_product_aliases
          where normalized_alias = ${'móvil lumira axon 9 pro'}
            and product_id = (
              select id from canonical_products where slug = ${nsSlug(ns, 'lumira-axon-9-pro')})
          returning id
        `);
        removed = [...deleted].length;
        stagesWithoutTheAlias = await stagesFor('móvil Lumira Axon 9 Pro', tx as unknown as Database);
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
    }
    // Assert the mutation LANDED before asserting the detector fired.
    expect(removed, 'the alias row was never removed, so the control measured nothing').toBe(1);
    // And that the product is still REACHABLE, which the comment above already
    // depends on and nothing checked: if the token and fuzzy stages ever stopped
    // matching, `stages` would be `[]` and `not.toContain` below would pass while
    // measuring nothing — the same vacuity the `toBe(1)` above exists to prevent.
    // Measured: `['token','fuzzy']` survives the delete, so this is a narrowing.
    expect(
      stagesWithoutTheAlias,
      'the product became unreachable, so the assertion below measures nothing',
    ).toContain('token');
    expect(stagesWithoutTheAlias).not.toContain('exact_alias');
    // And it is back afterwards — the transaction rolled back.
    expect(await stagesFor('móvil Lumira Axon 9 Pro')).toContain('exact_alias');
  });
});

describe('same-variant filter semantics', () => {
  it('refuses to combine one variant’s storage with another variant’s colour', async () => {
    // Each half matches something on its OWN, which is the control: without it
    // "the conjunction matched nothing" is satisfied by a filter that matches
    // nothing at all.
    const bigStorage = await matchedProducts([
      { origin: 'attribute', facetKey: nsKey(ns, 'storage_capacity'), min: 512_000_000_000 },
    ]);
    expect(bigStorage).toBe(1);
    const white = await matchedProducts([
      { origin: 'attribute', facetKey: nsKey(ns, 'phone_color'), values: ['white'] },
    ]);
    expect(white).toBe(1);

    // 512 GB exists only on the Axon and `white` only on the Vero, so no single
    // canonical variant carries both — and the filter says so rather than
    // answering from two variants of two products.
    const both = await matchedProducts([
      { origin: 'attribute', facetKey: nsKey(ns, 'storage_capacity'), min: 512_000_000_000 },
      { origin: 'attribute', facetKey: nsKey(ns, 'phone_color'), values: ['white'] },
    ]);
    expect(both).toBe(0);

    // And a conjunction that IS satisfied by one variant still matches, so the
    // zero above is about the conjunction and not about conjunctions.
    const satisfiable = await matchedProducts([
      { origin: 'attribute', facetKey: nsKey(ns, 'storage_capacity'), min: 512_000_000_000 },
      { origin: 'attribute', facetKey: nsKey(ns, 'phone_color'), values: ['black'] },
    ]);
    expect(satisfiable).toBe(1);
  });
});

describe('the product page', () => {
  it('renders every configuration of the selected model', async () => {
    const result = await readCanonicalProductPage({
      handle: nsSlug(ns, 'lumira-axon-9-pro'),
      comparisonCurrency: 'EUR',
      limit: 20,
      offerComparisonPermitted: true,
    });
    expect(result, 'the product page did not resolve').toBeDefined();
    if (!result) return;
    expect(result.page.product.name).toBe('Lumira Axon 9 Pro');
    expect(result.page.variants).toHaveLength(8);
  });
});
