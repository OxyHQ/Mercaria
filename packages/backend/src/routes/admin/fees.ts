import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { acceptFeeScheduleSchema, feePreviewSchema } from '../../middleware/fees-schemas.js';
import {
  acceptStoreFeeScheduleHandler,
  getStoreFeeScheduleHandler,
  previewStoreFeeHandler,
} from '../../controllers/fees.controller.js';

/**
 * A store's marketplace fee surface (#88), mounted at
 * `/admin/stores/:storeId/fees`.
 *
 * Authentication and store membership are already established by the parent
 * (`admin/index.ts` runs `authenticateToken`, `admin/stores.ts` runs
 * `loadStore`), so this router only adds the permission.
 *
 * ## `store:manage` on all three, like payment onboarding and for its reason
 *
 * The schedule read, the terms acceptance and the preview are one conversation
 * — "what will Mercaria charge this store, and do we agree" — and that is the
 * owner's conversation. `settings:write` would hand the acceptance (a binding
 * commercial consent) to `admin` and `staff`; `store:manage` is the one
 * permission an `admin` does not hold. The read and preview follow the
 * acceptance rather than getting a looser gate of their own, because a screen
 * that can show the terms but not accept them would be built against a
 * permission split this API then could not change without breaking it.
 */
const router = Router({ mergeParams: true });

router.get('/schedule', requireStorePermission('store:manage'), getStoreFeeScheduleHandler);

router.post(
  '/accept',
  requireStorePermission('store:manage'),
  validateBody(acceptFeeScheduleSchema),
  acceptStoreFeeScheduleHandler,
);

router.post(
  '/preview',
  requireStorePermission('store:manage'),
  validateBody(feePreviewSchema),
  previewStoreFeeHandler,
);

export default router;
