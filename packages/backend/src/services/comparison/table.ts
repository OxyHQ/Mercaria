/**
 * The machine comparison table (#96 §"Product comparison", rules 1–6).
 *
 * PURE. Everything it needs arrives as a value, so every case the issue names —
 * a missing attribute, two sources disagreeing, a unit that does not line up, a
 * question that does not apply to a category — is a table of inputs rather than
 * a catalogue somebody has to seed.
 *
 * ## Four states, kept apart, and why the fourth one is not a luxury
 *
 * A cell is `source_backed`, `inferred`, `conflicting`, `unknown` or
 * `not_applicable`. The two that are easiest to collapse are the last two, and
 * collapsing them is the bug: telling a shopper that a desk chair's battery
 * life is *unrecorded* invites them to go and look for it. "This question does
 * not apply here" is a different sentence, it comes from a different fact (the
 * attribute's category scope), and it must not be reachable from an absent
 * value.
 *
 * `conflicting` is #94's SELECTION state surfacing rather than being flattened:
 * two sources disagreeing is not a fact Mercaria is willing to state, and the
 * shopper is shown both candidates instead of one of them chosen by a rule
 * nobody wrote.
 *
 * ## A difference is not a tradeoff
 *
 * A DIFFERENCE is two cells that are not equal. A TRADEOFF is a difference on a
 * row whose preferred direction is declared. Everything else — most rows — is
 * reported as a difference with both values and no better/worse claim, which is
 * product-comparison rule 6 held by the data rather than by a caveat in the
 * copy. See `policy.ts` for why the default is `not_comparable`.
 */

import type {
  ComparisonCell,
  ComparisonConstraintColumn,
  ComparisonDifference,
  ComparisonDirection,
  ComparisonFactValue,
  ComparisonInferenceBasis,
  ComparisonMoneyFact,
  ComparisonTable,
  ComparisonTableRow,
  ComparisonTradeoff,
  ConditionGroup,
  OfferAvailability,
} from '@mercaria/shared-types';
import { COMMERCE_ROWS, resolveComparisonDirection } from './policy.js';
import { renderDays, renderMagnitude } from './render.js';

/** One recorded attribute fact for one subject, already normalized by #94. */
export interface TableAttributeFact {
  readonly key: string;
  readonly label: string;
  readonly definitionVersion: number;
  /** The base unit the magnitude is stored in. Absent for a non-measurement. */
  readonly unit?: string;
  readonly state: 'source_backed' | 'inferred' | 'conflicting';
  readonly basis?: ComparisonInferenceBasis;
  /** Present for `source_backed` and `inferred`. */
  readonly value?: ComparisonFactValue;
  /** Present for `conflicting` — every parse that disagreed. */
  readonly candidates?: readonly ComparisonFactValue[];
  readonly recordRefs: readonly string[];
}

/** What a subject's category declares about one attribute. */
export interface DeclaredAttribute {
  readonly label: string;
  readonly definitionVersion: number;
  readonly unit?: string;
  /** #94's own `comparable` flag. A row exists for it; a cell may still refuse. */
  readonly comparable: boolean;
}

/** The commerce half of one subject's row of the table. */
export interface TableCommerceFacts {
  /**
   * Whether the offers half is being served at all.
   *
   * `false` means the canonical offer-comparison lever is off, and every
   * commerce cell becomes `unknown` with `definition_not_published` — never a
   * zero price and never an empty availability list, either of which a client
   * would render as a fact.
   */
  readonly served: boolean;
  readonly lowestItemPrice: ComparisonMoneyFact;
  readonly lowestKnownTotal: ComparisonMoneyFact;
  readonly availability: readonly OfferAvailability[];
  readonly conditionGroups: readonly ConditionGroup[];
  readonly deliveryMaxDays?: number;
  readonly merchantCount: number;
  readonly hasOfficialChannel: boolean;
  /** The offers these facts were derived from. */
  readonly recordRefs: readonly string[];
}

/** Everything the table needs about one subject. */
export interface TableSubjectInput {
  readonly subjectRef: string;
  /** Every attribute the subject's category declares, keyed by attribute key. */
  readonly declared: ReadonlyMap<string, DeclaredAttribute>;
  /** The subject's own recorded facts, keyed by attribute key. */
  readonly facts: ReadonlyMap<string, TableAttributeFact>;
  readonly commerce: TableCommerceFacts;
  readonly constraints: ComparisonConstraintColumn;
}

/**
 * Build the table.
 *
 * Rows are the COMMERCE rows first, in `COMMERCE_ROWS` order, then every
 * attribute key any subject declares, sorted by key. Sorted rather than
 * insertion-ordered so two runs over the same catalogue produce byte-identical
 * tables — the same reason `ComparisonRecordIndex.all()` sorts.
 */
