/**
 * The seam onto #58's matching pipeline — a NARROW port, and a fail-closed
 * default.
 *
 * ## What this port exists to keep out
 *
 * When a merchant's native store is connected, its listings should end up
 * comparable against the same canonical products their external offers already
 * price. Deciding WHICH canonical variant a native variant is, is #58's job and
 * nobody else's: it owns the identifier normalization, the explainable rules and
 * the confidence model, and it is the only thing that may write
 * `native_listing_links` (#57 owns the table and states in as many words that
 * "this domain never decides a match").
 *
 * #84 therefore does not match anything. It ASKS, through the single-method
 * interface below, and records what came back. The interface is deliberately
 * one method wide and takes only ids: there is no parameter through which a
 * title, a display name or a similarity threshold could reach a matcher, which
 * is the fourth wall behind "no name-only automatic linkage" (the other three
 * are the vocabulary, the schema and the `.strict()` request schemas — see
 * `shared-types/src/store-linkage.ts`).
 *
 * ## The unimplemented side FAILS CLOSED, and that is a designed outcome
 *
 * #58 is not on `main`. With no matcher registered, {@link requestCanonicalMatching}
 * returns `matcher_unavailable` and attaches NOTHING. The consequence is
 * correct and worth stating plainly, because a reviewer will ask: the store's
 * listings materialize no native offers, because #57 materializes an offer only
 * for a variant that already has an active canonical attachment, and a variant
 * with none "materializes NOTHING, and that is not a failure". So a merchant
 * who links today gets a working native store, a canonical merchant page and
 * their existing external offers untouched — and their listings join the
 * comparison surface the moment #58 lands and its first convergence runs.
 *
 * The alternative — guessing a canonical variant from a listing title so the
 * page looks populated — is exactly the name-matching this issue forbids, one
 * table over.
 *
 * ## Why a registry and not a constructor parameter
 *
 * The linkage service is reached from two controllers and a resumable job, none
 * of which knows anything about canonical matching; threading a port through
 * three call sites would make every one of them name a dependency it has no
 * opinion about. A single registration point, called once at composition time
 * by the side that OWNS the implementation, keeps the knowledge where it
 * belongs. It is a module-level binding rather than a mutable cache: it is
 * written once at startup and read thereafter, and {@link resetCanonicalMatcher}
 * exists for tests rather than for a runtime path.
 */

import type { StoreLinkageMatchState } from '@mercaria/shared-types';

/** What the linkage side knows about a native variant: its ids, and nothing else. */
export interface CanonicalMatchTarget {
  listingId: string;
  productVariantId: string;
}

/** What one matching run reports back. Counts and a verdict — never a match itself. */
export interface CanonicalMatchingReport {
  /** How many native variants were handed to the matcher. */
  requested: number;
  /** How many it attached to a canonical variant. */
  attached: number;
  /** How many it could not decide. They stay unattached, and that is honest. */
  undecided: number;
}

/**
 * #58's side of the seam. ONE method, taking ids and a store scope.
 *
 * The implementation is expected to write `native_listing_links` itself, in its
 * own transaction, through #57's repository — this port returns counts so the
 * caller can record a verdict, and deliberately does not return matches for the
 * caller to persist. Two writers of one attachment table is the disagreement
 * ADR 0002 exists to prevent.
 */
export interface CanonicalMatcherPort {
  matchNativeVariants(input: {
    storeId: string;
    targets: readonly CanonicalMatchTarget[];
  }): Promise<CanonicalMatchingReport>;
}

/**
 * The registered matcher, or `undefined` while #58 has not landed.
 *
 * Module-level and written once at composition time. Deliberately NOT exported:
 * the only ways to reach it are the three functions below, so a caller cannot
 * read it, find it absent and improvise.
 */
let registeredMatcher: CanonicalMatcherPort | undefined;

/**
 * Register #58's matcher. Called once, at composition time, by the side that
 * owns the implementation.
 */
export function registerCanonicalMatcher(matcher: CanonicalMatcherPort): void {
  registeredMatcher = matcher;
}

/** Drop the registration. For tests, which must not leak a matcher between files. */
export function resetCanonicalMatcher(): void {
  registeredMatcher = undefined;
}

/** Whether a matcher is available at all — what the operator surface reports. */
export function hasCanonicalMatcher(): boolean {
  return registeredMatcher !== undefined;
}

/** What one matching request produced, plus WHY when it produced nothing. */
export interface CanonicalMatchingOutcome {
  state: StoreLinkageMatchState;
  report: CanonicalMatchingReport;
}

/**
 * Ask #58 to attach a store's native variants to canonical variants.
 *
 * Four outcomes, each distinguishable in the request's `match_state` so an
 * operator trace never has to guess which happened:
 *
 *  - `nothing_to_match` — the store publishes nothing. Not a failure.
 *  - `matcher_unavailable` — no matcher is registered. Nothing is attached and
 *    nothing is guessed. This is the state on `main` today.
 *  - `partial` — the matcher ran and left some variants undecided. They stay
 *    unattached, which is the fail-closed reading of "I do not know".
 *  - `matched` — every target got an answer.
 *
 * A matcher that THROWS is not caught here. Attaching a catalogue to the wrong
 * canonical products is worse than a linkage that has to be retried, and the
 * caller's resumable job already knows how to record the error and leave the
 * request claimable.
 */
export async function requestCanonicalMatching(input: {
  storeId: string;
  targets: readonly CanonicalMatchTarget[];
}): Promise<CanonicalMatchingOutcome> {
  const empty: CanonicalMatchingReport = { requested: 0, attached: 0, undecided: 0 };

  if (input.targets.length === 0) {
    return { state: 'nothing_to_match', report: empty };
  }
  if (!registeredMatcher) {
    return {
      state: 'matcher_unavailable',
      report: { requested: input.targets.length, attached: 0, undecided: input.targets.length },
    };
  }

  const report = await registeredMatcher.matchNativeVariants(input);
  return { state: report.undecided > 0 ? 'partial' : 'matched', report };
}
