import type {
  CurrencyCode,
  FacetOrigin,
  FacetResponse,
  FacetSelectionEntry,
  ResolvedFacetSelectionEntry,
} from '@mercaria/shared-types';
import {
  ALL_CURRENCY_CODES,
  FACET_ORIGINS,
  FACET_TAXONOMY_KEY,
  isFacetCommerceDimension,
} from '@mercaria/shared-types';

/**
 * Filter state, and the URL it is spelled in (#367 workstream 10 §"Facets and
 * filter UI").
 *
 * > Use stable IDs/keys in URLs/state; translated text is display only.
 *
 * So the wire form carries an ORIGIN, a stable `facetKey` and stable bucket
 * KEYS, and nothing else. There is no field on `FacetSelectionEntry` a label
 * could travel in, and nothing here reads one — a shopper sharing a filtered URL
 * shares the same filter whatever language either of them reads in.
 *
 * ## The grammar
 *
 * One `filters` query parameter, entries separated by `;`:
 *
 * ```
 * attribute~color=black|white;commerce~condition=new;attribute~screen_size=5..7
 * commerce~offer_price=1000..5000@EUR
 * taxonomy~category=<categoryId>
 * ```
 *
 * Every key and value is percent-encoded, because a bucket key is an arbitrary
 * string the registry chose and the separators are not reserved in it. Parsing
 * is TOTAL and lossy in one direction only: an entry this parser cannot read is
 * DROPPED rather than guessed at, and the count of dropped entries is returned,
 * so a surface can say a link carried a filter it could not restore instead of
 * silently showing unfiltered results under a filtered URL.
 *
 * ## The origin is part of the key and cannot be dropped
 *
 * `condition` is a commerce dimension and `color` is an attribute; two facets
 * may legitimately share a key across origins, and `POST /facets` requires the
 * origin on every selection entry. Encoding only the key would make the parse
 * guess which one a link meant.
 *
 * ## Every construction switches on the origin, because the three SHAPES differ
 *
 * `FacetSelectionEntry` is a discriminated union: an attribute range is in the
 * definition's BASE units (`min`/`max`), a commerce range is in a currency's
 * MINOR units (`minMinor`/`maxMinor`), and a taxonomy entry has values and no
 * range at all. Two different numeric scales must never be read into one field,
 * so the origin is consulted before any number is assigned — the compiler
 * enforces it, and that is why there is no shared "bounds" helper here.
 */

const ENTRY_SEPARATOR = ';';
const KEY_SEPARATOR = '~';
const VALUE_SEPARATOR = '|';
const RANGE_SEPARATOR = '..';
const CURRENCY_SEPARATOR = '@';

export interface FacetSelectionParse {
  readonly entries: readonly FacetSelectionEntry[];
  /** How many entries the URL carried that this parser could not read. */
  readonly droppedEntryCount: number;
}

function isFacetOrigin(value: string): value is FacetOrigin {
  return (FACET_ORIGINS as readonly string[]).includes(value);
}

function isCurrencyCode(value: string): value is CurrencyCode {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(value);
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not a value; the caller counts it as dropped.
    return '';
  }
}

/** Whether a selection entry says anything. An empty one is not a filter. */
function entryIsMeaningful(entry: FacetSelectionEntry): boolean {
  switch (entry.origin) {
    case 'attribute':
      return (
        (entry.values !== undefined && entry.values.length > 0) ||
        entry.min !== undefined ||
        entry.max !== undefined
      );
    case 'commerce':
      return (
        (entry.values !== undefined && entry.values.length > 0) ||
        entry.minMinor !== undefined ||
        entry.maxMinor !== undefined
      );
    case 'taxonomy':
      return entry.values.length > 0;
  }
}

function renderRange(lower: number | undefined, upper: number | undefined): string {
  return `${lower === undefined ? '' : String(lower)}${RANGE_SEPARATOR}${
    upper === undefined ? '' : String(upper)
  }`;
}

