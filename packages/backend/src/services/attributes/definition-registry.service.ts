/**
 * The versioned attribute definition registry (#94 registry rules 1–12).
 *
 * A definition is a VERSION, and a version's meaning is frozen the moment it is
 * published. That is the `fee_schedules` decision applied to catalogue policy,
 * and it is what makes an evaluation reproducible: a stored value cites the
 * version it was normalized under, so changing an attribute's meaning never
 * silently reinterprets facts recorded under the old one — it publishes a new
 * version and schedules a re-normalization.
 *
 * ## The lifecycle, and what each transition is allowed to touch
 *
 * `draft` → `active` (publish): the version becomes the meaning new observations
 * are read under, the previously active version becomes `deprecated` in the SAME
 * transaction, and every entity carrying a value for that key is enqueued for
 * re-indexing. One active version per key is held by a partial unique index, so
 * two concurrent publishes cannot both win — the loser gets a constraint
 * violation rather than a second live meaning.
 *
 * `active` → `deprecated`: stored values still resolve (they cite their
 * version), new assignments are refused. `deprecated` → `retired`: the key stops
 * being offered as a filter or a facet at all.
 *
 * Nothing goes backwards. A retired attribute that turns out to be needed is a
 * NEW version, because "un-retire" would make the meaning of every value
 * recorded during the retirement ambiguous.
 */

import {
  NORMALIZATION_RULE_VERSION,
  RESERVED_OFFER_FACT_KEYS,
  type AttributeCardinality,
  type AttributeComponentAxis,
  type AttributeDefinition,
  type AttributeDisplayPolicy,
  type AttributeEvidencePolicy,
  type AttributeObjectivity,
  type AttributeValueType,
  type CurrencyCode,
  type UnitFamily,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  addAttributeDefinitionCategory,
  findActiveAttributeDefinition,
  findAttributeDefinitionById,
  findAttributeDefinitionVersion,
  insertAttributeDefinition,
  insertAttributeEnumValue,
  insertAttributeValueAlias,
  listActiveAttributeDefinitions,
  listActiveDefinitionsForCategory,
  listAttributeDefinitionCategoriesForMany,
  listAttributeDefinitionVersions,
  listAttributeEnumValues,
  listAttributeLabels,
  listAttributeValueAliases,
  maxAttributeDefinitionVersion,
  transitionAttributeDefinition,
  upsertAttributeLabel,
  type AttributeDefinitionRow,
  type AttributeEnumValueRow,
} from '../../db/attributes/definitionRepository.js';
import { enqueueAttributeReindex } from '../../db/attributes/attributeOpsRepository.js';
import { listEntityIdsWithAttribute } from '../../db/canonical/attributeRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { BASE_UNITS } from '../canonical/units.js';
import { normalizeAttributeKey, normalizeOptionValue } from '../canonical/variant-signature.js';

/** A definition version with everything that gives its values meaning. */
export interface ResolvedAttributeDefinition {
  readonly row: AttributeDefinitionRow;
  readonly enumValues: readonly AttributeEnumValueRow[];
  /** Normalized alias → the canonical enum value it resolves to. */
  readonly aliases: ReadonlyMap<string, string>;
  readonly categoryScopes: readonly { categoryId: string; includeDescendants: boolean }[];
  readonly labels: readonly { locale: string; label: string; description?: string }[];
}

export interface DraftAttributeDefinitionInput {
  key: string;
  label: string;
  description?: string;
  valueType: AttributeValueType;
  cardinality?: AttributeCardinality;
  objectivity?: AttributeObjectivity;
  unitFamily?: UnitFamily;
  ratingScaleMax?: number;
  currency?: CurrencyCode;
  componentAxes?: AttributeComponentAxis[];
  minValue?: number;
  maxValue?: number;
  decimalPlaces?: number;
  maxLength?: number;
  implausibleAbove?: number;
  implausibleBelow?: number;
  variantDefining?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  comparable?: boolean;
  searchable?: boolean;
  hardConstraintCapable?: boolean;
  displayPolicy?: AttributeDisplayPolicy;
  evidencePolicy?: AttributeEvidencePolicy;
  enumValues?: { value: string; label: string; aliases?: string[] }[];
  labels?: { locale: string; label: string; description?: string }[];
  categoryScopes?: { categoryId: string; includeDescendants?: boolean }[];
  actorOxyUserId: string;
}

