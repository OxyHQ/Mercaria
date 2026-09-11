/**
 * The ONE thing that writes the 3D profile package (#1015 Workstream 3).
 *
 * ## The posture, inherited rather than invented
 *
 * `scripts/seed-verticals/apply.ts`', which inherited it from
 * `provision-taxonomy.ts`: insert-only, idempotent, and a divergent existing row
 * is REPORTED and never corrected. There is no destructive mode, and that is not
 * a switch left off — a "reset the 3D vertical" path would have to delete
 * attribute definitions that have left `draft` (which
 * `mercaria_attribute_definition_immutable` refuses), product-type versions that
 * have been published (`product_type_definitions_immutable_once_published`) and
 * licence versions a buyer's right may already name
 * (`asset_licence_versions_immutable_once_published`, plus `ON DELETE restrict`
 * from `asset_rights`). The honest reset is a new namespace; for the licences
 * there is not even that, which is the point of them.
 *
 * ## Everything here goes through #367's OWN machinery
 *
 * #1015 acceptance criterion 18 is not satisfied by a seed that writes
 * `product_type_fields` rows with its own INSERTs. So the attributes go through
 * `draftAttributeDefinition` + `publishAttributeDefinition`, the profiles through
 * `insertProductTypeDefinition`, `insertProductTypeFieldGroup`,
 * `insertProductTypeField` and `publishProductTypeVersion`, and the categories
 * through `taxonomyRepository`, which `taxonomy-write-chokepoint.test.ts` keeps
 * as the only writer of `categories`. The licences go through
 * `db/digital/licenceRepository.ts`, the only writer of theirs.
 *
 * What that buys is that every refusal those paths carry applies to this package
 * too — and two of them actually fire on a careless edit here:
 * `publishProductTypeVersion` refuses a visibility rule naming a field the same
 * FLOW does not declare (which is why `intended_use` is in the P2P flow of every
 * printable profile), and it refuses a `value_policy` that contradicts the cited
 * attribute's `value_type`.
 *
 * ## Why this is not one transaction
 *
 * Three of the services it calls open their own —
 * `draftAttributeDefinition`, `publishAttributeDefinition` and
 * `publishProductTypeVersion` each take `getDb().transaction(...)` — and nesting
 * a caller's handle into them is not available. So the unit of atomicity is the
 * STEP, which is exactly what idempotency is for: a run interrupted halfway is
 * resumed by running it again and every step converges.
 *
 * ## The namespace is OPTIONAL here, and that DIFFERS from #367 W14
 *
 * A vertical package always prefixes its keys, because `footwear` and
 * `smartphone` are two packages sharing one global key space and the prefix is
 * what keeps parallel test files from racing on
 * `attribute_definitions_key_version_key`.
 *
 * This package needs the same thing for tests and the OPPOSITE thing in
 * production: `THREE_D_PROFILE_KEYS` is published in `@mercaria/shared-types`, so
 * a production row whose key is `three_d_three_d_print_model` would make the
 * published tuple a list that matches nothing in the database. A key is frozen
 * by trigger and ADR 0007 D1 forbids a rename, so that is not a thing a later
 * migration could quietly fix.
 *
 * So: no `namespace` option means the CANONICAL keys, which is what a deployment
 * gets; a `namespace` means every key, slug and alias is prefixed, which is what
 * a test run gets. Both are the same code path with one prefix function.
 */

import { createHash } from 'node:crypto';

import { MERCARIA_REFERENCE_LICENCES, THREE_D_PROFILE_KEYS } from '@mercaria/shared-types';
import type { ProductTypeVisibilityRule } from '@mercaria/shared-types';

import type { Database, DatabaseOrTransaction } from '../../../db/postgres.js';
import { getDb } from '../../../db/postgres.js';
import {
  findCategoryByKey,
  insertCategory,
  insertCategoryAlias,
} from '../../../db/taxonomy/taxonomyRepository.js';
import { normalizeCatalogAlias } from '../../taxonomy/alias-normalization.js';
import { upsertCategoryLocalization } from '../../../db/catalogLocalization/categoryLocalizationRepository.js';
import { upsertProductTypeLocalization } from '../../../db/catalogLocalization/productTypeLocalizationRepository.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
  resolveActiveDefinition,
} from '../../attributes/definition-registry.service.js';
import {
  findProductTypeDefinitionByKeyVersion,
  insertProductTypeDefinition,
} from '../../../db/productTypes/productTypeRepository.js';
import {
  insertProductTypeCategoryScope,
  insertProductTypeField,
  insertProductTypeFieldGroup,
} from '../../../db/productTypes/productTypeFieldRepository.js';
import { publishProductTypeVersion } from '../../product-types/product-type.service.js';
import { applyReferenceLicences, type ReferenceLicenceStep } from './licences.js';
import type { ThreeDProfilePackage } from './types.js';

