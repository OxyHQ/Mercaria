/**
 * Feedback controller (THIN) — the user's submitted product feedback.
 *
 * Logic lives in `feedback.service`. Every operation is scoped to the
 * authenticated user's Oxy user id: `POST /feedback` submits, `GET /feedback`
 * lists the caller's history (paginated), `GET /feedback/:id` reads one item.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess, sendPaginated } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { routeParam } from '../utils/request.js';
import { create, list, getById, type CreateFeedbackInput } from '../services/feedback.service.js';
import { log } from '../lib/logger.js';

/** POST /feedback — submit a new piece of feedback. */
export async function submitFeedback(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const feedback = await create(oxyUserId, req.body as CreateFeedbackInput);
    sendSuccess(res, feedback, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to submit feedback');
    respondWithError(res, err, 'Failed to submit feedback');
  }
}

/** GET /feedback — the caller's feedback history (newest first, paginated). */
export async function listMyFeedback(req: Request, res: Response): Promise<void> {
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const { page, limit } = parsePagination(req.query);
    const { data, total } = await list(oxyUserId, { page, limit });
    sendPaginated(res, data, buildPagination(page, limit, total));
  } catch (err) {
    log.general.error({ err }, 'Failed to list feedback');
    respondWithError(res, err, 'Failed to load your feedback');
  }
}

/** GET /feedback/:id — a single feedback item owned by the caller. */
export async function getMyFeedback(req: Request, res: Response): Promise<void> {
  const id = routeParam(req, 'id');
  try {
    const oxyUserId = getRequiredOxyUserId(req);
    const feedback = await getById(oxyUserId, id);
    sendSuccess(res, feedback);
  } catch (err) {
    log.general.error({ err, feedbackId: id }, 'Failed to load feedback');
    respondWithError(res, err, 'Failed to load feedback');
  }
}
