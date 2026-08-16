/**
 * The referral PARTNER surface (#146 increment 2), served to two owners from
 * one set of handlers.
 *
 * ## The owner is a PARAMETER, not something sniffed off the request
 *
 * `makeReferralPartnerHandlers` takes the resolver its MOUNT supplies, and
 * there are exactly two:
 *
 *  - the store mount passes `req.store.id`, which exists only after `loadStore`
 *    and `requireStorePermission('store:manage')` have run — so "may this Oxy
 *    account act for this store" is answered by the middleware #85 and every
 *    other admin surface already use, before a referral module runs;
 *  - the self mount passes `getRequiredOxyUserId(req)`, where the owner IS the
 *    authenticated caller and there is no question to ask.
 *
 * That is deliberately not `if (req.store) … else …`. A handler that INFERRED
 * its owner from whichever field happened to be populated would be one mount
 * away from reading a store id on a route that never authorized one, and the
 * whole reason increment 1 left the tax route unmounted was to avoid answering
 * this question a second time. Passing it in makes the answer the router's,
 * visibly, at the line where the permission is named.
 *
 * `referral-enrollment-isolation.test.ts` fails the build if anything in this
 * domain learns to read a role matrix, a permission array or a store
 * membership.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { ReferralPartnerOwnerType } from '@mercaria/shared-types';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';
import { getDb } from '../db/postgres.js';
import { findPartnerByOwner } from '../db/referrals/partnerRepository.js';
import {
  startPartnerApplication,
  submitPartnerApplication,
  withdrawPartnerApplication,
} from '../services/referrals/enrollment.service.js';
import { openPartnerAppeal } from '../services/referrals/application-review.service.js';
import { readPartnerStanding } from '../services/referrals/partner-standing.service.js';
import {
  acceptPartnerTerms,
  setReferralMarketingConsent,
  toReferralTermsAcceptanceView,
} from '../services/referrals/terms.service.js';
import { declareTaxProfile, readTaxProfile } from '../services/referrals/tax-profile.service.js';
import { validateBody } from '../middleware/validate.js';
import {
  referralAppealSchema,
  referralApplicationSchema,
  referralMarketingConsentSchema,
  referralTaxProfileSchema,
  referralTermsAcceptanceSchema,
  type ReferralAppealBody,
  type ReferralApplicationBody,
  type ReferralMarketingConsentBody,
  type ReferralTaxProfileBody,
  type ReferralTermsAcceptanceBody,
} from '../middleware/referral-partner-schemas.js';
import { sendSuccess } from '../utils/api-response.js';

/** Which partner this request is about. Supplied by the MOUNT, never a body. */
export interface ReferralPartnerOwner {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
}

/** How a mount answers "whose partner record is this". */
export type ReferralPartnerOwnerResolver = (req: Request) => ReferralPartnerOwner;

/**
 * A display name for an owner who has none yet.
 *
 * Only ever used when the record is being CREATED and the applicant supplied
 * none; a partner who already exists keeps theirs. It is deliberately not read
 * from an Oxy profile or a store name: ADR 0003 D15 says Mercaria mirrors no
 * profile, and copying a store's trading name into a public disclosure surface
 * is a decision the merchant should make rather than one this route makes for
 * them.
 */
function fallbackDisplayName(owner: ReferralPartnerOwner): string {
  return owner.ownerType === 'store' ? 'Store partner' : 'Partner';
}

/**
 * Build the partner router for one owner resolution.
 *
 * NINE routes and no tenth. Everything a partner may do about their own
 * standing, and nothing about anybody else's — there is no route that takes a
 * partner id, no route that reads another partner, and no route that could
 * grant a permission.
 */
