/**
 * Referral integrity: conduct policy, risk signals, scoped enforcement, appeals
 * and disclosures (#148, under ADR 0005 D7, D17, D18 and R6–R8).
 *
 * Five tables. What each is for, and why it is not the others:
 *
 * - **`referral_conduct_policies`** is the versioned, enforceable list of
 *   prohibited conduct, tied to the terms version a partner accepted. The
 *   `fee_schedules` / `referral_reward_rules` device: immutable once it leaves
 *   `draft`, one `active` version per key. A policy change is a NEW version,
 *   because rewriting the one somebody accepted makes the accepted terms
 *   version a pointer to something that no longer exists.
 * - **`referral_risk_signals`** is an OBSERVATION about behaviour. It carries no
 *   identifier of any kind and no column could hold one — that absence is the
 *   enforcement, #77's posture applied to fraud detection.
 * - **`referral_enforcement_actions`** is a DECISION: what was done, on what
 *   basis, at what scope, by whom, until when. Append-only against its decision
 *   columns; only the lift and the appeal state may move.
 * - **`referral_enforcement_appeals`** is the independent path. Its CHECKs are
 *   the independence: a decider who is the imposer, or who is the appellant, has
 *   no row shape.
 * - **`referral_disclosure_requirements`** is the copy a partner is given, per
 *   surface, market and language, versioned on the same device as the policy.
 *
 * ## The one law this file exists to hold
 *
 * ADR 0005 D17: *"Signals freeze; only first-party identity evidence voids."*
 * `referral_enforcement_actions_forfeiture_basis_check` renders BOTH derived
 * sets — the forfeiting actions and the bases permitting forfeiture — from
 * `@mercaria/shared-types`, so a forfeiting action on a `risk_signal` basis has
 * no row shape at all. Not a service bug, not an operator mistake, not `psql`.
 *
 * ## What nobody can write down here
 *
 * No email, no hash, no phone, no address, no card fingerprint, no provider
 * customer, no wallet, no IP, no user agent, no device fingerprint, no cookie.
 * `evidence_ref` addresses a Mercaria ROW and `imposed_by_oxy_user_id` is an
 * operator; the whole of what these five tables store about a referred person
 * is a referral row id that points at them indirectly through #142's own
 * tables. Following an enforcement action to its evidence and out the other
 * side never reaches a buyer.
 *
 * ## Scoped enforcement is #148 acceptance 2
 *
 * `referral_partners.state = 'suspended'` collapses four consequences into one
 * column: no new links, no new attribution, no payout, no earning. An operator
 * investigating a partner therefore has to stop paying their honest earnings in
 * order to stop crediting new ones. `referral_enforcement_actions` separates
 * them by ACTION, and `deriveEnforcementEffects` reads the live set — so
 * *"new attribution can be paused while valid existing earnings continue
 * settling"* is a shape rather than a policy.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import {
  REFERRAL_BASES_PERMITTING_FORFEITURE,
  REFERRAL_CONDUCT_POLICY_STATUSES,
  REFERRAL_DISCLOSURE_STATUSES,
  REFERRAL_DISCLOSURE_SURFACES,
  REFERRAL_ENFORCEMENT_ACTIONS,
  REFERRAL_ENFORCEMENT_APPEAL_STATES,
  REFERRAL_ENFORCEMENT_BASES,
  REFERRAL_ENFORCEMENT_SCOPES,
  REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS,
  REFERRAL_PROHIBITED_CONDUCT_KINDS,
  REFERRAL_RISK_SIGNAL_KINDS,
  REFERRAL_RISK_SIGNAL_SEVERITIES,
  REFERRAL_RISK_SUBJECT_TYPES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { referralPartners } from './referrals';

/** Bound on a stored reason — the `referral_events` bound, same reasoning. */
const MAX_REASON_LENGTH = 2_000;

/** Bound on a disclosure sentence. Long enough for a paragraph, not an essay. */
const MAX_DISCLOSURE_LENGTH = 1_000;