/**
 * Draft a NEW version of an attribute.
 *
 * The version number is `max(existing) + 1`, read inside the transaction. Two
 * concurrent drafts of the same key therefore race on
 * `attribute_definitions_key_version_key` and one of them is refused by the
 * database — which is the correct outcome, because the loser's caller has to
 * decide whether they still want the change on top of the winner's.
 *
 * `baseUnit` is DERIVED from the unit family rather than accepted: a family has
 * exactly one base unit, and letting a caller name a second one would produce
 * two definitions whose magnitudes are in different units while both claim to be
 * normalized.
 */
export async function draftAttributeDefinition(
  input: DraftAttributeDefinitionInput,
  handle?: DatabaseOrTransaction,
): Promise<AttributeDefinition> {
  const key = normalizeAttributeKey(input.key);
  assertDefinitionShape(key, input);

  const draft = async (tx: DatabaseOrTransaction): Promise<AttributeDefinition> => {
    const nextVersion = (await maxAttributeDefinitionVersion(tx, key)) + 1;

    const row = await insertAttributeDefinition(tx, {
      key,
      version: nextVersion,
      lifecycleState: 'draft',
      label: input.label.trim(),
      description: input.description ?? null,
      valueType: input.valueType,
      cardinality: input.cardinality ?? 'single',
      objectivity: input.objectivity ?? 'objective',
      unitFamily: input.unitFamily ?? null,
      baseUnit: input.unitFamily === undefined ? null : BASE_UNITS[input.unitFamily],
      ratingScaleMax: input.ratingScaleMax ?? null,
      currency: input.currency ?? null,
      componentAxes: input.componentAxes ?? [],
      minValue: input.minValue ?? null,
      maxValue: input.maxValue ?? null,
      decimalPlaces: input.decimalPlaces ?? null,
      maxLength: input.maxLength ?? null,
      implausibleAbove: input.implausibleAbove ?? null,
      implausibleBelow: input.implausibleBelow ?? null,
      variantDefining: input.variantDefining ?? false,
      filterable: input.filterable ?? true,
      sortable: input.sortable ?? false,
      comparable: input.comparable ?? true,
      // The default follows the DISPLAY POLICY rather than being a flat `true`.
      // An `operator_only` attribute may not be searchable at all
      // (`attribute_definitions_searchable_display_check`), so a flat default
      // would refuse an operator drafting one for something they never said.
      // This is choosing the default, not coercing a stated value: an explicit
      // `searchable: true` beside `operator_only` still reaches the refusal in
      // `assertDefinitionShape`.
      searchable: input.searchable ?? (input.displayPolicy ?? 'public') === 'public',
      hardConstraintCapable: input.hardConstraintCapable ?? false,
      displayPolicy: input.displayPolicy ?? 'public',
      evidencePolicy: input.evidencePolicy ?? 'source_required',
      createdByOxyUserId: input.actorOxyUserId,
    });

    for (const [position, enumValue] of (input.enumValues ?? []).entries()) {
      const canonicalValue = normalizeOptionValue(enumValue.value);
      const stored = await insertAttributeEnumValue(
        tx,
        row.id,
        canonicalValue,
        enumValue.label.trim(),
        position,
      );
      if (!stored) continue;
      for (const alias of enumValue.aliases ?? []) {
        await insertAttributeValueAlias(tx, {
          attributeDefinitionId: row.id,
          enumValueId: stored.id,
          alias,
        });
      }
    }

    for (const label of input.labels ?? []) {
      await upsertAttributeLabel(tx, {
        attributeDefinitionId: row.id,
        locale: label.locale.trim().toLowerCase(),
        label: label.label.trim(),
        description: label.description,
        // `reviewed` and `mercaria`, with the drafting operator as the reviewer.
        //
        // Honest rather than convenient: this is Mercaria's OWN copy — not a
        // feed's, which is what `imported_source` means — and a named person
        // typed it through the operator surface, which is what `reviewed` means
        // and what `attribute_labels_reviewed_audit_check` demands beside it.
        // `approved` would claim a second, formal approval step nobody performed.
        settlement: {
          status: 'reviewed',
          provenance: 'mercaria',
          reviewedByOxyUserId: input.actorOxyUserId,
          reviewedAt: new Date(),
        },
      });
    }

    for (const scope of input.categoryScopes ?? []) {
      await addAttributeDefinitionCategory(
        tx,
        row.id,
        scope.categoryId,
        scope.includeDescendants ?? true,
      );
    }

    const resolved = await resolveDefinitionRow(tx, row);
    return toAttributeDefinitionDto(resolved);
  };
  // The CALLER's handle when it has one, so a draft can be part of a larger
  // atomic act. #568's approval mints version N+1 inside `approveProposal`'s
  // transaction; opening a second one here would be the #59 merge-runner
  // deadlock — a fresh connection writing rows the caller's transaction holds
  // locks on, which presents as a hang with no error rather than a failure.
  return handle === undefined ? getDb().transaction(draft) : draft(handle);
}

