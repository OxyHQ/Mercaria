/**
 * The request-context dimensions, and the PURE composition of them (ADR 0007 D4).
 *
 * A LEAF module, like its sibling `locale.ts` and for the same reason stated one
 * layer up in `@mercaria/ui`'s `logical-side.ts`: it imports nothing that needs a
 * bundler, so a test can run the REAL function. `context.ts` holds the hook —
 * `getLocales`, `useFx` and the i18n store all need a React tree and a
 * transform, and a plain-node runner cannot even parse that module graph
 * (measured: rollup fails on it before any assertion runs).
 *
 * So the split is not tidiness. Before it, the one property here that actually
 * goes wrong — a market taken off the READING LANGUAGE instead of off the DEVICE
 * — could not be asserted at all, and every dimension could be deleted with
 * `tsc`, lint, all validate scripts and both test runners staying green.
 */

import type { CurrencyCode } from '@mercaria/shared-types';
import { languageOf } from './locale';

/**
 * The six request dimensions, kept apart (#367 epic invariant, ADR 0007 D4).
 *
 * > Treat language, locale, market, currency, unit system and size system as
 * > related but independent dimensions.
 *
 * They are related — a Spanish device in Spain resolves five of them at once —
 * and collapsing them is how a shopper reading Spanish in Germany is shown
 * Spain's assortment, or how switching to English silently reprices a cart. So
 * each is resolved from its OWN source and carried as its own field, and no
 * consumer may derive one from another.
 *
 * | Dimension | Source | Why not something else |
 * | --- | --- | --- |
 * | `language` | the i18n store (the shopper's explicit choice) | never the device, which they already overrode |
 * | `locale` | the same choice, as a BCP-47 tag | the wire form of `language` |
 * | `market` | the DEVICE's region | a market is where you are buying, not what you read |
 * | `currency` | `FxContext` (the persisted display preference) | never the market, which does not choose it |
 * | `unitSystem` | the device's CLDR measurement system | never the language |
 * | `sizeSystem` | nothing today — see below | |
 *
 * ## Nothing here mutates a canonical value, and two dimensions say so
 *
 * `unitSystem` and `sizeSystem` are carried, reported and applied ONLY by
 * choosing which server-composed rendering to display. Neither is ever used to
 * convert a number in this package:
 *
 * - **Units.** Mercaria's public attribute surface already composes a
 *   `displayValue` beside the base-unit `normalizedNumber`, under the
 *   registry's own recorded conversion rules and versions. Converting here
 *   would be a second conversion authority with no version behind it, which is
 *   exactly what #367 workstream 4 forbids ("use deterministic conversion rules
 *   and versions", "avoid false precision after conversion"). The public
 *   surface accepts no unit-system parameter today, so what this dimension can
 *   currently do is be reported — see `docs/storefront-catalog.md`.
 * - **Sizes.** Mercaria publishes NO size-system mapping over HTTP, and
 *   workstream 4 states outright that conversions are sourced mappings with
 *   confidence rather than universal truth. So {@link CatalogSizeSystem} has
 *   ONE member, `unspecified`, and there is no value it could take that would
 *   authorize collapsing EU 42 into US 9. A size is rendered exactly as the
 *   catalogue recorded it.
 */

/**
 * The seven dimensions ADR 0007 D4 names, as DATA.
 *
 * > `language`, `locale`, `market`, `currency`, `measurement_system`,
 * > `size_system` and `time_zone` are seven independent request-context
 * > dimensions. They are carried as seven fields and never collapsed into one.
 *
 * Written down so the difference between what the ADR asks for and what this
 * package carries is a COUNTED fact rather than a paragraph somebody has to
 * notice. `request-context.test.ts` asserts the carried set plus the exemptions
 * equals this list exactly, in both directions — so dropping a dimension,
 * collapsing two, or quietly adding one all fail the build.
 */
export const ADR_0007_D4_REQUEST_DIMENSIONS = [
  'language',
  'locale',
  'market',
  'currency',
  'unitSystem',
  'sizeSystem',
  'timeZone',
] as const;

/** The dimensions {@link CatalogRequestContext} actually carries. */
export const CATALOG_REQUEST_DIMENSIONS = [
  'locale',
  'language',
  'market',
  'currency',
  'unitSystem',
  'sizeSystem',
] as const;

export type CatalogRequestDimension = (typeof CATALOG_REQUEST_DIMENSIONS)[number];

