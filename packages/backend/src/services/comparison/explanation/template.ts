/**
 * The rule-based explanation (#96 explanation rules 5, 6 and 7).
 *
 * PURE, deterministic, and NOT a degraded mode. Rule 6 asks for templates "for
 * simple comparisons and fallback", and a two-product comparison with three
 * differing rows is legitimately answered without a model at all — faster,
 * cheaper, and grounded by construction because every sentence is composed from
 * a value the package already carries.
 *
 * ## It is also the floor under acceptance 7
 *
 * "The deterministic comparison and solver still work when model services are
 * unavailable" is not a `try`/`catch`: the templates run whenever a provider is
 * absent, refuses or is rejected, so the surface has an explanation in every
 * case and the table beneath it never depended on one.
 *
 * ## Every sentence here would pass the validator
 *
 * That is asserted by a test rather than assumed, and it is the useful property:
 * the templates and the validator agree on what a grounded sentence is, so a
 * change to one that breaks the other is a red build rather than a paragraph
 * nobody can explain. It also means the template output can be handed to the
 * same renderer as a generated one — the two differ in `state` and provenance
 * and in nothing a client has to branch on.
 */

import {
  COMPARISON_TEMPLATE_VERSION,
  EXPLANATION_SCHEMA_VERSION,
  type ComparisonExplanation,
  type ExplanationPackage,
  type ExplanationPoint,
  type ExplanationRejection,
  type ExplanationSentence,
} from '@mercaria/shared-types';
import { MAX_EXPLANATION_POINTS, MAX_EXPLANATION_SENTENCES } from '../policy.js';

/**
 * Render the deterministic explanation.
 *
 * @param rejections What was tried and refused, if anything. Carried onto the
 *   result so "why is this the templated version" is answerable from the
 *   response — an operator debugging a provider should not have to correlate
 *   logs to find out it is being rejected.
 */
export function renderTemplateExplanation(
  pkg: ExplanationPackage,
  rejections: readonly ExplanationRejection[] = [],
): ComparisonExplanation {
  return {
    state: 'template',
    summary: composeSummary(pkg),
    points: composePoints(pkg),
    provenance: {
      provider: 'deterministic_template',
      // Empty rather than a version string: there is no prompt. A value here
      // would be a fact about a thing that does not exist.
      promptVersion: '',
      schemaVersion: EXPLANATION_SCHEMA_VERSION,
      comparisonPolicyVersion: pkg.comparisonPolicyVersion,
    },
    templateVersion: COMPARISON_TEMPLATE_VERSION,
    rejections,
  };
}

/**
 * The opening sentences: what is being compared, and what can be bought.
 *
 * Purchasability is stated from {@link ExplanationSubject.acquisition} and from
 * nothing else, which is product-comparison rule 8 held by the template having
 * no other field to read.
 */
function composeSummary(pkg: ExplanationPackage): readonly ExplanationSentence[] {
  const sentences: ExplanationSentence[] = [];

  const purchasable = pkg.subjects.filter((subject) => subject.acquisition === 'purchasable');
  const unavailable = pkg.subjects.filter((subject) => subject.acquisition === 'unavailable');

  if (purchasable.length > 0) {
    sentences.push({
      text: `Comparing ${listNames(purchasable.map((subject) => subject.name))}, priced in ${pkg.comparisonCurrency}.`,
      citedRefs: purchasable.map((subject) => subject.ref),
    });
  }
  if (unavailable.length > 0) {
    sentences.push({
      text: `${listNames(unavailable.map((subject) => subject.name))} ${unavailable.length === 1 ? 'has' : 'have'} no offer available right now.`,
      citedRefs: unavailable.map((subject) => subject.ref),
    });
  }

  // The cheapest KNOWN item price, and only when one subject actually has the
  // lowest. Two subjects tied is not a "cheapest", and saying it is would be
  // the first ungrounded sentence in an otherwise grounded paragraph.
  const cheapest = lowestPricedSubject(pkg);
  if (cheapest !== undefined) {
    sentences.push({
      text: `${cheapest.name} has the lowest known item price at ${String(cheapest.lowestKnownItemPrice)}.`,
      citedRefs: [cheapest.ref],
    });
  }

  if (pkg.gaps.length > 0) {
    // Rule 7: state what is missing rather than filling it in. The gap list is
    // summarized by COUNT and by the first label, never enumerated — a
    // paragraph naming eleven absent specifications is not an explanation.
    const first = pkg.gaps[0];
    sentences.push({
      text:
        pkg.gaps.length === 1
          ? `One fact is not recorded: ${first.label}.`
          : `${String(pkg.gaps.length)} facts are not recorded, starting with ${first.label}.`,
      citedRefs: [first.subjectRef],
    });
  }

  return sentences.slice(0, MAX_EXPLANATION_SENTENCES);
}

/** One point per tradeoff, then one per failed constraint. */
function composePoints(pkg: ExplanationPackage): readonly ExplanationPoint[] {
  const points: ExplanationPoint[] = [];

  for (const tradeoff of pkg.tradeoffs) {
    points.push({
      subjectRef: tradeoff.betterSubjectRef,
      kind: 'tradeoff',
      text: `${tradeoff.label}: ${tradeoff.betterValue} against ${tradeoff.worseValue}.`,
      citedRefs: [tradeoff.betterSubjectRef, tradeoff.worseSubjectRef],
    });
  }

  for (const constraint of pkg.constraints) {
    for (const [subjectRef, outcome] of Object.entries(constraint.outcomes)) {
      if (outcome === 'failed') {
        points.push({
          subjectRef,
          kind: 'unknown_fact',
          text: `Requirement not met: ${constraint.explanation}.`,
          citedRefs: [constraint.constraintRef, subjectRef],
        });
      } else if (outcome === 'unknown') {
        points.push({
          subjectRef,
          kind: 'unknown_fact',
          text: `Requirement cannot be checked: ${constraint.explanation}.`,
          citedRefs: [constraint.constraintRef, subjectRef],
        });
      }
    }
  }

  return points.slice(0, MAX_EXPLANATION_POINTS);
}

/**
 * The one subject with the strictly lowest known item price, or `undefined`.
 *
 * Compared on the RENDERED string's numeric part rather than re-derived,
 * because the package carries no machine amount — deliberately, since a
 * provider has no use for one. Every subject's price is in the comparison's one
 * currency, so the comparison is well defined.
 */
function lowestPricedSubject(
  pkg: ExplanationPackage,
): (ExplanationPackage['subjects'][number] & { lowestKnownItemPrice: string }) | undefined {
  let best: { subject: ExplanationPackage['subjects'][number]; amount: number } | undefined;
  let tied = false;
  for (const subject of pkg.subjects) {
    if (subject.lowestKnownItemPrice === undefined) continue;
    const amount = Number.parseFloat(subject.lowestKnownItemPrice);
    if (Number.isNaN(amount)) continue;
    if (best === undefined || amount < best.amount) {
      best = { subject, amount };
      tied = false;
    } else if (amount === best.amount) {
      tied = true;
    }
  }
  if (best === undefined || tied) return undefined;
  const subject = best.subject;
  if (subject.lowestKnownItemPrice === undefined) return undefined;
  return { ...subject, lowestKnownItemPrice: subject.lowestKnownItemPrice };
}

/** `A`, `A and B`, `A, B and C`. Deterministic, and no locale in it. */
function listNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
