/**
 * Accepting terms, and deciding whether what was accepted still counts (#146
 * increment 2, "Terms acceptance").
 *
 * ## Acceptance is EXPLICIT, and there is no shape that could preselect it
 *
 * #146 terms rule 9. `acceptPartnerTerms` takes a VERSION — not a boolean, not
 * an object with an `accepted` field that could default to `true`. A request
 * that names no version accepts nothing, so a client rendering a pre-ticked box
 * cannot make this server record consent that was never given. The same shape
 * is what makes rule 1 ("present the exact program and terms version") real:
 * the version travels with the acceptance and is compared, so accepting terms
 * whose text the applicant was never shown is a mismatch rather than a
 * silently-recorded yes.
 *
 * ## Marketing consent is a DIFFERENT function writing a DIFFERENT column
 *
 * #146 terms rule 8. It has its own writer, its own event and its own nullable
 * instant, so withdrawal is representable and a transactional send can never
 * read a terms acceptance as permission to market. One function writing both is
 * exactly how those two facts would become one.
 */

import {
  REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
  type ReferralTermsAcceptanceView,
  type ReferralTermsScope,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import {
  findPartnerById,
  lockPartnerForEnrollment,
  projectPartnerAgreementAcceptance,
  setPartnerMarketingConsent,
  type ReferralPartnerRow,
} from '../../db/referrals/partnerRepository.js';
import {
  insertTermsAcceptance,
  listTermsAcceptances,
  type ReferralTermsAcceptanceRow,
} from '../../db/referrals/termsAcceptanceRepository.js';
import {
  acceptanceSatisfiesPartnerAgreement,
  activeReferralPartnerAgreement,
} from './partner-agreement.js';

/** BCP-47 as the acceptance column's CHECK spells it. */
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The projection a partner surface reads. Every field named, never spread. */
export function toReferralTermsAcceptanceView(
  row: ReferralTermsAcceptanceRow,
): ReferralTermsAcceptanceView {
  return {
    scope: row.scope,
    termsVersion: row.termsVersion,
    ...(row.programId !== null ? { programId: row.programId } : {}),
    acceptedAt: row.acceptedAt.toISOString(),
    locale: row.locale,
  };
}

/**
 * Whether a partner's accepted agreement still satisfies the gate.
 *
 * PURE, over the one stored verdict, so the derivation and any surface
 * explaining itself to a partner read the same function. `superseded` and
 * `missing` are DIFFERENT answers because they owe different copy: one has
 * accepted something and needs to read a change, the other has accepted
 * nothing at all.
 */
export type ReferralAgreementStanding = 'accepted' | 'superseded' | 'missing';

export function deriveAgreementStanding(partner: {
  termsVersion: string | null;
}): ReferralAgreementStanding {
  if (partner.termsVersion === null) return 'missing';
  return acceptanceSatisfiesPartnerAgreement(partner.termsVersion) ? 'accepted' : 'superseded';
}

/**
 * Record one acceptance.
 *
 * The whole write is one transaction holding the PARTNER's lock: accepting the
 * agreement also PROJECTS the version onto `referral_partners`, and two
 * concurrent acceptances of two different versions must not be able to leave
 * the projection naming the older one. `projectPartnerAgreementAcceptance`
 * additionally refuses to move a newer stamp backwards, so the two mechanisms
 * are independently sufficient.
 *
 * A repeat of the same version is a SUCCESS with `created: false` — #146 terms
 * rule 4: re-acceptance is required only when a material new version says so,
 * and a client that sends the same one twice has not done anything wrong.
 */
export async function acceptPartnerTerms(input: {
  partnerId: string;
  scope: ReferralTermsScope;
  termsVersion: string;
  /** Required for `program_terms`, forbidden for `partner_agreement`. */
  programId?: string;
  locale: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<{ acceptance: ReferralTermsAcceptanceRow; created: boolean; partner: ReferralPartnerRow }> {
  const at = input.at ?? new Date();

  if (!LOCALE_PATTERN.test(input.locale)) {
    // Named rather than silently normalized: the commonest wrong value here is
    // a whole `Accept-Language` header, and storing that would make the locale
    // unusable for the copy it exists to select.
    throw validationError(`Not a language tag: ${input.locale}`);
  }
  if (input.scope === 'program_terms' && (input.programId ?? '').trim().length === 0) {
    throw validationError('Accepting a program\'s terms must name the program');
  }
  if (input.scope === 'partner_agreement' && input.programId !== undefined) {
    throw validationError('The partner agreement is not scoped to a program');
  }
  if (input.scope === 'partner_agreement') {
    const active = activeReferralPartnerAgreement();
    if (input.termsVersion !== active.version) {
      // Rule 1, enforced rather than assumed: accepting a version that is not
      // the one being presented is either a stale client or somebody accepting
      // terms they were never shown, and both are refusals.
      throw conflict(
        `The current partner agreement is ${active.version}; ${input.termsVersion} cannot be accepted`,
      );
    }
  }

  const db = getDb();
  return await db.transaction(async (tx) => {
    const partner = await lockPartnerForEnrollment(tx, input.partnerId);
    if (!partner) throw notFound('Referral partner not found');

    const { row, created } = await insertTermsAcceptance(tx, {
      partnerId: input.partnerId,
      scope: input.scope,
      programId: input.scope === 'program_terms' ? (input.programId ?? null) : null,
      termsVersion: input.termsVersion,
      acceptedAt: at,
      acceptedByOxyUserId: input.actorOxyUserId,
      locale: input.locale,
    });

    let projected = partner;
    if (created) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: input.partnerId,
        action: 'partner_terms_accepted',
        actorKind: 'partner',
        actorRef: input.actorOxyUserId,
        reason: `${input.scope} ${input.termsVersion}${
          input.programId !== undefined ? ` for program ${input.programId}` : ''
        } in ${input.locale}`,
      });
    }

    if (input.scope === 'partner_agreement') {
      projected =
        (await projectPartnerAgreementAcceptance(tx, {
          id: input.partnerId,
          termsVersion: input.termsVersion,
          acceptedAt: at,
        })) ?? partner;
    }

    return { acceptance: row, created, partner: projected };
  });
}

