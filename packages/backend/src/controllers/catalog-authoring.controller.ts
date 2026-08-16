/**
 * The catalog authoring HTTP surface (#367 step 5, ADR 0007 D10).
 *
 * Thin, like every controller here: it reads the request, calls one service and
 * shapes the response. The two things it owns that a service cannot are the
 * ETag exchange and the permission PROJECTION — and the second is worth reading
 * carefully, because it is where a client could otherwise be trusted.
 *
 * ## Permissions are DERIVED from the membership, never from the body
 *
 * `authoringPermissions(req)` reads `req.storeMembership`, which `loadStore` put
 * there and `requireStorePermission` already gated. The projection travels in
 * the schema so a form can grey out a control, and the server re-checks every
 * one of them on the write — a boolean sent to a client is a boolean a client
 * can send back, and none of these is ever read off a body.
 *
 * ## Validation findings are the SAME shape at validate and at publish
 *
 * A refused publish answers 422 carrying the identical
 * `AuthoringValidationResult` the `validate` route returns. A client renders one
 * list, and an author sees one experience of one rule rather than two.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { AuthoringPermissionContext, ProductTypeAuthoringFlow } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getDb } from '../db/postgres.js';
import { log } from '../lib/logger.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { effectivePermissions } from '../middleware/store-authz.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';
import { authoringEtagMatches } from '../services/catalog-authoring/etag.js';
import {
  composeAuthoringSchema,
  listAuthoringCategories,
  listAuthoringProductTypes,
} from '../services/catalog-authoring/schema.service.js';
import { searchCanonicalEntities } from '../services/catalog-authoring/canonical-search.service.js';
import {
  applyDraftUpgrade,
  createDraft,
  discardStoreDraft,
  listStoreDrafts,
  patchDraft,
  previewDraftUpgrade,
  readDraft,
  validateStoreDraft,
  type DraftFieldInput,
  type DraftVariantInput,
} from '../services/catalog-authoring/draft.service.js';
import { publishDraft } from '../services/catalog-authoring/publish.service.js';

/**
 * The flow a store member authors in.
 *
 * `merchant` and nothing else on this surface. `p2p` is a person's own flow,
 * `operator` and `verified_brand` are powers a store membership does not grant,
 * and `connector` is a machine replaying somebody else's feed. A `flow` query
 * parameter is accepted and NARROWED here rather than trusted, so a client
 * cannot ask for the operator form by typing a word.
 */
const STORE_AUTHORING_FLOW: ProductTypeAuthoringFlow = 'merchant';

function requestedFlow(raw: unknown): ProductTypeAuthoringFlow {
  return raw === 'p2p' ? 'p2p' : STORE_AUTHORING_FLOW;
}

/**
 * What this caller may do, derived from the membership `loadStore` resolved.
 *
 * `products:write` is the create/edit permission the existing product routes
 * use, and this surface deliberately reuses it rather than inventing one: a
 * permission string that is not in `STORE_PERMISSIONS` is refused by
 * `store_members_permissions_check` at the row, and a merchant authoring a
 * product is doing exactly what that permission names.
 *
 * `canProposeValues` is FALSE in every branch today. ADR 0007 D9's proposals are
 * #367 merge-order step 6; reporting `true` would tell a client a control exists
 * that no endpoint backs, which is worse than the control being absent.
 */
function authoringPermissions(req: Request): AuthoringPermissionContext {
  const membership = req.storeMembership;
  const granted = membership === undefined ? new Set<string>() : effectivePermissions(membership);
  const canWrite = granted.has('products:write');
  return {
    canEditDraft: canWrite,
    canPublish: canWrite,
    canProposeValues: false,
    canSelectCanonicalEntity: canWrite,
  };
}

/** The locale a read resolves in, from the query and never from a header. */
function requestedLocale(raw: unknown): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : 'en';
}

/* -------------------------------------------------------------------------- */
/* The public authoring surface                                                */
/* -------------------------------------------------------------------------- */

/** `GET /catalog-authoring/categories`. */
export async function authoringCategoriesHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      parentId?: string;
      roots?: string;
      locale?: string;
      limit?: number;
    };
    const categories = await listAuthoringCategories(getDb(), {
      // `roots=true` is how a client asks for the top level, because a query
      // string cannot carry a null and an ABSENT `parentId` already means "the
      // whole selectable set".
      ...(query.roots === 'true'
        ? { parentId: null }
        : query.parentId === undefined
          ? {}
          : { parentId: query.parentId }),
      requestedLocale: requestedLocale(query.locale),
      limit: query.limit ?? config.catalogAuthoring.categoryPageSize,
    });
    sendSuccess(res, { categories });
  } catch (err) {
    log.general.error({ err }, 'Failed to list authoring categories');
    respondWithError(res, err, 'Failed to list categories');
  }
}

