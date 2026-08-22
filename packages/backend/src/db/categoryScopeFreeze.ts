/**
 * Which tables may say something CATEGORY-SPECIFIC about a versioned catalog
 * contract, and what stops one being edited after that contract is frozen —
 * the declared half of epic #367 line 143, *"Support category-specific
 * overrides only through explicit, versioned rules."*
 *
 * ## The two boxes above line 143 are what this is about
 *
 * *"Model category-to-product-type eligibility explicitly"* is
 * `product_type_category_scopes`, and *"Model category-level inherited
 * attribute capabilities without copying definitions into every descendant"* is
 * `attribute_definition_categories` — a scope row plus its `include_descendants`
 * flag, which IS the inheritance rule (`schema/attributeRegistry.ts`). Both say
 * "under THIS category, this contract applies / applies differently", and both
 * hang off a version that is frozen once published. Line 143's load-bearing
 * word is **only**: a rule that is versioned, plus a second path that edits it
 * after the freeze, satisfies neither the word nor the intent.
 *
 * ## The population is DERIVED and the disposition is DECLARED
 *
 * `merge-plan.ts`'s arrangement and `commerceHistoryDispositions.ts`'s, for the
 * reason both give: completeness is the one thing nobody verifies by reading a
 * schema, because finding fewer category-scoped tables looks exactly like there
 * BEING fewer. {@link deriveCategoryScopedDefinitionTables} walks the drizzle
 * schema for every table that names BOTH a category and a versioned definition,
 * and `category-scope-freeze-census.test.ts` asserts this list covers EXACTLY
 * that set — so a new table joining the population fails the build until
 * somebody decides what happens to it, at the moment the reference is added.
 *
 * A **versioned definition** is itself derived rather than named: a table whose
 * identity is a UNIQUE over a `*key` column and a `*version` column — the
 * `fee_schedules` idiom this repository uses everywhere for "editable until it
 * is published, then frozen". The spelling is deliberately loose because the key
 * column is `key` on two of them and `schedule_key`, `policy_key`,
 * `version_key`, `cohort_key`, `plan_key` on the rest, and a rule keyed on the
 * literal name `key` would find only the two.
 *
 * That was measured rather than assumed, at three widths. The strict
 * `(key, version)` reading finds 2 tables; the loose spelling finds 14
 * (`fee_schedules`, `ranking_policy_versions`, `retail_eligibility_policies`,
 * `analytics_experiments` and the rest) and gives the SAME five-table
 * population; and accepting a wider unique that merely CONTAINS both columns
 * finds 23 and adds exactly one table, `navigation_nodes`, which is a subject.
 * So the FROZEN set is two under every reading. The loose spelling is what
 * ships because it costs nothing and the strict one would silently miss the
 * first policy family to grow a category scope; the widest is not the default
 * because it pulls in mapping and acceptance rows that carry a version column
 * without being a contract — and the census asserts it adds no RULE, so the day
 * that stops being true is a red build rather than a silent omission.
 *
 * ## `subject` is a decision, and it is CHECKABLE
 *
 * Three of the five members carry a category and a definition because they ARE
 * the thing being authored — a listing, an authoring draft, a proposal. Their
 * definition column is a CITATION of what that one subject was authored under,
 * not a statement about the category. Silence would not be a decision, and
 * neither would a sentence: the census asserts the mechanical consequence, that
 * a `subject` table has **no unique over (definition, category)** while every
 * `frozen_with_its_version` table has exactly that. One row per (version,
 * category) is what makes a row a RULE; one row per subject is what makes it a
 * subject. Both directions are asserted, so mislabelling either way is red.
 *
 * ## And the declaration is EXECUTED, never taken on trust
 *
 * `category-scope-freeze.realdb.test.ts` builds a real parent in each member's
 * own vocabulary, publishes it, and attempts INSERT, UPDATE and DELETE against
 * the scope row — requiring the named trigger to refuse each one, and requiring
 * the same three writes to SUCCEED while the parent is still a draft. A trigger
 * that exists and permits everything reads identically to one that works, and
 * `pg_trigger` cannot tell them apart.
 *
 * ## What is deliberately NOT in this population
 *
 * `condition_category_policies` (#90) is a category-specific restriction —
 * explicit, with a mandatory reason, a named operator and a closed vocabulary —
 * and it is **not versioned**: it has no version column, no version parent and
 * an in-place upsert plus a delete on `/internal/catalog-condition/category-policies`
 * (`db/condition/conditionPolicyRepository.ts`). It is outside this population
 * by the derivation and not by an exemption, because it overrides no versioned
 * contract; versioning it needs a ruleset table the condition domain owns.
 * Tracked separately rather than widened into here, where it would be a hand
 * entry outside the walk.
 */

