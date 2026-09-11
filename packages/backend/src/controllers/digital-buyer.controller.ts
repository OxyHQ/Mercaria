/**
 * The buyer surface: a library, a grant, the bytes, and a free claim
 * (#1015 W9/W12, ADR 0010 D5).
 *
 * ## Who is asking comes from the ACTOR and never from a body
 *
 * `buyerKeyForActor` is the one translation from a resolved `CommerceActor` to
 * an `asset_rights.buyer_key`, and an anonymous actor has no key — which is a
 * refusal (403) rather than a fallback, because inventing one from a cookie, a
 * fingerprint or an IP is the shape that makes rights unrecoverable AND
 * trackable at once. Nothing below reads an identifier out of a request body.
 *
 * ## Nothing here logs the token, the resolved URL or the storage key
 *
 * #1015 W1 rule 4 and ADR 0010 D5. The token leaves once, in the mint response;
 * only its SHA-256 is stored, the redeem handler never writes it anywhere, and
 * the resolved URL — which embeds a scoped media token — goes into a `Location`
 * header and into no log line, no message and no error field. `storage_key`
 * never reaches this file at all: `redeemDownloadGrant` reads it and the port
 * consumes it, and the only thing that crosses back is a URL.
 *
 * ## Why the redeem route is a GET with the token in the path
 *
 * The bytes are served by a redirect, so the credential has to ride in something
 * a navigation can carry. That would make the URL shareable — except that
 * `redeemDownloadGrant` re-checks the right against the REQUESTER's own key, so
 * a token handed to somebody else resolves to `right_not_active` rather than to
 * a file. The grant is short-lived and multi-redemption to make a resumed
 * transfer work (ADR 0010 D5); what stops it being a shareable URL is the actor
 * check, not the expiry. The response carries `Cache-Control: no-store` and
 * `Referrer-Policy: no-referrer` so neither hop leaks it onward.
 */

