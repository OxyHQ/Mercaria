/**
 * Locale-aware reading of numbers, money and magnitudes (#95 "Localization"
 * rules 2 and 5).
 *
 * PURE: no database, no configuration, no clock, no `Intl` formatter cached
 * across calls. Everything is a function of a string and a language tag.
 *
 * ## `1.299` is one thousand two hundred and ninety-nine, or it is 1.299
 *
 * That is the whole problem. `1.299,00 €` is Spanish for 1299 euros and
 * `1,299.00 $` is English for 1299 dollars, and reading either under the other
 * convention is wrong by a factor of a thousand — on a BUDGET, which is the one
 * number a shopper will notice and the one this surface must never get wrong
 * quietly. So a separator is never guessed from the number alone when the
 * language says which convention is in force, and when a number is genuinely
 * ambiguous under both readings it is refused rather than picked.
 *
 * ## Refusal is a real answer here, exactly as it is in #94's normalization
 *
 * `readLocalizedNumber` returns a discriminated union whose `unreadable` branch
 * has no `value` property, so a caller cannot use a number this module declined
 * to produce. That is #94's "a refusal is a first-class normalization outcome",
 * applied on the query side — and it is what turns "1,299" in an unknown
 * language into an `ambiguous_phrase` a shopper can correct rather than into a
 * budget of 1.299 €.
 */

import { ALL_CURRENCY_CODES, CURRENCY_PRECISION, type CurrencyCode } from '@mercaria/shared-types';

/**
 * Which decimal convention a language uses.
 *
 * Two groups, and the membership is a fact about the language rather than a
 * preference: `comma` languages write `1.299,50`, `dot` languages write
 * `1,299.50`. The list covers the launch languages plus the ones a European
 * marketplace actually receives; an unlisted language gets `unknown`, which
 * makes an ambiguous number refuse instead of being read under a default that
 * is wrong half the time.
 */
export type DecimalConvention = 'comma' | 'dot' | 'unknown';

const COMMA_DECIMAL_LANGUAGES: ReadonlySet<string> = new Set([
  'es',
  'ca',
  'gl',
  'eu',
  'pt',
  'fr',
  'it',
  'de',
  'nl',
  'da',
  'sv',
  'nb',
  'nn',
  'fi',
  'pl',
  'cs',
  'ro',
  'tr',
  'ru',
  'uk',
  'el',
  'hu',
  'bg',
  'hr',
  'sl',
  'sk',
  'lt',
  'lv',
  'et',
  'is',
]);

const DOT_DECIMAL_LANGUAGES: ReadonlySet<string> = new Set([
  'en',
  'ja',
  'ko',
  'zh',
  'th',
  'he',
  'ms',
  'ga',
  'mt',
]);

/**
 * The language subtag of a BCP-47 tag, lowercased.
 *
 * The LANGUAGE and not the region, deliberately: `es-MX` and `es-ES` write
 * numbers the same way and a shopper in Mexico typing Spanish means what a
 * shopper in Spain typing Spanish means. Region is what decides the MARKET,
 * which is a separate input this surface takes separately.
 */
export function languageOf(locale: string): string {
  const [language] = locale.trim().toLowerCase().split(/[-_]/u);
  return language ?? '';
}

/** Which decimal convention a language tag implies. */
export function decimalConventionOf(locale: string): DecimalConvention {
  const language = languageOf(locale);
  if (COMMA_DECIMAL_LANGUAGES.has(language)) return 'comma';
  if (DOT_DECIMAL_LANGUAGES.has(language)) return 'dot';
  return 'unknown';
}

/** A number that was read, or a statement that it could not be. */
export type LocalizedNumber =
  | { readonly status: 'read'; readonly value: number }
  | { readonly status: 'unreadable' };

/**
 * Read one numeric token under a language's convention.
 *
 * The cases, in the order they are decided:
 *
 * 1. **Both separators present** — the LAST one is the decimal separator,
 *    whatever the language says, because no convention writes a group separator
 *    after a decimal one. This is the one case the language cannot get wrong.
 * 2. **One separator, and it is unambiguous by SHAPE** — `1.234.567` has two
 *    dots so both are groups; `12.3456` has four trailing digits so the dot is
 *    not a group separator (groups are exactly three). Shape beats language
 *    here because it is a fact about the string.
 * 3. **One separator, exactly three trailing digits** — genuinely ambiguous.
 *    The LANGUAGE decides, and an `unknown` language refuses.
 * 4. **One separator, one or two trailing digits** — a group separator is
 *    always followed by three, so this is a decimal separator in every
 *    convention.
 *
 * Case 3's refusal is the point of the whole function. `1,299` in a language
 * this module does not know is either 1299 or 1.299, the two differ by a
 * thousand, and a budget is not a place to guess.
 */
