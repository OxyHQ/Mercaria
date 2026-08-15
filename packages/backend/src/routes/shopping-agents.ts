/**
 * `/shopping-agents` — a shopper's own saved objectives (#97).
 *
 * Mounted only when `SHOPPING_AGENTS_ENABLED`, so a deployment that has not
 * adopted #97 answers 404. The AGENTS themselves are never gated by anything: a
 * row already stored stays stored, keeps being evaluated and comes back when
 * the flag does — a flag that hid a person's agents would make the rollback
 * lever cost them the thing they were waiting for.
 *
 * ## The route set is CLOSED, and the omissions are the design
 *
 * There is no route that buys, adds to a cart, opens a checkout, contacts a
 * merchant or accepts terms — #97 acceptance 9 is that absence. There is also
 * no route that sets a finding's outcome, edits a finding, or marks one
 * notified: a finding is an appended observation and a notification is a
 * durable job, and a surface that could set either would be a way to make the
 * timeline say something nobody observed.
 *
 * Metered on the `'listings'` scope, #79's reasoning exactly: every route here
 * is keyed on the caller's own agent id or on a CATALOGUE id rather than on an
 * Oxy account id, so enumeration is not the risk that earned `'sellers'` its own
 * bucket. The two axes that ARE this domain's own — how many agents an account
 * may hold and how fast it may create them — are counted in Postgres, because
 * "across every ECS task" is not a question a per-IP bucket can answer.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateId, validateQuery } from '../middleware/validate.js';
import {
  createShoppingAgentSchema,
  listShoppingAgentFindingsQuerySchema,
  listShoppingAgentsQuerySchema,
  resolveShoppingAgentSplitSchema,
  updateShoppingAgentSchema,
} from '../middleware/shopping-agent-schemas.js';
import {
  createShoppingAgentHandler,
  deleteShoppingAgentHandler,
  getShoppingAgentHandler,
  listShoppingAgentFindingsHandler,
  listShoppingAgentsHandler,
  refuseForbiddenAgentActionMiddleware,
  resolveShoppingAgentSplitHandler,
  runShoppingAgentHandler,
  updateShoppingAgentHandler,
} from '../controllers/shopping-agents.controller.js';

const router = Router();

router.use(authenticateToken);
router.use(makeRateLimiter('listings'));

router.get('/', validateQuery(listShoppingAgentsQuerySchema), listShoppingAgentsHandler);

/**
 * The forbidden-action refusal is mounted BEFORE the schema, deliberately.
 *
 * A `.strict()` schema answers "Unrecognized key: purchase", which is true and
 * useless; this answers with the exact prohibition it found. #121's
 * `forbidden-evidence.ts` device, and the difference between a client author
 * reading "we do not support that field" and reading "this system does not do
 * that".
 */
router.post(
  '/',
  refuseForbiddenAgentActionMiddleware,
  validateBody(createShoppingAgentSchema),
  createShoppingAgentHandler,
);

router.get('/:agentId', validateId('agentId'), getShoppingAgentHandler);

router.patch(
  '/:agentId',
  validateId('agentId'),
  refuseForbiddenAgentActionMiddleware,
  validateBody(updateShoppingAgentSchema),
  updateShoppingAgentHandler,
);

router.delete('/:agentId', validateId('agentId'), deleteShoppingAgentHandler);

/** POST — ask for one more evaluation now (#97 UX 5). Returns 202: a request. */
router.post('/:agentId/run', validateId('agentId'), runShoppingAgentHandler);

/** POST — answer the question a catalogue split asked (#97 evaluation 8). */
router.post(
  '/:agentId/resolve-split',
  validateId('agentId'),
  validateBody(resolveShoppingAgentSplitSchema),
  resolveShoppingAgentSplitHandler,
);

/** GET — the timeline, including the findings that did NOT qualify (#97 UX 3). */
router.get(
  '/:agentId/findings',
  validateId('agentId'),
  validateQuery(listShoppingAgentFindingsQuerySchema),
  listShoppingAgentFindingsHandler,
);

export default router;
