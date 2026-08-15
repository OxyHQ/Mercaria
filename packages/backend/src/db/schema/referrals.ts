/**
 * The referral domain (#142, under ADR 0005): `referral_programs`,
 * `referral_partners`, `referral_codes`, `referral_links`, `referral_touches`,
 * `referral_attributions`, `referral_subject_redirects`,
 * `referral_conversions`, `referral_events`.
 *
 * Born in Postgres — like the payment domain, there is no Mongoose model any of
 * this is a port of, and the backfill has nothing to copy into it.
 *
 * ## The rules this file exists to hold
 *
 * **A program version is immutable once published** (issue #142: "An active
 * version cannot be edited. Publish a new version."). The schema's half of that
 * is `UNIQUE(program_id, version)` plus the one-active partial index; the
 * service's half is that every draft edit is a single-statement CAS on
 * `status = 'draft'`, pinned by a realdb test.
 *
 * **One winner per program and subject** (ADR 0005 D4's cardinality): the
 * partial unique index on `(program_id, subject_kind, subject_ref) WHERE
 * state = 'active'` is what makes two concurrent attributions of one subject
 * produce exactly one active row, the same way `payments_checkout_group_id_key`
 * makes a replayed checkout converge.
 *
 * **Touch data is separately retainable from durable records** (issue #142,
 * migration/scale 6). `referral_touches` carries its own `expires_at` and is
 * swept by `db/expiryTargets.ts`; NOTHING takes a foreign key into it. An
 * attribution snapshots its winning evidence into its own columns and carries
 * `winning_touch_id` as an unconstrained correlation, so sweeping a touch
 * erases the evidence trail's live end and never an earned attribution (ADR
 * 0005 D6).
 *
 * **No contact or payment data, structurally** (ADR 0005 A2). The only actor
 * identities representable are a pseudonymous guest-session reference and an
 * Oxy account id. There is no email column, no phone column, no device
 * fingerprint column — a boundary held by the SHAPE, not by a rule at the
 * write site.
 *
 * **The guest-session reference is an OPAQUE id, and stays one now that
 * `guest_sessions` EXISTS** (#103). The decision is purge semantics, not
 * timing: a guest session is hard-DELETED 7 days past expiry or revocation
 * (ADR 0003 D11, the two `db/expiryTargets.ts` entries), and referral evidence
 * must SURVIVE that purge — an attribution outlives its scope's expiry by
 * design (ADR 0005 D6). A `RESTRICT` foreign key would block the purge; a
 * `SET NULL`/`CASCADE` one would erase or delete earned evidence with it. So
 * `guest_session_ref` is correlation carried verbatim, exactly as every Oxy
 * user id is, and this schema imports nothing from the guest domain.
 *
 * **Affiliate redirects (#67) stay outside.** No table here can represent an
 * affiliate click: the touch-kind CHECK admits exactly the three first-party
 * kinds of ADR 0005 D4, so an external network's click has no row shape to
 * arrive in.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  ALL_CURRENCY_CODES,
  REFERRAL_ACTOR_KINDS,
  REFERRAL_APPEAL_STATES,
  REFERRAL_ATTRIBUTION_POLICIES,
  REFERRAL_ATTRIBUTION_STATES,
  REFERRAL_CHANNELS,
  REFERRAL_CLIENT_SURFACES,
  REFERRAL_COMMERCIAL_MODES,
  REFERRAL_CONFLICT_REASONS,
  REFERRAL_CONSENT_MODES,
  REFERRAL_CONVERSION_REASON_CODES,
  REFERRAL_CONVERSION_SOURCES,
  REFERRAL_CONVERSION_STATES,
  REFERRAL_CONVERSION_TYPES,
  REFERRAL_DESTINATION_TYPES,
  REFERRAL_EVENT_ACTIONS,
  REFERRAL_EVENT_ACTOR_KINDS,
  REFERRAL_EVENT_SUBJECT_TYPES,
  REFERRAL_INSTRUMENT_STATUSES,
  REFERRAL_PARTNER_OWNER_TYPES,
  REFERRAL_PARTNER_STATES,
  REFERRAL_PROGRAM_FAMILIES,
  REFERRAL_PROGRAM_STATUSES,
  REFERRAL_PROMOTION_METHODS,
  REFERRAL_READINESS_SUMMARIES,
  REFERRAL_RISK_STATES,
  REFERRAL_SUBJECT_KINDS,
  REFERRAL_TOUCH_KINDS,
  REFERRAL_TRAFFIC_CLASSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';

/** Bound on a stored audit reason — the `.slice()` at every writer. */
const MAX_REASON_LENGTH = 2_000;

/**
 * `referral_programs` — one row per program VERSION.
 *
 * The stable identity is `program_id` (a grouping token naming the set of
 * version rows, the `checkout_group_id` shape — there is no `programs` parent
 * entity to point at); the row is one immutable version of it. Editing is a
 * draft-only operation and publishing is a status transition, so "an active
 * version cannot be edited" is a property of the write paths plus the
 * one-active index below rather than a rule someone has to remember.
 *
 * ## Policy references are SEAMS, not implementations
 *
 * `commission_rule_ref`, `cap_policy_ref` and `payout_policy_ref` name records
 * owned by #144 (versioned rules) and #146 (payout policy). They are plain
 * text references — those systems do not exist yet, and a foreign key to a
 * table that has not landed would be invented structure. What #142 guarantees
 * is only that every published version NAMES its rules, so the pin at
 * attribution time (ADR 0005 D19) has something exact to pin.
 */
