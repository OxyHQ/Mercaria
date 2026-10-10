/**
 * Readers every provider shares: narrowing `unknown` JSON, machine-formatted
 * money and namespaced facts.
 *
 * ## Why money is not `feed-import/money.ts`' parser
 *
 * `parseFeedMoney` reads what a HUMAN typed into a spreadsheet, so a single
 * separator followed by three digits is a thousands separator — `1,999` is one
 * thousand nine hundred and ninety-nine. Every provider here publishes MACHINE
 * decimals: Open Prices writes `"1.250"` for one euro twenty-five, MITECO writes
 * `"2,095"` for two euros and nine and a half cents. Read with the feed rule,
 * both become a thousand times the price. The decimal separator is a property
 * of the PROVIDER, so the provider states it and this reader never guesses.
 */

import type {
  CurrencyCode,
  NormalizedSourceFact,
  NormalizedSourceFactValue,
  NormalizedSourceMoney,
} from '@mercaria/shared-types';
import {
  assertSafeMoneyAmount,
  CURRENCY_PRECISION,
  foldAccents,
  wordTokens,
} from '@mercaria/shared-types';

/** A JSON object, or `undefined` for anything else. */
export function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A JSON array, or an empty one for anything else. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-empty trimmed string; numbers are rendered, everything else is absent. */
export function asText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A finite number, from a number or a machine-formatted numeric string. */
export function asNumber(value: unknown, decimalSeparator: '.' | ',' = '.'): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = asText(value);
  if (text === undefined) return undefined;
  const normalized = decimalSeparator === ',' ? text.replace(/\./g, '').replace(',', '.') : text;
  if (!/^-?\d+(\.\d+)?$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Non-empty strings from an array, trimmed. */
export function asTextList(value: unknown): string[] {
  const result: string[] = [];
  for (const entry of asArray(value)) {
    const text = asText(entry);
    if (text !== undefined) result.push(text);
  }
  return result;
}

/**
 * A machine decimal in a currency's major unit → minor units, half-up.
 *
 * `undefined` for anything that is not a plain decimal in the stated
 * separator, for a currency Mercaria has no precision for, and for a negative
 * or out-of-range amount — an absent price, never an invented one.
 */
export function decimalMoney(
  value: unknown,
  currency: string | undefined,
  decimalSeparator: '.' | ',' = '.',
): NormalizedSourceMoney | undefined {
  const code = currency?.trim().toUpperCase();
  if (code === undefined || !/^[A-Z]{3}$/u.test(code)) return undefined;
  const precision = CURRENCY_PRECISION[code as CurrencyCode];
  if (precision === undefined) return undefined;

  let text: string | undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    text = value.toFixed(Math.max(precision + 1, 6));
  } else {
    const raw = asText(value);
    if (raw === undefined) return undefined;
    text = decimalSeparator === ',' ? raw.replace(/\./g, '').replace(',', '.') : raw;
  }
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(text);
  if (match === null) return undefined;
  const integer = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(precision + 1, '0');
  const kept = fraction.slice(0, precision);
  const roundUp = fraction.charCodeAt(precision) - 48 >= 5;
  const amount = Number(`${integer}${kept}`) + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(amount)) return undefined;
  try {
    assertSafeMoneyAmount(amount, 'open-data money value');
  } catch {
    return undefined;
  }
  return { amount, currency: code };
}

/** An amount already in minor units (Steam's `final: 969`). */
export function minorMoney(
  value: unknown,
  currency: string | undefined,
): NormalizedSourceMoney | undefined {
  const code = currency?.trim().toUpperCase();
  if (code === undefined || !/^[A-Z]{3}$/u.test(code)) return undefined;
  const amount = typeof value === 'number' ? value : asNumber(value);
  if (amount === undefined || !Number.isSafeInteger(amount) || amount < 0) return undefined;
  return { amount, currency: code };
}

/**
 * Collects facts, skipping absent values, so a provider writes one line per
 * fact instead of one conditional per fact.
 */
export class FactCollector {
  private readonly facts: NormalizedSourceFact[] = [];

  constructor(private readonly namespace: string) {}

  /** Add `namespace.key = value`, when the value is present. */
  add(key: string, value: NormalizedSourceFactValue | null | undefined, unit?: string): this {
    if (value === null || value === undefined) return this;
    if (typeof value === 'string' && value.trim() === '') return this;
    if (Array.isArray(value) && value.length === 0) return this;
    this.facts.push({
      key: `${this.namespace}.${key}`,
      value,
      ...(unit === undefined ? {} : { unit }),
    });
    return this;
  }

  /** Add a number read from any JSON value, when it is one. */
  number(key: string, value: unknown, unit?: string, decimalSeparator: '.' | ',' = '.'): this {
    return this.add(key, asNumber(value, decimalSeparator), unit);
  }

  /** Add a string read from any JSON value, when it is one. */
  text(key: string, value: unknown): this {
    return this.add(key, asText(value));
  }

  /** Add a list of strings read from any JSON value. */
  list(key: string, value: unknown): this {
    return this.add(key, asTextList(value));
  }

  /** Add a boolean, when the value is one. */
  flag(key: string, value: unknown): this {
    return typeof value === 'boolean' ? this.add(key, value) : this;
  }

  toArray(): NormalizedSourceFact[] {
    return [...this.facts];
  }
}

/**
 * A fact-key segment from a provider's MACHINE vocabulary: `energy-kcal` →
 * `energy_kcal`.
 *
 * ASCII only, on purpose: fact keys are `[a-z0-9_]` by normalization's own
 * pattern, and every caller hands this a provider's field name, never a
 * person's words. Anything outside the alphabet is dropped rather than
 * transliterated — a key that folds to nothing is refused downstream, which is
 * louder than one invented here.
 */
export function factKeySegment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 60);
}

/**
 * The key a source's account ref is compared on, from a NAME people wrote —
 * a chain's OSM brand, a station's `Rótulo`.
 *
 * Built from the repository's ONE accent fold and ONE word tokenizer
 * (`@mercaria/shared-types` text-fold) rather than an ASCII slug, because
 * chains are named in every script: an ASCII fold turns `Пятёрочка` and
 * `イオン` into the same empty key, and two chains collapsing into one source
 * is a false merge an operator would never see. Latin accents fold
 * (`BonÀrea` → `bonarea`); no other script is folded at all.
 */
export function subFeedKey(text: string): string {
  return wordTokens(foldAccents(text.toLowerCase())).join('_');
}

/** Digits only, or `undefined` — the shape every GTIN reader starts from. */
export function gtinDigits(value: unknown): string | undefined {
  const text = asText(value);
  if (text === undefined) return undefined;
  const digits = text.replace(/[\s-]/gu, '');
  return /^\d{8,14}$/u.test(digits) ? digits : undefined;
}

/** `YYYY-MM-DD` or an ISO instant → a Date, or `undefined`. */
export function asDate(value: unknown): Date | undefined {
  const text = asText(value);
  if (text === undefined) return undefined;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