/** Rendered into a CHECK — see `inList`'s contract in `columns.ts`. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

/**
 * `referral_conduct_policies` — one row per immutable conduct-policy VERSION.
 *
 * ## Why the prohibitions are a `text[]` and not sixteen booleans
 *
 * A program prohibits a SET, and the set is what a partner is shown and what an
 * enforcement action cites. Sixteen booleans would make "which rules does this
 * version carry" a sixteen-column read and a seventeenth prohibition a
 * migration on every row; an array with a containment CHECK rendered from the
 * shared tuple makes it one column and one constraint.
 *
 * `cardinality(...) >= 1`, never `array_length(...) >= 1`: on an empty array
 * `array_length` is NULL and a CHECK reads NULL as SATISFIED, so the obvious
 * spelling ADMITS exactly the row it exists to refuse — a policy version that
 * prohibits nothing, which a partner would accept and which would make every
 * later enforcement action uncitable.
 */
export const referralConductPolicies = pgTable(
  'referral_conduct_policies',
  {
    id: generatedId(),
    /** The stable identity every version row shares — a code constant today. */
    policyKey: text().notNull(),
    /** 1-based, dense per key. Immutable once the row exists. */
    version: integer().notNull(),
    status: text({ enum: asEnumValues(REFERRAL_CONDUCT_POLICY_STATUSES) })
      .notNull()
      .default('draft'),
    /**
     * The prohibitions this version carries.
     *
     * A SUBSET of `REFERRAL_PROHIBITED_CONDUCT_KINDS`, never free text: an
     * appeal against "you violated our spirit" is not one anybody can win, and
     * an enforcement action citing a prohibition nobody published is not one
     * anybody can defend.
     */
    prohibitedConduct: text().array().notNull(),
    /**
     * The terms version this policy is published UNDER.
     *
     * #148 requires the rules be *"visible before participation and tied to the
     * accepted terms version"*. This column is that tie: a partner's
     * `referral_terms_acceptances` row names a version, and the policy live
     * under it is the one they agreed to. There is no foreign key because
     * `referral_terms_acceptances` records ACCEPTANCES rather than documents —
     * the version vocabulary is `REFERRAL_PARTNER_AGREEMENT_VERSIONS`, a code
     * constant, and a foreign key onto acceptances would make a policy
     * unpublishable until somebody had accepted it.
     */
    termsVersion: text().notNull(),
    /** The partner-facing summary, rendered verbatim. */
    summary: text().notNull(),
    effectiveFrom: timestamptz().notNull(),
    publishedByOxyUserId: text(),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'referral_conduct_policies_status_check',
      t.status,
      REFERRAL_CONDUCT_POLICY_STATUSES,
    ),
    checkEveryElementOf(
      'referral_conduct_policies_conduct_check',
      t.prohibitedConduct,
      REFERRAL_PROHIBITED_CONDUCT_KINDS,
    ),
    check(
      'referral_conduct_policies_conduct_nonempty_check',
      sql`cardinality(${t.prohibitedConduct}) >= 1`,
    ),
    check('referral_conduct_policies_version_check', sql`${t.version} >= 1`),
    check(
      'referral_conduct_policies_identity_check',
      sql`length(${t.policyKey}) > 0 and length(${t.termsVersion}) > 0
          and length(${t.summary}) > 0
          and length(${t.summary}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    // A draft has not been published; anything else has, by somebody, at a
    // time. Two biconditionals rather than one over their conjunction: the
    // single form is SATISFIED when both halves are false, which admits a
    // `draft` carrying a publisher — exactly the row this refuses.
    check(
      'referral_conduct_policies_publication_check',
      sql`((${t.status} = 'draft') = (${t.publishedAt} is null))
          and ((${t.status} = 'draft') = (${t.publishedByOxyUserId} is null))`,
    ),
    uniqueIndex('referral_conduct_policies_version_key').on(t.policyKey, t.version),
    // ONE active version per key. The `referral_reward_rules` device: two
    // operators publishing at once converge on a refusal rather than on two
    // live policies whose prohibitions differ.
    uniqueIndex('referral_conduct_policies_active_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'active'`),
    index('referral_conduct_policies_terms_version_idx').on(t.termsVersion),
  ],
);

