/**
 * Redacting a search query BEFORE it is persisted (#77 search privacy 2,
 * acceptance 4).
 *
 * ## The decision this module executes
 *
 * **Raw query text is never retained.** What reaches Postgres is the string
 * after every recognised sensitive pattern has been replaced, and only for
 * `ANALYTICS_QUERY_TEXT_RETENTION_DAYS`; after that a sweep nulls even that and
 * the normalized tokens survive alone. There is deliberately no configuration
 * that turns redaction off and no "store the original for debugging" path — the
 * one that would exist is the one that would be found in an incident.
 *
 * ## A DENY-list here, and why that is the right way round for once
 *
 * The payments domain redacts by allow-list because it is reducing somebody
 * else's object to the keys Mercaria may keep, and an unknown key is a key that
 * might be sensitive. A search query is not an object with keys; it is one
 * string a person typed, and the useful content of it is unbounded by
 * construction — "wedding dress size 12" has to survive or the feature has no
 * point. So the only expressible rule is "recognise the shapes that carry
 * identity and destroy them", and the honest consequence is that this is
 * best-effort on the text and NOT a guarantee.
 *
 * That is exactly why the text has its own short retention on top: the two
 * controls answer different halves. The patterns handle what can be recognised;
 * the retention handles what cannot. And the NORMALIZED TOKENS — which are what
 * every aggregate actually reads — drop anything that survived redaction but
 * still looks like an identifier, because a token that appears once is dropped
 * by the reporting floor anyway.
 *
 * ## Order matters and is load-bearing
 *
 * Card numbers and IBANs are matched BEFORE the generic long-digit-run rule, or
 * a card number would be reported as `long_digit_run` and an operator watching
 * for `payment_card` would see nothing. URLS-WITH-CREDENTIALS before emails,
 * because `https://user:pass@host` contains an at-sign and must be reported as
 * `url_with_credentials`. Every ordering dependency has a fixture.
 *
 * (That sentence read "Emails before URLs" until #77's privacy review measured
 * it against `RULES`, which has `url_with_credentials` first — the prose
 * contradicted both the array and the reason it gave for the ordering.)
 */

import type { AnalyticsQueryRedactionKind } from '@mercaria/shared-types';
import {
  ANALYTICS_QUERY_REDACTED_MARKER,
  ANALYTICS_QUERY_REDACTION_KINDS,
} from '@mercaria/shared-types';

/** The longest query kept. Beyond this it is truncated and reported `oversized`. */
const MAX_QUERY_LENGTH = 256;

/** The longest normalized token kept. A 60-character "word" is an identifier. */
const MAX_TOKEN_LENGTH = 40;

/** The most tokens kept from one query. */
const MAX_TOKENS = 24;

/**
 * One recognised shape.
 *
 * `kind` is the bounded code stored beside the redacted text; `pattern` is
 * applied in the array's order, which is the order the module docblock
 * explains.
 */
interface RedactionRule {
  readonly kind: AnalyticsQueryRedactionKind;
  readonly pattern: RegExp;
}

/**
 * The rules, in application order.
 *
 * Each pattern is deliberately a little BROADER than the strict format it
 * names. A redaction that only catches correctly-formatted input catches the
 * cases that were never going to be a problem and misses the typo'd paste that
 * was — so `+34 600 123 456` and `600-123-456` are both a phone number here.
 *
 * `600123456` is NOT: the third branch's separators are mandatory (see the rule
 * below), so a bare nine-digit run is destroyed by `long_digit_run` instead and
 * REPORTED as one. This sentence claimed otherwise until #77's privacy review
 * measured it. The redaction is right and only the CODE is wrong, which matters
 * because the codes are the operational signal — an operator watching
 * `payment_card`/`phone` counts is reading a distribution the catch-all rule
 * shifts, exactly as the cards-before-digit-run note above describes.
 *
 * The cost of a FALSE POSITIVE is higher than "a search term nobody can read",
 * and the review measured that too: a 13-digit EAN, an ISBN-13, a 15-digit IMEI
 * and a GTIN-14 all fall inside the card rule's 13–19 digit range and are
 * reported as `payment_card`, so ordinary barcode traffic both loses its tokens
 * and inflates the one counter that is supposed to mean "somebody pasted a card
 * number into the search box". See `docs/reviews/2026-08-16-analytics-privacy-retention-review.md`.
 */
