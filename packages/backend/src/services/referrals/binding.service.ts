/**
 * Binding — turning carried click evidence, or a typed code, into a touch and
 * then into an attribution (#143 web, native, code, guest and merchant rules).
 *
 * ## The one place a subject enters the referral domain
 *
 * Everything upstream is subject-free: a signed link token names two row ids, a
 * carrier names the same two plus an instant, a code names itself. This module
 * is where a resolved `CommerceActor` becomes ADR 0005 D6's checkout scope or
 * D5's Oxy account, and it is the only module in the edge that reads one.
 *
 * `touchActorFor` is the whole translation and it is a `switch` over a union
 * with no common `id` field — so an anonymous visitor cannot acquire a subject,
 * ADR 0003 T10's "browsing creates no row" survives whoever edits this next,
 * and `pending` is an ordinary answer rather than an error.
 *
 * ## Why binding is a separate act from clicking
 *
 * ADR 0005 D6 stores a guest touch against the checkout scope; ADR 0003 T10
 * forbids minting one for a page view. A click by a stranger therefore has no
 * subject and cannot be written. Deferring it is not a workaround for that — it
 * is the only reading under which both rules hold, and it has a second
 * property worth naming: a crawler, a link unfurler and a prefetch produce no
 * rows at all, so the evidence store contains touches by people.
 *
 * ## Last touch wins, and the code always wins
 *
 * Neither rule is implemented here. `attribution.service.ts` (#142) resolves
 * the winner under ADR 0005 D4, and a typed code beats a stale click for the
 * structural reason D4 gives: code entry IS a touch and is by construction the
 * latest one. This module's only contribution to that is honesty about WHEN a
 * touch happened — a carried click is stamped with its CLICK instant, never
 * the bind's, so presenting a four-week-old carrier cannot jump the queue.
 *
 * ## What can never reach it
 *
 * There is no parameter here for an email, a hash, a phone number, a card
 * fingerprint, a Stripe customer, a wallet identity, an IP or a device
 * signature, and no function it calls takes one. That is ADR 0005 A2 and
 * #143's guest rules 7 and 10 held by the signatures rather than by a check —
 * "separate guest checkouts remain separate even when contact or payment
 * details match" is true because nothing here can observe that they match.
 */

