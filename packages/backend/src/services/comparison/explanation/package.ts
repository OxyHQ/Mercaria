/**
 * The bounded package an explanation provider may see (#96 explanation rule 2).
 *
 * PURE, and a PROJECTION rather than a second assembly: it is derived from the
 * one {@link ComparisonInput} the deterministic table was built from, so a
 * provider cannot be handed a fact the table does not contain.
 *
 * ## What is dropped, and why each one
 *
 * - **`recordId`** — an id in a package is an id in a completion. A model that
 *   never saw a canonical product id cannot put one in a sentence.
 * - **`canonicalPath`, `destinationHost`** — the same argument for links, and a
 *   stronger one: a generated URL is a phishing surface, and Mercaria composes
 *   every link itself from the refs the response already carries.
 * - **Product descriptions and merchant free text** — the package carries a
 *   NAME and a rendered value and nothing a seller wrote, because seller copy
 *   is the injection surface (#95's finding, one domain over) and because a
 *   summary of marketing prose is not a summary of Mercaria's records.
 * - **Price-history detail** — a signal reaches the package only as the lowest
 *   figure and the window it covers, and only when the deployment publishes
 *   price history at all (#78's own lever).
 *
 * ## `groundedValues` is what makes "introduced a number" decidable
 *
 * Every rendered value that reaches the package is also collected into one
 * flat, sorted set of NUMERIC TOKENS. The validator's rule is then membership:
 * a sentence may quote `1234.50` if and only if `1234.50` is in the set. That
 * is checkable, mutation-testable and free of judgement — where "does this
 * number follow from the facts" is none of the three.
 *
 * The tokens are extracted from the SAME rendered strings the package carries,
 * by the same extractor the validator uses, so the two can never disagree about
 * what a number looks like.
 */

import {
  EXPLANATION_SCHEMA_VERSION,
  type ComparisonCell,
  type ComparisonInput,
  type ExplanationConstraint,
  type ExplanationGap,
  type ExplanationPackage,
  type ExplanationRow,
  type ExplanationSubject,
  type ExplanationTradeoff,
} from '@mercaria/shared-types';

/**
 * Extract every numeric token from a string.
 *
 * Digits with optional internal separators and an optional sign, which covers
 * `1234.50`, `16`, `-3`, `4.5` and `2026`. Percent signs, currency codes and
 * units are NOT tokens — they are words, and a sentence that says "GB" when the
 * package says "GB" is not introducing anything.
 *
 * Exported because the validator must use exactly this extractor; two
 * definitions of "a number" is two answers to whether a draft invented one.
 */
export function numericTokens(text: string): readonly string[] {
  const matches = text.match(/-?\d+(?:[.,]\d+)*/g);
  return matches === null ? [] : matches;
}

/**
 * Build the package.
 *
 * `validRefs` is the citation whitelist and is assembled from the refs that
 * actually appear in the package — never from `input.records`. That distinction
 * is load-bearing: the input's reference table holds every record the
 * comparison touched, including ones no rendered fact mentions, and a model
 * allowed to cite those could ground a sentence in a record it was never shown.
 */