const RULES: readonly RedactionRule[] = [
  {
    // Before the email rule: `https://user:pass@host` contains an at-sign, and
    // reporting it as an email would name the wrong exposure.
    kind: 'url_with_credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi,
  },
  {
    kind: 'email',
    pattern: /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  },
  {
    // A JWT, an `sk_`/`pk_`/`ghp_`-style key, an AWS key id, or a long
    // high-entropy run with the punctuation a secret carries and prose does not.
    kind: 'secret_token',
    pattern:
      /\b(?:eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|(?:sk|pk|rk|whsec|ghp|gho|ghs|xox[baprs])_[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|mgs_[A-Za-z0-9_-]{20,}|mgp_[A-Za-z0-9_-]{20,}|mgx_[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    // IBAN before the card and digit-run rules: an ES IBAN is 24 characters of
    // mostly digits and would otherwise be reported as a long digit run.
    kind: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Za-z0-9]{4}[ ]?){3,7}[A-Za-z0-9]{1,4}\b/g,
  },
  {
    // 13–19 digits with optional spaces or hyphens — every major card network's
    // range, including the 19-digit UnionPay/Maestro forms a 16-digit-only
    // pattern silently misses.
    kind: 'payment_card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
  },
  {
    // A street address: a house number followed by words, or a Spanish-style
    // `calle …, 3º 2ª`. Broad on purpose — see the docblock.
    kind: 'postal_address',
    pattern:
      /\b(?:\d{1,4}\s+[A-Za-zÀ-ÿ.'-]+(?:\s+[A-Za-zÀ-ÿ.'-]+){0,3}\s+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way|plaza|square|sq)\b|(?:calle|carrer|avinguda|avenida|plaza|plaça|paseo|passeig|carretera|camino|cami)\s+[A-Za-zÀ-ÿ.'-]+(?:\s+[A-Za-zÀ-ÿ0-9.'ºª-]+){0,4})/gi,
  },
  {
    // Phone numbers, in the three shapes people actually type: an international
    // prefix, a parenthesised area code, or three-plus separated groups.
    //
    // The separators in the third branch are MANDATORY, and that is the whole
    // difference between this rule and one that eats the catalogue. With them
    // optional, `iphone 15 128 256` is three digit groups and reads as a phone
    // number — a redaction that destroys the most valuable queries in the
    // dataset while catching nothing a human would call a phone number.
    kind: 'phone',
    pattern:
      /(?:\+\d{1,3}[ .-]?\d{2,4}(?:[ .-]?\d{2,4}){1,4}|\(\d{2,4}\)[ .-]?\d{3}[ .-]?\d{4}|\b\d{3}[ .-]\d{2,4}[ .-]\d{2,4}(?:[ .-]\d{2,4})?\b)/g,
  },
  {
    // The catch-all, last: anything else that is nine or more consecutive
    // digits is an identifier of some kind — an order number, a DNI, a tracking
    // code — and none of them belongs in a query report.
    kind: 'long_digit_run',
    pattern: /\b\d{9,}\b/g,
  },
];

/** What redaction produced. */
export interface RedactedQuery {
  /** The text after redaction. Never the original. */
  readonly redactedText: string;
  /** Which shapes were found. Bounded codes, sorted, deduped. */
  readonly redactionKinds: readonly AnalyticsQueryRedactionKind[];
  /** The aggregate unit — lower-cased, punctuation-stripped, bounded. */
  readonly normalizedTokens: readonly string[];
}

/**
 * Redact and normalize a query.
 *
 * Always succeeds: a query is telemetry, and refusing to record one because it
 * looked odd would bias the zero-result and coverage metrics toward exactly the
 * searches most worth seeing.
 */
export function redactSearchQuery(raw: string): RedactedQuery {
  const kinds = new Set<AnalyticsQueryRedactionKind>();

  let text = raw.trim();
  if (text.length > MAX_QUERY_LENGTH) {
    text = text.slice(0, MAX_QUERY_LENGTH);
    kinds.add('oversized');
  }

  for (const rule of RULES) {
    // A fresh RegExp per call: the module-level literals carry `g`, which makes
    // `lastIndex` stateful, and a shared instance would skip matches on every
    // second call in a way that only shows up under load. `replace` resets it,
    // but `test` does not, and the two are one edit apart.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const replaced = text.replace(pattern, ANALYTICS_QUERY_REDACTED_MARKER);
    if (replaced !== text) {
      kinds.add(rule.kind);
      text = replaced;
    }
  }

  return {
    redactedText: text,
    redactionKinds: [...kinds].sort(),
    normalizedTokens: normalizeQueryTokens(text),
  };
}

/**
 * The tokens every aggregate reads.
 *
 * Derived from the REDACTED text, never from the original — otherwise the
 * tokens would outlive the text while still containing what the text was
 * redacted for, which is the failure mode the whole separation exists to
 * prevent.
 *
 * The marker itself is dropped rather than tokenised: a bucket keyed
 * `[redacted]` would merge every query that contained anything sensitive into
 * one very popular "query", which would then clear the reporting floor and
 * appear at the top of a merchant's list.
 */
export function normalizeQueryTokens(text: string): readonly string[] {
  const withoutMarker = text.split(ANALYTICS_QUERY_REDACTED_MARKER).join(' ');
  const tokens: string[] = [];
  for (const candidate of withoutMarker.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (candidate === '') continue;
    if (candidate.length > MAX_TOKEN_LENGTH) continue;
    tokens.push(candidate);
    if (tokens.length >= MAX_TOKENS) break;
  }
  return tokens;
}

/** Every redaction kind, re-exported so a fixture suite can assert coverage. */
export const REDACTION_KINDS_COVERED: readonly AnalyticsQueryRedactionKind[] = RULES.map(
  (rule) => rule.kind,
);

/**
 * Every kind in the vocabulary, so a test can assert the rules cover all of
 * them (bar `oversized`, which is a length rule rather than a pattern).
 */
export const ALL_REDACTION_KINDS = ANALYTICS_QUERY_REDACTION_KINDS;