export function buildComparisonTable(
  subjects: readonly TableSubjectInput[],
): ComparisonTable {
  const subjectRefs = subjects.map((subject) => subject.subjectRef);
  const rows: ComparisonTableRow[] = [
    ...COMMERCE_ROWS.map((row) => buildCommerceRow(row.key, row.label, row.direction, subjects)),
    ...attributeKeysOf(subjects).map((key) => buildAttributeRow(key, subjects)),
  ];

  return {
    subjectRefs,
    rows,
    constraints: subjects.map((subject) => subject.constraints),
    tradeoffs: collectTradeoffs(rows),
    differences: collectDifferences(rows),
  };
}

/** Every attribute key any subject declares, sorted. */
function attributeKeysOf(subjects: readonly TableSubjectInput[]): readonly string[] {
  const keys = new Set<string>();
  for (const subject of subjects) {
    for (const key of subject.declared.keys()) keys.add(key);
    // A fact whose definition is not in the subject's declared map is still a
    // recorded fact about that subject. Dropping the row would hide a real
    // value because a category scope moved, which is the failure a census
    // catches everywhere else in this codebase.
    for (const key of subject.facts.keys()) keys.add(key);
  }
  return [...keys].sort();
}

/** One attribute row across every subject. */
function buildAttributeRow(
  key: string,
  subjects: readonly TableSubjectInput[],
): ComparisonTableRow {
  const declarations = subjects
    .map((subject) => subject.declared.get(key))
    .filter((declared): declared is DeclaredAttribute => declared !== undefined);
  const label = declarations[0]?.label ?? firstFactLabel(key, subjects) ?? key;
  const definitionVersion = declarations[0]?.definitionVersion;
  const unit = rowUnit(key, subjects);

  const cells: Record<string, ComparisonCell> = {};
  for (const subject of subjects) {
    cells[subject.subjectRef] = attributeCell(key, unit, subject);
  }

  return {
    key,
    label,
    ...(definitionVersion === undefined ? {} : { definitionVersion }),
    ...(unit === undefined ? {} : { unit }),
    direction: resolveComparisonDirection(key),
    cells,
    differs: cellsDiffer(cells),
  };
}

/** The label a fact carries when no subject's category declares the attribute. */
function firstFactLabel(key: string, subjects: readonly TableSubjectInput[]): string | undefined {
  for (const subject of subjects) {
    const fact = subject.facts.get(key);
    if (fact !== undefined) return fact.label;
  }
  return undefined;
}

/**
 * The unit the whole row is expressed in.
 *
 * Taken from the first declaration that names one, then from the first fact.
 * A fact whose unit disagrees is NOT converted here — #94 normalizes into a
 * base unit at write time and a second conversion in a read path would be a
 * second authority over what a magnitude means. The disagreeing cell answers
 * `unit_not_comparable` instead, which is the honest reading of two facts
 * stored under two units.
 */
function rowUnit(key: string, subjects: readonly TableSubjectInput[]): string | undefined {
  for (const subject of subjects) {
    const declared = subject.declared.get(key);
    if (declared?.unit !== undefined) return declared.unit;
  }
  for (const subject of subjects) {
    const fact = subject.facts.get(key);
    if (fact?.unit !== undefined) return fact.unit;
  }
  return undefined;
}

/** One subject's cell on one attribute row. */
function attributeCell(
  key: string,
  rowUnitValue: string | undefined,
  subject: TableSubjectInput,
): ComparisonCell {
  const declared = subject.declared.get(key);
  const fact = subject.facts.get(key);

  if (fact === undefined) {
    // No recorded value. WHICH absence it is depends on the category, and the
    // two are different sentences — see the module header.
    if (declared === undefined) {
      return { state: 'not_applicable', reason: 'attribute_out_of_category' };
    }
    if (!declared.comparable) {
      return { state: 'not_applicable', reason: 'attribute_not_comparable' };
    }
    return { state: 'unknown', reason: 'not_recorded' };
  }

  if (declared !== undefined && !declared.comparable) {
    return { state: 'not_applicable', reason: 'attribute_not_comparable' };
  }

  if (fact.state === 'conflicting') {
    return {
      state: 'conflicting',
      candidates: fact.candidates ?? [],
      recordRefs: fact.recordRefs,
    };
  }

  if (fact.value === undefined) return { state: 'unknown', reason: 'not_recorded' };

  if (rowUnitValue !== undefined && fact.unit !== undefined && fact.unit !== rowUnitValue) {
    return { state: 'unknown', reason: 'unit_not_comparable' };
  }

  if (fact.state === 'inferred') {
    return {
      state: 'inferred',
      value: fact.value,
      basis: fact.basis ?? 'unit_conversion',
      recordRefs: fact.recordRefs,
    };
  }
  return { state: 'source_backed', value: fact.value, recordRefs: fact.recordRefs };
}

