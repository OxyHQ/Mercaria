/**
 * Merchants controller (THIN) — public reads over the canonical graph (#54).
 *
 * Every handler delegates policy (tombstone redirects, suppression, domain
 * normalization) to `services/commerce-graph/merchant.service.ts`; nothing
 * here decides anything a service could disagree with.
 */

import type { Request, Response } from 'express';
import {
  getMerchantPublic,
  getNativeCheckoutEligibility,
  lookupMerchantsByAlias,
  lookupMerchantsByDomain,
} from '../services/commerce-graph/merchant.service.js';
import { findMerchantForNativeStore } from '../services/commerce-graph/native-store-link.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** GET /merchants/lookup?domain=|alias= — resolver reads (issue API rule 1). */
export async function lookupMerchants(req: Request, res: Response): Promise<void> {
  try {
    const { domain, alias } = req.query as { domain?: string; alias?: string };
    if (domain !== undefined) {
      sendSuccess(res, await lookupMerchantsByDomain(domain));
      return;
    }
    // The schema guarantees exactly one criterion, so this is the alias arm.
    sendSuccess(res, await lookupMerchantsByAlias(alias ?? ''));
  } catch (error) {
    respondWithError(res, error, 'Merchant lookup failed');
  }
}

/** GET /merchants/by-native-store/:storeId — reverse lookup (issue API rule 3). */
export async function getMerchantByNativeStore(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await findMerchantForNativeStore(routeParam(req, 'storeId')));
  } catch (error) {
    respondWithError(res, error, 'Native store lookup failed');
  }
}

/** GET /merchants/:idOrSlug — the public profile, redirecting tombstones. */
export async function getMerchant(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getMerchantPublic(routeParam(req, 'idOrSlug')));
  } catch (error) {
    respondWithError(res, error, 'Merchant read failed');
  }
}

/**
 * GET /merchants/:idOrSlug/native-checkout-eligibility — the DERIVED verdict
 * (issue requirement 7). Answered for the resolved merchant id only; the
 * profile read is how a slug resolves first.
 */
export async function getMerchantCheckoutEligibility(req: Request, res: Response): Promise<void> {
  try {
    const profile = await getMerchantPublic(routeParam(req, 'idOrSlug'));
    sendSuccess(res, await getNativeCheckoutEligibility(profile.merchant.id));
  } catch (error) {
    respondWithError(res, error, 'Eligibility read failed');
  }
}
