/**
 * Mercaria-Specific Column Shapes
 *
 * `@oxyhq/db` owns the shapes every Oxy backend shares — `timestamptz`,
 * `createdAt`, `updatedAt`, `generatedId`, `tsvector`, `geography`, `inList`.
 * Import those DIRECTLY from `@oxyhq/db`; this module never re-exports them.
 *
 * What lives here is the handful of shapes that are Mercaria's own, each
 * repeated across many tables and each encoding a decision a hand-written column
 * could silently get wrong:
 *
 *  - `money` / `dualMoney` — the four-column expansion of a `DualMoney`, which
 *    is the single most-repeated shape in this schema and the one most likely to
 *    be got wrong by someone porting a Mongoose sub-document mechanically.
 *  - `currencyCode` — `text` typed and CHECKed from `ALL_CURRENCY_CODES`.
 *  - `addressColumns` — the nine-field address snapshot four tables embed.
 *  - `checkOneOf` / `checkEveryElementOf` — a CHECK rendered from the SAME tuple
 *    that types the column, so the two cannot drift.
 *
 * See `CONVENTIONS.md` for the reasoning behind each; this file states the
 * mechanics.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, text, type PgColumn } from 'drizzle-orm/pg-core';
import { inList, sqlColumnName, textArrayLiteral } from '@oxyhq/db';
import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';

/**
 * A shared-types runtime list, narrowed to the NON-EMPTY tuple drizzle's
 * `text({ enum })` requires.
 *
 * The lists in `@mercaria/shared-types` are typed `readonly T[]`, not tuples —
 * `ALL_CURRENCY_CODES` is literally `Object.keys(CURRENCY_PRECISION)`, so its
 * non-emptiness is a fact about the data rather than something the type system
 * records. A cast would assert it; this CHECKS it, at module load, where an
 * empty list is a build-time failure rather than a table with an `enum` of
 * nothing (which drizzle accepts and which would type every value as `never`).
 *
 * The element type survives: `T` is inferred as the union, so
 * `text({ enum: asEnumValues(ALL_CURRENCY_CODES) })` still types the column
 * `CurrencyCode` and not `string`.
 */
export function asEnumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error(
      'asEnumValues received an empty list. A drizzle `enum` of no values types ' +
        'the column `never` and a CHECK of no values rejects every row.',
    );
  }
  return [first, ...rest];
}

/** `ALL_CURRENCY_CODES` as the tuple both the column type and its CHECK read. */
export const CURRENCY_CODE_VALUES = asEnumValues(ALL_CURRENCY_CODES);

/**
 * A money AMOUNT — integer minor units, `bigint`, surfaced to TypeScript as a
 * `number`.
 *
 * ## Why `bigint` and not `integer`, measured rather than assumed
 *
 * FAIR carries EIGHT decimals (`CURRENCY_PRECISION.FAIR === 8`), so 1 ⊜ is
 * 100_000_000 minor units. A signed `integer` tops out at 2_147_483_647 — which
 * is **21.47 ⊜**. Not a large order: a mid-priced item overflows it. `integer`
 * would have been correct for a cents-only catalogue and is catastrophically
 * wrong for this one, silently, at the first real FAIR price.
 *
 * `bigint` holds 9.22e18, and `mode: 'number'` maps it to the JS `number` every
 * consumer already uses — `Money.amount` is declared `number` in
 * `@mercaria/shared-types`, and the pricing engine's half-even reconciliation is
 * integer arithmetic on that type. `mode: 'bigint'` would change the DTO's wire
 * type and every arithmetic site with it.
 *
 * `mode: 'number'` re-imposes JavaScript's own ceiling of 2^53 − 1, i.e. about
 * 90.07 million ⊜. That is NOT a ceiling this column introduces: it is exactly
 * the ceiling `Money.amount: number` already has today under Mongo, and
 * `money.ts`'s own comment flags the same figure as a pending BigInt decision.
 * This column raises the storage ceiling from 21 ⊜ to the DTO's own limit; it
 * does not lower anything. If that decision ever lands, this builder and the DTO
 * change together.
 *
 * postgres.js hands `int8` back as a string; drizzle's `PgBigInt53` maps it with
 * `Number(...)`, so the round trip is a `number` in both directions. That is
 * asserted against a real database rather than trusted.
 */
const moneyAmount = () => bigint({ mode: 'number' });

