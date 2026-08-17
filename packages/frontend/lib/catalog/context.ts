import { useMemo } from 'react';
import { getLocales } from 'expo-localization';
import type { CurrencyCode } from '@mercaria/shared-types';
import { useTranslation } from '@/lib/i18n';
import { useFx } from '@mercaria/ui';
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

/**
 * Resolve the six dimensions for this render.
 *
 * Memoized on the values themselves rather than on the objects they come from,
 * so a context is referentially stable across a re-render and a React Query key
 * built from it does not refetch on every paint.
 */
export function useCatalogContext(): CatalogRequestContext {
  const { locale } = useTranslation();
  const fx = useFx();
  // ONE observation of the device, so `market` and `unitSystem` cannot come
  // from two different readings of it. Read outside the memo and passed in as
  // dependencies rather than read inside one: `getLocales()` is external mutable
  // state, and reading it in a memoized position is how a stale value survives
  // a change the memo's own deps never saw.
  const [device] = getLocales();
  const market = readDeviceMarket(device?.regionCode);
  const unitSystem = readUnitSystem(device?.measurementSystem);
  const currency = fx.primaryCurrency;

  return useMemo<CatalogRequestContext>(
    () => ({
      locale,
      language: languageOf(locale),
      ...(market === undefined ? {} : { market }),
      currency,
      unitSystem,
      sizeSystem: 'unspecified',
    }),
    [locale, market, currency, unitSystem],
  );
}
