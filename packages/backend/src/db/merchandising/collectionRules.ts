/**
 * The automated-collection rule translator: `{field, operator, value}` → SQL.
 *
 * A pure function of the rule rows, deliberately separated from
 * `collectionRepository` so every operator can be table-tested without a
 * database, and from `collection.service` so no service holds SQL.
 *
 * Three properties are load-bearing and each replaces a Mongo mechanism:
 *
 *  - **A `contains` / `starts_with` / `ends_with` needle is ESCAPED.** Mongo used
 *    `$regex` with `escapeRegExp`; the Postgres analogue is `ILIKE` with `%`, `_`
 *    and `\` escaped. Skipping it makes a rule for a product type containing an
 *    underscore silently match one character of anything, and a rule containing
 *    `%` match the entire catalogue.
 *  - **`not_equals` matches a NULL/absent value**, because Mongo's `$ne` did:
 *    `{vendor: {$ne: 'Acme'}}` matched every document with no `vendor` at all.
 *    A bare `vendor <> 'Acme'` evaluates to NULL there and drops those rows, so
 *    a merchant's "everything except Acme" collection would silently exclude
 *    every unbranded product.
 *  - **An unsupported field/operator pair yields `null` and is SKIPPED**, and a
 *    rule set with NO usable condition matches NOTHING. Automated collections
 *    degrade gracefully; the alternative — treating "no conditions" as "no
 *    filter" — publishes a merchant's entire catalogue into one collection.
 */

import { and, arrayContains, eq, not, or, sql, type SQL } from 'drizzle-orm';
import type { CollectionRuleOperator } from '@mercaria/shared-types';
import { listings, productVariants } from '../schema/catalog.js';
import { variantExistsPredicate } from '../catalog/listingRepository.js';

/** One rule row, as `collection_rules` stores it. */
export interface CollectionRuleInput {
  field: string;
  operator: CollectionRuleOperator;
  value: string;
}

/**
 * Escape a user value for `ILIKE`.
 *
 * `\` first — escaping it after `%`/`_` would double-escape the backslashes this
 * function just introduced. Postgres's default `LIKE` escape character is `\`,
 * so no `ESCAPE` clause is needed.
 */