import type {
  ReferralBindingRefusalReason,
  ReferralBindingResult,
  ReferralClientSurface,
  ReferralCodeEntryMoment,
  ReferralConsentMode,
  ReferralTrafficClass,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { MERCHANT_CLAIM_ACTIVE_STATES } from '@mercaria/shared-types';
import { findClaimsByClaimant } from '../../db/merchant-claims/merchantClaimRepository.js';
import { resolveProgramControls } from '../../db/referrals/programControlRepository.js';
import { findProgramVersionById } from '../../db/referrals/programRepository.js';
import type { CommerceActor } from '../commerce-actor.js';
import { attributeTouch } from './attribution.service.js';
import {
  registerCodeTouch,
  registerLinkTouch,
  type TouchActor,
} from './touch.service.js';
import { verifyReferralState, type ReferralStateClaims } from './referral-state.js';

/**
 * The ONE translation from a resolved `CommerceActor` to a touch actor.
 *
 * `CommerceActor` has no common `id` field (ADR 0003 I1), so the compiler
 * forces this switch and an anonymous visitor can never acquire a subject
 * reference — the `cartOwnerForActor` (#104) and `addressBookOwnerForActor`
 * (#105) device, one domain over. `null` is "no subject", which is a real and
 * ordinary state here rather than a failure.
 *
 * It lives in the BINDING module because binding is the only thing that needs
 * a subject; the redirect imports it from here rather than the other way
 * round, so there is no cycle and no second spelling.
 */
export function touchActorFor(actor: CommerceActor): TouchActor | null {
  switch (actor.kind) {
    case 'oxy':
      return { kind: 'oxy_user', ref: actor.oxyUserId };
    case 'guest':
      // ADR 0005 D6's checkout-scoped id: #103's guest SESSION row id, stable
      // across a token rotation (rotation swaps `token_hash` in place), which
      // is what makes "session rotation must not duplicate or lose a valid
      // attribution" true by construction rather than by a merge rule.
      return { kind: 'guest_session', ref: actor.guestSessionId };
    case 'anonymous':
      return null;
  }
}

/** How many of a claimant's claims are examined when binding a merchant. */
const MERCHANT_CLAIM_SCAN_LIMIT = 50;

/** The request context a bind runs under. */
export interface ReferralBindContext {
  actor: CommerceActor;
  clientSurface: ReferralClientSurface;
  consentMode: ReferralConsentMode;
  trafficClass: ReferralTrafficClass;
  at: Date;
}

/** A refusal that carries no partner, program or code — the bounded vocabulary. */
function refuse(
  reason: ReferralBindingRefusalReason,
  disclosureRequired = false,
): ReferralBindingResult {
  return { state: reason === 'no_subject' ? 'pending' : 'none', reason, disclosureRequired };
}

/**
 * Bind a CARRIED click — the web and native deferred path.
 *
 * Returns `pending` for an anonymous caller and writes nothing: the carrier
 * stays with the browser and the next request that has a subject binds it. That
 * is not a failure state and the client renders nothing about it.
 */
export async function bindCarriedReferral(input: {
  stateToken: string | undefined;
  context: ReferralBindContext;
}): Promise<ReferralBindingResult & { redeemed: boolean }> {
  const claims = verifyReferralState(input.stateToken, input.context.at);
  if (claims === null) {
    return { ...refuse('state_unusable'), redeemed: false };
  }
  if (input.context.trafficClass !== 'organic') {
    // A carrier presented by something classified non-organic produces nothing
    // and is NOT redeemed: a preview fetch that consumed somebody's carrier
    // would lose them the attribution they clicked for.
    return { ...refuse('traffic_not_organic'), redeemed: false };
  }
  const actor = touchActorFor(input.context.actor);
  if (actor === null) {
    return { ...refuse('no_subject'), redeemed: false };
  }

  const registered = await registerLinkTouchFor(claims, input.context);
  if (registered === null) {
    // The link or its program stopped being usable between the click and now.
    // The carrier IS redeemed: re-presenting it would refuse identically every
    // request from here on, and a browser retrying forever is worse than a
    // click that quietly expired.
    return { ...refuse('instrument_unusable'), redeemed: true };
  }

  const outcome = await attributeRecordedTouch(registered.touchId, registered.programVersionId);
  return { ...outcome, disclosureRequired: registered.disclosureRequired, redeemed: true };
}

/** Register a carried click, answering `null` for every "no longer usable". */
async function registerLinkTouchFor(
  claims: ReferralStateClaims,
  context: ReferralBindContext,
): Promise<{ touchId: string; programVersionId: string; disclosureRequired: boolean } | null> {
  const actor = touchActorFor(context.actor);
  if (actor === null) return null;
  try {
    const registered = await registerLinkTouch({
      linkId: claims.linkId,
      codeId: claims.codeId,
      // The CLICK instant, from the signed carrier. #143 web rule 7.
      occurredAt: claims.clickedAt,
      context: {
        actor,
        clientSurface: context.clientSurface,
        consentMode: context.consentMode,
        trafficClass: context.trafficClass,
        at: context.at,
      },
    });
    return {
      touchId: registered.touch.id,
      programVersionId: registered.version.id,
      disclosureRequired: registered.disclosureRequired,
    };
  } catch {
    // A revoked link, a retired program, a code past its expiry. Every one is
    // an ordinary "this click is no longer worth anything", answered in the
    // bounded vocabulary rather than surfaced as a 409 a client would retry.
    return null;
  }
}

/**
 * Bind a code the buyer TYPED — the explicit act, recorded separately from a
 * passive link touch (#143 code rule 7) because the touch KIND distinguishes
 * them and the operator trace needs to.
 *
 * `at_checkout` and `in_app` are ADR 0005 D4's two code kinds. There is no
 * `at_registration`: Mercaria's registration is Oxy's, and a touch nothing here
 * observed is one this domain must not claim to have seen.
 */
export async function bindEnteredCode(input: {
  code: string;
  moment: ReferralCodeEntryMoment;
  context: ReferralBindContext;
}): Promise<ReferralBindingResult> {
  if (input.context.trafficClass !== 'organic') {
    return refuse('traffic_not_organic');
  }
  const actor = touchActorFor(input.context.actor);
  if (actor === null) {
    // A typed code needs a subject: there is nowhere to record it otherwise,
    // and inventing one is exactly what T10 forbids. The client's remedy is a
    // cart or a sign-in, which is the moment the code screen belongs to anyway.
    return refuse('no_subject');
  }

  let touchId: string;
  let programVersionId: string;
  try {
    const registered = await registerCodeTouch({
      code: input.code,
      touchKind: input.moment === 'at_checkout' ? 'code_entry_at_checkout' : 'code_entry_in_app',
      context: {
        actor,
        clientSurface: input.context.clientSurface,
        consentMode: input.context.consentMode,
        trafficClass: input.context.trafficClass,
        at: input.context.at,
      },
    });
    touchId = registered.touch.id;
    programVersionId = registered.touch.programVersionId;
  } catch {
    // An unknown, expired, paused or retired code — ONE answer for all of them.
    // #143 code rule 6: a refusal must not reveal private partner status, and a
    // distinguishable "that code exists but is paused" is an enumeration
    // oracle over every partner's instruments.
    return refuse('instrument_unusable');
  }

  return await attributeRecordedTouch(touchId, programVersionId);
}

/**
 * Bind a MERCHANT candidate — the merchant-referral path (#143 merchant rules).
 *
 * The candidate is not taken on the caller's word: they must hold a live claim
 * on that merchant (#83), so "a domain-verification claimant cannot steal an
 * existing merchant attribution silently" is answered in two layers. This one
 * refuses a caller who has no claim at all; the other is ADR 0005 D4's
 * last-touch supersession, which records the displacement as an auditable
 * `attribution_superseded` event rather than an overwrite.
 *
 * A later canonical merge is #142's `recordSubjectMerge`: both the loser's and
 * the winner's references resolve to one subject, so one adjudicated
 * attribution survives (#143 merchant rule 4, acceptance 7).
 */
export async function bindMerchantCandidate(input: {
  merchantId: string;
  stateToken: string | undefined;
  context: ReferralBindContext;
}): Promise<ReferralBindingResult> {
  if (input.context.actor.kind !== 'oxy') {
    // A merchant referral attributes an Oxy account's merchant candidate. A
    // guest cannot hold a claim, so there is nothing to bind.
    return refuse('merchant_not_bindable');
  }
  if (input.context.trafficClass !== 'organic') {
    return refuse('traffic_not_organic');
  }

  const db = getDb();
  const claims = await findClaimsByClaimant(
    db,
    input.context.actor.oxyUserId,
    MERCHANT_CLAIM_SCAN_LIMIT,
  );
  const holdsClaim = claims.some(
    (claim) =>
      claim.merchantId === input.merchantId &&
      (MERCHANT_CLAIM_ACTIVE_STATES as readonly string[]).includes(claim.state),
  );
  if (!holdsClaim) {
    return refuse('merchant_not_bindable');
  }

  const carried = verifyReferralState(input.stateToken, input.context.at);
  if (carried === null) {
    return refuse('state_unusable');
  }

  const actor = touchActorFor(input.context.actor);
  if (actor === null) return refuse('no_subject');

  let touchId: string;
  let programVersionId: string;
  let disclosureRequired = false;
  try {
    const registered = await registerLinkTouch({
      linkId: carried.linkId,
      codeId: carried.codeId,
      occurredAt: carried.clickedAt,
      context: {
        actor,
        clientSurface: input.context.clientSurface,
        consentMode: input.context.consentMode,
        trafficClass: input.context.trafficClass,
        merchantCandidateRef: input.merchantId,
        at: input.context.at,
      },
    });
    touchId = registered.touch.id;
    programVersionId = registered.version.id;
    disclosureRequired = registered.disclosureRequired;
  } catch {
    return refuse('instrument_unusable');
  }

  const outcome = await attributeRecordedTouch(touchId, programVersionId);
  return { ...outcome, disclosureRequired };
}

/**
 * Attribute a recorded touch, unless the program's attribution lever is down.
 *
 * The TOUCH is already written when this runs, and that ordering is the
 * decision: with attribution disabled the evidence still exists, so "we
 * received it and did not act on it" stays distinguishable from "it never
 * arrived" (ADR 0005 D16, D18). The lever is prospective and touches nothing
 * already attributed.
 *
 * Exported because the REDIRECT needs it too: a click by a request that already
 * carries a subject is resolved completely at click time, and there is exactly
 * one place that decides whether a recorded touch becomes a winner. Two would
 * be two answers to the lever.
 */
export async function attributeRecordedTouch(
  touchId: string,
  programVersionId: string,
): Promise<ReferralBindingResult> {
  const db = getDb();
  const version = await findProgramVersionById(db, programVersionId);
  if (!version) {
    return { state: 'recorded_not_attributed', reason: 'program_unavailable', disclosureRequired: false };
  }
  const controls = await resolveProgramControls(db, version.programId);
  if (!controls.attributionEnabled) {
    return {
      state: 'recorded_not_attributed',
      reason: 'program_unavailable',
      disclosureRequired: false,
    };
  }

  try {
    const outcome = await attributeTouch(touchId);
    if (outcome.outcome === 'refused') {
      return {
        state: 'recorded_not_attributed',
        reason: 'program_unavailable',
        disclosureRequired: false,
        publicTermsSummary: version.publicTermsSummary,
      };
    }
    return {
      state: 'attributed',
      disclosureRequired: false,
      publicTermsSummary: version.publicTermsSummary,
    };
  } catch {
    // The resolver throws for a touch outside its window, a subject kind the
    // program does not attribute, and a concurrent resolver winning the race.
    // All three are "the evidence exists and did not become a winner", which
    // is what `recorded_not_attributed` says.
    return {
      state: 'recorded_not_attributed',
      reason: 'program_unavailable',
      disclosureRequired: false,
    };
  }
}
