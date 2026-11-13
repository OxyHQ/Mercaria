/**
 * `/internal/pickup/*` — the location and collection operator surface (#93).
 *
 * On the SAME `catalog.operate` key
 * #54/#55/#56/#57/#58/#60/#62/#68/#83/#94 use, and NOT a new key: withdrawing a
 * published shop front is a catalogue-moderation power over the same graph, and
 * a new key would be a new thing to keep in step for a separation it does not
 * have. Reading what Mercaria PAYS suppliers is a different power and has its
 * own key; deciding what may be publicly discovered is this one.
 *
 * Mounted on every deployment — 404 to anyone without the key, never a 401 that
 * would advertise the surface — and it stays
 * mounted while `NEARBY_DISCOVERY_ENABLED` is off, because the evidence has to
 * be readable during the incident that turned discovery off.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/operator-authz.js';
import { validateBody, validateId } from '../middleware/validate.js';
import { setPublicationRestrictionSchema } from '../middleware/pickup-schemas.js';
import {
  pickupConsistencyHandler,
  publicationEventsHandler,
  setPublicationRestrictionHandler,
} from '../controllers/pickup-operator.controller.js';

const router = Router();

// Authentication FIRST, then the operator gate — it asks Oxy about the verified
// caller's own session, which only `authenticateToken` establishes.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — the three consistency probes, each a count plus a bounded sample. */
router.get('/consistency', pickupConsistencyHandler);

/** GET — one location's publication and place-link trail, append-only. */
router.get('/publications/:id/events', validateId('id'), publicationEventsHandler);

/** POST — raise or lift an operator restriction. The only write here. */
router.post(
  '/publications/:id/restriction',
  validateId('id'),
  validateBody(setPublicationRestrictionSchema),
  setPublicationRestrictionHandler,
);

export default router;
