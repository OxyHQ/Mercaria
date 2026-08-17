/**
 * The request-context dimensions are INDEPENDENT (#367, ADR 0007 D4).
 *
 * D4: "`language`, `locale`, `market`, `currency`, `measurement_system`,
 * `size_system` and `time_zone` are seven independent request-context
 * dimensions. They are carried as seven fields and never collapsed into one."
 *
 * ## What had no gate at all
 *
 * `context.ts` documented every dimension, its source and why it is not
 * something else — and nothing asserted any of it. Measured before this file
 * existed: no test in either package referenced `CatalogRequestContext` or
 * `useCatalogContext`, no validator mentioned a dimension, and removing
 * `language`, `unitSystem` and `sizeSystem` outright left `tsc`, lint, all
 * validate scripts and both test runners green. A mechanism with no gate behind
 * it is a convention.
 *
 * ## The one thing that actually goes wrong, and why it needed the split
 *
 * The collapse this module exists to prevent is a market taken off the READING
 * LANGUAGE instead of off the DEVICE — a shopper reading `es-ES` on a device set
 * to Germany being shown Spain's assortment. Every wrong answer there has the
 * right type, renders fine, and is a two-character edit
 * (`device?.regionCode` → `locale`). It was unassertable while the composition
 * lived inside a hook that needs `getLocales` and a React store, which is why
 * `resolveCatalogRequestContext` was extracted as a pure function — the
 * `logical-side.ts` and `isRtlLocale` split, applied here.
 *
 * The parameter names carry half the property on their own:
 * `CatalogContextSources` names `locale` and `deviceRegion` as SEPARATE inputs,
 * so a market derived from the locale has to be written out loud rather than
 * being the path of least resistance.
 */

import { describe, expect, it } from 'vitest';
import type { CatalogContextSources } from '../request-context';
import {
  ADR_0007_D4_REQUEST_DIMENSIONS,
  CATALOG_REQUEST_DIMENSIONS,
  CATALOG_REQUEST_DIMENSION_EXEMPTIONS,
  resolveCatalogRequestContext,
} from '../request-context';

/** A device in Germany reading Spanish — the case the collapse gets wrong. */
const SPANISH_IN_GERMANY: CatalogContextSources = {
  locale: 'es-ES',
  deviceRegion: 'DE',
  deviceMeasurementSystem: 'metric',
  currency: 'EUR',
};

describe('the declared dimension set', () => {
  it('names all seven the ADR does, and the count is the ADR’s own', () => {
    // A floor on the LIST rather than on a traversal of it: a list somebody
    // trimmed to match the implementation would make every assertion below pass
    // by describing less.
    expect(ADR_0007_D4_REQUEST_DIMENSIONS).toHaveLength(7);
    expect(new Set(ADR_0007_D4_REQUEST_DIMENSIONS).size).toBe(7);
    for (const dimension of ['language', 'locale', 'market', 'currency', 'timeZone'] as const) {
      expect(ADR_0007_D4_REQUEST_DIMENSIONS).toContain(dimension);
    }
  });

  it('carries every dimension it does not exempt, and exempts nothing it carries', () => {
    const carried = new Set<string>(CATALOG_REQUEST_DIMENSIONS);
    const exempt = new Set<string>(
      CATALOG_REQUEST_DIMENSION_EXEMPTIONS.map((entry) => entry.dimension),
    );

    // Both directions. Containment one way would be satisfied by exempting
    // everything; the other way by carrying a dimension the ADR never named.
    for (const dimension of ADR_0007_D4_REQUEST_DIMENSIONS) {
      expect(
        carried.has(dimension) !== exempt.has(dimension),
        `${dimension} must be either carried or exempt, and not both`,
      ).toBe(true);
    }
    for (const dimension of carried) {
      expect(ADR_0007_D4_REQUEST_DIMENSIONS).toContain(dimension);
    }
    expect(carried.size + exempt.size).toBe(ADR_0007_D4_REQUEST_DIMENSIONS.length);
  });

  it('exempts EXACTLY one dimension, with a reason', () => {
    // The exact-count rule: a list of exemptions a gate skips is how a gate stops
    // being one, so the length is pinned rather than bounded. Adding a second
    // exemption is a decision somebody has to come here and make.
    expect(CATALOG_REQUEST_DIMENSION_EXEMPTIONS).toHaveLength(1);
    const [only] = CATALOG_REQUEST_DIMENSION_EXEMPTIONS;
    expect(only.dimension).toBe('timeZone');
    // A reason long enough to be one. An empty string satisfies "has a reason".
    expect(only.reason.length).toBeGreaterThan(80);
  });
});

