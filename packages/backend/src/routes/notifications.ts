import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { validateBody, validateQuery, validateId } from '../middleware/validate.js';
import {
  notificationListQuerySchema,
  pushTokenSchema,
  pushTokenDeleteSchema,
  webPushSubscriptionSchema,
  webPushSubscriptionDeleteSchema,
} from '../middleware/schemas.js';
import {
  getVapidPublicKey,
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  dismiss,
  registerPushToken,
  removePushToken,
  registerWebPushSubscription,
  removeWebPushSubscription,
} from '../controllers/notifications.controller.js';

/**
 * Notifications API — the authenticated user's in-app notifications plus their
 * push-delivery registrations.
 *
 * `GET /notifications/vapid-public-key` is PUBLIC (a web-push config probe) and
 * is mounted BEFORE `authenticateToken`. Everything else requires a real Oxy
 * user: `GET /` lists (paginated), `GET /unread-count` returns the count,
 * `PATCH /:id/read` + `POST /read-all` + `PATCH /:id/dismiss` drive read state,
 * and the push-token / web-push-subscription routes manage delivery targets.
 * Metered on the `'general'` scope.
 */
const router = Router();

// Public web-push config probe (no auth).
router.get('/vapid-public-key', getVapidPublicKey);

router.use(authenticateToken);

// Notification feed + read state (static routes first, then param routes).
router.get('/', validateQuery(notificationListQuerySchema), listNotifications);
router.get('/unread-count', getUnreadCount);
router.post('/read-all', markAllRead);
router.patch('/:id/read', validateId('id'), markRead);
router.patch('/:id/dismiss', validateId('id'), dismiss);

// Expo push-token management.
router.post('/push-token', validateBody(pushTokenSchema), registerPushToken);
router.delete('/push-token', validateBody(pushTokenDeleteSchema), removePushToken);

// Web-push subscription management.
router.post(
  '/web-push-subscription',
  validateBody(webPushSubscriptionSchema),
  registerWebPushSubscription,
);
router.delete(
  '/web-push-subscription',
  validateBody(webPushSubscriptionDeleteSchema),
  removeWebPushSubscription,
);

export default router;