/**
 * Dimensions the ADR names and this package does NOT carry, each with a reason.
 *
 * Exactly one, and the count is asserted: a list of exemptions a gate skips is
 * how a gate stops being one. Recorded rather than filled in, deliberately —
 * adding a `timeZone` field that nothing reads would satisfy the ADR's sentence
 * and change no behaviour, which is worse than an absence somebody can see,
 * because the next reader cannot tell an unread field from a wired one.
 */
export const CATALOG_REQUEST_DIMENSION_EXEMPTIONS = [
  {
    dimension: 'timeZone',
    reason:
      'Nothing in the storefront renders a date or time in a REQUESTED zone: the two date '
      + 'formatters take a locale and use the device zone, and no catalogue endpoint accepts a '
      + 'time-zone parameter. Carrying it here would be a seventh field with no source and no '
      + 'consumer. It arrives with the first surface that renders a scheduled instant — a '
      + 'navigation tree publication window or a pickup slot — together with the endpoint '
      + 'parameter that makes it mean something.',
  },
] as const;

/**
 * How measurements are PREFERRED for display. Never how they are stored, and
 * never something this package converts with.
 */
export type CatalogUnitSystem = 'metric' | 'us' | 'uk' | 'unspecified';

/**
 * The shopper's size-system preference.
 *
 * ONE member, deliberately. A second member would be a client-side claim that
 * two size values name one foot, and no endpoint publishes the sourced mapping
 * that claim would need. Widening it is a visible code change that has to
 * arrive with the mapping it reads.
 */
export type CatalogSizeSystem = 'unspecified';

export interface CatalogRequestContext {
  /** The BCP-47 tag the shopper reads in. */
  readonly locale: string;
  /** Its primary language subtag, lowercased. */
  readonly language: string;
  /**
   * ISO-3166-1 alpha-2, from the DEVICE region.
   *
   * ABSENT when the device names none. Absent is a real answer and never a
   * guess: a market decides assortment, tax treatment and which navigation tree
   * is published, and inventing one from the reading language would show a
   * shopper somebody else's shop.
   */
  readonly market?: string;
  readonly currency: CurrencyCode;
  readonly unitSystem: CatalogUnitSystem;
  readonly sizeSystem: CatalogSizeSystem;
}

/** The CLDR measurement systems `expo-localization` reports, narrowed. */
function readUnitSystem(raw: string | null | undefined): CatalogUnitSystem {
  if (raw === 'metric') return 'metric';
  if (raw === 'us') return 'us';
  if (raw === 'uk') return 'uk';
  return 'unspecified';
}

/**
 * The device's region, normalized, or `undefined`.
 *
 * Read from the FIRST resolved locale rather than from the reading language's
 * own region subtag: a shopper reading `es-ES` on a device set to Germany is in
 * the German market, and taking the region off the language tag would be the
 * collapse this module exists to prevent.
 */
function readDeviceMarket(region: string | null | undefined): string | undefined {
  if (typeof region !== 'string') return undefined;
  const trimmed = region.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : undefined;
}

/** What the dimensions are resolved FROM — one named source each. */
export interface CatalogContextSources {
  /** The shopper's explicit reading choice, from the i18n store. */
  readonly locale: string;
  /** The DEVICE's region, raw. Never the locale's own region subtag. */
  readonly deviceRegion: string | null | undefined;
  /** The DEVICE's CLDR measurement system, raw. */
  readonly deviceMeasurementSystem: string | null | undefined;
  /** The persisted display preference, from `FxContext`. */
  readonly currency: CurrencyCode;
}

/**
 * Compose the six dimensions — PURE, so a guard can run it.
 *
 * Split out of {@link useCatalogContext} for the reason `isRtlLocale` is split
 * from `syncLayoutDirection` and `logical-side.ts` from `use-layout-direction`:
 * the DECISION imports nothing and can be asserted, while the OBSERVATION needs
 * `getLocales` and a React store and cannot run outside a bundler. Before the
 * split, the one property that actually goes wrong here — a market taken off the
 * reading language instead of off the device — was unassertable, and every
 * dimension could have been removed with `tsc`, lint, all validators and both
 * test runners staying green.
 *
 * The parameter names are the SOURCES rather than the dimensions, which is what
 * makes the independence checkable: `deviceRegion` and `locale` are different
 * parameters, so a market derived from the locale has to be written out loud.
 */
export function resolveCatalogRequestContext(
  sources: CatalogContextSources,
): CatalogRequestContext {
  const market = readDeviceMarket(sources.deviceRegion);
  return {
    locale: sources.locale,
    language: languageOf(sources.locale),
    ...(market === undefined ? {} : { market }),
    currency: sources.currency,
    unitSystem: readUnitSystem(sources.deviceMeasurementSystem),
    sizeSystem: 'unspecified',
  };
}

