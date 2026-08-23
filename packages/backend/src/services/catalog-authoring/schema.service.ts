/**
 * The composition (#367 step 5, ADR 0007 D10) — the one place an
 * `AuthoringSchema` is built.
 *
 * ```
 * category + product type (exact version) + attribute definitions (exact versions)
 *         + controlled value policies + store/seller permissions
 *         + flow + locale + market
 *         = AuthoringSchema
 * ```
 *
 * ## It composes and it decides NOTHING
 *
 * Identity is #367 step 1's, the product type's shape is step 3's, an
 * attribute's meaning is #94's, the fallback chain is step 2's. This module
 * joins them and adds exactly three things nobody else can: the RULE/TEXT
 * separation, the deterministic ETag, and the step list that keeps price, stock
 * and condition out of the attribute registry. `catalog-authoring-isolation.test.ts`
 * fails the build if it starts to rank, to write, or to reach a money domain.
 *
 * ## The cache, and why it is a KEY rather than an eviction
 *
 * D10 asks for caches keyed by every semantic dimension and invalidated
 * transactionally. The key is {@link AuthoringSchemaKey} — product type version,
 * category, flow, locale, market, permission fingerprint — PLUS the revisions of
 * every mutable subject the composition read
 * (`catalog_authoring_schema_invalidations`). An entry composed under revision 4
 * is unreachable the instant the revision is 5, in every ECS task at once,
 * because no lookup can name it. There is nothing to evict and no window during
 * which a task still serves the old answer.
 *
 * **That last sentence is only true while every mutable subject in the key has a
 * PRODUCER**, and for two years of this file's life one did not: `localization`
 * was folded into the key and the ETag and bumped by nothing, so an approved
 * translation was served stale until the process restarted (#655). The
 * mechanism was sound and one writer had simply not been wired to it, which is
 * the failure this comment previously described away. `invalidationRefs` and
 * `bumpAuthoringSchemaInvalidation`'s call sites are the two halves to check
 * together when a subject is added.
 *
 * A DRAFT or in-review product type version is never memoized at all: its fields
 * are still editable, so the only honest cache lifetime for one is zero. So the
 * memo holds only versions somebody else's trigger has frozen — but a frozen
 * version is not a frozen COMPOSITION: its translations stay mutable by design
 * (`db/schema/productTypes.ts`), which is exactly why the `localization` subject
 * exists and why it has to be bumped rather than assumed constant.
 */

import {
  ATTRIBUTE_COMPONENT_AXES,
  AUTHORING_SCHEMA_CONTRACT_VERSION,
  AUTHORING_STEP_KINDS,
  MERCARIA_BASE_LOCALE,
  PRODUCT_TYPE_AUTHORING_FLOWS,
  type AuthoringCategoryOption,
  type AuthoringControlledValue,
  type AuthoringField,
  type AuthoringFieldText,
  type AuthoringFieldValidation,
  type AuthoringGroup,
  type AuthoringLocaleContext,
  type AuthoringLocalizedText,
  type AuthoringPermissionContext,
  type AuthoringProductTypeOption,
  type AuthoringProductTypeRef,
  type AuthoringSchema,
  type AuthoringSchemaText,
  type AttributeComponentAxis,
  type AuthoringStep,
  type LocalizedResolution,
  type ProductTypeAuthoringFlow,
  type ProductTypeLifecycle,
  type SupportedLocale,
} from '@mercaria/shared-types';
import { inArray } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { listAttributeEnumValues } from '../../db/attributes/definitionRepository.js';
import { attributeEnumValues } from '../../db/schema/attributeRegistry.js';
import { attributeValueLocalizations } from '../../db/schema/catalogLocalization.js';
import { findCategoryLocalizations } from '../../db/catalogLocalization/categoryLocalizationRepository.js';
import { findProductTypeLocalizations } from '../../db/catalogLocalization/productTypeLocalizationRepository.js';
import {
  listProductTypeFieldGroups,
  listProductTypeFieldAllowedValues,
  listProductTypeFields,
} from '../../db/productTypes/productTypeFieldRepository.js';
import { findProductTypeDefinitionById } from '../../db/productTypes/productTypeRepository.js';
import {
  findCategoryRow,
  findProductTypeVersion,
  findPublishedVersionForKey,
  listAttributeDefinitionsByIds,
  listAttributeLabelsForDefinitions,
  listPublishedProductTypesForCategory,
  listSelectableCategories,
  productTypeIsScopedToCategory,
  type AttributeDefinitionRow,
  type CategoryRow,
  type ProductTypeDefinitionRow,
} from '../../db/catalogAuthoring/schemaSourceRepository.js';
import {
  invalidationKey,
  readAuthoringSchemaRevisions,
  type AuthoringInvalidationRef,
} from '../../db/catalogAuthoring/schemaInvalidationRepository.js';
import { localeFallbackChain } from '../catalog-localization/resolve.js';
// The OBSERVED resolver — see `read-observation.ts` (#367 W17 line 771).
import { resolveObservedLocalizedField } from '../catalog-localization/read-observation.js';
import { authoringEtag, authoringSchemaCacheKey, type AuthoringSchemaKey } from './etag.js';