/* -------------------------------------------------------------------------- */
/* The namespace                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a run's identity strings are qualified, or `null` for the canonical ones.
 *
 * Two spellings because two CHECKs differ: an attribute and a product-type key
 * are `^[a-z][a-z0-9_]*$` (underscores, no leading digit), and a category key
 * and a slug admit hyphens.
 */
export interface ThreeDNamespace {
  /** `run4a2b` — leads every attribute and product-type key. */
  readonly snake: string;
  /** `run4a2b` in kebab form — leads every category key and slug. */
  readonly kebab: string;
}

export function namespaceFor(token: string): ThreeDNamespace {
  const cleaned = token
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (cleaned.length === 0 || /^[0-9]/u.test(cleaned)) {
    throw new Error(
      `A 3D profile namespace must start with a letter and contain [a-z0-9_]; got '${token}'.`,
    );
  }
  return { snake: cleaned, kebab: cleaned.replace(/_/gu, '-') };
}

/** `intended_use` canonically, `run4a2b_intended_use` under a namespace. */
export function nsKey(ns: ThreeDNamespace | null, key: string): string {
  return ns === null ? key : `${ns.snake}_${key}`;
}

/** `three_d.props` canonically, `run4a2b.three_d.props` under a namespace. */
export function nsCategoryKey(ns: ThreeDNamespace | null, key: string): string {
  return ns === null ? key : `${ns.kebab}.${key}`;
}

/** `3d-props` canonically, `run4a2b-3d-props` under a namespace. */
export function nsSlug(ns: ThreeDNamespace | null, slug: string): string {
  return ns === null ? slug : `${ns.kebab}-${slug}`;
}

/**
 * A visibility rule with every field key namespaced.
 *
 * Applied HERE and nowhere else, so the rule in `package.ts` is written once in
 * the unprefixed spelling. The walk is over an already-typed AST whose depth and
 * node count the interpreter's bounds already guarantee finite, and it rebuilds
 * rather than mutating — a shared rule object is reused across nine fields and
 * seven profiles, and mutating it in place would prefix one of them twice.
 */
export function namespaceRule(
  ns: ThreeDNamespace | null,
  rule: ProductTypeVisibilityRule,
): ProductTypeVisibilityRule {
  if (ns === null) return rule;
  switch (rule.node) {
    case 'all':
      return { node: 'all', rules: rule.rules.map((branch) => namespaceRule(ns, branch)) };
    case 'any':
      return { node: 'any', rules: rule.rules.map((branch) => namespaceRule(ns, branch)) };
    case 'not':
      return { node: 'not', rule: namespaceRule(ns, rule.rule) };
    case 'presence':
      return { ...rule, field: nsKey(ns, rule.field) };
    case 'membership':
      return { ...rule, field: nsKey(ns, rule.field) };
    default:
      return { ...rule, field: nsKey(ns, rule.field) };
  }
}

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

/** What one step did, or would do. */
export type ProfileStepOutcome =
  /** The row was absent; created, or in a dry run would be. */
  | 'create'
  /** Already there and agrees. Nothing written. */
  | 'present'
  /**
   * There and DISAGREEING with the package.
   *
   * Reported, never corrected. The seed's authority is to add what is missing,
   * and a silent correction is how a hand-applied fix comes back — and for a
   * published attribute or licence version the database would refuse the
   * correction anyway, so the alternative is a crash rather than a repair.
   */
  | 'divergent';

export interface ProfileStep {
  readonly entity: string;
  readonly identity: string;
  readonly outcome: ProfileStepOutcome;
  readonly detail?: string;
}

