import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import storesRouter from './stores.js';

/**
 * Admin API root, mounted at `/admin`.
 *
 * Every admin route requires a real Oxy user (`authenticateToken`) and is
 * metered on the dedicated `'admin'` rate-limit scope. Store-level authorization
 * (the caller's role in the store's owning Oxy account, mapped to permissions)
 * is applied within the `stores` sub-router via `loadStore` +
 * `requireStorePermission`.
 */
const router = Router();

router.use(makeRateLimiter('admin'), authenticateToken);

router.use('/stores', storesRouter);

export default router;
