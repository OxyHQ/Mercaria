/**
 * Abuse reports — `POST /reports`.
 *
 * NOT to be confused with the store SALES ANALYTICS at
 * `/admin/stores/:storeId/reports/*` (`report.service.ts`). Same English word,
 * unrelated domains: this one is a shopper telling us something in the
 * marketplace is wrong.
 *
 * ## What a 201 means, and what it does not
 *
 * It means the report and — when the reported type has a route out — its delivery
 * row committed together, atomically. It does NOT mean CrowdSource accepted
 * anything: no outbound request is made in this handler at all. CrowdSource may
 * be unreachable, mid-deploy or switched off, and the reporter is told their
 * report was received either way, because it was.
 *
 * The response deliberately does not tell the client whether the report will be
 * reviewed. A reporter who learns that this noun is not wired to a jury learns
 * something about what is and is not watched, which is an invitation to route
 * around it. Operators get that from `localStatus`; shoppers get a receipt.
 */

import { Router, type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody } from '../middleware/validate.js';
import { abuseReportSchema } from '../middleware/schemas.js';
import { createAbuseReport } from '../services/moderation/report-intake.service.js';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { isMercariaError, respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type {
  AbuseReportCategory,
  AbuseReportedType,
} from '@mercaria/shared-types';

const router = Router();

router.use(authenticateToken);

router.post(
  '/',
  makeRateLimiter('reports'),
  validateBody(abuseReportSchema),
  async (req: Request, res: Response): Promise<void> => {
    /**
     * The reporter is the authenticated caller, full stop.
     *
     * Never `req.body.reporterOxyUserId` — the schema does not accept one, and
     * this is the reason. A client-supplied reporter is an attribution forgery:
     * it would let anyone file reports in someone else's name, poisoning both the
     * duplicate check and the reputation accounting a jury's decision feeds.
     */
    const reporterOxyUserId = req.userId;
    if (reporterOxyUserId === undefined) {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const body = req.body as {
      reportedType: AbuseReportedType;
      reportedId: string;
      categories: AbuseReportCategory[];
      details?: string;
    };

    try {
      const result = await createAbuseReport({
        reporterOxyUserId,
        reportedType: body.reportedType,
        reportedId: body.reportedId,
        categories: body.categories,
        ...(body.details === undefined ? {} : { details: body.details }),
      });

      sendSuccess(
        res,
        {
          // The row id verbatim — a 24-hex ObjectId for a pre-cutover report, a
          // uuid v7 for a newer one. Both are opaque to the client, which only
          // ever echoes it back.
          id: result.report.id,
          reportedType: result.report.reportedType,
          reportedId: result.report.reportedId,
          createdAt: result.report.createdAt,
        },
        201,
      );
    } catch (error: unknown) {
      if (!isMercariaError(error)) {
        log.moderation.error({ err: error }, '[Moderation] report intake failed');
      }
      respondWithError(res, error, 'Could not submit the report');
    }
  },
);

export default router;
