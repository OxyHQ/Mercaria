/**
 * Instrument issuance (#142, API 3): codes, vanity aliases and signed links.
 *
 * ## The approval gate (issue #142, identity/uniqueness 8)
 *
 * "A partner cannot issue instruments for a program it is not approved for."
 * Enforced here, at issuance, on three conjuncts: the partner's enrollment
 * state is `approved`, the program has an ACTIVE version, and that version's
 * `eligible_partner_types` admits the partner's owner type. A suspended or
 * terminated partner keeps every instrument row they already have — gates stop
 * new issuance, never durable records — but attribution refuses their codes
 * separately (`attribution.service.ts`).
 *
 * ## Codes are normalized HERE (the Mongoose-lowercase lesson)
 *
 * `CONVENTIONS.md`: application-level normalization must be re-applied at the
 * call site, and anything a UNIQUE constraint depends on is the place to audit
 * hardest. The requested code is lower-cased before storage; the expression
 * index on `lower(code)` is the second line of defence.
 */

import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@oxyhq/db';
import type { ReferralDestinationType } from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findActiveProgramVersion,
  findProgramVersionById,
  type ReferralProgramRow,
} from '../../db/referrals/programRepository.js';
import { findPartnerById, type ReferralPartnerRow } from '../../db/referrals/partnerRepository.js';
import { readEnforcementEffects } from './integrity/enforcement.service.js';
import {
  findCodeById,
  insertCode,
  insertLink,
  transitionCodeStatus,
  transitionLinkStatus,
  type InstrumentContextInput,
  type ReferralCodeRow,
  type ReferralLinkRow,
} from '../../db/referrals/instrumentRepository.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import { mintReferralLinkToken } from './link-token.js';
import { validateReferralDestination } from './destinations.js';

/** The namespace and case policy, stated once beside the CHECK that repeats it. */
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;

/** The shared issuance context, validated once. */
export interface IssueInstrumentContext extends Omit<InstrumentContextInput, 'destinationType'> {
  destinationType?: ReferralDestinationType;
}

/** Issue a code for a partner under a program's ACTIVE version. */
export async function issueCode(input: {
  partnerId: string;
  programId: string;
  /** The requested spelling; normalized lower-case before storage. */
  requestedCode?: string;
  aliasOfCodeId?: string;
  context?: IssueInstrumentContext;
  expiresAt?: Date;
  maxUses?: number;
  at?: Date;
}): Promise<ReferralCodeRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const { partner, version } = await requireIssuable(tx, input.partnerId, input.programId);

    if (input.aliasOfCodeId !== undefined) {
      const canonical = await findCodeById(tx, input.aliasOfCodeId);
      if (!canonical) throw notFound('Canonical code not found');
      if (canonical.partnerId !== partner.id) {
        throw conflict('A vanity alias must belong to the same partner as its canonical code');
      }
    }

    const code = normalizeCode(input.requestedCode ?? generateCode());
    const destination =
      input.context?.destinationType !== undefined
        ? validateReferralDestination({
            destinationType: input.context.destinationType,
            destinationRef: input.context.destinationRef,
          })
        : undefined;

    const row = await insertCode(tx, {
      partnerId: partner.id,
      programVersionId: version.id,
      code,
      aliasOfCodeId: input.aliasOfCodeId,
      destinationType: destination?.destinationType,
      destinationRef: destination?.destinationRef,
      campaignRef: input.context?.campaignRef,
      contentKey: input.context?.contentKey,
      market: input.context?.market,
      locale: input.context?.locale,
      activatedAt: at,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      disclosureRequired: true,
    });
    if (row === null) {
      throw conflict(`The code '${code}' is already reserved`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'code',
      subjectId: row.id,
      action: 'code_issued',
      actorKind: 'partner',
      actorRef: partner.ownerId,
      reason: `Issued '${code}' under ${version.programId} v${version.version}`,
    });
    return row;
  });
}

/**
 * Issue a signed link wrapping a code. The link id is minted FIRST so the
 * token can embed it; both land in one transaction, so a token that verifies
 * always names a row.
 */
export async function issueLink(input: {
  codeId: string;
  context?: IssueInstrumentContext;
  expiresAt?: Date;
  maxClicks?: number;
  at?: Date;
}): Promise<ReferralLinkRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const code = await findCodeById(tx, input.codeId);
    if (!code) throw notFound('Referral code not found');
    if (code.status !== 'active') {
      throw conflict(`The code is ${code.status}; links are issued for active codes only`);
    }
    // The same three-conjunct gate as issuance: a link is a new instrument.
    await requireIssuable(tx, code.partnerId, await programIdOfVersion(tx, code.programVersionId));

    const destination =
      input.context?.destinationType !== undefined
        ? validateReferralDestination({
            destinationType: input.context.destinationType,
            destinationRef: input.context.destinationRef,
          })
        : undefined;

    const linkId = uuidv7();
    const token = mintReferralLinkToken({ linkId, codeId: code.id });
    const row = await insertLink(tx, {
      id: linkId,
      codeId: code.id,
      token,
      destinationType: destination?.destinationType,
      destinationRef: destination?.destinationRef,
      campaignRef: input.context?.campaignRef,
      contentKey: input.context?.contentKey,
      market: input.context?.market,
      locale: input.context?.locale,
      activatedAt: at,
      expiresAt: input.expiresAt,
      maxClicks: input.maxClicks,
      disclosureRequired: code.disclosureRequired,
    });
    await appendReferralEvent(tx, {
      subjectType: 'link',
      subjectId: row.id,
      action: 'link_issued',
      actorKind: 'system',
      reason: `Issued link for code '${code.code}'`,
    });
    return row;
  });
}

