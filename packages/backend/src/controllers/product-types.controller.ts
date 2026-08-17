/**
 * Product-type controller (THIN) — the public specification layout (#367 step 3).
 *
 * One handler. The grouping rule, including its refusal to place an attribute two
 * authoring flows disagree about, is `deriveSpecificationLayout` in
 * `services/product-types/product-type.service.ts` and is pure. Nothing here
 * groups, orders or resolves anything: a controller that arranged the table would
 * be a second layout authority, and the one it would disagree with is the one an
 * operator published.
 */

import type { Request, Response } from 'express';
import { getDb } from '../db/postgres.js';
import { readPublicSpecificationLayout } from '../services/product-types/product-type.service.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * `GET /product-types/:key/specification-layout`.
 *
 * 404 covers three states on purpose — no such product type, one whose only
 * versions are drafts, and one whose published version was deprecated without a
 * replacement. All three mean "there is no published grouping for this key", and
 * distinguishing them would report the existence of unpublished catalogue work to
 * anybody who can guess a key.
 */
export async function productTypeSpecificationLayoutHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const layout = await readPublicSpecificationLayout(getDb(), routeParam(req, 'key'));
    if (layout === null) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No published specification layout for this product type', 404);
      return;
    }
    sendSuccess(res, layout);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read a specification layout');
  }
}