/** One commerce row across every subject. */
function buildCommerceRow(
  key: string,
  label: string,
  direction: ComparisonDirection,
  subjects: readonly TableSubjectInput[],
): ComparisonTableRow {
  const cells: Record<string, ComparisonCell> = {};
  for (const subject of subjects) cells[subject.subjectRef] = commerceCell(key, subject);
  return {
    key,
    label,
    direction,
    cells,
    differs: cellsDiffer(cells),
  };
}

/**
 * One subject's cell on one commerce row.
 *
 * Every branch reads a fact the offers half already derived. Nothing here
 * re-reads an offer, and nothing computes a price: the amounts arrive already
 * converted into the comparison's one currency with their quotes captured, so a
 * table cell and a plan line cannot disagree about what something costs.
 */
function commerceCell(key: string, subject: TableSubjectInput): ComparisonCell {
  const commerce = subject.commerce;
  if (!commerce.served) return { state: 'unknown', reason: 'definition_not_published' };

  switch (key) {
    case 'offer_price':
      return moneyCell(commerce.lowestItemPrice, commerce.recordRefs);
    case 'known_total':
      return moneyCell(commerce.lowestKnownTotal, commerce.recordRefs);
    case 'availability':
      return commerce.availability.length === 0
        ? { state: 'unknown', reason: 'not_recorded' }
        : {
            state: 'source_backed',
            value: textValue([...commerce.availability].sort().join(', ')),
            recordRefs: commerce.recordRefs,
          };
    case 'condition':
      return commerce.conditionGroups.length === 0
        ? { state: 'unknown', reason: 'not_recorded' }
        : {
            state: 'source_backed',
            value: textValue([...commerce.conditionGroups].sort().join(', ')),
            recordRefs: commerce.recordRefs,
          };
    case 'delivery_days':
      return commerce.deliveryMaxDays === undefined
        ? { state: 'unknown', reason: 'not_recorded' }
        : {
            state: 'source_backed',
            value: {
              type: 'number',
              value: commerce.deliveryMaxDays,
              unit: 'days',
              rendered: renderDays(commerce.deliveryMaxDays),
            },
            recordRefs: commerce.recordRefs,
          };
    case 'merchant_count':
      return {
        state: 'source_backed',
        value: {
          type: 'number',
          value: commerce.merchantCount,
          rendered: renderMagnitude(commerce.merchantCount),
        },
        recordRefs: commerce.recordRefs,
      };
    case 'official_channel':
      return {
        state: 'source_backed',
        value: {
          type: 'boolean',
          value: commerce.hasOfficialChannel,
          rendered: commerce.hasOfficialChannel ? 'yes' : 'no',
        },
        recordRefs: commerce.recordRefs,
      };
    default:
      // Unreachable while `COMMERCE_ROWS` and this switch agree, and a row added
      // to one and not the other lands here rather than rendering a blank cell
      // that reads as an absent fact.
      return { state: 'unknown', reason: 'definition_not_published' };
  }
}

/** A money fact as a cell. An unknown amount is an unknown cell, never a zero. */
function moneyCell(fact: ComparisonMoneyFact, recordRefs: readonly string[]): ComparisonCell {
  if (fact.state !== 'known') {
    return {
      state: 'unknown',
      reason: fact.reason === 'not_convertible' ? 'unit_not_comparable' : 'not_recorded',
    };
  }
  return {
    state: 'source_backed',
    value: { type: 'money', amount: fact.amount, rendered: fact.rendered },
    recordRefs,
  };
}

/** A plain text value with its rendered form, which for text is itself. */
function textValue(text: string): ComparisonFactValue {
  return { type: 'text', text, rendered: text };
}

/**
 * Whether the fact-stating cells in a row are not all equal.
 *
 * Compared on the RENDERED form, which is the one comparison that is
 * type-independent and is exactly what a shopper sees differ. A row where every
 * subject is unknown does not differ, which is correct: nothing was observed to
 * differ.
 */
function cellsDiffer(cells: Readonly<Record<string, ComparisonCell>>): boolean {
  const rendered = new Set<string>();
  for (const cell of Object.values(cells)) {
    if (cell.state === 'source_backed' || cell.state === 'inferred') {
      rendered.add(cell.value.rendered);
    }
  }
  return rendered.size > 1;
}

