/**
 * Merchant activation (#85) — three tables, and what is NOT here is the point.
 *
 * There is no `merchant_activation_state` column and no readiness verdict
 * anywhere in this file. Readiness is DERIVED at read time
 * (`services/merchant-activation/requirements.ts`), the
 * `deriveNativeCheckoutEligibility` (#57) divergence taken for the same reason
 * `deriveChannelReadiness` (#87) took it: the inputs sit on eleven tables in
 * eight domains, and a stored verdict would be a twelfth representation that
 * goes stale the instant Stripe restricts a seller — in the one place that must
 * not happen, which is a gate telling a merchant they can sell.
 *
 * What IS stored is what somebody DECIDED, plus what the derivation was
 * OBSERVED to say:
 *
 *  1. `merchant_activation_settings` — the merchant's own pause switches, the
 *     public support contact, and an operator's safety hold. One row per store.
 *  2. `merchant_activation_policy_acceptances` — a seller took on a stated
 *     responsibility. Append-only, polymorphic owner, `fee_schedule_acceptances`
 *     one domain over.
 *  3. `merchant_activation_capability_events` — the append-only trail of what
 *     each capability was observed to be. A RECORDING, never an authority
 *     (`payment_discrepancies`' relationship to a payment), and a scanned gate
 *     fails the build if a decision path reads it.
 *
 * ## The hold columns are unreachable from the merchant surface, structurally
 *
 * #85 permissions rule 11: "A merchant cannot bypass a platform safety pause
 * from the dashboard." That is held by two repository functions with different
 * signatures — `updateMerchantCheckoutIntents` has no hold parameter to pass,
 * so the merchant controller cannot clear a hold however it is called — plus a
 * trigger that refuses to change the hold columns from anything but a statement
 * naming an operator. Two layers, because the first is a fact about today's
 * call graph and the second survives whoever adds the next writer.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  MERCHANT_ACTIVATION_ACTOR_KINDS,
  MERCHANT_ACTIVATION_CAUSES,
  MERCHANT_ACTIVATION_POLICY_KEYS,
  MERCHANT_ACTIVATION_REQUIREMENT_KEYS,
  MERCHANT_CAPABILITIES,
  MERCHANT_CAPABILITY_STATES,
  MERCHANT_CHECKOUT_INTENTS,
  PROVIDER_ACCOUNT_OWNER_TYPES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { stores } from './stores';

/** Bound on the operator's stated hold reason — long enough to be useful, short enough not to be a note field. */
export const MERCHANT_ACTIVATION_MAX_HOLD_REASON_LENGTH = 500;

/** Bound on a public support contact value. */
export const MERCHANT_ACTIVATION_MAX_SUPPORT_CONTACT_LENGTH = 320;

/**
 * `merchant_activation_settings` — one row per store, carrying every activation
 * fact that is a DECISION rather than a derivation.
 *
 * ## Why the support contact is here and not on `stores`
 *
 * It is store profile data, and putting it on `stores` was the obvious choice.
 * It is here because clearing it WITHDRAWS a capability, and `stores` has
 * twenty unrelated writers and no trigger — so a settings PATCH that happened to
 * blank a field would silently disable native checkout with nothing in the audit
 * trail saying so. Every write that reaches these columns goes through the one
 * repository that also records a capability observation.
 *
 * ## The row is CREATED by the merchant surface and never by a read
 *
 * A checkout, a storefront render and an operator trace all treat an absent row
 * as the defaults below (`enabled`, `enabled`, no hold, no contact). A read that
 * minted a row would make "how many stores have started activation" unanswerable
 * and would write on a path that must never write (#104's T10, one domain over).
 */
