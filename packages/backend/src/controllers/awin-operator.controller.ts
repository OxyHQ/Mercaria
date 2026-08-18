/**
 * The Awin operator surface (#66).
 *
 * Register a publisher account, poll its feed list, look at what that found,
 * bind an advertiser to a #62 source, record a destination-and-tracking sample,
 * and move an advertiser's activation. Every write drives a path that already
 * exists and is already idempotent, so this surface adds buttons and no second
 * way for a catalogue to change.
 *
 * What is deliberately absent, and why each absence is load-bearing:
 *
 * - **No credential read, in any form.** The projections below name their
 *   fields (the `provider_accounts` #46 precedent) and report whether a locator
 *   is CONFIGURED, never what it says. A route that echoed one back would make
 *   this surface a second distribution channel for a key whose whole design is
 *   that Mercaria stores only where it lives.
 * - **No delete of an account, an advertiser, a feed, a quality snapshot or a
 *   sample.** Two of those tables are append-only by trigger and the rest are
 *   evidence. An advertiser that left is CLOSED, which preserves its
 *   observations, runs and every published rights version.
 * - **No "set this offer's tracking link" and no "approve this host".**
 *   `AWIN_TRACKING_HOSTS` is a code constant precisely so it cannot be answered
 *   differently per deployment and per row, which is the shape an open redirect
 *   eventually takes.
 * - **No rights policy and no status change.** Those live on
 *   `/internal/ingestion`, where #62's rights model is, and a second surface
 *   would be a second vocabulary for one act.
 * - **No flag write.** `AWIN_ENABLED` is read at boot, and a route that changed
 *   it at runtime would make "what was this deployment doing at 14:00"
 *   unanswerable from configuration.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  AwinAccountState,
  AwinAccountStateReason,
  AwinActivation,
  AwinSampleFinding,
  AwinSampleVerdict,
} from '@mercaria/shared-types';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import {
  changeAwinAccountState,
  findAwinAccount,
  listAwinAccounts,
  upsertAwinAccount,
  type AwinAccountRow,
} from '../db/awin/awinAccountRepository.js';
import {
  findAwinAdvertiser,
  listAwinAdvertisers,
  type AwinAdvertiserRow,
} from '../db/awin/awinAdvertiserRepository.js';
import { listAwinFeeds, type AwinFeedRow } from '../db/awin/awinFeedRepository.js';
import { listAwinQuality } from '../db/awin/awinQualityRepository.js';
import { listAwinLinkSamples } from '../db/awin/awinLinkSampleRepository.js';
import { readAwinNetworkQuota } from '../db/awin/awinNetworkLeaseRepository.js';
import { runAwinDiscovery } from '../services/awin/discovery.service.js';
import {
  changeAwinAdvertiserActivation,
  recordAwinSample,
} from '../services/awin/activation.service.js';
import { registerAwinAdvertiserSource } from '../services/awin/source-binding.service.js';
import {
  changeAwinAccountStateSchema,
  changeAwinActivationSchema,
  recordAwinSampleSchema,
  registerAwinAccountSchema,
  registerAwinSourceSchema,
} from '../middleware/awin-schemas.js';

/**
 * One account, with every field NAMED.
 *
 * The `provider_accounts` (#46) precedent: an explicit projection rather than a
 * filtered row, so a column added later is absent from the response until
 * somebody decides it belongs there. The two credential columns are reported as
 * BOOLEANS — whether a locator is recorded — because "is this configured" is the
 * question an operator has and "what does it say" is not one this surface
 * answers in any form.
 */
function toAccountDTO(row: AwinAccountRow): Record<string, unknown> {
  return {
    id: row.id,
    publisherId: row.publisherId,
    label: row.label,
    state: row.state,
    stateReason: row.stateReason,
    stateChangedAt: row.stateChangedAt,
    stateNote: row.stateNote,
    feedCredentialConfigured: row.feedCredentialRef !== null,
    publisherApiCredentialConfigured: row.publisherApiCredentialRef !== null,
    maxConcurrency: row.maxConcurrency,
    maxCallsPerMinute: row.maxCallsPerMinute,
    lastListPolledAt: row.lastListPolledAt,
    lastListFeedCount: row.lastListFeedCount,
    // The digest, not the list. It is what tells one poll from the next and
    // carries no advertiser, no URL and no key.
    lastListDigest: row.lastListDigest,
    lastListError: row.lastListError,
    lastListErrorAt: row.lastListErrorAt,
  };
}

