/**
 * The ONE thing that writes a reference vertical package (#367 Workstream 14).
 *
 * ## The posture, and where it comes from
 *
 * `provision-taxonomy.ts`'s: insert-only, idempotent, and a divergent existing
 * row is REPORTED rather than corrected. This seed has no destructive mode, and
 * that is not a switch left off — a "reset this vertical" path would have to
 * delete attribute definitions that have left `draft` (which
 * `mercaria_attribute_definition_immutable` refuses) and canonical products a
 * sibling may already have matched, so the honest reset is a new namespace.
 *
 * ## Dry run is the DEFAULT and it reads the database
 *
 * `--apply` is what writes. Without it every step still runs its EXISTENCE
 * query and reports `create` or `present`, so the plan is a statement about the
 * real database rather than about the package. A dry run that only echoed the
 * fixture would report the same output against a database where half the
 * package already exists and against one where none of it does, which is the
 * measurement failure this whole workstream is written against.
 *
 * ## Why this is not one transaction
 *
 * Three of the services it calls open their own: `createBrand`,
 * `createCanonicalProduct`, `createVariant`, `publishProductTypeVersion`,
 * `draftAttributeDefinition` and `applyAttributeObservation` each take
 * `getDb().transaction(...)`, and nesting a caller's handle into them is not
 * available. So the executor's unit of atomicity is the STEP, which is exactly
 * what idempotency is for: a run interrupted halfway is resumed by running it
 * again, and every step converges.
 *
 * ## What it deliberately does NOT create
 *
 * No store, no listing, no offer, no draft. A reference vertical is a
 * CATALOGUE — taxonomy, attributes, a product type, canonical identity and
 * (for the brake pad) fitment. Merchant commerce state on top of it is what the
 * E2E tests drive, through the real authoring service, because "a merchant can
 * publish against this catalogue" is a behaviour and not a row.
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import {
  findCategoryByKey,
  insertCategory,
  insertCategoryAlias,
} from '../../db/taxonomy/taxonomyRepository.js';
import { normalizeCatalogAlias } from '../../services/taxonomy/alias-normalization.js';
import { assertLocalizedRow } from '../../lib/localized-text.js';
import { upsertCategoryLocalization } from '../../db/catalogLocalization/categoryLocalizationRepository.js';
import { upsertProductTypeLocalization } from '../../db/catalogLocalization/productTypeLocalizationRepository.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
  resolveActiveDefinition,
} from '../../services/attributes/definition-registry.service.js';
import {
  findProductTypeDefinitionByKeyVersion,
  insertProductTypeDefinition,
} from '../../db/productTypes/productTypeRepository.js';
import {
  insertProductTypeCategoryScope,
  insertProductTypeField,
  insertProductTypeFieldGroup,
} from '../../db/productTypes/productTypeFieldRepository.js';
import { publishProductTypeVersion } from '../../services/product-types/product-type.service.js';
import { createBrand } from '../../services/canonical/brand.service.js';
import { findBrandBySlug } from '../../db/canonical/brandRepository.js';
import { createProductFamily } from '../../services/canonical/product-family.service.js';
import { findProductFamilyBySlug } from '../../db/canonical/productFamilyRepository.js';
import { createCanonicalProduct } from '../../services/canonical/canonical-product.service.js';
import { findCanonicalProductBySlug } from '../../db/canonical/canonicalProductRepository.js';
import { createVariant } from '../../services/canonical/canonical-variant.service.js';
import { assignIdentifier } from '../../services/canonical/product-identifier.service.js';
import { applyAttributeObservation } from '../../services/attributes/attribute-observation.service.js';
import { gs1CheckDigit } from '../../services/canonical/identifiers.js';
import {
  ensureCatalogSource,
  recordSourceObservation,
} from '../../db/canonical/provenanceRepository.js';
import {
  upsertVehicleConfiguration,
  upsertVehicleGeneration,
  upsertVehicleMake,
  upsertVehicleModel,
} from '../../db/compatibility/vehicleCatalogRepository.js';
import { openAutomotiveFitment } from '../../db/compatibility/automotiveFitmentRepository.js';
import { recordCompatibilityClaim } from '../../services/compatibility/claim.service.js';
import { attributeEnumValues } from '../../db/schema/attributeRegistry.js';
import { attributeValueLocalizations } from '../../db/schema/catalogLocalization.js';
import type { VerticalPackage } from './types.js';

/* -------------------------------------------------------------------------- */
/* The namespace                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How a package's identity strings are qualified. See `types.ts` for why every
 * one of them must be.
 *
 * The three spellings differ because three CHECKs differ, and getting one wrong
 * is a constraint violation that names the column rather than the mistake:
 * an attribute key is `^[a-z][a-z0-9_]*$` (no dots at the head, underscores
 * only), a category key admits dots and hyphens, and a slug is what a URL
 * carries.
 */
export interface VerticalNamespace {
  /** `v367_footwear` — leads every attribute and product-type key. */
  readonly snake: string;
  /** `v367-footwear` — leads every slug and handle. */
  readonly kebab: string;
}

export function namespaceFor(token: string): VerticalNamespace {
  const cleaned = token
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (cleaned.length === 0 || /^[0-9]/u.test(cleaned)) {
    throw new Error(
      `A vertical namespace must start with a letter and contain [a-z0-9_]; got '${token}'.`,
    );
  }
  return { snake: cleaned, kebab: cleaned.replace(/_/gu, '-') };
}

