/**
 * `POST /facets` — the public facet rail (#367 Workstream 10).
 *
 * One handler, no writes, no viewer-specific hydration. What it adds over the
 * service is the two boundary decisions an HTTP surface owns: the DEFAULTS for
 * locale and display currency, and turning a refused sort into a 400 rather than
 * letting it pass silently.
 *
 * ## A refused sort is an ERROR, not a fallback
 *
 * The tempting behaviour is to ignore an unsortable key and answer with the
 * default order. It is wrong for the reason every silent relaxation in this
 * domain is wrong: the client asked one question, the page answers another, and
 * nothing on the wire says so. The refusal carries a stable CODE and the key, so
 * a client fixes it rather than matching on message text (ADR 0007 D10).
 */

import type { Request, Response } from 'express';
import type {
  CurrencyCode,
  FacetCommerceDimension,
  FacetScope,
  FacetSelectionEntry,
} from '@mercaria/shared-types';
import { FACET_TAXONOMY_KEY, MERCARIA_BASE_LOCALE } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, validationError } from '../lib/errors/error-codes.js';
import { resolveFacets } from '../services/facets/facet.service.js';
import type { FacetRequestBody } from '../middleware/facet-schemas.js';
import {
  measurementSystemForMarket,
  type MeasurementSystem,
} from '../services/canonical/display-units.js';

/**
 * The display currency when a caller names none.
 *
 * FAIR, which is Mercaria's documented presentment default for a buyer who has
 * chosen none (`AGENTS.md` §Currency) — a product policy, applied at the
 * boundary rather than in the domain, which names no currency at all.
 */
const DEFAULT_FACET_CURRENCY: CurrencyCode = 'FAIR';

/**
 * The validated body, rebuilt as the domain's own union.
 *
 * Written out rather than cast, because the cast is where the discriminant gets
 * lost: `strict: false` makes zod's inference report every field as optional, so
 * an `as FacetSelectionEntry[]` would type-check while carrying a `facetKey`
 * TypeScript believes might be absent. Rebuilding on the `origin` string is
 * three branches and it is the point at which the wire shape becomes a value the
 * compiler will actually narrow.
 */
function toSelection(body: FacetRequestBody): FacetSelectionEntry[] {
  const entries: FacetSelectionEntry[] = [];
  for (const raw of body.selection ?? []) {
    if (raw.origin === 'taxonomy') {
      entries.push({
        origin: 'taxonomy',
        facetKey: FACET_TAXONOMY_KEY,
        values: raw.values ?? [],
      });
      continue;
    }
    if (raw.origin === 'commerce') {
      entries.push({
        origin: 'commerce',
        facetKey: raw.facetKey as FacetCommerceDimension,
        ...(raw.values === undefined ? {} : { values: raw.values }),
        ...(raw.minMinor === undefined ? {} : { minMinor: raw.minMinor }),
        ...(raw.maxMinor === undefined ? {} : { maxMinor: raw.maxMinor }),
        ...(raw.currency === undefined ? {} : { currency: raw.currency as CurrencyCode }),
      });
      continue;
    }
    entries.push({
      origin: 'attribute',
      facetKey: raw.facetKey,
      ...(raw.values === undefined ? {} : { values: raw.values }),
      ...(raw.min === undefined ? {} : { min: raw.min }),
      ...(raw.max === undefined ? {} : { max: raw.max }),
    });
  }
  return entries;
}

/** The scope, rebuilt on its own discriminant for the same reason. */
function toScope(body: FacetRequestBody): FacetScope {
  return body.scope.kind === 'canonical_products'
    ? { kind: 'canonical_products', canonicalProductIds: body.scope.canonicalProductIds }
    : {
        kind: 'category',
        categoryId: body.scope.categoryId,
        ...(body.scope.includeDescendants === undefined
          ? {}
          : { includeDescendants: body.scope.includeDescendants }),
      };
}

/**
 * The measurement system this request prefers, or `null` (#367 line 598).
 *
 * The SAME rule `catalog-attributes.controller.ts` states, and deliberately the
 * same three lines rather than a second convention: an explicit `unitSystem`
 * wins over a `market`, because the first is what the shopper's DEVICE reports
 * and the second is only where they are. Two surfaces deciding differently about
 * one shopper is the divergence #941 is about, one domain over.
 *
 * `null` is a real answer, not a missing one. `measurementSystemForMarket`
 * returns `null` for an absent or malformed market rather than `metric`, and
 * `metric` for a well-formed one CLDR does not override — two different
 * outcomes, and only the first means "nothing was stated". With `null` every
 * range is served in its base unit exactly as it was before this parameter
 * existed.
 *
 * `body.locale` is NOT consulted and must not be. A shopper reading Spanish in
 * Ohio is in a US-customary market; taking the system off the reading language
 * is the collapse ADR 0007 D4 forbids, and it is why `market` is a second
 * parameter rather than something derived here.
 */
function preferredSystem(body: FacetRequestBody): MeasurementSystem | null {
  if (body.unitSystem !== undefined) return body.unitSystem;
  return measurementSystemForMarket(body.market);
}

export async function facetsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as FacetRequestBody;
    const outcome = await resolveFacets(
      {
        scope: toScope(body),
        selection: toSelection(body),
        locale: body.locale ?? MERCARIA_BASE_LOCALE,
        displayCurrency: (body.currency as CurrencyCode | undefined) ?? DEFAULT_FACET_CURRENCY,
        measurementSystem: preferredSystem(body),
        ...(body.sort === undefined ? {} : { sort: body.sort }),
      },
      getDb(),
    );

    const sort = outcome.sort;
    if (sort !== undefined && sort.outcome === 'refused') {
      throw validationError(`Cannot sort by '${sort.key}': ${sort.refusal}.`);
    }

    sendSuccess(res, {
      ...outcome.response,
      ...(sort === undefined || sort.outcome !== 'resolved' ? {} : { sort: sort.directive }),
    });
  } catch (error) {
    respondWithError(res, error, 'Resolving facets failed');
  }
}
