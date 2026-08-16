/**
 * The navigation controller (THIN) — one public read, one operator preview and
 * the five authoring transitions (#367 step 7, ADR 0007 D3).
 *
 * ## The public read answers with an ETag and honours `If-None-Match`
 *
 * A navigation tree is requested on the first render of every session by every
 * client, and it changes when somebody publishes one — which is rarely. The
 * validator is a deterministic hash of the composed payload (ADR 0007 D10's
 * device), so a client that already holds this menu gets a 304 with no body and
 * a publication invalidates every cache in one step.
 *
 * ## `Cache-Control` is deliberately conservative
 *
 * `private, no-cache` — revalidate every time, serve from cache when the
 * validator matches. A shared-cache `max-age` would keep a withdrawn campaign or
 * a delisted category on somebody's screen for the length of the TTL, and the
 * projection's whole job is to stop exactly that.
 */

import type { Request, Response } from 'express';
import type { NavigationSurface } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import {
  archiveNavigationTree,
  createNavigationSavedQuery,
  createNavigationTreeDraft,
  deleteNavigationTreeDraft,
  publishNavigationTree,
  replaceNavigationTreeNodes,
} from '../services/navigation/authoring.service.js';
import { navigationEtagMatches } from '../services/navigation/etag.js';
import {
  previewNavigationTree,
  readPublishedNavigation,
} from '../services/navigation/navigation.service.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';

/** `GET /navigation?market=&locale=[&surface=]` — the published trees, live now. */
export async function navigationReadHandler(req: Request, res: Response): Promise<void> {
  const query = req.query as {
    market: string;
    locale: string;
    surface?: NavigationSurface;
  };
  try {
    const response = await readPublishedNavigation(getDb(), {
      market: query.market,
      locale: query.locale,
      ...(query.surface === undefined ? {} : { surface: query.surface }),
      at: new Date(),
    });

    res.setHeader('ETag', response.etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    // `Vary` because the payload is a function of the query string only — but a
    // proxy that ignored the query would serve one market's menu to another's
    // shoppers, and stating it costs nothing.
    res.setHeader('Vary', 'Accept-Encoding');
    if (navigationEtagMatches(req.headers['if-none-match'], response.etag)) {
      res.status(304).end();
      return;
    }
    sendSuccess(res, response);
  } catch (error) {
    respondWithError(res, error, 'Failed to read navigation');
  }
}

/** `GET /navigation/preview/:treeId` — one tree, whatever its lifecycle. */
export async function navigationPreviewHandler(req: Request, res: Response): Promise<void> {
  const query = req.query as { locale?: string };
  try {
    const preview = await previewNavigationTree(getDb(), {
      treeId: routeParam(req, 'treeId'),
      ...(query.locale === undefined ? {} : { locale: query.locale }),
      at: new Date(),
    });
    if (preview === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Navigation tree not found', 404);
      return;
    }
    sendSuccess(res, preview);
  } catch (error) {
    respondWithError(res, error, 'Failed to preview the navigation tree');
  }
}

/** `POST /navigation/trees` — create the next DRAFT version of a tree key. */
export async function createNavigationTreeHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    key: string;
    market: string;
    locale: string;
    surface: NavigationSurface;
    internalLabel: string;
    supersedesTreeId?: string;
  };
  try {
    const created = await createNavigationTreeDraft(getDb(), {
      key: body.key,
      market: body.market,
      locale: body.locale,
      surface: body.surface,
      internalLabel: body.internalLabel,
      ...(body.supersedesTreeId === undefined ? {} : { supersedesTreeId: body.supersedesTreeId }),
    });
    sendSuccess(res, created, 201);
  } catch (error) {
    respondWithError(res, error, 'Failed to create the navigation tree');
  }
}

/** `PUT /navigation/trees/:treeId/nodes` — replace the whole node set. */
export async function replaceNavigationNodesHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    nodes: Parameters<typeof replaceNavigationTreeNodes>[2];
  };
  try {
    const nodeCount = await replaceNavigationTreeNodes(getDb(), routeParam(req, 'treeId'), body.nodes);
    sendSuccess(res, { nodeCount });
  } catch (error) {
    respondWithError(res, error, 'Failed to replace the navigation tree nodes');
  }
}

/** `POST /navigation/trees/:treeId/publish`. */
export async function publishNavigationTreeHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    effectiveFrom?: Date;
    effectiveTo?: Date;
    supersedeLive?: boolean;
  };
  const actorOxyUserId = req.user?.id;
  if (actorOxyUserId === undefined) {
    // Unreachable behind `authenticateToken`; publishing writes an attributable
    // audit record, so it refuses rather than writing an anonymous one.
    sendError(res, ErrorCodes.UNAUTHORIZED, 'A publication must name its publisher', 401);
    return;
  }
  try {
    const published = await publishNavigationTree(getDb(), {
      treeId: routeParam(req, 'treeId'),
      actorOxyUserId,
      ...(body.effectiveFrom === undefined ? {} : { effectiveFrom: body.effectiveFrom }),
      ...(body.effectiveTo === undefined ? {} : { effectiveTo: body.effectiveTo }),
      ...(body.supersedeLive === undefined ? {} : { supersedeLive: body.supersedeLive }),
    });
    sendSuccess(res, {
      treeId: published.treeId,
      effectiveFrom: published.effectiveFrom.toISOString(),
    });
  } catch (error) {
    respondWithError(res, error, 'Failed to publish the navigation tree');
  }
}

/** `POST /navigation/trees/:treeId/archive`. */
export async function archiveNavigationTreeHandler(req: Request, res: Response): Promise<void> {
  try {
    await archiveNavigationTree(getDb(), routeParam(req, 'treeId'));
    sendSuccess(res, { archived: true });
  } catch (error) {
    respondWithError(res, error, 'Failed to archive the navigation tree');
  }
}

/** `DELETE /navigation/trees/:treeId` — a DRAFT only. */
export async function deleteNavigationTreeHandler(req: Request, res: Response): Promise<void> {
  try {
    await deleteNavigationTreeDraft(getDb(), routeParam(req, 'treeId'));
    sendSuccess(res, { deleted: true });
  } catch (error) {
    respondWithError(res, error, 'Failed to delete the navigation tree draft');
  }
}

/** `POST /navigation/saved-queries` — a curated search a node can point at. */
export async function createNavigationSavedQueryHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const savedQueryId = await createNavigationSavedQuery(
      getDb(),
      req.body as Parameters<typeof createNavigationSavedQuery>[1],
    );
    sendSuccess(res, { savedQueryId }, 201);
  } catch (error) {
    respondWithError(res, error, 'Failed to create the saved query');
  }
}