/** The declared component axes, as a set, for the narrowing below. */
const COMPONENT_AXES: ReadonlySet<string> = new Set(ATTRIBUTE_COMPONENT_AXES);

/**
 * The lifecycles a caller may NAME by `(key, version)` — an ALLOW-list.
 *
 * `?version=` lets any authenticated account address one exact product-type
 * version, and `findProductTypeVersion` filters on `(key, version)` and nothing
 * else. Without this list a `draft` or `review` version — the unlaunched schema
 * of a vertical nobody has announced, with every field, attribute and grouping
 * in it — was served identically to a published one to any buyer or seller who
 * guessed a documented key and a small integer. Keys follow ADR 0007 D1's
 * namespace convention, so guessing is cheap.
 *
 * It is stated POSITIVELY rather than as "not in `PRODUCT_TYPE_EDITABLE_LIFECYCLES`"
 * because the two fail in opposite directions: a fifth lifecycle nobody
 * classified is REFUSED here, and would have been SERVED by a deny-list. The
 * complement relationship the two tuples have today is asserted by
 * `schema-version-lifecycle-exposure.realdb.test.ts`, so adding a lifecycle
 * fails the build until somebody decides which side it belongs on rather than
 * landing on the permissive side in silence.
 *
 * `deprecated` is IN the list and that is not an oversight: a deprecated version
 * still resolves the records that pin it (ADR 0007 D5), which is the same reason
 * `productTypeIsScopedToCategory` deliberately does not filter on `published`.
 * `checkSchemaVersionAvailability` already documents this exact set as what
 * "retrievable" means and derives its own half from the complement — the claim
 * it makes about this function is what this list makes true.
 */
export const RETRIEVABLE_AUTHORING_LIFECYCLES: readonly ProductTypeLifecycle[] = [
  'published',
  'deprecated',
];

/** What a caller asks for. Every member is a semantic dimension of the key. */
export interface ComposeAuthoringSchemaInput {
  readonly productTypeKey: string;
  /** An exact version, or absent for the currently published one. */
  readonly version?: number;
  readonly categoryId: string;
  readonly flow: ProductTypeAuthoringFlow;
  readonly requestedLocale: string;
  readonly market: string;
  readonly permissions: AuthoringPermissionContext;
}

/** Why a composition was refused. A closed set; a client never matches on text. */
export type AuthoringSchemaRefusal =
  | 'product_type_not_found'
  | 'category_not_found'
  | 'category_not_selectable'
  | 'category_not_in_product_type_scope'
  | 'flow_declares_no_field';

/**
 * The outcome. A STRING discriminant, and the refused branch carries no
 * `schema` — a caller cannot reach a composition it did not get. The backend
 * compiles with `strict: false`, where a boolean discriminant narrows nothing
 * (#68's finding), so every union in this domain is spelled this way.
 */
export type AuthoringSchemaComposition =
  | { readonly outcome: 'composed'; readonly schema: AuthoringSchema }
  | { readonly outcome: 'refused'; readonly refusal: AuthoringSchemaRefusal; readonly detail: string };

function refused(refusal: AuthoringSchemaRefusal, detail: string): AuthoringSchemaComposition {
  return { outcome: 'refused', refusal, detail };
}

/**
 * The memo, holding ONLY compositions over a published, frozen version.
 *
 * Process-local, and that is safe for one reason and one reason only: its key
 * carries the invalidation revisions, so a stale entry cannot be looked up. It
 * is a latency optimization over a correctness mechanism that lives in Postgres,
 * which is the opposite of the process-local cache ADR 0007 D10 forbids.
 *
 * Bounded, and it drops the OLDEST — an unbounded memo on a per-locale,
 * per-market, per-permission key is a slow leak whose symptom is a task dying
 * hours later with no line pointing here.
 */
const memo = new Map<string, AuthoringSchema>();
const MEMO_MAX_ENTRIES = 512;

function remember(key: string, schema: AuthoringSchema): void {
  if (memo.size >= MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (oldest.done !== true) memo.delete(oldest.value);
  }
  memo.set(key, schema);
}

/** Test seam: the memo is process state and a suite that shares it is not isolated. */
export function clearAuthoringSchemaMemo(): void {
  memo.clear();
}

/**
 * The base-locale answer for a field the localization registry cannot yet
 * describe.
 *
 * #367 step 2 states, in `LOCALIZED_ENTITY_KINDS`' own doc comment, that
 * `attribute_definition` is deliberately absent because `attribute_labels`
 * carries no `status` and no `provenance`, so a candidate built from one of its
 * rows would have to invent both — and `catalog-localization.test.ts` asserts
 * that tuple EXACTLY. So an attribute's label is served in the base locale here,
 * and the coverage counter reports it as unresolved, which is the honest answer:
 * a machine translation reported as approved is the failure that decision avoids.
 *
 * This walks no chain and makes no policy decision — it is the resolver's own
 * base branch, quoted, for the one field class its registry cannot name. Closing
 * the seam is two entries in `CATALOG_LOCALIZED_FIELDS` plus the family columns
 * on `attribute_labels`, in the localization domain, and nothing here changes.
 */