/** An ISO-4217-style code from `ALL_CURRENCY_CODES` (plus FAIR, which is not ISO). */
const currencyCode = () => text({ enum: CURRENCY_CODE_VALUES });

type OptionalAmount = ReturnType<typeof moneyAmount>;
type RequiredAmount = ReturnType<OptionalAmount['notNull']>;
type OptionalCurrency = ReturnType<typeof currencyCode>;
type RequiredCurrency = ReturnType<OptionalCurrency['notNull']>;

/** `<prefix>Amount` + `<prefix>Currency`, both NOT NULL. */
export type MoneyColumns<P extends string> = Record<`${P}Amount`, RequiredAmount> &
  Record<`${P}Currency`, RequiredCurrency>;

/** `<prefix>Amount` + `<prefix>Currency`, both nullable — absent together. */
export type OptionalMoneyColumns<P extends string> = Record<`${P}Amount`, OptionalAmount> &
  Record<`${P}Currency`, OptionalCurrency>;

/** The four columns of a `DualMoney`, all NOT NULL. */
export type DualMoneyColumns<P extends string> = MoneyColumns<`${P}Shop`> &
  MoneyColumns<`${P}Presentment`>;

/** The four columns of an optional `DualMoney`, all nullable — absent together. */
export type OptionalDualMoneyColumns<P extends string> = OptionalMoneyColumns<`${P}Shop`> &
  OptionalMoneyColumns<`${P}Presentment`>;

/**
 * A single `Money { amount, currency }` as TWO real columns.
 *
 * ```ts
 * ...money('price')   // price_amount bigint not null, price_currency text not null
 * ```
 *
 * ## The assertion below, and the test that makes it safe
 *
 * TypeScript cannot infer a computed template-literal key through a generic, so
 * without the explicit return type the spread of this helper contributes NOTHING
 * to the table's type — the columns are created at runtime (and land in the DDL)
 * while `typeof table.priceAmount` does not exist. That failure is silent in the
 * worst direction, so the return type is stated and the object asserted to it.
 *
 * The residual risk is a typo INSIDE this function: a key spelled
 * `${prefix}Amt` would still satisfy the assertion's shape at no compile cost
 * while creating a differently-named column. `db/__tests__/schema-conventions.test.ts`
 * pins the exact SQL names these helpers emit for a known prefix, and that test
 * is the only thing standing between a typo here and a schema whose columns do
 * not match its types.
 */
export function money<P extends string>(prefix: P): MoneyColumns<P> {
  return {
    [`${prefix}Amount`]: moneyAmount().notNull(),
    [`${prefix}Currency`]: currencyCode().notNull(),
  } as MoneyColumns<P>;
}

/** {@link money}, nullable — for a `Money` the source model leaves unset. */
export function optionalMoney<P extends string>(prefix: P): OptionalMoneyColumns<P> {
  return {
    [`${prefix}Amount`]: moneyAmount(),
    [`${prefix}Currency`]: currencyCode(),
  } as OptionalMoneyColumns<P>;
}

/**
 * A `DualMoney { shop, presentment }` as FOUR real columns.
 *
 * ```ts
 * ...dualMoney('unitPrice')
 * // unit_price_shop_amount, unit_price_shop_currency,
 * // unit_price_presentment_amount, unit_price_presentment_currency
 * ```
 *
 * All four are NOT NULL together, deliberately: an order line with a shop amount
 * and no presentment amount is not a partially-filled row, it is a row that
 * cannot be rendered to the buyer who paid it.
 */
export function dualMoney<P extends string>(prefix: P): DualMoneyColumns<P> {
  return {
    ...money(`${prefix}Shop`),
    ...money(`${prefix}Presentment`),
  };
}

/** {@link dualMoney}, nullable — all four absent together (an un-discounted line). */
export function optionalDualMoney<P extends string>(prefix: P): OptionalDualMoneyColumns<P> {
  return {
    ...optionalMoney(`${prefix}Shop`),
    ...optionalMoney(`${prefix}Presentment`),
  };
}

/** The nine fields of a postal address, all NOT NULL where the source requires them. */
export type AddressColumns<P extends string> = Record<
  | `${P}Label`
  | `${P}Line2`
  | `${P}Region`
  | `${P}Phone`,
  ReturnType<typeof text>
> &
  Record<
    `${P}RecipientName` | `${P}Line1` | `${P}City` | `${P}PostalCode` | `${P}Country`,
    ReturnType<ReturnType<typeof text>['notNull']>
  >;

