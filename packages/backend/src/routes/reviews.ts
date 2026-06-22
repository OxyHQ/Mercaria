import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { createReviewSchema } from '../middleware/schemas.js';
import { createReviewHandler } from '../controllers/reviews.controller.js';

/**
 * Reviews API — write a verified-purchase review.
 *
 * `POST /reviews` requires authentication and gates on a qualifying prior order
 * in the service layer. Metered on the dedicated `'reviews'` scope. The public
 * READ endpoints live on the listings + stores routers
 * (`GET /listings/:id/reviews`, `GET /stores/:handle/reviews`).
 */
const router = Router();

router.use(authenticateToken);

router.post('/', makeRateLimiter('reviews'), validateBody(createReviewSchema), createReviewHandler);

export default router;
