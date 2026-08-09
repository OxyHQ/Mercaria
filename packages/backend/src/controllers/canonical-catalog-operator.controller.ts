/**
 * Operator controller for `/internal/canonical-catalog/*` (#56).
 *
 * THIN, like every other controller here: each handler unpacks a schema-verified
 * body, stamps the authenticated operator as the ACTOR, and delegates every
 * decision to `services/canonical/`. Nothing in this file decides identity,
 * resolves a conflict or picks a merge winner.
 *
 * The merge endpoints DO ship here, unlike #54's, and the difference is worth
 * naming: #54 deferred them because the merge OPERATION it would have exposed
 * was #59's, defined by ADR 0002 D16 to write a `catalog_revisions` row. #56's
 * merges write their own durable audit — the tombstone, the repointed children
 * and the append-only redirect history this issue requires (family rule 7,
 * acceptance 5) — so they are complete without that table. #59's ledger is
 * additive over them, not a precondition.
 */

import type { Request, Response } from 'express';
import type {
  AttributeValueType,
  CanonicalAliasKind,
  IdentifierScheme,
  SourceLinkMethod,
  UnitFamily,
} from '@mercaria/shared-types';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import {
  createProductFamily,
  mergeProductFamilies,
} from '../services/canonical/product-family.service.js';
import {
  applyProductSourceObservation,
  createCanonicalProduct,
  mergeCanonicalProducts,
} from '../services/canonical/canonical-product.service.js';
import { createVariant, mergeVariants } from '../services/canonical/canonical-variant.service.js';
import {
  assignIdentifier,
  correctIdentifier,
} from '../services/canonical/product-identifier.service.js';
import { defineAttribute } from '../services/canonical/attribute.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** POST /internal/canonical-catalog/product-families */
export async function createProductFamilyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      name: string;
      slug?: string;
      description?: string;
      brandId?: string;
      categoryId?: string;
      aliases?: { alias: string; kind: CanonicalAliasKind; language?: string }[];
    };
    const family = await createProductFamily({ ...body, actorOxyUserId: catalogOperatorId(req) });
    sendSuccess(res, { id: family.id, slug: family.slug, name: family.name }, 201);
  } catch (error) {
    respondWithError(res, error, 'Creating the product family failed');
  }
}

/** POST /internal/canonical-catalog/products */
export async function createCanonicalProductHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      name: string;
      slug?: string;
      description?: string;
      brandId?: string;
      familyId?: string;
      categoryId?: string;
      releasedAt?: Date;
      modelYear?: number;
      modelCode?: string;
      variantDefiningAttributeKeys?: string[];
      searchTokens?: string[];
      aliases?: { alias: string; kind: CanonicalAliasKind; language?: string }[];
    };
    const product = await createCanonicalProduct({
      ...body,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(
      res,
      {
        id: product.id,
        slug: product.slug,
        name: product.name,
        variantDefiningAttributeKeys: product.variantDefiningAttributeKeys,
      },
      201,
    );
  } catch (error) {
    respondWithError(res, error, 'Creating the canonical product failed');
  }
}

/** POST /internal/canonical-catalog/products/:productId/variants */
export async function createCanonicalVariantHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      name?: string;
      isDefault?: boolean;
      releasedAt?: Date;
      options: { key: string; value: string; position?: number }[];
    };
    const result = await createVariant({
      productId: routeParam(req, 'productId'),
      ...body,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(
      res,
      {
        id: result.variant.id,
        signature: result.variant.signature,
        isDefault: result.variant.isDefault,
        created: result.created,
        options: result.attributes.map((attribute) => ({
          key: attribute.attributeKey,
          displayValue: attribute.displayValue,
          normalizedValue: attribute.normalizedValue,
        })),
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    respondWithError(res, error, 'Creating the canonical variant failed');
  }
}

/**
 * POST /internal/canonical-catalog/products/:productId/observations
 *
 * The SOURCE-FACT upsert (#56 API rule 4). The body names what a source SAID;
 * the service decides what, if anything, that changes.
 */
export async function applyProductObservationHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      sourceId: string;
      externalId: string;
      observedAt: Date;
      staleAt?: Date;
      method: SourceLinkMethod;
      matchRule: string;
      confidence?: number;
      sourceTitle?: string;
      description?: string;
      releasedAt?: Date;
      modelYear?: number;
      modelCode?: string;
      images?: { fileId?: string; sourceUrl?: string; alt?: string; locale?: string }[];
      identifiers?: { scheme: IdentifierScheme; rawValue: string }[];
    };
    const productId = routeParam(req, 'productId');
    const result = await applyProductSourceObservation({
      productId,
      sourceId: body.sourceId,
      externalId: body.externalId,
      observedAt: body.observedAt,
      ...(body.staleAt === undefined ? {} : { staleAt: body.staleAt }),
      method: body.method,
      matchRule: body.matchRule,
      ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
      decidedByOxyUserId: catalogOperatorId(req),
      fields: {
        ...(body.sourceTitle === undefined ? {} : { name: body.sourceTitle }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.releasedAt === undefined ? {} : { releasedAt: body.releasedAt }),
        ...(body.modelYear === undefined ? {} : { modelYear: body.modelYear }),
        ...(body.modelCode === undefined ? {} : { modelCode: body.modelCode }),
      },
      ...(body.images === undefined ? {} : { images: body.images }),
    });

    // Identifiers go through the identifier service, so a collision becomes a
    // reviewable dispute rather than a silent overwrite — the same path a direct
    // assignment takes, deliberately not a second implementation.
    const identifierOutcomes: { scheme: IdentifierScheme; outcome: string }[] = [];
    for (const identifier of body.identifiers ?? []) {
      const outcome = await assignIdentifier({
        target: { kind: 'product', id: productId },
        scheme: identifier.scheme,
        rawValue: identifier.rawValue,
        sourceRecordId: result.sourceRecordId,
        assignedByOxyUserId: catalogOperatorId(req),
      });
      identifierOutcomes.push({ scheme: identifier.scheme, outcome: outcome.outcome });
    }

    sendSuccess(res, {
      productId: result.product.id,
      sourceRecordId: result.sourceRecordId,
      newObservation: result.newObservation,
      applied: result.applied,
      conflicts: result.conflicts,
      imagesAdded: result.imagesAdded,
      identifiers: identifierOutcomes,
    });
  } catch (error) {
    respondWithError(res, error, 'Applying the source observation failed');
  }
}

