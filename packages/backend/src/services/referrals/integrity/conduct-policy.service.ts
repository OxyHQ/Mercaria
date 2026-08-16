/**
 * The versioned prohibited-conduct policy (#148 "Prohibited conduct policy").
 *
 * ## The KEY is a code constant
 *
 * `REFERRAL_CONDUCT_POLICY_KEY` is not an environment variable and not a
 * column somebody chooses: which policy a partner is held to is a fact about
 * the program, and a per-deployment key would make "which rules apply" a
 * question with a different answer in staging. The reward-rule and
 * fee-schedule domains both name their key in code for the same reason.
 *
 * ## The rules are VISIBLE BEFORE PARTICIPATION
 *
 * `readActiveConductPolicy` is mounted on the partner surface with no
 * enrollment requirement — an account that has never applied can read exactly
 * what it would be agreeing to. That is #148's *"visible before
 * participation"*, and gating it behind enrollment would make the requirement
 * unmeetable by construction.
 *
 * ## And they are TIED to the accepted terms version
 *
 * `terms_version` on the row. A partner's `referral_terms_acceptances` names a
 * version; the policy published under it is the one they accepted. A policy
 * change is a NEW version with a NEW `effective_from`, because editing the one
 * somebody accepted makes the accepted version a pointer to something that no
 * longer exists — which is the whole reason this table is immutable once it
 * leaves `draft`.
 */

import {
  REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
  REFERRAL_PROHIBITED_CONDUCT_KINDS,
  type ReferralProhibitedConduct,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import {
  activateConductPolicy,
  findActiveConductPolicy,
  findConductPolicyById,
  findConductPolicyVersions,
  insertConductPolicyDraft,
  nextConductPolicyVersion,
  type ReferralConductPolicyRow,
} from '../../../db/referralIntegrity/policyRepository.js';

/** The ONE policy key at launch. A code constant — see the docblock. */
export const REFERRAL_CONDUCT_POLICY_KEY = 'referral-partner-conduct';

/** A policy version as anyone reads it. Every field named. */
export interface ReferralConductPolicyView {
  id: string;
  policyKey: string;
  version: number;
  status: string;
  prohibitedConduct: readonly ReferralProhibitedConduct[];
  termsVersion: string;
  summary: string;
  /** ISO-8601. */
  effectiveFrom: string;
  /** ISO-8601, absent while the version is a draft. */
  publishedAt?: string;
}

/**
 * The projection.
 *
 * `published_by_oxy_user_id` has no field here, and that is deliberate for
 * both readers: a partner has no business knowing which employee published a
 * rule, and an operator reads it off `referral_events`, which is the audit
 * trail. One projection for both is then safe, so there is one rather than two
 * that could disagree about what a policy says.
 */
export function toConductPolicyView(row: ReferralConductPolicyRow): ReferralConductPolicyView {
  return {
    id: row.id,
    policyKey: row.policyKey,
    version: row.version,
    status: row.status,
    prohibitedConduct: row.prohibitedConduct as ReferralProhibitedConduct[],
    termsVersion: row.termsVersion,
    summary: row.summary,
    effectiveFrom: row.effectiveFrom.toISOString(),
    publishedAt: row.publishedAt?.toISOString(),
  };
}

/**
 * The live policy, or `undefined` when nobody has published one.
 *
 * ABSENCE is a real answer and is reported as one rather than defaulted to a
 * built-in set of prohibitions. A built-in default would be #74's ranking
 * decision applied to the wrong kind of thing: a ranking must produce SOME
 * order or the comparison surface has none, while a rule people are held to
 * must have been published by somebody. An enforcement action can then cite no
 * prohibition, which `imposeEnforcementAction` permits — an action may rest on
 * a reason without citing a rule, and inventing a rule to cite would be worse.
 */
export async function readActiveConductPolicy(
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralConductPolicyView | undefined> {
  const row = await findActiveConductPolicy(db, REFERRAL_CONDUCT_POLICY_KEY);
  return row ? toConductPolicyView(row) : undefined;
}

/** Every version, newest first — the operator's history. */
export async function readConductPolicyVersions(): Promise<
  readonly ReferralConductPolicyView[]
> {
  const rows = await findConductPolicyVersions(getDb(), REFERRAL_CONDUCT_POLICY_KEY);
  return rows.map(toConductPolicyView);
}

/**
 * Draft a version.
 *
 * The version NUMBER is derived rather than supplied: a caller-chosen number
 * is one two operators can collide on, and the unique index would answer the
 * loser with a constraint name. Deriving it inside the transaction makes the
 * collision a serialization failure the caller retries.
 */
export async function draftConductPolicy(input: {
  prohibitedConduct: readonly ReferralProhibitedConduct[];
  termsVersion?: string;
  summary: string;
  effectiveFrom: Date;
  actorOxyUserId: string;
}): Promise<ReferralConductPolicyView> {
  const summary = input.summary.trim();
  if (summary.length === 0) throw validationError('A conduct policy requires a summary');
  if (input.prohibitedConduct.length === 0) {
    throw validationError('A conduct policy must prohibit at least one kind of conduct');
  }
  const unknown = input.prohibitedConduct.filter(
    (kind) => !REFERRAL_PROHIBITED_CONDUCT_KINDS.includes(kind),
  );
  if (unknown.length > 0) {
    throw validationError(
      `Not prohibited conduct this program can express: ${unknown.join(', ')}`,
    );
  }

  const db = getDb();
  return await db.transaction(async (tx) => {
    const version = await nextConductPolicyVersion(tx, REFERRAL_CONDUCT_POLICY_KEY);
    const row = await insertConductPolicyDraft(tx, {
      policyKey: REFERRAL_CONDUCT_POLICY_KEY,
      version,
      // Deduplicated: the CHECK is containment, which an array with a repeated
      // member satisfies, and a policy listing one prohibition twice renders
      // twice on the partner surface.
      prohibitedConduct: [...new Set(input.prohibitedConduct)],
      termsVersion: input.termsVersion ?? REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
      summary,
      effectiveFrom: input.effectiveFrom,
    });
    await appendReferralEvent(tx, {
      subjectType: 'conduct_policy',
      subjectId: row.id,
      action: 'conduct_policy_drafted',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `v${version} under terms ${row.termsVersion}`,
    });
    return toConductPolicyView(row);
  });
}

/** Publish a draft, superseding the incumbent in the same transaction. */
export async function publishConductPolicy(input: {
  policyId: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralConductPolicyView> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const existing = await findConductPolicyById(tx, input.policyId);
    if (!existing) throw notFound('Conduct policy version not found');
    if (existing.status !== 'draft') {
      throw conflict(`That version is ${existing.status} and cannot be published again`);
    }
    const row = await activateConductPolicy(tx, {
      id: input.policyId,
      policyKey: existing.policyKey,
      publishedByOxyUserId: input.actorOxyUserId,
      at,
    });
    if (!row) throw conflict('That version is no longer a draft');
    await appendReferralEvent(tx, {
      subjectType: 'conduct_policy',
      subjectId: row.id,
      action: 'conduct_policy_activated',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `v${row.version} live from ${row.effectiveFrom.toISOString()}`,
    });
    return toConductPolicyView(row);
  });
}
