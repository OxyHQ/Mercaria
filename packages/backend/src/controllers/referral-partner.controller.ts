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
import {
  referralInstrumentRetireSchema,
  referralIssueCodeSchema,
  referralIssueLinkSchema,
  referralPerformanceQuerySchema,
  type ReferralInstrumentRetireBody,
  type ReferralIssueCodeBody,
  type ReferralIssueLinkBody,
} from '../middleware/referral-dashboard-schemas.js';
import {
  assertOwnsCode,
  assertOwnsLink,
  readPartnerInstruments,
  readReferralPartnerDashboard,
} from '../services/referrals/dashboard/dashboard.service.js';
import {
  defaultPerformanceWindow,
  readPartnerPerformance,
} from '../services/referrals/dashboard/performance.service.js';
import { readPartnerEarnings } from '../services/referrals/dashboard/earnings.service.js';
import { issueCode, issueLink, retireCode, revokeLink } from '../services/referrals/instrument.service.js';
import { projectCode, projectLink } from '../services/referrals/read.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { referralEnforcementAppealSchema } from '../middleware/referral-schemas.js';
import {
  getReferralConductPolicyHandler,
  getReferralDisclosuresHandler,
  makeReferralEnforcementPartnerHandlers,
} from './referral-integrity.controller.js';

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
 * TWENTY-TWO routes and no twenty-third — #146's nine, #148's four and
 * #147's nine. Everything a partner may do about their own standing, conduct,
 * instruments and earnings, and nothing about anybody else's. There is no route
 * that takes a partner id, no route that reads another partner, and no route
 * that could grant a permission; the two #147 routes that take an INSTRUMENT id
 * compare it against the owner the mount supplied and answer one
 * indistinguishable 404 for "not yours" and "does not exist", which is the same
 * refusal #148's enforcement appeal gives for the same reason.
 *
 * #148's first two of four require NO partner record at all: it asks that the rules be
 * "visible before participation", and gating them behind enrollment would make
 * that requirement unmeetable by construction.
 *
 * ## What #147 deliberately did not add here
 *
 * No `GET /partners/:id`, no `GET /dashboard?partnerId=`, no export of another
 * partner's figures and no "compare me to other partners" — every one of them
 * would be the third way of deciding whose earnings these are, which is exactly
 * what passing the owner in as a parameter exists to prevent.
 */
