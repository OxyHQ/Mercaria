/**
 * What a generated draft has to survive (#96 explanation rule 4).
 *
 * PURE, and the whole of the grounding guarantee. Five independent checks, each
 * of which refuses a DIFFERENT way for a summary to stop being a summary:
 *
 * 1. **Schema** — the draft is the declared shape and the declared version, and
 *    is within the policy's size bounds. A draft that is not the shape cannot be
 *    checked at all, so it is refused before anything else reads it.
 * 2. **Citations resolve.** Every ref in every `citedRefs` is in the package's
 *    `validRefs`. A per-comparison handle has a domain of a few dozen values, so
 *    an invented one cannot accidentally point at a real record.
 * 3. **Every factual sentence cites something.** A sentence with no refs is
 *    refused rather than dropped: dropping it would leave a paragraph that reads
 *    as if the missing claim had been made and verified.
 * 4. **No new numbers.** Every numeric token in every sentence is in the
 *    package's `groundedValues`. This is the check that catches the failure the
 *    issue's benchmark scenario 12 is about — a provider that computes a
 *    plausible difference, converts a currency, or averages two figures.
 * 5. **No changed constraint result, and no forbidden topic.** A provider that
 *    wants to talk about a requirement must ECHO its outcome, and an echo that
 *    disagrees with the deterministic answer is a rejection. Affiliate
 *    economics, merchant plans and payment-rail acceptance are refused by
 *    name — see {@link FORBIDDEN_TOPIC} for the spellings, which are the only
 *    place in this whole domain any of them appears.
 *
 * ## Refusal is total, never partial
 *
 * A draft with one bad sentence is REJECTED WHOLE and the templates render
 * instead. Stripping the offending sentence would leave a paragraph whose
 * argument depends on a claim that is no longer there, and would make the
 * failure invisible: the rejections list is what an operator reads to find out
 * that a provider is inventing figures.
 */

import {
  EXPLANATION_SCHEMA_VERSION,
  type ConstraintSatisfaction,
  type ExplanationDraft,
  type ExplanationPackage,
  type ExplanationRejection,
} from '@mercaria/shared-types';
import {
  MAX_EXPLANATION_POINTS,
  MAX_EXPLANATION_SENTENCE_CHARS,
  MAX_EXPLANATION_SENTENCES,
} from '../policy.js';
import { numericTokens } from './package.js';

/**
 * Topics a recommendation may never mention (explanation rule 8).
 *
 * Matched on the generated TEXT rather than on the package, because the package
 * provably contains none of them — the projection has no field one could reach.
 * What this catches is a provider bringing the topic in from its own training:
 * "this retailer pays Mercaria a commission" is a sentence a model can compose
 * from nothing at all, and it would be both ungrounded and, on this surface,
 * exactly the disclosure the domain exists to prevent.
 *
 * FAIR is here for #74's reason, and the spellings are the ones the ranking and
 * retail-pricing gates already use.
 */
const FORBIDDEN_TOPIC =
  /\bcommission\b|\baffiliate\b|\bkickback\b|\bsubscription\b|\bmerchant plan\b|\bsponsored\b|\bpaid placement\b|\bFAIR\b|FairCoin|faircoin|OxyPay|oxy_?pay|\bmargin\b|\bmarkup\b/i;

/** The outcome of checking a draft. A STRING discriminant; `strict: false` applies. */
export type ExplanationValidation =
  | { readonly state: 'accepted'; readonly draft: ExplanationDraft }
  | { readonly state: 'rejected'; readonly rejections: readonly ExplanationRejection[] };

/**
 * Check one draft against the package it was built from.
 *
 * Returns EVERY problem rather than the first, for the reason #94's constraint
 * validator does: an operator debugging a provider needs the whole list, and a
 * provider that fixed one issue per round trip would take as many rounds as it
 * has bugs.
 */
