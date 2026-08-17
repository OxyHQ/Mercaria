import type {
  ComparisonCell,
  ComparisonInput,
  ComparisonTableRow,
} from '@mercaria/shared-types';

/**
 * The explicit rules that decide whether a comparison says anything, and the
 * ones that stop it saying more than it knows (#367 workstream 9 §"Product
 * comparison").
 *
 * Pure, and it consumes `ComparisonInput` — the server's own grounded package.
 * Nothing here re-derives a fact, re-orders a row or re-renders a value: every
 * row already carries its registry `key`, its `definitionVersion`, its
 * comparison `unit` and its `direction`, so "generate comparison sections/rows
 * from shared product type/attribute metadata" is satisfied by rendering what
 * arrived rather than by composing a section list per category.
 *
 * ## "Never imply a requirement is met when data is missing" is an ABSENCE
 *
 * `ComparisonConstraintColumn` keeps `satisfied`, `failed`, `unknown` and
 * `notApplicable` as four separate lists, and there is deliberately no function
 * in this module that adds `satisfied` to anything else or folds `unknown` into
 * either side. A renderer that wanted to claim an unknown requirement was met
 * would have to write the addition out loud, in a diff somebody reviews.
 *
 * ## Units are normalized once, by the server, and precision is not re-rounded
 *
 * `ComparisonTableRow.unit` is the unit every numeric cell in that row is
 * expressed in, and a cell converted into it carries
 * `state: 'inferred'` with `basis: 'unit_conversion'`. That is the whole of
 * "normalize units deterministically for comparison while preserving source
 * precision": the conversion is labelled where it happened, the rendered form
 * comes with it, and this package neither converts nor re-rounds — a second
 * rounding here would be exactly the false precision workstream 4 forbids.
 */

/** How many distinct categories the subjects span. */
export type ComparisonCategoryScope =
  | 'single_category'
  | 'multiple_categories'
  | 'unknown_category';

/**
 * Whether these subjects can be compared, and on what.
 *
 * Four outcomes, evaluated in the order below. The order is load-bearing:
 * `no_shared_facts` is checked BEFORE the category scope, because two products
 * in one category with nothing recorded in common produce a table of dashes,
 * and telling a shopper "these are comparable" over it is the empty claim this
 * verdict exists to refuse.
 */
export type ComparabilityVerdict =
  | { readonly kind: 'too_few_subjects'; readonly subjectCount: number }
  | { readonly kind: 'no_shared_facts'; readonly categoryScope: ComparisonCategoryScope }
  | {
      readonly kind: 'comparable';
      readonly sharedRowCount: number;
      readonly categoryScope: 'single_category';
    }
  | {
      readonly kind: 'comparable_across_categories';
      readonly sharedRowCount: number;
      readonly categoryScope: Exclude<ComparisonCategoryScope, 'single_category'>;
    };

/** Whether a cell states a value at all. `conflicting` deliberately does not. */
function cellStatesAValue(cell: ComparisonCell): boolean {
  return cell.state === 'source_backed' || cell.state === 'inferred';
}

/**
 * A row every subject has a stated value on.
 *
 * `conflicting` is excluded on purpose. #94 selects NEITHER candidate when two
 * sources disagree, so a conflicting cell is Mercaria declining to state the
 * fact — counting it as shared would let a comparison claim common ground that
 * rests on a disagreement nobody resolved.
 */
export function rowIsSharedAcrossSubjects(
  row: ComparisonTableRow,
  subjectRefs: readonly string[],
): boolean {
  return subjectRefs.every((ref) => {
    const cell = row.cells[ref];
    return cell !== undefined && cellStatesAValue(cell);
  });
}

function categoryScopeOf(input: ComparisonInput): ComparisonCategoryScope {
  const categories = new Set<string>();
  for (const subject of input.subjects) {
    if (subject.categoryId === undefined) return 'unknown_category';
    categories.add(subject.categoryId);
  }
  return categories.size === 1 ? 'single_category' : 'multiple_categories';
}

export function assessComparability(input: ComparisonInput): ComparabilityVerdict {
  const subjectRefs = input.table.subjectRefs;
  if (input.subjects.length < 2) {
    return { kind: 'too_few_subjects', subjectCount: input.subjects.length };
  }

  const categoryScope = categoryScopeOf(input);
  const sharedRowCount = input.table.rows.filter((row) =>
    rowIsSharedAcrossSubjects(row, subjectRefs),
  ).length;

  if (sharedRowCount === 0) return { kind: 'no_shared_facts', categoryScope };
  if (categoryScope === 'single_category') {
    return { kind: 'comparable', sharedRowCount, categoryScope };
  }
  return { kind: 'comparable_across_categories', sharedRowCount, categoryScope };
}

/**
 * The subjects a comparison URL names, as `handle` or `handle:variantId`.
 *
 * The variant half is what makes "compare exact variants when a fact is
 * variant-specific" reachable: a shopper who arrived from a configuration
 * carries it, and the comparison then answers about that configuration rather
 * than about the model. A subject with no variant compares the model, which is
 * a different and equally legitimate question.
 */
export interface ComparisonSubjectRequest {
  readonly handle: string;
  readonly canonicalVariantId?: string;
}

export function parseComparisonSubjects(
  raw: string | string[] | undefined,
): readonly ComparisonSubjectRequest[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const subjects: ComparisonSubjectRequest[] = [];

  for (const entry of values.flatMap((value) => value.split(','))) {
    const separator = entry.indexOf(':');
    // BOTH halves are trimmed, not the entry as a whole. Trimming the entry
    // leaves `"  a-handle :var"` with a trailing space INSIDE the handle, which
    // the server answers 404 for — measured, and invisible until somebody
    // hand-edits a `?p=` list or a client joins with `", "`.
    const handle = (separator < 0 ? entry : entry.slice(0, separator)).trim();
    if (handle.length === 0) continue;
    const variant = separator < 0 ? '' : entry.slice(separator + 1).trim();
    subjects.push(variant.length === 0 ? { handle } : { handle, canonicalVariantId: variant });
  }
  return subjects;
}
