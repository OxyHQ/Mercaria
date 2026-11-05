/**
 * `/legal/*` — documents a merchant agrees to, served by the API that records
 * the agreement.
 *
 * `GET /legal/merchant-plan-terms/:version` answers the exact text of one
 * VERSION of the Mercaria Merchant Plan Terms
 * (`services/billing/terms/merchant-plan-terms.ts`) — the version a plan names
 * and an acceptance records — so the page a merchant read and the version on
 * their subscription are one fact. Public and unauthenticated: terms are read
 * before anyone agrees to anything. Cacheable for a long time, because a
 * version never changes.
 */

import { Router } from 'express';
import {
  CURRENT_MERCHANT_PLAN_TERMS_VERSION,
  findMerchantPlanTerms,
  renderMerchantPlanTermsHtml,
} from '../services/billing/terms/merchant-plan-terms.js';

const router = Router();

/** The current version, by redirect, so a stable link always reads the newest. */
router.get('/merchant-plan-terms', (_req, res) => {
  res.redirect(302, `/legal/merchant-plan-terms/${CURRENT_MERCHANT_PLAN_TERMS_VERSION}`);
});

router.get('/merchant-plan-terms/:version', (req, res) => {
  const terms = findMerchantPlanTerms(req.params.version);
  if (!terms) {
    res.status(404).type('text/plain').send('No such version of the Mercaria Merchant Plan Terms.');
    return;
  }
  res
    .status(200)
    .set('Cache-Control', 'public, max-age=86400, immutable')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .type('html')
    .send(renderMerchantPlanTermsHtml(terms));
});

export default router;
