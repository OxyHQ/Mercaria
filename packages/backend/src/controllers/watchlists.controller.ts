/**
 * Watchlist controllers (THIN) — the buyer's own surface (#81).
 *
 * Every decision lives in `services/watchlists/`. What is here is the
 * request→service→envelope wiring and the one thing a controller must own: the
 * caller's identity, taken from the verified credential with
 * `getRequiredOxyUserId` and never from a body field. A watchlist is stored under
 * an Oxy account id, so a request able to name a different one would be an IDOR
 * over other people's private lists and their private notes.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  ConditionGroup,
  CurrencyCode,
  WatchlistItemSplitResolution,
  WatchlistTemplateKey,
} from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import {
  createWatchlist,
  duplicateWatchlist,
  listWatchlists,
  readWatchlist,
  removeWatchlist,
  updateWatchlist,
} from '../services/watchlists/watchlist.service.js';
import {
  addWatchlistItem,
  changeWatchlistItem,
  countWatchlistItemsPendingResolution,
  removeWatchlistItem,
  reorderWatchlistItems,
  resolveWatchlistItemSplit,
} from '../services/watchlists/item.service.js';
import {
  readWatchlistBasket,
  readWatchlistSnapshotDetail,
  readWatchlistSnapshotDiff,
  readWatchlistSnapshots,
  recordWatchlistSnapshot,
} from '../services/watchlists/snapshot.service.js';
import { WATCHLIST_TEMPLATES } from '../services/watchlists/templates.js';

/** GET /watchlists — every list this account owns. */
export async function listWatchlistsHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, { watchlists: await listWatchlists(oxyUserId) });
  } catch (err) {
    log.general.error({ err }, 'Failed to list watchlists');
    respondWithError(res, err, 'Failed to load your watchlists');
  }
}

/** GET /watchlists/templates — the starting shapes a client may offer (#81 UX rule 8). */
export function watchlistTemplatesHandler(_req: Request, res: Response): void {
  sendSuccess(res, { templates: Object.values(WATCHLIST_TEMPLATES) });
}

/** GET /watchlists/pending — how many entries are waiting on this buyer to answer. */
export async function pendingWatchlistResolutionsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, {
      awaitingResolution: await countWatchlistItemsPendingResolution(oxyUserId),
    });
  } catch (err) {
    log.general.error({ err }, 'Failed to count watchlist items awaiting resolution');
    respondWithError(res, err, 'Failed to read your watchlists');
  }
}

interface CreateWatchlistBody {
  name?: string;
  displayCurrency: CurrencyCode;
  description?: string;
  icon?: string;
  market?: string;
  templateKey?: WatchlistTemplateKey;
}

/** POST /watchlists — create one. */
export async function createWatchlistHandler(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as CreateWatchlistBody;
    sendSuccess(res, { watchlist: await createWatchlist({ oxyUserId, ...body }) });
  } catch (err) {
    log.general.error({ err }, 'Failed to create a watchlist');
    respondWithError(res, err, 'Failed to create that watchlist');
  }
}

/** GET /watchlists/:watchlistId — the list and its items. Evaluates NOTHING. */
export async function readWatchlistHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, await readWatchlist(oxyUserId, watchlistId));
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to read a watchlist');
    respondWithError(res, err, 'Failed to load that watchlist');
  }
}

/** PATCH /watchlists/:watchlistId — rename, re-describe, change the currency. */
export async function updateWatchlistHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { expectedVersion, ...patch } = req.body as {
      expectedVersion: number;
      name?: string;
      description?: string | null;
      icon?: string | null;
      displayCurrency?: CurrencyCode;
      market?: string | null;
    };
    sendSuccess(res, {
      watchlist: await updateWatchlist(oxyUserId, watchlistId, expectedVersion, patch),
    });
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to update a watchlist');
    respondWithError(res, err, 'Failed to update that watchlist');
  }
}

/** DELETE /watchlists/:watchlistId — remove it, its items and its history. */
export async function deleteWatchlistHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { expectedVersion } = req.body as { expectedVersion: number };
    sendSuccess(res, await removeWatchlist(oxyUserId, watchlistId, expectedVersion));
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to delete a watchlist');
    respondWithError(res, err, 'Failed to delete that watchlist');
  }
}

/** POST /watchlists/:watchlistId/duplicate — copy a list (#81 UX rule 7). */
export async function duplicateWatchlistHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { name } = req.body as { name?: string };
    sendSuccess(res, await duplicateWatchlist(oxyUserId, watchlistId, name));
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to duplicate a watchlist');
    respondWithError(res, err, 'Failed to duplicate that watchlist');
  }
}

/** POST /watchlists/:watchlistId/items — add one product (idempotent). */
export async function addWatchlistItemHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as {
      expectedVersion: number;
      canonicalProductId: string;
      quantity?: number;
      preferredCanonicalVariantId?: string;
      preferredConditionGroup?: ConditionGroup;
      preferredMerchantId?: string;
      targetAmount?: number;
      targetCurrency?: CurrencyCode;
      note?: string;
    };
    sendSuccess(res, await addWatchlistItem({ oxyUserId, watchlistId, ...body }));
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to add a watchlist item');
    respondWithError(res, err, 'Failed to add that item');
  }
}