/**
 * `referral_risk_signals` — one observation about BEHAVIOUR.
 *
 * ## Every column is a count, a rate, a duration or a row id
 *
 * The enforcement is what is ABSENT. There is no email column, no hash column,
 * no phone column, no address column, no card column, no provider-customer
 * column, no IP column, no user-agent column and no device column, and
 * `referral-integrity-isolation.test.ts` walks the real table to assert it —
 * because a scan of the source proves the code does not name one today, and a
 * walk of the columns proves the row cannot hold one tomorrow.
 *
 * `observed_value` and `threshold_value` are integers with no unit column,
 * deliberately: the unit is a property of the KIND, and a per-row unit is how
 * a basis-point rate ends up compared against a count. `deriveRiskSignalUnit`
 * is exhaustive over the kinds, so a kind added without a unit fails `tsc`.
 *
 * ## Append-only against UPDATE; DELETE deliberately PERMITTED
 *
 * The `analytics_events` posture, and it inverts the ledger's on purpose.
 * Append-only is what stops a signal being retuned after the fact to justify an
 * action taken on it. DELETE is permitted because erasure on a schedule IS the
 * retention policy (`REFERRAL_RETENTION_POLICY.risk_signal`), and a trigger
 * refusing it would make the shared expiry sweep fail silently on every row it
 * was supposed to remove.
 */
