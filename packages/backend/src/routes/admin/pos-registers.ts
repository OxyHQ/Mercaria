import { Router, type NextFunction, type Request, type Response } from 'express';
import { validateBody, validateId, validateQuery } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { ErrorCodes, sendError } from '../../utils/api-response.js';
import {
  createPosRegisterSchema,
  listPosRegistersQuerySchema,
  posRegisterSummaryQuerySchema,
  updatePosRegisterSchema,
} from '../../middleware/pos-register-schemas.js';
import {
  createPosRegisterHandler,
  listPosRegistersHandler,
  posRegisterSummaryHandler,
  removePosRegisterHandler,
  renamePosRegisterHandler,
} from '../../controllers/admin/pos-registers-admin.controller.js';

/**
 * Named POS registers sub-router, mounted at `/admin/stores/:storeId/pos-registers`
 * (the paid `expanded_pos_registers` tool, #89).
 *
 * `mergeParams` so `:storeId` is visible; the parent has run `authenticateToken`
 * → `loadStore`. Authorization, by who does the job:
 *
 * - LIST: whoever runs the POS (`draft_orders:write`, to pick a register) or
 *   manages locations (`locations:write`).
 * - CREATE / RENAME / REMOVE: `locations:write` — a register is part of how a
 *   location is set up.
 * - SUMMARY: `stats:read`, like every other sales report.
 *
 * Only CREATE is plan-gated (it takes the allowance, in the service). Listing,
 * renaming, removing and the summary stay open whatever the plan, because they
 * read or tidy what the store already has.
 *
 * `/summary` is registered before `/:id` so the literal is not captured.
 */
const router = Router({ mergeParams: true });

/** Either permission is enough: the cashier picking a till, or the manager setting tills up. */
function requireRegisterReader(req: Request, res: Response, next: NextFunction): void {
  const permissions = req.storeAccess?.permissions ?? [];
  if (permissions.includes('draft_orders:write') || permissions.includes('locations:write')) {
    next();
    return;
  }
  sendError(res, ErrorCodes.FORBIDDEN, 'Missing permission: draft_orders:write', 403);
}

const requireManage = requireStorePermission('locations:write');

router.get(
  '/',
  requireRegisterReader,
  validateQuery(listPosRegistersQuerySchema),
  listPosRegistersHandler,
);
router.get(
  '/summary',
  requireStorePermission('stats:read'),
  validateQuery(posRegisterSummaryQuerySchema),
  posRegisterSummaryHandler,
);
router.post('/', requireManage, validateBody(createPosRegisterSchema), createPosRegisterHandler);
router.patch(
  '/:id',
  requireManage,
  validateId('id'),
  validateBody(updatePosRegisterSchema),
  renamePosRegisterHandler,
);
router.delete('/:id', requireManage, validateId('id'), removePosRegisterHandler);

export default router;
