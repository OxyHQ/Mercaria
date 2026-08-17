/**
 * The React binding for the request-context dimensions (ADR 0007 D4).
 *
 * The DECISION — which dimension is resolved from which source, and what each
 * may not be derived from — lives in `./request-context.ts`, which imports
 * nothing that needs a bundler so a test can run it. This module is the
 * OBSERVATION: `getLocales`, the i18n store and `FxContext`, none of which can
 * run outside a React tree. The same split `@mercaria/ui` already has between
 * `isRtlLocale` and `syncLayoutDirection`.
 */

import { useMemo } from 'react';
import { getLocales } from 'expo-localization';
import { useTranslation } from '@/lib/i18n';
import { useFx } from '@mercaria/ui';
import {
  resolveCatalogRequestContext,
  type CatalogRequestContext,
} from './request-context';

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
  //
  // The deps are the RAW device values rather than the normalized ones they were
  // before the pure resolver was extracted. The stability property still holds
  // for the reason it mattered — a React Query key built from this context does
  // not churn per paint — because both come from one platform read and are
  // stable strings between reads. What is no longer true is that a raw value
  // changing to a different spelling of the same answer (`de` for `DE`) would be
  // absorbed; that is a change no platform makes, and normalizing before the
  // memo would put `readDeviceMarket` back outside the pure function, where the
  // one property worth asserting about it cannot be reached.
  const [device] = getLocales();
  const deviceRegion = device?.regionCode;
  const deviceMeasurementSystem = device?.measurementSystem;
  const currency = fx.primaryCurrency;

  return useMemo<CatalogRequestContext>(
    () =>
      resolveCatalogRequestContext({
        locale,
        deviceRegion,
        deviceMeasurementSystem,
        currency,
      }),
    [locale, deviceRegion, deviceMeasurementSystem, currency],
  );
}