/**
 * Retire a code — it stops attributing and keeps its row and namespace
 * reservation permanently (ADR 0005 D3).
 */
export async function retireCode(input: {
  codeId: string;
  actorKind: 'partner' | 'operator';
  actorRef: string;
  reason: string;
  at?: Date;
}): Promise<ReferralCodeRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionCodeStatus(tx, {
      id: input.codeId,
      expected: ['active', 'paused', 'expired'],
      to: 'retired',
      at,
    });
    if (!row) {
      const existing = await findCodeById(tx, input.codeId);
      if (!existing) throw notFound('Referral code not found');
      if (existing.status === 'retired') return existing;
      throw conflict(`The code is ${existing.status} and cannot be retired`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'code',
      subjectId: row.id,
      action: 'code_retired',
      actorKind: input.actorKind,
      actorRef: input.actorRef,
      reason: input.reason,
    });
    return row;
  });
}

/** Revoke a link immediately — its token dies with the row's status. */
export async function revokeLink(input: {
  linkId: string;
  actorKind: 'partner' | 'operator';
  actorRef: string;
  reason: string;
  at?: Date;
}): Promise<ReferralLinkRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionLinkStatus(tx, {
      id: input.linkId,
      expected: ['active', 'paused'],
      to: 'revoked',
      at,
    });
    if (!row) throw notFound('Referral link not found or already revoked');
    await appendReferralEvent(tx, {
      subjectType: 'link',
      subjectId: row.id,
      action: 'link_revoked',
      actorKind: input.actorKind,
      actorRef: input.actorRef,
      reason: input.reason,
    });
    return row;
  });
}

/**
 * The FOUR-conjunct issuance gate. Named so the tests can pin each refusal
 * separately: not approved, under a scoped link suspension, no active version,
 * owner type not eligible.
 *
 * #148 added the second. It is a SEPARATE conjunct from the partner state
 * rather than a widening of it, because that is exactly the granularity
 * acceptance 2 asks for: a partner under `new_link_suspension` keeps every
 * instrument they already hold working, keeps earning on them, and keeps being
 * paid — they simply cannot mint more. Folding it into `partner.state` would
 * take all four of those away at once.
 */
async function requireIssuable(
  db: DatabaseOrTransaction,
  partnerId: string,
  programId: string,
): Promise<{ partner: ReferralPartnerRow; version: ReferralProgramRow }> {
  const partner = await findPartnerById(db, partnerId);
  if (!partner) throw notFound('Referral partner not found');
  if (partner.state !== 'approved') {
    throw conflict(
      `The partner is ${partner.state} and cannot issue instruments for this program`,
    );
  }
  // #148: the scoped suspension, through the ONE derivation the three gates
  // share. `removedFromProgramIds` is read here too — a partner removed from
  // one program must not mint instruments for it while keeping every other
  // program they are in, which a partner-wide boolean could not express.
  const effects = await readEnforcementEffects(db, partnerId);
  if (effects.newLinksSuspended || effects.removedFromProgramIds.includes(programId)) {
    throw conflict('New instruments are suspended for this partner');
  }
  const version = await findActiveProgramVersion(db, programId);
  if (!version) {
    throw conflict('The program has no active version — instruments cannot be issued');
  }
  if (!version.eligiblePartnerTypes.includes(partner.ownerType)) {
    throw conflict(
      `The program does not admit ${partner.ownerType} partners`,
    );
  }
  return { partner, version };
}

/** The stable program id a version row belongs to. */
async function programIdOfVersion(db: DatabaseOrTransaction, versionId: string): Promise<string> {
  const version = await findProgramVersionById(db, versionId);
  if (!version) throw notFound('Referral program version not found');
  return version.programId;
}

/** Normalize and validate a code spelling against the namespace policy. */
function normalizeCode(requested: string): string {
  const code = requested.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw validationError(
      'A code is 3–32 characters of lower-case letters, digits and hyphens, starting alphanumeric',
    );
  }
  return code;
}

/** A generated code: 10 chars from an unambiguous alphabet, retried on collision by the caller. */
function generateCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}