/** `v367_footwear_shoe_size_eu`. */
export function nsKey(ns: VerticalNamespace, key: string): string {
  return `${ns.snake}_${key}`;
}

/** `v367-footwear.athletic.mens_running_shoes`. */
export function nsCategoryKey(ns: VerticalNamespace, key: string): string {
  return `${ns.kebab}.${key}`;
}

/** `v367-footwear-mens-running-shoes`. */
export function nsSlug(ns: VerticalNamespace, slug: string): string {
  return `${ns.kebab}-${slug}`;
}

/**
 * A valid EAN-13 that belongs to this namespace and to nothing else.
 *
 * A GTIN is the one identity in a package that a PREFIX cannot namespace: it is
 * thirteen digits with a check digit, and it is unique over the whole database
 * because it is unique over the whole world. Measured — applying one package
 * under two namespaces answered `disputed` on every literal EAN, which is the
 * identifier domain working correctly and the fixture being wrong.
 *
 * So the number is derived: GS1 prefix `2` (restricted distribution, the range
 * reserved for numbers that are NOT registered trade items — which is exactly
 * what a fixture's is), nine digits of a namespace digest, a two-digit
 * per-package ordinal, and the GS1 check digit computed by the same function
 * `normalizeIdentifier` validates with.
 */
export function namespacedEan(ns: VerticalNamespace, packageName: string, seed: number): string {
  if (!Number.isInteger(seed) || seed < 0 || seed > 99) {
    throw new Error(`A namespaced GTIN seed is a two-digit ordinal; got ${seed}.`);
  }
  const digest = createHash('sha256').update(`${ns.snake}:${packageName}`).digest('hex');
  const scrambled = (BigInt(`0x${digest.slice(0, 12)}`) % 1_000_000_000n)
    .toString()
    .padStart(9, '0');
  const payload = `2${scrambled}${String(seed).padStart(2, '0')}`;
  return `${payload}${gs1CheckDigit(payload)}`;
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

/** What one step did, or would do. */
export type SeedStepOutcome =
  /** The row was absent; created (or, in a dry run, would be). */
  | 'create'
  /** The row was already there and agrees. Nothing written. */
  | 'present'
  /**
   * The row is there and DISAGREES with the package.
   *
   * Reported and never corrected, `provision-taxonomy.ts`'s ruling: the seed
   * has no authority to overwrite a decision somebody made in the database,
   * and a silent correction is how a hand-fixed category name comes back.
   */
  | 'divergent';

export interface SeedStep {
  readonly entity: string;
  readonly identity: string;
  readonly outcome: SeedStepOutcome;
  readonly detail?: string;
}

export interface SeedReport {
  readonly packageName: string;
  readonly namespace: VerticalNamespace;
  readonly applied: boolean;
  readonly steps: readonly SeedStep[];
  readonly created: number;
  readonly present: number;
  readonly divergent: number;
}

/** Everything a caller needs to find what an apply wrote, without re-deriving keys. */
export interface SeedHandles {
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly categoryIds: ReadonlyMap<string, string>;
  readonly attributeIds: ReadonlyMap<string, string>;
  readonly attributeVersions: ReadonlyMap<string, number>;
  readonly enumValueIds: ReadonlyMap<string, string>;
  readonly productTypeIds: ReadonlyMap<string, string>;
  readonly brandIds: ReadonlyMap<string, string>;
  readonly familyIds: ReadonlyMap<string, string>;
  readonly productIds: ReadonlyMap<string, string>;
  readonly variantIds: ReadonlyMap<string, string>;
  readonly vehicleMakeIds: ReadonlyMap<string, string>;
  readonly vehicleModelIds: ReadonlyMap<string, string>;
  readonly vehicleGenerationIds: ReadonlyMap<string, string>;
  readonly vehicleConfigurationIds: ReadonlyMap<string, string>;
}

export interface SeedResult {
  readonly report: SeedReport;
  /** Present only after a real apply — a dry run resolves no ids it did not find. */
  readonly handles: SeedHandles;
}

export interface ApplyOptions {
  /** Writes only when true. The default reads and reports. */
  readonly apply: boolean;
  /** Overrides the package's own name as the identity prefix. Tests pass a per-run token. */
  readonly namespace?: string;
  /** Stamped on everything this run authors. */
  readonly actorOxyUserId: string;
}

/* -------------------------------------------------------------------------- */
/* The executor                                                                */
/* -------------------------------------------------------------------------- */

class Recorder {
  readonly steps: SeedStep[] = [];

  record(entity: string, identity: string, outcome: SeedStepOutcome, detail?: string): void {
    this.steps.push(detail === undefined ? { entity, identity, outcome } : { entity, identity, outcome, detail });
  }
}

/**
 * Apply one package.
 *
 * Order is forced by the real foreign keys and by two triggers, and a caller
 * cannot vary it: categories before the attribute scopes that reference them,
 * attribute definitions before the product-type fields that CITE them
 * (`mercaria_product_type_field_citation` resolves `(id, key, version)` and
 * refuses a mismatch), every product-type CHILD before publication
 * (`mercaria_product_type_child_frozen` refuses a child write once the parent
 * has left `draft`/`review`), and every attribute CHILD before publication
 * (`mercaria_attribute_enum_frozen`, same shape one domain over).
 */
export async function applyVerticalPackage(
  pkg: VerticalPackage,
  options: ApplyOptions,
  database: Database = getDb(),
): Promise<SeedResult> {
  const ns = namespaceFor(options.namespace ?? pkg.name);
  const rec = new Recorder();
  const db: DatabaseOrTransaction = database;

  const categoryIds = new Map<string, string>();
  const attributeIds = new Map<string, string>();
  const attributeVersions = new Map<string, number>();
  const enumValueIds = new Map<string, string>();
  const productTypeIds = new Map<string, string>();
  const brandIds = new Map<string, string>();
  const familyIds = new Map<string, string>();
  const productIds = new Map<string, string>();
  const variantIds = new Map<string, string>();
  const vehicleMakeIds = new Map<string, string>();
  const vehicleModelIds = new Map<string, string>();
  const vehicleGenerationIds = new Map<string, string>();
  const vehicleConfigurationIds = new Map<string, string>();

  /* ---------------------------------------------------------------- source */
  // Operator entry IS a `catalog_sources` row (ADR 0002 D19): every fact this
  // package records is an observation with provenance, and there is no
  // source-less case. `may_store` is false — the payload is the package in this
  // repository, and a copy of it in a jsonb column would be a second one.
  const sourceName = `${ns.kebab}: ${pkg.sourceName}`;
  let sourceId = '';
  let sourceRecordId = '';
  if (options.apply) {
    const source = await ensureCatalogSource(db, {
      kind: 'operator',
      name: sourceName,
      mayDisplay: true,
      mayStore: false,
      attributionRequired: false,
      rightsNote: 'Mercaria reference vertical package (#367 Workstream 14).',
    });
    sourceId = source.id;
    const observation = await recordSourceObservation(db, {
      sourceId: source.id,
      externalType: 'product',
      externalId: `${ns.snake}:reference-package`,
      observedAt: new Date(),
      contentHash: createHash('sha256').update(`${ns.snake}:${pkg.name}`).digest('hex'),
    });
    sourceRecordId = observation.record.id;
    rec.record('catalog_source', sourceName, observation.inserted ? 'create' : 'present');
  } else {
    rec.record('catalog_source', sourceName, 'create', 'dry run: not resolved');
  }

  /* ------------------------------------------------------------ categories */
  for (const category of pkg.categories) {
    const key = nsCategoryKey(ns, category.key);
    const slug = nsSlug(ns, category.slug);
    const existing = await findCategoryByKey(key, db);
    if (existing) {
      categoryIds.set(category.key, existing.id);
      const agrees =
        existing.slug === slug &&
        existing.selectable === category.selectable &&
        existing.name === category.name;
      rec.record(
        'category',
        key,
        agrees ? 'present' : 'divergent',
        agrees
          ? undefined
          : `stored (name='${existing.name}', slug='${existing.slug}', selectable=${existing.selectable}) ` +
            `differs from the package (name='${category.name}', slug='${slug}', selectable=${category.selectable})`,
      );
      continue;
    }
    rec.record('category', key, 'create');
    if (!options.apply) continue;

    const parentId =
      category.parentKey === null ? null : (categoryIds.get(category.parentKey) ?? null);
    if (category.parentKey !== null && parentId === null) {
      throw new Error(
        `Category '${category.key}' names parent '${category.parentKey}', which the package does not declare before it.`,
      );
    }
    const row = await insertCategory(
      {
        key,
        name: category.name,
        slug,
        parentId,
        selectable: category.selectable,
        position: category.position,
        lifecycle: 'published',
      },
      db,
    );
    categoryIds.set(category.key, row.id);

    for (const localization of category.localizations) {
      await upsertCategoryLocalization(
        {
          categoryId: row.id,
          locale: localization.locale,
          status: 'approved',
          provenance: 'mercaria',
          name: localization.name,
          description: localization.description ?? null,
          sourceLocale: 'en',
          reviewedByOxyUserId: options.actorOxyUserId,
          reviewedAt: new Date(),
        },
        db,
      );
    }
    for (const alias of category.aliases) {
      await insertCategoryAlias(
        {
          categoryId: row.id,
          locale: alias.locale,
          alias: alias.alias,
          // `normalizeCatalogAlias`, not `trim().toLowerCase()`: the read side
          // compares in the accent-FOLDED space, so a bare lowercase write
          // stores `móviles` where the lookup asks for `moviles` and the row
          // resolves for nobody. One normalization, stated in one module.
          normalizedAlias: normalizeCatalogAlias(alias.alias),
          kind: alias.kind,
        },
        db,
      );
    }
  }

  /* ------------------------------------------------------------ attributes */
  for (const attribute of pkg.attributes) {
    const key = nsKey(ns, attribute.key);
    const active = await resolveActiveDefinition(db, key);
    if (active) {
      attributeIds.set(attribute.key, active.row.id);
      attributeVersions.set(attribute.key, active.row.version);
      for (const value of active.enumValues) enumValueIds.set(`${attribute.key}:${value.value}`, value.id);
      const agrees =
        active.row.valueType === attribute.valueType &&
        active.row.variantDefining === (attribute.variantDefining ?? false);
      rec.record(
        'attribute',
        key,
        agrees ? 'present' : 'divergent',
        agrees
          ? undefined
          : `stored (valueType='${active.row.valueType}', variantDefining=${active.row.variantDefining}) ` +
            `differs from the package (valueType='${attribute.valueType}', variantDefining=${attribute.variantDefining ?? false})`,
      );
      continue;
    }
    rec.record('attribute', key, 'create');
    if (!options.apply) continue;

    // Every child rides the DRAFT transaction. `mercaria_attribute_enum_frozen`
    // refuses an enum value or an alias once the parent has left `draft`, so a
    // colour added after publication is a new VERSION and never an edit — which
    // is the whole of "make schema versions immutable after publication".
    const drafted = await draftAttributeDefinition({
      key,
      label: attribute.label,
      ...(attribute.description === undefined ? {} : { description: attribute.description }),
      valueType: attribute.valueType,
      ...(attribute.cardinality === undefined ? {} : { cardinality: attribute.cardinality }),
      ...(attribute.unitFamily === undefined ? {} : { unitFamily: attribute.unitFamily }),
      ...(attribute.componentAxes === undefined
        ? {}
        : { componentAxes: [...attribute.componentAxes] }),
      ...(attribute.decimalPlaces === undefined ? {} : { decimalPlaces: attribute.decimalPlaces }),
      ...(attribute.minValue === undefined ? {} : { minValue: attribute.minValue }),
      ...(attribute.maxValue === undefined ? {} : { maxValue: attribute.maxValue }),
      ...(attribute.variantDefining === undefined
        ? {}
        : { variantDefining: attribute.variantDefining }),
      ...(attribute.filterable === undefined ? {} : { filterable: attribute.filterable }),
      ...(attribute.sortable === undefined ? {} : { sortable: attribute.sortable }),
      ...(attribute.comparable === undefined ? {} : { comparable: attribute.comparable }),
      ...(attribute.hardConstraintCapable === undefined
        ? {}
        : { hardConstraintCapable: attribute.hardConstraintCapable }),
      ...(attribute.enumValues === undefined
        ? {}
        : {
            enumValues: attribute.enumValues.map((value) => ({
              value: value.value,
              label: value.label,
              ...(value.aliases === undefined ? {} : { aliases: [...value.aliases] }),
            })),
          }),
      ...(attribute.labels === undefined ? {} : { labels: attribute.labels.map((l) => ({ ...l })) }),
      ...(attribute.categoryScopeKeys === undefined
        ? {}
        : {
            categoryScopes: attribute.categoryScopeKeys.map((categoryKey) => {
              const id = categoryIds.get(categoryKey);
              if (id === undefined) {
                throw new Error(
                  `Attribute '${attribute.key}' is scoped to category '${categoryKey}', which the package does not declare.`,
                );
              }
              return { categoryId: id, includeDescendants: true };
            }),
          }),
      actorOxyUserId: options.actorOxyUserId,
    });
    await publishAttributeDefinition(key, drafted.version, options.actorOxyUserId);

    const published = await resolveActiveDefinition(db, key);
    if (!published) {
      throw new Error(`Attribute '${key}' was published and did not resolve as active.`);
    }
    attributeIds.set(attribute.key, published.row.id);
    attributeVersions.set(attribute.key, published.row.version);
    for (const value of published.enumValues) {
      enumValueIds.set(`${attribute.key}:${value.value}`, value.id);
    }

    // `attribute_value_localizations` has no repository — nothing in the
    // codebase writes it, and `read.service.ts` is its only reader. Writing it
    // here is deliberate rather than an omission somebody should fix later: a
    // controlled value whose LABEL cannot be translated is a filter pill that
    // says `black` in every market, which is exactly the cross-language
    // fragmentation Workstream 2 exists to end. Every column the family's nine
    // CHECKs demand is stated (never the base locale, `approved` implies a
    // reviewer, a reviewed row implies a timestamp).
    for (const value of attribute.enumValues ?? []) {
      for (const localization of value.localizations ?? []) {
        const enumValueId = enumValueIds.get(`${attribute.key}:${value.value}`);
        if (enumValueId === undefined) continue;
        await db
          .insert(attributeValueLocalizations)
          .values({
            attributeEnumValueId: enumValueId,
            locale: localization.locale,
            status: 'approved',
            provenance: 'mercaria',
            sourceLocale: 'en',
            // The declaration, applied where the WRITE is (#367 line 187). The
            // text is a code constant rather than a request body, so there is no
            // request schema to attach it to — this IS the boundary for this
            // table. It writes `label` and not `description`, which is exactly
            // why the check takes a ROW rather than a column list.
            ...assertLocalizedRow('attribute_value_localizations', {
              label: localization.label,
            }),
            reviewedByOxyUserId: options.actorOxyUserId,
            reviewedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [
              attributeValueLocalizations.attributeEnumValueId,
              attributeValueLocalizations.locale,
            ],
          });
      }
    }
  }

  /* ---------------------------------------------------------- product types */
  for (const productType of pkg.productTypes) {
    const key = nsKey(ns, productType.key);
    const existing = await findProductTypeDefinitionByKeyVersion(db, key, productType.version);
    if (existing) {
      productTypeIds.set(productType.key, existing.id);
      rec.record(
        'product_type',
        `${key}@${productType.version}`,
        existing.lifecycle === 'published' ? 'present' : 'divergent',
        existing.lifecycle === 'published'
          ? undefined
          : `stored lifecycle is '${existing.lifecycle}'; the package expects a published version`,
      );
      continue;
    }
    rec.record('product_type', `${key}@${productType.version}`, 'create');
    if (!options.apply) continue;

    const definition = await insertProductTypeDefinition(db, {
      key,
      version: productType.version,
      name: productType.name,
      description: productType.description,
      pendingProposalPolicy: 'block_publication',
      createdByOxyUserId: options.actorOxyUserId,
    });
    productTypeIds.set(productType.key, definition.id);

    const groupIds = new Map<string, string>();
    for (const group of productType.groups) {
      const row = await insertProductTypeFieldGroup(db, {
        productTypeDefinitionId: definition.id,
        key: group.key,
        label: group.label,
        position: group.position,
      });
      groupIds.set(group.key, row.id);
    }

    for (const field of productType.fields) {
      const attributeDefinitionId = attributeIds.get(field.attributeKey);
      const attributeDefinitionVersion = attributeVersions.get(field.attributeKey);
      if (attributeDefinitionId === undefined || attributeDefinitionVersion === undefined) {
        throw new Error(
          `Product type '${productType.key}' cites attribute '${field.attributeKey}', which the package does not declare before it.`,
        );
      }
      await insertProductTypeField(db, {
        productTypeDefinitionId: definition.id,
        groupId: field.groupKey === undefined ? null : (groupIds.get(field.groupKey) ?? null),
        attributeDefinitionId,
        attributeKey: nsKey(ns, field.attributeKey),
        attributeDefinitionVersion,
        scope: field.scope,
        flow: field.flow,
        requirement: field.requirement,
        valuePolicy: field.valuePolicy,
        variantCapable: field.variantCapable ?? false,
        position: field.position,
      });
    }

    for (const categoryKey of productType.categoryScopeKeys) {
      const categoryId = categoryIds.get(categoryKey);
      if (categoryId === undefined) {
        throw new Error(
          `Product type '${productType.key}' is scoped to category '${categoryKey}', which the package does not declare.`,
        );
      }
      await insertProductTypeCategoryScope(db, {
        productTypeDefinitionId: definition.id,
        categoryId,
        includeDescendants: true,
      });
    }

    for (const localization of productType.localizations) {
      await upsertProductTypeLocalization(
        {
          productTypeDefinitionId: definition.id,
          locale: localization.locale,
          status: 'approved',
          provenance: 'mercaria',
          name: localization.name,
          description: localization.description ?? null,
          helpText: localization.helpText ?? null,
          sourceLocale: 'en',
          reviewedByOxyUserId: options.actorOxyUserId,
          reviewedAt: new Date(),
        },
        db,
      );
    }

    // Publication is the LAST step and it can refuse — for zero category
    // scopes, zero fields, a variant-axis violation or a visibility rule naming
    // a field the flow does not declare. It returns a discriminated union and
    // throws nothing, so a seed that ignored the outcome would leave a `draft`
    // version behind and report success.
    const publication = await publishProductTypeVersion(database, {
      definitionId: definition.id,
      publishedByOxyUserId: options.actorOxyUserId,
    });
    if (publication.outcome === 'refused') {
      throw new Error(
        `Product type '${key}@${productType.version}' was refused publication: ${publication.refusal} — ${publication.detail}`,
      );
    }
  }

  /* ---------------------------------------------------------------- brands */
  for (const brand of pkg.brands) {
    const slug = nsSlug(ns, brand.slug);
    const existing = await findBrandBySlug(db, slug);
    if (existing) {
      brandIds.set(brand.key, existing.id);
      rec.record('brand', slug, 'present');
      continue;
    }
    rec.record('brand', slug, 'create');
    if (!options.apply) continue;
    const row = await createBrand({
      name: brand.name,
      slug,
      ...(brand.websiteUrl === undefined ? {} : { websiteUrl: brand.websiteUrl }),
      ...(brand.aliases === undefined ? {} : { aliases: brand.aliases.map((a) => ({ ...a })) }),
      actorOxyUserId: options.actorOxyUserId,
    });
    brandIds.set(brand.key, row.id);
  }

  /* -------------------------------------------------------------- families */
  for (const family of pkg.families) {
    const slug = nsSlug(ns, family.slug);
    const existing = await findProductFamilyBySlug(db, slug);
    if (existing) {
      familyIds.set(family.key, existing.id);
      rec.record('product_family', slug, 'present');
      continue;
    }
    rec.record('product_family', slug, 'create');
    if (!options.apply) continue;
    const brandId = requireHandle(brandIds, family.brandKey, 'brand', family.key);
    const categoryId = requireHandle(categoryIds, family.categoryKey, 'category', family.key);
    const row = await createProductFamily({
      name: family.name,
      slug,
      brandId,
      categoryId,
      actorOxyUserId: options.actorOxyUserId,
    });
    familyIds.set(family.key, row.id);
  }

  /* -------------------------------------------------------------- products */
  for (const product of pkg.products) {
    const slug = nsSlug(ns, product.slug);
    const existing = await findCanonicalProductBySlug(db, slug);
    let productId: string;
    if (existing) {
      productId = existing.id;
      productIds.set(product.key, existing.id);
      rec.record('canonical_product', slug, 'present');
    } else {
      rec.record('canonical_product', slug, 'create');
      if (!options.apply) {
        // A dry run cannot resolve a variant it has not created, so it reports
        // the package's own counts rather than skipping the product silently.
        // A plan that stops at the product would tell an operator a package is
        // 23 rows when it is 23 plus 16 variants plus 86 facts.
        for (const variant of product.variants) {
          rec.record('canonical_variant', variant.key, 'create');
          for (const identifier of variant.identifiers ?? []) {
            rec.record(
              'product_identifier',
              `${variant.key}/${identifier.scheme}:${
                identifier.kind === 'literal'
                  ? identifier.rawValue
                  : namespacedEan(ns, pkg.name, identifier.seed)
              }`,
              'create',
            );
          }
          for (const fact of variant.facts ?? []) {
            rec.record('attribute_fact', `${variant.key}/${fact.attributeKey}`, 'create');
          }
        }
        for (const fact of product.facts ?? []) {
          rec.record('attribute_fact', `${product.key}/${fact.attributeKey}`, 'create');
        }
        continue;
      }
      const brandId = requireHandle(brandIds, product.brandKey, 'brand', product.key);
      const categoryId = requireHandle(categoryIds, product.categoryKey, 'category', product.key);
      const row = await createCanonicalProduct({
        name: product.name,
        slug,
        brandId,
        categoryId,
        ...(product.familyKey === undefined
          ? {}
          : { familyId: requireHandle(familyIds, product.familyKey, 'family', product.key) }),
        ...(product.modelYear === undefined ? {} : { modelYear: product.modelYear }),
        variantDefiningAttributeKeys: product.variantAxisKeys.map((key) => nsKey(ns, key)),
        ...(product.searchTokens === undefined ? {} : { searchTokens: [...product.searchTokens] }),
        ...(product.aliases === undefined
          ? {}
          : { aliases: product.aliases.map((a) => ({ ...a })) }),
        actorOxyUserId: options.actorOxyUserId,
      });
      productId = row.id;
      productIds.set(product.key, row.id);
    }

    if (!options.apply) continue;

    for (const fact of product.facts ?? []) {
      await recordFact(rec, {
        grain: { kind: 'product', id: productId },
        attributeKey: nsKey(ns, fact.attributeKey),
        displayValue: fact.displayValue,
        sourceRecordId,
        catalogSourceId: sourceId,
        ...(fact.sourceField === undefined ? {} : { sourceField: fact.sourceField }),
        identity: `${product.key}/${fact.attributeKey}`,
      });
    }

    for (const variant of product.variants) {
      const created = await createVariant({
        productId,
        options: variant.options.map((option) => ({
          key: nsKey(ns, option.key),
          value: option.value,
        })),
        actorOxyUserId: options.actorOxyUserId,
      });
      variantIds.set(variant.key, created.variant.id);
      rec.record('canonical_variant', variant.key, created.created ? 'create' : 'present');

      for (const identifier of variant.identifiers ?? []) {
        const rawValue =
          identifier.kind === 'literal'
            ? identifier.rawValue
            : namespacedEan(ns, pkg.name, identifier.seed);
        const outcome = await assignIdentifier({
          target: { kind: 'variant', id: created.variant.id },
          scheme: identifier.scheme,
          rawValue,
          sourceRecordId,
          assignedByOxyUserId: options.actorOxyUserId,
        });
        rec.record(
          'product_identifier',
          `${variant.key}/${identifier.scheme}:${rawValue}`,
          outcome.outcome === 'assigned'
            ? 'create'
            : outcome.outcome === 'unchanged'
              ? 'present'
              : 'divergent',
          outcome.outcome === 'invalid'
            ? `refused: ${outcome.reason}`
            : outcome.outcome === 'disputed'
              ? 'the identifier is already claimed by another variant'
              : undefined,
        );
      }

      for (const fact of variant.facts ?? []) {
        await recordFact(rec, {
          grain: { kind: 'variant', id: created.variant.id },
          attributeKey: nsKey(ns, fact.attributeKey),
          displayValue: fact.displayValue,
          sourceRecordId,
          catalogSourceId: sourceId,
          ...(fact.sourceField === undefined ? {} : { sourceField: fact.sourceField }),
          identity: `${variant.key}/${fact.attributeKey}`,
        });
      }
    }
  }

  /* -------------------------------------------------------------- vehicles */
  for (const make of pkg.vehicleMakes) {
    const makeKey = nsKey(ns, make.key);
    const existingMake = await db.execute<{ id: string }>(
      sql`select id from vehicle_makes where key = ${makeKey} limit 1`,
    );
    const priorMakeId = [...existingMake][0]?.id;
    rec.record('vehicle_make', makeKey, priorMakeId === undefined ? 'create' : 'present');
    if (!options.apply) continue;
    const makeRow = await upsertVehicleMake(
      {
        key: makeKey,
        name: make.name,
        ...(make.countryCode === undefined ? {} : { countryCode: make.countryCode }),
      },
      db,
    );
    vehicleMakeIds.set(make.key, makeRow.id);

    for (const model of make.models) {
      const modelRow = await upsertVehicleModel(
        { makeId: makeRow.id, key: nsKey(ns, model.key), name: model.name },
        db,
      );
      vehicleModelIds.set(model.key, modelRow.id);

      for (const generation of model.generations) {
        const generationRow = await upsertVehicleGeneration(
          {
            modelId: modelRow.id,
            key: nsKey(ns, generation.key),
            name: generation.name,
            ...(generation.chassisCode === undefined ? {} : { chassisCode: generation.chassisCode }),
            ...(generation.producedFromYear === undefined
              ? {}
              : { producedFromYear: generation.producedFromYear }),
            ...(generation.producedToYear === undefined
              ? {}
              : { producedToYear: generation.producedToYear }),
          },
          db,
        );
        vehicleGenerationIds.set(generation.key, generationRow.id);

        for (const configuration of generation.configurations) {
          const configurationRow = await upsertVehicleConfiguration(
            {
              generationId: generationRow.id,
              key: nsKey(ns, configuration.key),
              name: configuration.name,
              ...(configuration.yearFrom === undefined ? {} : { yearFrom: configuration.yearFrom }),
              ...(configuration.yearTo === undefined ? {} : { yearTo: configuration.yearTo }),
              ...(configuration.engineCode === undefined
                ? {}
                : { engineCode: configuration.engineCode }),
              ...(configuration.engineDisplacementCc === undefined
                ? {}
                : { engineDisplacementCc: configuration.engineDisplacementCc }),
              ...(configuration.powerKw === undefined ? {} : { powerKw: configuration.powerKw }),
              ...(configuration.fuelType === undefined ? {} : { fuelType: configuration.fuelType }),
              ...(configuration.drivetrain === undefined
                ? {}
                : { drivetrain: configuration.drivetrain }),
              ...(configuration.transmission === undefined
                ? {}
                : { transmission: configuration.transmission }),
              ...(configuration.bodyStyle === undefined
                ? {}
                : { bodyStyle: configuration.bodyStyle }),
              ...(configuration.doors === undefined ? {} : { doors: configuration.doors }),
              ...(configuration.trim === undefined ? {} : { trim: configuration.trim }),
              ...(configuration.market === undefined ? {} : { market: configuration.market }),
            },
            db,
          );
          vehicleConfigurationIds.set(configuration.key, configurationRow.id);
          rec.record(
            'vehicle_configuration',
            configuration.key,
            priorMakeId === undefined ? 'create' : 'present',
          );
        }
      }
    }
  }

  /* -------------------------------------------------------------- fitments */
  for (const fitment of pkg.fitments) {
    const identity = `${fitment.variantKey}@${fitment.configurationKey ?? fitment.generationKey ?? fitment.modelKey ?? fitment.makeKey}/${fitment.position}`;
    if (!options.apply) {
      rec.record('automotive_fitment', identity, 'create');
      continue;
    }
    const variantId = requireHandle(variantIds, fitment.variantKey, 'variant', 'fitment');
    // `openAutomotiveFitment` is `ON CONFLICT DO NOTHING` on the open
    // `fitment_key`, then reads the conflicting row back — so a re-run
    // converges and the count before/after is what tells `create` from
    // `present`. The key includes `position` and excludes `qualifiers`, which
    // is why two rows for one vehicle at front and rear are two fitments and
    // two rows differing only in a qualifier are one.
    const before = await db.execute<{ total: number }>(
      sql`select count(*)::int as total from automotive_fitments where subject_variant_id = ${variantId} and valid_to is null`,
    );
    const priorFitments = [...before][0]?.total ?? 0;
    await openAutomotiveFitment(
      {
        subjectVariantId: variantId,
        scope: fitment.scope,
        vehicleMakeId: requireHandle(vehicleMakeIds, fitment.makeKey, 'vehicle make', 'fitment'),
        ...(fitment.modelKey === undefined
          ? {}
          : { vehicleModelId: requireHandle(vehicleModelIds, fitment.modelKey, 'vehicle model', 'fitment') }),
        ...(fitment.generationKey === undefined
          ? {}
          : {
              vehicleGenerationId: requireHandle(
                vehicleGenerationIds,
                fitment.generationKey,
                'vehicle generation',
                'fitment',
              ),
            }),
        ...(fitment.configurationKey === undefined
          ? {}
          : {
              vehicleConfigurationId: requireHandle(
                vehicleConfigurationIds,
                fitment.configurationKey,
                'vehicle configuration',
                'fitment',
              ),
            }),
        applicability: fitment.applicability,
        position: fitment.position,
        ...(fitment.qualifiers === undefined ? {} : { qualifiers: [...fitment.qualifiers] }),
        ...(fitment.conditionNote === undefined ? {} : { conditionNote: fitment.conditionNote }),
        ...(fitment.yearFrom === undefined ? {} : { yearFrom: fitment.yearFrom }),
        ...(fitment.yearTo === undefined ? {} : { yearTo: fitment.yearTo }),
        ...(fitment.quantityPerVehicle === undefined
          ? {}
          : { quantityPerVehicle: fitment.quantityPerVehicle }),
        verification: fitment.verification,
        ...(fitment.verificationMethod === undefined
          ? {}
          : { verificationMethod: fitment.verificationMethod }),
        ...(fitment.manufacturerReference === undefined
          ? {}
          : { manufacturerReference: fitment.manufacturerReference }),
        ...(fitment.manufacturerPublicationUrl === undefined
          ? {}
          : { manufacturerPublicationUrl: fitment.manufacturerPublicationUrl }),
        ...(fitment.contentSha256 === undefined ? {} : { contentSha256: fitment.contentSha256 }),
        assertedByKind: 'operator',
        // A POSITIVE fit is published only when verified, and a verified row
        // needs all three audit columns by CHECK. A NEGATIVE one is published
        // from `candidate` too — the asymmetry is `POSITIVE_VERIFICATIONS` vs
        // `NEGATIVE_VERIFICATIONS`, and it is why an exclusion bites immediately.
        ...(fitment.verification === 'verified'
          ? { verifiedAt: new Date(), verifiedByOxyUserId: options.actorOxyUserId }
          : {}),
        observedAt: new Date(),
      },
      db,
    );
    const after = await db.execute<{ total: number }>(
      sql`select count(*)::int as total from automotive_fitments where subject_variant_id = ${variantId} and valid_to is null`,
    );
    const nowFitments = [...after][0]?.total ?? 0;
    rec.record('automotive_fitment', identity, nowFitments > priorFitments ? 'create' : 'present');
  }

  /* ----------------------------------------------------- unresolved claims */
  for (const claim of pkg.compatibilityClaims) {
    const identity = `${claim.variantKey}: ${claim.rawTargetText}`;
    if (!options.apply) {
      rec.record('compatibility_claim', identity, 'create');
      continue;
    }
    const variantId = requireHandle(variantIds, claim.variantKey, 'variant', 'claim');
    // `recordCompatibilityClaim` APPENDS, and correctly: a claim is an
    // OBSERVATION, and two deliveries of one sentence are two observations that
    // a source's history should keep. `compatibility_claims` therefore carries
    // no unique key over the raw text, so convergence is the SEED's job and not
    // the repository's — measured, on the second apply, as four extra rows and
    // a census that said so.
    const existing = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from compatibility_claims
      where subject_variant_id = ${variantId}
        and raw_target_text = ${claim.rawTargetText}
        and asserted_by_source_id = ${sourceId}
    `);
    if (([...existing][0]?.total ?? 0) > 0) {
      rec.record('compatibility_claim', identity, 'present');
      continue;
    }
    rec.record('compatibility_claim', identity, 'create');
    await recordCompatibilityClaim({
      subject: { kind: 'canonical_variant', variantId },
      claim: {
        rawTargetText: claim.rawTargetText,
        ...(claim.rawQualifierText === undefined
          ? {}
          : { rawQualifierText: claim.rawQualifierText }),
        assertedByKind: 'catalog_source',
        assertedBySourceId: sourceId,
        sourceRecordId,
        observedAt: new Date(),
      },
      unresolvedReason: claim.unresolvedReason,
    });
  }

  const created = rec.steps.filter((step) => step.outcome === 'create').length;
  const present = rec.steps.filter((step) => step.outcome === 'present').length;
  const divergent = rec.steps.filter((step) => step.outcome === 'divergent').length;

  return {
    report: {
      packageName: pkg.name,
      namespace: ns,
      applied: options.apply,
      steps: rec.steps,
      created,
      present,
      divergent,
    },
    handles: {
      sourceId,
      sourceRecordId,
      categoryIds,
      attributeIds,
      attributeVersions,
      enumValueIds,
      productTypeIds,
      brandIds,
      familyIds,
      productIds,
      variantIds,
      vehicleMakeIds,
      vehicleModelIds,
      vehicleGenerationIds,
      vehicleConfigurationIds,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function requireHandle(
  map: ReadonlyMap<string, string>,
  key: string,
  kind: string,
  owner: string,
): string {
  const id = map.get(key);
  if (id === undefined) {
    throw new Error(`'${owner}' names ${kind} '${key}', which the package does not declare before it.`);
  }
  return id;
}

/**
 * Record one observed fact, and REPORT what normalization made of it.
 *
 * The outcome is not decoration. `applyAttributeObservation` answers `unusable`
 * when a spelling has no alias row, and a seed that ignored it would report a
 * clean run having written a value no filter can ever match — the exact shape
 * of a seed that looks like proof and is not. `unusable` is recorded as
 * `divergent`, which makes the process exit non-zero.
 */
async function recordFact(
  rec: Recorder,
  input: {
    grain: { kind: 'product' | 'variant'; id: string };
    attributeKey: string;
    displayValue: string;
    sourceRecordId: string;
    catalogSourceId: string;
    sourceField?: string;
    identity: string;
  },
): Promise<void> {
  const result = await applyAttributeObservation({
    grain: input.grain,
    attributeKey: input.attributeKey,
    displayValue: input.displayValue,
    sourceRecordId: input.sourceRecordId,
    catalogSourceId: input.catalogSourceId,
    ...(input.sourceField === undefined ? {} : { sourceField: input.sourceField }),
    method: 'operator',
    observedAt: new Date(),
  });
  const usable = result.outcome === 'selected' || result.outcome === 'agreed';
  rec.record(
    'attribute_fact',
    input.identity,
    usable ? 'create' : result.outcome === 'unchanged' ? 'present' : 'divergent',
    usable || result.outcome === 'unchanged'
      ? undefined
      : `'${input.displayValue}' normalized to '${result.outcome}' — no typed value was stored`,
  );
}

/**
 * How many enum values a namespace's attribute definitions actually carry.
 *
 * Used by the census as its positive control over the value vocabulary: the
 * definitions can all exist with zero values between them, and a count of
 * DEFINITIONS cannot see that.
 */
export async function countNamespaceEnumValues(
  db: DatabaseOrTransaction,
  ns: VerticalNamespace,
): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from ${attributeEnumValues} v
    join attribute_definitions d on d.id = v.attribute_definition_id
    where d.key like ${`${ns.snake}_%`}
  `);
  return [...rows][0]?.total ?? 0;
}

/** A namespace's own enum-value id, for a caller that has no handle map. */
export async function findNamespaceEnumValueId(
  db: DatabaseOrTransaction,
  ns: VerticalNamespace,
  attributeKey: string,
  value: string,
): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    select v.id
    from attribute_enum_values v
    join attribute_definitions d on d.id = v.attribute_definition_id
    where d.key = ${nsKey(ns, attributeKey)} and v.value = ${value}
    limit 1
  `);
  return [...rows][0]?.id ?? null;
}
