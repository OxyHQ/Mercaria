/**
 * Composing and CHECKING what is said about a finding (#97 finding 10,
 * acceptance 4 and 7).
 *
 * PURE, and three things live here: the deterministic template every finding
 * gets, the package a provider is shown, and the validator a provider's draft
 * must survive.
 *
 * ## The validator is what makes the seam safe to close
 *
 * A draft is refused, in full, for any of six reasons — and each of them is a
 * way a summary could assert something the finding does not say:
 *
 * - `unknown_record_ref` — a citation naming a handle this finding never
 *   minted. #96's `validRefs` device: the whitelist is assembled from the refs
 *   that actually appear in the package, never from the domain's whole record
 *   table, so a provider cannot cite a real product that was not part of this
 *   observation.
 * - `uncited_sentence` — a sentence citing nothing at all. #97 evaluation 5
 *   permits a SUMMARY of a completed finding; a sentence pointing at nothing is
 *   a new claim.
 * - `unsupported_number` — a numeral that does not appear in the finding.
 *   This is the one that catches the failure everybody worries about: a model
 *   writing "now 189 €" about a plan that costs 289.
 * - `forbidden_action_language` — a draft that tells the shopper Mercaria has
 *   bought, ordered, reserved or messaged on their behalf. The vocabulary is
 *   the domain's own {@link SHOPPING_AGENT_FORBIDDEN_ACTIONS} plus the plain
 *   words for them, because a shopper reads English rather than a value.
 * - `too_many_sentences` / `sentence_too_long` — bounds, so a summary is a
 *   summary.
 *
 * A rejection is never fatal: the template renders and the rejections are
 * recorded beside it, so an operator can see a provider drifting rather than a
 * surface quietly going quiet.
 */

import {
  MAX_SHOPPING_AGENT_SUMMARY_SENTENCES,
  MAX_SHOPPING_AGENT_SUMMARY_SENTENCE_CHARS,
  SHOPPING_AGENT_FORBIDDEN_ACTIONS,
  SHOPPING_AGENT_SUMMARY_SCHEMA_VERSION,
  type ShoppingAgentFinding,
  type ShoppingAgentJobKind,
  type ShoppingAgentSummary,
  type ShoppingAgentSummaryDraft,
  type ShoppingAgentSummaryRejection,
  type ShoppingAgentSummarySentence,
} from '@mercaria/shared-types';
import type { ShoppingAgentSummaryPackage } from './summary.port.js';

/**
 * Words a summary may never contain, whatever a provider was asked for.
 *
 * DERIVED from the forbidden-action vocabulary (so a member added there is
 * covered here without anybody remembering) and extended with the plain English
 * a model would actually write. The extension is the load-bearing half: a
 * provider will never emit the literal token `place_order`, and "I've placed
 * your order" is exactly what it might emit.
 */
const FORBIDDEN_ACTION_PHRASES: readonly string[] = [
  ...SHOPPING_AGENT_FORBIDDEN_ACTIONS.map((action) => action.replace(/_/g, ' ')),
  'bought it',
  'purchased it',
  'placed your order',
  'placed an order',
  'ordered it',
  'added to your cart',
  'checked out',
  'paid for',
  'reserved it',
  'contacted the seller',
  'messaged the seller',
  'accepted the terms',
  'on your behalf',
];

/** Every numeral in a string, as it was written. #96's own token rule. */
export function numericTokens(text: string): readonly string[] {
  // The separator class is written as ESCAPES rather than as literal characters:
  // a narrow no-break space is what a locale-aware formatter puts between a
  // figure and its currency, and pasting one into source is invisible to every
  // reader and to `git diff`.
  return (
    text
      .match(/\d[\d.,\u00a0\u202f\s]*\d|\d/g)
      ?.map((token) => token.replace(/[\s\u00a0\u202f]/g, '')) ?? []
  );
}

/**
 * The package a provider is shown.
 *
 * Named field by field and never spread from a row: #97 privacy 5 forbids
 * sending a private note to a provider, and the way a note would actually
 * arrive is `{...finding, ...agent}`.
 */
export function buildShoppingAgentSummaryPackage(input: {
  readonly finding: ShoppingAgentFinding;
  /**
   * The agent's kind, passed IN rather than read off the finding.
   *
   * A finding has no `kind` column — it belongs to an agent that has one — and
   * denormalising it onto the row would be a second representation of one fact
   * that an edit could make disagree.
   */
  readonly kind: ShoppingAgentJobKind;
  readonly objectiveRendered?: string;
  readonly objectiveDeltaRendered?: string;
}): ShoppingAgentSummaryPackage {
  const { finding } = input;
  const tokens = new Set<string>();
  for (const rendered of [input.objectiveRendered, input.objectiveDeltaRendered]) {
    if (rendered === undefined) continue;
    for (const token of numericTokens(rendered)) tokens.add(token);
  }
  for (const count of [
    finding.satisfiedConstraintIds.length,
    finding.failedConstraintIds.length,
    finding.unknownConstraintIds.length,
    finding.selection.length,
  ]) {
    tokens.add(String(count));
  }

  return {
    findingId: finding.id,
    kind: input.kind,
    outcome: finding.outcome,
    completeness: finding.completeness,
    freshness: finding.freshness,
    ...(input.objectiveRendered === undefined
      ? {}
      : { objectiveRendered: input.objectiveRendered }),
    ...(input.objectiveDeltaRendered === undefined
      ? {}
      : { objectiveDeltaRendered: input.objectiveDeltaRendered }),
    lineCount: finding.selection.length,
    satisfiedConstraintCount: finding.satisfiedConstraintIds.length,
    failedConstraintCount: finding.failedConstraintIds.length,
    unknownConstraintCount: finding.unknownConstraintIds.length,
    records: finding.records,
    validRefs: finding.records.map((record) => record.ref),
    numericTokens: [...tokens],
  };
}

