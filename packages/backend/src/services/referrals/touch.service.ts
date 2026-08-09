/**
 * Link resolution and touch registration (#142, API 4).
 *
 * A touch is NOT a conversion and cannot create earnings: this service writes
 * evidence rows and answers "where does this link point" — nothing more. The
 * attribution decision is a separate, explicit call (`attribution.service.ts`),
 * and the money path never reads a touch at all.
 *
 * ## Which program version a touch records
 *
 * The instrument pins the version it was ISSUED under; the touch records the
 * version LIVE when it happened — resolved through the stable program id — so
 * an attribution created from it pins the terms that were actually advertised
 * at touch time (ADR 0005 D19). A program with no active version (retired,
 * paused, between versions) registers no touches: prospective gating, exactly
 * as D18 describes.
 *
 * ## Privacy posture
 *
 * The actor is a pseudonymous guest-session reference (an opaque id from
 * #101/#103's subsystem — never imported, never joined) or an Oxy account id.
 * The traffic classification arrives from the caller's edge (bot/preview/
 * internal detection is #148's surface); a non-organic touch is STORED —
 * "we received it and ignored it" is a different fact from "it never arrived"
 * — and is never attribution-eligible.
 */

import type {
  ReferralActorKind,
  ReferralClientSurface,
  ReferralConsentMode,
  ReferralTouchKind,
  ReferralTrafficClass,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { RETENTION_SECONDS } from '../../db/expiryTargets.js';
import {
  findActiveProgramVersion,
  findProgramVersionById,
  type ReferralProgramRow,
} from '../../db/referrals/programRepository.js';
import {
  claimLinkClick,
  findCodeByCode,
  findCodeById,
  findLinkByToken,
  type ReferralCodeRow,
} from '../../db/referrals/instrumentRepository.js';
import { insertTouch, type ReferralTouchRow } from '../../db/referrals/touchRepository.js';
import { referralDestinationPath, type ReferralDestination } from './destinations.js';
import { verifyReferralLinkToken } from './link-token.js';

/** Who touched — exactly one identity, matching the closed actor set. */
export interface TouchActor {
  kind: ReferralActorKind;
  /** The guest-session ref or Oxy user id, per `kind`. */
  ref: string;
}

/** The caller-classified request context a touch is registered under. */
export interface TouchContext {
  actor: TouchActor;
  clientSurface: ReferralClientSurface;
  consentMode: ReferralConsentMode;
  trafficClass?: ReferralTrafficClass;
  merchantCandidateRef?: string;
  at?: Date;
}

/** What a resolved link answers: where to send the browser, and the recorded touch. */
export interface LinkResolution {
  /** A RELATIVE Mercaria path from the allow-list — never an absolute URL. */
  destinationPath: string;
  touch: ReferralTouchRow;
  disclosureRequired: boolean;
}

/**
 * Resolve a signed link token and register the click as a touch.
 *
 * Order matters and is deliberate: signature first (stateless, refuses
 * garbage before any read), then the ROW's lifecycle (the authority), then the
 * click-limit claim (one statement), then the program gate, then the touch.
 */
export async function resolveLinkAndRegisterTouch(
  token: string,
  context: TouchContext,
): Promise<LinkResolution> {
  const claims = verifyReferralLinkToken(token);
  const at = context.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const link = await findLinkByToken(tx, token);
    if (!link || link.id !== claims.linkId || link.codeId !== claims.codeId) {
      // A verified signature over ids that resolve to nothing: a link from a
      // database this deployment does not serve, or a revoked-and-swept row.
      throw notFound('Referral link not found');
    }
    if (link.expiresAt !== null && link.expiresAt.getTime() <= at.getTime()) {
      throw conflict('The referral link has expired');
    }
    const claimed = await claimLinkClick(tx, link.id);
    if (!claimed) {
      throw conflict(`The referral link is ${link.status === 'active' ? 'at its click limit' : link.status}`);
    }

    const code = await findCodeById(tx, link.codeId);
    if (!code) throw notFound('Referral code not found');
    const { version } = await requireTouchable(tx, code, at);

    const destination: ReferralDestination =
      claimed.destinationType !== null
        ? { destinationType: claimed.destinationType, destinationRef: claimed.destinationRef ?? undefined }
        : code.destinationType !== null
          ? { destinationType: code.destinationType, destinationRef: code.destinationRef ?? undefined }
          : { destinationType: 'home' };

    const touch = await writeTouch(tx, {
      version,
      code,
      linkId: claimed.id,
      touchKind: 'link_click',
      destination,
      context,
      at,
      campaignRef: claimed.campaignRef ?? code.campaignRef ?? undefined,
      contentKey: claimed.contentKey ?? code.contentKey ?? undefined,
    });

    return {
      destinationPath: referralDestinationPath(destination),
      touch,
      disclosureRequired: claimed.disclosureRequired,
    };
  });
}

