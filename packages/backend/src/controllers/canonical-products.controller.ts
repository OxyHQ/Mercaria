/**
 * Canonical product/family controller (THIN) — public reads over the canonical
 * product layer (#56 API rules 1–2).
 *
 * Every handler delegates policy — tombstone redirects, identifier conflicts,
 * alias ambiguity — to `services/canonical/`. Nothing here decides anything a
 * service could disagree with, and nothing here can widen the projection: the
 * DTOs the services return carry no source ids, link confidences, match rules or
 * pinned fields, so a serializer cannot leak what the type does not hold.
 */

import type { Request, Response } from 'express';
import type { IdentifierScheme } from '@mercaria/shared-types';
import {
  findCanonicalProductByIdentifier,
  findCanonicalProductIdsBySourceObject,
  getPublicCanonicalProduct,
  getVariantOptionAssignments,
  resolveCanonicalProductByAlias,
} from '../services/canonical/canonical-product.service.js';
import { getPublicProductFamily } from '../services/canonical/product-family.service.js';
import { listVariants } from '../services/canonical/canonical-variant.service.js';
import { listVariantIdentifiers } from '../services/canonical/product-identifier.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * GET /canonical-products/lookup?scheme=&identifier= | ?alias= | ?sourceId=&externalId=
 *
 * The identifier arm answers `conflict` as a RESULT rather than an error: an
 * identifier under dispute has an owner and a contest, and a caller that cannot
 * tell that apart from a clean resolution would attach an offer to a product
 * nobody has confirmed (#56 acceptance 3).
 */
export async function lookupCanonicalProducts(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as {
      scheme?: IdentifierScheme;
      identifier?: string;
      alias?: string;
      sourceId?: string;
      externalId?: string;
    };

    if (query.scheme !== undefined && query.identifier !== undefined) {
      const found = await findCanonicalProductByIdentifier(query.scheme, query.identifier);
      if (found === undefined) {
        sendSuccess(res, { kind: 'none' });
        return;
      }
      if ('conflictOwnerId' in found) {
        sendSuccess(res, {
          kind: 'conflict',
          ownerId: found.conflictOwnerId,
          disputedIds: found.disputedIds,
        });
        return;
      }
      sendSuccess(res, { kind: 'resolved', productId: found.productId });
      return;
    }

    if (query.alias !== undefined) {
      sendSuccess(res, await resolveCanonicalProductByAlias(query.alias));
      return;
    }

    // The schema guarantees exactly one criterion, so this is the source arm.
    const ids = await findCanonicalProductIdsBySourceObject(
      query.sourceId ?? '',
      query.externalId ?? '',
    );
    sendSuccess(res, { kind: ids.length === 0 ? 'none' : 'resolved', productIds: ids });
  } catch (error) {
    respondWithError(res, error, 'Canonical product lookup failed');
  }
}

/** GET /canonical-products/:idOrSlug — the public projection; tombstones redirect. */
export async function getCanonicalProduct(req: Request, res: Response): Promise<void> {
  try {
    const product = await getPublicCanonicalProduct(routeParam(req, 'idOrSlug'));
    if (!product) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Canonical product not found', 404);
      return;
    }
    sendSuccess(res, product);
  } catch (error) {
    respondWithError(res, error, 'Canonical product read failed');
  }
}

/**
 * GET /canonical-products/:idOrSlug/variants — the reverse lookup a product page
 * reads (#56 API rule 2).
 *
 * Merge tombstones are filtered OUT of the list while remaining resolvable by
 * id: a variant page must still answer for an old link, and a product page must
 * not show the same configuration twice.
 */
export async function listCanonicalProductVariants(req: Request, res: Response): Promise<void> {
  try {
    const product = await getPublicCanonicalProduct(routeParam(req, 'idOrSlug'));
    if (!product) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Canonical product not found', 404);
      return;
    }
    const variants = await listVariants(product.id);
    const payload = [];
    for (const variant of variants) {
      if (variant.status === 'merged') continue;
      const identifiers = await listVariantIdentifiers(variant.id);
      payload.push({
        id: variant.id,
        name: variant.name,
        signature: variant.signature,
        isDefault: variant.isDefault,
        status: variant.status,
        options: await getVariantOptionAssignments(variant.id),
        identifiers: identifiers
          .filter((identifier) => identifier.status === 'active')
          .map((identifier) => ({
            scheme: identifier.scheme,
            rawValue: identifier.rawValue,
            canonicalValue: identifier.canonicalValue,
          })),
      });
    }
    sendSuccess(res, payload);
  } catch (error) {
    respondWithError(res, error, 'Canonical variant read failed');
  }
}

/** GET /product-families/:idOrSlug — the public projection; tombstones redirect. */
export async function getProductFamily(req: Request, res: Response): Promise<void> {
  try {
    const family = await getPublicProductFamily(routeParam(req, 'idOrSlug'));
    if (!family) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Product family not found', 404);
      return;
    }
    sendSuccess(res, family);
  } catch (error) {
    respondWithError(res, error, 'Product family read failed');
  }
}