/**
 * Publish a draft, retiring the version it replaces and scheduling re-indexing.
 *
 * All three happen in ONE transaction. Publishing without deprecating the
 * predecessor would leave two active versions and the partial unique would
 * refuse the write; deprecating without enqueueing the reindex would leave a
 * search index answering under rules nobody is applying any more.
 */
export async function publishAttributeDefinition(
  key: string,
  version: number,
  actorOxyUserId: string,
): Promise<AttributeDefinition> {
  const normalizedKey = normalizeAttributeKey(key);
  if (actorOxyUserId.trim().length === 0) {
    throw validationError('publishAttributeDefinition: an actor is required.');
  }

  return getDb().transaction(async (tx) => {
    const draft = await findAttributeDefinitionVersion(tx, normalizedKey, version);
    if (!draft) throw notFound(`Attribute '${normalizedKey}' has no version ${version}.`);
    if (draft.lifecycleState !== 'draft') {
      throw conflict(
        `Attribute '${normalizedKey}' version ${version} is '${draft.lifecycleState}'; only a draft can be published.`,
      );
    }

    const previous = await findActiveAttributeDefinition(tx, normalizedKey);
    if (previous) {
      const deprecated = await transitionAttributeDefinition(
        tx,
        previous.id,
        'active',
        'deprecated',
        { deprecatedAt: new Date() },
      );
      if (!deprecated) {
        throw conflict(
          `Attribute '${normalizedKey}' changed state while publishing version ${version}; retry.`,
        );
      }
    }

    const published = await transitionAttributeDefinition(tx, draft.id, 'draft', 'active', {
      publishedByOxyUserId: actorOxyUserId,
      publishedAt: new Date(),
    });
    if (!published) {
      throw conflict(`Attribute '${normalizedKey}' version ${version} is no longer a draft.`);
    }

    await enqueueReindexForKey(tx, normalizedKey, version, 'definition_published');

    const resolved = await resolveDefinitionRow(tx, published);
    return toAttributeDefinitionDto(resolved);
  });
}

/**
 * Take a version out of service for NEW assignments. Stored values still resolve.
 *
 * `replacedByDefinitionId` is optional and answers "use X instead" (#367 line
 * 237). Omitting it is a complete decision, not an incomplete one: a version can
 * be deprecated because nobody should use that attribute any more, with no
 * successor to send anybody to.
 *
 * The replacement is written in the SAME statement as the lifecycle move rather
 * than a second UPDATE afterwards, so the row never exists in the intermediate
 * state `attribute_definitions_replaced_by_lifecycle_check` refuses — and a
 * crash between two statements cannot leave a deprecation whose successor was
 * lost.
 */
export async function deprecateAttributeDefinition(
  key: string,
  version: number,
  replacedByDefinitionId?: string,
): Promise<AttributeDefinition> {
  return moveLifecycle(
    key,
    version,
    'active',
    'deprecated',
    'definition_deprecated',
    replacedByDefinitionId,
  );
}

/** Stop offering the attribute entirely — no facet, no filter, no new value. */
export async function retireAttributeDefinition(
  key: string,
  version: number,
): Promise<AttributeDefinition> {
  return moveLifecycle(key, version, 'deprecated', 'retired', 'definition_deprecated');
}

