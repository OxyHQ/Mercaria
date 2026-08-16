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

export async function facetsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as FacetRequestBody;
    const outcome = await resolveFacets(
      {
        scope: toScope(body),
        selection: toSelection(body),
        locale: body.locale ?? MERCARIA_BASE_LOCALE,
        displayCurrency: (body.currency as CurrencyCode | undefined) ?? DEFAULT_FACET_CURRENCY,
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