export const referralPrograms = pgTable(
  'referral_programs',
  {
    id: generatedId(),
    /** The stable program identity every version row shares. */
    programId: text().notNull(),
    /** 1-based, dense per program. Immutable once the row exists. */
    version: integer().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    /** The buyer-facing terms summary, safe to render verbatim. */
    publicTermsSummary: text().notNull(),
    family: text({ enum: asEnumValues(REFERRAL_PROGRAM_FAMILIES) }).notNull(),
    status: text({ enum: asEnumValues(REFERRAL_PROGRAM_STATUSES) }).notNull().default('draft'),
    /** Required by the time the version is published; a draft may not know it yet. */
    effectiveStartAt: timestamptz(),
    effectiveEndAt: timestamptz(),
    /** Who may enroll — a subset of the partner owner types (ADR 0005 D2). */
    eligiblePartnerTypes: text().array().notNull(),
    /** What kinds of subject this program may attribute. */
    eligibleSubjectKinds: text().array().notNull(),
    /**
     * Scope arrays. Empty means UNRESTRICTED — one spelling of "all", so a
     * reader never has to treat NULL and `{}` as two absences.
     */
    markets: text().array().notNull().default([]),
    currencies: text().array().notNull().default([]),
    channels: text().array().notNull().default([]),
    commercialModes: text().array().notNull().default([]),
    /** The touch rule this version pins (ADR 0005 D4). Exactly one exists today. */
    attributionPolicy: text({ enum: asEnumValues(REFERRAL_ATTRIBUTION_POLICIES) }).notNull(),
    /** Touch → conversion window, in days (D4: 30 for the launch programs). */
    attributionWindowDays: integer().notNull(),
    /** Merchant signup → activation runway (D4's 90 days). NULL for buyer programs. */
    activationWindowDays: integer(),
    /** Which milestone converts (ADR 0005 D11) — the conversion-type vocabulary. */
    qualifyingEventPolicy: text({ enum: asEnumValues(REFERRAL_CONVERSION_TYPES) }).notNull(),
    /** The #144 rule version this program version pays under. A reference, never a copy. */
    commissionRuleRef: text().notNull(),
    /** Hold before vesting, in days (ADR 0005 D12). */
    holdDays: integer().notNull(),
    /** The #144 cap policy, when one applies. */
    capPolicyRef: text(),
    /** The #146 payout policy reference. */
    payoutPolicyRef: text().notNull(),
    termsVersion: text().notNull(),
    disclosureVersion: text().notNull(),
    createdByOxyUserId: text().notNull(),
    /** Set at publish, never before — the CHECK below holds the pair together. */
    approvedByOxyUserId: text(),
    /** Feature-flag / cohort scoping for staged rollout (ADR 0005's three phases). */
    featureFlagKey: text(),
    cohortKeys: text().array().notNull().default([]),
    publishedAt: timestamptz(),
    pausedAt: timestamptz(),
    endedAt: timestamptz(),
    retiredAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('referral_programs_family_check', t.family, REFERRAL_PROGRAM_FAMILIES),
    checkOneOf('referral_programs_status_check', t.status, REFERRAL_PROGRAM_STATUSES),
    checkOneOf(
      'referral_programs_attribution_policy_check',
      t.attributionPolicy,
      REFERRAL_ATTRIBUTION_POLICIES,
    ),
    checkOneOf(
      'referral_programs_qualifying_event_policy_check',
      t.qualifyingEventPolicy,
      REFERRAL_CONVERSION_TYPES,
    ),
    checkEveryElementOf(
      'referral_programs_eligible_partner_types_check',
      t.eligiblePartnerTypes,
      REFERRAL_PARTNER_OWNER_TYPES,
    ),
    checkEveryElementOf(
      'referral_programs_eligible_subject_kinds_check',
      t.eligibleSubjectKinds,
      REFERRAL_SUBJECT_KINDS,
    ),
    checkEveryElementOf('referral_programs_currencies_check', t.currencies, ALL_CURRENCY_CODES),
    checkEveryElementOf('referral_programs_channels_check', t.channels, REFERRAL_CHANNELS),
    checkEveryElementOf(
      'referral_programs_commercial_modes_check',
      t.commercialModes,
      REFERRAL_COMMERCIAL_MODES,
    ),
    // The two eligibility sets have no "all" spelling: a program that names
    // nobody who can enroll and nothing that can be referred is not a program.
    check(
      'referral_programs_eligibility_nonempty_check',
      sql`cardinality(${t.eligiblePartnerTypes}) > 0 and cardinality(${t.eligibleSubjectKinds}) > 0`,
    ),
    // Markets are an open ISO-3166 set (no enumeration to contain them in), but
    // an empty string is never a market and would read as a real element.
    check('referral_programs_markets_check', sql`not ('' = any(${t.markets}))`),
    check('referral_programs_cohort_keys_check', sql`not ('' = any(${t.cohortKeys}))`),
    check(
      'referral_programs_identity_check',
      sql`length(${t.programId}) > 0 and ${t.version} >= 1 and length(${t.name}) > 0
          and length(${t.publicTermsSummary}) > 0 and length(${t.termsVersion}) > 0
          and length(${t.disclosureVersion}) > 0 and length(${t.commissionRuleRef}) > 0
          and length(${t.payoutPolicyRef}) > 0 and length(${t.createdByOxyUserId}) > 0`,
    ),
    check(
      'referral_programs_windows_check',
      sql`${t.attributionWindowDays} > 0 and ${t.holdDays} >= 0
          and (${t.activationWindowDays} is null or ${t.activationWindowDays} > 0)`,
    ),
    check(
      'referral_programs_effective_window_check',
      sql`${t.effectiveEndAt} is null or ${t.effectiveStartAt} is null
          or ${t.effectiveEndAt} > ${t.effectiveStartAt}`,
    ),
    // A published version was approved and scheduled; a draft need not be. The
    // pair travels together so "who approved the live terms" always has an
    // answer (issue field 15).
    check(
      'referral_programs_published_check',
      sql`${t.status} = 'draft'
          or (${t.approvedByOxyUserId} is not null and ${t.publishedAt} is not null
              and ${t.effectiveStartAt} is not null)`,
    ),
    // One-directional status/timestamp agreements — a later state may retain an
    // earlier timestamp (a retired program keeps its paused_at), so equality
    // would be wrong.
    check(
      'referral_programs_status_times_check',
      sql`(${t.status} <> 'paused' or ${t.pausedAt} is not null)
          and (${t.status} <> 'ended' or ${t.endedAt} is not null)
          and (${t.status} <> 'retired' or ${t.retiredAt} is not null)`,
    ),
    uniqueIndex('referral_programs_program_id_version_key').on(t.programId, t.version),
    // ONE active version per program: instruments and attributions resolve "the
    // program" to exactly one set of live terms, and two publishers racing
    // converge instead of double-activating.
    uniqueIndex('referral_programs_one_active_key')
      .on(t.programId)
      .where(sql`${t.status} = 'active'`),
    // "Which programs are live / starting" — the operator list and the
    // scheduled-activation sweep.
    index('referral_programs_status_start_idx').on(t.status, t.effectiveStartAt),
  ],
);

