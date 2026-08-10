/**
 * Comparison and basket controllers (THIN) — #96's public surface.
 *
 * Everything is delegated to `services/comparison/`. Nothing here compares,
 * scores, solves, prices or explains: the deterministic table and the solver
 * live in tested domain modules, and a controller that derived any of it would
 * be the first place a second answer appeared — #74's rule for the same shape
 * of surface, one domain over.
 *
 * ## The two rollout levers are resolved HERE and passed IN
 *
 * `CANONICAL_OFFER_COMPARISON` decides whether the offers half may be served at
 * all, and `PRICE_HISTORY_PUBLIC_READS_ENABLED` decides whether #78's signals
 * may enter the grounded input. Both are read once, in this file, and handed to
 * the services as booleans — the `readCanonicalProductPage` decision, so a
 * service reading `config` is never a second place a rollout is decided.
 *
 * A comparison with the offers lever off still answers: the products, their
 * typed attributes and their constraint outcomes are all real, and every
 * subject reports `unavailable` with `offer_comparison_withheld` rather than
 * rendering as a product nobody sells.
 */

import type { Request, Response } from 'express';
import type {
  BasketChannelPolicy,
  BasketObjective,
  BasketReasonCode,
  BasketRequest,
  BasketRequestLine,
  ConditionGroup,
  CurrencyCode,
  ProductConstraint,
  ValidatedConstraintSet,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getDb } from '../db/postgres.js';
import { respondWithError, validationError } from '../lib/errors/error-codes.js';
import { validateConstraintSet } from '../services/attributes/constraint-validation.js';
import { resolveOfferComparisonMode } from '../services/backfill/read-mode.js';
import { compareCanonicalProducts } from '../services/comparison/comparison.service.js';
import { solveBasketRequest } from '../services/comparison/basket.service.js';
import {
  offerIdsByRef,
  revalidateBasketPlan,
} from '../services/comparison/revalidation.service.js';
import { readWatchlist } from '../services/watchlists/watchlist.service.js';
import {
  DEFAULT_PRESENTMENT_CURRENCY,
  resolvePresentmentCurrency,
} from '../services/user-preference.service.js';
import { sendSuccess } from '../utils/api-response.js';

/**
 * The currency this comparison names.
 *
 * A signed-in buyer's STORED preference is authoritative and the body's
 * `currency` is ignored for them — `cart.service`'s rule, quoted by #74 and
 * applying here for its reason: a preference they set is a decision, and a link
 * somebody sent them is not.
 */
async function resolveComparisonCurrency(
  req: Request,
  requested: CurrencyCode | undefined,
): Promise<CurrencyCode> {
  const oxyUserId = req.user?.id;
  if (oxyUserId) return resolvePresentmentCurrency(oxyUserId);
  return requested ?? DEFAULT_PRESENTMENT_CURRENCY;
}

/** Whether the offers half may be served in this deployment. */
function offersPermitted(): boolean {
  return resolveOfferComparisonMode() === 'on';
}

/**
 * Validate a raw constraint set through #94, or refuse.
 *
 * The client cannot send a {@link ValidatedConstraintSet} — its brand is
 * unexported and unforgeable, deliberately — so a comparison that takes
 * constraints must validate them here, through #94's own validator and not a
 * second one. A refusal carries EVERY issue, which is #94's own rule: a shopper
 * who asked for three impossible things should be told about three.
 */
async function validateConstraints(
  constraints: readonly ProductConstraint[] | undefined,
  categoryId: string | undefined,
): Promise<ValidatedConstraintSet | undefined> {
  if (constraints === undefined || constraints.length === 0) return undefined;
  const validation = await validateConstraintSet(
    getDb(),
    { constraints },
    categoryId === undefined ? {} : { categoryId },
  );
  // `=== true`, never `!validation.valid`: the backend compiles without
  // `strictNullChecks`, where TypeScript does not narrow a union on the
  // TRUTHINESS of a boolean-literal discriminant (#68's finding, hit again in
  // #110 and once more here).
  if (validation.valid === true) return validation.set;
  throw validationError(
    `Those requirements cannot be answered: ${validation.issues
      .map((issue) => `${issue.constraintId}: ${issue.code}`)
      .join('; ')}`,
  );
}

/** `POST /comparison` — the grounded comparison of two or more products. */
export async function compareProductsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      subjects: { handle: string; canonicalVariantId?: string }[];
      currency?: CurrencyCode;
      market?: string;
      conditionGroups?: ConditionGroup[];
      categoryId?: string;
      constraints?: ProductConstraint[];
    };

    const constraints = await validateConstraints(body.constraints, body.categoryId);
    const result = await compareCanonicalProducts({
      subjects: body.subjects.map((subject) => ({
        handle: subject.handle,
        ...(subject.canonicalVariantId === undefined
          ? {}
          : { canonicalVariantId: subject.canonicalVariantId }),
      })),
      comparisonCurrency: await resolveComparisonCurrency(req, body.currency),
      ...(body.market === undefined ? {} : { market: body.market }),
      ...(body.conditionGroups === undefined ? {} : { conditionGroups: body.conditionGroups }),
      ...(constraints === undefined ? {} : { constraints }),
      offerLimit: config.pagination.defaultPageSize,
      offerComparisonPermitted: offersPermitted(),
      priceSignalsPermitted: config.priceHistory.publicReadsEnabled,
    });

    sendSuccess(res, result);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to compare products');
  }
}

