/**
 * The merchant and POS side of #93: publishing a location, and running a
 * collection desk.
 *
 * ## Two permissions, both of which already existed
 *
 * `locations:write` for the shop front (it is the same authority as "may change
 * where this store keeps stock", pointed outward) and `orders:fulfill` for the
 * desk (marking ready and handing over IS fulfilling). #93 operations rule 4
 * asks for exactly that, and an eighteenth permission would have meant every
 * existing owner silently lacking it on the deploy that added it.
 *
 * ## Every order handler re-loads the order SCOPED TO THE STORE
 *
 * `loadStoreOrder` is one function and every desk action goes through it. #93
 * merchant rule 5 — "one staff action cannot expose or mutate another store's
 * sibling order" — is therefore a property of the call graph rather than a
 * predicate somebody remembered: a mixed cart's sibling orders belong to
 * different stores, and an id from one of them resolves to NOTHING here.
 *
 * ## What a merchant response never carries
 *
 * No buyer email, no buyer phone, no guest session id and no portal token. The
 * order projection a merchant reads is #106's `MerchantOrder`, which `Omit`s
 * the buyer fields at the TYPE level; nothing in this file reaches past it, and
 * the collection trail it does add carries staff ids only.
 */

import type { Request, Response } from 'express';
import type {
  CancelPickupInput,
  CollectPickupInput,
  CreateLocationClosureInput,
  SetLocationPickupPauseInput,
  SetLocationPublicationStateInput,
  UpsertLocationPublicationInput,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { notFound, respondWithError } from '../../lib/errors/error-codes.js';
import { findOrderById } from '../../db/orders/orderRepository.js';
import {
  addClosure,
  changePickupPause,
  changePublicationState,
  confirmPublicationProfile,
  listStorePublications,
  readPublication,
  readPublicationTrail,
  removeClosure,
  upsertPublication,
} from '../../services/pickup/publication.service.js';
import {
  cancelPickup,
  collectPickup,
  markPickupReady,
  projectOrderPickup,
  readCollectionTrail,
  rotateCollectionCode,
  type CollectionOrderFacts,
} from '../../services/pickup/collection.service.js';
import { findOrderPickup, listOpenPickupsAtLocation } from '../../db/pickup/orderPickupRepository.js';
import { sendSuccess } from '../../utils/api-response.js';
import { routeParam } from '../../utils/request.js';

/** The store the parent router already authorized. */
function storeId(req: Request): string {
  return req.store?.id ?? routeParam(req, 'storeId');
}

/** Today, in ISO date form — the closure window's lower bound. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** GET /admin/stores/:storeId/locations/publications — every shop front. */
export async function listPublicationsHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, { publications: await listStorePublications(storeId(req), today()) });
  } catch (err) {
    respondWithError(res, err, 'Failed to load location publications');
  }
}

/** GET /admin/stores/:storeId/locations/:id/publication. */
export async function getPublicationHandler(req: Request, res: Response): Promise<void> {
  try {
    const bundle = await readPublication(
      { storeId: storeId(req), locationId: routeParam(req, 'id') },
      today(),
    );
    if (!bundle) throw notFound('Location not found');
    sendSuccess(res, bundle);
  } catch (err) {
    respondWithError(res, err, 'Failed to load the location publication');
  }
}

/** PUT /admin/stores/:storeId/locations/:id/publication. */
export async function putPublicationHandler(req: Request, res: Response): Promise<void> {
  try {
    const bundle = await upsertPublication({
      storeId: storeId(req),
      locationId: routeParam(req, 'id'),
      actorOxyUserId: req.userId ?? '',
      at: new Date(),
      body: req.body as UpsertLocationPublicationInput,
    });
    sendSuccess(res, bundle);
  } catch (err) {
    respondWithError(res, err, 'Failed to save the location publication');
  }
}

/** POST /admin/stores/:storeId/locations/:id/publication/state. */
export async function setPublicationStateHandler(req: Request, res: Response): Promise<void> {
  try {
    const publication = await changePublicationState({
      storeId: storeId(req),
      locationId: routeParam(req, 'id'),
      actorOxyUserId: req.userId ?? '',
      at: new Date(),
      body: req.body as SetLocationPublicationStateInput,
    });
    sendSuccess(res, { publication });
  } catch (err) {
    respondWithError(res, err, 'Failed to change the publication state');
  }
}

/** POST /admin/stores/:storeId/locations/:id/publication/pickup-pause. */
export async function setPickupPauseHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as SetLocationPickupPauseInput;
    const publication = await changePickupPause({
      storeId: storeId(req),
      locationId: routeParam(req, 'id'),
      actorOxyUserId: req.userId ?? '',
      at: new Date(),
      paused: body.paused,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    sendSuccess(res, { publication });
  } catch (err) {
    respondWithError(res, err, 'Failed to change the collection pause');
  }
}