/**
 * `referral_partners` — one participant, ever, per owner (ADR 0005 D2).
 *
 * Separate from the PUBLIC identity (Oxy owns that; `display_name` is the
 * partner's own marketing name, not a copy of an Oxy profile) and from the
 * payout BENEFICIARY (`payout_beneficiary_ref` names a `provider_accounts` row
 * once #146 wires it — a reference, because a partner must be representable
 * before they are payable, and D15 gates payout on readiness rather than
 * gating enrollment on paperwork).
 *
 * The readiness columns are SUMMARIES imported from #146's machinery — the
 * `onboarding_state` discipline: one stored verdict per concern, nothing here
 * re-derives it, and integer/enum columns cannot carry the identity documents
 * the verdict was derived from.
 */
export const referralPartners = pgTable(
  'referral_partners',
  {
    id: generatedId(),
    ownerType: text({ enum: asEnumValues(REFERRAL_PARTNER_OWNER_TYPES) }).notNull(),
    /** A store id or an Oxy account id — polymorphic by `owner_type`, no foreign key. */
    ownerId: text().notNull(),
    /** The partner's public-facing display identity for disclosure surfaces. */
    displayName: text().notNull(),
    state: text({ enum: asEnumValues(REFERRAL_PARTNER_STATES) }).notNull().default('applied'),
    /** Enrollment history summary — the full trail is `referral_events`. */
    appliedAt: timestamptz(),
    invitedAt: timestamptz(),
    approvedAt: timestamptz(),
    /** Which terms version was accepted, and when — absent together. */
    termsVersion: text(),
    termsAcceptedAt: timestamptz(),
    promotionMethods: text().array().notNull().default([]),
    /** The `provider_accounts` row referral payouts pay through, once #146 wires it. */
    payoutBeneficiaryRef: text(),
    taxReadiness: text({ enum: asEnumValues(REFERRAL_READINESS_SUMMARIES) })
      .notNull()
      .default('unknown'),
    identityReadiness: text({ enum: asEnumValues(REFERRAL_READINESS_SUMMARIES) })
      .notNull()
      .default('unknown'),
    payoutReadiness: text({ enum: asEnumValues(REFERRAL_READINESS_SUMMARIES) })
      .notNull()
      .default('unknown'),
    riskState: text({ enum: asEnumValues(REFERRAL_RISK_STATES) }).notNull().default('none'),
    suspendedAt: timestamptz(),
    terminatedAt: timestamptz(),
    appealState: text({ enum: asEnumValues(REFERRAL_APPEAL_STATES) }).notNull().default('none'),
    reviewedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('referral_partners_owner_type_check', t.ownerType, REFERRAL_PARTNER_OWNER_TYPES),
    checkOneOf('referral_partners_state_check', t.state, REFERRAL_PARTNER_STATES),
    checkOneOf(
      'referral_partners_tax_readiness_check',
      t.taxReadiness,
      REFERRAL_READINESS_SUMMARIES,
    ),
    checkOneOf(
      'referral_partners_identity_readiness_check',
      t.identityReadiness,
      REFERRAL_READINESS_SUMMARIES,
    ),
    checkOneOf(
      'referral_partners_payout_readiness_check',
      t.payoutReadiness,
      REFERRAL_READINESS_SUMMARIES,
    ),
    checkOneOf('referral_partners_risk_state_check', t.riskState, REFERRAL_RISK_STATES),
    checkOneOf('referral_partners_appeal_state_check', t.appealState, REFERRAL_APPEAL_STATES),
    checkEveryElementOf(
      'referral_partners_promotion_methods_check',
      t.promotionMethods,
      REFERRAL_PROMOTION_METHODS,
    ),
    check(
      'referral_partners_identity_check',
      sql`length(${t.ownerId}) > 0 and length(${t.displayName}) > 0`,
    ),
    // Accepted terms name their version; a version nobody accepted names no time.
    check(
      'referral_partners_terms_check',
      sql`(${t.termsVersion} is null) = (${t.termsAcceptedAt} is null)`,
    ),
    check(
      'referral_partners_state_times_check',
      sql`(${t.state} <> 'suspended' or ${t.suspendedAt} is not null)
          and (${t.state} <> 'terminated' or ${t.terminatedAt} is not null)`,
    ),
    // ADR 0005 D2: one partner record per owner, ever.
    uniqueIndex('referral_partners_owner_key').on(t.ownerType, t.ownerId),
    index('referral_partners_state_idx').on(t.state),
  ],
);

/**
 * `referral_codes` — a human-readable instrument, owned by one partner forever
 * (ADR 0005 D3).
 *
 * Codes are stored NORMALIZED (lower-case, enforced by CHECK) and are globally
 * unique case-insensitively — the unique index is on `lower(code)` anyway, so
 * uniqueness holds even against a write path that forgets to normalize.
 * Retiring a code keeps the row and its reservation permanently: an
 * attribution recorded against it must stay explicable, and a recycled code
 * would let a new owner inherit another partner's history.
 *
 * A vanity RENAME is a NEW row pointing at its canonical ancestor through
 * `alias_of_code_id` — the alias history is rows, resolvable and uniqueness-
 * checked by the same index as everything else, never a rewrite of the code a
 * touch already named.
 *
 * The destination pair can only name an INTERNAL surface: a closed type plus
 * an opaque reference, mapped to a route in exactly one place
 * (`services/referrals/destinations.ts`). No column can hold a URL, which is
 * what "cannot become an open redirect" means structurally.
 */