import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

/** What happens to a category-scoped row when its definition version is frozen. */
export type CategoryScopeDisposition =
  /**
   * One row per (version, category), frozen with the version by `trigger`:
   * INSERT, UPDATE and DELETE are all refused once the parent leaves draft, so
   * changing what a published contract says under a category means publishing a
   * new version.
   */
  | {
      readonly table: string;
      readonly kind: 'frozen_with_its_version';
      readonly parentTable: string;
      readonly trigger: string;
      readonly why: string;
    }
  /**
   * The row IS the authored subject; its definition column cites what that one
   * subject was authored under and says nothing about the category. Asserted by
   * the ABSENCE of a (definition, category) unique.
   */
  | {
      readonly table: string;
      readonly kind: 'subject_not_a_rule';
      readonly why: string;
    };

/**
 * Every table that names both a category and a versioned catalog definition.
 *
 * Ordered by table name so a diff of this file reads as a diff of the schema.
 */
export const CATEGORY_SCOPE_DISPOSITIONS: readonly CategoryScopeDisposition[] = [
  {
    table: 'attribute_definition_categories',
    kind: 'frozen_with_its_version',
    parentTable: 'attribute_definitions',
    trigger: 'attribute_definition_categories_frozen',
    why:
      'The category SCOPE of an attribute definition version, plus `include_descendants`, ' +
      'which is the inheritance rule itself. Frozen for the reason the sibling ' +
      '`attribute_enum_values_frozen` gives one table over: a scope that could change after ' +
      'publication would let a published definition silently start or stop applying under a ' +
      'category, and every stored value authored under it was authored on the old answer.',
  },
  {
    table: 'catalog_authoring_drafts',
    kind: 'subject_not_a_rule',
    why:
      'One in-progress authored product. `category_id` is where the seller is filing it and ' +
      '`product_type_definition_id` is the version they opened, pinned beside `schema_hash` ' +
      'and `schema_snapshot`. A draft may be re-pointed at another category while it is a ' +
      'draft, which is the whole point of one.',
  },
  {
    table: 'catalog_proposals',
    kind: 'subject_not_a_rule',
    why:
      'One request for a missing concept (ADR 0007 D9). Both definition columns are the ' +
      'context the proposal was raised in; approving it mints a NEW version through ' +
      '`version-carry-forward.ts` rather than editing the one cited here.',
  },
  {
    table: 'listings',
    kind: 'subject_not_a_rule',
    why:
      "The seller's own product. `category_id` is its primary filing (`docs/taxonomy.md`) and " +
      '`product_type_definition_id` is the version it was authored under — a pin, so that ' +
      'editing a published version cannot reinterpret it. Neither is a statement about the ' +
      'category, and a listing is re-categorised through the catalog write chokepoint.',
  },
  {
    table: 'product_type_category_scopes',
    kind: 'frozen_with_its_version',
    parentTable: 'product_type_definitions',
    trigger: 'product_type_category_scopes_frozen',
    why:
      'Which categories a product type version may be authored under. ADR 0007 D2 assigns this ' +
      'table to the PRODUCT-TYPE domain precisely so it sits inside the version freeze, and ' +
      'names the alternative: "the hole would be exactly where somebody later widens a ' +
      "published version's scope, which is the one edit the immutability guarantee exists to " +
      'refuse."',
  },
];

/** A table in the population, as the walk reports it. */
export interface CategoryScopedDefinitionTable {
  readonly table: string;
  /** The single-column foreign keys onto a versioned definition table. */
  readonly definitionColumns: readonly string[];
  /** The single-column foreign keys onto `categories`. */
  readonly categoryColumns: readonly string[];
  /** True when some UNIQUE covers exactly one definition column and one category column. */
  readonly hasScopeUnique: boolean;
}

/** `key`, `scheduleKey`, `policy_key`, `versionKey` — the identity half. */
const KEY_COLUMN = /(?:^|_|[a-z])[Kk]ey$/u;
/** `version`, `attributeDefinitionVersion`, `policy_version` — the ordinal half. */
const VERSION_COLUMN = /(?:^|_|[a-z])[Vv]ersion$/u;

/**
 * A table whose identity is `(<something>key, <something>version)` — the shape
 * `fee_schedules` (#88), `attribute_definitions` (#94) and
 * `product_type_definitions` (ADR 0007 D5) all use for "a version is editable
 * until it is published, and then it is frozen".
 *
 * Derived rather than listed so a versioned contract that grows a category
 * scope joins the population on the commit that adds the reference, rather than
 * when somebody remembers this file exists.
 */