export const referralRiskSignals = pgTable(
  'referral_risk_signals',
  {
    id: generatedId(),
    /** The partner the signal is about. Always present — signals are per partner. */
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'cascade' }),
    subjectType: text({ enum: asEnumValues(REFERRAL_RISK_SUBJECT_TYPES) }).notNull(),
    /** A referral row id: a partner, an attribution, a conversion or a reward. */
    subjectId: text().notNull(),
    /** The program the observation was made under, when it was scoped to one. */
    programId: text(),
    kind: text({ enum: asEnumValues(REFERRAL_RISK_SIGNAL_KINDS) }).notNull(),
    severity: text({ enum: asEnumValues(REFERRAL_RISK_SIGNAL_SEVERITIES) }).notNull(),
    /** What was measured. Units come from the KIND — see the docblock. */
    observedValue: integer().notNull(),
    /** What it was measured against, when the kind has a threshold. */
    thresholdValue: integer(),
    /** The measurement window. Both ends, so a rate is reproducible. */
    windowStart: timestamptz().notNull(),
    windowEnd: timestamptz().notNull(),
    /**
     * A Mercaria ROW the observation rests on — an order, a refund, a dispute
     * record, another partner.
     *
     * Never a person and never a provider identifier: ADR 0005 A2 lets a fraud
     * signal reference payment-domain OUTCOMES and never payment-domain
     * identifiers, and this column is where somebody would otherwise put one.
     */
    evidenceRef: text(),
    /** `system` for the evaluator, `operator` for a hand-recorded finding. */
    recordedByKind: text({ enum: asEnumValues(['system', 'operator'] as const) }).notNull(),
    recordedByOxyUserId: text(),
    /** An operator's note. Bounded, and absent for a system observation. */
    note: text(),
    /** Retention: `REFERRAL_RETENTION_POLICY.risk_signal`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('referral_risk_signals_subject_type_check', t.subjectType, REFERRAL_RISK_SUBJECT_TYPES),
    checkOneOf('referral_risk_signals_kind_check', t.kind, REFERRAL_RISK_SIGNAL_KINDS),
    checkOneOf(
      'referral_risk_signals_severity_check',
      t.severity,
      REFERRAL_RISK_SIGNAL_SEVERITIES,
    ),
    check(
      'referral_risk_signals_recorded_by_check',
      sql`${t.recordedByKind} in ('system', 'operator')
          and ((${t.recordedByKind} = 'operator') = (${t.recordedByOxyUserId} is not null))`,
    ),
    // `manual_evidence` is the operator's kind and only the operator's. A
    // system-recorded "manual evidence" is a contradiction that would let an
    // automated sweep produce the one signal kind a reviewer trusts most.
    check(
      'referral_risk_signals_manual_kind_check',
      sql`${t.kind} <> 'manual_evidence' or ${t.recordedByKind} = 'operator'`,
    ),
    check('referral_risk_signals_window_check', sql`${t.windowEnd} >= ${t.windowStart}`),
    check('referral_risk_signals_value_check', sql`${t.observedValue} >= 0`),
    check(
      'referral_risk_signals_threshold_check',
      sql`${t.thresholdValue} is null or ${t.thresholdValue} >= 0`,
    ),
    check(
      'referral_risk_signals_note_check',
      sql`${t.note} is null
          or (length(${t.note}) > 0 and length(${t.note}) <= ${sql.raw(String(MAX_REASON_LENGTH))})`,
    ),
    check('referral_risk_signals_expiry_check', sql`${t.expiresAt} > ${t.windowEnd}`),
    index('referral_risk_signals_partner_created_at_idx').on(t.partnerId, t.createdAt.desc()),
    index('referral_risk_signals_subject_idx').on(t.subjectType, t.subjectId),
    index('referral_risk_signals_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `referral_enforcement_actions` — one scoped, reasoned, evidenced decision.
 *
 * ## The forfeiture CHECK
 *
 * `referral_enforcement_actions_forfeiture_basis_check` renders
 * `REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS` and
 * `REFERRAL_BASES_PERMITTING_FORFEITURE`, both DERIVED in shared-types rather
 * than written down beside their sources. So ADR 0005 D17's law is one
 * constraint over two computed sets, and an action that becomes able to destroy
 * money does so in a place `tsc` guards and a migration records.
 *
 * ## One LIVE action per (scope, subject, action)
 *
 * A partial unique `WHERE lifted_at IS NULL`. Two operators reaching the same
 * conclusion converge on one row rather than stacking duplicates, and a LIFTED
 * action is re-imposable — which a plain unique would forbid forever, leaving a
 * partner who was cleared and then reoffended permanently un-actionable.
 *
 * ## What may move after the fact, and nothing else
 *
 * A trigger freezes every decision column. Only `lifted_at`, `lifted_by`,
 * `lift_reason` and `appeal_state` may change, which is what makes an action
 * *"reversible through compensating records"* rather than editable: lifting
 * appends the lift, it does not rewrite the decision.
 */