/**
 * Register a code ENTRY touch — in-app or at checkout (the other two kinds of
 * ADR 0005 D4's closed set). Alias spellings resolve to their canonical code,
 * so an alias's touch is the canonical code's touch.
 */
export async function registerCodeTouch(input: {
  code: string;
  touchKind: Exclude<ReferralTouchKind, 'link_click'>;
  context: TouchContext;
}): Promise<{ touch: ReferralTouchRow; code: ReferralCodeRow }> {
  const at = input.context.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const entered = await findCodeByCode(tx, input.code);
    if (!entered) throw notFound('Referral code not found');
    const code =
      entered.aliasOfCodeId !== null ? await findCodeById(tx, entered.aliasOfCodeId) : entered;
    if (!code) throw notFound('Referral code not found');
    if (entered.status !== 'active') {
      throw conflict(`The referral code is ${entered.status}`);
    }
    const { version } = await requireTouchable(tx, code, at);

    const destination: ReferralDestination =
      code.destinationType !== null
        ? { destinationType: code.destinationType, destinationRef: code.destinationRef ?? undefined }
        : { destinationType: 'home' };

    const touch = await writeTouch(tx, {
      version,
      code,
      touchKind: input.touchKind,
      destination,
      context: input.context,
      at,
      campaignRef: code.campaignRef ?? undefined,
      contentKey: code.contentKey ?? undefined,
    });
    return { touch, code };
  });
}

/** The gate a touch passes: code usable, program has a LIVE version. */
async function requireTouchable(
  db: DatabaseOrTransaction,
  code: ReferralCodeRow,
  at: Date,
): Promise<{ version: ReferralProgramRow }> {
  if (code.status !== 'active') {
    throw conflict(`The referral code is ${code.status}`);
  }
  if (code.expiresAt !== null && code.expiresAt.getTime() <= at.getTime()) {
    throw conflict('The referral code has expired');
  }
  const issuedUnder = await findProgramVersionById(db, code.programVersionId);
  if (!issuedUnder) throw notFound('Referral program version not found');
  const version = await findActiveProgramVersion(db, issuedUnder.programId);
  if (!version) {
    throw conflict('The referral program is not currently active');
  }
  return { version };
}

/** Compose and insert the touch row — window and retention stamped here, once. */
async function writeTouch(
  db: DatabaseOrTransaction,
  input: {
    version: ReferralProgramRow;
    code: ReferralCodeRow;
    linkId?: string;
    touchKind: ReferralTouchKind;
    destination: ReferralDestination;
    context: TouchContext;
    at: Date;
    campaignRef?: string;
    contentKey?: string;
  },
): Promise<ReferralTouchRow> {
  const { actor } = input.context;
  if (actor.ref.trim().length === 0) {
    throw validationError('A touch actor reference cannot be empty');
  }
  const windowMs = input.version.attributionWindowDays * 24 * 60 * 60 * 1_000;
  const attributionWindowExpiresAt = new Date(input.at.getTime() + windowMs);
  const expiresAt = new Date(
    attributionWindowExpiresAt.getTime() + RETENTION_SECONDS.referralTouchEvidenceMargin * 1_000,
  );
  return await insertTouch(db, {
    programVersionId: input.version.id,
    partnerId: input.code.partnerId,
    codeId: input.code.id,
    linkId: input.linkId,
    touchKind: input.touchKind,
    occurredAt: input.at,
    clientSurface: input.context.clientSurface,
    destinationType: input.destination.destinationType,
    destinationRef: input.destination.destinationRef,
    actorKind: actor.kind,
    guestSessionRef: actor.kind === 'guest_session' ? actor.ref : undefined,
    oxyUserId: actor.kind === 'oxy_user' ? actor.ref : undefined,
    merchantCandidateRef: input.context.merchantCandidateRef,
    trafficClass: input.context.trafficClass ?? 'organic',
    consentMode: input.context.consentMode,
    attributionWindowExpiresAt,
    campaignRef: input.campaignRef,
    contentKey: input.contentKey,
    expiresAt,
  });
}