/** Whether a draft may be published, and every reason it may not. */
export type ShoppingAgentSummaryValidation =
  | { readonly state: 'accepted' }
  | { readonly state: 'rejected'; readonly rejections: readonly ShoppingAgentSummaryRejection[] };

/**
 * Check a draft against the finding it claims to summarise.
 *
 * Returns EVERY rejection rather than the first, #96's own rule: an operator
 * comparing two providers needs the shape of what each gets wrong, not the
 * alphabetically earliest.
 */
export function validateShoppingAgentSummaryDraft(
  pkg: ShoppingAgentSummaryPackage,
  draft: ShoppingAgentSummaryDraft,
): ShoppingAgentSummaryValidation {
  const rejections = new Set<ShoppingAgentSummaryRejection>();

  if (draft.sentences.length === 0) rejections.add('empty_draft');
  if (draft.sentences.length > MAX_SHOPPING_AGENT_SUMMARY_SENTENCES) {
    rejections.add('too_many_sentences');
  }

  const valid = new Set(pkg.validRefs);
  const supported = new Set(pkg.numericTokens);

  for (const sentence of draft.sentences) {
    const text = sentence.text.trim();
    if (text.length > MAX_SHOPPING_AGENT_SUMMARY_SENTENCE_CHARS) {
      rejections.add('sentence_too_long');
    }
    if (sentence.recordRefs.length === 0) rejections.add('uncited_sentence');
    for (const ref of sentence.recordRefs) {
      if (!valid.has(ref)) rejections.add('unknown_record_ref');
    }
    for (const token of numericTokens(text)) {
      if (!supported.has(token)) rejections.add('unsupported_number');
    }
    const lowered = text.toLowerCase();
    if (FORBIDDEN_ACTION_PHRASES.some((phrase) => lowered.includes(phrase))) {
      rejections.add('forbidden_action_language');
    }
  }

  if (rejections.size === 0) return { state: 'accepted' };
  return { state: 'rejected', rejections: [...rejections].sort() };
}

/**
 * The summary every finding gets, composed from the finding alone.
 *
 * This is what #97 acceptance 7 means by "templated notifications remain
 * functional": it is not a fallback that degrades the surface, it is the
 * summary — a provider only ever REPLACES it, and only after surviving the
 * validator above.
 */
export function renderShoppingAgentSummaryTemplate(
  pkg: ShoppingAgentSummaryPackage,
  rejections: readonly ShoppingAgentSummaryRejection[] = [],
): ShoppingAgentSummary {
  const sentences: ShoppingAgentSummarySentence[] = [];
  const refs = pkg.validRefs.slice(0, 3);

  if (pkg.outcome === 'qualified') {
    const amount = pkg.objectiveRendered;
    sentences.push({
      text:
        amount === undefined
          ? 'This objective is met by the current offers.'
          : `This objective is met at ${amount}.`,
      recordRefs: refs,
    });
    if (pkg.objectiveDeltaRendered !== undefined) {
      sentences.push({
        text: `That is a change of ${pkg.objectiveDeltaRendered} against the last comparable finding.`,
        recordRefs: refs,
      });
    }
  } else if (pkg.outcome === 'not_qualified') {
    sentences.push({
      text:
        pkg.objectiveRendered === undefined
          ? 'The current offers do not meet this objective.'
          : `The best current answer is ${pkg.objectiveRendered}, which does not meet this objective.`,
      recordRefs: refs,
    });
  } else {
    sentences.push({
      text: 'This evaluation could not be completed from the information available.',
      recordRefs: refs,
    });
  }

  if (pkg.unknownConstraintCount > 0) {
    sentences.push({
      text: `${String(pkg.unknownConstraintCount)} of your requirements could not be checked against the recorded facts.`,
      recordRefs: refs,
    });
  }
  if (pkg.freshness !== 'current') {
    sentences.push({
      text: 'Some of the offers behind this are not freshly confirmed.',
      recordRefs: refs,
    });
  }

  return {
    source: 'deterministic_template',
    sentences: sentences.slice(0, MAX_SHOPPING_AGENT_SUMMARY_SENTENCES),
    rejections,
  };
}

/** A provider's accepted draft, stamped with who produced it. */
export function acceptedShoppingAgentSummary(input: {
  readonly draft: ShoppingAgentSummaryDraft;
  readonly providerId: string;
  readonly promptVersion: string;
}): ShoppingAgentSummary {
  return {
    source: 'provider',
    sentences: input.draft.sentences,
    providerId: input.providerId,
    promptVersion: input.promptVersion,
    schemaVersion: SHOPPING_AGENT_SUMMARY_SCHEMA_VERSION,
  };
}