export interface ProfileSeedReport {
  readonly packageName: string;
  /** `null` when the canonical keys were used. */
  readonly namespace: ThreeDNamespace | null;
  readonly applied: boolean;
  readonly steps: readonly ProfileStep[];
  readonly created: number;
  readonly present: number;
  readonly divergent: number;
}

/** Everything a caller needs to find what an apply wrote, without re-deriving keys. */
export interface ProfileSeedHandles {
  readonly categoryIds: ReadonlyMap<string, string>;
  readonly attributeIds: ReadonlyMap<string, string>;
  readonly attributeVersions: ReadonlyMap<string, number>;
  readonly profileIds: ReadonlyMap<string, string>;
  readonly licenceIds: ReadonlyMap<string, string>;
  readonly licenceVersionIds: ReadonlyMap<string, string>;
}

export interface ProfileSeedResult {
  readonly report: ProfileSeedReport;
  /** Populated only by a real apply — a dry run resolves no id it did not find. */
  readonly handles: ProfileSeedHandles;
}

export interface ApplyProfilesOptions {
  /** Writes only when true. The default reads and reports. */
  readonly apply: boolean;
  /** Prefixes every identity string. ABSENT means the canonical keys. */
  readonly namespace?: string;
  /** Stamped on everything this run authors. */
  readonly actorOxyUserId: string;
}

class Recorder {
  readonly steps: ProfileStep[] = [];