/**
 * The magnitude a direction can be applied to, or `undefined`.
 *
 * Numbers and money only. A RANGE is deliberately excluded — "6.1 to 6.7 in" is
 * not one point on a scale, and picking an end or a midpoint to order by would
 * be an inference the cell never declared. A range that differs is reported as
 * a DIFFERENCE, with both ranges shown.
 */
function orderableMagnitude(value: ComparisonFactValue): number | undefined {
  if (value.type === 'number') return value.value;
  if (value.type === 'money') return value.amount.amount;
  return undefined;
}

/**
 * One tradeoff per directional row that differs — best against worst.
 *
 * Deliberately not every pair. A table of eight subjects has twenty-eight pairs
 * per row and a paragraph cannot carry them; naming the extremes is the
 * reduction that stays true (both values are recorded, and the direction is
 * declared) and stays readable. A client that wants the middle reads the row.
 */
function collectTradeoffs(rows: readonly ComparisonTableRow[]): readonly ComparisonTradeoff[] {
  const tradeoffs: ComparisonTradeoff[] = [];
  for (const row of rows) {
    if (row.direction === 'not_comparable') continue;
    if (!row.differs) continue;

    const ordered: { subjectRef: string; value: ComparisonFactValue; magnitude: number }[] = [];
    for (const [subjectRef, cell] of Object.entries(row.cells)) {
      if (cell.state !== 'source_backed' && cell.state !== 'inferred') continue;
      const magnitude = orderableMagnitude(cell.value);
      if (magnitude === undefined) continue;
      ordered.push({ subjectRef, value: cell.value, magnitude });
    }
    if (ordered.length < 2) continue;

    // Sorted with the subject ref as the tiebreak, so two subjects at the same
    // magnitude produce the same tradeoff on every run. Without it the pick
    // would depend on `Object.entries` order, which is the ingestion-order
    // dependency #74 forbids by name.
    ordered.sort((left, right) =>
      left.magnitude === right.magnitude
        ? left.subjectRef.localeCompare(right.subjectRef)
        : left.magnitude - right.magnitude,
    );
    const lowest = ordered[0];
    const highest = ordered[ordered.length - 1];
    if (lowest.magnitude === highest.magnitude) continue;

    const better = row.direction === 'lower_is_better' ? lowest : highest;
    const worse = row.direction === 'lower_is_better' ? highest : lowest;

    tradeoffs.push({
      rowKey: row.key,
      label: row.label,
      betterSubjectRef: better.subjectRef,
      worseSubjectRef: worse.subjectRef,
      betterValue: better.value,
      worseValue: worse.value,
      direction: row.direction,
      recordRefs: rowRecordRefs(row, [better.subjectRef, worse.subjectRef]),
    });
  }
  return tradeoffs;
}

/** Every difference the table recorded that carries no better/worse reading. */
function collectDifferences(rows: readonly ComparisonTableRow[]): readonly ComparisonDifference[] {
  const differences: ComparisonDifference[] = [];
  for (const row of rows) {
    if (!row.differs) continue;
    if (row.direction !== 'not_comparable' && hasOrderablePair(row)) continue;

    const values: Record<string, string> = {};
    for (const [subjectRef, cell] of Object.entries(row.cells)) {
      if (cell.state !== 'source_backed' && cell.state !== 'inferred') continue;
      values[subjectRef] = cell.value.rendered;
    }
    differences.push({
      rowKey: row.key,
      label: row.label,
      values,
      recordRefs: rowRecordRefs(row, Object.keys(values)),
    });
  }
  return differences;
}

/** Whether a directional row has two cells a magnitude can be read from. */
function hasOrderablePair(row: ComparisonTableRow): boolean {
  let orderable = 0;
  for (const cell of Object.values(row.cells)) {
    if (cell.state !== 'source_backed' && cell.state !== 'inferred') continue;
    if (orderableMagnitude(cell.value) !== undefined) orderable += 1;
  }
  return orderable >= 2;
}

/** The records behind the named subjects' cells on one row, deduplicated. */
function rowRecordRefs(
  row: ComparisonTableRow,
  subjectRefs: readonly string[],
): readonly string[] {
  const refs = new Set<string>();
  for (const subjectRef of subjectRefs) {
    const cell = row.cells[subjectRef];
    if (cell === undefined) continue;
    if (cell.state === 'source_backed' || cell.state === 'inferred' || cell.state === 'conflicting') {
      for (const ref of cell.recordRefs) refs.add(ref);
    }
  }
  return [...refs].sort();
}