function baseOnlyText(value: string | null | undefined): AuthoringLocalizedText | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return {
    value,
    effectiveLocale: MERCARIA_BASE_LOCALE,
    step: 'base',
    // A base string is not a translation: it is the text the concept was
    // authored in. The resolver states the same two constants for the same
    // reason — so no writer can claim a base string was machine translated.
    status: 'approved',
  };
}

/** A resolver answer, as the DTO carries it. Absence stays absence. */
function toText(resolution: LocalizedResolution): AuthoringLocalizedText | undefined {
  if (resolution.outcome !== 'resolved') return undefined;
  return {
    value: resolution.value,
    effectiveLocale: resolution.effectiveLocale,
    step: resolution.step,
    status: resolution.status,
  };
}

/** The registry facts, projected for one exact version. Nothing here is authored. */
function toValidation(definition: AttributeDefinitionRow): AuthoringFieldValidation {
  return {
    valueType: definition.valueType,
    cardinality: definition.cardinality,
    unitFamily: definition.unitFamily ?? null,
    baseUnit: definition.baseUnit ?? null,
    ratingScaleMax: definition.ratingScaleMax ?? null,
    currency: definition.currency ?? null,
    // NARROWED rather than asserted. The column is `text[]` with a containment
    // CHECK (`attribute_definitions_axes_domain_check`), so every stored element
    // IS a member — but a cast would keep saying so after somebody widened the
    // column, and the filter simply stops emitting what it cannot name.
    componentAxes: definition.componentAxes.filter((axis): axis is AttributeComponentAxis =>
      COMPONENT_AXES.has(axis),
    ),
    minValue: definition.minValue ?? null,
    maxValue: definition.maxValue ?? null,
    decimalPlaces: definition.decimalPlaces ?? null,
    maxLength: definition.maxLength ?? null,
    implausibleAbove: definition.implausibleAbove ?? null,
    implausibleBelow: definition.implausibleBelow ?? null,
  };
}

function toProductTypeRef(row: ProductTypeDefinitionRow): AuthoringProductTypeRef {
  return {
    definitionId: row.id,
    key: row.key,
    version: row.version,
    lifecycle: row.lifecycle,
    pendingProposalPolicy: row.pendingProposalPolicy,
  };
}

/**
 * The ordered steps a surface walks.
 *
 * `canonical_link` is `available` only when the caller may select one, which is
 * the one step whose availability is a PERMISSION rather than a deployment fact.
 * Every other step is always available: a schema that reported "you cannot set a
 * price here" would be describing the money domain, which this one may not read.
 */
function composeSteps(permissions: AuthoringPermissionContext): AuthoringStep[] {
  return AUTHORING_STEP_KINDS.map((kind, index) => ({
    kind,
    position: index,
    available: kind === 'canonical_link' ? permissions.canSelectCanonicalEntity : true,
  }));
}

/**
 * Every mutable subject a composition depends on.
 *
 * Deliberately NOT the product type version or the attribute versions when they
 * are frozen: a subject whose revision could never change is a read that can
 * never inform anything, and putting one in the key would cost a round trip to
 * learn a constant. The `product_type` subject appears only for a version that
 * is still editable, which is also the case the memo refuses outright.
 *
 * `localization` appears TWICE, once per entity whose name this composition
 * resolves through the localization registry (#655). The category half was
 * missing, so approving a category translation moved a revision nothing read —
 * the `category` subject beside it is bumped by taxonomy edits and carries a
 * different meaning, and borrowing it would make one subject mean two things.
 * Both ids cost nothing extra to read: `readAuthoringSchemaRevisions` is ONE
 * statement whatever the ref count.
 */
function invalidationRefs(
  definition: ProductTypeDefinitionRow,
  categoryId: string,
  attributeDefinitionIds: readonly string[],
): AuthoringInvalidationRef[] {
  const refs: AuthoringInvalidationRef[] = [
    { subject: 'category', subjectId: categoryId },
    { subject: 'localization', subjectId: definition.id },
    { subject: 'localization', subjectId: categoryId },
  ];
  for (const id of attributeDefinitionIds) {
    refs.push({ subject: 'attribute_values', subjectId: id });
  }
  if (definition.lifecycle !== 'published' && definition.lifecycle !== 'deprecated') {
    refs.push({ subject: 'product_type', subjectId: definition.id });
  }
  return refs;
}

