/**
 * Reading a price out of a merchant's file (#63 processing 2, Mapping UX 4).
 *
 * The one place in this importer where a wrong answer is a wrong PRICE on a
 * comparison page, so every ambiguity below resolves toward a refusal rather
 * than a guess.
 *
 * ## Three separator conventions, and the rule that covers all of them
 *
 * `1,234.56`, `1.234,56` and `19,99` all appear in real European feeds. The
 * rule is mechanical and total: when BOTH separators are present the LAST one
 * is the decimal point and the other is a grouping separator — that is
 * unambiguous in every locale. When only one is present it is a grouping
 * separator exactly when it is followed by three digits and nothing else
 * (`1,999` is one thousand nine hundred and ninety-nine, in every catalogue
 * anybody has published), and a decimal point otherwise.
 *
 * That rule has a cost and it is stated rather than hidden: a genuine
 * three-decimal value in a two-decimal currency — `1.005` meaning one euro and
 * half a cent — is read as one thousand and five. It is the right trade: a
 * half-cent price is not something anybody publishes, and `1.005` meaning a
 * thousand is every European feed. A merchant whose currency really carries
 * three decimals publishes in minor units and says so
 * (`money_minor_units`).
 *
 * ## The conversion is STRING arithmetic, never floating point
 *
 * `Math.round(19.99 * 100)` is 1999 and `Math.round(1.005 * 100)` is 100, which
 * is the wrong answer and is invisible until a customer is charged it. The
 * digits are padded and truncated as text, with half-up rounding read off the
 * first dropped digit, so the result is the exact minor-unit value the merchant
 * wrote.
 *
 * ## An unlistable currency is a REFUSAL, with one escape hatch
 *
 * Converting major units to minor ones needs the currency's precision, and
 * `CURRENCY_PRECISION` is the only authority for it. A code Mercaria does not
 * list therefore cannot be converted, and the record is refused with
 * `unsupported_currency` and the code named — issue Mapping UX 4 verbatim.
 * The escape hatch is real and narrow: a feed whose column is ALREADY in minor
 * units (`money_minor_units`) needs no precision, so it is accepted under any
 * shape-valid code, exactly as #62's normalization accepts a source currency it
 * does not present.
 */

import type { CurrencyCode, NormalizedSourceMoney } from '@mercaria/shared-types';
import { assertSafeMoneyAmount, CURRENCY_PRECISION } from '@mercaria/shared-types';

/** Why a money value could not be read. Maps 1:1 onto a `FeedRecordIssueCode`. */
export type MoneyParseFailure =
  | 'missing_currency'
  | 'unsupported_currency'
  | 'unparseable_number'
  | 'negative_amount'
  | 'amount_out_of_range';

/**
 * A STRING discriminant, for `identifiers.ts`' reason: this backend compiles
 * with `strict: false`, under which a boolean discriminant does not narrow.
 */
export type MoneyParseResult =
  | { readonly kind: 'money'; readonly money: NormalizedSourceMoney }
  | { readonly kind: 'refused'; readonly failure: MoneyParseFailure; readonly token?: string };

/**
 * Read one money value.
 *
 * `amountText` may carry the currency (`19.99 EUR`, the Google Merchant
 * convention) — it is taken from there first, then from the mapped currency
 * column, then from the version's default. That order is deliberate: the value
 * a publisher wrote BESIDE the number is the most specific statement about it,
 * and a default that overrode it would silently re-denominate a multi-currency
 * feed.
 */
export function parseFeedMoney(input: {
  readonly amountText: string;
  readonly currencyText: string | null;
  readonly defaultCurrency: string | null;
  readonly minorUnits: boolean;
}): MoneyParseResult {
  const { amount: amountPart, currency: inlineCurrency } = splitInlineCurrency(input.amountText);

  const currency = normalizeCurrency(inlineCurrency ?? input.currencyText ?? input.defaultCurrency);
  if (currency === null) return { kind: 'refused', failure: 'missing_currency' };

  const digits = normalizeAmountDigits(amountPart);
  if (digits === null) return { kind: 'refused', failure: 'unparseable_number' };
  if (digits.negative) return { kind: 'refused', failure: 'negative_amount' };

  let amount: number;
  if (input.minorUnits) {
    if (digits.fraction !== '') return { kind: 'refused', failure: 'unparseable_number' };
    amount = Number(digits.integer === '' ? '0' : digits.integer);
  } else {
    const precision = CURRENCY_PRECISION[currency as CurrencyCode];
    if (precision === undefined) {
      return { kind: 'refused', failure: 'unsupported_currency', token: currency };
    }
    const minor = toMinorUnits(digits.integer, digits.fraction, precision);
    if (minor === null) return { kind: 'refused', failure: 'unparseable_number' };
    amount = minor;
  }

  if (!Number.isSafeInteger(amount)) return { kind: 'refused', failure: 'amount_out_of_range' };
  try {
    assertSafeMoneyAmount(amount, 'feed import money value');
  } catch {
    return { kind: 'refused', failure: 'amount_out_of_range' };
  }
  return { kind: 'money', money: { amount, currency } };
}

