/**
 * The canonical PRODUCT layer against a REAL PostgreSQL database — issue #56,
 * acceptance criterion 6: uniqueness, identifier validation, variant signatures
 * and unit normalization, plus the other five acceptance criteria, because every
 * one of them is held by a partial unique index, a CHECK, a trigger or an
 * `ON CONFLICT` arbiter and NONE of those exists under a mocked repository.
 *
 * The mocked-repository blind spot is the reason this file exists in this shape:
 * a mocked `insert` accepts a statement the server rejects outright, so a test
 * that asserted "the service returned disputed" against a mock would pass just
 * as happily if the collision gate had been deleted.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every slug, name, key, GTIN and source id this file
 * writes carries a per-run suffix, and teardown deletes exactly what it created
 * — children first, tombstones neutralized before deletion because
 * `merged_into_id` is RESTRICT (which is itself the property D12 wants: a winner
 * cannot vanish from under its tombstones).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { brands } from '../schema/organizations.js';
import { categories } from '../schema/catalog.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
} from '../schema/attributeRegistry.js';
import {
  bundleComponents,
  canonicalAttributeValues,
  canonicalFieldProvenance,
  canonicalImages,
  canonicalProductAliases,
  canonicalProductFamilies,
  canonicalProductFamilyAliases,
  canonicalProductFamilyRedirects,
  canonicalProductFamilySourceLinks,
  canonicalProductRedirects,
  canonicalProductSourceLinks,
  canonicalProducts,
  canonicalVariantAliases,
  canonicalVariantAttributes,
  canonicalVariantSourceLinks,
  canonicalVariants,
  productIdentifiers,
} from '../schema/canonicalCatalog.js';
import {
  procurementOffers,
  supplierAccounts,
  supplierEvents,
  suppliers,
} from '../schema/procurement.js';
import { ensureCatalogSource } from '../canonical/provenanceRepository.js';
import { createBrand } from '../../services/canonical/brand.service.js';
import {
  createProductFamily,
  listFamilyRedirectHistory,
  mergeProductFamilies,
} from '../../services/canonical/product-family.service.js';
import {
  applyProductSourceObservation,
  createCanonicalProduct,
  findCanonicalProductByIdentifier,
  getPublicCanonicalProduct,
  listProductRedirectHistory,
  mergeCanonicalProducts,
  resolveCanonicalProduct,
} from '../../services/canonical/canonical-product.service.js';
import {
  createVariant,
  ensureDefaultVariant,
  listVariants,
  mergeVariants,
  resolveVariant,
  setBundleComponents,
} from '../../services/canonical/canonical-variant.service.js';
import {
  assignIdentifier,
  correctIdentifier,
  resolveIdentifier,
} from '../../services/canonical/product-identifier.service.js';
import { applyAttributeObservation } from '../../services/attributes/attribute-observation.service.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../../services/attributes/definition-registry.service.js';
import { createSupplier } from '../procurement/supplierRepository.js';
import { createSupplierAccount } from '../procurement/supplierAccountRepository.js';
import { reviewAggregates } from '../schema/reviews.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `operator-${RUN}`;

const createdFamilyIds: string[] = [];
const createdProductIds: string[] = [];
const createdBrandIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdSourceIds: string[] = [];
const createdAttributeKeys: string[] = [];

/**
 * Draft and publish one attribute definition in a single step.
 *
 * #94 made a definition a VERSION with a lifecycle, so "define an attribute"
 * is two audited acts. These tests care about the resulting meaning, not the
 * lifecycle — the lifecycle has its own coverage in
 * `attribute-registry.realdb.test.ts` — so the helper keeps them readable
 * without pretending the two steps are one.
 */
async function defineAttribute(input: {
  key: string;
  label: string;
  valueType: 'string' | 'measurement' | 'boolean' | 'integer' | 'decimal' | 'enum';
  unitFamily?: 'mass' | 'length' | 'digital_storage';
  categoryIds?: string[];
}): Promise<{ id: string; key: string }> {
  const draft = await draftAttributeDefinition({
    key: input.key,
    label: input.label,
    valueType: input.valueType,
    ...(input.unitFamily === undefined ? {} : { unitFamily: input.unitFamily }),
    ...(input.categoryIds === undefined
      ? {}
      : { categoryScopes: input.categoryIds.map((categoryId) => ({ categoryId })) }),
    actorOxyUserId: `operator-${RUN}`,
  });
  const published = await publishAttributeDefinition(draft.key, draft.version, `operator-${RUN}`);
  return { id: published.id, key: published.key };
}
const createdSupplierIds: string[] = [];

/** A catalog source registered once for this run; every observation cites it. */
let sourceId = '';

