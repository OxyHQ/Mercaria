/**
 * Normalizing and validating what a buyer TYPES at checkout — the address and
 * the contact (#105 "Address and contact validation").
 *
 * Everything here is pure: no database, no network, and — stated because the
 * issue asks for it explicitly (validation rule 8) — **no geocoding and no
 * address-correction provider**. Sending a buyer's street address to a third
 * party to be "corrected" is a disclosure with its own privacy and provider
 * contract, and this module makes exactly zero outbound calls, which is a
 * property a reader can check by looking for an import.
 *
 * ## Two forms of every value, and they are not interchangeable
 *
 * The buyer typed something; Mercaria needs both what they typed and a
 * canonical form to compare with. Collapsing the two is the classic mistake:
 *
 *  - the DISPLAY email is what a transactional mail is addressed to and what a
 *    receipt shows — `Jane.Doe@Example.com`, exactly as entered (ADR 0003 D12:
 *    "the stored ciphertext preserves the address exactly as typed");
 *  - the NORMALIZED email is `jane.doe@example.com`, and exists only to be
 *    hashed. Trim, NFC, lowercase the WHOLE address, and NOTHING else. No
 *    plus-tag stripping, no Gmail dot-folding: those are mailbox-owner
 *    semantics, and folding them would merge addresses their owner deliberately
 *    keeps apart;
 *  - the DISPLAY phone is what a courier reads off a label, preserved with the
 *    spacing the buyer used, while the canonical form is digits (plus a leading
 *    `+` when they gave one) and is used only to check the number is plausible.
 *
 * ## Why the phone canonicalization refuses to guess a country code
 *
 * "Canonical" for a phone number usually means E.164, which requires a country
 * calling code. A number typed without a `+` could be national in the
 * destination country, national in the buyer's own country, or already
 * international with the `+` dropped — and a dialling-plan table that guessed
 * would produce a WRONG number that looks canonical. So a number with no `+`
 * canonicalizes to its digits and stays that way; only an explicitly
 * international number becomes E.164. That is what "safe canonical
 * representation where a country context is available" has to mean without
 * shipping a dialling-plan dependency.
 */

import {
  CHECKOUT_TEXT_LIMITS,
  type CheckoutAddressInput,
  type CheckoutContactInput,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/**
 * ISO 3166-1 alpha-2, the current assignment list.
 *
 * Embedded as data rather than derived from `Intl`: `Intl.DisplayNames` echoes
 * an unknown region code back instead of failing, so "does ICU know this code"
 * is not a membership test, and the answer would move with the runtime's ICU
 * version — a validation rule that changes when Node is upgraded is not a rule.
 * User-assigned codes (`AA`, `QM`-`QZ`, `XA`-`XZ`, `ZZ`) are deliberately
 * absent: they are private-use and no carrier delivers to one.
 */
const ISO_3166_ALPHA2 = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ ' +
    'BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM ' +
    'DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS ' +
    'GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
    'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
    'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
    'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV ' +
    'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
    'VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

/**
 * Postal-code patterns for the countries whose rule is genuinely unambiguous
 * (#105 validation rule 3: "only where rules are reliable; avoid rejecting
 * valid international formats through overfitted regexes").
 *
 * The list is short ON PURPOSE and every entry earns its place by being a
 * published national format with no exceptions worth arguing about. A country
 * absent from this map is length-checked and character-checked and NOT
 * pattern-checked — which is the correct answer for the long tail, because the
 * failure mode of an overfitted regex is refusing a real buyer's real address
 * with no way for them to proceed, and the failure mode of not having one is a
 * parcel a carrier's own validation catches.
 *
 * Matched against the UPPER-CASED value, since every one of these formats is
 * officially upper-case.
 */
const POSTAL_CODE_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  // Four digits, no exceptions.
  ['AT', /^\d{4}$/],
  ['AU', /^\d{4}$/],
  ['BE', /^\d{4}$/],
  ['BG', /^\d{4}$/],
  ['CH', /^\d{4}$/],
  ['DK', /^\d{4}$/],
  ['HU', /^\d{4}$/],
  ['LU', /^\d{4}$/],
  ['NO', /^\d{4}$/],
  ['NZ', /^\d{4}$/],
  // Five digits, no exceptions.
  ['DE', /^\d{5}$/],
  ['ES', /^\d{5}$/],
  ['FI', /^\d{5}$/],
  ['FR', /^\d{5}$/],
  ['IT', /^\d{5}$/],
  ['MX', /^\d{5}$/],
  ['TR', /^\d{5}$/],
  // Two digits, hyphen, three digits.
  ['PL', /^\d{2}-\d{3}$/],
  // Four digits, hyphen, three digits.
  ['PT', /^\d{4}-\d{3}$/],
  // Three digits, hyphen, four digits.
  ['JP', /^\d{3}-\d{4}$/],
  // Four digits, optional space, two letters.
  ['NL', /^\d{4} ?[A-Z]{2}$/],
  // Optional `SE-` prefix, three digits, optional space, two digits.
  ['SE', /^(SE-)?\d{3} ?\d{2}$/],
  // ZIP, optionally ZIP+4.
  ['US', /^\d{5}(-\d{4})?$/],
  // Canadian FSA/LDU. Excludes D, F, I, O, Q, U everywhere and W, Z leading.
  ['CA', /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/],
  // UK, the official BS 7666 form.
  ['GB', /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/],
]);

