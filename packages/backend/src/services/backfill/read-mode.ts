/**
 * The canonical READ levers (#60 feature flags 2, 3, 5 and 6; ADR 0002 D24).
 *
 * Six levers, and the reason they are six rather than one is that each bounds a
 * different blast radius. Turning off the offer comparison should not take the
 * brand pages down with it; taking the whole public surface off the air is a
 * different, blunter act than telling a product page to stop answering.
 *
 * | Lever | Config | Gates |
 * |---|---|---|
 * | The domain | `CANONICAL_GRAPH_ENABLED` | the backfill dispatcher LOOP |
 * | Canonical-write publication | `CANONICAL_WRITE_PUBLICATION_ENABLED` | whether an `apply` run may mutate the graph (`graph-writer.ts`) |
 * | Canonical product reads | `CANONICAL_READS` | `/canonical-products`, `/product-families` handlers |
 * | Native-offer comparison | `CANONICAL_OFFER_COMPARISON` | the `GET /offers` handler |
 * | Canonical search (#70) | `CANONICAL_SEARCH` | the `GET /search` handler |
 * | Public canonical routes | `CANONICAL_PUBLIC_ROUTES_ENABLED` | the MOUNT of all of the above |
 * | Cohorts | `CANONICAL_READ_COHORTS` | which objects a permitted read may answer for |
 *
 * ## Why the read levers default ON and the write levers default OFF
 *
 * ADR 0002 D24's environment block shows `CANONICAL_READS=off`, and that was
 * written in phase 0, when the graph had no tables and no routes. By the time
 * this issue lands, #53–#57 have SHIPPED `/canonical-products`,
 * `/product-families`, `/brand-relationships` and `/offers` with no flag at all.
 * A lever introduced with an `off` default would therefore not be a rollout
 * lever — it would silently withdraw four shipped public surfaces on the deploy
 * that added it, which D24 forbids in as many words ("no legacy read path is
 * removed while any flag exists").
 *
 * So the READ levers preserve today's behaviour and exist to be turned OFF,
 * which is exactly what #60 acceptance 5 asks of them ("**turning off** canonical
 * reads restores the existing listing-first experience"). The `GUEST_INLINE_DESTINATION_ENABLED`
 * precedent: an incident lever defaults true. The WRITE levers —
 * `CANONICAL_GRAPH_ENABLED` and `CANONICAL_WRITE_PUBLICATION_ENABLED` — default
 * OFF as D24 binds, because those are the ones that mutate.
 *
 * ## What `shadow` means, and what it does not
 *
 * `shadow` is ADR 0002 D24 phase 3: compute the canonical answer, serve the
 * legacy one, and record that both were available. A SHOPPER sees exactly what
 * `off` shows them — it is not a third public behaviour. On the routes this
 * module gates, `off` and `shadow` are both 404, and `shadow` additionally
 * counts the request so a rollout has evidence of demand before it is turned on.
 *
 * #70's `GET /search` is the first surface where `shadow` computes BOTH answers
 * and compares them — see `services/search/shadow.ts`, which records the
 * comparison and still serves nothing. #71's product page is the other one and
 * does not exist yet; this module gives it `resolveCanonicalReadMode` and
 * {@link recordCanonicalShadowRead} rather than pretending it already compares.
 */

import type { NextFunction, Request, Response } from 'express';
import type { CanonicalReadMode, CanonicalRolloutFlags } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { canonicalReadAllowedFor, type CohortSubject } from './cohort.js';

/**
 * How many reads were refused while a lever was `shadow`, per surface.
 *
 * PROCESS-LOCAL, and the `ledgerImbalanceAttempts` reasoning applies exactly:
 * this counts something a task observed, several tasks each observe their own,
 * and a durable row per refused read would be an analytics table this domain has
 * no business owning (#77 owns measurement, and its own gate forbids a discovery
 * module writing here). Scraping and aggregation belong to `oxy-infra`.
 */
const shadowReads = new Map<string, number>();

/** Record that a surface would have answered from the canonical graph. */
export function recordCanonicalShadowRead(surface: string): void {
  shadowReads.set(surface, (shadowReads.get(surface) ?? 0) + 1);
}

/** The shadow counters, for the operator metrics endpoint. */
export function readCanonicalShadowReads(): Readonly<Record<string, number>> {
  return Object.fromEntries(shadowReads);
}

/** Reset the counters. Test-only seam; production never calls it. */
export function resetCanonicalShadowReads(): void {
  shadowReads.clear();
}

/** Every lever's current value, as the operator surface projects it. */
export function canonicalRolloutFlags(): CanonicalRolloutFlags {
  return {
    graphEnabled: config.canonicalRollout.graphEnabled,
    writePublicationEnabled: config.canonicalRollout.writePublicationEnabled,
    reads: config.canonicalRollout.reads,
    offerComparison: config.canonicalRollout.offerComparison,
    search: config.canonicalRollout.search,
    publicRoutesEnabled: config.canonicalRollout.publicRoutesEnabled,
    searchIndexingEnabled: config.canonicalRollout.searchIndexingEnabled,
    readCohorts: config.canonicalRollout.readCohorts,
  };
}

/** The canonical PRODUCT read mode. */
export function resolveCanonicalReadMode(): CanonicalReadMode {
  return config.canonicalRollout.reads;
}

/** The native-offer COMPARISON read mode. */
export function resolveOfferComparisonMode(): CanonicalReadMode {
  return config.canonicalRollout.offerComparison;
}

/**
 * The canonical SEARCH read mode (#70).
 *
 * Its own lever, `off` by default, and the ONE place in this table where
 * `shadow` does what the docblock above says the mode was invented for: #70's
 * handler computes the canonical answer AND the listing-first one, records the
 * comparison (`services/search/shadow.ts`) and serves neither, because the
 * surface is not public yet. On the other gated routes `shadow` only counts.
 */
export function resolveCanonicalSearchMode(): CanonicalReadMode {
  return config.canonicalRollout.search;
}

/**
 * May a canonical read answer for this object, given the mode and the cohorts?
 *
 * Both halves, in one call, because they are one question and separating them is
 * how a surface ends up checking the mode and forgetting the cohort. `shadow` is
 * refused here and counted by the caller — see the module docblock.
 */
export function canonicalReadPermitted(
  mode: CanonicalReadMode,
  subject: CohortSubject,
): boolean {
  if (mode !== 'on') return false;
  return canonicalReadAllowedFor(config.canonicalRollout.readCohorts, subject);
}

/**
 * The middleware every gated canonical route runs.
 *
 * Answers 404 rather than 403 when a lever is off: a shopper hitting a surface
 * this deployment has not rolled out yet is looking at a page that does not
 * exist here, and a 403 would advertise a surface they cannot reach. The same
 * reasoning as the operator allow-lists' unmounted routers, applied to a
 * rollout instead of to an authorization.
 *
 * It gates on the MODE alone. The cohort question needs the object, which the
 * middleware has not loaded — so a handler that serves a specific canonical row
 * calls {@link canonicalReadPermitted} with it afterwards, and one that serves a
 * LIST filters with it. Splitting it this way is deliberate: a middleware that
 * pretended to answer the cohort question would answer it for every route with
 * an empty subject, which `canonicalReadAllowedFor` refuses — turning a
 * cohorted rollout into a total outage.
 */
export function requireCanonicalReads(surface: string, mode: () => CanonicalReadMode) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const current = mode();
    if (current === 'on') {
      next();
      return;
    }
    if (current === 'shadow') recordCanonicalShadowRead(surface);
    res.status(404).json({ success: false, error: 'NOT_FOUND' });
  };
}