export const merchantActivationSettings = pgTable(
  'merchant_activation_settings',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),

    /**
     * What the merchant asked for. NEVER what it gets — the derivation decides
     * that, and a store whose intent is `enabled` and whose payment account is
     * restricted is `disabled`, not `enabled`.
     */
    nativeCheckoutIntent: text({ enum: asEnumValues(MERCHANT_CHECKOUT_INTENTS) })
      .notNull()
      .default('enabled'),
    /**
     * The guest half, and it is a SEPARATE column rather than a narrowing of the
     * one above — #85 readiness-change rule 9: "Disabling guest checkout does not
     * disable authenticated checkout unless its own requirements also fail."
     * One tri-state column could not express "guest paused, native running"
     * without a value that means the same as two flags.
     */
    guestCheckoutIntent: text({ enum: asEnumValues(MERCHANT_CHECKOUT_INTENTS) })
      .notNull()
      .default('enabled'),

    /**
     * The PUBLIC support contact a native order needs (#85 dashboard step 9).
     *
     * Two nullable columns and a requirement satisfied by EITHER, rather than
     * one mandatory column: a merchant who answers on a web form and a merchant
     * who answers by email are both reachable, and forcing an address on the
     * first would get a fake one.
     *
     * Deliberately NOT encrypted and NOT in `PROTECTED_COLUMNS`: this is the
     * contact a merchant PUBLISHES, the opposite of `guest_checkouts.email_ciphertext`.
     * Treating it as a secret would make it unrenderable on the one page it
     * exists to appear on.
     */
    supportEmail: text(),
    supportUrl: text(),

    /**
     * An operator's safety hold. Three columns rather than one boolean, because
     * #85 security 10 asks for actor and reason on every capability change and
     * a hold is the change with the most consequence.
     *
     * All three move together — a CHECK below makes a hold without a reason,
     * an actor or an instant unrepresentable, so "who held this store and why"
     * can never be a question the row cannot answer.
     */
    platformHoldReason: text(),
    platformHeldByOxyUserId: text(),
    platformHeldAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'merchant_activation_settings_native_intent_check',
      t.nativeCheckoutIntent,
      MERCHANT_CHECKOUT_INTENTS,
    ),
    checkOneOf(
      'merchant_activation_settings_guest_intent_check',
      t.guestCheckoutIntent,
      MERCHANT_CHECKOUT_INTENTS,
    ),
    // The hold is all three columns or none of them. `num_nonnulls` rather than
    // three pairwise implications: the pairwise spelling is satisfied by two of
    // three being present, which is exactly the row that leaves a store held
    // with nobody named.
    check(
      'merchant_activation_settings_hold_shape_check',
      sql`num_nonnulls(${t.platformHoldReason}, ${t.platformHeldByOxyUserId}, ${t.platformHeldAt}) in (0, 3)`,
    ),
    check(
      'merchant_activation_settings_hold_reason_length_check',
      sql`${t.platformHoldReason} is null
          or (length(${t.platformHoldReason}) between 1 and ${sql.raw(String(MERCHANT_ACTIVATION_MAX_HOLD_REASON_LENGTH))})`,
    ),
    // A contact column present but EMPTY is the sentinel `stores.description`'s
    // comment warns about: it would satisfy `is not null` and reach nobody.
    check(
      'merchant_activation_settings_support_email_check',
      sql`${t.supportEmail} is null
          or (length(${t.supportEmail}) between 3 and ${sql.raw(String(MERCHANT_ACTIVATION_MAX_SUPPORT_CONTACT_LENGTH))}
              and position('@' in ${t.supportEmail}) > 1)`,
    ),
    check(
      'merchant_activation_settings_support_url_check',
      sql`${t.supportUrl} is null
          or (length(${t.supportUrl}) between 8 and ${sql.raw(String(MERCHANT_ACTIVATION_MAX_SUPPORT_CONTACT_LENGTH))}
              and ${t.supportUrl} like 'https://%')`,
    ),
    uniqueIndex('merchant_activation_settings_store_id_key').on(t.storeId),
  ],
);

/**
 * `merchant_activation_policy_acceptances` — a seller took on a stated
 * responsibility, once, at a named version.
 *
 * Append-only by trigger, and the acceptance is an AUDIT record: re-accepting
 * the same version converges on the existing row through the unique index rather
 * than rewriting it, exactly as `fee_schedule_acceptances` does. Withdrawing an
 * acceptance is not an UPDATE and not a DELETE — it is publishing a new policy
 * version, which leaves every prior consent legible.
 *
 * The owner is `provider_accounts`' POLYMORPHIC pair for its reason: half the
 * owners are Oxy accounts, whose key space is not in this database. That is also
 * what lets an individual seller accept #112's P2P policy — a person selling a
 * bicycle has no store and no `store:manage` to hold, which is precisely why #88
 * recorded the P2P acceptance surface as #85's rather than widening its own.
 */
export const merchantActivationPolicyAcceptances = pgTable(
  'merchant_activation_policy_acceptances',
  {
    id: generatedId(),
    policyKey: text({ enum: asEnumValues(MERCHANT_ACTIVATION_POLICY_KEYS) }).notNull(),
    /**
     * The version the seller actually saw. A code constant at acceptance time
     * (`MERCHANT_ACTIVATION_POLICIES`), snapshotted here for the
     * `fee_schedule_acceptances.terms_version` reason: the acceptance must state
     * what was agreed even when read apart from the code that published it.
     */
    policyVersion: text().notNull(),
    ownerType: text({ enum: asEnumValues(PROVIDER_ACCOUNT_OWNER_TYPES) }).notNull(),
    /** A store id or an Oxy account id, by `owner_type`. No FK on either — see CONVENTIONS. */
    ownerId: text().notNull(),
    /** The store member (or the individual seller) who accepted. */
    acceptedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'merchant_activation_policy_acceptances_key_check',
      t.policyKey,
      MERCHANT_ACTIVATION_POLICY_KEYS,
    ),
    checkOneOf(
      'merchant_activation_policy_acceptances_owner_type_check',
      t.ownerType,
      PROVIDER_ACCOUNT_OWNER_TYPES,
    ),
    check(
      'merchant_activation_policy_acceptances_version_check',
      sql`length(${t.policyVersion}) between 1 and 64`,
    ),
    // One acceptance per owner per policy version — a replayed accept converges
    // instead of duplicating the audit trail.
    uniqueIndex('merchant_activation_policy_acceptances_owner_version_key').on(
      t.ownerType,
      t.ownerId,
      t.policyKey,
      t.policyVersion,
    ),
    index('merchant_activation_policy_acceptances_owner_idx').on(t.ownerType, t.ownerId),
  ],
);

