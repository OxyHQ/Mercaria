import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { inviteMemberSchema, updateMemberSchema } from '../../middleware/schemas.js';
import {
  listMembers,
  addMember,
  patchMember,
  deleteMember,
} from '../../controllers/admin/members.controller.js';

/**
 * Store members sub-router, mounted at `/admin/stores/:storeId/members`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router has already run
 * `authenticateToken` → `loadStore`, so `req.store`/`req.storeMembership` are
 * set. Member management requires the `members:manage` permission; owner-
 * protection invariants are enforced in `store.service`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('members:manage'), listMembers);
router.post('/', requireStorePermission('members:manage'), validateBody(inviteMemberSchema), addMember);
router.patch(
  '/:oxyUserId',
  requireStorePermission('members:manage'),
  validateBody(updateMemberSchema),
  patchMember,
);
router.delete('/:oxyUserId', requireStorePermission('members:manage'), deleteMember);

export default router;