/**
 * Compose one authoring schema from a caller-supplied `(key, version)`.
 *
 * This is the ONE place a caller NAMES a product-type version, which is why the
 * lifecycle allow-list is applied here rather than inside
 * `findProductTypeVersion`. That repository function promises exactly what its
 * name says — the row at `(key, version)` — and it is the primitive an operator
 * preview or an upgrade path would reach for to look at a `draft` deliberately;
 * a hidden filter inside it would answer such a caller with `null`, which is
 * indistinguishable from "no such version" and would send whoever hit it looking
 * for a missing row rather than a refused one.
 *
 * `composeForDefinition` is deliberately NOT gated: it serves a PINNED
 * definition id, which a draft, a validation and a publish already hold and did
 * not choose. Nothing in this repository composes an editable version through it
 * — `createDraft` refuses a non-published version outright — so the exposure is
 * this function's alone.
 */
export async function composeAuthoringSchema(
  db: DatabaseOrTransaction,
  input: ComposeAuthoringSchemaInput,
): Promise<AuthoringSchemaComposition> {
  const definition =
    input.version === undefined
      ? await findPublishedVersionForKey(db, input.productTypeKey)
      : await findProductTypeVersion(db, input.productTypeKey, input.version);
  // ONE detail string for two different facts, deliberately. A version that does
  // not exist and a version that exists and is still being argued about answer
  // identically, in both the refusal CODE and the sentence — otherwise the
  // refusal is an oracle enumerating the unlaunched verticals, which is most of
  // what the exposure was worth.
  const unavailable =
    input.version === undefined
      ? `No published version of product type "${input.productTypeKey}".`
      : `No version ${input.version} of product type "${input.productTypeKey}".`;
  if (definition === null) {
    return refused('product_type_not_found', unavailable);
  }
  // Unconditional rather than inside the `?version=` branch: the published
  // finder's own filter already satisfies this, so there is no branch here to
  // get wrong, and a change to either finder cannot walk around it.
  if (!RETRIEVABLE_AUTHORING_LIFECYCLES.includes(definition.lifecycle)) {
    return refused('product_type_not_found', unavailable);
  }
  return composeForDefinition(db, definition, input);
}

/**
 * Compose for a version already in hand — the entry a draft uses.
 *
 * Separate from {@link composeAuthoringSchema} rather than reached through it,
 * because a draft PINS a definition id and resolving it back through
 * `(key, version)` would be a second lookup that could answer differently the
 * day somebody deprecates the version.
 */
export async function composeAuthoringSchemaForDefinitionId(
  db: DatabaseOrTransaction,
  definitionId: string,
  input: Omit<ComposeAuthoringSchemaInput, 'productTypeKey' | 'version'>,
): Promise<AuthoringSchemaComposition> {
  const definition = await findProductTypeDefinitionById(db, definitionId);
  if (definition === null) {
    return refused('product_type_not_found', `No product type version ${definitionId}.`);
  }
  return composeForDefinition(db, definition, input);
}