function toAdvertiserDTO(row: AwinAdvertiserRow): Record<string, unknown> {
  return {
    id: row.id,
    accountId: row.accountId,
    advertiserId: row.advertiserId,
    displayName: row.displayName,
    catalogSourceId: row.catalogSourceId,
    membershipStatus: row.membershipStatus,
    membershipChangedAt: row.membershipChangedAt,
    activation: row.activation,
    activationChangedAt: row.activationChangedAt,
    activationChangedByOxyUserId: row.activationChangedByOxyUserId,
    activationNote: row.activationNote,
    activatingSampleId: row.activatingSampleId,
    primaryRegion: row.primaryRegion,
    vertical: row.vertical,
    lastSeenInListAt: row.lastSeenInListAt,
  };
}

/**
 * One feed, WITHOUT a download URL — because there is none stored.
 *
 * Awin puts the product-data key in the PATH, so a feed URL in this domain is a
 * credential wearing a hostname (#63's rule, inherited). It is composed at fetch
 * time and never persisted, so there is nothing here to withhold.
 */
function toFeedDTO(row: AwinFeedRow): Record<string, unknown> {
  return {
    id: row.id,
    feedId: row.feedId,
    feedName: row.feedName,
    language: row.language,
    currency: row.currency,
    productCount: row.productCount,
    listedLastImportedAt: row.listedLastImportedAt,
    importedLastImportedAt: row.importedLastImportedAt,
    lastImportAt: row.lastImportAt,
    lastImportDigest: row.lastImportDigest,
    declaredColumns: row.declaredColumns,
    mappingVersion: row.mappingVersion,
    lastSeenInListAt: row.lastSeenInListAt,
  };
}

/** GET — every publisher account, its state, its budget and its last poll. */
export async function listAwinAccountsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const accounts = await listAwinAccounts();
    const withQuota = await Promise.all(
      accounts.map(async (account) => ({
        ...toAccountDTO(account),
        quota: await readAwinNetworkQuota({ accountId: account.id }),
      })),
    );
    sendSuccess(res, { accounts: withQuota });
  } catch (err) {
    respondWithError(res, err, 'Failed to list Awin accounts');
  }
}

/** POST — register or reconfigure one publisher account. It permits nothing. */
export async function registerAwinAccountHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = registerAwinAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid body', 400);
      return;
    }
    // Named explicitly rather than spread: this package compiles with
    // `strict: false`, so zod's inferred output types every field OPTIONAL and
    // a spread would not satisfy a required parameter. Naming them also makes
    // the two credential LOCATORS visible at the one call site that carries
    // them.
    const account = await upsertAwinAccount({
      publisherId: parsed.data.publisherId ?? '',
      label: parsed.data.label ?? '',
      feedCredentialRef: parsed.data.feedCredentialRef ?? null,
      publisherApiCredentialRef: parsed.data.publisherApiCredentialRef ?? null,
      ...(parsed.data.maxConcurrency === undefined
        ? {}
        : { maxConcurrency: parsed.data.maxConcurrency }),
      ...(parsed.data.maxCallsPerMinute === undefined
        ? {}
        : { maxCallsPerMinute: parsed.data.maxCallsPerMinute }),
    });
    sendSuccess(res, { account: toAccountDTO(account) });
  } catch (err) {
    respondWithError(res, err, 'Failed to register the Awin account');
  }
}

/** POST — pause, resume, or record a deauthorization. A reason is mandatory. */
export async function changeAwinAccountStateHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = changeAwinAccountStateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid body', 400);
      return;
    }
    const account = await changeAwinAccountState({
      accountId: routeParam(req, 'accountId'),
      state: parsed.data.state as AwinAccountState,
      reason: parsed.data.reason as AwinAccountStateReason,
      actorOxyUserId: getRequiredOxyUserId(req),
      note: parsed.data.note,
    });
    if (account === null) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Awin account not found', 404);
      return;
    }
    sendSuccess(res, { account: toAccountDTO(account) });
  } catch (err) {
    respondWithError(res, err, 'Failed to change the Awin account state');
  }
}

/**
 * POST — poll the feed list NOW and reconcile advertisers and feeds.
 *
 * The supported way to bring a network up before any loop is switched on, and
 * the reason this surface stays mounted while `AWIN_ENABLED` is off.
 */