export function escapeLikeNeedle(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** A predicate that matches no row, for a rule set with nothing usable in it. */
export const MATCHES_NOTHING: SQL = sql`false`;

/** The listing columns a string rule may target. */
const STRING_COLUMNS = {
  title: listings.title,
  productType: listings.productType,
  vendor: listings.vendor,
} as const;

/** The listing ARRAY columns a rule may target, matched by element. */
const ARRAY_COLUMNS = {
  tag: listings.tags,
  categorySlug: listings.categorySlugs,
} as const;

/** A string comparison, or `null` when the operator does not apply to text. */
function stringPredicate(
  column: (typeof STRING_COLUMNS)[keyof typeof STRING_COLUMNS],
  operator: CollectionRuleOperator,
  value: string,
): SQL | null {
  const needle = escapeLikeNeedle(value);
  switch (operator) {
    case 'equals':
      return sql`${column} = ${value}`;
    case 'not_equals':
      // Mongo's `$ne` matched an absent field; see the module header.
      return sql`(${column} is null or ${column} <> ${value})`;
    case 'contains':
      return sql`${column} ilike ${`%${needle}%`}`;
    case 'starts_with':
      return sql`${column} ilike ${`${needle}%`}`;
    case 'ends_with':
      return sql`${column} ilike ${`%${needle}`}`;
    default:
      return null;
  }
}

/**
 * An element match on a `text[]` column, or `null` for an operator an array
 * cannot express.
 *
 * Array CONTAINMENT (`@>`) rather than `= any(...)` so the GIN indexes on
 * `tags` and `category_slugs` serve it — a btree cannot, and `= any` would not
 * use one. Built with `arrayContains` and not a hand-written `@> ${[value]}`:
 * postgres.js EXPANDS a JavaScript array into one bind parameter per element, so
 * the hand-written form binds a bare scalar against a `text[]` and fails at
 * execution.
 */
function arrayPredicate(
  column: (typeof ARRAY_COLUMNS)[keyof typeof ARRAY_COLUMNS],
  operator: CollectionRuleOperator,
  value: string,
): SQL | null {
  if (operator === 'equals' || operator === 'contains') {
    return arrayContains(column, [value]);
  }
  if (operator === 'not_equals') {
    return not(arrayContains(column, [value]));
  }
  return null;
}

/** A numeric comparison against a bigint column, or `null` when it does not apply. */
function numericPredicate(
  column: SQL,
  operator: CollectionRuleOperator,
  value: string,
): SQL | null {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  switch (operator) {
    case 'equals':
      return sql`${column} = ${num}`;
    case 'not_equals':
      return sql`(${column} is null or ${column} <> ${num})`;
    case 'gt':
      return sql`${column} > ${num}`;
    case 'lt':
      return sql`${column} < ${num}`;
    case 'gte':
      return sql`${column} >= ${num}`;
    case 'lte':
      return sql`${column} <= ${num}`;
    default:
      return null;
  }
}

/**
 * An inventory rule, resolved against the listing's denormalized `has_inventory`
 * boolean — Mercaria has no per-listing stock NUMBER to compare, so the rule is
 * reduced to in-stock / out-of-stock exactly as the Mongo translator did.
 */
function inventoryPredicate(operator: CollectionRuleOperator, value: string): SQL | null {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  if (operator === 'equals') {
    return eq(listings.hasInventory, num > 0);
  }
  if (operator === 'not_equals') {
    return eq(listings.hasInventory, !(num > 0));
  }
  if ((operator === 'gt' && num >= 0) || (operator === 'gte' && num >= 1)) {
    return eq(listings.hasInventory, true);
  }
  if ((operator === 'lt' && num <= 1) || (operator === 'lte' && num <= 0)) {
    return eq(listings.hasInventory, false);
  }
  return null;
}

/**
 * Translate ONE rule, or `null` when the field/operator pair is unsupported.
 *
 * `compareAtPrice` is the only variant-level field: it is not denormalized onto
 * the listing, so it resolves through a CORRELATED `EXISTS` whose outer
 * reference is qualified by {@link variantExistsPredicate}. The Mongo version
 * ran a separate query and constrained `_id $in [...]`, which could not be
 * combined with the rest of the filter in one statement.
 */
export function translateRule(rule: CollectionRuleInput): SQL | null {
  const stringColumn = STRING_COLUMNS[rule.field as keyof typeof STRING_COLUMNS];
  if (stringColumn) {
    return stringPredicate(stringColumn, rule.operator, rule.value);
  }

  const arrayColumn = ARRAY_COLUMNS[rule.field as keyof typeof ARRAY_COLUMNS];
  if (arrayColumn) {
    return arrayPredicate(arrayColumn, rule.operator, rule.value);
  }

  if (rule.field === 'price') {
    return numericPredicate(sql`${listings.priceRangeMinAmount}`, rule.operator, rule.value);
  }

  if (rule.field === 'inventory') {
    return inventoryPredicate(rule.operator, rule.value);
  }

  if (rule.field === 'compareAtPrice') {
    const variantPredicate = numericPredicate(
      sql`${productVariants.compareAtPriceAmount}`,
      rule.operator,
      rule.value,
    );
    return variantPredicate ? variantExistsPredicate(variantPredicate) : null;
  }

  return null;
}

/**
 * Combine a rule set into ONE predicate over `listings`.
 *
 * Returns {@link MATCHES_NOTHING} when no condition survives translation, which
 * is the whole point: a collection whose rules are all unsupported must contain
 * nothing, not everything.
 */
export function translateRules(
  rules: readonly CollectionRuleInput[],
  appliesDisjunctively: boolean,
): SQL {
  const predicates = rules.flatMap((rule) => {
    const predicate = translateRule(rule);
    return predicate ? [predicate] : [];
  });

  if (predicates.length === 0) {
    return MATCHES_NOTHING;
  }
  const combined = appliesDisjunctively ? or(...predicates) : and(...predicates);
  return combined ?? MATCHES_NOTHING;
}