async function composeForDefinition(
  db: DatabaseOrTransaction,
  definition: ProductTypeDefinitionRow,
  input: Omit<ComposeAuthoringSchemaInput, 'productTypeKey' | 'version'>,
): Promise<AuthoringSchemaComposition> {
  const category = await findCategoryRow(db, input.categoryId);
  if (category === null) {
    return refused('category_not_found', `No category ${input.categoryId}.`);
  }
  if (!category.selectable) {
    return refused(
      'category_not_selectable',
      `"${category.key}" is a structural node, so a product may not be filed under it (ADR 0007 D2).`,
    );
  }
  const scoped = await productTypeIsScopedToCategory(db, definition.id, category.id);
  if (!scoped) {
    return refused(
      'category_not_in_product_type_scope',
      `${definition.key} v${definition.version} is not scoped to "${category.key}".`,
    );
  }

  const [groups, fields] = await Promise.all([
    listProductTypeFieldGroups(db, definition.id),
    listProductTypeFields(db, definition.id, input.flow),
  ]);
  if (fields.length === 0) {
    return refused(
      'flow_declares_no_field',
      `${definition.key} v${definition.version} declares no field in the "${input.flow}" flow.`,
    );
  }

  const attributeDefinitionIds = [...new Set(fields.map((field) => field.attributeDefinitionId))];
  const refs = invalidationRefs(definition, category.id, attributeDefinitionIds);
  const revisions = await readAuthoringSchemaRevisions(db, refs);
  const renderedRevisions = refs.map(
    (ref) => `${invalidationKey(ref)}=${revisions.get(invalidationKey(ref)) ?? 0}`,
  );

  const key: AuthoringSchemaKey = {
    productTypeDefinitionId: definition.id,
    // #611: `published` and `deprecated` share every other member, so without
    // this the memo serves a deprecated version as published.
    lifecycle: definition.lifecycle,
    categoryId: category.id,
    flow: input.flow,
    locale: input.requestedLocale,
    market: input.market,
    permissionFingerprint: fingerprintPermissions(input.permissions),
    revisions: renderedRevisions,
  };
  const cacheKey = authoringSchemaCacheKey(key);
  // Only a FROZEN version may be memoized. `published` and `deprecated` are both
  // immutable by trigger; `draft` and `review` are the states in which a schema
  // is still being argued about, and the only honest cache lifetime for one is
  // zero.
  const memoizable = definition.lifecycle === 'published' || definition.lifecycle === 'deprecated';
  if (memoizable) {
    const hit = memo.get(cacheKey);
    if (hit !== undefined) return { outcome: 'composed', schema: hit };
  }

  const [definitions, enumValues, allowedValues] = await Promise.all([
    listAttributeDefinitionsByIds(db, attributeDefinitionIds),
    listAttributeEnumValues(db, attributeDefinitionIds),
    listProductTypeFieldAllowedValues(db, fields.map((field) => field.id)),
  ]);
  const definitionById = new Map(definitions.map((row) => [row.id, row]));

  const valuesByDefinition = new Map<string, AuthoringControlledValue[]>();
  for (const value of enumValues) {
    const bucket = valuesByDefinition.get(value.attributeDefinitionId) ?? [];
    bucket.push({ id: value.id, value: value.value, position: value.position });
    valuesByDefinition.set(value.attributeDefinitionId, bucket);
  }

  /**
   * The permitted subset per field, or ABSENT for a field nobody narrowed
   * (#367 W7, epic line 235).
   *
   * `undefined` and an empty set are kept apart deliberately: absence means the
   * field permits every value its definition defines, which is the state of
   * every field that has ever existed. An empty subset is unrepresentable — a
   * row IS a permission, so "permits none" has no shape — and collapsing the two
   * would make the first deploy of this table offer nothing anywhere. See the
   * table's own doc.
   */
  const permittedByField = new Map<string, Set<string>>();
  for (const row of allowedValues) {
    const bucket = permittedByField.get(row.productTypeFieldId) ?? new Set<string>();
    bucket.add(row.attributeEnumValueId);
    permittedByField.set(row.productTypeFieldId, bucket);
  }

  const composedGroups: AuthoringGroup[] = groups.map((group) => ({
    id: group.id,
    key: group.key,
    position: group.position,
  }));

  const composedFields: AuthoringField[] = [];
  for (const field of fields) {
    const attribute = definitionById.get(field.attributeDefinitionId);
    // A field whose cited definition is gone cannot be composed, and skipping it
    // silently would produce a form missing a required question with every
    // surface reporting success. `product_type_fields.attribute_definition_id`
    // is `restrict`, so this is unreachable — which is exactly why it must not
    // be a silent `continue`.
    if (attribute === undefined) {
      return refused(
        'product_type_not_found',
        `${definition.key} v${definition.version} cites attribute definition ${field.attributeDefinitionId}, which does not exist.`,
      );
    }
    composedFields.push({
      id: field.id,
      key: field.attributeKey,
      attributeDefinitionId: field.attributeDefinitionId,
      attributeVersion: field.attributeDefinitionVersion,
      scope: field.scope,
      requirement: field.requirement,
      valuePolicy: field.valuePolicy,
      variantCapable: field.variantCapable,
      groupId: field.groupId ?? null,
      position: field.position,
      visibilityRule: field.visibilityRule ?? null,
      validation: toValidation(attribute),
      // NARROWED by the field's subset when it has one, and the registry's own
      // order is preserved because `definitionValues` is already ordered by
      // `attribute_enum_values.position` — the subset says WHICH values, never
      // in what order, so there is only ever one ordering authority.
      controlledValues: permittedValues(
        valuesByDefinition.get(field.attributeDefinitionId) ?? [],
        permittedByField.get(field.id),
      ),
    });
  }

  const text = await composeText(db, {
    definition,
    category,
    requestedLocale: input.requestedLocale,
    fields: composedFields,
    groups,
    definitionById,
    // The values the composed fields actually RENDER, not every value of every
    // cited definition. Before subsets existed the two sets were identical; now
    // a narrowed field must not pull localized labels for values no form shows,
    // and the union is taken across fields because two fields citing one
    // definition may permit different subsets of it.
    enumValueIds: composedFields.flatMap((field) =>
      field.controlledValues.map((value) => value.id),
    ),
  });

  const body = {
    contractVersion: AUTHORING_SCHEMA_CONTRACT_VERSION,
    productType: toProductTypeRef(definition),
    categoryId: category.id,
    flow: input.flow,
    market: input.market,
    locale: text.locale,
    permissions: input.permissions,
    steps: composeSteps(input.permissions),
    groups: composedGroups,
    fields: composedFields,
    text: text.text,
  };
  const schema: AuthoringSchema = { ...body, etag: authoringEtag(key, body) };
  if (memoizable) remember(cacheKey, schema);
  return { outcome: 'composed', schema };
}

