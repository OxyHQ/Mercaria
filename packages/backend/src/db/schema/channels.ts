/**
 * Channel onboarding and the channel audit trail (#87).
 *
 * Two tables, and what is ABSENT from the first one is the point: a resumable
 * onboarding session holds NO credential of any kind, and no column exists that
 * could hold one. Wizard step 4 — "collect credentials only through the secure
 * provider-specific flow" — is that absence rather than a rule somebody follows,
 * and it matters more here than almost anywhere: an abandoned session outlives
 * the flow that created it by design, so a consumer secret parked on one would
 * sit in plaintext, unencrypted, for as long as the merchant never came back.
 *
 * Lands after `connectors.ts`, which owns `connections`, and after `feedImport.ts`,
 * which owns `feed_configurations` — a session points at both.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CHANNEL_ACTIVATION_BLOCKERS,
  CHANNEL_AUDIT_ACTIONS,
  CHANNEL_ONBOARDING_STATES,
  CHANNEL_ONBOARDING_STEPS,
  CHANNEL_TYPE_IDS,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { connections } from './connectors';
import { feedConfigurations } from './feedImport';
import { merchants, storefronts } from './merchants';
import { stores } from './stores';

/**
 * `channel_onboarding_sessions` — one merchant's progress through the connection
 * wizard, resumable across devices and across weeks.
 *
 * ## Why a row rather than client state
 *
 * The OAuth channels LEAVE Mercaria mid-flow: the merchant is sent to Shopify,
 * authorizes, and comes back through a public callback that has no idea which
 * tab they started in. Holding the wizard's state on the client would lose it at
 * exactly the step that takes longest, and #87 wizard requirement 12 asks for a
 * resumable state in so many words.
 *
 * ## The counters are RECORDS, not a verdict
 *
 * `preview_*` holds what the bounded preview found (#87 wizard 10). They are
 * stored because a merchant reads them, decides, and comes back — not because
 * anything derives from them: `activation_blockers` is re-derived on every read
 * against the LIVE connection state, so a session previewed last week cannot
 * activate a connection that has since errored.
 */
export const channelOnboardingSessions = pgTable(
  'channel_onboarding_sessions',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /**
     * Which channel the merchant is connecting. Broader than a connector
     * provider id — `product_feed` and `woocommerce_plugin` are both here and
     * neither is a `connections.provider` value.
     */
    channelType: text({ enum: asEnumValues(CHANNEL_TYPE_IDS) }).notNull(),
    state: text({ enum: asEnumValues(CHANNEL_ONBOARDING_STATES) }).notNull().default('in_progress'),
    step: text({ enum: asEnumValues(CHANNEL_ONBOARDING_STEPS) }).notNull().default('scope'),

    /**
     * The connection the credential step created or reused.
     *
     * `ON DELETE RESTRICT` for the reason every other `connection_id` in this
     * schema is: nothing deletes a connection today, and the pointer exists so
     * that if anything ever did, it would have to decide what happens to the
     * sessions naming it rather than silently taking them along.
     */
    connectionId: text().references(() => connections.id, { onDelete: 'restrict' }),
    /** The feed configuration a `product_feed` session created. */
    feedConfigurationId: text().references(() => feedConfigurations.id, { onDelete: 'restrict' }),

    /**
     * The verified merchant and exact storefront this session bound to
     * (#87 reconcile 1), resolved through #83's claim and #84's link.
     *
     * Nullable because the binding is a FACT that may not exist: a store with no
     * verified merchant claim has no merchant to bind to, and that is an
     * ordinary state rather than an error. Recording it here, at the moment the
     * wizard proved it, is what lets the reconciliation view say WHICH storefront
     * the already-indexed offers were looked for under.
     */
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    storefrontId: text().references(() => storefronts.id, { onDelete: 'restrict' }),

    /** What the bounded preview found. All five counters, or none. */
    previewScanned: integer(),
    previewMatched: integer(),
    previewCreated: integer(),
    previewReview: integer(),
    previewInvalid: integer(),
    previewDuplicate: integer(),
    previewedAt: timestamptz(),

    /**
     * Why activation was refused, as of the last derivation.
     *
     * Stored so the wizard can be resumed showing what it showed, and RE-DERIVED
     * on every read rather than trusted — the same posture
     * `catalog_backfill_runs` takes toward its counters. A stored blocker that
     * nothing re-checks is how a merchant activates a connection that broke
     * after they previewed it.
     */
    activationBlockers: text().array().notNull().default(sql`'{}'::text[]`),

    /** Who started it. An Oxy id, so no foreign key (Oxy owns identity). */
    startedByOxyUserId: text().notNull(),
    activatedAt: timestamptz(),
    abandonedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('channel_onboarding_sessions_channel_type_check', t.channelType, CHANNEL_TYPE_IDS),
    checkOneOf('channel_onboarding_sessions_state_check', t.state, CHANNEL_ONBOARDING_STATES),
    checkOneOf('channel_onboarding_sessions_step_check', t.step, CHANNEL_ONBOARDING_STEPS),
    checkEveryElementOf(
      'channel_onboarding_sessions_blockers_check',
      t.activationBlockers,
      CHANNEL_ACTIVATION_BLOCKERS,
    ),
    /**
     * The preview is six counters and an instant, all present or all absent.
     *
     * A partial preview record is worse than none: five counters with a missing
     * `scanned` reads as a preview that examined nothing, which is also what a
     * mapping matching no rows produces — and those two must never be
     * indistinguishable (#60's vacuity-floor reasoning, one domain over).
     */
    check(
      'channel_onboarding_sessions_preview_complete_check',
      sql`num_nonnulls(${t.previewScanned}, ${t.previewMatched}, ${t.previewCreated}, ${t.previewReview}, ${t.previewInvalid}, ${t.previewDuplicate}, ${t.previewedAt}) in (0, 7)`,
    ),
    /**
     * The counters partition what was scanned, exactly (equality, never `<=`).
     *
     * `catalog_backfill_runs_counters_total_check`, applied to a preview: a
     * record the preview read and then dropped on the floor would otherwise be
     * invisible, and a preview that silently loses records is the one that says
     * "nothing to review" about a feed full of problems.
     */
    check(
      'channel_onboarding_sessions_preview_total_check',
      sql`${t.previewScanned} is null or ${t.previewScanned} = ${t.previewMatched} + ${t.previewCreated} + ${t.previewReview} + ${t.previewInvalid} + ${t.previewDuplicate}`,
    ),
    /** A terminal state carries its instant, and a live one carries neither. */
    check(
      'channel_onboarding_sessions_terminal_check',
      sql`(${t.state} = 'activated' and ${t.activatedAt} is not null and ${t.abandonedAt} is null)
       or (${t.state} = 'abandoned' and ${t.abandonedAt} is not null and ${t.activatedAt} is null)
       or (${t.state} = 'in_progress' and ${t.activatedAt} is null and ${t.abandonedAt} is null)`,
    ),
    /**
     * An activated session names what it activated.
     *
     * Exactly one of the two, because a session activates a connection OR a feed
     * and never both — and an activated session naming neither would be a
     * merchant told they are connected to nothing.
     */
    check(
      'channel_onboarding_sessions_activated_target_check',
      sql`${t.state} <> 'activated' or num_nonnulls(${t.connectionId}, ${t.feedConfigurationId}) = 1`,
    ),
    /**
     * ONE live session per store per channel type — a PARTIAL unique, so
     * finished sessions accumulate as history.
     *
     * This is what makes #87 acceptance 2 ("previewing or retrying a connection
     * creates no duplicate channel") true of the wizard itself: a merchant who
     * opens the flow twice, or whose browser retries the request, converges on
     * the session they already have rather than starting a second one that would
     * then race the first to create a connection.
     */
    uniqueIndex('channel_onboarding_sessions_live_key')
      .on(t.storeId, t.channelType)
      .where(sql`state = 'in_progress'`),
    index('channel_onboarding_sessions_store_id_created_at_idx').on(t.storeId, t.createdAt.desc()),
  ],
);

