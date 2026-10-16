import { Router } from 'express';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { CATALOG_SAFETY_REVIEW_DECISIONS } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { listings } from '../db/schema/catalog.js';
import { authenticateToken } from '../middleware/auth.js';
import { catalogOperatorId, requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody, validateId } from '../middleware/validate.js';
import {
  readCatalogReviewCandidates,
  recordCatalogSafetyReview,
} from '../services/supervised-shopping/catalog-review.service.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';

const router = Router();
router.use(authenticateToken, requireCatalogOperator);
router.get('/access', (_req, res) => sendSuccess(res, { allowed: true }));

router.get('/', async (req, res) => {
  try {
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 128)) {
      throw validationError('Invalid review cursor.');
    }
    const rows = await getDb()
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.status, 'active'),
          typeof cursor === 'string' ? gt(listings.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(listings.id))
      .limit(51);
    sendSuccess(res, {
      items: await readCatalogReviewCandidates(rows.slice(0, 50).map(({ id }) => id)),
      nextCursor: rows.length > 50 ? rows[49].id : null,
    });
  } catch (error) {
    respondWithError(res, error, 'Could not load items for review.');
  }
});

router.get('/:listingId', validateId('listingId'), async (req, res) => {
  try {
    const [candidate] = await readCatalogReviewCandidates([routeParam(req, 'listingId')]);
    if (!candidate) throw notFound('Item not found.');
    sendSuccess(res, candidate);
  } catch (error) {
    respondWithError(res, error, 'Could not load this item for review.');
  }
});

router.post(
  '/:listingId/reviews',
  validateId('listingId'),
  validateBody(
    z
      .object({
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(CATALOG_SAFETY_REVIEW_DECISIONS),
      })
      .strict(),
  ),
  async (req, res) => {
    try {
      sendSuccess(
        res,
        await recordCatalogSafetyReview({
          listingId: routeParam(req, 'listingId'),
          contentDigest: req.body.contentDigest,
          decision: req.body.decision,
          reviewerOxyUserId: catalogOperatorId(req),
        }),
      );
    } catch (error) {
      respondWithError(res, error, 'Could not save this review.');
    }
  },
);

export default router;