async function moveLifecycle(
  key: string,
  version: number,
  expected: 'active' | 'deprecated',
  next: 'deprecated' | 'retired',
  reindexReason: 'definition_deprecated',
  replacedByDefinitionId?: string,
): Promise<AttributeDefinition> {
  const normalizedKey = normalizeAttributeKey(key);
  return getDb().transaction(async (tx) => {
    const row = await findAttributeDefinitionVersion(tx, normalizedKey, version);
    if (!row) throw notFound(`Attribute '${normalizedKey}' has no version ${version}.`);
    // The replacement must EXIST, and saying so here rather than letting the
    // foreign key raise is what turns a 500 into a 404 naming what was missing.
    // The FK is still the authority — this is the message, not the guarantee.
    if (replacedByDefinitionId !== undefined) {
      const replacement = await findAttributeDefinitionById(tx, replacedByDefinitionId);
      if (!replacement) {
        throw notFound(`No attribute definition ${replacedByDefinitionId} to replace it with.`);
      }
    }
    const moved = await transitionAttributeDefinition(tx, row.id, expected, next, {
      deprecatedAt: new Date(),
      ...(replacedByDefinitionId === undefined ? {} : { replacedByDefinitionId }),
    });
    if (!moved) {
      throw conflict(
        `Attribute '${normalizedKey}' version ${version} is '${row.lifecycleState}', not '${expected}'.`,
      );
    }
    await enqueueReindexForKey(tx, normalizedKey, version, reindexReason);
    const resolved = await resolveDefinitionRow(tx, moved);
    return toAttributeDefinitionDto(resolved);
  });
}

/**
 * Enqueue a reindex request for every entity carrying a value for one key.
 *
 * One row per ENTITY rather than one naming the definition: the consumer's unit
 * of work is a document, and a single "everything with key X changed" row would
 * have to be expanded by whoever drained it — unbounded work inside a lease.
 */
async function enqueueReindexForKey(
  tx: DatabaseOrTransaction,
  attributeKey: string,
  definitionVersion: number,
  reason: 'definition_published' | 'definition_deprecated',
): Promise<void> {
  const affected = await listEntityIdsWithAttribute(tx, attributeKey);
  for (const entity of affected) {
    await enqueueAttributeReindex(tx, {
      entityKind: entity.kind,
      entityId: entity.id,
      attributeKey,
      definitionVersion,
      reason,
    });
  }
}

/** The ACTIVE definition for a key, hydrated. `undefined` when there is none. */
export async function resolveActiveDefinition(
  db: DatabaseOrTransaction,
  key: string,
): Promise<ResolvedAttributeDefinition | undefined> {
  const row = await findActiveAttributeDefinition(db, normalizeAttributeKey(key));
  if (!row) return undefined;
  return resolveDefinitionRow(db, row);
}

/** One exact version, hydrated — what an evaluation cites. */
export async function resolveDefinitionVersion(
  db: DatabaseOrTransaction,
  key: string,
  version: number,
): Promise<ResolvedAttributeDefinition | undefined> {
  const row = await findAttributeDefinitionVersion(db, normalizeAttributeKey(key), version);
  if (!row) return undefined;
  return resolveDefinitionRow(db, row);
}

/** Every active definition, hydrated. */
export async function resolveAllActiveDefinitions(
  db: DatabaseOrTransaction,
): Promise<ResolvedAttributeDefinition[]> {
  return hydrateMany(db, await listActiveAttributeDefinitions(db));
}

/** Active definitions that apply to a category, inheritance included. */
export async function resolveDefinitionsForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<ResolvedAttributeDefinition[]> {
  return hydrateMany(db, await listActiveDefinitionsForCategory(db, categoryId));
}

/** Every version of one key, newest first — the operator's history view. */
export async function listDefinitionHistory(
  db: DatabaseOrTransaction,
  key: string,
): Promise<ResolvedAttributeDefinition[]> {
  return hydrateMany(db, await listAttributeDefinitionVersions(db, normalizeAttributeKey(key)));
}

