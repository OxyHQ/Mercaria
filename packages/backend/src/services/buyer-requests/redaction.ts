/**
 * Redacting a support message before it is stored (#110 support rule 6).
 *
 * PURE, and the original text is never written down: `writeSupportMessage`
 * stores what this function returns and drops what it was given, so a buyer who
 * pastes a card number into a support thread has not put one in Mercaria's
 * database for the length of a retention window.
 *
 * ## What it recognises, and why the list is short
 *
 * Five kinds. The temptation is a sixth, a seventh and a rule that catches
 * "anything that looks sensitive", and the cost of that is specific: an
 * over-eager pass eats order numbers, tracking references and postal codes, and
 * a support channel that cannot quote an order number is useless for the thing
 * it exists for. So each rule is one Mercaria can recognise with confidence, and
 * the rest is handled by TELLING people not to — support rule 6 says "warned
 * against AND redacted where feasible", and the warning is the storefront's.
 *
 * ## The ORDER of the rules is load-bearing
 *
 * #77's `retention.ts` establishes it and the same three collisions apply here:
 *
 *  - **Credentials first.** `mgs_`/`mgx_`/`mgp_` tokens are long alphanumeric
 *    runs; anything matching them later would leave a fragment behind, and half
 *    a token in a database is still the half an attacker did not have.
 *  - **IBANs before cards.** An IBAN contains a long digit run and would be
 *    partially eaten by the card rule, leaving a country code and a checksum
 *    that identify the account's bank.
 *  - **Cards and IBANs before the phone rule.** A card number written with
 *    spaces matches a loose phone pattern, and reporting it as a phone number
 *    would tell a reader the wrong thing about what was removed.
 *
 * And the phone rule's separators are MANDATORY. Without them `order 4021 8899`
 * is a phone number, and the messages worth keeping are exactly the ones full of
 * reference numbers.
 */

import type { SupportRedactionKind } from '@mercaria/shared-types';

/** What replaces a redacted run. Names the kind, so a reader knows what went. */
const PLACEHOLDER: Record<SupportRedactionKind, string> = {
  payment_card: '[card number removed]',
  iban: '[bank account removed]',
  email_address: '[email address removed]',
  phone_number: '[phone number removed]',
  access_token: '[access token removed]',
};

/**
 * The rules, in the order they must run. See the module docblock.
 *
 * A list rather than a chain of `replace` calls, so the order is data a test can
 * assert rather than the order somebody happened to type — and so a rule added
 * later has to state where it goes.
 */
const RULES: readonly { readonly kind: SupportRedactionKind; readonly pattern: RegExp }[] = [
  // Every Mercaria bearer credential shares the `m…_` + base64url shape. Matched
  // first, and deliberately by PREFIX rather than by entropy: a guess about
  // randomness would miss a short one and eat an unlucky word.
  { kind: 'access_token', pattern: /\bm(?:gs|gx|gp)_[A-Za-z0-9_-]{16,}/g },
  // IBAN: two letters, two check digits, then up to thirty alphanumerics,
  // optionally in groups of four. Before the card rule — see the docblock.
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}[ ]?[A-Za-z0-9]{0,4}\b/g },
  // Payment card: 13–19 digits, optionally separated by a single space or
  // hyphen. Bounded on both sides so a longer digit run is left alone — a
  // 24-digit reference is not a card and blanking it helps nobody.
  { kind: 'payment_card', pattern: /\b\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?\b/g },
  { kind: 'email_address', pattern: /\b[^\s@]+@[^\s@.]+\.[^\s@]{2,}\b/g },
  // MANDATORY separators. See the docblock for the failure this prevents.
  {
    kind: 'phone_number',
    pattern: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{2,4}[ .-]\d{2,4}(?:[ .-]\d{2,4})?/g,
  },
];

/** A message body with everything recognised replaced, and what was replaced. */
export interface RedactedSupportBody {
  body: string;
  /** Sorted and deduplicated, so two identical messages produce identical rows. */
  redactions: SupportRedactionKind[];
}

/**
 * Redact a support message body.
 *
 * Returns the ORIGINAL text when nothing matched, so the overwhelmingly common
 * message is stored byte for byte and a reader is never left wondering whether
 * a sentence was altered.
 */
export function redactSupportBody(body: string): RedactedSupportBody {
  const found = new Set<SupportRedactionKind>();
  let text = body;
  for (const rule of RULES) {
    // A fresh regex per call: the `g` flag makes `lastIndex` stateful, and a
    // module-level pattern reused across two messages skips the start of the
    // second — a bug that appears only under load and looks like a leak.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (!pattern.test(text)) continue;
    found.add(rule.kind);
    text = text.replace(
      new RegExp(rule.pattern.source, rule.pattern.flags),
      PLACEHOLDER[rule.kind],
    );
  }
  return { body: text, redactions: [...found].sort() };
}