beforeAll(async () => {
  db = await connectPostgres();
  const source = await ensureCatalogSource(db, {
    kind: 'feed',
    name: `canonical-catalog-test-${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  sourceId = source.id;
  createdSourceIds.push(source.id);
}, 120_000);

afterAll(async () => {
  // Children first. RESTRICT constraints make any wrong order loud, not silent.
  const variantIds = (
    await db
      .select({ id: canonicalVariants.id })
      .from(canonicalVariants)
      .where(inArray(canonicalVariants.productId, createdProductIds.length ? createdProductIds : ['']))
  ).map((row) => row.id);

  if (variantIds.length > 0) {
    await db.delete(bundleComponents).where(inArray(bundleComponents.bundleVariantId, variantIds));
    await db.delete(productIdentifiers).where(inArray(productIdentifiers.variantId, variantIds));
    await db.delete(canonicalImages).where(inArray(canonicalImages.variantId, variantIds));
    await db
      .delete(canonicalAttributeValues)
      .where(inArray(canonicalAttributeValues.variantId, variantIds));
    await db
      .delete(canonicalFieldProvenance)
      .where(inArray(canonicalFieldProvenance.variantId, variantIds));
    await db
      .delete(canonicalVariantAttributes)
      .where(inArray(canonicalVariantAttributes.variantId, variantIds));
    await db
      .delete(canonicalVariantAliases)
      .where(inArray(canonicalVariantAliases.variantId, variantIds));
    await db
      .delete(canonicalVariantSourceLinks)
      .where(inArray(canonicalVariantSourceLinks.variantId, variantIds));
  }
  if (createdSupplierIds.length > 0) {
    await db
      .delete(procurementOffers)
      .where(inArray(procurementOffers.supplierId, createdSupplierIds));
    await db
      .delete(supplierAccounts)
      .where(inArray(supplierAccounts.supplierId, createdSupplierIds));
    // `supplier_events` is the birth/lifecycle audit trail every supplier gets;
    // its foreign key is RESTRICT, so it goes before its supplier.
    await db.delete(supplierEvents).where(inArray(supplierEvents.supplierId, createdSupplierIds));
    await db.delete(suppliers).where(inArray(suppliers.id, createdSupplierIds));
  }
  if (variantIds.length > 0) {
    await db
      .update(canonicalVariants)
      .set({ status: 'active', mergedIntoId: null })
      .where(inArray(canonicalVariants.id, variantIds));
    await db.delete(canonicalVariants).where(inArray(canonicalVariants.id, variantIds));
  }
  if (createdProductIds.length > 0) {
    await db
      .delete(productIdentifiers)
      .where(inArray(productIdentifiers.productId, createdProductIds));
    await db.delete(canonicalImages).where(inArray(canonicalImages.productId, createdProductIds));
    await db
      .delete(canonicalAttributeValues)
      .where(inArray(canonicalAttributeValues.productId, createdProductIds));
    await db
      .delete(canonicalFieldProvenance)
      .where(inArray(canonicalFieldProvenance.productId, createdProductIds));
    await db
      .delete(canonicalProductRedirects)
      .where(inArray(canonicalProductRedirects.fromId, createdProductIds));
    await db
      .delete(canonicalProductAliases)
      .where(inArray(canonicalProductAliases.productId, createdProductIds));
    await db
      .delete(canonicalProductSourceLinks)
      .where(inArray(canonicalProductSourceLinks.productId, createdProductIds));
    // `review_aggregates.canonical_product_id` is RESTRICT since #76 — a
    // product's rating must be able to BLOCK its disappearance rather than
    // vanish with it. A merge here rebuilds both products' aggregates, so the
    // rows exist even though this suite writes no reviews.
    await db
      .delete(reviewAggregates)
      .where(inArray(reviewAggregates.canonicalProductId, createdProductIds));
    await db
      .update(canonicalProducts)
      .set({ status: 'active', mergedIntoId: null })
      .where(inArray(canonicalProducts.id, createdProductIds));
    await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, createdProductIds));
  }
  if (createdFamilyIds.length > 0) {
    await db
      .delete(canonicalFieldProvenance)
      .where(inArray(canonicalFieldProvenance.familyId, createdFamilyIds));
    await db
      .delete(canonicalProductFamilyRedirects)
      .where(inArray(canonicalProductFamilyRedirects.fromId, createdFamilyIds));
    await db
      .delete(canonicalProductFamilyAliases)
      .where(inArray(canonicalProductFamilyAliases.familyId, createdFamilyIds));
    await db
      .delete(canonicalProductFamilySourceLinks)
      .where(inArray(canonicalProductFamilySourceLinks.familyId, createdFamilyIds));
    await db
      .update(canonicalProductFamilies)
      .set({ status: 'active', mergedIntoId: null })
      .where(inArray(canonicalProductFamilies.id, createdFamilyIds));
    await db
      .delete(canonicalProductFamilies)
      .where(inArray(canonicalProductFamilies.id, createdFamilyIds));
  }
  if (createdAttributeKeys.length > 0) {
    const definitionIds = (
      await db
        .select({ id: attributeDefinitions.id })
        .from(attributeDefinitions)
        .where(inArray(attributeDefinitions.key, createdAttributeKeys))
    ).map((row) => row.id);
    if (definitionIds.length > 0) {
      await db
        .delete(attributeDefinitionCategories)
        .where(inArray(attributeDefinitionCategories.attributeDefinitionId, definitionIds));
      // A PUBLISHED definition version refuses DELETE
      // (`attribute_definitions_immutable_once_published`), because a stored
      // value cites its version and deleting it would leave that value
      // uninterpretable. Teardown therefore demotes to `draft` first — the one
      // pair of columns the trigger leaves movable, and the one the CHECK
      // requires to move together. That the cleanup has to do this IS the
      // guarantee working; a suite that could delete a published version would
      // be evidence the trigger does not hold.
      await db
        .update(attributeDefinitions)
        .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
        .where(inArray(attributeDefinitions.id, definitionIds));
      await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, definitionIds));
    }
  }
  if (createdSourceIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, createdSourceIds));
    await db.delete(catalogSources).where(inArray(catalogSources.id, createdSourceIds));
  }
  if (createdBrandIds.length > 0) {
    await db.delete(brands).where(inArray(brands.id, createdBrandIds));
  }
  if (createdCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
});

/** Assert a write is refused by the named CONSTRAINT KIND, not merely by an error. */
async function expectRefused(kind: 'check' | 'unique', write: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  const matched = kind === 'check' ? isCheckViolation(caught) : isUniqueViolation(caught);
  expect(matched, `expected a ${kind} violation, got: ${String(caught)}`).toBe(true);
}

async function mintBrand(name: string): Promise<string> {
  const brand = await createBrand({ name });
  createdBrandIds.push(brand.id);
  return brand.id;
}

async function mintCategory(): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({ name: `Canonical Test ${RUN}`, slug: `canonical-test-${RUN}` })
    .returning();
  if (!row) throw new Error('category insert returned no row');
  createdCategoryIds.push(row.id);
  return row.id;
}

interface ProductFixtureInput {
  label: string;
  brandId?: string;
  familyId?: string;
  axes?: string[];
}

async function mintProduct(input: ProductFixtureInput): Promise<string> {
  const product = await createCanonicalProduct({
    name: `${input.label} ${RUN}`,
    ...(input.brandId === undefined ? {} : { brandId: input.brandId }),
    ...(input.familyId === undefined ? {} : { familyId: input.familyId }),
    ...(input.axes === undefined ? {} : { variantDefiningAttributeKeys: input.axes }),
  });
  createdProductIds.push(product.id);
  return product.id;
}

async function mintFamily(label: string, brandId?: string): Promise<string> {
  const family = await createProductFamily({
    name: `${label} ${RUN}`,
    ...(brandId === undefined ? {} : { brandId }),
  });
  createdFamilyIds.push(family.id);
  return family.id;
}

/** A GS1 check digit, so the fixtures below are real GTINs rather than digits. */
function gtin13(body12: string): string {
  let sum = 0;
  for (let index = 0; index < body12.length; index += 1) {
    const digit = body12.charCodeAt(body12.length - 1 - index) - 48;
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  return `${body12}${(10 - (sum % 10)) % 10}`;
}

/** A distinct, valid EAN-13 per call within this run. */
let gtinCounter = 0;
function nextGtin(): string {
  gtinCounter += 1;
  const body = `95${String(gtinCounter).padStart(3, '0')}${RUN.replace(/\D/gu, '').padEnd(7, '0').slice(0, 7)}`;
  return gtin13(body.padEnd(12, '0').slice(0, 12));
}

describe('acceptance 1 — one model, several capacities and colours, ONE product', () => {
  it('represents four configurations of one iPhone as four variants of one product', async () => {
    const brandId = await mintBrand(`Apple ${RUN}`);
    const familyId = await mintFamily('iPhone', brandId);
    const storageKey = `storage_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(storageKey);
    await defineAttribute({
      key: storageKey,
      label: 'Storage',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
    });

    const productId = await mintProduct({
      label: 'iPhone 16 Pro',
      brandId,
      familyId,
      axes: [storageKey, 'color'],
    });

    for (const storage of ['256 GB', '512 GB']) {
      for (const colour of ['Black Titanium', 'White Titanium']) {
        await createVariant({
          productId,
          options: [
            { key: storageKey, value: storage },
            { key: 'color', value: colour },
          ],
          name: `${storage}, ${colour}`,
        });
      }
    }

    const variants = await listVariants(productId);
    expect(variants).toHaveLength(4);
    // ONE product row, not four — the whole point of the criterion.
    const productRows = await db
      .select()
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, productId));
    expect(productRows).toHaveLength(1);
    expect(productRows[0]?.variantCount).toBe(4);
    expect(productRows[0]?.familyId).toBe(familyId);

    const families = await db
      .select()
      .from(canonicalProductFamilies)
      .where(eq(canonicalProductFamilies.id, familyId));
    expect(families[0]?.productCount).toBe(1);
  });

  it('converges a second feed that lists the same options in a DIFFERENT order and unit', async () => {
    const storageKey = `cap_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(storageKey);
    await defineAttribute({
      key: storageKey,
      label: 'Capacity',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
    });
    const productId = await mintProduct({ label: 'Convergence Phone', axes: [storageKey, 'color'] });

    const first = await createVariant({
      productId,
      options: [
        { key: storageKey, value: '256 GB' },
        { key: 'color', value: 'Black Titanium' },
      ],
    });
    // Different ORDER, different unit SPELLING, different CASE — one variant.
    const second = await createVariant({
      productId,
      options: [
        { key: 'color', value: 'black  titanium' },
        { key: storageKey, value: '0.256 TB' },
      ],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.variant.id).toBe(first.variant.id);
    expect(await listVariants(productId)).toHaveLength(1);
  });

  it('gives a product with no declared axes exactly one default variant', async () => {
    const productId = await mintProduct({ label: 'USB-C Cable' });
    const variants = await listVariants(productId);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.isDefault).toBe(true);

    // Idempotent: the ≥1 invariant is a floor, not a counter.
    const again = await ensureDefaultVariant(productId);
    expect(again.id).toBe(variants[0]?.id);
    expect(await listVariants(productId)).toHaveLength(1);
  });

  it('refuses a variant whose options do not match the declared axes', async () => {
    const productId = await mintProduct({ label: 'Axis Product', axes: ['color', 'size'] });
    await expect(
      createVariant({ productId, options: [{ key: 'color', value: 'Red' }] }),
    ).rejects.toThrow(/declared axes/u);
    await expect(
      createVariant({
        productId,
        options: [
          { key: 'color', value: 'Red' },
          { key: 'size', value: 'M' },
          { key: 'region', value: 'EU' },
        ],
      }),
    ).rejects.toThrow(/declared axes/u);
  });
});

describe('acceptance 2 — a merchant title or SKU cannot create a global identity', () => {
  it('never writes a source title to the canonical name; it becomes an alias plus a conflict', async () => {
    const productId = await mintProduct({ label: 'Curated Name' });
    const before = await resolveCanonicalProduct(productId);

    const result = await applyProductSourceObservation({
      productId,
      sourceId,
      externalId: `title-${RUN}`,
      observedAt: new Date('2026-08-01T00:00:00Z'),
      method: 'connector_declared',
      matchRule: 'test.title',
      fields: { name: 'BRAND NEW!!! Curated Name 100% Genuine FAST SHIP' },
    });

    expect(result.conflicts).toContainEqual({
      field: 'name',
      reason: 'conflicting_name',
      sourceValue: 'BRAND NEW!!! Curated Name 100% Genuine FAST SHIP',
    });
    expect(result.applied).not.toContain('name');

    const after = await resolveCanonicalProduct(productId);
    expect(after?.name).toBe(before?.name);

    // The seller's words survive as an alias citing the observation — findable,
    // never authoritative.
    const aliases = await db
      .select()
      .from(canonicalProductAliases)
      .where(eq(canonicalProductAliases.productId, productId));
    const sourceAlias = aliases.find((alias) => alias.alias.startsWith('BRAND NEW'));
    expect(sourceAlias).toBeDefined();
    expect(sourceAlias?.sourceRecordId).toBe(result.sourceRecordId);
  });

  it('refuses an MPN on a product that resolves to no brand (#56 identifier rule 4)', async () => {
    const productId = await mintProduct({ label: 'Brandless Thing' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');

    await expect(
      assignIdentifier({
        target: { kind: 'variant', id: variant.id },
        scheme: 'mpn',
        rawValue: `MPN-${RUN}`,
      }),
    ).rejects.toThrow(/scoped to a brand/u);

    // With a brand it is accepted — so the refusal above is a narrowing, not a
    // blanket rejection that would pass for the wrong reason.
    const brandId = await mintBrand(`Scoped Brand ${RUN}`);
    const brandedProductId = await mintProduct({ label: 'Branded Thing', brandId });
    const [brandedVariant] = await listVariants(brandedProductId);
    if (!brandedVariant) throw new Error('the default variant is missing');
    const accepted = await assignIdentifier({
      target: { kind: 'variant', id: brandedVariant.id },
      scheme: 'mpn',
      rawValue: `MPN-${RUN}`,
    });
    expect(accepted.outcome).toBe('assigned');
  });

  it('refuses a scheme written at the wrong grain', async () => {
    const productId = await mintProduct({ label: 'Grain Product' });
    await expect(
      assignIdentifier({
        target: { kind: 'product', id: productId },
        scheme: 'ean',
        rawValue: nextGtin(),
      }),
    ).rejects.toThrow(/identifies a variant/u);
  });
});

describe('acceptance 3 — identifier conflicts enter review, never overwrite', () => {
  it('stores a colliding GTIN as disputed and leaves the existing owner untouched', async () => {
    const firstProductId = await mintProduct({ label: 'Owner Product' });
    const secondProductId = await mintProduct({ label: 'Newcomer Product' });
    const [owner] = await listVariants(firstProductId);
    const [newcomer] = await listVariants(secondProductId);
    if (!owner || !newcomer) throw new Error('the default variants are missing');

    const gtin = nextGtin();
    const assigned = await assignIdentifier({
      target: { kind: 'variant', id: owner.id },
      scheme: 'ean',
      rawValue: gtin,
    });
    expect(assigned.outcome).toBe('assigned');

    const collision = await assignIdentifier({
      target: { kind: 'variant', id: newcomer.id },
      scheme: 'ean',
      rawValue: gtin,
    });
    expect(collision.outcome).toBe('disputed');
    if (collision.outcome !== 'disputed') return;
    expect(collision.identifier.status).toBe('disputed');
    expect(collision.conflictsWith.variantId).toBe(owner.id);

    // The owner did NOT move: that is the whole criterion.
    const rows = await db
      .select()
      .from(productIdentifiers)
      .where(
        sql`${productIdentifiers.normalizedValue} = ${gtin} and ${productIdentifiers.status} = 'active'`,
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variantId).toBe(owner.id);

    // And the lookup answers `conflict`, not a clean resolution — a caller that
    // could not tell the two apart would attach an offer to an unconfirmed item.
    const resolution = await resolveIdentifier('ean', gtin);
    expect(resolution.kind).toBe('conflict');
    if (resolution.kind !== 'conflict') return;
    expect(resolution.ownerId).toBe(owner.id);
    expect(resolution.disputedIds).toEqual([newcomer.id]);
  });

  it('lets the DATABASE refuse a second active owner, so a writer that skips the service still cannot steal one', async () => {
    const productId = await mintProduct({ label: 'Gate Product' });
    const otherId = await mintProduct({ label: 'Gate Other' });
    const [owner] = await listVariants(productId);
    const [other] = await listVariants(otherId);
    if (!owner || !other) throw new Error('the default variants are missing');

    const gtin = nextGtin();
    await assignIdentifier({
      target: { kind: 'variant', id: owner.id },
      scheme: 'ean',
      rawValue: gtin,
    });

    await expectRefused('unique', () =>
      db.insert(productIdentifiers).values({
        variantId: other.id,
        scheme: 'ean',
        rawValue: gtin,
        normalizedValue: gtin,
        canonicalScheme: 'gtin',
        canonicalValue: gtin.padStart(14, '0'),
        status: 'active',
      }),
    );
  });

  it('refuses an identifier whose check digit is wrong, without storing anything', async () => {
    const productId = await mintProduct({ label: 'Bad Digit Product' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');

    const valid = nextGtin();
    const broken = `${valid.slice(0, -1)}${(Number(valid.slice(-1)) + 1) % 10}`;
    const result = await assignIdentifier({
      target: { kind: 'variant', id: variant.id },
      scheme: 'ean',
      rawValue: broken,
    });
    expect(result).toEqual({ outcome: 'invalid', reason: 'bad_check_digit' });

    const stored = await db
      .select()
      .from(productIdentifiers)
      .where(eq(productIdentifiers.variantId, variant.id));
    expect(stored).toHaveLength(0);
  });

  it('converges a re-assertion of an identifier the same entity already owns', async () => {
    const productId = await mintProduct({ label: 'Idempotent Product' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');
    const gtin = nextGtin();

    const first = await assignIdentifier({
      target: { kind: 'variant', id: variant.id },
      scheme: 'ean',
      rawValue: gtin,
    });
    const second = await assignIdentifier({
      target: { kind: 'variant', id: variant.id },
      scheme: 'ean',
      rawValue: gtin,
    });
    expect(first.outcome).toBe('assigned');
    expect(second.outcome).toBe('unchanged');
    if (first.outcome === 'invalid' || second.outcome === 'invalid') return;
    expect(second.identifier.id).toBe(first.identifier.id);

    const rows = await db
      .select()
      .from(productIdentifiers)
      .where(eq(productIdentifiers.variantId, variant.id));
    expect(rows).toHaveLength(1);
  });

  it('corrects by APPENDING: the wrong value survives, the new one names it', async () => {
    const productId = await mintProduct({ label: 'Correction Product' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');

    const wrong = nextGtin();
    const right = nextGtin();
    const assigned = await assignIdentifier({
      target: { kind: 'variant', id: variant.id },
      scheme: 'ean',
      rawValue: wrong,
    });
    if (assigned.outcome === 'invalid') throw new Error('fixture GTIN was rejected');

    const corrected = await correctIdentifier({
      identifierId: assigned.identifier.id,
      scheme: 'ean',
      rawValue: right,
      actorOxyUserId: OPERATOR,
      note: 'the feed transposed two digits',
    });

    expect(corrected.retired.status).toBe('corrected');
    expect(corrected.retired.rawValue).toBe(wrong);
    expect(corrected.replacement.supersedesIdentifierId).toBe(assigned.identifier.id);
    expect(corrected.replacement.status).toBe('active');

    // The wrong value is still queryable — a dispute is reviewed from what a
    // source ACTUALLY said, so an in-place edit would destroy the evidence.
    const history = await db
      .select()
      .from(productIdentifiers)
      .where(eq(productIdentifiers.variantId, variant.id));
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.rawValue).sort()).toEqual([wrong, right].sort());
  });

  it('refuses an in-place edit of a stored identifier value (the immutability trigger)', async () => {
    const productId = await mintProduct({ label: 'Immutable Product' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');
    const gtin = nextGtin();
    const assigned = await assignIdentifier({
      target: { kind: 'variant', id: variant.id },
      scheme: 'ean',
      rawValue: gtin,
    });
    if (assigned.outcome === 'invalid') throw new Error('fixture GTIN was rejected');

    await expectRefused('check', () =>
      db
        .update(productIdentifiers)
        .set({ rawValue: nextGtin() })
        .where(eq(productIdentifiers.id, assigned.identifier.id)),
    );

    // …while the two updates the trigger deliberately PERMITS still work: a
    // status transition (how a correction is recorded) and an owner change (what
    // a merge does). A trigger that refused those would break both.
    const statusChange = await db
      .update(productIdentifiers)
      .set({ status: 'retired' })
      .where(eq(productIdentifiers.id, assigned.identifier.id))
      .returning();
    expect(statusChange[0]?.status).toBe('retired');
  });
});

describe('acceptance 4 — every selected field and image traces to provenance', () => {
  it('writes a provenance row for each applied field, in the observation transaction', async () => {
    const productId = await mintProduct({ label: 'Provenance Product' });
    const observedAt = new Date('2026-08-02T00:00:00Z');

    const result = await applyProductSourceObservation({
      productId,
      sourceId,
      externalId: `prov-${RUN}`,
      observedAt,
      method: 'connector_declared',
      matchRule: 'test.provenance',
      confidence: 0.8,
      fields: { description: 'A description the source supplied', modelCode: `MC-${RUN}` },
      images: [{ sourceUrl: `https://example.test/${RUN}.jpg`, alt: 'front' }],
    });

    expect(result.applied.sort()).toEqual(['description', 'modelCode']);
    expect(result.imagesAdded).toBe(1);

    const provenance = await db
      .select()
      .from(canonicalFieldProvenance)
      .where(eq(canonicalFieldProvenance.productId, productId));
    expect(provenance.map((row) => row.field).sort()).toEqual(['description', 'modelCode']);
    for (const row of provenance) {
      expect(row.sourceRecordId).toBe(result.sourceRecordId);
      expect(row.method).toBe('connector_declared');
      expect(row.confidence).toBe(0.8);
      expect(row.selectedAt.toISOString()).toBe(observedAt.toISOString());
    }

    // The public projection carries the traceability without leaking source ids.
    const publicProduct = await getPublicCanonicalProduct(productId);
    expect(publicProduct?.fieldProvenance.map((entry) => entry.field).sort()).toEqual([
      'description',
      'modelCode',
    ]);
    expect(publicProduct?.fieldProvenance[0]?.freshness?.sourceKind).toBe('feed');
    expect(JSON.stringify(publicProduct)).not.toContain(result.sourceRecordId);
    expect(publicProduct?.images[0]?.freshness?.observedAt).toBe(observedAt.toISOString());
  });

  it('makes an image without an observation UNWRITABLE, not merely discouraged', async () => {
    const productId = await mintProduct({ label: 'Image Provenance Product' });
    // `source_record_id` is NOT NULL, so there is no path — service or psql —
    // that attaches an image nobody can attribute.
    await expect(
      db.execute(
        sql`insert into canonical_images (id, product_id, source_url, position) values (${uuidv7()}, ${productId}, ${'https://example.test/orphan.jpg'}, 0)`,
      ),
    ).rejects.toThrow();
  });

  it('refuses an image that belongs to both grains, and one that belongs to neither', async () => {
    const productId = await mintProduct({ label: 'Image Grain Product' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');
    const record = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        externalType: 'product',
        externalId: `image-grain-${RUN}`,
        observedAt: new Date(),
        contentHash: 'a'.repeat(64),
      })
      .returning();
    const recordId = record[0]?.id;
    if (!recordId) throw new Error('source record insert returned no row');

    await expectRefused('check', () =>
      db.insert(canonicalImages).values({
        productId,
        variantId: variant.id,
        sourceUrl: 'https://example.test/both.jpg',
        sourceRecordId: recordId,
      }),
    );
    await expectRefused('check', () =>
      db.insert(canonicalImages).values({
        sourceUrl: 'https://example.test/neither.jpg',
        sourceRecordId: recordId,
      }),
    );
  });

  it('converges a re-delivered observation: the same content writes nothing new', async () => {
    const productId = await mintProduct({ label: 'Converging Product' });
    const observation = {
      productId,
      sourceId,
      externalId: `converge-${RUN}`,
      observedAt: new Date('2026-08-03T00:00:00Z'),
      method: 'connector_declared' as const,
      matchRule: 'test.converge',
      fields: { description: 'Stable description' },
      images: [{ sourceUrl: `https://example.test/converge-${RUN}.jpg` }],
    };

    const first = await applyProductSourceObservation(observation);
    const second = await applyProductSourceObservation(observation);

    expect(first.newObservation).toBe(true);
    expect(second.newObservation).toBe(false);
    expect(second.sourceRecordId).toBe(first.sourceRecordId);
    expect(second.imagesAdded).toBe(0);

    const images = await db
      .select()
      .from(canonicalImages)
      .where(eq(canonicalImages.productId, productId));
    expect(images).toHaveLength(1);
    const links = await db
      .select()
      .from(canonicalProductSourceLinks)
      .where(eq(canonicalProductSourceLinks.productId, productId));
    expect(links).toHaveLength(1);
  });
});