/**
 * Grant or withdraw MARKETING consent (#146 terms rule 8).
 *
 * Its own act, its own event and its own column. Withdrawal writes NULL rather
 * than a second row, because unlike a terms acceptance there is no version to
 * keep a history of — what matters is whether Mercaria may market to this
 * partner right now, and `referral_events` carries the trail of how it changed.
 */
export async function setReferralMarketingConsent(input: {
  partnerId: string;
  granted: boolean;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralPartnerRow> {
  const at = input.at ?? new Date();
  const db = getDb();

  return await db.transaction(async (tx) => {
    const row = await setPartnerMarketingConsent(tx, {
      id: input.partnerId,
      at: input.granted ? at : null,
    });
    if (!row) throw notFound('Referral partner not found');

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_marketing_consent_set',
      actorKind: 'partner',
      actorRef: input.actorOxyUserId,
      reason: input.granted ? 'granted' : 'withdrawn',
    });
    return row;
  });
}

/** Every acceptance this partner has made, newest first. */
export async function readTermsAcceptances(
  partnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ReferralTermsAcceptanceView[]> {
  const rows = await listTermsAcceptances(db, partnerId);
  return rows.map(toReferralTermsAcceptanceView);
}

/**
 * What a partner still has to accept, plus the text of it.
 *
 * The ACTIVE agreement travels with the answer rather than being fetched
 * separately, because #146 terms rule 7 asks for downloadable terms and a
 * surface that had to make a second call to render what it is asking somebody
 * to accept is a surface that will one day render the wrong version.
 */
export async function readAgreementRequirement(
  partnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  standing: ReferralAgreementStanding;
  requiredVersion: string;
  agreement: ReturnType<typeof activeReferralPartnerAgreement>;
  acceptedVersion?: string;
}> {
  const partner = await findPartnerById(db, partnerId);
  if (!partner) throw notFound('Referral partner not found');
  const standing = deriveAgreementStanding(partner);
  return {
    standing,
    requiredVersion: REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
    agreement: activeReferralPartnerAgreement(),
    ...(partner.termsVersion !== null ? { acceptedVersion: partner.termsVersion } : {}),
  };
}