/**
 * A stable, short summary of what this caller may do.
 *
 * The four booleans in a fixed order, so two callers with the same effective
 * answer share a cache entry and a caller whose role changed does not. It is
 * NOT the caller's identity: putting an Oxy account id in the key would give
 * every merchant their own copy of a schema that is identical for all of them.
 */
export function fingerprintPermissions(permissions: AuthoringPermissionContext): string {
  return [
    permissions.canEditDraft ? '1' : '0',
    permissions.canPublish ? '1' : '0',
    permissions.canProposeValues ? '1' : '0',
    permissions.canSelectCanonicalEntity ? '1' : '0',
  ].join('');
}

interface ComposeTextInput {
  readonly definition: ProductTypeDefinitionRow;
  readonly category: CategoryRow;
  readonly requestedLocale: string;
  readonly fields: readonly AuthoringField[];
  readonly groups: readonly { readonly id: string; readonly label: string }[];
  readonly definitionById: ReadonlyMap<string, AttributeDefinitionRow>;
  readonly enumValueIds: readonly string[];
}

/**
 * Every localized string in one response — three statements, whatever the field
 * count.
 *
 * The locale narrowing uses the `language_then_base` chain, which is a SUPERSET
 * of the `exact_locale_then_base` and `exact_locale_only` ones, so a field whose
 * class forbids cross-market fallback is still READ and still refused by the
 * resolver applying its own shorter plan. Narrowing on a shorter one is the
 * dangerous direction: the resolver would answer `no_text_in_locale` for text
 * that exists, and nothing would say so. That reasoning is `read.service.ts`'s
 * and is quoted here because
 * this file issues its own reads rather than calling it — the category read
 * there resolves a slug this surface has no use for, and a schema needs the
 * attribute labels it does not carry.
 */
/**
 * The values a field permits: its subset when it has one, every value otherwise.
 *
 * PURE, and separated from the composition so the empty-versus-absent decision
 * has one place a test can drive and one place a reader can check. The filter
 * preserves `definitionValues`' order, which is the registry's own — a subset
 * narrows WHICH values, never their order.
 *
 * A subset naming a value the definition no longer defines contributes nothing
 * rather than a hole: the intersection is taken over the registry's rows, so a
 * stale row cannot conjure a value into a form. It cannot arise today —
 * `product_type_field_allowed_values` pins the value and its owning definition
 * with one composite key — and the filter direction is what keeps that true if
 * it ever could.
 */
function permittedValues(
  definitionValues: readonly AuthoringControlledValue[],
  permitted: ReadonlySet<string> | undefined,
): AuthoringControlledValue[] {
  if (permitted === undefined) return [...definitionValues];
  return definitionValues.filter((value) => permitted.has(value.id));
}