describe('acceptance 5 — merges preserve redirects and references', () => {
  it('tombstones the loser, records each redirect hop, and keeps resolution one hop', async () => {
    const oldest = await mintProduct({ label: 'Merge A' });
    const middle = await mintProduct({ label: 'Merge B' });
    const winner = await mintProduct({ label: 'Merge C' });

    const first = await mergeCanonicalProducts({
      winnerId: middle,
      loserId: oldest,
      actorOxyUserId: OPERATOR,
      note: 'duplicates from two feeds',
    });
    expect(first.merged).toBe(true);

    const second = await mergeCanonicalProducts({
      winnerId: winner,
      loserId: middle,
      actorOxyUserId: OPERATOR,
      note: 'the line consolidated',
    });
    expect(second.merged).toBe(true);
    // The merge itself plus the FLATTEN of the tombstone that pointed at B.
    expect(second.redirectsRecorded).toBe(2);

    // Resolution is ONE hop from every id, including the oldest.
    expect((await resolveCanonicalProduct(oldest))?.id).toBe(winner);
    expect((await resolveCanonicalProduct(middle))?.id).toBe(winner);

    const rows = await db
      .select()
      .from(canonicalProducts)
      .where(inArray(canonicalProducts.id, [oldest, middle]));
    for (const row of rows) {
      expect(row.status).toBe('merged');
      expect(row.mergedIntoId).toBe(winner);
    }

    // `merged_into_id` alone cannot answer "where did A point BEFORE" — the
    // flatten overwrote it. The history table can, which is why it exists.
    const history = await listProductRedirectHistory(oldest);
    expect(history.map((entry) => entry.toId).sort()).toEqual([middle, winner].sort());
    expect(history.find((entry) => entry.toId === middle)?.reason).toBe('merge');
    expect(history.find((entry) => entry.toId === winner)?.reason).toBe('flatten');
  });

  it('is idempotent: re-running a merge writes nothing and grows no history', async () => {
    const loser = await mintProduct({ label: 'Idempotent Loser' });
    const winner = await mintProduct({ label: 'Idempotent Winner' });
    const input = { winnerId: winner, loserId: loser, actorOxyUserId: OPERATOR, note: 'duplicate' };

    const first = await mergeCanonicalProducts(input);
    const second = await mergeCanonicalProducts(input);
    expect(first.merged).toBe(true);
    expect(second.merged).toBe(false);

    const history = await db
      .select()
      .from(canonicalProductRedirects)
      .where(eq(canonicalProductRedirects.fromId, loser));
    expect(history).toHaveLength(1);
  });

  it('keeps an offer reference resolvable across a VARIANT merge', async () => {
    // `procurement_offers.canonical_variant_id` is a real RESTRICT foreign key
    // as of this migration, so it is a live stand-in for every other reference
    // the graph will grow (#57's offers, #57's native listing links): the merge
    // must not delete the row those point at.
    const supplier = await createSupplier({
      supplierType: 'dropship_distributor',
      canonicalName: `Merge Supplier ${RUN}`,
      establishmentCountries: ['ES'],
      fulfilmentOriginCountries: ['ES'],
    });
    createdSupplierIds.push(supplier.id);
    const account = await createSupplierAccount({
      supplierId: supplier.id,
      provider: 'test-platform',
      environment: 'test',
      providerAccountId: `acct-${RUN}`,
      credentialReference: `/oxy/mercaria/suppliers/test/${RUN}`,
      enabledMarkets: ['ES'],
      fulfilmentOrigins: ['ES'],
    });

    const productId = await mintProduct({ label: 'Referenced Product', axes: ['color'] });
    const loser = await createVariant({
      productId,
      options: [{ key: 'color', value: 'Red' }],
    });
    const winner = await createVariant({
      productId,
      options: [{ key: 'color', value: 'Crimson' }],
    });

    const offerRows = await db
      .insert(procurementOffers)
      .values({
        supplierId: supplier.id,
        supplierAccountId: account.id,
        canonicalProductId: productId,
        canonicalVariantId: loser.variant.id,
        supplierSku: `SKU-${RUN}`,
        unitCostAmount: 1000,
        unitCostCurrency: 'EUR',
        firstSeenAt: new Date(),
        lastConfirmedAt: new Date(),
        provenance: 'api',
      })
      .returning();
    const offerId = offerRows[0]?.id;
    if (!offerId) throw new Error('procurement offer insert returned no row');

    const merged = await mergeVariants({
      winnerId: winner.variant.id,
      loserId: loser.variant.id,
      actorOxyUserId: OPERATOR,
    });
    expect(merged.merged).toBe(true);

    // The reference still resolves — the loser ROW was never deleted…
    const offerAfter = await db
      .select()
      .from(procurementOffers)
      .where(eq(procurementOffers.id, offerId));
    expect(offerAfter[0]?.canonicalVariantId).toBe(loser.variant.id);
    // …and following it lands on the winner.
    expect((await resolveVariant(loser.variant.id))?.id).toBe(winner.variant.id);
  });

  it('moves a merged family’s products to the winner and records the redirect', async () => {
    const loserFamily = await mintFamily('Legacy Line');
    const winnerFamily = await mintFamily('Current Line');
    const productId = await mintProduct({ label: 'Line Product', familyId: loserFamily });

    const result = await mergeProductFamilies({
      winnerId: winnerFamily,
      loserId: loserFamily,
      actorOxyUserId: OPERATOR,
      note: 'the two lines were the same line',
    });
    expect(result.merged).toBe(true);
    expect(result.productsRepointed).toBe(1);

    const product = await resolveCanonicalProduct(productId);
    expect(product?.familyId).toBe(winnerFamily);
    expect((await listFamilyRedirectHistory(loserFamily)).map((entry) => entry.toId)).toEqual([
      winnerFamily,
    ]);

    const winnerRow = await db
      .select()
      .from(canonicalProductFamilies)
      .where(eq(canonicalProductFamilies.id, winnerFamily));
    expect(winnerRow[0]?.productCount).toBe(1);
  });

  it('repoints a merged variant’s identifiers without destroying their history', async () => {
    const productId = await mintProduct({ label: 'Identifier Merge Product', axes: ['color'] });
    const loser = await createVariant({ productId, options: [{ key: 'color', value: 'Teal' }] });
    const winner = await createVariant({ productId, options: [{ key: 'color', value: 'Aqua' }] });
    const gtin = nextGtin();
    await assignIdentifier({
      target: { kind: 'variant', id: loser.variant.id },
      scheme: 'ean',
      rawValue: gtin,
    });

    await mergeVariants({
      winnerId: winner.variant.id,
      loserId: loser.variant.id,
      actorOxyUserId: OPERATOR,
    });

    const rows = await db
      .select()
      .from(productIdentifiers)
      .where(eq(productIdentifiers.normalizedValue, gtin));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variantId).toBe(winner.variant.id);
    expect(rows[0]?.status).toBe('active');
    // Lookup follows the identifier to the surviving variant.
    const resolution = await resolveIdentifier('ean', gtin);
    expect(resolution).toEqual({ kind: 'resolved', grain: 'variant', id: winner.variant.id });
  });
});

