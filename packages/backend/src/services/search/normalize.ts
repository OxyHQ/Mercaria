/**
 * Query normalization (#70 "Query normalization"), and nothing else.
 *
 * PURE: no database, no configuration, no clock. Everything here is a function
 * of the string a shopper typed, which is what lets the whole of #70's
 * normalization contract be tested against exact inputs and what stops a
 * normalization decision quietly becoming a retrieval decision.
 *
 * ## It EXTENDS `services/canonical/normalization.ts`; it does not fork it
 *
 * {@link normalizeEntityName} is the fold the write path applies to every
 * canonical name and every alias before storing it, so a query normalized any
 * other way would compare in a space the indexes do not live in — the exact
 * match stage would then silently never fire. This module calls it for the
 * name-space form and adds only what a QUERY needs and a NAME does not:
 * tokenization, discriminating-token detection and identifier recognition.
 *
 * A second copy of the entity-name fold here is the specific bug this note
 * exists to prevent, and the isolation gate scans for one.
 *
 * ## What "alias expansion without unbounded synonym rewriting" means here
 *
 * #70 asks for alias expansion and warns against unbounded synonym rewriting,
 * and this module resolves that by having NO synonym table at all. Expansion
 * happens against real stored ALIAS ROWS (`canonical_product_aliases`,
 * `brand_aliases`, …) in the retrieval stage — rows somebody recorded, with a
 * kind and a provenance — rather than against a rewrite dictionary nobody owns.
 * There is therefore no expansion budget to bound, because there is no
 * generative step to bound.
 *
 * ## Locale
 *
 * `to_tsvector('simple', …)` is the configuration every canonical search vector
 * in this schema is built with (ADR 0002 D21): proper nouns must not be
 * English-stemmed, "Nike" is not a verb, and a per-locale stemmer would make
 * one product findable in one market and not another. So locale-aware behaviour
 * here is CASE and ACCENT folding, which is locale-independent and correct
 * everywhere, and deliberately not stemming. {@link normalizeSearchQuery} is
 * the only place that decision is made.
 */

import { IDENTIFIER_SCHEMES } from '@mercaria/shared-types';
import type { IdentifierScheme } from '@mercaria/shared-types';
import { normalizeEntityName } from '../canonical/normalization.js';
import { normalizeIdentifier } from '../canonical/identifiers.js';

/**
 * The longest query this surface will read.
 *
 * A bound rather than a truncation refusal, because a shopper who pasted a
 * specification sheet still means something by the first part of it — and an
 * unbounded title is what turns candidate generation into a sequential scan
 * (the `PostgresCandidateSource` lesson). The excess is dropped before
 * tokenization, so nothing downstream can see it.
 */
export const SEARCH_QUERY_MAX_LENGTH = 256;

/** The most tokens any one query contributes to retrieval. */
export const SEARCH_QUERY_MAX_TOKENS = 24;

/**
 * The shortest prefix the prefix stage will run.
 *
 * THREE, and it is not an arbitrary nicety: `pg_trgm`'s index cannot help a
 * pattern shorter than one trigram, so a two-character prefix is a sequential
 * scan of the whole product table on the hottest read path. Below this the
 * stage does not run and the lexical and fuzzy stages answer instead.
 */
export const SEARCH_PREFIX_MIN_LENGTH = 3;

/**
 * Tokens that carry no discriminating power and are dropped from the TOKEN
 * stage — never from the lexical or fuzzy ones, which handle their own.
 *
 * Deliberately tiny and deliberately not a stop-word list per language: this is
 * the set of words that appear in so many canonical product names that a
 * `search_tokens` overlap on one of them returns an arbitrary page of the
 * catalogue. A real multilingual stop-word list belongs to a text
 * configuration, which is `to_tsvector`'s job and not this module's.
 */
const NON_DISCRIMINATING_TOKENS: ReadonlySet<string> = new Set([
  'and',
  'con',
  'de',
  'del',
  'der',
  'die',
  'el',
  'et',
  'for',
  'la',
  'le',
  'les',
  'los',
  'of',
  'para',
  'the',
  'und',
  'with',
  'y',
]);

/** One way the query could be read as a product identifier. */
export interface SearchIdentifierCandidate {
  readonly scheme: IdentifierScheme;
  /** The token, exactly as the shopper typed it. */
  readonly rawValue: string;
  /** The scheme's own normalization — what a lookup compares on. */
  readonly normalizedValue: string;
  /** The cross-scheme 14-digit form, when the scheme collapses into one. */
  readonly canonicalScheme?: string;
  readonly canonicalValue?: string;
}

/** Everything retrieval needs to know about what somebody typed. */
export interface NormalizedSearchQuery {
  /**
   * The bounded, whitespace-collapsed original.
   *
   * Carried because `websearch_to_tsquery` parses the shopper's OWN operators
   * (`"phrase"`, `-exclusion`) and the folded form has already destroyed them.
   * It is never stored, never logged and never echoed in a response.
   */
  readonly bounded: string;
  /** The entity-name-space fold — what an exact-name lookup compares on. */
  readonly normalized: string;
  /** The folded tokens, in order, bounded by {@link SEARCH_QUERY_MAX_TOKENS}. */
  readonly tokens: readonly string[];
  /**
   * The tokens worth a `search_tokens` overlap: model codes, alphanumeric part
   * numbers, anything with a digit in it, and long words. See
   * {@link isDiscriminatingToken}.
   */
  readonly discriminatingTokens: readonly string[];
  /** Every scheme the query validly reads as. Empty for ordinary prose. */
  readonly identifiers: readonly SearchIdentifierCandidate[];
  /**
   * Whether the query is NOTHING BUT an identifier.
   *
   * The retrieval planner reads this: a bare barcode must answer
   * deterministically and must not also drag in every product whose name
   * happens to share three digits with it, which is what an unconditional fuzzy
   * stage would do.
   */
  readonly identifierOnly: boolean;
  /** Whether the query is long enough for the prefix stage to be indexable. */
  readonly prefixEligible: boolean;
}