/** `GET /catalog-authoring/product-types?categoryId=`. */
export async function authoringProductTypesHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as { categoryId: string; locale?: string };
    const productTypes = await listAuthoringProductTypes(getDb(), {
      categoryId: query.categoryId,
      requestedLocale: requestedLocale(query.locale),
    });
    sendSuccess(res, { productTypes });
  } catch (err) {
    log.general.error({ err }, 'Failed to list authoring product types');
    respondWithError(res, err, 'Failed to list product types');
  }
}

/**
 * `GET /catalog-authoring/schemas/:productTypeKey`.
 *
 * The ETag exchange lives here rather than in the service, because a service
 * that answered 304 would have to know about HTTP — and because the SAME
 * composition is what a draft, a validation and a publish read, none of which
 * has an `If-None-Match` to compare.
 */
export async function authoringSchemaHandler(req: Request, res: Response): Promise<void> {
  const productTypeKey = routeParam(req, 'productTypeKey');
  try {
    const query = req.query as unknown as {
      categoryId: string;
      version?: number;
      flow?: string;
      locale?: string;
      market: string;
    };
    const composition = await composeAuthoringSchema(getDb(), {
      productTypeKey,
      ...(query.version === undefined ? {} : { version: query.version }),
      categoryId: query.categoryId,
      flow: requestedFlow(query.flow),
      requestedLocale: requestedLocale(query.locale),
      market: query.market,
      permissions: authoringPermissions(req),
    });
    if (composition.outcome !== 'composed') {
      // The refusal CODE, not a sentence a client matches on. The detail is the
      // human half and the code is what a surface branches on.
      res
        .status(composition.refusal === 'product_type_not_found' ? 404 : 400)
        .json({ success: false, error: composition.refusal, message: composition.detail });
      return;
    }

    res.setHeader('ETag', composition.schema.etag);
    // `private`, because the schema carries this caller's permission projection.
    // `no-cache` rather than `no-store`: a client SHOULD keep it and revalidate,
    // which is the whole point of a deterministic ETag.
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    if (authoringEtagMatches(req.headers['if-none-match'], composition.schema.etag)) {
      res.status(304).end();
      return;
    }
    sendSuccess(res, { schema: composition.schema });
  } catch (err) {
    log.general.error({ err, productTypeKey }, 'Failed to compose an authoring schema');
    respondWithError(res, err, 'Failed to compose that authoring schema');
  }
}

/** `GET /catalog-authoring/canonical-search`. */
export async function authoringCanonicalSearchHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      q: string;
      kind?: 'canonical_product' | 'brand';
      canonicalProductId?: string;
      limit?: number;
    };
    const result = await searchCanonicalEntities(getDb(), {
      query: query.q,
      kind: query.kind ?? 'canonical_product',
      ...(query.canonicalProductId === undefined
        ? {}
        : { canonicalProductId: query.canonicalProductId }),
      limit: query.limit ?? config.catalogAuthoring.canonicalSearchLimit,
    });
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err }, 'Failed to search the canonical catalogue');
    respondWithError(res, err, 'Failed to search the catalogue');
  }
}

/* -------------------------------------------------------------------------- */
/* Store-scoped drafts                                                         */
/* -------------------------------------------------------------------------- */

/** `POST /stores/:storeId/product-drafts`. */
export async function createProductDraftHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  try {
    const body = req.body as {
      categoryId: string;
      productTypeKey: string;
      version?: number;
      flow?: string;
      locale?: string;
      market: string;
      title?: string;
      description?: string;
    };
    const draft = await createDraft(getDb(), {
      storeId,
      actorOxyUserId: getRequiredOxyUserId(req),
      categoryId: body.categoryId,
      productTypeKey: body.productTypeKey,
      ...(body.version === undefined ? {} : { version: body.version }),
      flow: requestedFlow(body.flow),
      locale: requestedLocale(body.locale),
      market: body.market,
      permissions: authoringPermissions(req),
      ttlSeconds: config.catalogAuthoring.draftTtlSeconds,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
    });
    sendSuccess(res, { draft }, 201);
  } catch (err) {
    log.general.error({ err, storeId }, 'Failed to create a product draft');
    respondWithError(res, err, 'Failed to create that draft');
  }
}

/** `GET /stores/:storeId/product-drafts`. */
export async function listProductDraftsHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  try {
    const query = req.query as unknown as {
      status?: 'open' | 'published' | 'discarded';
      limit?: number;
      offset?: number;
    };
    const drafts = await listStoreDrafts(getDb(), storeId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit ?? config.catalogAuthoring.draftPageSize,
      offset: query.offset ?? 0,
    });
    sendSuccess(res, { drafts });
  } catch (err) {
    log.general.error({ err, storeId }, 'Failed to list product drafts');
    respondWithError(res, err, 'Failed to list drafts');
  }
}

/** `GET /stores/:storeId/product-drafts/:draftId`. */
export async function getProductDraftHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  const draftId = routeParam(req, 'draftId');
  try {
    sendSuccess(res, { draft: await readDraft(getDb(), storeId, draftId) });
  } catch (err) {
    log.general.error({ err, storeId, draftId }, 'Failed to read a product draft');
    respondWithError(res, err, 'Failed to read that draft');
  }
}

