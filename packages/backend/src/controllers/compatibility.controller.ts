/**
 * Compatibility controller (THIN) — the public fitment reads (#367 step 8,
 * ADR 0007 D8).
 *
 * Every handler parses its selector, calls `services/compatibility/` and projects.
 * **Nothing here decides anything about a fit.** Which verification states may
 * speak is the publication policy in the two services; whether a part fits a car
 * is `resolveFitment` in `@mercaria/shared-types`; which fields reach a shopper is
 * `projection.ts`. A controller that re-derived any of them would be a second
 * answer to the question this domain exists to answer once — and the direction it
 * would go wrong in is a confident yes.
 *
 * ## No analytics event is emitted, deliberately
 *
 * `ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES` (#77) has no compatibility member and
 * `analytics_events.event_type` CHECKs against that tuple, so an emission here
 * would be refused at the row. Adding one is a shared-types change plus a
 * migration, and it is a decision about measurement rather than a side effect of
 * publishing a read — the `offer_impression` precedent says a server may emit only
 * what the client cannot know, and "this shopper asked whether a part fits their
 * car" is a fact about a person's vehicle.
 */

import type { Request, Response } from 'express';
import type {
  CompatibilityRelationKind,
  CompatibilitySubject,
  CompatibilityTarget,
  TypedCompatibilityTargetType,
} from '@mercaria/shared-types';
import {
  answerFitment,
  listPublishedVehiclesForPart,
} from '../services/compatibility/fitment.service.js';
import { readCompatibilityRelationPage } from '../services/compatibility/compatibility.service.js';
import {
  projectCompatibilityRelations,
  projectFitmentVerdict,
  projectPartFitments,
  projectVehicleCatalogLevel,
} from '../services/compatibility/projection.js';
import {
  listVehicleConfigurations,
  listVehicleGenerations,
  listVehicleMakes,
  listVehicleModels,
} from '../db/compatibility/vehicleCatalogRepository.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** What the relation route's schema has already narrowed to exactly one selector. */
interface RelationQuery {
  subjectProductId?: string;
  subjectVariantId?: string;
  targetFamilyId?: string;
  targetProductId?: string;
  targetVariantId?: string;
  targetType?: TypedCompatibilityTargetType;
  targetKey?: string;
  kinds?: CompatibilityRelationKind[];
  market?: string;
  limit?: number;
}

/** The default page bound, shared by both list reads. */
const DEFAULT_LIMIT = 50;

/**
 * The subject, or `null` when the query named a target instead.
 *
 * Returns the union rather than a pair of ids, so the value that leaves this
 * function cannot be a half-specified subject — the same reason the repository's
 * predicate switches on a union with no common id field.
 */
function subjectFrom(query: RelationQuery): CompatibilitySubject | null {
  if (query.subjectVariantId !== undefined) {
    return { kind: 'canonical_variant', variantId: query.subjectVariantId };
  }
  if (query.subjectProductId !== undefined) {
    return { kind: 'canonical_product', productId: query.subjectProductId };
  }
  return null;
}

/**
 * The target, or `null` when the query named a subject.
 *
 * The `typed` branch reads BOTH halves and the schema has already refused one
 * without the other, so there is no path on which a target type is paired with an
 * absent key — which would otherwise select every typed target of that type.
 */
function targetFrom(query: RelationQuery): CompatibilityTarget | null {
  if (query.targetVariantId !== undefined) {
    return { kind: 'canonical_variant', variantId: query.targetVariantId };
  }
  if (query.targetProductId !== undefined) {
    return { kind: 'canonical_product', productId: query.targetProductId };
  }
  if (query.targetFamilyId !== undefined) {
    return { kind: 'canonical_family', familyId: query.targetFamilyId };
  }
  if (query.targetType !== undefined && query.targetKey !== undefined) {
    return { kind: 'typed', target: { type: query.targetType, key: query.targetKey } };
  }
  return null;
}

/**
 * `GET /compatibility/relations` — what this fits, or what fits this.
 *
 * The direction is decided HERE, from which selector arrived, and travels to the
 * response as `lookup`. A client is told which question was answered rather than
 * having to remember which parameter it sent, because an empty forward page and an
 * empty reverse page are the two opposite sentences a product page could render
 * from the same JSON.
 */
