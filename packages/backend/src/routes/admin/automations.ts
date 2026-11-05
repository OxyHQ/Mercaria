import { Router } from 'express';
import { validateBody, validateId, validateQuery } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  createAutomationRuleSchema,
  listAutomationRunsQuerySchema,
  updateAutomationRuleSchema,
} from '../../middleware/automation-rules-schemas.js';
import {
  createAutomationRule,
  deleteAutomationRule,
  getAutomationRule,
  listAutomationRuleRuns,
  listAutomationRules,
  patchAutomationRule,
} from '../../controllers/admin/automation-rules-admin.controller.js';

/**
 * A store's automation rules (#89, `automation_rules`), mounted at
 * `/admin/stores/:storeId/automations`. The parent has run `authenticateToken`
 * and `loadStore`, so this router adds only the permission.
 *
 * Reads are `products:read`; writes are `products:write`, because what a rule
 * does is catalogue work (pause and republish a listing) or a notification. A
 * rule that moves an ORDER also needs `orders:fulfill`, checked by the service
 * against the rule's action — so a member cannot write a rule that does what
 * they could not do by hand.
 *
 * Nothing here is gated by the PLAN at the mount: listing, reading and deleting
 * one's own rules are never refused (#89), and the service decides the rest.
 * `/runs` is declared before `/:id` so it is never read as an id.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('products:read'), listAutomationRules);
router.get(
  '/runs',
  requireStorePermission('products:read'),
  validateQuery(listAutomationRunsQuerySchema),
  listAutomationRuleRuns,
);
router.post(
  '/',
  requireStorePermission('products:write'),
  validateBody(createAutomationRuleSchema),
  createAutomationRule,
);
router.get('/:id', requireStorePermission('products:read'), validateId('id'), getAutomationRule);
router.patch(
  '/:id',
  requireStorePermission('products:write'),
  validateId('id'),
  validateBody(updateAutomationRuleSchema),
  patchAutomationRule,
);
router.delete(
  '/:id',
  requireStorePermission('products:write'),
  validateId('id'),
  deleteAutomationRule,
);

export default router;