/** `PATCH /stores/:storeId/product-drafts/:draftId`. */
export async function patchProductDraftHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  const draftId = routeParam(req, 'draftId');
  try {
    const body = req.body as {
      version: number;
      title?: string | null;
      description?: string | null;
      imageFileIds?: string[];
      tags?: string[];
      selectedCanonicalProductId?: string | null;
      fields?: DraftFieldInput[];
      variants?: DraftVariantInput[];
    };
    const draft = await patchDraft(getDb(), {
      storeId,
      draftId,
      expectedVersion: body.version,
      permissions: authoringPermissions(req),
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.imageFileIds === undefined ? {} : { imageFileIds: body.imageFileIds }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
      ...(body.selectedCanonicalProductId === undefined
        ? {}
        : { selectedCanonicalProductId: body.selectedCanonicalProductId }),
      ...(body.fields === undefined ? {} : { fields: body.fields }),
      ...(body.variants === undefined ? {} : { variants: body.variants }),
    });
    sendSuccess(res, { draft });
  } catch (err) {
    log.general.error({ err, storeId, draftId }, 'Failed to patch a product draft');
    respondWithError(res, err, 'Failed to save that draft');
  }
}

/** `DELETE /stores/:storeId/product-drafts/:draftId?version=`. */
export async function discardProductDraftHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  const draftId = routeParam(req, 'draftId');
  try {
    const query = req.query as unknown as { version: number };
    const draft = await discardStoreDraft(getDb(), storeId, draftId, query.version);
    sendSuccess(res, { draft });
  } catch (err) {
    log.general.error({ err, storeId, draftId }, 'Failed to discard a product draft');
    respondWithError(res, err, 'Failed to discard that draft');
  }
}

/** `POST /stores/:storeId/product-drafts/:draftId/validate`. */
export async function validateProductDraftHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  const draftId = routeParam(req, 'draftId');
  try {
    const validation = await validateStoreDraft(getDb(), {
      storeId,
      draftId,
      permissions: authoringPermissions(req),
    });
    sendSuccess(res, { validation });
  } catch (err) {
    log.general.error({ err, storeId, draftId }, 'Failed to validate a product draft');
    respondWithError(res, err, 'Failed to validate that draft');
  }
}

/** `GET /stores/:storeId/product-drafts/:draftId/upgrade` — the PREVIEW. */
export async function previewProductDraftUpgradeHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  const draftId = routeParam(req, 'draftId');
  try {
    sendSuccess(res, { preview: await previewDraftUpgrade(getDb(), storeId, draftId) });
  } catch (err) {
    log.general.error({ err, storeId, draftId }, 'Failed to preview a draft upgrade');
    respondWithError(res, err, 'Failed to preview that upgrade');
  }
}

/** `POST /stores/:storeId/product-drafts/:draftId/upgrade` — APPLY it. */
export async function applyProductDraftUpgradeHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  const draftId = routeParam(req, 'draftId');
  try {
    const body = req.body as { version: number; targetDefinitionId: string };
    const draft = await applyDraftUpgrade(getDb(), {
      storeId,
      draftId,
      expectedVersion: body.version,
      targetDefinitionId: body.targetDefinitionId,
      permissions: authoringPermissions(req),
    });
    sendSuccess(res, { draft });
  } catch (err) {
    log.general.error({ err, storeId, draftId }, 'Failed to apply a draft upgrade');
    respondWithError(res, err, 'Failed to apply that upgrade');
  }
}

/**
 * `POST /stores/:storeId/product-drafts/:draftId/publish`.
 *
 * The `Idempotency-Key` header is read raw, the way `checkout.controller.ts`
 * reads it: there is no schema and no middleware for it, because it is a
 * transport-level retry token rather than part of the body a client composes.
 */
export async function publishProductDraftHandler(req: Request, res: Response): Promise<void> {
  const storeId = routeParam(req, 'storeId');
  const draftId = routeParam(req, 'draftId');
  try {
    const raw = req.headers['idempotency-key'];
    const idempotencyKey = (Array.isArray(raw) ? raw[0] : raw) || null;
    const result = await publishDraft(getDb(), {
      storeId,
      draftId,
      actorOxyUserId: getRequiredOxyUserId(req),
      permissions: authoringPermissions(req),
      idempotencyKey,
    });
    if (result.outcome === 'refused') {
      // 422 and not 400: the request was well-formed and the DRAFT is not ready.
      // The body is the same `AuthoringValidationResult` the validate route
      // returns, so a client renders one list for both.
      res.status(422).json({ success: false, error: 'VALIDATION_ERROR', data: { validation: result.validation } });
      return;
    }
    sendSuccess(
      res,
      { listingId: result.listingId, draft: result.draft },
      result.outcome === 'published' ? 201 : 200,
    );
  } catch (err) {
    log.general.error({ err, storeId, draftId }, 'Failed to publish a product draft');
    respondWithError(res, err, 'Failed to publish that draft');
  }
}
