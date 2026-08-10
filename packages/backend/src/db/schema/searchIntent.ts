/**
 * Natural-language shopping intent (#95): four tables.
 *
 * `search_intent_sessions` and `search_intent_turns` carry the clarification
 * state machine and the evidence a fallback rate is computed from;
 * `search_intent_benchmark_runs` and `search_intent_enablements` carry
 * acceptance 7 — "benchmark thresholds are recorded before enabling the parser
 * by category and language" — as a schema property rather than as a process.
 *
 * ## No raw query text is stored, anywhere in this domain
 *
 * `search_intent_turns.redacted_query` holds what #77's `redactSearchQuery`
 * produced and nothing else, and there is no column an original could occupy.
 * That is the one decision in this domain worth reading twice, because #95's
 * clarification rule 3 asks that the ORIGINAL query be preserved and #95 safety
 * rule 7 asks that #77's redaction and retention policy be applied, and the two
 * pull in opposite directions.
 *
 * Rule 7 wins, and rule 3 is satisfied on the CLIENT side, which is where the
 * original already lives: the shopper typed it, the share-safe URL carries it,
 * and a clarification answer re-submits it. So Mercaria never holds an
 * un-redacted copy of anything anybody typed, the session survives a page
 * reload through the URL rather than through a server-side transcript, and
 * "preserve the original query and parsed alternatives" is true of the
 * experience without being true of a database column somebody could dump.
 *
 * The cost is stated rather than hidden: a shopper who loses their tab loses
 * the query, and an operator tracing an interpretation sees the redacted form.
 * Both are the right trade for a column that would otherwise accumulate every
 * sentence every shopper has ever typed into a search box.
 *
 * ## Retention is a sweep target, not a trigger
 *
 * Both session and turn carry `expires_at` and both are registered in
 * `db/expiryTargets.ts`. A trigger refusing DELETE would make retention fail
 * silently, which is `analytics_events`' explicit reasoning and applies here
 * for the same reason: erasure on a schedule IS the policy.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  INTENT_ACTOR_KINDS,
  INTENT_CLARIFICATION_KINDS,
  INTENT_FALLBACK_REASONS,
  INTERPRETATION_MODES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { guestSessions } from './guests';

/**
 * `search_intent_sessions` — one shopper's bounded clarification conversation.
 *
 * The OWNER columns are the security boundary and they follow `carts`' shape
 * exactly: an Oxy id carries no foreign key (Oxy owns identity) while a guest
 * session id MUST, `ON DELETE CASCADE`, so purging a guest credential purges
 * the clarification state derived from it with no sweep involved.
 *
 * An `anonymous` session has neither, and that is a real state rather than a
 * gap: most shopping traffic carries no credential at all, and refusing to
 * clarify for those shoppers would make the feature reachable only after
 * somebody had put something in a cart. Such a session is addressed by its id
 * alone. What that id grants is deliberately almost nothing — the surface never
 * READS a session back to a client, so the whole capability is "influence which
 * clarification questions this conversation has already asked", which is a
 * nuisance rather than a disclosure. It is stated here rather than left for a
 * reader to work out.
 */