export function readLocalizedNumber(token: string, locale: string): LocalizedNumber {
  const cleaned = token.replace(/[\u{2009}\u{202F}\u{00A0}\s]/gu, '');
  if (!/^\d[\d.,]*$/u.test(cleaned)) return { status: 'unreadable' };

  const dots = (cleaned.match(/\./gu) ?? []).length;
  const commas = (cleaned.match(/,/gu) ?? []).length;

  if (dots === 0 && commas === 0) {
    const value = Number(cleaned);
    return Number.isFinite(value) ? { status: 'read', value } : { status: 'unreadable' };
  }

  if (dots > 0 && commas > 0) {
    const decimalSeparator = cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',';
    return parseWithSeparator(cleaned, decimalSeparator);
  }

  const separator = dots > 0 ? '.' : ',';
  const occurrences = dots > 0 ? dots : commas;
  const trailing = cleaned.length - cleaned.lastIndexOf(separator) - 1;

  // Repeated separators are grouping — `1.234.567` — and a decimal separator
  // never repeats.
  if (occurrences > 1) return parseWithSeparator(cleaned, separator === '.' ? ',' : '.');
  // A group is exactly three digits, so anything else is a decimal separator.
  if (trailing !== 3) return parseWithSeparator(cleaned, separator);

  const convention = decimalConventionOf(locale);
  if (convention === 'unknown') return { status: 'unreadable' };
  const decimalSeparator = convention === 'comma' ? ',' : '.';
  return parseWithSeparator(cleaned, decimalSeparator);
}

function parseWithSeparator(cleaned: string, decimalSeparator: string): LocalizedNumber {
  const groupSeparator = decimalSeparator === '.' ? ',' : '.';
  const stripped = cleaned.split(groupSeparator).join('');
  const normalized = stripped.split(decimalSeparator).join('.');
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return { status: 'unreadable' };
  const value = Number(normalized);
  return Number.isFinite(value) ? { status: 'read', value } : { status: 'unreadable' };
}

/**
 * Currency SYMBOLS a shopper types, mapped to the code they mean.
 *
 * `$` is deliberately absent, and the absence is the interesting entry: it is
 * the sign for at least a dozen currencies Mercaria supports, so reading it as
 * USD would silently price a Canadian, Australian, Mexican, Singaporean or Hong
 * Kong shopper's budget in somebody else's money. A bare `$` therefore resolves
 * only through the request's own currency, and when the request names none the
 * phrase is reported `unknown_currency` — visible and correctable.
 *
 * The ambiguous `kr` (Swedish, Norwegian and Danish crowns) is absent for the
 * same reason, and so is a bare `£` … which is NOT ambiguous in Mercaria's set,
 * so it is present. The rule is not "avoid symbols", it is "a symbol that names
 * exactly one supported currency resolves, and one that names several does
 * not".
 */
const UNAMBIGUOUS_CURRENCY_SYMBOLS: Readonly<Record<string, CurrencyCode>> = Object.freeze({
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '⊜': 'FAIR',
  'zł': 'PLN',
  'R$': 'BRL',
  // `¥` names both the yen and the yuan and BOTH are in Mercaria's set, so it
  // belongs with `$` and `kr` among the ambiguous ones rather than here.
});

/** A currency that was read, or a statement that it could not be. */
export type ReadCurrency =
  | { readonly status: 'read'; readonly currency: CurrencyCode }
  | { readonly status: 'ambiguous'; readonly token: string }
  | { readonly status: 'absent' };

/**
 * Read a currency out of a phrase.
 *
 * A three-letter CODE the shopper typed wins over a symbol, because typing
 * `USD` is an explicit statement and a symbol is a convention. A code outside
 * Mercaria's presentment set is `ambiguous` rather than `absent`: the shopper
 * named a currency and Mercaria does not support it, which is a different thing
 * from their having named none, and only one of the two is worth telling them.
 */
export function readCurrency(phrase: string): ReadCurrency {
  const upper = phrase.toUpperCase();
  const codeMatch = upper.match(/\b([A-Z]{3})\b/u);
  if (codeMatch !== null) {
    const code = codeMatch[1] ?? '';
    const supported = ALL_CURRENCY_CODES.find((candidate) => candidate === code);
    if (supported !== undefined) return { status: 'read', currency: supported };
    // Three capitals that are not a supported code are usually a word
    // (`RAM`, `USB`, `SSD`), so only an actual currency-shaped miss is reported.
    if (KNOWN_UNSUPPORTED_CURRENCY_CODES.has(code)) return { status: 'ambiguous', token: code };
  }

  for (const [symbol, currency] of Object.entries(UNAMBIGUOUS_CURRENCY_SYMBOLS)) {
    if (phrase.includes(symbol) && ALL_CURRENCY_CODES.includes(currency)) {
      return { status: 'read', currency };
    }
  }
  const ambiguous = AMBIGUOUS_CURRENCY_SYMBOLS.find((symbol) =>
    symbol === 'kr' ? /\bkr\b/iu.test(phrase) : phrase.includes(symbol),
  );
  if (ambiguous !== undefined) return { status: 'ambiguous', token: ambiguous };
  return { status: 'absent' };
}

