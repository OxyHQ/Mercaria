/**
 * The catalog rollout gate — `CATALOG_ROLLOUT_COHORTS` applied to a request
 * (ADR 0007 D12, #367 Workstream 0 line 117).
 *
 * ## Why this is a middleware and not a clause in each service
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * A rollout cohort answers a question about the DEPLOYMENT — has an operator
 * switched this surface on for this market, this store, this product type yet —
 * where a service answers questions about the WORLD. That is
 * `services/checkout/guest-rollout.ts`'s division, and it exists so an incident
 * lever is never mistaken later for a policy somebody decided.
 *
 * And the four levers this refines carry ISOLATION WALLS that forbid their
 * domains from reading configuration at all:
 * `services/facets/__tests__/facet-isolation.test.ts` and
 * `services/__tests__/navigation-isolation.test.ts` are BLANKET. Those walls are
 * scoped to the directories each domain OWNS and deliberately not to the shared
 * route, controller and middleware modules — which is exactly where a mount flag
 * already lives (`app.ts`) and where this belongs. A cohort check inside
 * `facet.service.ts` would fail the build, and the natural repair — widening the
 * wall — would take the lever prohibition with it.
 *
 * ## The refusal is a 404, and it is the SAME 404 the lever gives
 *
 * A cohort narrowing is the mount decision at a finer grain: this deployment has
 * not switched this surface on for you. The storefront already treats that
 * answer as "fall back to what we served before" — `packages/frontend/lib/catalog/
 * __tests__/navigation-fallback.test.ts` executes the case and calls it "the
 * lever off is a REJECTED promise (404)" — so reusing the status means a
 * narrowed rollout needs no client change and cannot produce a menu-shaped error
 * on a shopper's first request.
 *
 * It also names NO dimension, for `guest-rollout.ts`'s reason: a refusal that
 * said WHICH lever fired would let a caller map the switchboard by varying one
 * input per request. WHICH cohort was missed is LOGGED, where the operator who
 * set it can read it.
 *
 * ## It gates a request and nothing durable
 *
 * No repository, no outbox enqueue and no loop reads a cohort — a draft, a
 * proposal or a navigation tree stored while a cohort was narrow is still there
 * and still reachable when it widens, which is the same promise the four levers
 * make and `routes/__tests__/catalog-rollout.realdb.test.ts` measures.
 */

import type { NextFunction, Request, Response } from 'express';
import type { CatalogRolloutSubject } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import { ErrorCodes, sendError } from '../utils/api-response.js';
import {
  catalogRolloutAllowedFor,
  catalogRolloutCohortLabel,
  parseCatalogRolloutCohorts,
  type CatalogRolloutCohort,
} from '../services/catalog-rollout/cohort.js';

/**
 * Parsed ONCE at import, beside the frozen config it reads.
 *
 * `config` freezes `process.env` at import and every mount in `app.ts` is
 * decided from that frozen value, so parsing per request would re-derive a
 * constant on the hottest catalogue paths. A test that needs a different cohort
 * list uses `vi.resetModules()` and re-imports, which is what
 * `catalog-rollout.realdb.test.ts` already does per deployment.
 */
const ENABLED_COHORTS: readonly CatalogRolloutCohort[] = Object.freeze(
  parseCatalogRolloutCohorts(config.catalog.rolloutCohorts),
);

/**
 * What a request states about itself, in the ONE place the mapping lives.
 *
 * Read in a fixed order — path parameters, then query, then body — because the
 * three can all carry a `storeId` and only one of them is authoritative for a
 * given route: `/stores/:storeId/product-drafts` proves the store through its
 * mount path, and a body field on that route is a value a caller typed.
 * Preferring the path means a caller cannot widen their own cohort by adding a
 * field, which is not a security boundary (`loadStore` is) but is the difference
 * between a lever that means what it says and one a client can nudge.
 *
 * Everything is read defensively rather than through the route's own zod type:
 * this runs at `router.use` level, BEFORE the per-route validator, precisely so
 * that a surface outside the rollout is refused before its body is examined.
 */
export function catalogRolloutSubjectFromRequest(req: Request): CatalogRolloutSubject {
  const params = asRecord(req.params);
  const query = asRecord(req.query);
  const body = asRecord(req.body);
  const pick = (key: string): string | null =>
    firstString(params[key], query[key], body[key]);

  return {
    market: pick('market'),
    locale: pick('locale'),
    storeId: pick('storeId'),
    categoryId: pick('categoryId'),
    productTypeKey: pick('productTypeKey'),
  };
}

/**
 * Refuse a request outside the enabled cohorts.
 *
 * `extract` defaults to {@link catalogRolloutSubjectFromRequest}; a route whose
 * subject is not on the request in that shape passes its own. The parameter
 * exists so a caller states what its surface can answer, rather than this file
 * accumulating a `switch` over paths.
 *
 * With no cohorts configured — the default — this is a length check and a
 * `next()`, so a deployment that never sets the variable pays nothing for the
 * gate existing.
 */
export function catalogRolloutGate(
  extract: (req: Request) => CatalogRolloutSubject = catalogRolloutSubjectFromRequest,
) {
  return function catalogRolloutMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (ENABLED_COHORTS.length === 0) {
      next();
      return;
    }

    const subject = extract(req);
    if (catalogRolloutAllowedFor(ENABLED_COHORTS, subject)) {
      next();
      return;
    }

    log.general.warn(
      {
        path: req.path,
        method: req.method,
        // The SUBJECT, not the enabled list: an operator reading this needs to
        // know what arrived and could not be admitted. The enabled list is in
        // their own configuration and repeating it on every refusal would put a
        // deployment's whole rollout into every log line.
        subject,
        enabledCohorts: ENABLED_COHORTS.map(catalogRolloutCohortLabel),
      },
      '[Catalog] a request fell outside CATALOG_ROLLOUT_COHORTS',
    );
    sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
  };
}

/** A request bag as a plain record, tolerating the `undefined` Express can hand back. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The first candidate that is a non-empty string, else `null`. */
function firstString(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}
