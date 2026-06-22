import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import storesRouter from './stores.js';

/**
 * Admin API root, mounted at `/admin`.
 *
 * Every admin route requires a real Oxy user (`authenticateToken`) and is
 * metered on the dedicated `'admin'` rate-limit scope. Store-level authorization
 * (membership + role/permission) is applied within the `stores` sub-router via
 * `loadStore` + `requireStoreRole`/`requireStorePermission`.
 */
const router = Router();

router.use(makeRateLimiter('admin'), authenticateToken);

router.use('/stores', storesRouter);

export default router;