/**
 * Symbols that name SEVERAL currencies Mercaria supports.
 *
 * Reported as ambiguous rather than resolved, so the shopper is told rather
 * than priced in somebody else's money. When the request itself names a
 * currency the caller uses that instead — an explicit preference outranks a
 * symbol that could mean five things.
 */
const AMBIGUOUS_CURRENCY_SYMBOLS: readonly string[] = ['$', '¥', 'kr'];

/**
 * ISO codes a shopper might plausibly type that Mercaria does not price in.
 *
 * A small, explicit list rather than "any three capitals": `SSD`, `RAM`, `USB`,
 * `LED` and `GPS` are all three capitals in ordinary product prose, and
 * reporting each of them as an unsupported currency would fill the unresolved
 * list with noise a shopper cannot act on.
 */
const KNOWN_UNSUPPORTED_CURRENCY_CODES: ReadonlySet<string> = new Set([
  'RUB',
  'TRY',
  'ARS',
  'CLP',
  'COP',
  'PEN',
  'UYU',
  'KRW',
  'TWD',
  'THB',
  'VND',
  'IDR',
  'PHP',
  'MYR',
  'SAR',
  'ILS',
  'EGP',
  'NGN',
  'KES',
  'CZK',
  'HUF',
  'RON',
  'BGN',
  'ISK',
  'UAH',
]);

/**
 * Convert a major-unit amount to minor units for a currency.
 *
 * String arithmetic is deliberately NOT used here, unlike #63's feed money
 * reader: a shopper types two decimal places at most and the value has already
 * been through `readLocalizedNumber`, so the float path is exact for every
 * input this surface accepts. `Math.round` on the scaled value is what closes
 * the `1.005 * 100 = 100.49999999999999` case, and the bound below is what
 * keeps a pasted twenty-digit number from becoming an amount.
 *
 * Returns `undefined` rather than a clamped value when the amount would exceed
 * what `Money` represents — a budget of ten to the twentieth is not a budget,
 * and silently capping it would answer a question nobody asked.
 */
export function toMinorUnits(amount: number, currency: CurrencyCode): number | undefined {
  const precision = CURRENCY_PRECISION[currency];
  const minor = Math.round(amount * 10 ** precision);
  if (!Number.isSafeInteger(minor) || minor < 0) return undefined;
  return minor;
}

/**
 * The label an attribute is DESCRIBED under, in the shopper's own language
 * (#367 line 590, #946 piece 2).
 *
 * `deterministic.ts` already matches a typed phrase against every localized
 * label a definition carries — that is how `memoria` finds the RAM attribute.
 * What it did NOT do is describe the result under the label it matched: every
 * explanation was built from `definition.row.label`, the BASE label, so a
 * shopper who typed `memoria` was told *"RAM is at least 16 GB"* in English.
 *
 * ## Why the chain is a PREFERENCE and the base is the floor
 *
 * `es-ES` prefers a row recorded as `es-ES`, then one recorded as `es`, then the
 * base. It never falls through to some OTHER language's row: a French label is
 * not a better answer for a Spanish reader than the base one, and picking
 * "whatever localization exists" is how a German shopper gets Portuguese.
 *
 * That is deliberately NARROWER than the matching side, and the asymmetry is the
 * point. `deterministic.ts` READS every language for every query (localization
 * rule 6) because a shopper may type a word from any of them; it may only WRITE
 * back one, and the only defensible one is theirs.
 *
 * ## What this does not touch
 *
 * The English template sentences around the label — *"is at least"*, *"we
 * treated it as a preference"* — are #946 piece 3 and a product decision, not
 * this function's. And number formatting is `describeBudget`'s recorded
 * boundary (`paraphrase.ts`): grouping and locale-aware rendering belong to the
 * client, which knows the shopper's locale and has `formatMoney`.
 */
export function labelForLocale(
  baseLabel: string,
  labels: readonly { readonly locale: string; readonly label: string }[],
  locale: string,
): string {
  const tag = locale.trim().toLowerCase().replace(/_/gu, '-');
  const language = languageOf(locale);
  for (const wanted of tag === language ? [tag] : [tag, language]) {
    const hit = labels.find((entry) => entry.locale.trim().toLowerCase() === wanted);
    // An empty localized label is not a translation — it is a row somebody left
    // blank, and rendering it would replace a real English word with nothing.
    if (hit !== undefined && hit.label.trim().length > 0) return hit.label;
  }
  return baseLabel;
}
