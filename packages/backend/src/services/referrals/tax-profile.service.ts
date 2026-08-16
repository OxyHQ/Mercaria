/**
 * Completing the tax questionnaire, and what that does to the payout gate
 * (#146, ADR 0005 D15 gate 2).
 *
 * ## Three values, and `blocked` is deliberately not one of them
 *
 * {@link deriveTaxReadiness} answers `pending` or `ready` and can never answer
 * `blocked` or `unknown`, and both absences are decisions:
 *
 *  - `unknown` is "nobody has looked", and this derivation always looks. It runs
 *    over rows this domain owns, so there is no outage that could leave the
 *    question unanswered — unlike the identity gate, where an unreachable rail
 *    genuinely means Mercaria does not know.
 *  - `blocked` would mean a completed questionnaire that Mercaria refuses to
 *    act on. Nothing in increment 1 can produce that: there is no invalidation
 *    path, because the fraud review that would drive one is #148's and the
 *    operator review path is increment 2's. Adding the column now would be a
 *    column nothing could populate, which is a second source of truth for a fact
 *    Mercaria does not hold. When one of those lands it adds an invalidation
 *    revision and this function grows a third branch — the vocabulary already
 *    admits it, so that is a change to this file and to no schema.
 *
 * A partner who has never submitted and one whose submission answers a
 * superseded questionnaire are BOTH `pending`, and that is right: each owes the
 * same next action, which is filling in the current form. What differs is the
 * copy a surface shows them, which is why {@link readTaxProfile} returns the
 * stored revision beside the verdict rather than only the verdict.
 *
 * ## The HTTP surface EXISTS as of increment 2
 *
 * Increment 1 left these two functions complete and unmounted, for one stated
 * reason: a route needs partner-facing auth, and "which Oxy account may declare
 * for a `store` partner" is the `store:manage` question #85 answers — answering
 * it HERE would be a second answer to it. Until then tax readiness was `pending`
 * for every partner and the payout gate blocked every batch.
 *
 * Increment 2 mounts both on `GET`/`POST .../referral-partner/tax-profile`, and
 * it does not answer that question either: the store half is mounted UNDER
 * `/admin/stores/:storeId`, where `loadStore` plus
 * `requireStorePermission('store:manage')` have already answered it, and the
 * individual half is mounted where the owner IS the authenticated caller.
 * #85's two-mount shape, so the answer stays in exactly one place — the
 * middleware — and `referral-enrollment-isolation.test.ts` fails the build if
 * any module in this domain grows a second one.
 *
 * `services/referrals/enrollment.service.ts` is the entry point;
 * `docs/referral-enrollment.md` is the reference.
 */

import {
  REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION,
  type ReferralReadinessSummary,
  type ReferralTaxParticipantType,
  type ReferralTaxProfile,
  type ReferralTaxVatStatus,
} from '@mercaria/shared-types';
import { notFound } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import {
  findLatestTaxProfile,
  insertTaxProfileRevision,
  lockPartnerForTaxProfile,
  type ReferralTaxProfileRow,
} from '../../db/referrals/taxProfileRepository.js';
import { answersCurrentReferralTaxQuestionnaire } from './tax-terms.js';

/**
 * ADR 0005 D15 gate 2, over the partner's latest declaration.
 *
 * PURE, so the rule is testable without a database and there is exactly one
 * spelling of it — the gate and any surface explaining itself to a partner read
 * the same function.
 */
export function deriveTaxReadiness(
  latest: Pick<ReferralTaxProfileRow, 'questionnaireVersion'> | undefined,
): ReferralReadinessSummary {
  if (!latest) return 'pending';
  return answersCurrentReferralTaxQuestionnaire(latest.questionnaireVersion) ? 'ready' : 'pending';
}

/** The projection a surface reads. Every field named, never spread. */
export function toReferralTaxProfile(row: ReferralTaxProfileRow): ReferralTaxProfile {
  return {
    partnerId: row.partnerId,
    revision: row.revision,
    questionnaireVersion: row.questionnaireVersion,
    participantType: row.participantType,
    residencyCountry: row.residencyCountry,
    vatStatus: row.vatStatus,
    declaredAt: row.declaredAt.toISOString(),
    answersCurrentQuestionnaire: answersCurrentReferralTaxQuestionnaire(row.questionnaireVersion),
  };
}

/** What a partner has declared, and what the gate makes of it. */
export interface ReferralTaxProfileView {
  profile: ReferralTaxProfile | undefined;
  readiness: ReferralReadinessSummary;
  /** The version a submission must answer to satisfy the gate today. */
  requiredQuestionnaireVersion: string;
}

/** Read one partner's current declaration and the verdict over it. */
export async function readTaxProfile(partnerId: string): Promise<ReferralTaxProfileView> {
  const latest = await findLatestTaxProfile(getDb(), partnerId);
  return {
    profile: latest ? toReferralTaxProfile(latest) : undefined,
    readiness: deriveTaxReadiness(latest),
    requiredQuestionnaireVersion: REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION,
  };
}

/**
 * Record a declaration against the CURRENT questionnaire.
 *
 * The version is not a parameter, deliberately: a caller able to name one could
 * satisfy the gate by citing a version it prefers, and a client that shipped
 * before a bump would go on answering the old questions forever while reading as
 * `ready`. What a submission answers is whatever Mercaria is asking at the
 * moment it arrives.
 *
 * The whole write is one transaction holding the PARTNER's lock, so two
 * concurrent submissions are allocated distinct revisions rather than colliding
 * on the unique index. The event is appended inside it: a declaration that
 * committed with no trail entry is exactly the pair an operator later cannot
 * reconcile.
 */
export async function declareTaxProfile(input: {
  partnerId: string;
  participantType: ReferralTaxParticipantType;
  /** ISO 3166-1 alpha-2; normalized to upper case before the CHECK sees it. */
  residencyCountry: string;
  vatStatus: ReferralTaxVatStatus;
  declaredByOxyUserId: string;
  at?: Date;
}): Promise<ReferralTaxProfileView> {
  const at = input.at ?? new Date();
  const residencyCountry = input.residencyCountry.trim().toUpperCase();
  const db = getDb();

  return await db.transaction(async (tx) => {
    const exists = await lockPartnerForTaxProfile(tx, input.partnerId);
    if (!exists) throw notFound('Referral partner not found');

    const row = await insertTaxProfileRevision(tx, {
      partnerId: input.partnerId,
      questionnaireVersion: REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION,
      participantType: input.participantType,
      residencyCountry,
      vatStatus: input.vatStatus,
      declaredAt: at,
      declaredByOxyUserId: input.declaredByOxyUserId,
    });

    // The reason names the version and the revision and NOT the declaration:
    // `referral_events.reason` is free text an operator reads, and a residency
    // country copied into it would put the one fact this domain minimises
    // somewhere no projection controls.
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_tax_profile_declared',
      actorKind: 'partner',
      actorRef: input.declaredByOxyUserId,
      reason: `revision ${String(row.revision)} answering questionnaire ${row.questionnaireVersion}`,
    });

    return {
      profile: toReferralTaxProfile(row),
      readiness: deriveTaxReadiness(row),
      requiredQuestionnaireVersion: REFERRAL_ACTIVE_TAX_QUESTIONNAIRE_VERSION,
    };
  });
}
