/**
 * The two stored forms of a proposed label (#367 step 6, ADR 0007 D9).
 *
 * D9 asks for the label "in its source locale plus normalized and search forms",
 * and the three are three different jobs:
 *
 * - **The source form** is what the submitter typed, kept verbatim on
 *   `proposed_label`. It is the only one an operator is ever shown, and the only
 *   one that can become a controlled value's LABEL on approval.
 * - **The normalized form** decides CONVERGENCE — is this the same request as
 *   that one. It is the deeper folding `normalizeEntityName` performs (accents
 *   folded, punctuation collapsed, trailing legal suffixes stripped), reused
 *   rather than re-implemented so that a proposal and a canonical brand answer
 *   "is this the same name" identically.
 * - **The search form** decides RETRIEVAL — what LOOKS like it. It is accent
 *   folding and case folding and nothing else.
 *
 * ## Why two forms and not one
 *
 * Legal-suffix stripping is right for convergence and wrong for retrieval.
 * `normalizeEntityName('Limited')` returns `limited` only because the stripper
 * declines to consume everything — but `normalizeEntityName('Acme Ltd')` returns
 * `acme`, and a trigram index built over that space cannot find `Acme Ltd` for
 * somebody typing it. Collapsing the two would make the near-match probe worse
 * at exactly the labels most likely to be duplicated.
 *
 * ## Neither form is ever identity
 *
 * ADR 0007 D1: a label is presentation. Nothing here produces a key, a slug or
 * anything a foreign key could target, and `CatalogProposalSubmission` has no
 * field that could carry one.
 */

import { foldAccents, normalizeEntityName, wordTokens } from '../canonical/normalization.js';

/** The three forms of one proposed label. */
export interface NormalizedProposalLabel {
  /** Verbatim, trimmed only. What the submitter typed. */
  readonly source: string;
  /** The convergence form. `''` when the label has no normalizable content. */
  readonly normalized: string;
  /** The retrieval form. `''` when the label has no letters or digits at all. */
  readonly search: string;
}

/**
 * Fold a proposed label into its three forms.
 *
 * Returns EMPTY normalized/search strings for a label with no letters or digits
 * — a row of punctuation. The caller refuses such a submission rather than
 * storing a proposal nobody can ever converge on or find, which is the same
 * ruling `normalizeEntityName`'s own doc makes for the canonical graph.
 *
 * ## Both forms tokenize through `wordTokens` (#830)
 *
 * The search form used to carry its own copy of the `[^\p{L}\p{N}]` collapse.
 * That class drops combining marks, so a Devanagari label lost its vowel signs
 * in BOTH forms — and fixing only `normalizeEntityName` would have left the two
 * halves of this one return value disagreeing about the same label, written to
 * `normalized_label` and `search_label` on the same row in the same transaction.
 * They share the tokenizer so they cannot diverge again; what still separates
 * them is legal-suffix stripping, which is the difference that is meant to
 * exist.
 */
export function normalizeProposalLabel(raw: string): NormalizedProposalLabel {
  const source = raw.trim();
  return {
    source,
    normalized: normalizeEntityName(source),
    search: wordTokens(foldAccents(source).toLowerCase()).join(' '),
  };
}
