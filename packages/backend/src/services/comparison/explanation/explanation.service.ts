/**
 * Composing one comparison's explanation (#96 §"Explanation generation").
 *
 * The order of operations is the whole design, and it is the reverse of the
 * tempting one: the DETERMINISTIC answer is composed first and unconditionally,
 * a provider is asked second, and a provider's answer replaces the deterministic
 * one only after it has survived every check in `validation.ts`.
 *
 * Written the other way round — try the model, fall back on error — the
 * fallback is a `catch` block, and a `catch` block is exercised by nothing. Here
 * the templated explanation is on the normal path and the generated one is the
 * exception, so acceptance 7 ("still works when model services are unavailable")
 * is the behaviour of every deployment that has not registered a provider,
 * which today is all of them.
 */

import {
  type ComparisonExplanation,
  type ComparisonInput,
  type ExplanationPackage,
  type ExplanationRejection,
} from '@mercaria/shared-types';
import { log } from '../../../lib/logger.js';
import { explanationProvider } from './adapter.port.js';
import { buildExplanationPackage } from './package.js';
import { renderTemplateExplanation } from './template.js';
import { validateExplanationDraft } from './validation.js';

/**
 * How long a provider gets.
 *
 * A comparison is a page load and the table is already composed, so the budget
 * is what a shopper will wait for a paragraph and not what a model would like.
 * A provider that overruns answers `unavailable` and the templates render.
 */
export const EXPLANATION_DEADLINE_MS = 2_500;

/** What the service produced, plus the package it was produced from. */
export interface ExplanationOutcome {
  readonly explanation: ComparisonExplanation;
  /** The bounded package a provider saw. Returned so an operator can inspect it. */
  readonly pkg: ExplanationPackage;
}

/**
 * Explain one comparison.
 *
 * Never throws. A provider that rejects the promise is a `provider_error`
 * rejection on the templated result, because a comparison surface that 500s
 * because a summarizer is down would make the narrative load-bearing — which is
 * exactly what the deterministic half exists not to be.
 */
export async function explainComparison(input: ComparisonInput): Promise<ExplanationOutcome> {
  const pkg = buildExplanationPackage(input);
  const provider = explanationProvider();

  let outcome: Awaited<ReturnType<typeof provider.draft>>;
  try {
    outcome = await provider.draft(pkg, EXPLANATION_DEADLINE_MS);
  } catch (error) {
    // Logged rather than swallowed: a provider throwing is an operational fact,
    // and the rejection carried on the response is what a client sees.
    log.general.warn(
      { provider: provider.id, error: error instanceof Error ? error.message : 'unknown' },
      '[Comparison] explanation provider threw',
    );
    outcome = { outcome: 'failed', detail: 'provider threw' };
  }

  if (outcome.outcome === 'unavailable') {
    return {
      pkg,
      explanation: renderTemplateExplanation(pkg, [
        { reason: 'provider_unavailable', detail: provider.id },
      ]),
    };
  }
  if (outcome.outcome === 'failed') {
    return {
      pkg,
      explanation: renderTemplateExplanation(pkg, [
        { reason: 'provider_error', detail: outcome.detail },
      ]),
    };
  }

  const validation = validateExplanationDraft(pkg, outcome.draft);
  if (validation.state === 'rejected') {
    // Every rejection is logged with its reason CODE and its short detail — never
    // the draft, which is somebody else's model output and may contain anything.
    log.general.warn(
      {
        provider: provider.id,
        promptVersion: provider.promptVersion,
        reasons: validation.rejections.map((rejection) => rejection.reason),
      },
      '[Comparison] explanation draft rejected',
    );
    return { pkg, explanation: renderTemplateExplanation(pkg, validation.rejections) };
  }

  return {
    pkg,
    explanation: {
      state: 'generated',
      summary: validation.draft.summary,
      points: validation.draft.points,
      provenance: {
        provider: provider.id,
        promptVersion: provider.promptVersion,
        schemaVersion: validation.draft.schemaVersion,
        comparisonPolicyVersion: pkg.comparisonPolicyVersion,
      },
    },
  };
}

/**
 * The explanation for a comparison nothing may summarize.
 *
 * Used when the offers half was withheld entirely: there is no package to build
 * a paragraph from, and a template rendering "comparing A and B" over a page
 * with no prices would be the confident-and-empty output the whole domain
 * refuses.
 */
export function withheldExplanation(
  rejections: readonly ExplanationRejection[],
): ComparisonExplanation {
  return { state: 'unavailable', rejections };
}