export function deriveVersionedDefinitionTables(
  schemaModule: Record<string, unknown>,
  /**
   * `identity` (the default) wants the key and the version to BE the unique —
   * a table whose identity is that pair. `any` accepts a wider unique that
   * merely contains both, which catches a contract versioned per market and
   * locale (`navigation_trees` is `(key, market, locale, version)`).
   *
   * The default is the narrow one because it is what "a version of this
   * contract" means, and the wide reading pulls in mapping and acceptance rows
   * that carry a version column without being a contract. The census pins the
   * consequence rather than leaving it to taste: under `any` the population
   * gains exactly one table and it is a SUBJECT, so the FROZEN set is the same
   * under both — measured, and red if that ever stops being true.
   */
  options: { readonly arity?: 'identity' | 'any' } = {},
): ReadonlySet<string> {
  const exact = (options.arity ?? 'identity') === 'identity';
  const found = new Set<string>();
  for (const table of tablesOf(schemaModule)) {
    const config = getTableConfig(table);
    for (const columns of uniqueColumnSets(table)) {
      if (exact && columns.length !== 2) continue;
      if (
        columns.some((name) => KEY_COLUMN.test(name)) &&
        columns.some((name) => VERSION_COLUMN.test(name))
      ) {
        found.add(config.name);
      }
    }
  }
  return found;
}

/**
 * Every table naming BOTH a versioned definition and a category.
 *
 * Reads `getTableConfig(...).foreignKeys`, which is drizzle's own reflection of
 * the DDL it emits, so this cannot disagree with the migration the way a grep
 * over source could.
 */
export function deriveCategoryScopedDefinitionTables(
  schemaModule: Record<string, unknown>,
  /** The versioned set, injectable so a test can drive the walk with another one. */
  versionedTables?: ReadonlySet<string>,
): readonly CategoryScopedDefinitionTable[] {
  const versioned = versionedTables ?? deriveVersionedDefinitionTables(schemaModule);
  const out: CategoryScopedDefinitionTable[] = [];
  for (const table of tablesOf(schemaModule)) {
    const config = getTableConfig(table);
    const definitionColumns: string[] = [];
    const categoryColumns: string[] = [];
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const parent = getTableName(reference.foreignTable);
      // Only single-column keys: a composite citation is a JOIN back to a
      // parent row, never the "(version, category)" pair this is about.
      if (reference.columns.length !== 1) continue;
      const column = reference.columns[0];
      if (column === undefined) continue;
      if (versioned.has(parent) && parent !== config.name) definitionColumns.push(column.name);
      if (parent === 'categories' && parent !== config.name) categoryColumns.push(column.name);
    }
    if (definitionColumns.length === 0 || categoryColumns.length === 0) continue;
    const hasScopeUnique = uniqueColumnSets(table).some(
      (columns) =>
        columns.length === 2 &&
        definitionColumns.some((name) => columns.includes(name)) &&
        categoryColumns.some((name) => columns.includes(name)),
    );
    out.push({
      table: config.name,
      definitionColumns: [...definitionColumns].sort(),
      categoryColumns: [...categoryColumns].sort(),
      hasScopeUnique,
    });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

/** Every drizzle table the barrel exports — the set drizzle-kit emits DDL for. */
function tablesOf(schemaModule: Record<string, unknown>): PgTable[] {
  return Object.values(schemaModule).flatMap((value) => (is(value, PgTable) ? [value] : []));
}

/**
 * Every UNIQUE over a table, as sorted column-name lists.
 *
 * Both spellings, because drizzle models them separately and this repository
 * uses both: `unique(...)` lands in `uniqueConstraints` and `uniqueIndex(...)`
 * in `indexes` with `unique: true`. Reading only one of them would report
 * `product_type_category_scopes` — a `uniqueIndex` — as having no scope unique
 * at all, and the census would then mark the very table it exists to protect as
 * a subject.
 */
function uniqueColumnSets(table: PgTable): readonly string[][] {
  const config = getTableConfig(table);
  const fromConstraints = config.uniqueConstraints.map((constraint) =>
    constraint.columns.map((column) => column.name).sort(),
  );
  const fromIndexes = config.indexes
    .filter((index) => index.config.unique)
    .map((index) =>
      index.config.columns
        .flatMap((column) => ('name' in column ? [String(column.name)] : []))
        .sort(),
    );
  return [...fromConstraints, ...fromIndexes];
}