export function buildExplanationPackage(input: ComparisonInput): ExplanationPackage {
  const values = new Set<string>();
  const refs = new Set<string>();

  const subjects: ExplanationSubject[] = input.subjects.map((subject) => {
    refs.add(subject.ref);
    const offers = input.offers.filter((offer) => offer.subjectRef === subject.ref);
    const merchantRefs = new Set(
      offers.map((offer) => offer.merchantRef).filter((ref): ref is string => ref !== undefined),
    );
    const lowestItem = lowestRendered(offers.map((offer) => offer.itemPrice));
    const lowestTotal = lowestRendered(offers.map((offer) => offer.total));
    for (const offer of offers) refs.add(offer.ref);
    if (lowestItem !== undefined) collect(values, lowestItem);
    if (lowestTotal !== undefined) collect(values, lowestTotal);
    collect(values, String(merchantRefs.size));

    return {
      ref: subject.ref,
      name: subject.name,
      acquisition: subject.acquisition.state,
      ...(lowestItem === undefined ? {} : { lowestKnownItemPrice: lowestItem }),
      ...(lowestTotal === undefined ? {} : { lowestKnownTotal: lowestTotal }),
      merchantCount: merchantRefs.size,
    };
  });

  const rows: ExplanationRow[] = input.table.rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const [subjectRef, cell] of Object.entries(row.cells)) {
      const rendered = renderCellForModel(cell);
      cells[subjectRef] = rendered;
      collect(values, rendered);
      if (cell.state === 'source_backed' || cell.state === 'inferred' || cell.state === 'conflicting') {
        for (const ref of cell.recordRefs) refs.add(ref);
      }
    }
    return { key: row.key, label: row.label, direction: row.direction, cells };
  });

  const tradeoffs: ExplanationTradeoff[] = input.table.tradeoffs.map((tradeoff) => {
    collect(values, tradeoff.betterValue.rendered);
    collect(values, tradeoff.worseValue.rendered);
    for (const ref of tradeoff.recordRefs) refs.add(ref);
    return {
      rowKey: tradeoff.rowKey,
      label: tradeoff.label,
      betterSubjectRef: tradeoff.betterSubjectRef,
      worseSubjectRef: tradeoff.worseSubjectRef,
      betterValue: tradeoff.betterValue.rendered,
      worseValue: tradeoff.worseValue.rendered,
    };
  });

  const gaps: ExplanationGap[] = input.gaps.map((gap) => ({
    subjectRef: gap.subjectRef,
    label: gap.label,
    reason: gap.reason,
  }));

  const constraints: readonly ExplanationConstraint[] = buildConstraintView(input, refs);

  // Price signals reach the package only as their rendered low and window, and
  // only when #78's public-reads lever put them in the input at all.
  for (const signal of input.priceSignals) {
    refs.add(signal.ref);
    collect(values, signal.rendered);
    collect(values, String(signal.windowDays));
  }

  return {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    comparisonPolicyVersion: input.policy.comparisonPolicyVersion,
    comparisonCurrency: input.comparisonCurrency,
    subjects,
    rows,
    tradeoffs,
    gaps,
    constraints,
    groundedValues: [...values].sort(),
    validRefs: [...refs].sort(),
  };
}

/** Every constraint, with each subject's deterministic outcome. */
function buildConstraintView(
  input: ComparisonInput,
  refs: Set<string>,
): readonly ExplanationConstraint[] {
  const byRef = new Map<string, ExplanationConstraint>();
  for (const column of input.table.constraints) {
    const results = [
      ...column.satisfied,
      ...column.failed,
      ...column.unknown,
      ...column.notApplicable,
    ];
    for (const result of results) {
      refs.add(result.constraintRef);
      const existing = byRef.get(result.constraintRef);
      const outcomes: Record<string, ExplanationConstraint['outcomes'][string]> = {
        ...(existing === undefined ? {} : existing.outcomes),
        [column.subjectRef]: result.satisfaction,
      };
      byRef.set(result.constraintRef, {
        constraintRef: result.constraintRef,
        constraintId: result.constraintId,
        explanation: result.explanation,
        outcomes,
      });
    }
  }
  // Sorted, so the package a provider sees is byte-identical between two runs
  // over the same catalogue — which is what makes a prompt cacheable and a
  // rejection reproducible.
  return [...byRef.values()].sort((left, right) =>
    left.constraintRef.localeCompare(right.constraintRef),
  );
}

/**
 * A cell as a provider reads it.
 *
 * An unknown cell renders as a WORD naming why, never as an empty string: a
 * blank in a table is the one thing a summarizer reliably fills in from general
 * knowledge, and explanation rule 7 asks it to state the gap instead.
 */
function renderCellForModel(cell: ComparisonCell): string {
  switch (cell.state) {
    case 'source_backed':
      return cell.value.rendered;
    case 'inferred':
      return `${cell.value.rendered} (inferred: ${cell.basis})`;
    case 'conflicting':
      return `conflicting (${cell.candidates.map((value) => value.rendered).join(' / ')})`;
    case 'unknown':
      return `unknown (${cell.reason})`;
    case 'not_applicable':
      return `not applicable (${cell.reason})`;
    default:
      return 'unknown (not_recorded)';
  }
}

/** The lowest rendered amount among a set of money facts, when any is known. */
function lowestRendered(
  facts: readonly { readonly state: string; readonly amount?: { readonly amount: number }; readonly rendered?: string }[],
): string | undefined {
  let best: { amount: number; rendered: string } | undefined;
  for (const fact of facts) {
    if (fact.state !== 'known') continue;
    if (fact.amount === undefined || fact.rendered === undefined) continue;
    if (best === undefined || fact.amount.amount < best.amount) {
      best = { amount: fact.amount.amount, rendered: fact.rendered };
    }
  }
  return best?.rendered;
}

/** Add every numeric token in a rendered string to the grounded set. */
function collect(values: Set<string>, rendered: string): void {
  for (const token of numericTokens(rendered)) values.add(token);
}