export const referralEnforcementActions = pgTable(
  'referral_enforcement_actions',
  {
    id: generatedId(),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    action: text({ enum: asEnumValues(REFERRAL_ENFORCEMENT_ACTIONS) }).notNull(),
    scope: text({ enum: asEnumValues(REFERRAL_ENFORCEMENT_SCOPES) }).notNull(),
    /** The row the action is about — a partner, a program pairing, a reward. */
    subjectId: text().notNull(),
    /** Required for `program_partner` scope; the program removed from. */
    programId: text(),
    basis: text({ enum: asEnumValues(REFERRAL_ENFORCEMENT_BASES) }).notNull(),
    /** The published prohibition cited, when the action cites one. */
    conduct: text(),
    reason: text().notNull(),
    /**
     * `referral_risk_signals` ids. NOT a foreign key array — Postgres has none
     * — and deliberately not a join table either: the signals are evidence
     * SNAPSHOTTED at the moment of the decision, and a join table would let a
     * later sweep's retention delete change what an action appears to have been
     * based on. The ids may dangle after 400 days, and that is correct: the
     * REASON survives the working papers, which is the same division
     * `REFERRAL_RETENTION_POLICY` draws between `review_evidence` and the
     * action itself.
     */
    evidenceSignalIds: text().array().notNull().default(sql`'{}'::text[]`),
    startsAt: timestamptz().notNull(),
    /** When the action lapses on its own. NULL means it does not. */
    expiresAt: timestamptz(),
    liftedAt: timestamptz(),
    liftedByOxyUserId: text(),
    liftReason: text(),
    appealState: text({ enum: asEnumValues(REFERRAL_ENFORCEMENT_APPEAL_STATES) })
      .notNull()
      .default('none'),
    imposedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('referral_enforcement_actions_action_check', t.action, REFERRAL_ENFORCEMENT_ACTIONS),
    checkOneOf('referral_enforcement_actions_scope_check', t.scope, REFERRAL_ENFORCEMENT_SCOPES),
    checkOneOf('referral_enforcement_actions_basis_check', t.basis, REFERRAL_ENFORCEMENT_BASES),
    checkOneOf(
      'referral_enforcement_actions_appeal_state_check',
      t.appealState,
      REFERRAL_ENFORCEMENT_APPEAL_STATES,
    ),
    checkOneOf(
      'referral_enforcement_actions_conduct_check',
      t.conduct,
      REFERRAL_PROHIBITED_CONDUCT_KINDS,
    ),
    // ADR 0005 D17, as a row shape. Both sets are DERIVED in shared-types.
    check(
      'referral_enforcement_actions_forfeiture_basis_check',
      sql`${t.action} not in (${sql.raw(inList(REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS))})
          or ${t.basis} in (${sql.raw(inList(REFERRAL_BASES_PERMITTING_FORFEITURE))})`,
    ),
    // A signal-based action must NAME its signals. Without this the basis is a
    // word rather than a claim, and "we saw a pattern" becomes unfalsifiable.
    // `cardinality`, never `array_length` — NULL on an empty array reads as
    // SATISFIED and would admit the evidence-free row this refuses.
    check(
      'referral_enforcement_actions_signal_evidence_check',
      sql`${t.basis} <> 'risk_signal' or cardinality(${t.evidenceSignalIds}) >= 1`,
    ),
    // A program-scoped action names its program; a partner-wide one must not,
    // or an operator reading "removed from" has two answers.
    check(
      'referral_enforcement_actions_program_shape_check',
      sql`(${t.scope} = 'program_partner') = (${t.programId} is not null)`,
    ),
    // The three lift columns move together or not at all. `num_nonnulls` rather
    // than three pairwise biconditionals: the pairwise form needs three
    // constraints to say what one says, and a missing third reads as clean.
    check(
      'referral_enforcement_actions_lift_shape_check',
      sql`num_nonnulls(${t.liftedAt}, ${t.liftedByOxyUserId}, ${t.liftReason}) in (0, 3)`,
    ),
    check(
      'referral_enforcement_actions_window_check',
      sql`(${t.expiresAt} is null or ${t.expiresAt} > ${t.startsAt})
          and (${t.liftedAt} is null or ${t.liftedAt} >= ${t.startsAt})`,
    ),
    check(
      'referral_enforcement_actions_reason_check',
      sql`length(${t.reason}) > 0 and length(${t.reason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}
          and (${t.liftReason} is null
               or (length(${t.liftReason}) > 0
                   and length(${t.liftReason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}))`,
    ),
    check(
      'referral_enforcement_actions_identity_check',
      sql`length(${t.imposedByOxyUserId}) > 0 and length(${t.subjectId}) > 0`,
    ),
    // `cleared` is a RECORD that somebody looked and found nothing, so it may
    // never carry an expiry or a lift: there is nothing to lapse and nothing to
    // undo, and a lifted clearance would read as an un-clearing.
    check(
      'referral_enforcement_actions_cleared_shape_check',
      sql`${t.action} <> 'cleared'
          or (${t.expiresAt} is null and ${t.liftedAt} is null)`,
    ),
    uniqueIndex('referral_enforcement_actions_live_key')
      .on(t.scope, t.subjectId, t.action)
      .where(sql`${t.liftedAt} is null`),
    index('referral_enforcement_actions_partner_live_idx')
      .on(t.partnerId, t.action)
      .where(sql`${t.liftedAt} is null`),
    index('referral_enforcement_actions_partner_created_at_idx').on(
      t.partnerId,
      t.createdAt.desc(),
    ),
  ],
);

