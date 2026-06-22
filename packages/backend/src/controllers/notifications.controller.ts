/**
 * Notifications controller (THIN).
 *
 * Read/management side of notifications. Logic lives in
 * `notification-read.service`. Every authenticated operation is scoped to the
 * caller's Oxy user id.
 *
 * Response-shape convention: list → `PaginatedResponse` (the separate
 * `GET /unread-count` carries the live count, so it is NOT duplicated on the
 * page); count endpoints → `{ count }`; register endpoints → `{ id }`;
 * action-style endpoints with no resource to echo (read / dismiss / remove)
 * → `{ success: true }`.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import {
  listNotifications as listNotificationsSvc,
  getUnread,
  markRead as markReadSvc,
  markAllRead as markAllReadSvc,
  dismiss as dismissSvc,
  registerPushToken as registerPushTokenSvc,
  removePushToken as removePushTokenSvc,
  registerWebPushSubscription as registerWebPushSubscriptionSvc,
  removeWebPushSubscription as removeWebPushSubscriptionSvc,
} from '../services/notification-read.service.js';
import { VAPID_PUBLIC_KEY } from '../lib/web-push.js';
import { log } from '../lib/logger.js';

/**
 * GET /notifications/vapid-public-key — PUBLIC config probe.
 *
 * Returns the browser-subscription VAPID public key, or 503 when web push is not
 * configured. The client reads `publicKey`, so this keeps a bespoke (non-envelope)
 * shape on purpose — it is a config probe, not a domain resource.
 */
export function getVapidPublicKey(_req: Request, res: Response): void {
  if (!VAPID_PUBLIC_KEY) {
    res.status(503).json({ error: 'Web push not configured' });
    return;
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
}

/** GET /notifications — the caller's notifications (newest first, paginated). */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const { data, total } = await listNotificationsSvc(oxyUserId, { page, limit, status, type });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list notifications');
    respondWithError(res, err, 'Failed to load notifications');
  }
}

/** GET /notifications/unread-count — the caller's live unread count. */
export async function getUnreadCount(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const count = await getUnread(oxyUserId);
    sendSuccess(res, { count });
  } catch (err) {
    log.general.error({ err }, 'Failed to get unread count');
    respondWithError(res, err, 'Failed to get unread count');
  }
}

/** PATCH /notifications/:id/read — mark a single notification read. */
export async function markRead(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await markReadSvc(oxyUserId, id);
    sendSuccess(res, { success: true });
  } catch (err) {
    log.general.error({ err, notificationId: id }, 'Failed to mark notification read');
    respondWithError(res, err, 'Failed to mark as read');
  }
}

/** POST /notifications/read-all — mark all of the caller's notifications read. */
export async function markAllRead(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const count = await markAllReadSvc(oxyUserId);
    sendSuccess(res, { count });
  } catch (err) {
    log.general.error({ err }, 'Failed to mark all notifications read');
    respondWithError(res, err, 'Failed to mark all as read');
  }
}

/** PATCH /notifications/:id/dismiss — dismiss a single notification. */
export async function dismiss(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    await dismissSvc(oxyUserId, id);
    sendSuccess(res, { success: true });
  } catch (err) {
    log.general.error({ err, notificationId: id }, 'Failed to dismiss notification');
    respondWithError(res, err, 'Failed to dismiss notification');
  }
}

/** POST /notifications/push-token — register or reactivate an Expo push token. */
export async function registerPushToken(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const result = await registerPushTokenSvc(
      oxyUserId,
      req.body as { token: string; deviceId?: string; platform?: 'ios' | 'android' | 'web' },
    );
    sendSuccess(res, result, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to register push token');
    respondWithError(res, err, 'Failed to register push token');
  }
}

/** DELETE /notifications/push-token — deactivate an Expo push token. */
export async function removePushToken(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { token } = req.body as { token: string };
    await removePushTokenSvc(oxyUserId, token);
    sendSuccess(res, { success: true });
  } catch (err) {
    log.general.error({ err }, 'Failed to deactivate push token');
    respondWithError(res, err, 'Failed to deactivate push token');
  }
}

/** POST /notifications/web-push-subscription — register or reactivate a subscription. */
export async function registerWebPushSubscription(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const result = await registerWebPushSubscriptionSvc(
      oxyUserId,
      req.body as { endpoint: string; keys: { p256dh: string; auth: string } },
    );
    sendSuccess(res, result, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to register web push subscription');
    respondWithError(res, err, 'Failed to register web push subscription');
  }
}

/** DELETE /notifications/web-push-subscription — deactivate a subscription. */
export async function removeWebPushSubscription(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { endpoint } = req.body as { endpoint: string };
    await removeWebPushSubscriptionSvc(oxyUserId, endpoint);
    sendSuccess(res, { success: true });
  } catch (err) {
    log.general.error({ err }, 'Failed to deactivate web push subscription');
    respondWithError(res, err, 'Failed to deactivate web push subscription');
  }
}