export function makeReferralPartnerRouter(resolveOwner: ReferralPartnerOwnerResolver): Router {
  const router = Router({ mergeParams: true });

  /** Everything this owner's partner surface renders. */
  router.get('/', async (req: Request, res: Response) => {
    try {
      sendSuccess(res, await readPartnerStanding(resolveOwner(req)));
    } catch (err) {
      respondWithError(res, err, 'Failed to read referral partner standing');
    }
  });

  /** Start or update the DRAFT application. Idempotent per owner. */
  router.post('/application', validateBody(referralApplicationSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const body = req.body as ReferralApplicationBody;
      await startPartnerApplication({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        displayName: body.displayName ?? fallbackDisplayName(owner),
        ...(body.enrollmentMode !== undefined ? { enrollmentMode: body.enrollmentMode } : {}),
        actorOxyUserId: getRequiredOxyUserId(req),
        answers: body,
      });
      // The whole standing rather than the row that moved: a draft save changes
      // what is outstanding, and a client that had to re-fetch to find out
      // would render a stale checklist for one paint.
      sendSuccess(res, await readPartnerStanding(owner));
    } catch (err) {
      respondWithError(res, err, 'Failed to save the referral partner application');
    }
  });

  /** Submit it for a decision. */
  router.post('/application/submit', async (req: Request, res: Response) => {
    try {
      const owner = resolveOwner(req);
      await submitPartnerApplication({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        actorOxyUserId: getRequiredOxyUserId(req),
      });
      sendSuccess(res, await readPartnerStanding(owner));
    } catch (err) {
      respondWithError(res, err, 'Failed to submit the referral partner application');
    }
  });

  /** Close it. A new one may be started afterwards. */
  router.post('/application/withdraw', async (req: Request, res: Response) => {
    try {
      const owner = resolveOwner(req);
      await withdrawPartnerApplication({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        actorOxyUserId: getRequiredOxyUserId(req),
      });
      sendSuccess(res, await readPartnerStanding(owner));
    } catch (err) {
      respondWithError(res, err, 'Failed to withdraw the referral partner application');
    }
  });

  /** Accept a terms document. The VERSION is the whole request. */
  router.post('/terms', validateBody(referralTermsAcceptanceSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const partner = await requirePartner(owner);
      const body = req.body as ReferralTermsAcceptanceBody;
      const { acceptance, created } = await acceptPartnerTerms({
        partnerId: partner.id,
        scope: body.scope,
        termsVersion: body.termsVersion,
        ...(body.programId !== undefined ? { programId: body.programId } : {}),
        locale: body.locale,
        actorOxyUserId: getRequiredOxyUserId(req),
      });
      sendSuccess(res, {
        acceptance: toReferralTermsAcceptanceView(acceptance),
        // `false` means this version was already accepted, which is a success:
        // #146 terms rule 4 requires re-acceptance only on a MATERIAL new
        // version, so a client that sends the same one twice is not wrong.
        recorded: created,
      });
    } catch (err) {
      respondWithError(res, err, 'Failed to record the terms acceptance');
    }
  });

  /** Marketing consent — separate from terms, and revocable. */
  router.post('/marketing-consent', validateBody(referralMarketingConsentSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const partner = await requirePartner(owner);
      const body = req.body as ReferralMarketingConsentBody;
      const row = await setReferralMarketingConsent({
        partnerId: partner.id,
        granted: body.granted,
        actorOxyUserId: getRequiredOxyUserId(req),
      });
      sendSuccess(res, { marketingConsent: row.marketingConsentAt !== null });
    } catch (err) {
      respondWithError(res, err, 'Failed to record the marketing consent');
    }
  });

  /** What this partner has declared for tax, and what the gate makes of it. */
  router.get('/tax-profile', async (req: Request, res: Response) => {
    try {
      const partner = await requirePartner(resolveOwner(req));
      sendSuccess(res, await readTaxProfile(partner.id));
    } catch (err) {
      respondWithError(res, err, 'Failed to read the tax profile');
    }
  });

  /**
   * ADR 0005 D15 gate 2, reaching a caller for the first time.
   *
   * Increment 1 built `declareTaxProfile` complete and left it unmounted, for
   * one stated reason: "which Oxy account may declare for a `store` partner is
   * the `store:manage` question #85 answers, and answering it here would be a
   * second answer". This route does not answer it — the STORE mount does, with
   * `requireStorePermission('store:manage')`, and the self mount has no
   * question to ask. Until this existed, tax readiness was `pending` for every
   * partner and the payout gate blocked every batch.
   */
  router.post('/tax-profile', validateBody(referralTaxProfileSchema), async (req, res) => {
    try {
      const partner = await requirePartner(resolveOwner(req));
      const body = req.body as ReferralTaxProfileBody;
      sendSuccess(
        res,
        await declareTaxProfile({
          partnerId: partner.id,
          participantType: body.participantType,
          residencyCountry: body.residencyCountry,
          vatStatus: body.vatStatus,
          declaredByOxyUserId: getRequiredOxyUserId(req),
        }),
      );
    } catch (err) {
      respondWithError(res, err, 'Failed to record the tax declaration');
    }
  });

  /** Appeal a suspension or a termination (#146 review rule 5). */
  router.post('/appeal', validateBody(referralAppealSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const partner = await requirePartner(owner);
      const body = req.body as ReferralAppealBody;
      await openPartnerAppeal({
        partnerId: partner.id,
        actorOxyUserId: getRequiredOxyUserId(req),
        reason: body.reason,
      });
      sendSuccess(res, await readPartnerStanding(owner));
    } catch (err) {
      respondWithError(res, err, 'Failed to open the appeal');
    }
  });

  return router;
}

/**
 * The owner's partner record, or a 404.
 *
 * Note what this does NOT do: it takes an OWNER and never a partner id, so
 * there is no request on this surface that could reach a record belonging to
 * somebody else. That is the same device `orderAccessSubjectForCommerceActor`
 * uses — the refusal is the SIGNATURE rather than a check.
 */
async function requirePartner(owner: ReferralPartnerOwner) {
  const partner = await findPartnerByOwner(getDb(), owner);
  if (!partner) throw notFound('Referral partner not found');
  return partner;
}
