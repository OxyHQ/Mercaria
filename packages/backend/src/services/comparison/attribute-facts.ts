/**
 * One stored attribute value, as a comparison cell reads it (#96 grounded
 * input item 3).
 *
 * A TRANSLATION of #94's normalized columns into a {@link ComparisonFactValue},
 * and nothing more: no unit conversion, no rounding, no inference about what a
 * bare number means. #94 normalized the value into its definition's base unit
 * at write time under a recorded ruleset, and a second conversion in a read
 * path would be a second authority over what a magnitude means — which is the
 * disagreement the version stamp on every row exists to prevent.
 *
 * A row whose normalized columns are all empty produces `undefined` rather than
 * an empty value. That is not a defensive branch: `unparsed`, `unknown_unit`,
 * `out_of_range`, `implausible` and `marketing_claim` are all real, recorded,
 * DELIBERATE refusals in #94's normalization vocabulary, and every one of them
 * stores the source's words with no normalized magnitude beside them. Rendering
 * such a row would put a marketing claim in a specification table, which is
 * exactly what #94 refused it for.
 */

import type { ComparisonFactValue, CurrencyCode, Money } from '@mercaria/shared-types';
import { renderMagnitude, renderMoney } from './render.js';
import type { ComparisonRecordIndex } from './record-refs.js';
import type { TableAttributeFact } from './table.js';

/** The columns this translation reads. A structural type, so no repository import. */
export interface StoredAttributeValueRow {
  readonly id: string;
  readonly attributeKey: string;
  readonly definitionVersion: number | null;
  readonly normalizedText: string | null;
  readonly normalizedNumber: number | null;
  readonly normalizedNumberMax: number | null;
  readonly normalizedUnit: string | null;
  readonly normalizedBoolean: boolean | null;
  readonly normalizedDate: Date | null;
  readonly normalizedAmountMinor: number | null;
  readonly normalizedCurrency: CurrencyCode | null;
}

/**
 * Translate one row.
 *
 * @returns `undefined` for a row carrying no normalized value — see the module
 *   header for why that is a decision rather than a guard.
 */
export function toAttributeFact(
  row: StoredAttributeValueRow,
  index: ComparisonRecordIndex,
): TableAttributeFact | undefined {
  const value = valueOf(row);
  if (value === undefined) return undefined;

  const ref = index.register({
    kind: 'attribute_value',
    recordId: row.id,
    label: row.attributeKey,
  });

  return {
    key: row.attributeKey,
    // The KEY as the fallback label. The table prefers the definition's own
    // label when the subject's category declares the attribute; this is what a
    // fact carries when it does not, which is a real state after a category
    // scope moves and is better than a blank row header.
    label: row.attributeKey,
    definitionVersion: row.definitionVersion ?? 0,
    ...(row.normalizedUnit === null ? {} : { unit: row.normalizedUnit }),
    state: 'source_backed',
    value,
    recordRefs: [ref],
  };
}

/**
 * The one typed value a row carries.
 *
 * The order is #94's own column precedence and it matters in exactly one place:
 * `normalizedNumberMax` is checked BEFORE `normalizedNumber`, because a range
 * stores its LOWER bound in `normalizedNumber` and reading that column first
 * would render "6.1 to 6.7 in" as "6.1 in" — a narrower claim than the record
 * makes, in a table whose whole purpose is comparing them.
 */
function valueOf(row: StoredAttributeValueRow): ComparisonFactValue | undefined {
  if (row.normalizedNumberMax !== null && row.normalizedNumber !== null) {
    const unit = row.normalizedUnit ?? undefined;
    return {
      type: 'range',
      lower: row.normalizedNumber,
      upper: row.normalizedNumberMax,
      ...(unit === undefined ? {} : { unit }),
      rendered: `${renderMagnitude(row.normalizedNumber)}–${renderMagnitude(row.normalizedNumberMax, unit)}`,
    };
  }
  if (row.normalizedAmountMinor !== null && row.normalizedCurrency !== null) {
    // A money ATTRIBUTE names ONE currency on its own definition (#94), so the
    // row is self-describing and nothing is converted here. A comparison
    // currency is about OFFERS; converting a stored manufacturer list price
    // into it would restate a specification as a price somebody is charging.
    const money: Money = {
      amount: row.normalizedAmountMinor,
      currency: row.normalizedCurrency,
    };
    return { type: 'money', amount: money, rendered: renderMoney(money) };
  }
  if (row.normalizedNumber !== null) {
    const unit = row.normalizedUnit ?? undefined;
    return {
      type: 'number',
      value: row.normalizedNumber,
      ...(unit === undefined ? {} : { unit }),
      rendered: renderMagnitude(row.normalizedNumber, unit),
    };
  }
  if (row.normalizedBoolean !== null) {
    return {
      type: 'boolean',
      value: row.normalizedBoolean,
      rendered: row.normalizedBoolean ? 'yes' : 'no',
    };
  }
  if (row.normalizedDate !== null) {
    const iso = row.normalizedDate.toISOString();
    return { type: 'date', iso, rendered: iso.slice(0, 10) };
  }
  if (row.normalizedText !== null) {
    return { type: 'text', text: row.normalizedText, rendered: row.normalizedText };
  }
  return undefined;
}