async function resolveDefinitionRow(
  db: DatabaseOrTransaction,
  row: AttributeDefinitionRow,
): Promise<ResolvedAttributeDefinition> {
  const [resolved] = await hydrateMany(db, [row]);
  if (!resolved) throw new Error(`resolveDefinitionRow lost definition ${row.id}.`);
  return resolved;
}

/**
 * Hydrate a batch in four queries rather than four per definition.
 *
 * The batching is not an optimization detail — a facet page resolves every
 * attribute of a category at once, and the per-row shape would issue four
 * queries per attribute on the hot path of every category page.
 */
async function hydrateMany(
  db: DatabaseOrTransaction,
  rows: readonly AttributeDefinitionRow[],
): Promise<ResolvedAttributeDefinition[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [enumValues, aliases, scopes, labels] = await Promise.all([
    listAttributeEnumValues(db, ids),
    listAttributeValueAliases(db, ids),
    listAttributeDefinitionCategoriesForMany(db, ids),
    listAttributeLabels(db, ids),
  ]);

  const enumValueById = new Map(enumValues.map((value) => [value.id, value]));

  return rows.map((row) => {
    const ownEnumValues = enumValues.filter((value) => value.attributeDefinitionId === row.id);
    const ownAliases = new Map<string, string>();
    for (const alias of aliases) {
      if (alias.attributeDefinitionId !== row.id) continue;
      const target = enumValueById.get(alias.enumValueId);
      if (target) ownAliases.set(alias.normalizedAlias, target.value);
    }
    // A canonical value is its own alias, so the resolver has ONE lookup rather
    // than a lookup plus a fallback that could disagree with it.
    for (const value of ownEnumValues) ownAliases.set(value.value, value.value);

    return {
      row,
      enumValues: ownEnumValues,
      aliases: ownAliases,
      categoryScopes: scopes
        .filter((scope) => scope.attributeDefinitionId === row.id)
        .map((scope) => ({
          categoryId: scope.categoryId,
          includeDescendants: scope.includeDescendants,
        })),
      labels: labels
        .filter((label) => label.attributeDefinitionId === row.id)
        .map((label) => ({
          locale: label.locale,
          label: label.label,
          ...(label.description === null ? {} : { description: label.description }),
        })),
    };
  });
}

/** The public DTO of one hydrated definition version. */
export function toAttributeDefinitionDto(
  resolved: ResolvedAttributeDefinition,
): AttributeDefinition {
  const { row } = resolved;
  const aliasesFor = (value: string): string[] =>
    [...resolved.aliases.entries()]
      .filter(([alias, target]) => target === value && alias !== value)
      .map(([alias]) => alias);

  return {
    id: row.id,
    key: row.key,
    version: row.version,
    lifecycleState: row.lifecycleState,
    label: row.label,
    ...(row.description === null ? {} : { description: row.description }),
    labels: resolved.labels.map((label) => ({ ...label })),
    valueType: row.valueType,
    cardinality: row.cardinality,
    objectivity: row.objectivity,
    ...(row.unitFamily === null ? {} : { unitFamily: row.unitFamily }),
    ...(row.baseUnit === null ? {} : { baseUnit: row.baseUnit }),
    ...(row.ratingScaleMax === null ? {} : { ratingScaleMax: row.ratingScaleMax }),
    ...(row.currency === null ? {} : { currency: row.currency }),
    ...(row.replacedByDefinitionId === null
      ? {}
      : { replacedByDefinitionId: row.replacedByDefinitionId }),
    enumValues: resolved.enumValues.map((value) => ({
      value: value.value,
      label: value.label,
      position: value.position,
      aliases: aliasesFor(value.value),
    })),
    componentAxes: row.componentAxes.filter(isComponentAxis),
    validation: {
      ...(row.minValue === null ? {} : { minValue: row.minValue }),
      ...(row.maxValue === null ? {} : { maxValue: row.maxValue }),
      ...(row.decimalPlaces === null ? {} : { decimalPlaces: row.decimalPlaces }),
      ...(row.maxLength === null ? {} : { maxLength: row.maxLength }),
      ...(row.implausibleAbove === null ? {} : { implausibleAbove: row.implausibleAbove }),
      ...(row.implausibleBelow === null ? {} : { implausibleBelow: row.implausibleBelow }),
    },
    variantDefining: row.variantDefining,
    filterable: row.filterable,
    sortable: row.sortable,
    comparable: row.comparable,
    searchable: row.searchable,
    hardConstraintCapable: row.hardConstraintCapable,
    displayPolicy: row.displayPolicy,
    evidencePolicy: row.evidencePolicy,
    categoryScopes: resolved.categoryScopes.map((scope) => ({ ...scope })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt.toISOString() }),
    ...(row.deprecatedAt === null ? {} : { deprecatedAt: row.deprecatedAt.toISOString() }),
  };
}