/**
 * Characters that must never reach an address column (#105 validation rule 7).
 *
 * Three families, one class each:
 *
 *  - **C0 and C1 controls** (`U+0000`-`U+001F`, `U+007F`-`U+009F`), which
 *    includes every newline and carriage return. A line break in a
 *    `recipientName` is header injection anywhere the value is later composed
 *    into a message, and a NUL truncates the value in half the systems that
 *    will ever read it.
 *  - **Unicode line and paragraph separators** (`U+2028`, `U+2029`) — the pair
 *    a `\n`/`\r` check misses, and which breaks a JavaScript string literal and
 *    several label renderers.
 *  - **Bidirectional overrides** (`U+202A`-`U+202E`, `U+2066`-`U+2069`). These
 *    are the display-spoofing family: they make a shipping label read as one
 *    destination while the underlying data says another, which is a real fraud
 *    vector on a printed label and has no legitimate use in a postal address.
 *
 * `<` and `>` are refused separately below — they are not dangerous
 * CHARACTERS, they are the shape of markup, and separating the two refusals is
 * what lets each error message tell the buyer something true.
 */
// Matching control characters IS the purpose of this pattern. `no-control-regex`
// exists to catch one appearing by accident inside a regex that meant something
// else; here they are the subject, so the rule is silenced at exactly this line
// and nowhere wider.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * An email shape check that is deliberately PERMISSIVE about the local part.
 *
 * One `@`, a non-empty local part with no whitespace, and a domain with at
 * least one dot and a two-or-more-letter final label. RFC 5322 permits far
 * more than this (quoted strings, comments, address literals) and essentially
 * no mail provider accepts those at signup, so a stricter-than-RFC check is the
 * right trade — but it stays away from the parts that DO vary in practice: the
 * local part may contain `+`, `.`, `-`, `_`, `'` and Unicode, and the domain may
 * be an IDN.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/u;

/** A phone number, after canonicalization: optional `+`, then 6-15 digits. */
const CANONICAL_PHONE_PATTERN = /^\+?\d{6,15}$/;

/**
 * A field's normalized value, or a refusal naming the field.
 *
 * Every refusal names the FIELD and never echoes the value: a validation error
 * becomes a log line and an error body, and both are places #105's privacy
 * rule 8 says contact and address values must not appear.
 */
function normalizeText(value: string, field: string, max: number): string {
  const normalized = value.normalize('NFC').trim();
  if (FORBIDDEN_CHARACTERS.test(normalized)) {
    throw validationError(`${field} contains characters that are not allowed in an address.`);
  }
  if (normalized.includes('<') || normalized.includes('>')) {
    throw validationError(`${field} cannot contain markup.`);
  }
  if (normalized.length === 0) {
    throw validationError(`${field} is required.`);
  }
  if (normalized.length > max) {
    throw validationError(`${field} must be ${max} characters or fewer.`);
  }
  return normalized;
}

/** {@link normalizeText} for a field that may legitimately be absent. */
function normalizeOptionalText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  // An empty optional is ABSENT, not an error and not an empty string: an
  // empty `line2` would print a blank line on a shipping label, the same
  // reasoning `address.service.ts` already applies to saved addresses.
  if (value.normalize('NFC').trim().length === 0) return undefined;
  return normalizeText(value, field, max);
}

/** A validated destination address, ready to become an immutable snapshot. */
export interface NormalizedCheckoutAddress {
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  /** ISO-3166 alpha-2, upper-cased. */
  country: string;
  /** The buyer's own spacing, preserved — a courier reads this. */
  phone?: string;
}