/** PATCH /watchlists/:watchlistId/items/:itemId — quantity, preferences, target, note. */
export async function updateWatchlistItemHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  const itemId = routeParam(req, 'itemId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const body = req.body as {
      expectedVersion: number;
      quantity?: number;
      preferredCanonicalVariantId?: string | null;
      preferredConditionGroup?: ConditionGroup | null;
      preferredMerchantId?: string | null;
      targetAmount?: number | null;
      targetCurrency?: CurrencyCode | null;
      note?: string | null;
    };
    sendSuccess(res, await changeWatchlistItem({ oxyUserId, watchlistId, itemId, ...body }));
  } catch (err) {
    log.general.error({ err, watchlistId, itemId }, 'Failed to update a watchlist item');
    respondWithError(res, err, 'Failed to update that item');
  }
}

/** DELETE /watchlists/:watchlistId/items/:itemId — remove one entry. */
export async function deleteWatchlistItemHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  const itemId = routeParam(req, 'itemId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { expectedVersion } = req.body as { expectedVersion: number };
    sendSuccess(res, await removeWatchlistItem(oxyUserId, watchlistId, itemId, expectedVersion));
  } catch (err) {
    log.general.error({ err, watchlistId, itemId }, 'Failed to remove a watchlist item');
    respondWithError(res, err, 'Failed to remove that item');
  }
}

/** PUT /watchlists/:watchlistId/items/order — the COMPLETE ordering. */
export async function reorderWatchlistItemsHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { expectedVersion, itemIds } = req.body as {
      expectedVersion: number;
      itemIds: string[];
    };
    sendSuccess(
      res,
      await reorderWatchlistItems(oxyUserId, watchlistId, expectedVersion, itemIds),
    );
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to reorder a watchlist');
    respondWithError(res, err, 'Failed to reorder that watchlist');
  }
}

/** POST /watchlists/:watchlistId/items/:itemId/resolve-split — answer a split. */
export async function resolveWatchlistSplitHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  const itemId = routeParam(req, 'itemId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { expectedVersion, resolution } = req.body as {
      expectedVersion: number;
      resolution: WatchlistItemSplitResolution;
    };
    sendSuccess(
      res,
      await resolveWatchlistItemSplit({
        oxyUserId,
        watchlistId,
        itemId,
        expectedVersion,
        resolution,
      }),
    );
  } catch (err) {
    log.general.error({ err, watchlistId, itemId }, 'Failed to resolve a watchlist split');
    respondWithError(res, err, 'Failed to resolve that item');
  }
}

/** GET /watchlists/:watchlistId/basket — evaluate, and record NOTHING. */
export async function readWatchlistBasketHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, { basket: await readWatchlistBasket(oxyUserId, watchlistId) });
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to evaluate a watchlist basket');
    respondWithError(res, err, 'Failed to price that watchlist');
  }
}

/** POST /watchlists/:watchlistId/snapshots — record one evaluation, deduplicated. */
export async function recordWatchlistSnapshotHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, await recordWatchlistSnapshot(oxyUserId, watchlistId));
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to record a watchlist snapshot');
    respondWithError(res, err, 'Failed to save that measurement');
  }
}

/** GET /watchlists/:watchlistId/snapshots — the recorded history, newest first. */
export async function listWatchlistSnapshotsHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { limit } = req.query as unknown as { limit?: number };
    sendSuccess(res, {
      snapshots: await readWatchlistSnapshots(oxyUserId, watchlistId, limit),
    });
  } catch (err) {
    log.general.error({ err, watchlistId }, 'Failed to list watchlist snapshots');
    respondWithError(res, err, 'Failed to load that history');
  }
}

/** GET /watchlists/:watchlistId/snapshots/:snapshotId — one recorded evaluation. */
export async function readWatchlistSnapshotHandler(req: Request, res: Response): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  const snapshotId = routeParam(req, 'snapshotId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, await readWatchlistSnapshotDetail(oxyUserId, watchlistId, snapshotId));
  } catch (err) {
    log.general.error({ err, watchlistId, snapshotId }, 'Failed to read a watchlist snapshot');
    respondWithError(res, err, 'Failed to load that measurement');
  }
}

/** GET /watchlists/:watchlistId/snapshots/:snapshotId/diff — which items drove it. */
export async function readWatchlistSnapshotDiffHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const watchlistId = routeParam(req, 'watchlistId');
  const snapshotId = routeParam(req, 'snapshotId');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    sendSuccess(res, { diff: await readWatchlistSnapshotDiff(oxyUserId, watchlistId, snapshotId) });
  } catch (err) {
    log.general.error({ err, watchlistId, snapshotId }, 'Failed to diff a watchlist snapshot');
    respondWithError(res, err, 'Failed to explain that change');
  }
}