export const referralCodes = pgTable(
  'referral_codes',
  {
    id: generatedId(),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    /** The exact program version this instrument was issued under (issue field 2). */
    programVersionId: text()
      .notNull()
      .references(() => referralPrograms.id, { onDelete: 'restrict' }),
    /** Normalized lower-case; the CHECK is the namespace and case policy. */
    code: text().notNull(),
    /** The canonical code this row is a vanity alias of, when it is one. */
    aliasOfCodeId: text().references((): AnyPgColumn => referralCodes.id, {
      onDelete: 'restrict',
    }),
    status: text({ enum: asEnumValues(REFERRAL_INSTRUMENT_STATUSES) }).notNull().default('active'),
    destinationType: text({ enum: asEnumValues(REFERRAL_DESTINATION_TYPES) }),
    /** The destination's own id (listing/collection/store) — never a URL. */
    destinationRef: text(),
    campaignRef: text(),
    contentKey: text(),
    /** ISO-3166-1 alpha-2, upper-cased, when the instrument is market-scoped. */
    market: text(),
    locale: text(),
    activatedAt: timestamptz(),
    pausedAt: timestamptz(),
    expiresAt: timestamptz(),
    revokedAt: timestamptz(),
    retiredAt: timestamptz(),
    /** Conversion ceiling, when configured (issue field 9). */
    maxUses: integer(),
    disclosureRequired: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('referral_codes_status_check', t.status, REFERRAL_INSTRUMENT_STATUSES),
    checkOneOf('referral_codes_destination_type_check', t.destinationType, REFERRAL_DESTINATION_TYPES),
    // The namespace and case policy (ADR 0005 D3): lower-case letters, digits
    // and hyphens, 3–32 characters, starting alphanumeric. `lower()` in the
    // CHECK would be redundant with the pattern but states the policy.
    check('referral_codes_code_check', sql`${t.code} ~ '^[a-z0-9][a-z0-9-]{2,31}$'`),
    // A destination is complete or absent: `home` needs no reference, an entity
    // destination requires one, and a reference without a type is unreadable.
    check(
      'referral_codes_destination_check',
      sql`(${t.destinationType} is null and ${t.destinationRef} is null)
          or (${t.destinationType} = 'home' and ${t.destinationRef} is null)
          or (${t.destinationType} in ('listing', 'collection', 'store')
              and ${t.destinationRef} is not null and length(${t.destinationRef}) > 0)`,
    ),
    check(
      'referral_codes_market_check',
      sql`${t.market} is null or (${t.market} = upper(${t.market}) and length(${t.market}) = 2)`,
    ),
    check('referral_codes_max_uses_check', sql`${t.maxUses} is null or ${t.maxUses} > 0`),
    check(
      'referral_codes_status_times_check',
      sql`(${t.status} <> 'revoked' or ${t.revokedAt} is not null)
          and (${t.status} <> 'retired' or ${t.retiredAt} is not null)`,
    ),
    // Global case-insensitive uniqueness, on the EXPRESSION rather than the
    // column: holds even against a writer that skips normalization, and it is
    // the reservation that retirement keeps forever.
    uniqueIndex('referral_codes_code_key').on(sql`lower(${t.code})`),
    index('referral_codes_partner_id_idx').on(t.partnerId, t.createdAt.desc()),
    index('referral_codes_program_version_id_idx').on(t.programVersionId),
    index('referral_codes_alias_of_code_id_idx')
      .on(t.aliasOfCodeId)
      .where(sql`${t.aliasOfCodeId} is not null`),
  ],
);

/**
 * `referral_links` — a shareable instrument wrapping a code (ADR 0005 D3).
 *
 * `token` is the SIGNED opaque value the wild sees (HMAC over the link's own
 * ids — no partner data, no customer data, nothing secret inside; see
 * `services/referrals/link-token.ts`). The row is the lifecycle authority: a
 * revoked link dies immediately regardless of what its token says, which is
 * why the token deliberately carries no expiry of its own.
 *
 * `click_count` exists to make the click LIMIT enforceable in one statement —
 * the `$inc`-guard discipline: `set click_count = click_count + 1 where
 * max_clicks is null or click_count < max_clicks`, so two concurrent clicks at
 * the ceiling admit exactly one.
 */
export const referralLinks = pgTable(
  'referral_links',
  {
    id: generatedId(),
    codeId: text()
      .notNull()
      .references(() => referralCodes.id, { onDelete: 'restrict' }),
    /** The signed opaque token, verbatim as shared. Unique — one spelling per link. */
    token: text().notNull(),
    status: text({ enum: asEnumValues(REFERRAL_INSTRUMENT_STATUSES) }).notNull().default('active'),
    /** Optional override of the code's destination — same closed shape. */
    destinationType: text({ enum: asEnumValues(REFERRAL_DESTINATION_TYPES) }),
    destinationRef: text(),
    campaignRef: text(),
    contentKey: text(),
    market: text(),
    locale: text(),
    activatedAt: timestamptz(),
    pausedAt: timestamptz(),
    expiresAt: timestamptz(),
    revokedAt: timestamptz(),
    maxClicks: integer(),
    clickCount: bigint({ mode: 'number' }).notNull().default(0),
    disclosureRequired: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('referral_links_status_check', t.status, REFERRAL_INSTRUMENT_STATUSES),
    checkOneOf('referral_links_destination_type_check', t.destinationType, REFERRAL_DESTINATION_TYPES),
    check('referral_links_token_check', sql`length(${t.token}) > 0`),
    check(
      'referral_links_destination_check',
      sql`(${t.destinationType} is null and ${t.destinationRef} is null)
          or (${t.destinationType} = 'home' and ${t.destinationRef} is null)
          or (${t.destinationType} in ('listing', 'collection', 'store')
              and ${t.destinationRef} is not null and length(${t.destinationRef}) > 0)`,
    ),
    check(
      'referral_links_market_check',
      sql`${t.market} is null or (${t.market} = upper(${t.market}) and length(${t.market}) = 2)`,
    ),
    check(
      'referral_links_click_limit_check',
      sql`(${t.maxClicks} is null or ${t.maxClicks} > 0) and ${t.clickCount} >= 0
          and (${t.maxClicks} is null or ${t.clickCount} <= ${t.maxClicks})`,
    ),
    check(
      'referral_links_status_times_check',
      sql`${t.status} <> 'revoked' or ${t.revokedAt} is not null`,
    ),
    // The signed-token lookup (issue, migration/scale 3) and the guarantee that
    // one token names one link.
    uniqueIndex('referral_links_token_key').on(t.token),
    index('referral_links_code_id_idx').on(t.codeId, t.createdAt.desc()),
  ],
);