/**
 * `referral_enforcement_appeals` — the independent path (#148 control 14).
 *
 * ## Independence is TWO CHECKs, not a service comparison
 *
 * `imposed_by_oxy_user_id` is SNAPSHOTTED onto the appeal at submission, so the
 * database can compare it against the decider without a subquery a CHECK is not
 * allowed to contain. A decider who imposed the action, and a decider who is
 * the appellant, both have no row shape — which is #55's four-eyes reasoning
 * applied to the one decision a partner most needs somebody else to make.
 *
 * ## Append-only, with a precise exception
 *
 * UPDATE is refused except on the decision columns moving NULL → a value
 * exactly once, and DELETE is refused outright. An appeal somebody could delete
 * is not an appeal path, it is a suggestion box.
 */
export const referralEnforcementAppeals = pgTable(
  'referral_enforcement_appeals',
  {
    id: generatedId(),
    actionId: text()
      .notNull()
      .references(() => referralEnforcementActions.id, { onDelete: 'restrict' }),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    state: text({ enum: asEnumValues(REFERRAL_ENFORCEMENT_APPEAL_STATES) })
      .notNull()
      .default('open'),
    /** Snapshotted from the action — see the docblock. */
    imposedByOxyUserId: text().notNull(),
    /** The Oxy account that submitted it: the partner's owner, or their store's. */
    submittedByOxyUserId: text().notNull(),
    submittedReason: text().notNull(),
    submittedAt: timestamptz().notNull(),
    decidedByOxyUserId: text(),
    decisionReason: text(),
    decidedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'referral_enforcement_appeals_state_check',
      t.state,
      REFERRAL_ENFORCEMENT_APPEAL_STATES,
    ),
    // An appeal is never `none`: the row's existence IS an appeal.
    check('referral_enforcement_appeals_live_state_check', sql`${t.state} <> 'none'`),
    // The independence. Two comparisons, `is distinct from` rather than `<>`,
    // because `<>` against a NULL decider yields NULL and a CHECK reads NULL as
    // SATISFIED — which would make both halves vacuous on every open appeal,
    // exactly the rows they exist to constrain later.
    check(
      'referral_enforcement_appeals_independence_check',
      sql`${t.decidedByOxyUserId} is distinct from ${t.imposedByOxyUserId}
          and ${t.decidedByOxyUserId} is distinct from ${t.submittedByOxyUserId}`,
    ),
    // Decided exactly when it left `open`. TWO biconditionals, not one over
    // their conjunction: the single form is satisfied when both halves are
    // false, admitting an `accepted` row with no decider and no date.
    check(
      'referral_enforcement_appeals_decision_shape_check',
      sql`((${t.state} = 'open') = (${t.decidedByOxyUserId} is null))
          and ((${t.state} = 'open') = (${t.decidedAt} is null))`,
    ),
    check(
      'referral_enforcement_appeals_reason_check',
      sql`length(${t.submittedReason}) > 0
          and length(${t.submittedReason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}
          and (${t.decisionReason} is null
               or (length(${t.decisionReason}) > 0
                   and length(${t.decisionReason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}))`,
    ),
    check(
      'referral_enforcement_appeals_identity_check',
      sql`length(${t.submittedByOxyUserId}) > 0 and length(${t.imposedByOxyUserId}) > 0`,
    ),
    check(
      'referral_enforcement_appeals_time_check',
      sql`${t.decidedAt} is null or ${t.decidedAt} >= ${t.submittedAt}`,
    ),
    // ONE open appeal per action. A second concurrent appeal against one
    // decision is two reviewers reaching two answers about one row.
    uniqueIndex('referral_enforcement_appeals_open_key')
      .on(t.actionId)
      .where(sql`${t.state} = 'open'`),
    index('referral_enforcement_appeals_partner_idx').on(t.partnerId, t.createdAt.desc()),
    index('referral_enforcement_appeals_open_idx')
      .on(t.submittedAt)
      .where(sql`${t.state} = 'open'`),
  ],
);