export function makeReferralPartnerRouter(resolveOwner: ReferralPartnerOwnerResolver): Router {
  const router = Router({ mergeParams: true });
  const integrity = makeReferralEnforcementPartnerHandlers(resolveOwner);

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

  // ── Integrity (#148) ──────────────────────────────────────────────────────

  /**
   * The prohibited-conduct policy, visible BEFORE participation.
   *
   * No partner record is required and none is read. `null` when nothing is
   * published, which is an honest absence rather than an invented policy — a
   * built-in default would be a rule people are held to that nobody authored.
   */
  router.get('/conduct', getReferralConductPolicyHandler);

  /** The disclosure copy for a market and language. Also pre-participation. */
  router.get('/disclosures', getReferralDisclosuresHandler);

  /**
   * The actions against this partner, and their appeals.
   *
   * Through `ReferralEnforcementPartnerView` — a different TYPE from the
   * operator's, not a filtered one — so no operator identity, no evidence id,
   * no subject id and no basis can reach it without failing `tsc`.
   */
  router.get('/enforcement', integrity.list);

  /**
   * Open an appeal against ONE action.
   *
   * The action must belong to this partner; somebody else's is answered with
   * the SAME 404 as a missing one, because a distinguishable response is an
   * enumeration oracle over every partner's enforcement record.
   */
  router.post(
    '/enforcement/:actionId/appeal',
    validateBody(referralEnforcementAppealSchema),
    integrity.appeal,
  );

  // ─── #147: the dashboard, the tools and the numbers ───────────────────────

  /**
   * Everything the dashboard renders, in ONE read.
   *
   * Server-composed for #71's reason: the parts are separate pages in separate
   * orders over separate tables, and a client joining them drops whatever fell
   * outside its own window — as a hole in a figure somebody is being paid on.
   */
  router.get('/dashboard', async (req: Request, res: Response) => {
    try {
      sendSuccess(res, await readReferralPartnerDashboard(resolveOwner(req)));
    } catch (err) {
      respondWithError(res, err, 'Failed to read the referral partner dashboard');
    }
  });

  /**
   * One breakdown, by ONE dimension.
   *
   * A POST rather than a GET with query parameters, because the request is
   * validated by a `.strict()` schema and `validateBody` is what runs one — and
   * because a strict schema is the whole of how "no cross-tabs" is enforced: an
   * array of dimensions is unrepresentable rather than ignored. It reads and
   * writes nothing.
   */
  router.post('/performance', validateBody(referralPerformanceQuerySchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const partner = await requirePartner(owner);
      const body = req.body as { dimension: Parameters<typeof readPartnerPerformance>[0]['dimension']; from: string; through: string };
      sendSuccess(
        res,
        await readPartnerPerformance({
          partnerId: partner.id,
          dimension: body.dimension,
          from: body.from,
          through: body.through,
        }),
      );
    } catch (err) {
      respondWithError(res, err, 'Failed to read referral performance');
    }
  });

  /** The trailing 30 days by date — what a first paint needs with no body. */
  router.get('/performance', async (req: Request, res: Response) => {
    try {
      const partner = await requirePartner(resolveOwner(req));
      const window = defaultPerformanceWindow();
      sendSuccess(
        res,
        await readPartnerPerformance({ partnerId: partner.id, dimension: 'date', ...window }),
      );
    } catch (err) {
      respondWithError(res, err, 'Failed to read referral performance');
    }
  });

  /** Earnings by state and currency, plus the rows ADR 0005 A5 permits. */
  router.get('/earnings', async (req: Request, res: Response) => {
    try {
      const partner = await requirePartner(resolveOwner(req));
      sendSuccess(res, await readPartnerEarnings(partner.id));
    } catch (err) {
      respondWithError(res, err, 'Failed to read referral earnings');
    }
  });

  /** The partner's own instruments, paged. */
  router.get('/instruments', async (req: Request, res: Response) => {
    try {
      const before = typeof req.query.before === 'string' ? new Date(req.query.before) : undefined;
      sendSuccess(
        res,
        await readPartnerInstruments(resolveOwner(req), {
          ...(before && !Number.isNaN(before.getTime()) ? { before } : {}),
        }),
      );
    } catch (err) {
      respondWithError(res, err, 'Failed to read referral instruments');
    }
  });

  /**
   * Create a code.
   *
   * The body names a destination TYPE and the destination's own id, never a
   * URL — #143's redirect composes the destination from a configured origin and
   * takes nothing from a request, so an arbitrary-redirect injector has no
   * field to arrive in. The service is what decides the final code string,
   * because ADR 0005 D3 makes codes globally unique case-insensitively.
   */
  router.post('/codes', validateBody(referralIssueCodeSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const partner = await requirePartner(owner);
      const body = req.body as ReferralIssueCodeBody;
      const row = await issueCode({
        partnerId: partner.id,
        programId: body.programId,
        ...(body.requestedCode !== undefined ? { requestedCode: body.requestedCode } : {}),
        context: {
          ...(body.destinationType !== undefined ? { destinationType: body.destinationType } : {}),
          ...(body.destinationRef !== undefined ? { destinationRef: body.destinationRef } : {}),
          ...(body.campaignRef !== undefined ? { campaignRef: body.campaignRef } : {}),
          ...(body.contentKey !== undefined ? { contentKey: body.contentKey } : {}),
          ...(body.market !== undefined ? { market: body.market } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
        },
      });
      sendSuccess(res, { code: projectCode(row) }, 201);
    } catch (err) {
      respondWithError(res, err, 'Failed to create the referral code');
    }
  });

  /** Create a link under a code this owner holds. */
  router.post('/links', validateBody(referralIssueLinkSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const body = req.body as ReferralIssueLinkBody;
      // Ownership FIRST: the code id arrives from the client, so this is the
      // one place in the domain where an id is compared rather than derived.
      await assertOwnsCode(owner, body.codeId);
      const row = await issueLink({
        codeId: body.codeId,
        context: {
          ...(body.destinationType !== undefined ? { destinationType: body.destinationType } : {}),
          ...(body.destinationRef !== undefined ? { destinationRef: body.destinationRef } : {}),
          ...(body.campaignRef !== undefined ? { campaignRef: body.campaignRef } : {}),
          ...(body.contentKey !== undefined ? { contentKey: body.contentKey } : {}),
        },
      });
      sendSuccess(res, { link: projectLink(row) }, 201);
    } catch (err) {
      respondWithError(res, err, 'Failed to create the referral link');
    }
  });

  /**
   * Retire a code.
   *
   * ADR 0005 D3: retiring stops a code attributing and keeps its row and its
   * reservation permanently. There is deliberately no DELETE and no "reissue" —
   * a recycled code would let a new owner inherit another partner's history.
   */
  router.post('/codes/:codeId/retire', validateBody(referralInstrumentRetireSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const codeId = req.params.codeId as string;
      await assertOwnsCode(owner, codeId);
      const row = await retireCode({
        codeId,
        actorKind: 'partner',
        actorRef: getRequiredOxyUserId(req),
        reason: (req.body as ReferralInstrumentRetireBody).reason,
      });
      sendSuccess(res, { code: projectCode(row) });
    } catch (err) {
      respondWithError(res, err, 'Failed to retire the referral code');
    }
  });

  /** Revoke a link. The code it wraps is untouched. */
  router.post('/links/:linkId/revoke', validateBody(referralInstrumentRetireSchema), async (req, res) => {
    try {
      const owner = resolveOwner(req);
      const linkId = req.params.linkId as string;
      await assertOwnsLink(owner, linkId);
      const row = await revokeLink({
        linkId,
        actorKind: 'partner',
        actorRef: getRequiredOxyUserId(req),
        reason: (req.body as ReferralInstrumentRetireBody).reason,
      });
      sendSuccess(res, { link: projectLink(row) });
    } catch (err) {
      respondWithError(res, err, 'Failed to revoke the referral link');
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
