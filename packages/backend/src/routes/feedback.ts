import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateObjectId } from '../middleware/validate.js';
import { feedbackSchema } from '../middleware/schemas.js';
import {
  submitFeedback,
  listMyFeedback,
  getMyFeedback,
} from '../controllers/feedback.controller.js';

/**
 * Feedback API — the authenticated user's submitted product feedback.
 *
 * `POST /feedback` submits; `GET /feedback` lists the caller's history
 * (paginated); `GET /feedback/:id` reads a single item. Ownership is enforced in
 * `feedback.service` (every query is scoped to the caller's Oxy user id).
 * Metered on the dedicated `'feedback'` scope.
 */
const router = Router();

router.use(authenticateToken);

router.post('/', makeRateLimiter('feedback'), validateBody(feedbackSchema), submitFeedback);
router.get('/', makeRateLimiter('feedback'), listMyFeedback);
router.get('/:id', makeRateLimiter('feedback'), validateObjectId('id'), getMyFeedback);

export default router;