/**
 * `referral_disclosure_requirements` — the copy a partner is given, versioned.
 *
 * ## Why (surface, market, language) and not one blob
 *
 * A link in a bio and a spoken sentence in a video are the same obligation with
 * different copy, and one text serving both fits neither. `*` is the
 * market-independent and language-independent default, so a deployment
 * publishes one row and refines it where a jurisdiction or a language needs
 * different words — and #148's *"support market and language variants"* costs
 * a row rather than a schema.
 *
 * ## No jurisdiction table, deliberately
 *
 * Which markets REQUIRE a disclosure is a legal question ADR 0005's open item 1
 * assigns to the legal entity, and a table of jurisdictions would be Mercaria
 * asserting an answer nobody gave it. What is representable is what Mercaria
 * DECIDED to require, per market, with `required` on the row and a version
 * behind it — so the decision has an author and a date whenever it is made.
 */
export const referralDisclosureRequirements = pgTable(
  'referral_disclosure_requirements',
  {
    id: generatedId(),
    disclosureKey: text().notNull(),
    version: integer().notNull(),
    status: text({ enum: asEnumValues(REFERRAL_DISCLOSURE_STATUSES) })
      .notNull()
      .default('draft'),
    surface: text({ enum: asEnumValues(REFERRAL_DISCLOSURE_SURFACES) }).notNull(),
    /** ISO-3166 alpha-2 upper case, or `*`. */
    market: text().notNull().default('*'),
    /** BCP-47 primary subtag lower case, or `*`. */
    language: text().notNull().default('*'),
    /** The exact sentence a partner renders. */
    copy: text().notNull(),
    /** Whether omitting it is a `disclosure_failure` under the conduct policy. */
    required: text({ enum: asEnumValues(['yes', 'no'] as const) })
      .notNull()
      .default('yes'),
    effectiveFrom: timestamptz().notNull(),
    publishedByOxyUserId: text(),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'referral_disclosure_requirements_status_check',
      t.status,
      REFERRAL_DISCLOSURE_STATUSES,
    ),
    checkOneOf(
      'referral_disclosure_requirements_surface_check',
      t.surface,
      REFERRAL_DISCLOSURE_SURFACES,
    ),
    check('referral_disclosure_requirements_required_check', sql`${t.required} in ('yes', 'no')`),
    check('referral_disclosure_requirements_version_check', sql`${t.version} >= 1`),
    check(
      'referral_disclosure_requirements_market_check',
      sql`${t.market} = '*' or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'referral_disclosure_requirements_language_check',
      sql`${t.language} = '*' or ${t.language} ~ '^[a-z]{2,3}$'`,
    ),
    check(
      'referral_disclosure_requirements_copy_check',
      sql`length(${t.copy}) > 0
          and length(${t.copy}) <= ${sql.raw(String(MAX_DISCLOSURE_LENGTH))}`,
    ),
    check(
      'referral_disclosure_requirements_publication_check',
      sql`((${t.status} = 'draft') = (${t.publishedAt} is null))
          and ((${t.status} = 'draft') = (${t.publishedByOxyUserId} is null))`,
    ),
    uniqueIndex('referral_disclosure_requirements_version_key').on(
      t.disclosureKey,
      t.surface,
      t.market,
      t.language,
      t.version,
    ),
    uniqueIndex('referral_disclosure_requirements_active_key')
      .on(t.disclosureKey, t.surface, t.market, t.language)
      .where(sql`${t.status} = 'active'`),
  ],
);