/** Compose the `filters` query value. Returns `undefined` for an empty selection. */
export function serializeFacetSelection(
  entries: readonly FacetSelectionEntry[],
): string | undefined {
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entryIsMeaningful(entry)) continue;
    const head = `${entry.origin}${KEY_SEPARATOR}${encode(entry.facetKey)}`;

    if (entry.values !== undefined && entry.values.length > 0) {
      parts.push(`${head}=${entry.values.map(encode).join(VALUE_SEPARATOR)}`);
      continue;
    }

    if (entry.origin === 'attribute') {
      parts.push(`${head}=${renderRange(entry.min, entry.max)}`);
      continue;
    }
    if (entry.origin === 'commerce') {
      const range = renderRange(entry.minMinor, entry.maxMinor);
      parts.push(
        entry.currency === undefined
          ? `${head}=${range}`
          : `${head}=${range}${CURRENCY_SEPARATOR}${entry.currency}`,
      );
    }
  }
  return parts.length === 0 ? undefined : parts.join(ENTRY_SEPARATOR);
}

/** A bounded entry, built on the branch its origin permits. */
function boundedEntry(
  origin: FacetOrigin,
  facetKey: string,
  lower: number | undefined,
  upper: number | undefined,
  currency: string | undefined,
): FacetSelectionEntry | undefined {
  if (origin === 'attribute') {
    return {
      origin,
      facetKey,
      ...(lower === undefined ? {} : { min: lower }),
      ...(upper === undefined ? {} : { max: upper }),
    };
  }
  if (origin === 'commerce') {
    if (!isFacetCommerceDimension(facetKey)) return undefined;
    // A currency the server does not price in is DROPPED rather than sent: a
    // money bound whose currency is refused is a 400, and a bound applied under
    // some other currency would be a filter the shopper never asked for.
    //
    // Narrowed POSITIVELY into its own binding rather than by the negated
    // guard `if (currency !== undefined && !isCurrencyCode(currency)) return`.
    //
    // That guard is CORRECT here and the comment this replaces said otherwise.
    // This package sets `strict: true`, so `strictNullChecks` is on and
    // TypeScript narrows through the negated conjunction perfectly well.
    // Measured on a two-file probe: `strict: true` reports nothing, and
    // `strict: false` reports `TS2322: Type '{ currency?: string; }' is not
    // assignable` — which is the error that briefly appeared here, produced by
    // a cross-package test file that dragged this module into the BACKEND's
    // program, where `strict: false` disables the narrowing.
    //
    // The positive form is kept because it is the one that holds under BOTH
    // compilations, and this module is the sort a test in another package may
    // legitimately import. A guard whose correctness depends on which
    // program compiled it is a guard nobody can check by reading it.
    let priced: CurrencyCode | undefined;
    if (currency !== undefined) {
      if (!isCurrencyCode(currency)) return undefined;
      priced = currency;
    }
    return {
      origin,
      facetKey,
      ...(lower === undefined ? {} : { minMinor: lower }),
      ...(upper === undefined ? {} : { maxMinor: upper }),
      ...(priced === undefined ? {} : { currency: priced }),
    };
  }
  // A taxonomy entry has no range shape at all.
  return undefined;
}

/** A values entry, built on the branch its origin permits. */
function valuesEntry(
  origin: FacetOrigin,
  facetKey: string,
  values: readonly string[],
): FacetSelectionEntry | undefined {
  if (origin === 'attribute') return { origin, facetKey, values };
  if (origin === 'commerce') {
    return isFacetCommerceDimension(facetKey) ? { origin, facetKey, values } : undefined;
  }
  return facetKey === FACET_TAXONOMY_KEY
    ? { origin, facetKey: FACET_TAXONOMY_KEY, values }
    : undefined;
}

