/**
 * `/watchlists` — the buyer's private lists and their basket history (#81).
 *
 * Mounted only when `WATCHLISTS_ENABLED`, so a deployment that has not adopted
 * #81 answers 404. The LISTS themselves are never gated by anything: a row
 * already stored stays stored and comes back when the flag does, because a flag
 * that hid a person's own data would make the rollback lever cost them their
 * lists — which is the lever nobody would then pull.
 *
 * There is deliberately NO operator surface and no internal router. Six
 * allow-lists already exist and none of them should be able to read somebody's
 * private list or their private notes; a seventh would be a new power rather
 * than a new scope for an existing one, and every repair this domain could need
 * is an idempotent path the OWNER already drives. #81 privacy rule 2 bounds what
 * a merchant may receive, and the enforcement is that there is no surface to
 * receive it from.
 *
 * Metered on the `'listings'` scope — a watchlist read is a catalogue-shaped
 * read at the same rate and volume, and the basket evaluation is bounded by the
 * per-list item limit. A dedicated bucket would be a budget to tune for no risk
 * the catalogue budget does not already bound.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId } from '../middleware/validate.js';
import {
  addWatchlistItemSchema,
  createWatchlistSchema,
  duplicateWatchlistSchema,
  reorderWatchlistItemsSchema,
  resolveWatchlistSplitSchema,
  updateWatchlistItemSchema,
  updateWatchlistSchema,
  watchlistVersionSchema,
} from '../middleware/watchlist-schemas.js';
import {
  addWatchlistItemHandler,
  createWatchlistHandler,
  deleteWatchlistHandler,
  deleteWatchlistItemHandler,
  duplicateWatchlistHandler,
  listWatchlistsHandler,
  listWatchlistSnapshotsHandler,
  pendingWatchlistResolutionsHandler,
  readWatchlistBasketHandler,
  readWatchlistHandler,
  readWatchlistSnapshotDiffHandler,
  readWatchlistSnapshotHandler,
  recordWatchlistSnapshotHandler,
  reorderWatchlistItemsHandler,
  resolveWatchlistSplitHandler,
  updateWatchlistHandler,
  updateWatchlistItemHandler,
  watchlistTemplatesHandler,
} from '../controllers/watchlists.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(makeRateLimiter('listings'));

/** The two literal paths come FIRST, or `/:watchlistId` swallows them. */
router.get('/templates', watchlistTemplatesHandler);
router.get('/pending', pendingWatchlistResolutionsHandler);

router.get('/', listWatchlistsHandler);
router.post('/', validateBody(createWatchlistSchema), createWatchlistHandler);

router.get('/:watchlistId', validateId('watchlistId'), readWatchlistHandler);
router.patch(
  '/:watchlistId',
  validateId('watchlistId'),
  validateBody(updateWatchlistSchema),
  updateWatchlistHandler,
);
router.delete(
  '/:watchlistId',
  validateId('watchlistId'),
  validateBody(watchlistVersionSchema),
  deleteWatchlistHandler,
);
router.post(
  '/:watchlistId/duplicate',
  validateId('watchlistId'),
  validateBody(duplicateWatchlistSchema),
  duplicateWatchlistHandler,
);

/**
 * `items/order` comes BEFORE `items/:itemId`, or a reorder is read as a patch of
 * an item called `order`.
 */
router.put(
  '/:watchlistId/items/order',
  validateId('watchlistId'),
  validateBody(reorderWatchlistItemsSchema),
  reorderWatchlistItemsHandler,
);
router.post(
  '/:watchlistId/items',
  validateId('watchlistId'),
  validateBody(addWatchlistItemSchema),
  addWatchlistItemHandler,
);
router.patch(
  '/:watchlistId/items/:itemId',
  validateId('watchlistId'),
  validateId('itemId'),
  validateBody(updateWatchlistItemSchema),
  updateWatchlistItemHandler,
);
router.delete(
  '/:watchlistId/items/:itemId',
  validateId('watchlistId'),
  validateId('itemId'),
  validateBody(watchlistVersionSchema),
  deleteWatchlistItemHandler,
);
router.post(
  '/:watchlistId/items/:itemId/resolve-split',
  validateId('watchlistId'),
  validateId('itemId'),
  validateBody(resolveWatchlistSplitSchema),
  resolveWatchlistSplitHandler,
);

/** The basket is a READ and records nothing; the snapshot is the write. */
router.get('/:watchlistId/basket', validateId('watchlistId'), readWatchlistBasketHandler);
router.post('/:watchlistId/snapshots', validateId('watchlistId'), recordWatchlistSnapshotHandler);
router.get('/:watchlistId/snapshots', validateId('watchlistId'), listWatchlistSnapshotsHandler);
router.get(
  '/:watchlistId/snapshots/:snapshotId',
  validateId('watchlistId'),
  validateId('snapshotId'),
  readWatchlistSnapshotHandler,
);
router.get(
  '/:watchlistId/snapshots/:snapshotId/diff',
  validateId('watchlistId'),
  validateId('snapshotId'),
  readWatchlistSnapshotDiffHandler,
);

export default router;