import type { Request, Response } from 'express';
import type {
  AssetDownloadRefusalReason,
  BuyerAssetRightSummary,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { grantRight } from '../db/digital/rightRepository.js';
import { findVariantById } from '../db/catalog/variantRepository.js';
import { resolveDigitalLines } from '../services/checkout/digital-lines.js';
import { buyerKeyForActor } from '../services/digital/buyer-key.js';
import {
  mintDownloadGrant,
  redeemDownloadGrant,
} from '../services/digital/download.service.js';
import { listBuyerLibrary } from '../services/digital/right.service.js';
import { assetStorage, isDigitalStorageError } from '../services/digital/storage.js';
import { sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import {
  conflict,
  forbidden,
  notFound,
  respondWithError,
  MercariaError,
} from '../lib/errors/error-codes.js';

/**
 * The caller's `asset_rights.buyer_key`, or a 403.
 *
 * A right belongs to somebody. An anonymous caller is not somebody, and the
 * message says what to do about it rather than what went wrong.
 */
function requireBuyerKey(req: Request): string {
  const actor = req.commerceActor;
  const key = actor ? buyerKeyForActor(actor) : null;
  if (!key) {
    throw forbidden('Sign in, or start a session, to reach your downloads.');
  }
  return key;
}

/**
 * How a refusal reaches the wire.
 *
 * `no_right` is 404 and covers BOTH "no such right" and "somebody else's" —
 * `download.service` already collapses them, and a 403 here would re-open the
 * oracle by telling the two apart at the status line. `downloads_disabled` is
 * 503 because the caller did nothing wrong and retrying later is correct: it is
 * an INCIDENT lever, and every right stays `active` while it is off.
 */
const REFUSAL_STATUS: Record<AssetDownloadRefusalReason, number> = {
  no_right: 404,
  right_not_active: 403,
  version_not_covered: 403,
  version_not_downloadable: 409,
  file_not_in_package: 404,
  file_not_downloadable: 403,
  grant_expired: 410,
  grant_exhausted: 410,
  downloads_disabled: 503,
};

/** One sentence per refusal. Says what is true, never which id exists. */
const REFUSAL_MESSAGE: Record<AssetDownloadRefusalReason, string> = {
  no_right: 'No download is available to you for that item.',
  right_not_active: 'This purchase is not currently active.',
  version_not_covered: 'Your licence does not cover that version.',
  version_not_downloadable: 'That version is not available for download.',
  file_not_in_package: 'No download is available to you for that item.',
  file_not_downloadable: 'That file is a preview and is not downloadable.',
  grant_expired: 'This download link has expired. Ask for a new one.',
  grant_exhausted: 'This download link has been used its maximum number of times.',
  downloads_disabled: 'Downloads are temporarily paused. Your purchases are unaffected.',
};

/** Turn a refusal into the thrown error the responder already knows. */
function refusalError(reason: AssetDownloadRefusalReason): MercariaError {
  const status = REFUSAL_STATUS[reason];
  const code =
    status === 404
      ? ErrorCodes.NOT_FOUND
      : status === 403
        ? ErrorCodes.FORBIDDEN
        : status === 503
          ? ErrorCodes.INTERNAL_ERROR
          : ErrorCodes.CONFLICT;
  return new MercariaError({ code, message: REFUSAL_MESSAGE[reason], httpStatus: status });
}

/**
 * GET /digital/library — everything this buyer owns.
 *
 * Carries no storage key by construction: `listBuyerLibrary` reads through the
 * repository's public column set, so the exclusion is structural rather than
 * careful. A refunded right is LISTED with every file marked un-downloadable
 * rather than hidden — a library that hid it would look like the purchase never
 * happened.
 */
export async function listDigitalLibraryHandler(req: Request, res: Response): Promise<void> {
  try {
    const buyerKey = requireBuyerKey(req);
    const library: BuyerAssetRightSummary[] = await listBuyerLibrary(buyerKey);
    sendSuccess(res, library);
  } catch (error) {
    respondWithError(res, error, 'Reading your library failed');
  }
}

/**
 * POST /digital/downloads — mint a grant.
 *
 * The six checks are `download.service`'s and none of them reads a payment
 * (#1015 boundary 4). What comes back is the token, ONCE: it is not stored, not
 * logged and not re-readable, so a client that loses it asks for another grant.
 */
export async function mintDigitalDownloadHandler(req: Request, res: Response): Promise<void> {
  try {
    const requesterKey = requireBuyerKey(req);
    const body = req.body as { rightId: string; versionId: string; fileId: string };
    const authorization = await mintDownloadGrant({
      requesterKey,
      rightId: body.rightId,
      versionId: body.versionId,
      fileId: body.fileId,
    });
    if (authorization.outcome === 'refused') {
      throw refusalError(authorization.reason);
    }
    const { grant } = authorization;
    // `no-store` on the one response that carries a bearer-like credential.
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(
      res,
      {
        grantId: grant.grantId,
        token: grant.token,
        expiresAt: grant.expiresAt.toISOString(),
        fileName: grant.fileName,
        byteSize: grant.byteSize,
      },
      201,
    );
  } catch (error) {
    respondWithError(res, error, 'Preparing the download failed');
  }
}

/**
 * GET /digital/downloads/:token — redeem and redirect to the bytes.
 *
 * The ONE place a storage key is turned into a URL, and it happens after
 * `redeemDownloadGrant` has claimed a redemption in a single statement and
 * re-checked the right's status — a refund or a revocation inside the five-minute
 * window stops the transfer rather than being noticed on the next request.
 */
export async function redeemDigitalDownloadHandler(req: Request, res: Response): Promise<void> {
  try {
    const requesterKey = requireBuyerKey(req);
    // Read straight into the call. It is never assigned to a named log field, it
    // never enters an error message, and the responder below cannot reach it.
    const redemption = await redeemDownloadGrant(routeParam(req, 'token'), requesterKey);
    if (redemption.outcome === 'refused') {
      throw refusalError(redemption.reason);
    }

    let url: string;
    try {
      // ADR 0010 D17: the SERVICE mint, and no fallback of any kind — a private
      // deliverable resolves through `/assets/service/linked-url` or not at all.
      // Emphatically NOT a user-scoped resolver: this buyer is not a viewer Oxy
      // knows anything about, and the one that looks right would be called
      // successfully and refuse the person who paid.
      url = await assetStorage.resolveAuthorizedUrl(redemption.storageKey);
    } catch (error) {
      if (isDigitalStorageError(error) && error.reason === 'unconfigured') {
        throw new MercariaError({
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Downloads are not fully configured on this deployment.',
          httpStatus: 503,
        });
      }
      if (isDigitalStorageError(error) && error.reason === 'absent') {
        // The file is no longer attached to this application in Oxy — the creator
        // unlinked it, or it was removed there. A retry will not fix that, so the
        // sentence does not ask for one, and it says the RIGHT is intact because
        // it is: D6 and D17 both, nothing revokes a purchase over an act in
        // another product. It still names no file.
        throw new MercariaError({
          code: ErrorCodes.INTERNAL_ERROR,
          message:
            'This file cannot be served at the moment. Your purchase is unaffected — please contact support.',
          httpStatus: 502,
        });
      }
      throw new MercariaError({
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'The file could not be served right now. Try again.',
        httpStatus: 502,
      });
    }

    // `no-store` so no shared cache holds the redirect, and `no-referrer` so the
    // next hop is not told the URL this request was made with — which is the
    // grant token.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, url);
  } catch (error) {
    respondWithError(res, error, 'Serving the download failed');
  }
}

/**
 * POST /digital/claims — take a FREE asset.
 *
 * A claim is an ACQUISITION, so it asks the acquisition questions
 * (`resolveDigitalLines` applies all of them: the option is acquirable, the
 * licence version published, the asset listed, its current version acquirable)
 * plus the per-vertical allow-list. It deliberately does NOT ask
 * `paidCheckoutEnabled` — ADR 0010 D13 says a free claim still works with paid
 * checkout off, and that is the whole reason the two are separate levers.
 *
 * "Free" is a fact about the OFFER and not about the deliverable, so the price
 * read is the variant's own — the same columns `nativeUnitPrice` reads at
 * checkout, so a variant this route calls free is one checkout would charge
 * zero for.
 */
export async function claimFreeDigitalAssetHandler(req: Request, res: Response): Promise<void> {
  try {
    const buyerKey = requireBuyerKey(req);
    const { variantId } = req.body as { variantId: string };

    const variant = await findVariantById(variantId);
    if (!variant) throw notFound('No such item');

    const lines = await resolveDigitalLines([variantId]);
    const line = lines.get(variantId);
    if (!line) throw notFound('No such item');

    if (!config.digital.enabledVerticals.includes(line.vertical)) {
      throw conflict('This download is not available in this region yet.');
    }

    // An UNPRICED variant is not a free one. `nativeUnitPrice` refuses to sell a
    // variant whose price columns are NULL rather than snapshotting a zero onto
    // an order, and treating that same state as free here would be the one path
    // that hands the deliverable over for nothing because nobody set a price.
    if (variant.priceAmount === null || variant.priceCurrency === null) {
      throw conflict('This item is not available to claim.');
    }
    if (variant.priceAmount !== 0) {
      throw conflict('This item is not free. Buy it to add it to your library.');
    }

    const now = new Date();
    // ONE statement with `ON CONFLICT DO NOTHING` behind it: the partial unique
    // index `(buyer_key, package_id) WHERE order_item_id IS NULL` is what bounds
    // a second claim, so a double tap converges on one right and only the first
    // caller appends a `granted` event.
    const result = await grantRight(
      {
        buyerKey,
        assetId: line.assetId,
        packageId: line.packageId,
        purchasedVersionId: line.assetVersionId,
        licenceVersionId: line.licenceVersionId,
        updatePolicy: line.updatePolicy,
        source: 'free_claim',
        orderItemId: null,
        orderId: null,
        grantedAt: now,
      },
      buyerKey,
    );

    sendSuccess(
      res,
      {
        rightId: result.right.id,
        status: result.right.status,
        assetId: result.right.assetId,
        packageId: result.right.packageId,
        purchasedVersionId: result.right.purchasedVersionId,
        licenceVersionId: result.right.licenceVersionId,
        updatePolicy: result.right.updatePolicy,
        /** False on a converged replay — the same right, not a second one. */
        created: result.created,
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    respondWithError(res, error, 'Claiming the download failed');
  }
}