export async function compatibilityRelationsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as RelationQuery;
    const subject = subjectFrom(query);
    const target = targetFrom(query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const options = {
      ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
      ...(query.market === undefined ? {} : { market: query.market.toUpperCase() }),
      limit,
    };

    if (subject !== null) {
      const page = await readCompatibilityRelationPage({ lookup: 'subject', subject }, options);
      sendSuccess(
        res,
        projectCompatibilityRelations('subject', page.relations, page.examinedLimit, page.truncated),
      );
      return;
    }
    if (target !== null) {
      const page = await readCompatibilityRelationPage({ lookup: 'target', target }, options);
      sendSuccess(
        res,
        projectCompatibilityRelations('target', page.relations, page.examinedLimit, page.truncated),
      );
      return;
    }
    // Unreachable: the schema's exactly-one refinement runs first. Throwing rather
    // than answering an empty page, because an empty page here would be a read
    // that examined NOTHING presented as a product that fits nothing — the
    // measurement trap, in the one place a shopper acts on the answer.
    throw new Error(
      'compatibility relations: no selector survived validation; `compatibilityRelationsQuerySchema` should make this unreachable',
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read compatibility relations');
  }
}

/** `GET /compatibility/fitments` — the vehicles this part is stated to fit. */
export async function partFitmentsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as RelationQuery;
    const subject = subjectFrom(query);
    if (subject === null) {
      throw new Error(
        'part fitments: no subject survived validation; `partFitmentsQuerySchema` should make this unreachable',
      );
    }
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = await listPublishedVehiclesForPart(subject, limit);
    sendSuccess(
      res,
      projectPartFitments(subject, page.fitments, page.examinedLimit, page.truncated),
    );
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to read part fitments');
  }
}

/** `GET /compatibility/fitments/verdict` — does this part fit this car. */
export async function fitmentVerdictHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as RelationQuery & {
      makeId: string;
      modelId?: string;
      generationId?: string;
      configurationId?: string;
      year?: number;
    };
    const subject = subjectFrom(query);
    if (subject === null) {
      throw new Error(
        'fitment verdict: no subject survived validation; `fitmentVerdictQuerySchema` should make this unreachable',
      );
    }
    const answer = await answerFitment({
      subject,
      vehicle: {
        makeId: query.makeId,
        ...(query.modelId === undefined ? {} : { modelId: query.modelId }),
        ...(query.generationId === undefined ? {} : { generationId: query.generationId }),
        ...(query.configurationId === undefined ? {} : { configurationId: query.configurationId }),
      },
      ...(query.year === undefined ? {} : { year: query.year }),
    });
    sendSuccess(res, projectFitmentVerdict(subject, answer, query.year ?? null));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to answer a fitment question');
  }
}

/** `GET /compatibility/vehicles/makes`. */
export async function vehicleMakesHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, projectVehicleCatalogLevel('make', await listVehicleMakes()));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list vehicle makes');
  }
}

/** `GET /compatibility/vehicles/makes/:makeId/models`. */
export async function vehicleModelsHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listVehicleModels(routeParam(req, 'makeId'));
    sendSuccess(res, projectVehicleCatalogLevel('model', rows));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list vehicle models');
  }
}

/** `GET /compatibility/vehicles/models/:modelId/generations`. */
export async function vehicleGenerationsHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listVehicleGenerations(routeParam(req, 'modelId'));
    sendSuccess(res, projectVehicleCatalogLevel('generation', rows));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list vehicle generations');
  }
}

/**
 * `GET /compatibility/vehicles/generations/:generationId/configurations?year=`.
 *
 * The year narrows to the configurations produced in it, with both NULL bounds
 * treated as OPEN by the repository — which is most of the ones still in
 * production, and the reason that predicate is written out rather than left to a
 * `between`.
 */
export async function vehicleConfigurationsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { year } = req.query as unknown as { year?: number };
    const rows = await listVehicleConfigurations(routeParam(req, 'generationId'), year ?? null);
    sendSuccess(res, projectVehicleCatalogLevel('configuration', rows));
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to list vehicle configurations');
  }
}