  record(entity: string, identity: string, outcome: ProfileStepOutcome, detail?: string): void {
    this.steps.push(
      detail === undefined ? { entity, identity, outcome } : { entity, identity, outcome, detail },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The executor                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply the package.
 *
 * The ORDER is forced by real foreign keys and three triggers and a caller
 * cannot vary it: categories before the attribute scopes that reference them;
 * attribute definitions before the product-type fields that CITE them
 * (`mercaria_product_type_field_citation` resolves `(id, key, version)` and
 * refuses a mismatch); every child of a version before publication
 * (`mercaria_product_type_child_frozen`); and every enum value before the
 * attribute is published (`mercaria_attribute_enum_frozen`, which is why an
 * added controlled value is a new VERSION and never an edit).
 *
 * The licences are LAST and are order-independent of all of it: they name no
 * category, no attribute and no product type, which is what makes them a
 * separate module and separately runnable.
 */
export async function applyThreeDProfilePackage(
  pkg: ThreeDProfilePackage,
  options: ApplyProfilesOptions,
  database: Database = getDb(),
): Promise<ProfileSeedResult> {
  const ns = options.namespace === undefined ? null : namespaceFor(options.namespace);
  const rec = new Recorder();
  const db: DatabaseOrTransaction = database;

  const categoryIds = new Map<string, string>();
  const attributeIds = new Map<string, string>();
  const attributeVersions = new Map<string, number>();
  const profileIds = new Map<string, string>();

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
          // stores `impresión 3d` where the lookup asks for `impresion 3d` and
          // the row resolves for nobody.
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

    const drafted = await draftAttributeDefinition({
      key,
      label: attribute.label,
      ...(attribute.description === undefined ? {} : { description: attribute.description }),
      valueType: attribute.valueType,
      ...(attribute.cardinality === undefined ? {} : { cardinality: attribute.cardinality }),
      ...(attribute.objectivity === undefined ? {} : { objectivity: attribute.objectivity }),
      ...(attribute.unitFamily === undefined ? {} : { unitFamily: attribute.unitFamily }),
      ...(attribute.decimalPlaces === undefined ? {} : { decimalPlaces: attribute.decimalPlaces }),
      ...(attribute.minValue === undefined ? {} : { minValue: attribute.minValue }),
      ...(attribute.maxValue === undefined ? {} : { maxValue: attribute.maxValue }),
      ...(attribute.variantDefining === undefined
        ? {}
        : { variantDefining: attribute.variantDefining }),
      ...(attribute.filterable === undefined ? {} : { filterable: attribute.filterable }),
      ...(attribute.sortable === undefined ? {} : { sortable: attribute.sortable }),
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
      ...(attribute.labels === undefined
        ? {}
        : { labels: attribute.labels.map((label) => ({ ...label })) }),
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
  }

  /* -------------------------------------------------------------- profiles */
  for (const profile of pkg.profiles) {
    const key = nsKey(ns, profile.key);
    const existing = await findProductTypeDefinitionByKeyVersion(db, key, profile.version);
    if (existing) {
      profileIds.set(profile.key, existing.id);
      rec.record(
        'product_type',
        `${key}@${profile.version}`,
        existing.lifecycle === 'published' ? 'present' : 'divergent',
        existing.lifecycle === 'published'
          ? undefined
          : `stored lifecycle is '${existing.lifecycle}'; the package expects a published version`,
      );
      continue;
    }
    rec.record('product_type', `${key}@${profile.version}`, 'create');
    if (!options.apply) {
      // A dry run cannot resolve a field of a version it has not created, so it
      // reports the package's own counts rather than stopping at the version. A
      // plan that stopped there would tell an operator a profile is one row when
      // it is one row plus up to twenty fields.
      for (const field of profile.fields) {
        rec.record('product_type_field', `${profile.key}/${field.flow}/${field.attributeKey}`, 'create');
      }
      continue;
    }

    const definition = await insertProductTypeDefinition(db, {
      key,
      version: profile.version,
      name: profile.name,
      description: profile.description,
      // `block_publication`, the same answer every reference package gives: a
      // controlled value still under review must not reach a product page as if
      // it were vocabulary (ADR 0007 D9). For a digital asset it is stricter
      // than it looks — a published listing is immediately acquirable, and a
      // buyer's order line SNAPSHOTS what it said.
      pendingProposalPolicy: 'block_publication',
      createdByOxyUserId: options.actorOxyUserId,
    });
    profileIds.set(profile.key, definition.id);

    const groupIds = new Map<string, string>();
    for (const group of profile.groups) {
      const row = await insertProductTypeFieldGroup(db, {
        productTypeDefinitionId: definition.id,
        key: group.key,
        label: group.label,
        position: group.position,
      });
      groupIds.set(group.key, row.id);
    }

    for (const field of profile.fields) {
      const attributeDefinitionId = attributeIds.get(field.attributeKey);
      const attributeDefinitionVersion = attributeVersions.get(field.attributeKey);
      if (attributeDefinitionId === undefined || attributeDefinitionVersion === undefined) {
        throw new Error(
          `Profile '${profile.key}' cites attribute '${field.attributeKey}', which the package does not declare before it.`,
        );
      }
      const groupId = groupIds.get(field.groupKey);
      if (groupId === undefined) {
        throw new Error(
          `Profile '${profile.key}' lays '${field.attributeKey}' out in group '${field.groupKey}', which it does not declare.`,
        );
      }
      await insertProductTypeField(db, {
        productTypeDefinitionId: definition.id,
        groupId,
        attributeDefinitionId,
        attributeKey: nsKey(ns, field.attributeKey),
        attributeDefinitionVersion,
        scope: field.scope,
        flow: field.flow,
        requirement: field.requirement,
        valuePolicy: field.valuePolicy,
        variantCapable: field.variantCapable ?? false,
        position: field.position,
        ...(field.visibilityRule === undefined
          ? {}
          : { visibilityRule: namespaceRule(ns, field.visibilityRule) }),
      });
      // Recorded per field, so a real apply's report and the dry run's PLAN
      // describe the same work. They still differ on a SECOND apply, where a
      // present version's fields are not enumerated at all — and that asymmetry
      // is sound rather than an omission: `mercaria_product_type_child_frozen`
      // refuses every write to a published version's fields, so there is nothing
      // a re-apply could find changed and nothing it could do about it.
      rec.record(
        'product_type_field',
        `${profile.key}/${field.flow}/${field.attributeKey}`,
        'create',
      );
    }

    for (const categoryKey of profile.categoryScopeKeys) {
      const categoryId = categoryIds.get(categoryKey);
      if (categoryId === undefined) {
        throw new Error(
          `Profile '${profile.key}' is scoped to category '${categoryKey}', which the package does not declare.`,
        );
      }
      await insertProductTypeCategoryScope(db, {
        productTypeDefinitionId: definition.id,
        categoryId,
        includeDescendants: true,
      });
    }

    for (const localization of profile.localizations) {
      await upsertProductTypeLocalization(
        {
          productTypeDefinitionId: definition.id,
          locale: localization.locale,
          status: 'approved',
          provenance: 'mercaria',
          name: localization.name,
          description: localization.description ?? null,
          helpText: null,
          sourceLocale: 'en',
          reviewedByOxyUserId: options.actorOxyUserId,
          reviewedAt: new Date(),
        },
        db,
      );
    }

    // Publication is LAST and it can refuse — for no category scope, no field, a
    // variant-axis violation, a value policy contradicting the cited attribute,
    // or a visibility rule naming a field the flow does not declare. It returns a
    // discriminated union and throws NOTHING, so a seed that ignored the outcome
    // would leave a `draft` version behind and report success.
    const publication = await publishProductTypeVersion(database, {
      definitionId: definition.id,
      publishedByOxyUserId: options.actorOxyUserId,
    });
    if (publication.outcome === 'refused') {
      throw new Error(
        `Profile '${key}@${profile.version}' was refused publication: ${publication.refusal} — ${publication.detail}`,
      );
    }
  }

  /* -------------------------------------------------------------- licences */
  const licences = await applyReferenceLicences(pkg, { apply: options.apply }, db);
  for (const step of licences.steps) rec.record(step.entity, step.identity, step.outcome, step.detail);

  return {
    report: {
      packageName: pkg.name,
      namespace: ns,
      applied: options.apply,
      steps: rec.steps,
      created: rec.steps.filter((step) => step.outcome === 'create').length,
      present: rec.steps.filter((step) => step.outcome === 'present').length,
      divergent: rec.steps.filter((step) => step.outcome === 'divergent').length,
    },
    handles: {
      categoryIds,
      attributeIds,
      attributeVersions,
      profileIds,
      licenceIds: licences.licenceIds,
      licenceVersionIds: licences.licenceVersionIds,
    },
  };
}

/**
 * A stable fingerprint of the package's VOCABULARY, for an operator log line.
 *
 * Not a migration marker and nothing reads it to decide anything: it exists so a
 * run's output names which revision of the profiles it applied, because a seed
 * whose data changed between two deployments is otherwise indistinguishable in a
 * log from one that ran twice.
 *
 * Over the keys and not the prose: a reworded help text is not a different
 * vocabulary, and a fingerprint that moved on every typo would be noise an
 * operator learns to ignore.
 */
export function profileVocabularyFingerprint(pkg: ThreeDProfilePackage): string {
  const material = [
    ...pkg.categories.map((category) => `c:${category.key}`),
    ...pkg.attributes.map(
      (attribute) => `a:${attribute.key}:${attribute.valueType}:${attribute.variantDefining ?? false}`,
    ),
    ...pkg.profiles.flatMap((profile) => [
      `p:${profile.key}@${profile.version}`,
      ...profile.fields.map((field) => `f:${profile.key}:${field.flow}:${field.attributeKey}`),
    ]),
    ...pkg.licences.map((licence) => `l:${licence.slug}@${licence.version}`),
  ].join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Both published vocabularies the package must agree with, checked before a
 * single statement runs.
 *
 * It is a separate exported function rather than an assertion inside the apply
 * so the CLI can refuse a bad package BEFORE touching the database, and so
 * `three-d-profiles.test.ts` can drive it with a mutated package and watch it
 * refuse. Returns the problems rather than throwing on the first, because an
 * operator fixing a package wants the list.
 */
export function disagreementsWithPublishedVocabulary(pkg: ThreeDProfilePackage): string[] {
  const problems: string[] = [];
  const declared = pkg.profiles.map((profile) => profile.key);
  for (const key of THREE_D_PROFILE_KEYS) {
    if (!declared.includes(key)) {
      problems.push(`THREE_D_PROFILE_KEYS names '${key}' and the package declares no profile for it.`);
    }
  }
  const slugs = MERCARIA_REFERENCE_LICENCES.map((licence) => licence.slug);
  for (const slug of slugs) {
    if (!pkg.licences.some((licence) => licence.slug === slug)) {
      problems.push(
        `MERCARIA_REFERENCE_LICENCES names '${slug}' and the package seeds no licence for it.`,
      );
    }
  }
  for (const licence of pkg.licences) {
    if (!slugs.includes(licence.slug)) {
      problems.push(
        `The package seeds licence '${licence.slug}', which MERCARIA_REFERENCE_LICENCES does not define — ` +
          'its terms would have nowhere to come from.',
      );
    }
  }
  return problems;
}

export type { ReferenceLicenceStep };