/** A validated contact, in both of its forms. */
export interface NormalizedCheckoutContact {
  /** Exactly as typed (NFC, trimmed). What mail is addressed to. */
  displayEmail: string;
  /** Lower-cased whole address. Hashed, never displayed, never sent to. */
  normalizedEmail: string;
  /** As typed. */
  displayPhone?: string;
  /** Digits, `+`-prefixed only when the buyer gave one. Comparison only. */
  canonicalPhone?: string;
}

/**
 * Validate and normalize a typed destination address.
 *
 * The country check is the ONE that is not merely hygiene: it decides whether
 * anything downstream can reason about this destination at all, so it runs
 * against the real ISO-3166 list rather than a length check. A two-character
 * string that is not an assigned code is refused here, before the seller
 * eligibility gate ever sees it — otherwise "no seller ships to XX" would be
 * the error a typo produced, and the buyer would go looking for a different
 * seller.
 */
export function normalizeCheckoutAddress(input: CheckoutAddressInput): NormalizedCheckoutAddress {
  const country = input.country.normalize('NFC').trim().toUpperCase();
  if (!ISO_3166_ALPHA2.has(country)) {
    throw validationError('Country must be a valid ISO-3166 alpha-2 country code.');
  }

  const postalCode = normalizeText(
    input.postalCode,
    'Postal code',
    CHECKOUT_TEXT_LIMITS.postalCode,
  );
  const pattern = POSTAL_CODE_PATTERNS.get(country);
  if (pattern && !pattern.test(postalCode.toUpperCase())) {
    throw validationError(`Postal code is not a valid format for ${country}.`);
  }

  const line2 = normalizeOptionalText(input.line2, 'Address line 2', CHECKOUT_TEXT_LIMITS.line2);
  const region = normalizeOptionalText(input.region, 'Region', CHECKOUT_TEXT_LIMITS.region);
  const phone = normalizeOptionalText(input.phone, 'Phone', CHECKOUT_TEXT_LIMITS.phone);
  if (phone !== undefined) {
    assertPlausiblePhone(phone);
  }

  return {
    recipientName: normalizeText(
      input.recipientName,
      'Recipient name',
      CHECKOUT_TEXT_LIMITS.recipientName,
    ),
    line1: normalizeText(input.line1, 'Address line 1', CHECKOUT_TEXT_LIMITS.line1),
    ...(line2 !== undefined ? { line2 } : {}),
    city: normalizeText(input.city, 'City', CHECKOUT_TEXT_LIMITS.city),
    ...(region !== undefined ? { region } : {}),
    postalCode,
    country,
    ...(phone !== undefined ? { phone } : {}),
  };
}

/** Validate and normalize a contact, producing both forms. */
export function normalizeCheckoutContact(input: CheckoutContactInput): NormalizedCheckoutContact {
  const displayEmail = normalizeText(input.email, 'Email', CHECKOUT_TEXT_LIMITS.email);
  if (!EMAIL_PATTERN.test(displayEmail)) {
    throw validationError('Email is not a valid address.');
  }
  const displayPhone = normalizeOptionalText(input.phone, 'Phone', CHECKOUT_TEXT_LIMITS.phone);
  if (displayPhone !== undefined) {
    assertPlausiblePhone(displayPhone);
  }

  return {
    displayEmail,
    // ADR 0003 D12, verbatim and nothing beyond it: trim, NFC, lowercase the
    // WHOLE address. `normalizeText` already did the first two.
    normalizedEmail: displayEmail.toLowerCase(),
    ...(displayPhone !== undefined
      ? { displayPhone, canonicalPhone: canonicalizePhone(displayPhone) }
      : {}),
  };
}

/**
 * The comparison form of a typed phone number: digits, with a leading `+` iff
 * the buyer typed one.
 *
 * See the module docblock for why no country code is ever inferred.
 */
export function canonicalizePhone(displayPhone: string): string {
  const digits = displayPhone.replace(/\D/g, '');
  return displayPhone.trimStart().startsWith('+') ? `+${digits}` : digits;
}

/** Refuse a phone number that cannot be a phone number at all. */
function assertPlausiblePhone(displayPhone: string): void {
  if (!CANONICAL_PHONE_PATTERN.test(canonicalizePhone(displayPhone))) {
    throw validationError('Phone must be 6 to 15 digits, optionally with a leading +.');
  }
}

/** Whether a country code is an assigned ISO-3166 alpha-2 value. */
export function isIsoAlpha2Country(country: string): boolean {
  return ISO_3166_ALPHA2.has(country);
}
