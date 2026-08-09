/**
 * The product-save operator controllers (#80 counter rule 3, privacy rule 5).
 *
 * Four capabilities and no more: SEE the counter drift, REBUILD a counter, RUN
 * a migration page, ERASE one account's saves. Each drives a path that already
 * exists and is already idempotent, so this surface adds a trigger rather than a
 * new way for a save to come into being — there is deliberately no "create a
 * save for this person", no "move this save" and no read that names who saved
 * anything.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import {
  readCounterDrift,
  rebuildCounterPage,
  rebuildOneListingCounter,
  rebuildOneProductCounter,
  traceProductSaves,
} from '../services/product-saves/counters.service.js';
import { runFavoriteMigrationPage } from '../services/product-saves/save-migration.service.js';
import { eraseProductSavesForOxyUser } from '../services/product-saves/product-save.service.js';

/** GET /internal/product-saves/counters/drift — report, repair nothing. */
export async function counterDriftHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      limit?: number;
      productCursor?: string;
      listingCursor?: string;
    };
    sendSuccess(res, await readCounterDrift(query));
  } catch (err) {
    log.general.error({ err }, 'Failed to read product-save counter drift');
    respondWithError(res, err, 'Failed to read counter drift');
  }
}

/** POST /internal/product-saves/counters/rebuild — one product, one listing, or a page. */
export async function rebuildCountersHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      canonicalProductId?: string;
      listingId?: string;
      limit?: number;
    };
    if (body.canonicalProductId) {
      sendSuccess(res, {
        canonicalProductId: body.canonicalProductId,
        saveCount: await rebuildOneProductCounter(body.canonicalProductId),
      });
      return;
    }
    if (body.listingId) {
      sendSuccess(res, {
        listingId: body.listingId,
        favoriteCount: await rebuildOneListingCounter(body.listingId),
      });
      return;
    }
    sendSuccess(res, await rebuildCounterPage(body.limit));
  } catch (err) {
    log.general.error({ err }, 'Failed to rebuild product-save counters');
    respondWithError(res, err, 'Failed to rebuild counters');
  }
}

/** GET /internal/product-saves/trace/:canonicalProductId — counts, never people. */
export async function traceProductSavesHandler(req: Request, res: Response): Promise<void> {
  const canonicalProductId = routeParam(req, 'canonicalProductId');
  try {
    sendSuccess(res, await traceProductSaves(canonicalProductId));
  } catch (err) {
    log.general.error({ err, canonicalProductId }, 'Failed to trace product saves');
    respondWithError(res, err, 'Failed to trace that product');
  }
}

/** POST /internal/product-saves/migrations — run one page (#80 migration rules). */
export async function runMigrationHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { limit: number; cursor?: string; dryRun?: boolean };
    const report = await runFavoriteMigrationPage(body);
    log.general.info(
      {
        actorOxyUserId: getRequiredOxyUserId(req),
        migrationVersion: report.migrationVersion,
        dryRun: report.dryRun,
        scanned: report.scanned,
        created: report.created,
      },
      '[ProductSaves] a migration page ran',
    );
    sendSuccess(res, report);
  } catch (err) {
    log.general.error({ err }, 'Failed to run a favorite migration page');
    respondWithError(res, err, 'Failed to run the migration');
  }
}

/**
 * DELETE /internal/product-saves/subjects/:oxyUserId — #80 privacy rule 5.
 *
 * The only destructive action on this surface, and the only one that names a
 * person. The reason is required by the schema and the ACTOR is logged beside
 * it: an erasure with nobody attached and no stated reason is exactly the record
 * an audit would need and would not find.
 *
 * The response is a pair of COUNTS. Returning the products whose counters moved
 * would be a list of what that person had saved, handed to the operator who
 * erased it.
 */
export async function eraseSubjectSavesHandler(req: Request, res: Response): Promise<void> {
  const subjectOxyUserId = routeParam(req, 'oxyUserId');
  try {
    const actorOxyUserId = getRequiredOxyUserId(req);
    const { reason } = req.body as { reason: string };
    if (subjectOxyUserId === '') throw validationError('Name the account whose saves are erased.');
    const result = await eraseProductSavesForOxyUser(subjectOxyUserId);
    log.general.warn(
      { actorOxyUserId, subjectOxyUserId, reason, deleted: result.deleted },
      '[ProductSaves] an operator erased an account saved products',
    );
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err }, 'Failed to erase an account saved products');
    respondWithError(res, err, 'Failed to erase those saves');
  }
}