/**
 * `channel_audit_events` — who changed what about a store's channels
 * (#87 security 7).
 *
 * ## It records FIELD NAMES and never values
 *
 * `changed_fields` is a list of column names. That is #63's error-report rule
 * ("an error report carries no VALUES") applied to an audit trail, and the
 * reason is sharper here: the values a channel change carries include a
 * consumer secret and an API key pair, so a trail recording before-and-after
 * would be a plaintext credential store that nobody classified as one and that
 * no retention policy covers.
 *
 * ## Append-only by trigger, with a PRECISE delete exception
 *
 * An audit trail somebody can edit is a trail that says whatever the last person
 * to touch it wanted, so UPDATE always raises. DELETE raises only while the
 * STORE still exists — #90's `listing_condition_revisions` device, and the
 * exception is exactly as wide as the `ON DELETE CASCADE` above it and no wider.
 *
 * A blanket refusal reads as the stricter choice and is the wrong one: it makes
 * a store with any channel history undeletable forever, because the cascade the
 * foreign key declares can never run. `channels.realdb.test.ts` found that on
 * its first run, which is why a trigger belongs behind a real server rather than
 * behind a mocked insert that would have accepted either version.
 */
export const channelAuditEvents = pgTable(
  'channel_audit_events',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    action: text({ enum: asEnumValues(CHANNEL_AUDIT_ACTIONS) }).notNull(),
    /** Absent for an action that is not about one channel type. */
    channelType: text({ enum: asEnumValues(CHANNEL_TYPE_IDS) }),
    connectionId: text().references(() => connections.id, { onDelete: 'restrict' }),
    feedConfigurationId: text().references(() => feedConfigurations.id, { onDelete: 'restrict' }),
    /** Who did it. An Oxy id, so no foreign key. Never a service credential. */
    actorOxyUserId: text().notNull(),
    /** The NAMES of the fields that changed. Never their values. */
    changedFields: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('channel_audit_events_action_check', t.action, CHANNEL_AUDIT_ACTIONS),
    checkOneOf('channel_audit_events_channel_type_check', t.channelType, CHANNEL_TYPE_IDS),
    index('channel_audit_events_store_id_created_at_idx').on(t.storeId, t.createdAt.desc()),
  ],
);