/** `19.99 EUR` / `EUR 19.99` / `€19.99` → the number and the code, when present. */
function splitInlineCurrency(text: string): { amount: string; currency: string | null } {
  const trimmed = text.trim();
  const trailing = /^(.*?)[\s\u00a0]*([A-Za-z]{3,4})$/u.exec(trimmed);
  if (trailing !== null && /\d/u.test(trailing[1] ?? '')) {
    return { amount: trailing[1] ?? '', currency: trailing[2] ?? null };
  }
  const leading = /^([A-Za-z]{3,4})[\s\u00a0]*(.*)$/u.exec(trimmed);
  if (leading !== null && /\d/u.test(leading[2] ?? '')) {
    return { amount: leading[2] ?? '', currency: leading[1] ?? null };
  }
  return { amount: trimmed, currency: null };
}

/** Upper-cased and shape-checked; `null` when there is nothing usable. */
function normalizeCurrency(value: string | null): string | null {
  if (value === null) return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{3,4}$/u.test(upper) ? upper : null;
}

/**
 * The integer and fractional digit strings, and the sign.
 *
 * Currency SYMBOLS are removed rather than interpreted — `€`, `£` and `$` are
 * ambiguous between currencies (three countries use `$` in feeds Mercaria will
 * see), so the code comes from a code and never from a glyph.
 */
function normalizeAmountDigits(
  text: string,
): { integer: string; fraction: string; negative: boolean } | null {
  const cleaned = text.replace(/[\s\u00a0\u202f]/gu, '').replace(/[^\d.,+-]/gu, '');
  if (cleaned === '') return null;
  const negative = cleaned.startsWith('-');
  const unsigned = cleaned.replace(/^[+-]/u, '');
  if (!/^[\d.,]+$/u.test(unsigned) || !/\d/u.test(unsigned)) return null;

  const lastDot = unsigned.lastIndexOf('.');
  const lastComma = unsigned.lastIndexOf(',');
  let decimalAt = -1;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const only = lastDot !== -1 ? lastDot : lastComma;
    const trailing = unsigned.length - only - 1;
    // A single separator followed by exactly three digits is a grouping
    // separator: `1,999` is one thousand nine hundred and ninety-nine.
    decimalAt = trailing === 3 ? -1 : only;
  }

  const integerText = decimalAt === -1 ? unsigned : unsigned.slice(0, decimalAt);
  const fractionText = decimalAt === -1 ? '' : unsigned.slice(decimalAt + 1);
  const integer = integerText.replace(/\D/gu, '');
  const fraction = fractionText.replace(/\D/gu, '');
  if (decimalAt !== -1 && fractionText.replace(/\d/gu, '') !== '') return null;
  return { integer, fraction, negative };
}

/**
 * `("19", "995", 2)` → `2000`. Half-up, in string arithmetic.
 *
 * The rounding direction matches `pricing.service`'s half-up on the fee base,
 * and it is applied ONCE here rather than anywhere downstream — a value stored
 * in minor units is exact from this point on.
 */
function toMinorUnits(integer: string, fraction: string, precision: number): number | null {
  const whole = integer === '' ? '0' : integer;
  const padded = fraction.padEnd(precision + 1, '0');
  const kept = padded.slice(0, precision);
  const next = padded.charCodeAt(precision) - 48;
  const combined = `${whole}${kept}`.replace(/^0+(?=\d)/u, '');
  const base = Number(combined);
  if (!Number.isFinite(base)) return null;
  return next >= 5 ? base + 1 : base;
}