export async function discoverAwinHandler(req: Request, res: Response): Promise<void> {
  try {
    const account = await findAwinAccount(routeParam(req, 'accountId'));
    if (account === null) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Awin account not found', 404);
      return;
    }
    const result = await runAwinDiscovery({ account });
    sendSuccess(res, { discovery: result });
  } catch (err) {
    respondWithError(res, err, 'Failed to run Awin discovery');
  }
}

/** GET — this account's advertisers, with membership and activation. */
export async function listAwinAdvertisersHandler(req: Request, res: Response): Promise<void> {
  try {
    const advertisers = await listAwinAdvertisers({ accountId: routeParam(req, 'accountId') });
    sendSuccess(res, { advertisers: advertisers.map(toAdvertiserDTO) });
  } catch (err) {
    respondWithError(res, err, 'Failed to list Awin advertisers');
  }
}

/**
 * GET — one advertiser's whole trace.
 *
 * It opens from an ADVERTISER ID and nothing else. There is no route that opens
 * from a product, a price or a buyer, because none of those is a question this
 * domain should be able to be asked.
 */
export async function traceAwinAdvertiserHandler(req: Request, res: Response): Promise<void> {
  try {
    const advertiserRowId = routeParam(req, 'advertiserId');
    const advertiser = await findAwinAdvertiser(advertiserRowId);
    if (advertiser === null) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Awin advertiser not found', 404);
      return;
    }
    const [feeds, quality, samples] = await Promise.all([
      listAwinFeeds(advertiserRowId),
      listAwinQuality({ advertiserRowId }),
      listAwinLinkSamples({ advertiserRowId }),
    ]);
    sendSuccess(res, {
      advertiser: toAdvertiserDTO(advertiser),
      feeds: feeds.map(toFeedDTO),
      quality,
      samples,
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to trace the Awin advertiser');
  }
}

/**
 * POST — bind this advertiser to a #62 source, with a merchant and a
 * storefront.
 *
 * ONE call writes both halves of the binding, in one transaction, because two
 * calls could leave a source pointing at one advertiser while another claims it
 * — and the adapter would then ingest the wrong retailer's feed under the wrong
 * merchant, with no error anywhere.
 */
export async function registerAwinSourceHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = registerAwinSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid body', 400);
      return;
    }
    const advertiser = await registerAwinAdvertiserSource({
      advertiserRowId: routeParam(req, 'advertiserId'),
      merchantId: parsed.data.merchantId ?? '',
      ...(parsed.data.storefrontId === undefined
        ? {}
        : { storefrontId: parsed.data.storefrontId }),
      ...(parsed.data.territories === undefined
        ? {}
        : { territories: parsed.data.territories }),
      ...(parsed.data.freshnessTtlSeconds === undefined
        ? {}
        : { freshnessTtlSeconds: parsed.data.freshnessTtlSeconds }),
      ...(parsed.data.pageSize === undefined ? {} : { pageSize: parsed.data.pageSize }),
    });
    sendSuccess(res, { advertiser: toAdvertiserDTO(advertiser) });
  } catch (err) {
    respondWithError(res, err, 'Failed to register the Awin advertiser source');
  }
}

/** POST — move this advertiser's activation. The per-advertiser kill switch. */
export async function changeAwinActivationHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = changeAwinActivationSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid body', 400);
      return;
    }
    const advertiser = await changeAwinAdvertiserActivation({
      advertiserRowId: routeParam(req, 'advertiserId'),
      activation: parsed.data.activation as AwinActivation,
      actorOxyUserId: getRequiredOxyUserId(req),
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    });
    sendSuccess(res, { advertiser: toAdvertiserDTO(advertiser) });
  } catch (err) {
    respondWithError(res, err, 'Failed to change the Awin advertiser activation');
  }
}

/** POST — record a destination-and-tracking sample. Append-only. */
export async function recordAwinSampleHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = recordAwinSampleSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid body', 400);
      return;
    }
    const sample = await recordAwinSample({
      advertiserRowId: routeParam(req, 'advertiserId'),
      feedRowId: parsed.data.feedRowId,
      verdict: parsed.data.verdict as AwinSampleVerdict,
      sampled: parsed.data.sampled,
      passedRows: parsed.data.passedRows,
      findings: (parsed.data.findings ?? []) as readonly AwinSampleFinding[],
      takenByOxyUserId: getRequiredOxyUserId(req),
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    });
    sendSuccess(res, { sample });
  } catch (err) {
    respondWithError(res, err, 'Failed to record the Awin sample');
  }
}