/** POST /internal/canonical-catalog/identifiers */
export async function assignIdentifierHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      productId?: string;
      variantId?: string;
      scheme: IdentifierScheme;
      rawValue: string;
      sourceRecordId?: string;
      note?: string;
    };
    const target =
      body.productId === undefined
        ? ({ kind: 'variant', id: String(body.variantId) } as const)
        : ({ kind: 'product', id: body.productId } as const);
    const result = await assignIdentifier({
      target,
      scheme: body.scheme,
      rawValue: body.rawValue,
      ...(body.sourceRecordId === undefined ? {} : { sourceRecordId: body.sourceRecordId }),
      assignedByOxyUserId: catalogOperatorId(req),
      ...(body.note === undefined ? {} : { note: body.note }),
    });

    // A dispute is a successful REQUEST with an unsuccessful assignment: the
    // assertion is stored and routed to review, and answering 4xx would tell the
    // caller nothing was recorded when something was.
    if (result.outcome === 'invalid') {
      sendSuccess(res, { outcome: result.outcome, reason: result.reason });
      return;
    }
    sendSuccess(
      res,
      {
        outcome: result.outcome,
        identifierId: result.identifier.id,
        status: result.identifier.status,
        ...(result.outcome === 'disputed'
          ? { conflictsWithIdentifierId: result.conflictsWith.id }
          : {}),
      },
      result.outcome === 'assigned' ? 201 : 200,
    );
  } catch (error) {
    respondWithError(res, error, 'Assigning the identifier failed');
  }
}

/** POST /internal/canonical-catalog/identifiers/:id/correct */
export async function correctIdentifierHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { scheme: IdentifierScheme; rawValue: string; note: string };
    const result = await correctIdentifier({
      identifierId: routeParam(req, 'id'),
      scheme: body.scheme,
      rawValue: body.rawValue,
      note: body.note,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, {
      retiredIdentifierId: result.retired.id,
      replacementIdentifierId: result.replacement.id,
    });
  } catch (error) {
    respondWithError(res, error, 'Correcting the identifier failed');
  }
}

/** POST /internal/canonical-catalog/attribute-definitions */
export async function defineAttributeHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      key: string;
      label: string;
      valueType: AttributeValueType;
      unitFamily?: UnitFamily;
      allowedValues?: string[];
      description?: string;
      categoryIds?: string[];
    };
    const definition = await defineAttribute(body);
    sendSuccess(
      res,
      {
        id: definition.id,
        key: definition.key,
        valueType: definition.valueType,
        unitFamily: definition.unitFamily,
        baseUnit: definition.baseUnit,
      },
      201,
    );
  } catch (error) {
    respondWithError(res, error, 'Defining the attribute failed');
  }
}

/** POST /internal/canonical-catalog/product-families/:winnerId/merge */
export async function mergeProductFamiliesHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { loserId: string; reason: string };
    const result = await mergeProductFamilies({
      winnerId: routeParam(req, 'winnerId'),
      loserId: body.loserId,
      note: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, result);
  } catch (error) {
    respondWithError(res, error, 'Merging the product families failed');
  }
}

/** POST /internal/canonical-catalog/products/:winnerId/merge */
export async function mergeCanonicalProductsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { loserId: string; reason: string };
    const result = await mergeCanonicalProducts({
      winnerId: routeParam(req, 'winnerId'),
      loserId: body.loserId,
      note: body.reason,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, result);
  } catch (error) {
    respondWithError(res, error, 'Merging the canonical products failed');
  }
}

/** POST /internal/canonical-catalog/variants/:winnerId/merge */
export async function mergeCanonicalVariantsHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { loserId: string };
    const result = await mergeVariants({
      winnerId: routeParam(req, 'winnerId'),
      loserId: body.loserId,
      actorOxyUserId: catalogOperatorId(req),
    });
    sendSuccess(res, result);
  } catch (error) {
    respondWithError(res, error, 'Merging the canonical variants failed');
  }
}