/** Read the `filters` query value. */
export function parseFacetSelection(raw: string | string[] | undefined): FacetSelectionParse {
  if (raw === undefined) return { entries: [], droppedEntryCount: 0 };
  const source = Array.isArray(raw) ? raw.join(ENTRY_SEPARATOR) : raw;

  const entries: FacetSelectionEntry[] = [];
  let droppedEntryCount = 0;

  for (const part of source.split(ENTRY_SEPARATOR)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const equals = trimmed.indexOf('=');
    const separator = equals <= 0 ? -1 : trimmed.slice(0, equals).indexOf(KEY_SEPARATOR);
    if (equals <= 0 || separator <= 0) {
      droppedEntryCount += 1;
      continue;
    }
    const origin = trimmed.slice(0, separator);
    const facetKey = decode(trimmed.slice(separator + 1, equals));
    const tail = trimmed.slice(equals + 1);
    if (!isFacetOrigin(origin) || facetKey.length === 0) {
      droppedEntryCount += 1;
      continue;
    }

    if (tail.includes(RANGE_SEPARATOR)) {
      const [bounds, currencyPart] = tail.split(CURRENCY_SEPARATOR);
      const [lowerRaw, upperRaw] = bounds.split(RANGE_SEPARATOR);
      const lower = lowerRaw.length === 0 ? undefined : Number(lowerRaw);
      const upper = upperRaw === undefined || upperRaw.length === 0 ? undefined : Number(upperRaw);
      const usable =
        (lower === undefined || Number.isFinite(lower)) &&
        (upper === undefined || Number.isFinite(upper)) &&
        !(lower === undefined && upper === undefined);
      const entry = usable
        ? boundedEntry(origin, facetKey, lower, upper, currencyPart)
        : undefined;
      if (entry === undefined) {
        droppedEntryCount += 1;
        continue;
      }
      entries.push(entry);
      continue;
    }

    const values = tail
      .split(VALUE_SEPARATOR)
      .map(decode)
      .filter((value) => value.length > 0);
    const entry = values.length === 0 ? undefined : valuesEntry(origin, facetKey, values);
    if (entry === undefined) {
      droppedEntryCount += 1;
      continue;
    }
    entries.push(entry);
  }

  return { entries, droppedEntryCount };
}

/** Toggle one bucket of one facet, preserving every other selection. */
export function toggleFacetValue(
  entries: readonly FacetSelectionEntry[],
  origin: FacetOrigin,
  facetKey: string,
  valueKey: string,
  multiSelect: boolean,
): readonly FacetSelectionEntry[] {
  const others = entries.filter(
    (entry) => !(entry.origin === origin && entry.facetKey === facetKey),
  );
  const current = entries.find(
    (entry) => entry.origin === origin && entry.facetKey === facetKey,
  );
  const selected = current?.values ?? [];
  const isSelected = selected.includes(valueKey);

  const nextValues = isSelected
    ? selected.filter((value) => value !== valueKey)
    : multiSelect
      ? [...selected, valueKey]
      : [valueKey];

  if (nextValues.length === 0) return others;
  const next = valuesEntry(origin, facetKey, nextValues);
  // A key the origin's own shape refuses cannot become a selection. It can only
  // arise from a facet the server did not offer, so leaving the rest of the
  // selection untouched is the safe answer — never a widened entry.
  return next === undefined ? entries : [...others, next];
}

/**
 * A selection entry the server kept even though the facet is no longer offered.
 *
 * `facetOffered: false` is #367's "preserve selected filters even if the current
 * result set makes a facet count zero" arriving as a fact rather than as
 * client-side memory: the server echoes the entry back and says it could not
 * offer the facet for these results. A surface renders it as a removable chip,
 * because the remedy is to remove it and the shopper cannot find it in a rail
 * that no longer lists it.
 */
export function unofferedSelections(
  response: FacetResponse,
): readonly ResolvedFacetSelectionEntry[] {
  return response.selection.filter((entry) => !entry.facetOffered);
}