/**
 * Whether a token is worth matching on its own.
 *
 * Three ways to qualify, and each names a real case:
 *
 * - it contains a DIGIT (`a2560`, `16`, `x100`) — model codes and capacities
 *   are the highest-signal thing in a product title;
 * - it is at least five characters and not a listed filler — long words are
 *   rarely accidental;
 * - it mixes letters and digits — the shape of a part number.
 *
 * A short pure-alphabetic token (`pro`, `max`, `air`) is deliberately NOT
 * discriminating: an overlap on `pro` returns the catalogue.
 */
export function isDiscriminatingToken(token: string): boolean {
  if (NON_DISCRIMINATING_TOKENS.has(token)) return false;
  if (/\d/u.test(token)) return true;
  return token.length >= 5;
}

/**
 * Read one token as every identifier scheme it validly is.
 *
 * Every scheme is TRIED — the shopper did not say which one they pasted, and a
 * thirteen-digit number is legitimately an EAN and an ISBN-13 at once. Invalid
 * normalizations are dropped silently rather than reported: a query is not an
 * identifier assertion, so a mistyped barcode is just a query that found
 * nothing deterministically and fell through to the lexical stages.
 *
 * `brand_model` and `mpn` are EXCLUDED. Both accept essentially any string, so
 * including them would classify every single word as an identifier candidate
 * and make {@link NormalizedSearchQuery.identifierOnly} true for the whole
 * catalogue — turning off fuzzy retrieval for ordinary prose. They are reached
 * instead through the exact-name and alias stages, which is what they actually
 * are: names.
 */
function readIdentifierCandidates(token: string): SearchIdentifierCandidate[] {
  const candidates: SearchIdentifierCandidate[] = [];
  for (const scheme of IDENTIFIER_SCHEMES) {
    if (scheme === 'mpn' || scheme === 'brand_model') continue;
    const normalization = normalizeIdentifier(scheme, token);
    if (normalization.kind !== 'valid') continue;
    const identifier = normalization.identifier;
    candidates.push({
      scheme,
      rawValue: token,
      normalizedValue: identifier.normalizedValue,
      ...(identifier.canonicalScheme === undefined
        ? {}
        : { canonicalScheme: identifier.canonicalScheme }),
      ...(identifier.canonicalValue === undefined
        ? {}
        : { canonicalValue: identifier.canonicalValue }),
    });
  }
  return candidates;
}

/**
 * Normalize one search term.
 *
 * The Unicode step is NFKC rather than NFC, and that is the one place this
 * differs from the write path's fold: a shopper's keyboard produces full-width
 * digits, ligatures and superscripts that a merchant's catalogue never
 * contains, and NFKC is what makes `ｉＰｈｏｎｅ` find `iPhone`. It is applied to
 * the QUERY only — compatibility folding is lossy, and applying it to a stored
 * name would change what the name IS.
 */
export function normalizeSearchQuery(term: string): NormalizedSearchQuery {
  const bounded = term.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, SEARCH_QUERY_MAX_LENGTH);

  // The identifier read runs on the RAW tokens: a barcode may be typed with
  // hyphens or spaces, which the name fold would have collapsed away along with
  // everything else, and `normalizeIdentifier` does its own scheme-specific
  // stripping. Splitting on whitespace alone keeps `978-0-13-235088-4` whole.
  const rawTokens = bounded.split(' ').filter((token) => token.length > 0);
  const identifiers = rawTokens.flatMap(readIdentifierCandidates);
  // DISTINCT TOKENS that read as an identifier, not the identifier COUNT: one
  // thirteen-digit number is legitimately both an EAN and an ISBN-13, so
  // comparing the identifier count against the token count answers `false` for
  // a bare barcode and `true` for `ean <barcode>` — exactly inverted. Measured
  // by `normalize.test.ts` on its first run.
  const identifierTokens = new Set(identifiers.map((identifier) => identifier.rawValue));

  const normalized = normalizeEntityName(bounded);
  const tokens = normalized.length === 0 ? [] : normalized.split(' ').slice(0, SEARCH_QUERY_MAX_TOKENS);
  const discriminatingTokens = tokens.filter(isDiscriminatingToken);

  return {
    bounded,
    normalized,
    tokens,
    discriminatingTokens,
    identifiers,
    // "Nothing but an identifier" is measured against the RAW tokens, so
    // `ean 5012345678900` is not identifier-only and still searches the word.
    identifierOnly: identifierTokens.size > 0 && identifierTokens.size === rawTokens.length,
    prefixEligible: normalized.length >= SEARCH_PREFIX_MIN_LENGTH,
  };
}

/**
 * Escape a value for use inside a SQL `LIKE` pattern.
 *
 * The prefix stage builds `<normalized>%`, and a query containing `%` or `_`
 * would otherwise be a wildcard the shopper did not ask for — `100%` matching
 * every product whose name starts with `100`. The backslash is the default
 * escape character, so it has to be escaped first or it would consume the
 * escapes added after it.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/%/gu, '\\%').replace(/_/gu, '\\_');
}
