/**
 * The bounded clarification state machine (#95 "Clarification policy").
 *
 * PURE: no database, no clock. The SESSION is a row (`search_intent_sessions`);
 * the DECISIONS about it are here, so "does this question repeat" and "may this
 * session ask again" are answerable from a state value and a list rather than
 * from a query.
 *
 * ## Repetition is impossible, not discouraged (rule 7)
 *
 * Three bounds compose, and each closes a way round the others:
 *
 * 1. **A KIND is asked at most once per session.** The session records
 *    `asked_kinds`, and a kind already in it produces no question — which is why
 *    `IntentClarificationKind` is a closed vocabulary rather than free text: two
 *    phrasings of "did you mean laptops or tablets" are one KIND, and a
 *    text-comparison anti-repetition rule would let the second through.
 * 2. **A session runs at most {@link MAX_CLARIFICATION_ROUNDS} rounds.** On the
 *    session rather than the request, because a per-request bound is no bound at
 *    all — every answer starts a new request.
 * 3. **At most {@link MAX_CLARIFICATIONS_PER_RESULT} questions at once.** A
 *    shopper answering four questions before seeing anything has been given a
 *    form, not a search.
 *
 * Past the bounds the surface answers with whatever it understood and asks
 * nothing more, which is rule 2 ("do not block a useful result when safe
 * defaults can be shown transparently") arriving by exhaustion rather than by
 * judgement — and the defaults it used are in the paraphrase either way, so the
 * transparency does not depend on the bound.
 *
 * ## "Search anyway" is not a special path (rule 8)
 *
 * Every result is already a complete, runnable plan: the questions are BESIDE
 * it, never instead of it. So `Search anyway` is the client simply not sending
 * an answer — there is no endpoint for it and no state it moves — and the
 * absence of that endpoint is what guarantees a clarification can never block a
 * search.
 */

import {
  INTENT_CLARIFICATION_KINDS,
  MAX_CLARIFICATIONS_PER_RESULT,
  MAX_CLARIFICATION_OPTIONS,
  MAX_CLARIFICATION_ROUNDS,
  type IntentClarification,
  type IntentClarificationKind,
} from '@mercaria/shared-types';

/** The session state a clarification decision reads. */
export interface ClarificationState {
  /** Kinds this session has already asked. A kind appears at most once. */
  readonly askedKinds: readonly IntentClarificationKind[];
  /** How many rounds have been asked. Incremented when questions are emitted. */
  readonly rounds: number;
}

/** How many more rounds this session may ask. Never negative. */
export function clarificationRoundsRemaining(state: ClarificationState): number {
  return Math.max(0, MAX_CLARIFICATION_ROUNDS - state.rounds);
}

/** The candidate ambiguities a plan produced, and what a question would offer. */
export interface ClarificationCandidate {
  readonly kind: IntentClarificationKind;
  /** The question, composed by Mercaria from the structure. Never model prose. */
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

/**
 * Decide which questions to ask, if any.
 *
 * Candidates arrive in the order the interpretation produced them, which is the
 * order the ambiguous phrases appear in the query, and that ordering is kept:
 * the first ambiguity a shopper wrote is the one they are most likely to want
 * to resolve, and re-ordering by a notion of "materiality" would need a ranking
 * of question kinds nobody has defined.
 */
export function selectClarifications(
  state: ClarificationState,
  candidates: readonly ClarificationCandidate[],
): IntentClarification[] {
  if (clarificationRoundsRemaining(state) === 0) return [];
  const asked = new Set(state.askedKinds);
  const selected: IntentClarification[] = [];
  for (const candidate of candidates) {
    if (selected.length >= MAX_CLARIFICATIONS_PER_RESULT) break;
    if (asked.has(candidate.kind)) continue;
    // A question with fewer than two options is not a question: one option is a
    // statement and zero is a bug. Both would ask a shopper to confirm
    // something Mercaria had already decided, which is worse than deciding it
    // and saying so in the paraphrase.
    if (candidate.options.length < 2) continue;
    asked.add(candidate.kind);
    selected.push({
      id: `clar-${candidate.kind}`,
      kind: candidate.kind,
      question: candidate.question,
      options: candidate.options.slice(0, MAX_CLARIFICATION_OPTIONS),
    });
  }
  return selected;
}

/**
 * The answer a shopper gave, resolved against the question that was asked.
 *
 * A string discriminant, for the `strict: false` narrowing reason every result
 * union in this codebase now uses. `not_open` covers both "this session never
 * asked that" and "it asked and has since been answered": the two are the same
 * fact from the client's side (the answer changes nothing) and distinguishing
 * them in the response would leak the session's internal history to a caller
 * who does not hold the session.
 */
export type ClarificationAnswerResolution =
  | { readonly status: 'applied'; readonly kind: IntentClarificationKind; readonly optionId: string }
  | { readonly status: 'not_open' };

/**
 * Resolve one answer against the session's open question.
 *
 * The OPEN question is the authority, not the answer's own claim about which
 * question it belongs to: a client replaying an answer to a question two rounds
 * old would otherwise re-apply a decision the shopper has since changed.
 */
export function resolveClarificationAnswer(
  openClarificationId: string | undefined,
  answer: { readonly clarificationId: string; readonly optionId: string },
): ClarificationAnswerResolution {
  if (openClarificationId === undefined || openClarificationId !== answer.clarificationId) {
    return { status: 'not_open' };
  }
  // The kind is READ BACK out of the closed tuple rather than cast out of the
  // id's suffix. A cast would let a client that guessed an id shape name a kind
  // this vocabulary does not contain, and the session would then record it in
  // `asked_kinds` — where a CHECK refuses it, one layer too late to be a good
  // error message.
  const suffix = answer.clarificationId.slice('clar-'.length);
  const kind = INTENT_CLARIFICATION_KINDS.find((candidate) => candidate === suffix);
  if (kind === undefined) return { status: 'not_open' };
  return { status: 'applied', kind, optionId: answer.optionId };
}