async function composeText(
  db: DatabaseOrTransaction,
  input: ComposeTextInput,
): Promise<{ text: AuthoringSchemaText; locale: AuthoringLocaleContext }> {
  const chain = localeFallbackChain(input.requestedLocale, 'language_then_base');
  const attributeDefinitionIds = [...input.definitionById.keys()];

  const [productTypeRows, categoryRows, attributeLabelRows, valueLocalizations] = await Promise.all([
    findProductTypeLocalizations([input.definition.id], chain as readonly SupportedLocale[], db),
    findCategoryLocalizations([input.category.id], chain as readonly SupportedLocale[], db),
    listAttributeLabelsForDefinitions(db, attributeDefinitionIds, chain),
    readLocalizedValueLabels(db, input.enumValueIds, chain),
  ]);

  const productTypeName = toText(
    resolveObservedLocalizedField({
      field: 'product_type.name',
      requestedLocale: input.requestedLocale,
      candidates: productTypeRows.map((row) => ({
        locale: row.locale,
        status: row.status,
        provenance: row.provenance,
        value: row.name,
      })),
      baseValue: input.definition.name,
    }),
  );
  const productTypeDescription = toText(
    resolveObservedLocalizedField({
      field: 'product_type.description',
      requestedLocale: input.requestedLocale,
      candidates: productTypeRows.map((row) => ({
        locale: row.locale,
        status: row.status,
        provenance: row.provenance,
        value: row.description,
      })),
      baseValue: input.definition.description,
    }),
  );
  const categoryName = toText(
    resolveObservedLocalizedField({
      field: 'category.name',
      requestedLocale: input.requestedLocale,
      candidates: categoryRows.map((row) => ({
        locale: row.locale,
        status: row.status,
        provenance: row.provenance,
        value: row.name,
      })),
      baseValue: input.category.name,
    }),
  );

  // Attribute labels: base locale only. See `baseOnlyText`.
  const labelByDefinitionAndLocale = new Map<string, { label: string; description: string | null }>();
  for (const row of attributeLabelRows) {
    labelByDefinitionAndLocale.set(`${row.attributeDefinitionId}:${row.locale}`, {
      label: row.label,
      description: row.description,
    });
  }

  const fieldText: Record<string, AuthoringFieldText> = {};
  for (const field of input.fields) {
    const attribute = input.definitionById.get(field.attributeDefinitionId);
    if (attribute === undefined) continue;
    // The chain is walked for the LABEL rows because they exist and are useful
    // even though the registry cannot describe their provenance; what is NOT
    // done is claiming a status for one. A row found in the requested locale is
    // still reported with `step: 'base'` and `status: 'approved'` — the honest
    // reading of a table that records neither — and the coverage counter below
    // counts it as unresolved so an operator sees the gap rather than a
    // confident 100%.
    let label = baseOnlyText(attribute.label);
    let help = baseOnlyText(attribute.description);
    for (const locale of chain) {
      const row = labelByDefinitionAndLocale.get(`${attribute.id}:${locale}`);
      if (row === undefined) continue;
      label = baseOnlyText(row.label) ?? label;
      help = baseOnlyText(row.description) ?? help;
      break;
    }
    fieldText[field.id] = {
      ...(label === undefined ? {} : { label }),
      ...(help === undefined ? {} : { help }),
      // `placeholder` and `example` are modelled because ADR 0007 D10 names
      // them, and they used to be ABSENT here because no table in this
      // repository carried one — "the field arrives when a column does".
      //
      // THE COLUMNS NOW EXIST: `product_type_fields.placeholder`/`.example`
      // hold the base-locale text and `product_type_field_localizations`
      // holds the translations. They are still not emitted HERE, and that is
      // now a wiring gap rather than a modelling one: this function reads its
      // field text from the cited ATTRIBUTE's `attribute_labels` rows, which
      // have no placeholder or example to give it, and reading the new tables
      // means a new query and a fallback-chain resolution per field.
      //
      // Deliberately left to the change that adds that read, so this stays a
      // NAMED seam rather than a comment asserting an absence that is no
      // longer true. The original reasoning still stands and still binds
      // whoever wires it: an invented example is a claim about a product
      // nobody made, so an absent column stays absent from the response —
      // it never becomes a plausible default.
    };
  }

  const groupText: Record<string, { label?: AuthoringLocalizedText }> = {};
  for (const group of input.groups) {
    const label = baseOnlyText(group.label);
    groupText[group.id] = label === undefined ? {} : { label };
  }

  const valueText: Record<string, { label?: AuthoringLocalizedText }> = {};
  for (const [valueId, resolution] of valueLocalizations) {
    const label = toText(resolution);
    valueText[valueId] = label === undefined ? {} : { label };
  }

  // Coverage counts the strings that resolved in the REQUESTED locale over the
  // strings emitted — the vacuity floor of a localization surface. Without it
  // "we have no Spanish" and "we did not look" render identically.
  const emitted: (AuthoringLocalizedText | undefined)[] = [
    productTypeName,
    productTypeDescription,
    categoryName,
    ...Object.values(fieldText).flatMap((entry) => [entry.label, entry.help]),
    ...Object.values(valueText).map((entry) => entry.label),
  ];
  const present = emitted.filter((entry): entry is AuthoringLocalizedText => entry !== undefined);
  const requested = chain[0] ?? MERCARIA_BASE_LOCALE;
  const resolvedInRequested = present.filter((entry) => entry.effectiveLocale === requested).length;

  return {
    text: {
      ...(productTypeName === undefined ? {} : { productTypeName }),
      ...(productTypeDescription === undefined ? {} : { productTypeDescription }),
      ...(categoryName === undefined ? {} : { categoryName }),
      groups: groupText,
      fields: fieldText,
      values: valueText,
    },
    locale: {
      requestedLocale: requested,
      effectiveLocale: categoryName?.effectiveLocale ?? MERCARIA_BASE_LOCALE,
      step: categoryName?.step ?? 'base',
      coverage: { resolvedInRequestedLocale: resolvedInRequested, total: present.length },
    },
  };
}

/**
 * Controlled-value labels, resolved through the family's own resolver.
 *
 * Its own function rather than a call to `read.service.ts`'s
 * `readLocalizedAttributeValues` because that one re-reads
 * `attribute_enum_values` to obtain the base label — a statement this
 * composition has already issued. Two reads of one table in one request is the
 * N+1 this whole file is arranged to avoid, and the resolution itself is
 * `resolve.ts`'s either way.
 */