const COMPONENT_AXIS_SET = new Set<string>([
  'width',
  'height',
  'depth',
  'diagonal',
  'circumference',
]);

function isComponentAxis(value: string): value is AttributeComponentAxis {
  return COMPONENT_AXIS_SET.has(value);
}

/**
 * The shape rules a draft must satisfy BEFORE the database sees it.
 *
 * Every one of these is also a CHECK on the table, deliberately: the CHECK is
 * what holds against a writer that skips this service, and this is what gives a
 * caller a sentence they can act on instead of SQLSTATE 23514. The one rule that
 * exists ONLY here is the reserved-key refusal's message — the CHECK refuses the
 * write either way, but "`price` names a current offer, not a product
 * specification" is the part that stops somebody retrying with `Price`.
 */
function assertDefinitionShape(key: string, input: DraftAttributeDefinitionInput): void {
  if (!/^[a-z][a-z0-9_]*$/u.test(key)) {
    throw validationError(
      `Attribute key '${input.key}' must match ^[a-z][a-z0-9_]*$ — it is a stable machine name, never a label.`,
    );
  }
  if (RESERVED_OFFER_FACT_KEYS.includes(key)) {
    throw validationError(
      `Attribute key '${key}' names a fact about a current OFFER (price, availability, condition, delivery), not about a product. ` +
        'Those are answered from live offers through the commerce constraint facets, never from a static product attribute.',
    );
  }
  const takesUnitFamily = input.valueType === 'measurement' || input.valueType === 'structured';
  if (takesUnitFamily !== (input.unitFamily !== undefined)) {
    throw validationError(
      'A measurement or structured attribute needs a unit family, and no other value type may carry one — ' +
        "a structured value's components are magnitudes on named axes.",
    );
  }
  if ((input.unitFamily === 'rating') !== (input.ratingScaleMax !== undefined)) {
    throw validationError(
      'A rating attribute needs its scale maximum, and no other unit family may carry one — 4.5 out of 5 is not 4.5 out of 10.',
    );
  }
  if ((input.valueType === 'money') !== (input.currency !== undefined)) {
    throw validationError(
      'A money attribute names exactly one currency, and no other value type may carry one.',
    );
  }
  if ((input.valueType === 'structured') !== ((input.componentAxes ?? []).length > 0)) {
    throw validationError(
      'A structured attribute declares its component axes, and no other value type may declare any.',
    );
  }
  if (input.valueType === 'enum' && (input.enumValues ?? []).length === 0) {
    throw validationError('An enum attribute with no allowed values admits nothing.');
  }
  if (input.valueType !== 'enum' && (input.enumValues ?? []).length > 0) {
    throw validationError('Only an enum attribute may declare allowed values.');
  }
  if (input.hardConstraintCapable === true && (input.objectivity ?? 'objective') !== 'objective') {
    throw validationError(
      'Only an objective attribute may be hard-constraint-capable: an opinion must not be able to exclude a product.',
    );
  }
  if (input.hardConstraintCapable === true && input.filterable === false) {
    throw validationError(
      'A hard-constraint-capable attribute must be filterable — a requirement a shopper cannot see is a rule they cannot check.',
    );
  }
  if (input.searchable === true && input.displayPolicy === 'operator_only') {
    throw validationError(
      'An operator-only attribute cannot be searchable: recognising a shopper word for it puts its label in the explanation shown back to them.',
    );
  }
}

/** The normalization ruleset new values are written under. */
export const ACTIVE_NORMALIZATION_RULE_VERSION = NORMALIZATION_RULE_VERSION;
