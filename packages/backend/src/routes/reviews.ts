import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { createReviewSchema } from '../middleware/schemas.js';
import {
  createReviewHandler,
  listMerchantReviews,
  listMyReviewEligibilities,
  listOrderReviewEligibilities,
  listProductReviews,
} from '../controllers/reviews.controller.js';

/**
 * Reviews API (#76).
 *
 * ## Two halves, split by whether authorship matters
 *
 * The PUBLIC reads — a canonical product's reviews and a merchant's reviews —
 * are mounted before `authenticateToken`, because a product page is a product
 * page whether or not anybody is signed in, and requiring a session to read a
 * rating would make the whole scoped model invisible to a first-time visitor.
 * They return the scoped aggregate ALONGSIDE the page, so the stars a page shows
 * and the reviews it lists come from one read (#75 will mirror exactly that
 * aggregate in structured data).
 *
 * Everything after `router.use(authenticateToken)` is about a specific person:
 * writing a review, and asking what one is entitled to review. `GET
 * /reviews/eligibilities` is what turns order history into "you can rate this"
 * without the client having to guess — and it exposes verification STATUS only,
 * never the contact or payment identifiers #76 privacy rule 3 keeps out.
 *
 * The other public reads live on their own routers, unchanged through the
 * compatibility window: `GET /listings/:id/reviews`, `GET /stores/:handle/reviews`.
 */
const router = Router();

router.get('/product/:canonicalProductId', listProductReviews);
router.get('/merchant/:merchantId', listMerchantReviews);

router.use(authenticateToken);

router.get('/eligibilities', listMyReviewEligibilities);
router.get('/eligibilities/order/:orderId', listOrderReviewEligibilities);

router.post('/', makeRateLimiter('reviews'), validateBody(createReviewSchema), createReviewHandler);

export default router;