export function validateExplanationDraft(
  pkg: ExplanationPackage,
  draft: ExplanationDraft,
): ExplanationValidation {
  const rejections: ExplanationRejection[] = [];

  if (draft.schemaVersion !== EXPLANATION_SCHEMA_VERSION) {
    rejections.push({
      reason: 'schema_invalid',
      detail: `draft declares schema ${String(draft.schemaVersion)}`,
    });
  }
  if (!Array.isArray(draft.summary) || !Array.isArray(draft.points)) {
    return {
      state: 'rejected',
      rejections: [
        ...rejections,
        { reason: 'schema_invalid', detail: 'summary and points must both be arrays' },
      ],
    };
  }
  if (draft.summary.length > MAX_EXPLANATION_SENTENCES) {
    rejections.push({
      reason: 'output_too_long',
      detail: `${String(draft.summary.length)} summary sentences`,
    });
  }
  if (draft.points.length > MAX_EXPLANATION_POINTS) {
    rejections.push({
      reason: 'output_too_long',
      detail: `${String(draft.points.length)} points`,
    });
  }

  const validRefs = new Set(pkg.validRefs);
  const grounded = new Set(pkg.groundedValues);
  const subjectRefs = new Set(pkg.subjects.map((subject) => subject.ref));

  for (const sentence of draft.summary) {
    checkText(sentence.text, sentence.citedRefs, grounded, validRefs, rejections);
  }
  for (const point of draft.points) {
    if (!subjectRefs.has(point.subjectRef)) {
      rejections.push({ reason: 'unknown_record_reference', detail: point.subjectRef });
    }
    checkText(point.text, point.citedRefs, grounded, validRefs, rejections);
  }

  checkConstraintEchoes(pkg, draft, rejections);

  return rejections.length === 0
    ? { state: 'accepted', draft }
    : { state: 'rejected', rejections };
}

/** One sentence: length, citations, numbers and topic. */
function checkText(
  text: string,
  citedRefs: readonly string[],
  grounded: ReadonlySet<string>,
  validRefs: ReadonlySet<string>,
  rejections: ExplanationRejection[],
): void {
  if (typeof text !== 'string' || text.trim().length === 0) {
    rejections.push({ reason: 'schema_invalid', detail: 'empty sentence' });
    return;
  }
  if (text.length > MAX_EXPLANATION_SENTENCE_CHARS) {
    rejections.push({ reason: 'output_too_long', detail: text.slice(0, 60) });
  }
  if (!Array.isArray(citedRefs) || citedRefs.length === 0) {
    rejections.push({ reason: 'uncited_statement', detail: text.slice(0, 60) });
  } else {
    for (const ref of citedRefs) {
      if (!validRefs.has(ref)) {
        rejections.push({ reason: 'unknown_record_reference', detail: ref });
      }
    }
  }
  for (const token of numericTokens(text)) {
    if (!grounded.has(token)) {
      rejections.push({ reason: 'introduced_number', detail: token });
    }
  }
  if (FORBIDDEN_TOPIC.test(text)) {
    rejections.push({ reason: 'forbidden_topic', detail: text.slice(0, 60) });
  }
}

/**
 * Every echoed constraint outcome must match the deterministic one.
 *
 * The echo is what makes "may not change constraint results" checkable. A
 * provider that says "the 300 € ceiling is met" without echoing it is caught by
 * the number check (the ceiling is grounded) and by the citation check (the
 * constraint's ref must be cited); a provider that echoes the wrong outcome is
 * caught here, by name.
 */
function checkConstraintEchoes(
  pkg: ExplanationPackage,
  draft: ExplanationDraft,
  rejections: ExplanationRejection[],
): void {
  if (!Array.isArray(draft.constraintEchoes)) {
    rejections.push({ reason: 'schema_invalid', detail: 'constraintEchoes must be an array' });
    return;
  }
  const byRef = new Map(pkg.constraints.map((constraint) => [constraint.constraintRef, constraint]));
  for (const echo of draft.constraintEchoes) {
    const constraint = byRef.get(echo.constraintRef);
    if (constraint === undefined) {
      rejections.push({ reason: 'unknown_constraint_reference', detail: echo.constraintRef });
      continue;
    }
    const expected: ConstraintSatisfaction | 'not_applicable' | undefined =
      constraint.outcomes[echo.subjectRef];
    if (expected === undefined) {
      rejections.push({
        reason: 'unknown_record_reference',
        detail: `${echo.constraintRef}@${echo.subjectRef}`,
      });
      continue;
    }
    if (expected !== echo.satisfaction) {
      rejections.push({
        reason: 'constraint_result_changed',
        detail: `${echo.constraintRef}@${echo.subjectRef}: ${String(echo.satisfaction)} ≠ ${expected}`,
      });
    }
  }
}