export const searchIntentSessions = pgTable(
  'search_intent_sessions',
  {
    id: generatedId(),
    actorKind: text({ enum: asEnumValues(INTENT_ACTOR_KINDS) }).notNull(),
    /** An Oxy account id. No foreign key — Oxy owns identity. */
    oxyUserId: text(),
    guestSessionId: text().references(() => guestSessions.id, { onDelete: 'cascade' }),
    /** BCP-47, as the request declared it. Decides the dictionaries and voices. */
    locale: text().notNull(),
    /** ISO 3166-1 alpha-2, when the request named one. */
    market: text(),
    /**
     * The kinds this session has already asked, so no kind is ever asked twice
     * (#95 clarification rule 7). An ARRAY rather than a child table because the
     * whole of it is read on every turn and it can never exceed the vocabulary's
     * own size.
     */
    askedKinds: text().array().notNull().default(sql`'{}'::text[]`),
    /** How many rounds have been asked. Bounded by the service, floored here. */
    rounds: integer().notNull().default(0),
    /** The one question awaiting an answer, when there is one. */
    openClarificationId: text(),
    /** When it stops being usable. Swept, never archived. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('search_intent_sessions_actor_kind_check', t.actorKind, INTENT_ACTOR_KINDS),
    // The owner columns and the actor kind cannot disagree. An Oxy id on a guest
    // session, or a guest id on an anonymous one, would make the resolver's
    // ownership check answer about the wrong subject.
    check(
      'search_intent_sessions_owner_check',
      sql`num_nonnulls(${t.oxyUserId}, ${t.guestSessionId}) <= 1
          and (${t.oxyUserId} is null or ${t.actorKind} = 'oxy')
          and (${t.guestSessionId} is null or ${t.actorKind} = 'guest')
          and (${t.actorKind} <> 'oxy' or ${t.oxyUserId} is not null)
          and (${t.actorKind} <> 'guest' or ${t.guestSessionId} is not null)
          and (${t.actorKind} <> 'anonymous'
               or num_nonnulls(${t.oxyUserId}, ${t.guestSessionId}) = 0)`,
    ),
    checkEveryElementOf(
      'search_intent_sessions_asked_kinds_check',
      t.askedKinds,
      INTENT_CLARIFICATION_KINDS,
    ),
    check('search_intent_sessions_rounds_check', sql`${t.rounds} >= 0`),
    check(
      'search_intent_sessions_locale_check',
      sql`${t.locale} ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
    check(
      'search_intent_sessions_market_check',
      sql`${t.market} is null or ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    index('search_intent_sessions_oxy_user_id_idx')
      .on(t.oxyUserId, t.createdAt.desc())
      .where(sql`${t.oxyUserId} is not null`),
    index('search_intent_sessions_guest_session_id_idx')
      .on(t.guestSessionId)
      .where(sql`${t.guestSessionId} is not null`),
    // The expiry sweep's own scan. A LEADING btree on the swept column, which
    // `findUnsupportedExpiryColumns` requires: without it the sweep is a
    // sequential scan of the whole table on every tick, and the table this one
    // sweeps grows with shopping traffic.
    index('search_intent_sessions_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `search_intent_turns` — one interpretation, and the evidence a fallback rate
 * is computed from (#95 deterministic-fallback rule 8, acceptance 8).
 *
 * One row per served interpretation, whether a model ran or not. This is what
 * makes acceptance 8 — "analytics can compare parsed and fallback search quality
 * without retaining unnecessary sensitive text" — answerable without adding a
 * single column to #77's domain: the row carries the mode, the fallback reason,
 * the counts and `query_event_id`, which is #77's own correlation handle. An
 * operator joins a turn to the search it produced through that handle; #77's
 * retention removes its half on its own clock and this one removes this half on
 * its own, and neither depends on the other.
 *
 * APPEND-ONLY is deliberately NOT enforced by a trigger here, unlike
 * `analytics_events`. The row is written once and never updated by any code
 * path, so a trigger would be guarding against a writer that does not exist —
 * and the DELETE the retention sweep performs would then need an exception,
 * which is exactly the shape that makes a retention failure silent.
 */
export const searchIntentTurns = pgTable(
  'search_intent_turns',
  {
    id: generatedId(),
    sessionId: text().references(() => searchIntentSessions.id, { onDelete: 'cascade' }),
    /** #77's correlation handle for the search this turn produced, when there was one. */
    queryEventId: text(),
    mode: text({ enum: asEnumValues(INTERPRETATION_MODES) }).notNull(),
    /** Present EXACTLY when the mode is `deterministic` — the same biconditional the DTO has. */
    fallbackReason: text({ enum: asEnumValues(INTENT_FALLBACK_REASONS) }),
    /** The registered parser's id, or the literal `deterministic`. Never a credential. */
    provider: text().notNull(),
    /** The model the provider used, when one did. Never a credential. */
    model: text(),
    promptVersion: text().notNull(),
    schemaVersion: text().notNull(),
    parserVersion: text().notNull(),
    /** #77's redacted form. There is no column an original could occupy. */
    redactedQuery: text().notNull(),
    /** BCP-47 and ISO 639-1 — what the turn was read as. */
    locale: text().notNull(),
    language: text().notNull(),
    /** The category the interpretation resolved to, when it resolved one. */
    categoryId: text(),
    hardConstraintCount: integer().notNull().default(0),
    preferenceCount: integer().notNull().default(0),
    unresolvedCount: integer().notNull().default(0),
    clarificationCount: integer().notNull().default(0),
    /** How long the whole interpretation took, including any model call. */
    latencyMs: integer().notNull().default(0),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('search_intent_turns_mode_check', t.mode, INTERPRETATION_MODES),
    checkOneOf('search_intent_turns_fallback_reason_check', t.fallbackReason, INTENT_FALLBACK_REASONS),
    // The biconditional. A `model` turn carrying a fallback reason and a
    // `deterministic` turn carrying none are both rows that would make the
    // fallback rate uncomputable — the first inflates it, the second leaves a
    // fallback nobody can attribute.
    check(
      'search_intent_turns_fallback_shape_check',
      sql`(${t.mode} = 'deterministic') = (${t.fallbackReason} is not null)`,
    ),
    check(
      'search_intent_turns_counts_check',
      sql`${t.hardConstraintCount} >= 0 and ${t.preferenceCount} >= 0
          and ${t.unresolvedCount} >= 0 and ${t.clarificationCount} >= 0
          and ${t.latencyMs} >= 0`,
    ),
    check('search_intent_turns_language_check', sql`${t.language} ~ '^[a-z]{2,3}$'`),
    // The fallback rate's own scan: "turns of this mode in this window".
    index('search_intent_turns_mode_created_at_idx').on(t.mode, t.createdAt),
    index('search_intent_turns_session_id_idx')
      .on(t.sessionId, t.createdAt)
      .where(sql`${t.sessionId} is not null`),
    index('search_intent_turns_query_event_id_idx')
      .on(t.queryEventId)
      .where(sql`${t.queryEventId} is not null`),
    index('search_intent_turns_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * `search_intent_benchmark_runs` — one measured pass over the labelled dataset
 * (#95 "Evaluation").
 *
 * The dataset is content-addressed (`dataset_digest`), which is the #58
 * benchmark's device: a run recorded against a dataset somebody has since
 * edited cannot be mistaken for one measured against the current cases, because
 * the digest in the row and the digest the dataset computes today differ and
 * the enablement check compares them.
 *
 * Every measure is a COLUMN rather than a jsonb bag, the
 * `ranking_policy_versions` decision for the same reason: a number whose
 * definition is unstated cannot be stored, and a bag would let a run report
 * whatever its author found flattering. A measure added to
 * `INTENT_BENCHMARK_MEASURES` needs a column and a migration, which is the
 * right amount of friction for changing what "the parser is good enough" means.
 */
export const searchIntentBenchmarkRuns = pgTable(
  'search_intent_benchmark_runs',
  {
    id: generatedId(),
    /** The dataset's declared version — `bench-1`. */
    datasetVersion: text().notNull(),
    /** sha-256 of the case list, so an edited dataset invalidates its runs. */
    datasetDigest: text().notNull(),
    caseCount: integer().notNull(),
    /** Which parser was measured. `deterministic` when none was registered. */
    provider: text().notNull(),
    model: text(),
    promptVersion: text().notNull(),
    parserVersion: text().notNull(),
    /** ISO 639-1 — a run measures ONE language. */
    language: text().notNull(),
    /**
     * The category this run measured, or NULL for a run over every case.
     *
     * Nullable because the dataset's cases are not all category-scoped —
     * injection and malformed-input cases have no category at all — and a run
     * over the whole set is the one that answers "is the parser safe", while a
     * category-scoped run is the one that answers "is it accurate here".
     */
    categoryId: text(),

    // ── The eight measures, one column each ──────────────────────────────
    schemaValidity: doublePrecision().notNull(),
    categoryAccuracy: doublePrecision().notNull(),
    hardConstraintRecall: doublePrecision().notNull(),
    falseHardConstraintRate: doublePrecision().notNull(),
    clarificationPrecision: doublePrecision().notNull(),
    latencyP95Ms: integer().notNull(),
    costUnits: doublePrecision().notNull(),
    fallbackRate: doublePrecision().notNull(),

    /** How many cases each rate was computed over. A rate off two is noise. */
    sampleSize: integer().notNull(),
    /** The operator who ran it — an Oxy account id, no foreign key. */
    ranByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('search_intent_benchmark_runs_language_check', sql`${t.language} ~ '^[a-z]{2,3}$'`),
    check(
      'search_intent_benchmark_runs_digest_check',
      sql`${t.datasetDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    // Every rate is a proportion. A "recall" of 1.4 is a computation bug, and
    // storing one would enable a parser against a threshold it never met.
    check(
      'search_intent_benchmark_runs_rates_check',
      sql`${t.schemaValidity} between 0 and 1
          and ${t.categoryAccuracy} between 0 and 1
          and ${t.hardConstraintRecall} between 0 and 1
          and ${t.falseHardConstraintRate} between 0 and 1
          and ${t.clarificationPrecision} between 0 and 1
          and ${t.fallbackRate} between 0 and 1`,
    ),
    check(
      'search_intent_benchmark_runs_counts_check',
      sql`${t.caseCount} > 0 and ${t.sampleSize} > 0 and ${t.latencyP95Ms} >= 0
          and ${t.costUnits} >= 0`,
    ),
    check('search_intent_benchmark_runs_actor_check', sql`btrim(${t.ranByOxyUserId}) <> ''`),
    index('search_intent_benchmark_runs_language_created_at_idx').on(
      t.language,
      t.createdAt.desc(),
    ),
    /**
     * The composite key an enablement cites.
     *
     * `unique()` and never `uniqueIndex()`: drizzle-kit emits every
     * `ADD CONSTRAINT … FOREIGN KEY` BEFORE every `CREATE UNIQUE INDEX`
     * regardless of source order, so a foreign key onto a unique INDEX runs
     * before its target exists and the migration fails at APPLY time with
     * `42830`. A `unique()` is emitted inline inside `CREATE TABLE`, so it
     * already exists by the time any FK statement runs.
     */
    unique('search_intent_benchmark_runs_id_dataset_key').on(t.id, t.datasetDigest),
  ],
);

/**
 * `search_intent_enablements` — may the model parser run for this category and
 * language (#95 acceptance 7).
 *
 * ONE row per (category, language) pair, and it CITES the run that qualified
 * it. The citation is what makes acceptance 7 structural: an enablement with no
 * measurement behind it is unrepresentable because `benchmark_run_id` is NOT
 * NULL, and an enablement citing a run measured against a dataset somebody has
 * since edited is caught by the digest comparison the service performs against
 * the live dataset.
 *
 * A NULL `category_id` is the DEPLOYMENT-WIDE row — "this language has been
 * measured" — and it does not enable any category on its own. The service
 * requires BOTH: the language row and the category row. Two gates rather than
 * one because the two failures are different: a parser that is accurate in
 * Spanish and has never been measured on refrigerators should not sell
 * refrigerators, and a parser measured on refrigerators in Spanish says nothing
 * about German.
 */
export const searchIntentEnablements = pgTable(
  'search_intent_enablements',
  {
    id: generatedId(),
    /** NULL is the language-wide row. See the table docblock. */
    categoryId: text(),
    /** ISO 639-1. */
    language: text().notNull(),
    enabled: boolean().notNull().default(false),
    /** The run whose measurements justify this. NOT NULL — acceptance 7. */
    benchmarkRunId: text().notNull(),
    /** Carried so the service can compare it against the live dataset's digest. */
    datasetDigest: text().notNull(),
    /** The operator who enabled it, and when. */
    enabledByOxyUserId: text().notNull(),
    enabledAt: timestamptz().notNull(),
    /** Why — read by whoever is deciding whether to turn it off. */
    note: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('search_intent_enablements_language_check', sql`${t.language} ~ '^[a-z]{2,3}$'`),
    check('search_intent_enablements_actor_check', sql`btrim(${t.enabledByOxyUserId}) <> ''`),
    check('search_intent_enablements_note_check', sql`btrim(${t.note}) <> ''`),
    check(
      'search_intent_enablements_digest_check',
      sql`${t.datasetDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    // The composite citation — the `match_category_gates` device. A row naming a
    // run measured against ANOTHER dataset is unrepresentable, so "these
    // thresholds were recorded against these exact cases" is a foreign key
    // rather than a convention. `restrict`, so a run cannot be deleted out from
    // under the enablement that rests on it.
    foreignKey({
      name: 'search_intent_enablements_benchmark_fk',
      columns: [t.benchmarkRunId, t.datasetDigest],
      foreignColumns: [searchIntentBenchmarkRuns.id, searchIntentBenchmarkRuns.datasetDigest],
    }).onDelete('restrict'),
    // Two partial uniques rather than one, because Postgres treats NULLs as
    // DISTINCT: a plain `unique(category_id, language)` would admit any number
    // of language-wide rows for one language, and the service would then read
    // whichever it found first.
    uniqueIndex('search_intent_enablements_category_language_key')
      .on(t.categoryId, t.language)
      .where(sql`${t.categoryId} is not null`),
    uniqueIndex('search_intent_enablements_language_key')
      .on(t.language)
      .where(sql`${t.categoryId} is null`),
    index('search_intent_enablements_run_idx').on(t.benchmarkRunId),
  ],
);