/** `POST /comparison/basket` — solve a basket over current eligible offers. */
export async function solveBasketHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      lines?: BasketRequestLine[];
      watchlistId?: string;
      currency?: CurrencyCode;
      market?: string;
      channelPolicy?: BasketChannelPolicy;
      conditionGroups?: ConditionGroup[];
      objectives?: BasketObjective[];
      maxMerchants?: number;
      excludedMerchantIds?: string[];
      pickup?: true;
    };

    const resolved = await resolveLines(req, body);
    const request: BasketRequest = {
      lines: resolved.lines,
      comparisonCurrency: await resolveComparisonCurrency(req, body.currency),
      ...(body.market === undefined ? {} : { market: body.market.toUpperCase() }),
      channelPolicy: body.channelPolicy ?? 'mixed',
      ...(body.conditionGroups === undefined ? {} : { conditionGroups: body.conditionGroups }),
      objectives: body.objectives ?? ['cheapest_known_item_prices'],
      ...(body.maxMerchants === undefined ? {} : { maxMerchants: body.maxMerchants }),
      ...(body.excludedMerchantIds === undefined
        ? {}
        : { excludedMerchantIds: body.excludedMerchantIds }),
      ...(body.pickup === undefined ? {} : { pickupPreference: { requested: true } }),
    };

    const solution = await solveBasketRequest({
      request,
      offerComparisonPermitted: offersPermitted(),
      ...(resolved.callerRefusals.size === 0
        ? {}
        : { callerRefusals: resolved.callerRefusals }),
    });
    sendSuccess(res, solution);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to solve basket');
  }
}

/** The lines to solve, plus any the caller already knows cannot be planned. */
interface ResolvedBasketLines {
  readonly lines: readonly BasketRequestLine[];
  readonly callerRefusals: ReadonlyMap<string, readonly BasketReasonCode[]>;
}

/**
 * The lines to solve, from the body or from #81's watchlist.
 *
 * A watchlist needs an Oxy account and there is no guest branch: #81's lists are
 * private to an account, and `readWatchlist` answers ONE indistinguishable 404
 * for "no such list" and "not yours" — which is its rule, honoured by calling it
 * rather than by re-deriving ownership here.
 *
 * ## An AMBIGUOUS item becomes a line that cannot be planned, never a dropped one
 *
 * A catalogue split can leave a watchlist item pointing at two products, and
 * #81 records that as `ambiguous_after_split` rather than guessing. Planning it
 * would put the wrong product in a basket; dropping it would make a basket of
 * four items silently plan three and report success. So it stays a LINE, counts
 * toward coverage, and carries `watchlist_item_unresolved` — the only answer a
 * shopper can act on, by telling #81 which half they meant.
 */
async function resolveLines(
  req: Request,
  body: { lines?: BasketRequestLine[]; watchlistId?: string },
): Promise<ResolvedBasketLines> {
  if (body.lines !== undefined) return { lines: body.lines, callerRefusals: new Map() };
  const watchlistId = body.watchlistId;
  if (watchlistId === undefined) throw validationError('Provide lines or a watchlistId');

  const oxyUserId = req.user?.id;
  if (!oxyUserId) throw validationError('Solving a watchlist needs a signed-in account');

  const detail = await readWatchlist(oxyUserId, watchlistId);
  const lines: BasketRequestLine[] = [];
  const callerRefusals = new Map<string, readonly BasketReasonCode[]>();

  for (const item of detail.items) {
    lines.push({
      lineId: item.id,
      canonicalProductId: item.canonicalProductId,
      ...(item.preferredCanonicalVariantId === undefined
        ? {}
        : { canonicalVariantId: item.preferredCanonicalVariantId }),
      quantity: item.quantity,
      ...(item.preferredConditionGroup === undefined
        ? {}
        : { conditionGroups: [item.preferredConditionGroup] }),
      ...(item.preferredMerchantId === undefined ? {} : { merchantId: item.preferredMerchantId }),
    });
    if (item.resolution.state === 'ambiguous_after_split') {
      callerRefusals.set(item.id, ['watchlist_item_unresolved']);
    }
  }

  if (lines.length === 0) throw validationError('That watchlist has no items yet');
  return { lines, callerRefusals };
}

/** `POST /comparison/basket/revalidate` — re-check a plan before acting on it. */
export async function revalidateBasketHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      snapshot: Parameters<typeof revalidateBasketPlan>[0]['snapshot'];
      plan: Parameters<typeof revalidateBasketPlan>[0]['plan'];
      records: { ref: string; kind: string; recordId: string }[];
    };
    const revalidation = await revalidateBasketPlan({
      snapshot: body.snapshot,
      plan: body.plan,
      offerIdsByRef: offerIdsByRef(body.records),
    });
    sendSuccess(res, revalidation);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to revalidate basket');
  }
}