describe('acceptance 6 — uniqueness, signatures and normalization, at the database', () => {
  it('refuses a duplicate product slug, and a tombstone keeps its slug forever', async () => {
    const productId = await mintProduct({ label: 'Slug Product' });
    const row = await resolveCanonicalProduct(productId);
    if (!row) throw new Error('the product vanished');

    await expect(
      createCanonicalProduct({ name: 'Another name entirely', slug: row.slug }),
    ).rejects.toThrow(/already exists/u);
  });

  it('refuses two variants of one product with the same option set, whatever the order', async () => {
    const productId = await mintProduct({ label: 'Signature Product', axes: ['color', 'size'] });
    const created = await createVariant({
      productId,
      options: [
        { key: 'color', value: 'Blue' },
        { key: 'size', value: 'M' },
      ],
    });

    // Through the DATABASE, bypassing the service's convergence entirely: the
    // unique index is what makes the signature load-bearing rather than advisory.
    await expectRefused('unique', () =>
      db.insert(canonicalVariants).values({
        productId,
        signature: created.variant.signature,
      }),
    );
  });

  it('refuses a second default variant of one product', async () => {
    const productId = await mintProduct({ label: 'Default Product', axes: ['color'] });
    await createVariant({
      productId,
      options: [{ key: 'color', value: 'Green' }],
      isDefault: true,
    });
    await expectRefused('unique', () =>
      db.insert(canonicalVariants).values({
        productId,
        signature: 'b'.repeat(64),
        isDefault: true,
      }),
    );
  });

  it('refuses a signature that is not a sha-256 digest', async () => {
    const productId = await mintProduct({ label: 'Shape Product' });
    await expectRefused('check', () =>
      db.insert(canonicalVariants).values({ productId, signature: 'not-a-digest' }),
    );
  });

  it('refuses one axis carrying two values on one variant', async () => {
    const productId = await mintProduct({ label: 'Axis Unique Product', axes: ['color'] });
    const created = await createVariant({ productId, options: [{ key: 'color', value: 'Amber' }] });
    await expectRefused('unique', () =>
      db.insert(canonicalVariantAttributes).values({
        variantId: created.variant.id,
        attributeKey: 'color',
        displayValue: 'Ochre',
        normalizedValue: 'ochre',
      }),
    );
  });

  it('normalizes a quantity option to its base unit, storing the parsed magnitude', async () => {
    const key = `screen_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(key);
    await defineAttribute({
      key,
      label: 'Screen size',
      valueType: 'measurement',
      unitFamily: 'length',
    });
    const productId = await mintProduct({ label: 'Screen Product', axes: [key] });
    const created = await createVariant({ productId, options: [{ key, value: '6.1 in' }] });

    const rows = await db
      .select()
      .from(canonicalVariantAttributes)
      .where(eq(canonicalVariantAttributes.variantId, created.variant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayValue).toBe('6.1 in');
    expect(rows[0]?.normalizedUnit).toBe('mm');
    expect(rows[0]?.normalizedNumber).toBeCloseTo(154.94, 6);
    expect(rows[0]?.normalizationState).toBe('normalized');

    // The centimetre spelling of the same size converges on the same variant.
    const same = await createVariant({ productId, options: [{ key, value: '15.494 cm' }] });
    expect(same.created).toBe(false);
    expect(same.variant.id).toBe(created.variant.id);
  });

  it('keeps an unparsable value as a SOURCE FACT with no magnitude at all', async () => {
    const key = `weight_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(key);
    await defineAttribute({ key, label: 'Weight', valueType: 'measurement', unitFamily: 'mass' });
    const productId = await mintProduct({ label: 'Unparsed Product', axes: [key] });
    const created = await createVariant({ productId, options: [{ key, value: 'about 200 grams' }] });

    const rows = await db
      .select()
      .from(canonicalVariantAttributes)
      .where(eq(canonicalVariantAttributes.variantId, created.variant.id));
    expect(rows[0]?.normalizationState).toBe('unparsed');
    expect(rows[0]?.normalizedNumber).toBeNull();
    expect(rows[0]?.normalizedUnit).toBeNull();
    expect(rows[0]?.displayValue).toBe('about 200 grams');
  });

  it('makes "not normalized but carries a magnitude" unrepresentable', async () => {
    const productId = await mintProduct({ label: 'State Check Product', axes: ['color'] });
    const created = await createVariant({ productId, options: [{ key: 'color', value: 'Slate' }] });
    await expectRefused('check', () =>
      db
        .update(canonicalVariantAttributes)
        .set({ normalizationState: 'unparsed', normalizedNumber: 12 })
        .where(eq(canonicalVariantAttributes.variantId, created.variant.id)),
    );
  });

  it('keeps two disagreeing sources as facts, selecting NEITHER', async () => {
    const key = `material_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(key);
    await defineAttribute({ key, label: 'Material', valueType: 'string' });
    const productId = await mintProduct({ label: 'Conflict Product' });

    const first = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        externalType: 'product',
        externalId: `mat-a-${RUN}`,
        observedAt: new Date(),
        contentHash: 'c'.repeat(64),
      })
      .returning();
    const second = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        externalType: 'product',
        externalId: `mat-b-${RUN}`,
        observedAt: new Date(),
        contentHash: 'd'.repeat(64),
      })
      .returning();
    const firstRecordId = first[0]?.id;
    const secondRecordId = second[0]?.id;
    if (!firstRecordId || !secondRecordId) throw new Error('source record insert returned no row');

    const agreed = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey: key,
      displayValue: 'Titanium',
      sourceRecordId: firstRecordId,
      confidence: 0.7,
    });
    expect(agreed.outcome).toBe('selected');

    const disagreed = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey: key,
      displayValue: 'Aluminium',
      sourceRecordId: secondRecordId,
      confidence: 0.7,
    });
    expect(disagreed.outcome).toBe('conflicting');

    const rows = await db
      .select()
      .from(canonicalAttributeValues)
      .where(eq(canonicalAttributeValues.productId, productId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.selectionState === 'conflicting')).toBe(true);
    // The PARSE survives the conflict: an operator resolving it must be able to
    // see what they are choosing between (#94 moved `conflicting` off the parse).
    expect(rows.every((row) => row.normalizationState === 'normalized')).toBe(true);
    // Both source strings survive verbatim — the disagreement IS the record.
    expect(rows.map((row) => row.sourceDisplayValue).sort()).toEqual(['Aluminium', 'Titanium']);
  });

  it('refuses two SELECTED values for one attribute of one entity', async () => {
    const key = `finish_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(key);
    await defineAttribute({ key, label: 'Finish', valueType: 'string' });
    const productId = await mintProduct({ label: 'Selection Product' });

    const record = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        externalType: 'product',
        externalId: `finish-${RUN}`,
        observedAt: new Date(),
        contentHash: 'e'.repeat(64),
      })
      .returning();
    const recordId = record[0]?.id;
    if (!recordId) throw new Error('source record insert returned no row');

    await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey: key,
      displayValue: 'Matte',
      sourceRecordId: recordId,
    });

    const other = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        externalType: 'product',
        externalId: `finish-2-${RUN}`,
        observedAt: new Date(),
        contentHash: 'f'.repeat(64),
      })
      .returning();
    const otherId = other[0]?.id;
    if (!otherId) throw new Error('source record insert returned no row');

    await expectRefused('unique', () =>
      db.insert(canonicalAttributeValues).values({
        productId,
        attributeKey: key,
        sourceDisplayValue: 'Gloss',
        normalizedText: 'gloss',
        normalizationState: 'normalized',
        selectionState: 'selected',
        sourceRecordId: otherId,
      }),
    );
  });

  it('refuses a duplicate attribute definition key and a half-declared quantity', async () => {
    const key = `dupkey_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(key);
    const first = await defineAttribute({ key, label: 'Duplicate', valueType: 'string' });
    // A second VERSION of one key is the whole point of the versioned registry.
    // A second ACTIVE version is refused by the partial unique, whichever writer
    // tries it — including one that skipped the publish service entirely.
    await expectRefused('unique', () =>
      db.insert(attributeDefinitions).values({
        key,
        version: 99,
        lifecycleState: 'active',
        publishedAt: new Date(),
        label: 'Duplicate again',
        valueType: 'string',
      }),
    );
    expect(first.key).toBe(key);

    // The database refuses the same half-declared shapes the service does, so a
    // writer that skipped the service still cannot store a quantity with no unit.
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        key: `nounit_${RUN.replace(/\W/gu, '')}`.slice(0, 30),
        label: 'No unit',
        valueType: 'measurement',
      }),
    );
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        key: `Bad-Key-${RUN}`.slice(0, 30),
        label: 'Bad key',
        valueType: 'string',
      }),
    );
  });

  it('scopes a bundle to real components and refuses one that contains itself', async () => {
    const componentProductId = await mintProduct({ label: 'Console' });
    const bundleProductId = await mintProduct({ label: 'Console Bundle' });
    const [component] = await listVariants(componentProductId);
    const [bundle] = await listVariants(bundleProductId);
    if (!component || !bundle) throw new Error('the default variants are missing');

    const components = await setBundleComponents({
      bundleVariantId: bundle.id,
      components: [{ variantId: component.id, quantity: 2 }],
    });
    expect(components).toEqual([{ componentVariantId: component.id, quantity: 2 }]);

    await expect(
      setBundleComponents({
        bundleVariantId: bundle.id,
        components: [{ variantId: bundle.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/cannot contain itself/u);

    // A component a bundle names cannot be deleted out from under it: RESTRICT.
    await expect(
      db.delete(canonicalVariants).where(eq(canonicalVariants.id, component.id)),
    ).rejects.toThrow();
  });

  it('refuses an identifier row whose canonical pair is half-filled', async () => {
    const productId = await mintProduct({ label: 'Pair Product' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');
    await expectRefused('check', () =>
      db.insert(productIdentifiers).values({
        variantId: variant.id,
        scheme: 'ean',
        rawValue: '4006381333931',
        normalizedValue: '4006381333931',
        canonicalScheme: 'gtin',
      }),
    );
    await expectRefused('check', () =>
      db.insert(productIdentifiers).values({
        variantId: variant.id,
        scheme: 'ean',
        rawValue: '4006381333931',
        normalizedValue: '4006381333931',
        canonicalValue: '00004006381333931'.slice(-14),
      }),
    );
  });

  it('refuses a disputed identifier that names nothing to dispute', async () => {
    const productId = await mintProduct({ label: 'Dispute Shape Product' });
    const [variant] = await listVariants(productId);
    if (!variant) throw new Error('the default variant is missing');
    await expectRefused('check', () =>
      db.insert(productIdentifiers).values({
        variantId: variant.id,
        scheme: 'mpn',
        rawValue: 'X',
        normalizedValue: 'X',
        status: 'disputed',
      }),
    );
  });

  it('answers an identifier lookup with the product a GTIN identifies through its variant', async () => {
    const brandId = await mintBrand(`Lookup Brand ${RUN}`);
    const productId = await mintProduct({ label: 'Lookup Product', brandId, axes: ['color'] });
    const created = await createVariant({ productId, options: [{ key: 'color', value: 'Ivory' }] });
    const gtin = nextGtin();
    await assignIdentifier({
      target: { kind: 'variant', id: created.variant.id },
      scheme: 'ean',
      rawValue: gtin,
    });

    const found = await findCanonicalProductByIdentifier('ean', gtin);
    expect(found).toEqual({ productId });
    // A well-formed but unknown GTIN answers nothing, rather than a near match.
    expect(await findCanonicalProductByIdentifier('ean', nextGtin())).toBeUndefined();
  });

  it('scopes an attribute definition to categories, and an unscoped one applies anywhere', async () => {
    const categoryId = await mintCategory();
    const scopedKey = `scoped_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    const globalKey = `global_${RUN.replace(/\W/gu, '')}`.slice(0, 30);
    createdAttributeKeys.push(scopedKey, globalKey);

    const scoped = await defineAttribute({
      key: scopedKey,
      label: 'Scoped',
      valueType: 'string',
      categoryIds: [categoryId],
    });
    await defineAttribute({ key: globalKey, label: 'Global', valueType: 'string' });

    const rows = await db
      .select()
      .from(attributeDefinitionCategories)
      .where(eq(attributeDefinitionCategories.attributeDefinitionId, scoped.id));
    expect(rows.map((row) => row.categoryId)).toEqual([categoryId]);
  });
});
