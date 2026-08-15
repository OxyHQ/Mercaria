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
  findLinkById,
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
 * A link resolved to its live facts, with NOTHING written.
 *
 * Split out for #143's redirect (`redirect.service.ts`), which must answer
 * "where does this go, and may it go there" for a request that has no subject
 * to attribute — an anonymous click. ADR 0003 T10 forbids minting a session
 * merely to have somewhere to write, so the redirect resolves, hands the
 * evidence to the browser in a purpose-specific carrier, and the touch is
 * written later against the real subject.
 */
export interface ResolvedReferralLink {
  linkId: string;
  code: ReferralCodeRow;
  version: ReferralProgramRow;
  destination: ReferralDestination;
  destinationPath: string;
  disclosureRequired: boolean;
  campaignRef?: string;
  contentKey?: string;
}

/**
 * Resolve a signed link token against its row, writing nothing.
 *
 * Order matters and is deliberate: signature first (stateless, refuses garbage
 * before any read), then the ROW's lifecycle (the authority — a revoked link
 * must die immediately whatever its token says), then the code, then the
 * program gate.
 *
 * The click-limit CLAIM is deliberately not here: it is a write, and only the
 * caller knows whether this request has earned one (a scanner has not).
 */
export async function resolveReferralLink(
  db: DatabaseOrTransaction,
  token: string,
  at: Date,
): Promise<ResolvedReferralLink> {
  const claims = verifyReferralLinkToken(token);
  const link = await findLinkByToken(db, token);
  if (!link || link.id !== claims.linkId || link.codeId !== claims.codeId) {
    // A verified signature over ids that resolve to nothing: a link from a
    // database this deployment does not serve, or a revoked-and-swept row.
    throw notFound('Referral link not found');
  }
  if (link.status !== 'active') {
    throw conflict(`The referral link is ${link.status}`);
  }
  if (link.expiresAt !== null && link.expiresAt.getTime() <= at.getTime()) {
    throw conflict('The referral link has expired');
  }

  const code = await findCodeById(db, link.codeId);
  if (!code) throw notFound('Referral code not found');
  const { version } = await requireTouchable(db, code, at);

  const destination: ReferralDestination =
    link.destinationType !== null
      ? { destinationType: link.destinationType, destinationRef: link.destinationRef ?? undefined }
      : code.destinationType !== null
        ? { destinationType: code.destinationType, destinationRef: code.destinationRef ?? undefined }
        : { destinationType: 'home' };

  return {
    linkId: link.id,
    code,
    version,
    destination,
    destinationPath: referralDestinationPath(destination),
    disclosureRequired: link.disclosureRequired,
    campaignRef: link.campaignRef ?? code.campaignRef ?? undefined,
    contentKey: link.contentKey ?? code.contentKey ?? undefined,
  };
}

/**
 * Claim one click against a link's ceiling.
 *
 * `false` means the ceiling is reached (or the row left `active` between the
 * resolve and here). Separated from {@link resolveReferralLink} so a
 * non-organic request can be redirected WITHOUT spending a partner's budget —
 * a scanner that burned a limited link's last click would cost the partner the
 * campaign, silently.
 */
export async function claimReferralLinkClick(
  db: DatabaseOrTransaction,
  linkId: string,
): Promise<boolean> {
  const claimed = await claimLinkClick(db, linkId);
  return claimed !== undefined;
}

/**
 * Register a link touch for a click that has ALREADY been resolved and claimed
 * — #143's deferred binding, where the click happened while the visitor was
 * anonymous and a subject appeared later.
 *
 * The lifecycle is re-checked here rather than trusted from the carrier: a link
 * revoked between the click and the bind must not produce a touch, and the
 * carrier is signed evidence of a click, never a licence to write one.
 */
export async function registerLinkTouch(input: {
  linkId: string;
  codeId: string;
  /** The CLICK instant, from the signed carrier — never the bind's clock. */
  occurredAt: Date;
  context: TouchContext;
}): Promise<{ touch: ReferralTouchRow; disclosureRequired: boolean; version: ReferralProgramRow }> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const link = await findLinkById(tx, input.linkId);
    if (!link || link.codeId !== input.codeId) throw notFound('Referral link not found');
    if (link.status !== 'active') throw conflict(`The referral link is ${link.status}`);

    const code = await findCodeById(tx, link.codeId);
    if (!code) throw notFound('Referral code not found');
    // The program gate reads the clock at BIND time: a program retired between
    // the click and the bind registers nothing, which is D18's prospective
    // gating rather than a grandfathered click.
    const at = input.context.at ?? new Date();
    const { version } = await requireTouchable(tx, code, at);

    const destination: ReferralDestination =
      link.destinationType !== null
        ? { destinationType: link.destinationType, destinationRef: link.destinationRef ?? undefined }
        : code.destinationType !== null
          ? { destinationType: code.destinationType, destinationRef: code.destinationRef ?? undefined }
          : { destinationType: 'home' };

    const touch = await writeTouch(tx, {
      version,
      code,
      linkId: link.id,
      touchKind: 'link_click',
      destination,
      context: input.context,
      // The CLICK is when the touch happened. Stamping the bind's clock would
      // let a browser holding a carrier for four weeks re-anchor a 30-day
      // window every time it presented one — #143 web rule 7, in the one place
      // it could actually go wrong.
      at: input.occurredAt,
      campaignRef: link.campaignRef ?? code.campaignRef ?? undefined,
      contentKey: link.contentKey ?? code.contentKey ?? undefined,
    });
    return { touch, disclosureRequired: link.disclosureRequired, version };
  });
}

/**
 * Resolve a signed link token and register the click as a touch, in one
 * transaction — the path for a click whose request ALREADY carries a subject
 * (a signed-in shopper, or a native client presenting its guest credential).
 *
 * Nothing is deferred in that case: there is a subject, so the evidence lands
 * where ADR 0005 D6 says it should immediately and no carrier is needed.
 */
export async function resolveLinkAndRegisterTouch(
  token: string,
  context: TouchContext,
): Promise<LinkResolution> {
  const at = context.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const resolved = await resolveReferralLink(tx, token, at);
    if (!(await claimReferralLinkClick(tx, resolved.linkId))) {
      throw conflict('The referral link is at its click limit');
    }

    const touch = await writeTouch(tx, {
      version: resolved.version,
      code: resolved.code,
      linkId: resolved.linkId,
      touchKind: 'link_click',
      destination: resolved.destination,
      context,
      at,
      campaignRef: resolved.campaignRef,
      contentKey: resolved.contentKey,
    });

    return {
      destinationPath: resolved.destinationPath,
      touch,
      disclosureRequired: resolved.disclosureRequired,
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