describe('the dimensions are resolved from separate sources', () => {
  it('takes the market from the DEVICE region, never from the locale’s region subtag', () => {
    const context = resolveCatalogRequestContext(SPANISH_IN_GERMANY);
    // The whole point: `es-ES` carries `ES`, the device says `DE`, and the market
    // is where the shopper is buying.
    expect(context.market).toBe('DE');
    expect(context.market).not.toBe('ES');
    // And the reading language is untouched by the market.
    expect(context.locale).toBe('es-ES');
    expect(context.language).toBe('es');
  });

  it('reports NO market when the device names none, rather than guessing one', () => {
    const context = resolveCatalogRequestContext({
      ...SPANISH_IN_GERMANY,
      deviceRegion: undefined,
    });
    // Absent, not `'ES'` off the locale and not a placeholder. A market decides
    // assortment and tax treatment, so an invented one shows somebody else's shop.
    expect(context.market).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(context, 'market')).toBe(false);
  });

  it('refuses a device region that is not two letters', () => {
    for (const raw of ['', '  ', 'DEU', 'D', '4X2', null]) {
      expect(resolveCatalogRequestContext({ ...SPANISH_IN_GERMANY, deviceRegion: raw }).market)
        .toBeUndefined();
    }
    // The positive control on the loop above: the reader does admit a real one,
    // case-normalized. Without this the loop passes against a reader that admits
    // nothing at all.
    expect(resolveCatalogRequestContext({ ...SPANISH_IN_GERMANY, deviceRegion: 'de' }).market)
      .toBe('DE');
  });

  it('does not derive the currency from the locale or the market', () => {
    // One locale, one device, two currencies — the persisted display preference
    // is its own dimension. Collapsing it is how switching language reprices a
    // cart.
    const eur = resolveCatalogRequestContext({ ...SPANISH_IN_GERMANY, currency: 'EUR' });
    const usd = resolveCatalogRequestContext({ ...SPANISH_IN_GERMANY, currency: 'USD' });
    expect(eur.currency).toBe('EUR');
    expect(usd.currency).toBe('USD');
    // …and changing the currency moves NOTHING else.
    expect({ ...eur, currency: null }).toEqual({ ...usd, currency: null });
  });

  it('does not derive the unit system from the language or the market', () => {
    // A US device reading Spanish is still on US units; a metric device reading
    // English is still metric. Either direction collapsed is a wrong unit label
    // beside a correct number.
    expect(
      resolveCatalogRequestContext({ ...SPANISH_IN_GERMANY, deviceMeasurementSystem: 'us' })
        .unitSystem,
    ).toBe('us');
    expect(
      resolveCatalogRequestContext({
        locale: 'en',
        deviceRegion: 'US',
        deviceMeasurementSystem: 'metric',
        currency: 'USD',
      }).unitSystem,
    ).toBe('metric');
    // An unrecognised system is `unspecified`, never a guess from the region.
    expect(
      resolveCatalogRequestContext({ ...SPANISH_IN_GERMANY, deviceMeasurementSystem: 'imperial' })
        .unitSystem,
    ).toBe('unspecified');
  });

  it('emits a size system that cannot claim a conversion', () => {
    // ONE member. There is no value this could take that would authorize
    // collapsing EU 42 into US 9, because no endpoint publishes the sourced
    // mapping such a claim needs.
    expect(resolveCatalogRequestContext(SPANISH_IN_GERMANY).sizeSystem).toBe('unspecified');
  });

  it('carries exactly the declared dimensions and nothing else', () => {
    // The runtime half of the declaration above: a field added to the interface
    // without joining `CATALOG_REQUEST_DIMENSIONS` fails here, and a dimension
    // removed from the resolver fails the required-key check.
    const context = resolveCatalogRequestContext(SPANISH_IN_GERMANY);
    const keys = Object.keys(context);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(CATALOG_REQUEST_DIMENSIONS, `${key} is emitted but not declared`).toContain(key);
    }
    // Every declared dimension except the optional one must be present. `market`
    // is legitimately absent when the device names none, which the case above
    // covers; this fixture supplies one, so here it must be present too.
    for (const dimension of CATALOG_REQUEST_DIMENSIONS) {
      expect(keys, `${dimension} is declared but not emitted`).toContain(dimension);
    }
  });
});