async function readLocalizedValueLabels(
  db: DatabaseOrTransaction,
  enumValueIds: readonly string[],
  chain: readonly string[],
): Promise<Map<string, LocalizedResolution>> {
  const resolved = new Map<string, LocalizedResolution>();
  if (enumValueIds.length === 0) return resolved;

  const [baseRows, localizationRows] = await Promise.all([
    db
      .select({ id: attributeEnumValues.id, label: attributeEnumValues.label })
      .from(attributeEnumValues)
      .where(inArray(attributeEnumValues.id, [...enumValueIds])),
    db
      .select()
      .from(attributeValueLocalizations)
      .where(inArray(attributeValueLocalizations.attributeEnumValueId, [...enumValueIds])),
  ]);

  const candidatesByValue = new Map<
    string,
    { locale: string; status: LocalizedCandidateStatus; provenance: LocalizedCandidateProvenance; value: string | null }[]
  >();
  for (const row of localizationRows) {
    if (!chain.includes(row.locale)) continue;
    const bucket = candidatesByValue.get(row.attributeEnumValueId) ?? [];
    bucket.push({
      locale: row.locale,
      status: row.status,
      provenance: row.provenance,
      value: row.label,
    });
    candidatesByValue.set(row.attributeEnumValueId, bucket);
  }

  for (const base of baseRows) {
    resolved.set(
      base.id,
      resolveObservedLocalizedField({
        field: 'attribute_value.label',
        requestedLocale: chain[0] ?? MERCARIA_BASE_LOCALE,
        candidates: candidatesByValue.get(base.id) ?? [],
        baseValue: base.label,
      }),
    );
  }
  return resolved;
}

// Off the OBSERVED resolver, whose signature is the pure one's unchanged — so
// these describe exactly what this serving path passes, and a widening of the
// pure resolver that the wrapper did not adopt would be a type error here.
type LocalizedCandidateStatus =
  Parameters<typeof resolveObservedLocalizedField>[0]['candidates'][number]['status'];
type LocalizedCandidateProvenance = Parameters<
  typeof resolveObservedLocalizedField
>[0]['candidates'][number]['provenance'];

/* -------------------------------------------------------------------------- */
/* The classification reads                                                    */
/* -------------------------------------------------------------------------- */

/** `GET /catalog-authoring/categories` — the categories a product may be filed under. */
export async function listAuthoringCategories(
  db: DatabaseOrTransaction,
  options: { parentId?: string | null; requestedLocale: string; limit: number },
): Promise<AuthoringCategoryOption[]> {
  const rows = await listSelectableCategories(db, {
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    limit: options.limit,
  });
  if (rows.length === 0) return [];

  const chain = localeFallbackChain(options.requestedLocale, 'language_then_base');
  const localizations = await findCategoryLocalizations(
    rows.map((row) => row.id),
    chain as readonly SupportedLocale[],
    db,
  );
  const byCategory = new Map<string, { locale: string; status: LocalizedCandidateStatus; provenance: LocalizedCandidateProvenance; value: string | null }[]>();
  for (const row of localizations) {
    const bucket = byCategory.get(row.categoryId) ?? [];
    bucket.push({
      locale: row.locale,
      status: row.status,
      provenance: row.provenance,
      value: row.name,
    });
    byCategory.set(row.categoryId, bucket);
  }

  return rows.map((row) => {
    const name = toText(
      resolveObservedLocalizedField({
        field: 'category.name',
        requestedLocale: options.requestedLocale,
        candidates: byCategory.get(row.id) ?? [],
        baseValue: row.name,
      }),
    );
    return {
      id: row.id,
      key: row.key,
      parentId: row.parentId ?? null,
      ancestorIds: row.ancestorIds,
      selectable: row.selectable,
      position: row.position,
      ...(name === undefined ? {} : { name }),
    };
  });
}

/** `GET /catalog-authoring/product-types?categoryId=` — what may be authored here. */
export async function listAuthoringProductTypes(
  db: DatabaseOrTransaction,
  options: { categoryId: string; requestedLocale: string },
): Promise<AuthoringProductTypeOption[]> {
  const scoped = await listPublishedProductTypesForCategory(db, options.categoryId);
  if (scoped.length === 0) return [];

  const chain = localeFallbackChain(options.requestedLocale, 'language_then_base');
  const localizations = await findProductTypeLocalizations(
    scoped.map((entry) => entry.definition.id),
    chain as readonly SupportedLocale[],
    db,
  );
  const byDefinition = new Map<string, { locale: string; status: LocalizedCandidateStatus; provenance: LocalizedCandidateProvenance; value: string | null }[]>();
  for (const row of localizations) {
    const bucket = byDefinition.get(row.productTypeDefinitionId) ?? [];
    bucket.push({
      locale: row.locale,
      status: row.status,
      provenance: row.provenance,
      value: row.name,
    });
    byDefinition.set(row.productTypeDefinitionId, bucket);
  }

  return scoped.map((entry) => {
    const name = toText(
      resolveObservedLocalizedField({
        field: 'product_type.name',
        requestedLocale: options.requestedLocale,
        candidates: byDefinition.get(entry.definition.id) ?? [],
        baseValue: entry.definition.name,
      }),
    );
    return {
      definitionId: entry.definition.id,
      key: entry.definition.key,
      version: entry.definition.version,
      includeDescendants: entry.includeDescendants,
      ...(name === undefined ? {} : { name }),
    };
  });
}

/** The flows this deployment composes for. Exported so a schema test can walk them. */
export const AUTHORING_FLOWS: readonly ProductTypeAuthoringFlow[] = PRODUCT_TYPE_AUTHORING_FLOWS;