/**
 * `referral_touches` — privacy-conscious, append-only touch evidence.
 *
 * A touch is NOT a conversion and cannot create earnings (issue #142): nothing
 * reads this table to book anything — the attribution resolver reads it to
 * pick a winner, snapshots the winning evidence onto the attribution, and the
 * money path never sees it.
 *
 * No `updated_at` — the ABSENCE is the append-only contract, the
 * `order_status_history` shape. No foreign key points INTO this table, and
 * `expires_at` is swept by `db/expiryTargets.ts`: raw touch volume is
 * retainable separately from the durable records derived from it (issue,
 * migration/scale 6; ADR 0005 D6).
 *
 * The actor columns are the WHOLE identity surface: a pseudonymous
 * guest-session reference (an opaque id from #101/#103's subsystem — no
 * import, no foreign key) or an Oxy account id, exactly one, held exclusive by
 * CHECK. Contact and payment data have no columns to arrive in.
 */
export const referralTouches = pgTable(
  'referral_touches',
  {
    id: generatedId(),
    /** The program version LIVE when the touch happened (not the instrument's). */
    programVersionId: text()
      .notNull()
      .references(() => referralPrograms.id, { onDelete: 'restrict' }),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    /** Every touch names its code; a link touch names the link as well. */
    codeId: text()
      .notNull()
      .references(() => referralCodes.id, { onDelete: 'restrict' }),
    linkId: text().references(() => referralLinks.id, { onDelete: 'restrict' }),
    touchKind: text({ enum: asEnumValues(REFERRAL_TOUCH_KINDS) }).notNull(),
    occurredAt: timestamptz().notNull(),
    clientSurface: text({ enum: asEnumValues(REFERRAL_CLIENT_SURFACES) }).notNull(),
    /** The destination context the touch resolved to, snapshotted. */
    destinationType: text({ enum: asEnumValues(REFERRAL_DESTINATION_TYPES) }),
    destinationRef: text(),
    actorKind: text({ enum: asEnumValues(REFERRAL_ACTOR_KINDS) }).notNull(),
    /**
     * Opaque pseudonymous guest-session id (#103). Deliberately NO foreign key
     * even though `guest_sessions` is a table in this database: session rows
     * are hard-purged on their own clock (ADR 0003 D11) and touch evidence
     * must survive the purge — see this file's docblock.
     */
    guestSessionRef: text(),
    oxyUserId: text(),
    /** Merchant-referral claim context, when the touch is about becoming one. */
    merchantCandidateRef: text(),
    trafficClass: text({ enum: asEnumValues(REFERRAL_TRAFFIC_CLASSES) })
      .notNull()
      .default('organic'),
    consentMode: text({ enum: asEnumValues(REFERRAL_CONSENT_MODES) }).notNull(),
    /** When this touch stops being attribution-eligible (ADR 0005 D4's window). */
    attributionWindowExpiresAt: timestamptz().notNull(),
    /** Safe campaign metadata — keys, never free-form tracking payloads. */
    campaignRef: text(),
    contentKey: text(),
    /** Set at insert and never advanced. Swept by `db/expiryTargets.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('referral_touches_touch_kind_check', t.touchKind, REFERRAL_TOUCH_KINDS),
    checkOneOf('referral_touches_client_surface_check', t.clientSurface, REFERRAL_CLIENT_SURFACES),
    checkOneOf(
      'referral_touches_destination_type_check',
      t.destinationType,
      REFERRAL_DESTINATION_TYPES,
    ),
    checkOneOf('referral_touches_actor_kind_check', t.actorKind, REFERRAL_ACTOR_KINDS),
    checkOneOf('referral_touches_traffic_class_check', t.trafficClass, REFERRAL_TRAFFIC_CLASSES),
    checkOneOf('referral_touches_consent_mode_check', t.consentMode, REFERRAL_CONSENT_MODES),
    // Exactly one actor identity, matching its kind — "guest or Oxy actor
    // only", held by shape (ADR 0005 A1/A2).
    check(
      'referral_touches_actor_check',
      sql`((${t.actorKind} = 'guest_session') = (${t.guestSessionRef} is not null))
          and ((${t.actorKind} = 'oxy_user') = (${t.oxyUserId} is not null))`,
    ),
    check(
      'referral_touches_actor_nonempty_check',
      sql`(${t.guestSessionRef} is null or length(${t.guestSessionRef}) > 0)
          and (${t.oxyUserId} is null or length(${t.oxyUserId}) > 0)`,
    ),
    // A link click without its link would be evidence that cannot be traced.
    check(
      'referral_touches_link_check',
      sql`${t.touchKind} <> 'link_click' or ${t.linkId} is not null`,
    ),
    // Raw retention outlives attribution eligibility, never the reverse: a
    // touch swept while still eligible would erase evidence a resolver may
    // still cite.
    check(
      'referral_touches_expiry_order_check',
      sql`${t.expiresAt} >= ${t.attributionWindowExpiresAt}
          and ${t.attributionWindowExpiresAt} > ${t.occurredAt}`,
    ),
    // The resolver's read: latest eligible touch for a code/partner.
    index('referral_touches_code_id_occurred_at_idx').on(t.codeId, t.occurredAt.desc()),
    index('referral_touches_partner_id_occurred_at_idx').on(t.partnerId, t.occurredAt.desc()),
    // Subject-side reads, partial — most touches have exactly one side set.
    index('referral_touches_guest_session_ref_idx')
      .on(t.guestSessionRef, t.occurredAt.desc())
      .where(sql`${t.guestSessionRef} is not null`),
    index('referral_touches_oxy_user_id_idx')
      .on(t.oxyUserId, t.occurredAt.desc())
      .where(sql`${t.oxyUserId} is not null`),
    // Window expiry (issue, migration/scale 3) and the leading btree the
    // retention sweep needs.
    index('referral_touches_window_expires_at_idx').on(t.attributionWindowExpiresAt),
    index('referral_touches_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `referral_attributions` — the immutable, append-only-corrected record that
 * ONE partner referred ONE subject under ONE program (issue #142; ADR 0005 D19).
 *
 * ## What immutability means here, exactly
 *
 * A row's identity, evidence and pinned versions never change. The ONLY
 * mutations are state transitions out of `active` (superseded / conflicted /
 * invalidated / corrected), each carrying its bounded reason and resolution
 * time. A correction or supersession is a NEW row that names its PREDECESSOR
 * (`supersedes_attribution_id`) — the pointer runs backwards in time on
 * purpose, the reversing-ledger-transaction direction: the predecessor already
 * exists and never changes, so the reference is a real foreign key, while a
 * forward pointer would require editing a resolved row to know its future.
 *
 * ## The winner-cardinality index
 *
 * `(program_id, subject_kind, subject_ref) WHERE state = 'active'` is ADR 0005
 * D4's "one winner per program and subject" as a constraint rather than a
 * convention: two concurrent resolvers produce exactly one active row, and
 * last-touch supersession is an ordered pair of writes inside one transaction.
 *
 * ## Evidence is SNAPSHOTTED, and `winning_touch_id` is correlation
 *
 * Touches are swept on their own retention (see `referral_touches`), so the
 * attribution carries its own copy of the facts it was decided on — the
 * winning code (a real FK: code rows live forever, D3), the touch kind and the
 * touch time. `winning_touch_id` is an unconstrained pointer into the
 * separately-retained evidence store: present while the raw row lives, dangling
 * honestly after the sweep, exactly as ADR 0005 D6 describes.
 *
 * The subject reference is an OPAQUE id in the subject's own key space — an
 * Oxy account id, a guest checkout scope id (#101/#103's subsystem, no import,
 * no foreign key), or a merchant candidate reference. Email, card, phone and
 * device fingerprints are not representable as subjects (A2).
 */
export const referralAttributions = pgTable(
  'referral_attributions',
  {
    id: generatedId(),
    /** The stable program identity — half of the winner-cardinality key. */
    programId: text().notNull(),
    /** The EXACT version live at attribution time (D19's pin). */
    programVersionId: text()
      .notNull()
      .references(() => referralPrograms.id, { onDelete: 'restrict' }),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    subjectKind: text({ enum: asEnumValues(REFERRAL_SUBJECT_KINDS) }).notNull(),
    /** The subject's own opaque reference — never contact or payment data. */
    subjectRef: text().notNull(),
    /** Correlation into the separately-retained touch store — no foreign key. */
    winningTouchId: text(),
    winningCodeId: text()
      .notNull()
      .references(() => referralCodes.id, { onDelete: 'restrict' }),
    /** Evidence snapshot: what kind of touch won, and when it happened. */
    evidenceTouchKind: text({ enum: asEnumValues(REFERRAL_TOUCH_KINDS) }).notNull(),
    evidenceOccurredAt: timestamptz().notNull(),
    /** The policy this row was decided under, and the #144 rule version it pins. */
    attributionPolicy: text({ enum: asEnumValues(REFERRAL_ATTRIBUTION_POLICIES) }).notNull(),
    ruleVersionRef: text().notNull(),
    /** When this attribution stops converting — evidence time + the window. */
    expiresAt: timestamptz().notNull(),
    state: text({ enum: asEnumValues(REFERRAL_ATTRIBUTION_STATES) }).notNull().default('active'),
    conflictReason: text({ enum: asEnumValues(REFERRAL_CONFLICT_REASONS) }),
    resolvedAt: timestamptz(),
    /** The predecessor this row superseded or corrected, when it has one. */
    supersedesAttributionId: text().references((): AnyPgColumn => referralAttributions.id, {
      onDelete: 'restrict',
    }),
    /** Whether the winning touch came from a guest session or an Oxy actor. */
    originalActorKind: text({ enum: asEnumValues(REFERRAL_ACTOR_KINDS) }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('referral_attributions_subject_kind_check', t.subjectKind, REFERRAL_SUBJECT_KINDS),
    checkOneOf(
      'referral_attributions_evidence_touch_kind_check',
      t.evidenceTouchKind,
      REFERRAL_TOUCH_KINDS,
    ),
    checkOneOf(
      'referral_attributions_attribution_policy_check',
      t.attributionPolicy,
      REFERRAL_ATTRIBUTION_POLICIES,
    ),
    checkOneOf('referral_attributions_state_check', t.state, REFERRAL_ATTRIBUTION_STATES),
    checkOneOf(
      'referral_attributions_conflict_reason_check',
      t.conflictReason,
      REFERRAL_CONFLICT_REASONS,
    ),
    checkOneOf(
      'referral_attributions_original_actor_kind_check',
      t.originalActorKind,
      REFERRAL_ACTOR_KINDS,
    ),
    check(
      'referral_attributions_identity_check',
      sql`length(${t.programId}) > 0 and length(${t.subjectRef}) > 0
          and length(${t.ruleVersionRef}) > 0`,
    ),
    // An active row carries no resolution; a resolved row explains itself.
    // Two-directional on purpose — a reason on an active row and a resolved row
    // with no reason are both records that cannot be read.
    check(
      'referral_attributions_resolution_check',
      sql`((${t.state} = 'active') = (${t.conflictReason} is null))
          and ((${t.state} = 'active') = (${t.resolvedAt} is null))`,
    ),
    // A row cannot be its own predecessor.
    check(
      'referral_attributions_supersedes_check',
      sql`${t.supersedesAttributionId} is null or ${t.supersedesAttributionId} <> ${t.id}`,
    ),
    check(
      'referral_attributions_expiry_check',
      sql`${t.expiresAt} > ${t.evidenceOccurredAt}`,
    ),
    // ADR 0005 D4's winner cardinality: ONE active attribution per program and
    // subject. The concurrent loser's insert fails here and is mapped to a
    // conflict, never a duplicate winner.
    uniqueIndex('referral_attributions_active_winner_key')
      .on(t.programId, t.subjectKind, t.subjectRef)
      .where(sql`${t.state} = 'active'`),
    index('referral_attributions_partner_id_idx').on(t.partnerId, t.createdAt.desc()),
    index('referral_attributions_subject_idx').on(t.subjectKind, t.subjectRef, t.createdAt.desc()),
    // Attribution expiry reads (issue, migration/scale 3) — only active rows
    // ever need the scan.
    index('referral_attributions_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'active'`),
    index('referral_attributions_program_version_id_idx').on(t.programVersionId),
    // "What replaced X" — the successor lookup, partial because most rows
    // never supersede anything.
    index('referral_attributions_supersedes_idx')
      .on(t.supersedesAttributionId)
      .where(sql`${t.supersedesAttributionId} is not null`),
  ],
);

/**
 * `referral_subject_redirects` — identity merges preserved as REDIRECTS
 * (issue #142, identity/uniqueness 6).
 *
 * When a product, merchant or Oxy identity merge collapses one subject
 * reference into another, history is NOT rewritten: every attribution keeps
 * the reference it was created with, and this table records `from → to` so
 * reads and new attributions resolve through it. Append-only — a redirect is a
 * fact about a merge that happened, and `UNIQUE(subject_kind, from_ref)` means
 * one reference redirects to exactly one place.
 */
export const referralSubjectRedirects = pgTable(
  'referral_subject_redirects',
  {
    id: generatedId(),
    subjectKind: text({ enum: asEnumValues(REFERRAL_SUBJECT_KINDS) }).notNull(),
    fromRef: text().notNull(),
    toRef: text().notNull(),
    actorKind: text({ enum: asEnumValues(REFERRAL_EVENT_ACTOR_KINDS) }).notNull(),
    actorRef: text(),
    reason: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'referral_subject_redirects_subject_kind_check',
      t.subjectKind,
      REFERRAL_SUBJECT_KINDS,
    ),
    checkOneOf(
      'referral_subject_redirects_actor_kind_check',
      t.actorKind,
      REFERRAL_EVENT_ACTOR_KINDS,
    ),
    check(
      'referral_subject_redirects_refs_check',
      sql`length(${t.fromRef}) > 0 and length(${t.toRef}) > 0 and ${t.fromRef} <> ${t.toRef}`,
    ),
    check(
      'referral_subject_redirects_reason_check',
      sql`length(${t.reason}) > 0 and length(${t.reason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    check(
      'referral_subject_redirects_actor_check',
      sql`${t.actorKind} = 'system' or ${t.actorRef} is not null`,
    ),
    uniqueIndex('referral_subject_redirects_from_key').on(t.subjectKind, t.fromRef),
    index('referral_subject_redirects_to_idx').on(t.subjectKind, t.toRef),
  ],
);

/**
 * `referral_conversions` — a verified milestone, separate from attribution
 * (issue #142 §ReferralConversion).
 *
 * Derived ONLY from durable source events (a paid order's processing, a
 * merchant activation) — never from a client. The idempotency key is
 * deterministic from the source event, and the TWO unique indexes below are
 * the replay guarantee and the one-source-one-conversion rule respectively: a
 * redelivered source event converges on the row it already made, and one
 * source event cannot pay several partners (identity/uniqueness 4 and 5 — the
 * launch programs support no split, so the constraint says so).
 *
 * No amount columns, deliberately: what a conversion is WORTH is #144/#145's
 * versioned-rule and earnings-ledger territory. This row is the fact that a
 * qualifying milestone verifiably happened, with `revenue_base_ref` as the
 * seam the revenue-base record (#144) attaches through.
 */
export const referralConversions = pgTable(
  'referral_conversions',
  {
    id: generatedId(),
    attributionId: text()
      .notNull()
      .references(() => referralAttributions.id, { onDelete: 'restrict' }),
    /** The exact program version, denormalized from the attribution's pin. */
    programVersionId: text()
      .notNull()
      .references(() => referralPrograms.id, { onDelete: 'restrict' }),
    conversionType: text({ enum: asEnumValues(REFERRAL_CONVERSION_TYPES) }).notNull(),
    sourceKind: text({ enum: asEnumValues(REFERRAL_CONVERSION_SOURCES) }).notNull(),
    /** The source aggregate's own id (an order id, a store id) — correlation. */
    sourceRef: text().notNull(),
    /** The durable event within the aggregate this conversion was derived from. */
    sourceEventId: text().notNull(),
    /** Deterministic from the source event; the replay-convergence key. */
    idempotencyKey: text().notNull(),
    /** When the milestone happened, per its own aggregate. */
    occurredAt: timestamptz().notNull(),
    verifiedAt: timestamptz(),
    state: text({ enum: asEnumValues(REFERRAL_CONVERSION_STATES) }).notNull().default('pending'),
    reasonCode: text({ enum: asEnumValues(REFERRAL_CONVERSION_REASON_CODES) }),
    /** The #144 revenue-base record, once one exists. A seam, not a value. */
    revenueBaseRef: text(),
    /** The row that corrected this one, for `corrected` rows. */
    correctedByConversionId: text().references((): AnyPgColumn => referralConversions.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'referral_conversions_conversion_type_check',
      t.conversionType,
      REFERRAL_CONVERSION_TYPES,
    ),
    checkOneOf('referral_conversions_source_kind_check', t.sourceKind, REFERRAL_CONVERSION_SOURCES),
    checkOneOf('referral_conversions_state_check', t.state, REFERRAL_CONVERSION_STATES),
    checkOneOf('referral_conversions_reason_code_check', t.reasonCode, REFERRAL_CONVERSION_REASON_CODES),
    check(
      'referral_conversions_identity_check',
      sql`length(${t.sourceRef}) > 0 and length(${t.sourceEventId}) > 0
          and length(${t.idempotencyKey}) > 0`,
    ),
    // A refusal or reversal explains itself with a bounded code (ADR 0005 D16:
    // an effect that did not happen must be distinguishable from one that
    // silently vanished).
    check(
      'referral_conversions_reason_check',
      sql`${t.state} not in ('rejected', 'reversed', 'corrected') or ${t.reasonCode} is not null`,
    ),
    // An eligible conversion was verified at a recorded moment.
    check(
      'referral_conversions_verified_check',
      sql`${t.state} <> 'eligible' or ${t.verifiedAt} is not null`,
    ),
    check(
      'referral_conversions_corrected_check',
      sql`(${t.state} = 'corrected') = (${t.correctedByConversionId} is not null)`,
    ),
    // The replay guard: a redelivered source event converges here.
    uniqueIndex('referral_conversions_idempotency_key_key').on(t.idempotencyKey),
    // One source conversion cannot pay several partners (no split at launch).
    uniqueIndex('referral_conversions_source_event_key').on(t.sourceKind, t.sourceEventId),
    index('referral_conversions_attribution_id_idx').on(t.attributionId, t.createdAt.desc()),
    index('referral_conversions_source_idx').on(t.sourceKind, t.sourceRef),
    index('referral_conversions_state_created_at_idx').on(t.state, t.createdAt),
  ],
);

/**
 * `referral_events` — the append-only audit trail for the whole domain.
 *
 * Every state transition appends exactly one row with a CLOSED action, a named
 * actor and a mandatory reason — the `payment_repairs` discipline, ported.
 * Refusals included: an attribution the resolver refused (suspended partner,
 * retired program) leaves a row here, because a partner-support question
 * deserves an answer.
 *
 * Polymorphic subject, exactly as `moderation_enforcements.subject_id` is —
 * the subject id addresses a different table per row, so no single foreign key
 * can express it. No `updated_at`: append-only contract.
 */
export const referralEvents = pgTable(
  'referral_events',
  {
    id: generatedId(),
    subjectType: text({ enum: asEnumValues(REFERRAL_EVENT_SUBJECT_TYPES) }).notNull(),
    subjectId: text().notNull(),
    action: text({ enum: asEnumValues(REFERRAL_EVENT_ACTIONS) }).notNull(),
    actorKind: text({ enum: asEnumValues(REFERRAL_EVENT_ACTOR_KINDS) }).notNull(),
    /** Who, when a person acted: an Oxy user id or a partner row id. NULL for `system`. */
    actorRef: text(),
    reason: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('referral_events_subject_type_check', t.subjectType, REFERRAL_EVENT_SUBJECT_TYPES),
    checkOneOf('referral_events_action_check', t.action, REFERRAL_EVENT_ACTIONS),
    checkOneOf('referral_events_actor_kind_check', t.actorKind, REFERRAL_EVENT_ACTOR_KINDS),
    check('referral_events_subject_id_check', sql`length(${t.subjectId}) > 0`),
    check(
      'referral_events_reason_check',
      sql`length(${t.reason}) > 0 and length(${t.reason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    // A human action names its human (the `payment_repairs` mandatory actor).
    check(
      'referral_events_actor_check',
      sql`${t.actorKind} = 'system' or ${t.actorRef} is not null`,
    ),
    index('referral_events_subject_idx').on(t.subjectType, t.subjectId, t.createdAt),
  ],
);

/**
 * `referral_program_controls` — the two operator levers on one program (#143
 * link rule 8: "Let program operators disable redirect, attribution or both
 * independently").
 *
 * ## Why a separate table rather than two columns on `referral_programs`
 *
 * A `referral_programs` row is a VERSION, and its terms are what an attribution
 * pins (ADR 0005 D19). An operational switch living on that row would be a
 * mutable field inside an otherwise frozen record, and flipping it during an
 * incident would edit the terms somebody was attributed under. So the levers
 * live on the STABLE `program_id` — the identity every version shares — and the
 * versioned terms stay untouched.
 *
 * `program_id` therefore carries NO foreign key: `referral_programs`' unique is
 * `(program_id, version)`, so there is no single-column target to point at.
 * Deliberate, and the same reading as every `ID_COLUMNS_WITHOUT_FOREIGN_KEY`
 * entry — the id is validated by the service against a real program before a
 * row is written.
 *
 * ## Absence means BOTH ENABLED
 *
 * A program nobody has intervened on has no row here, and both levers read
 * true. The inverse would make every freshly published program silently
 * unusable until an operator discovered a table they had never heard of, and
 * the domain is already bounded twice over — by `REFERRALS_ENABLED` and by the
 * program's own status.
 *
 * ## What each lever stops, and what it deliberately does not
 *
 * `redirect_enabled = false` stops `GET /r/:token` resolving for this
 * program's links. A code typed at checkout still attributes, because that is a
 * different instrument reaching a different surface — which is what
 * "independently" means.
 *
 * `attribution_enabled = false` stops NEW attributions and **still records the
 * touch**. That is ADR 0005 D18's "gating loops and gates, never records" and
 * the house rule it restates: an effect that did not happen must stay
 * distinguishable from one that never arrived. Conversions against attributions
 * that already exist are untouched — a lever is prospective (D16/D18), never
 * retroactive.
 */
export const referralProgramControls = pgTable(
  'referral_program_controls',
  {
    id: generatedId(),
    /** The STABLE program identity, not a version row's id. */
    programId: text().notNull(),
    redirectEnabled: boolean().notNull().default(true),
    attributionEnabled: boolean().notNull().default(true),
    /**
     * #145's lever, and the THIRD independent one: may a payout batch for this
     * program be built and settled?
     *
     * It is ADR 0005 D18's "program suspension stops new vesting/payout where
     * policy says so but preserves history" at the grain the ADR states it —
     * and it is deliberately NOT what program TERMINATION uses: D18 says a
     * terminated program's existing rewards run their ordinary lifecycle to
     * payout, including the final sub-minimum batch. This is the incident
     * lever, so it withholds rather than voids, exactly like every D15 gate.
     */
    payoutEnabled: boolean().notNull().default(true),
    /** Mandatory actor — the `payment_repairs` and `referral_events` posture. */
    updatedByOxyUserId: text().notNull(),
    /** Why, in the operator's own words. Bounded like every stored reason here. */
    reason: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'referral_program_controls_identity_check',
      sql`length(${t.programId}) > 0 and length(${t.updatedByOxyUserId}) > 0`,
    ),
    check(
      'referral_program_controls_reason_check',
      sql`length(${t.reason}) > 0 and length(${t.reason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    // ONE controls row per program: two rows could disagree about whether a
    // lever is down, and an incident is exactly when nobody can afford to find
    // out which one the reader picked.
    uniqueIndex('referral_program_controls_program_id_key').on(t.programId),
  ],
);
