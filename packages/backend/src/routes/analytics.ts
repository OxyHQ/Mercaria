/**
 * `/analytics` — the client ingestion endpoint (#77).
 *
 * ## Why it needs `resolveCommerceActor` and why that is safe here
 *
 * The actor dimension is the point: a funnel that cannot tell a guest from an
 * authenticated buyer cannot answer "authenticated and guest native checkout
 * funnels with the same definitions". `resolveCommerceActor` is the ONE
 * resolver (ADR 0003 D1) and reading `req.commerceActor` is how every other
 * consumer gets it.
 *
 * It is safe on this route specifically because ingestion never MINTS a guest
 * session: issuance is lazy and write-triggered (ADR 0003 T10), and this
 * handler calls neither `issueGuestActor` nor anything that would. A visitor
 * with no credential resolves anonymous and is counted through the
 * client-supplied surface handle instead. So an impression beacon creates no
 * row, which is the anti-farming property T10 exists to protect.
 *
 * ## Rate limited on its own bucket, generously
 *
 * An impression batch is the highest-volume legitimate request this API takes.
 * Metering it on the general budget would make a shopper who scrolls a long
 * results page spend the allowance they need to check out with.
 */

import { Router } from 'express';
import { makeActorRateLimiter } from '../lib/rate-limit.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import { ingestAnalyticsEventsHandler } from '../controllers/analytics-ingest.controller.js';

const router = Router();

// The resolver FIRST, so the actor-aware limiter below buckets a guest per
// SESSION rather than per IP — `lib/rate-limit.ts` states that ordering
// requirement, and a per-IP bucket would make one NAT one shopper.
router.use(resolveCommerceActor);
router.use(
  makeActorRateLimiter('analytics-ingest', {
    // Generous on both branches: a batch carries up to 50 events, so an
    // anonymous shopper scrolling several long results pages in a 15-minute
    // window stays comfortably inside 2,000 requests, and an identified one has
    // the SDK's own default headroom.
    anonymousMax: 2_000,
  }),
);

/**
 * POST /analytics/events — a bounded batch of client-emittable events.
 *
 * Answers 202: the events were accepted into a bounded queue that may drop
 * them. Telling a client they were stored would be the overstatement
 * `POST /reports` refuses one domain over.
 */
router.post('/events', ingestAnalyticsEventsHandler);

export default router;