/** The nine fields of an OPTIONAL address — every column nullable. */
export type OptionalAddressColumns<P extends string> = Record<
  | `${P}Label`
  | `${P}RecipientName`
  | `${P}Line1`
  | `${P}Line2`
  | `${P}City`
  | `${P}Region`
  | `${P}PostalCode`
  | `${P}Country`
  | `${P}Phone`,
  ReturnType<typeof text>
>;

/**
 * The address snapshot four models embed — `Order.shippingAddressSnapshot`,
 * `DraftOrder.shippingAddressSnapshot`, `Location.address`,
 * `Customer.defaultAddress` — plus the buyer's own saved `Address`.
 *
 * Each of those Mongoose sub-schemas is a hand-copied duplicate of the same nine
 * fields, and three of their docblocks claim to "mirror the order
 * AddressSnapshot shape". Generating them from one definition makes that claim
 * structurally true instead of a comment that can go stale.
 *
 * Same assertion caveat as {@link money}, and the same test pins it.
 */
export function addressColumns<P extends string>(prefix: P): AddressColumns<P> {
  return {
    [`${prefix}Label`]: text(),
    [`${prefix}RecipientName`]: text().notNull(),
    [`${prefix}Line1`]: text().notNull(),
    [`${prefix}Line2`]: text(),
    [`${prefix}City`]: text().notNull(),
    [`${prefix}Region`]: text(),
    [`${prefix}PostalCode`]: text().notNull(),
    [`${prefix}Country`]: text().notNull(),
    [`${prefix}Phone`]: text(),
  } as AddressColumns<P>;
}

/**
 * {@link addressColumns} for an address the source model leaves entirely unset.
 *
 * Every column is nullable, so "has an address" is `<prefix>_recipient_name is
 * not null` rather than a separate flag. A NOT NULL on the required subfields
 * would make the ABSENT case unrepresentable, which is the case these four
 * tables actually have most of the time.
 */
export function optionalAddressColumns<P extends string>(prefix: P): OptionalAddressColumns<P> {
  return {
    [`${prefix}Label`]: text(),
    [`${prefix}RecipientName`]: text(),
    [`${prefix}Line1`]: text(),
    [`${prefix}Line2`]: text(),
    [`${prefix}City`]: text(),
    [`${prefix}Region`]: text(),
    [`${prefix}PostalCode`]: text(),
    [`${prefix}Country`]: text(),
    [`${prefix}Phone`]: text(),
  } as OptionalAddressColumns<P>;
}

/**
 * `CHECK (<column> in (…))`, rendered from the SAME tuple that types the column.
 *
 * A nullable column passes: `null in (…)` is NULL, and a CHECK rejects only
 * FALSE. That is the wanted behaviour everywhere here — an unset optional enum
 * is absence, not a violation.
 */
export function checkOneOf(name: string, column: PgColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${sql.raw(inList(values))})`);
}

/**
 * `CHECK (<column> <@ array[…])` — every ELEMENT of a `text[]` is in range.
 *
 * A scalar `in` cannot express this and a CHECK may not contain a subquery, so
 * "every element is in range" is written as array CONTAINMENT, never `unnest`.
 * An empty array satisfies it trivially, which is correct: an empty set has no
 * out-of-range element.
 */
export function checkEveryElementOf(name: string, column: PgColumn, values: readonly string[]) {
  return check(name, sql`${column} <@ ${sql.raw(textArrayLiteral(values))}`);
}

/**
 * A `<table>_<column>_check` CHECK for every currency column passed.
 *
 * Listed EXPLICITLY per table rather than derived by scanning for a `_currency`
 * suffix, because that scan is wrong in both directions and the wrongness is
 * silent: `draft_orders.currency` carries a `CurrencyCode` and does not match
 * the suffix, while `connections.shop_currency` is the EXTERNAL platform's
 * currency — declared with no enum in Mongoose precisely because a Shopify shop
 * may report a code Mercaria does not list, and CHECKing it would reject the
 * connection instead of the price.
 *
 * The constraint name comes from `sqlColumnName`, never `column.name` (which is
 * the TypeScript property), so it matches the column the DDL actually creates.
 */
export function currencyChecks(table: string, columns: readonly PgColumn[]) {
  return columns.map((column) =>
    checkOneOf(`${table}_${sqlColumnName(column)}_check`, column, ALL_CURRENCY_CODES),
  );
}