/**
 * `merchant_activation_capability_events` — the append-only record of what each
 * capability was OBSERVED to be, and what changed it.
 *
 * ## It is a recording and never an authority
 *
 * The verdict is derived; this table says what the derivation said when somebody
 * last looked. A decision path reading it would be reading a cached answer that
 * survives the Stripe restriction that should have withdrawn it —
 * `price_signal_evaluations`' rule, and a scanned gate enforces it.
 *
 * ## ONE table, not a current-state row beside a history table
 *
 * "What is this capability now" is the LATEST row, read with `distinct on`. A
 * second table holding the current value would be derivable from this one and
 * could therefore disagree with it, which is the failure every one-verdict rule
 * in this repository exists to prevent. The index below is what makes the
 * latest-row read cheap.
 *
 * ## Serialization is the settings row's lock
 *
 * Two observers could otherwise both see the same previous state and both write
 * a transition. The writer takes `FOR UPDATE` on the store's
 * `merchant_activation_settings` row first — a row that must exist for any
 * observation to be recorded — so observation is serialized per store without a
 * lease table of its own.
 */
export const merchantActivationCapabilityEvents = pgTable(
  'merchant_activation_capability_events',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    capability: text({ enum: asEnumValues(MERCHANT_CAPABILITIES) }).notNull(),
    /**
     * NULL exactly once per (store, capability): the first observation has no
     * predecessor. A sentinel value would make "we have never looked" and "it
     * was withheld" the same row.
     */
    previousState: text({ enum: asEnumValues(MERCHANT_CAPABILITY_STATES) }),
    nextState: text({ enum: asEnumValues(MERCHANT_CAPABILITY_STATES) }).notNull(),
    /**
     * The requirements that withheld it, at the moment of observation.
     *
     * A `text[]` with an element CHECK rather than jsonb: the whole point is
     * that only a REQUIREMENT KEY can be stored, so an operator note, a buyer's
     * email or a moderation finding has no shape to arrive in — `analytics.ts`'
     * allow-list argument, applied to an audit row.
     */
    unmet: text()
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    actorKind: text({ enum: asEnumValues(MERCHANT_ACTIVATION_ACTOR_KINDS) }).notNull(),
    /** NULL for `system`, which is most transitions — see the type's docblock. */
    actorOxyUserId: text(),
    cause: text({ enum: asEnumValues(MERCHANT_ACTIVATION_CAUSES) }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'merchant_activation_capability_events_capability_check',
      t.capability,
      MERCHANT_CAPABILITIES,
    ),
    checkOneOf(
      'merchant_activation_capability_events_next_state_check',
      t.nextState,
      MERCHANT_CAPABILITY_STATES,
    ),
    check(
      'merchant_activation_capability_events_previous_state_check',
      sql`${t.previousState} is null
          or ${t.previousState} in ('granted', 'withheld', 'not_applicable')`,
    ),
    checkOneOf(
      'merchant_activation_capability_events_actor_kind_check',
      t.actorKind,
      MERCHANT_ACTIVATION_ACTOR_KINDS,
    ),
    checkOneOf('merchant_activation_capability_events_cause_check', t.cause, MERCHANT_ACTIVATION_CAUSES),
    // A `merchant` or `operator` transition names the person; a `system` one
    // must NOT, or a sweep's observation would be attributed to whoever happened
    // to trigger it. A biconditional, so neither direction can be forgotten.
    check(
      'merchant_activation_capability_events_actor_shape_check',
      sql`(${t.actorKind} = 'system') = (${t.actorOxyUserId} is null)`,
    ),
    // A transition that changed nothing is not a transition. The writer already
    // compares before inserting; this is what stops a second writer skipping it.
    check(
      'merchant_activation_capability_events_change_check',
      sql`${t.previousState} is null or ${t.previousState} <> ${t.nextState}`,
    ),
    // `granted` with a non-empty unmet list is the one shape that would make the
    // trail lie in the dangerous direction.
    check(
      'merchant_activation_capability_events_granted_shape_check',
      sql`${t.nextState} <> 'granted' or coalesce(array_length(${t.unmet}, 1), 0) = 0`,
    ),
    checkEveryElementOf('merchant_activation_capability_events_unmet_check', t.unmet, [
      ...MERCHANT_ACTIVATION_REQUIREMENT_KEYS,
    ]),
    // The latest-row read: `distinct on (store_id, capability) … order by
    // store_id, capability, created_at desc, id desc`.
    index('merchant_activation_capability_events_latest_idx').on(
      t.storeId,
      t.capability,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);