/** POST /admin/stores/:storeId/locations/:id/publication/confirm. */
export async function confirmPublicationHandler(req: Request, res: Response): Promise<void> {
  try {
    await confirmPublicationProfile({
      storeId: storeId(req),
      locationId: routeParam(req, 'id'),
      actorOxyUserId: req.userId ?? '',
      at: new Date(),
    });
    sendSuccess(res, { confirmed: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to confirm the location profile');
  }
}

/** POST /admin/stores/:storeId/locations/:id/publication/closures. */
export async function createClosureHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as CreateLocationClosureInput;
    const closure = await addClosure({
      storeId: storeId(req),
      locationId: routeParam(req, 'id'),
      fromDate: body.fromDate,
      throughDate: body.throughDate,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    sendSuccess(res, closure, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to add the closure');
  }
}

/** DELETE /admin/stores/:storeId/locations/:id/publication/closures/:closureId. */
export async function deleteClosureHandler(req: Request, res: Response): Promise<void> {
  try {
    await removeClosure({
      storeId: storeId(req),
      locationId: routeParam(req, 'id'),
      closureId: routeParam(req, 'closureId'),
    });
    sendSuccess(res, { removed: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to remove the closure');
  }
}

/** GET /admin/stores/:storeId/locations/:id/publication/events — the audit trail. */
export async function publicationTrailHandler(req: Request, res: Response): Promise<void> {
  try {
    const events = await readPublicationTrail({
      storeId: storeId(req),
      locationId: routeParam(req, 'id'),
      limit: 100,
    });
    sendSuccess(res, { events });
  } catch (err) {
    respondWithError(res, err, 'Failed to load the publication trail');
  }
}

/** GET /admin/stores/:storeId/locations/:id/pickups — one branch's own queue. */
export async function locationPickupQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const bundle = await readPublication(
      { storeId: storeId(req), locationId: routeParam(req, 'id') },
      today(),
    );
    if (!bundle) throw notFound('Location not found');
    const rows = await listOpenPickupsAtLocation({
      locationId: routeParam(req, 'id'),
      limit: 200,
    });
    sendSuccess(res, { pickups: rows.map(projectOrderPickup) });
  } catch (err) {
    respondWithError(res, err, 'Failed to load the collection queue');
  }
}

/**
 * The order, scoped to the store — the ONE place a desk action resolves one.
 *
 * See the module docblock: this is what makes "cannot reach a sibling order"
 * structural. It returns the three columns the collection domain reads and
 * nothing else, so a desk handler has no buyer field in scope to leak.
 */
async function loadStoreOrder(req: Request): Promise<CollectionOrderFacts> {
  const order = await findOrderById(routeParam(req, 'id'));
  if (!order || order.storeId !== storeId(req)) throw notFound('Order not found');
  return {
    id: order.id,
    storeId: order.storeId,
    buyerOrigin: order.buyerOrigin,
    checkoutGroupId: order.checkoutGroupId,
  };
}

/** GET /admin/stores/:storeId/orders/:id/pickup. */
export async function getOrderPickupHandler(req: Request, res: Response): Promise<void> {
  try {
    const order = await loadStoreOrder(req);
    const row = await findOrderPickup(order.id);
    if (!row) throw notFound('This order is not a collection.');
    sendSuccess(res, {
      pickup: projectOrderPickup(row),
      events: await readCollectionTrail({ orderId: order.id, limit: 50 }),
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to load the collection');
  }
}

/** POST /admin/stores/:storeId/orders/:id/pickup/ready. */
export async function markPickupReadyHandler(req: Request, res: Response): Promise<void> {
  try {
    const order = await loadStoreOrder(req);
    const pickup = await markPickupReady({
      order,
      actorOxyUserId: req.userId ?? '',
      at: new Date(),
    });
    sendSuccess(res, { pickup });
  } catch (err) {
    respondWithError(res, err, 'Failed to mark the collection ready');
  }
}

/** POST /admin/stores/:storeId/orders/:id/pickup/collect. */
export async function collectPickupHandler(req: Request, res: Response): Promise<void> {
  try {
    const order = await loadStoreOrder(req);
    const pickup = await collectPickup({
      order,
      actorOxyUserId: req.userId ?? '',
      at: new Date(),
      body: req.body as CollectPickupInput,
    });
    sendSuccess(res, { pickup });
  } catch (err) {
    // Logged at INFO rather than ERROR: a refused code is an ordinary event at
    // a counter, and paging somebody about it would train them to ignore the
    // channel that also carries a real fault.
    log.general.info({ orderId: routeParam(req, 'id') }, '[Pickup] a handover was not completed');
    respondWithError(res, err, 'Failed to complete the collection');
  }
}

/** POST /admin/stores/:storeId/orders/:id/pickup/cancel. */
export async function cancelPickupHandler(req: Request, res: Response): Promise<void> {
  try {
    const order = await loadStoreOrder(req);
    const pickup = await cancelPickup({
      order,
      actorOxyUserId: req.userId ?? '',
      reason: (req.body as CancelPickupInput).reason,
      at: new Date(),
    });
    sendSuccess(res, { pickup });
  } catch (err) {
    respondWithError(res, err, 'Failed to cancel the collection');
  }
}

/**
 * POST /admin/stores/:storeId/orders/:id/pickup/rotate-code.
 *
 * Returns the NEW code, because the shop is the party that has to tell the
 * customer it changed. There is no route that returns the CURRENT code to a
 * merchant: a code is the buyer's, and a desk verifies one by presenting it
 * rather than by reading it.
 */
export async function rotateCollectionCodeHandler(req: Request, res: Response): Promise<void> {
  try {
    const order = await loadStoreOrder(req);
    const code = await rotateCollectionCode({
      order,
      actorOxyUserId: req.userId ?? '',
      reason: (req.body as { reason: string }).reason,
      at: new Date(),
    });
    sendSuccess(res, { code });
  } catch (err) {
    respondWithError(res, err, 'Failed to rotate the collection code');
  }
}
