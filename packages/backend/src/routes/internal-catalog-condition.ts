/**
 * `/internal/catalog-condition/*` — the condition domain's operator surface
 * (#90).
 *
 * On the SAME allow-list (`CATALOG_OPERATOR_OXY_USER_IDS`) that #54, #55, #56,
 * #57, #58, #83 and #94 use, and for the same reason those share it: deciding
 * what an external source's wording MEANS, and deciding which conditions a
 * category refuses, are the same power over the same graph as reshaping it. A
 * fifth allow-list would be a fifth thing to keep in step for no separation it
 * does not already have.
 *
 * A SEPARATE router rather than routes added to `internal-commerce-graph.ts`,
 * per ADR 0002 D25(a)'s file-ownership protocol.
 *
 * Mount gated on the allow-list being non-empty, so a deployment with no
 * operators 404s rather than 401s — a 401 advertises the surface.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireCatalogOperator } from '../middleware/catalog-operator-authz.js';
import { validateBody } from '../middleware/validate.js';
import {
  conditionCategoryPolicySchema,
  conditionRulesetDraftSchema,
  conditionRulesetMappingsSchema,
  conditionRulesetPublishSchema,
} from '../middleware/condition-schemas.js';
import {
  createConditionRulesetHandler,
  deleteConditionCategoryPolicyHandler,
  getConditionRulesetHandler,
  listConditionCategoryPoliciesHandler,
  listConditionRulesetsHandler,
  publishConditionRulesetHandler,
  putConditionCategoryPolicyHandler,
  putConditionRulesetMappingsHandler,
  traceListingConditionHandler,
} from '../controllers/condition-operator.controller.js';

const router = Router();

// Authentication FIRST, then the allow-list: the gate reads the VERIFIED
// caller, and an allow-list consulted before authentication would compare
// against whatever a client claimed.
router.use(authenticateToken);
router.use(requireCatalogOperator);

/** GET — a provider's ruleset history. Static segment, so it precedes `/:id`. */
router.get('/mapping-rulesets/providers/:provider', listConditionRulesetsHandler);

/** POST — open a DRAFT version. */
router.post(
  '/mapping-rulesets',
  validateBody(conditionRulesetDraftSchema),
  createConditionRulesetHandler,
);

/** GET — one ruleset and its rules, sub-floor ones included. */
router.get('/mapping-rulesets/:id', getConditionRulesetHandler);

/** PUT — replace a DRAFT's rules. A published one is refused, 409. */
router.put(
  '/mapping-rulesets/:id/mappings',
  validateBody(conditionRulesetMappingsSchema),
  putConditionRulesetMappingsHandler,
);

/** POST — publish a draft, superseding the incumbent. Re-reads nothing. */
router.post(
  '/mapping-rulesets/:id/publish',
  validateBody(conditionRulesetPublishSchema),
  publishConditionRulesetHandler,
);

/** PUT — record or correct one category restriction. */
router.put(
  '/category-policies',
  validateBody(conditionCategoryPolicySchema),
  putConditionCategoryPolicyHandler,
);

/** GET — the restrictions on one category. */
router.get('/category-policies/:categoryId', listConditionCategoryPoliciesHandler);

/** DELETE — lift one restriction. */
router.delete('/category-policies/:categoryId/:conditionKey', deleteConditionCategoryPolicyHandler);

/** GET — one listing's condition history (#90 evidence rule 8). */
router.get('/listings/:listingId/history', traceListingConditionHandler);

export default router;
