/**
 * Source-aware offer freshness, refresh scheduling and catalogue health —
 * issue #68: `catalog_source_freshness_policies`, `offer_refresh_tasks`,
 * `catalog_source_refresh_leases`, `catalog_source_distributions`,
 * `catalog_source_run_quarantines`.
 *
 * #68 sits between #57 (the offer, which holds current state) and #62 (the
 * ingestion framework, which produces it). It adds the machinery neither owns:
 * how long a source's facts stay trustworthy, when they are re-read, how hard
 * Mercaria may knock, and what happens when a feed publishes something that
 * cannot be true.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **There is no global TTL, and no column here could become one.** Every
 *    duration lives on a row keyed to ONE source, and the type that carries
 *    them into the derivation (`SourceFreshnessPolicy`) names the source it was
 *    resolved for. `catalog_source_freshness_policies` has no
 *    deployment-scoped row, no "default" row, and no nullable `source_id` that
 *    could mean "all sources".
 * 2. **A published freshness policy is FROZEN.** The `fee_schedules` mechanism
 *    (trigger + one-active-per-source partial unique): changing how long a
 *    source's facts live is a NEW version, so the terms an offer was ingested
 *    under stay answerable afterwards. That matters here specifically because
 *    these numbers encode contractual obligations — an eBay caching term, an
 *    Awin per-programme rule — and "what were we permitted to cache last March"
 *    must not be a question the schema destroyed the answer to.
 * 3. **A task's priority cannot disagree with itself.** `priority_rank` is a
 *    STORED GENERATED `case` over `priority_class`, rendered from the same
 *    tuple the scheduler reads, and `priority_class` must be a member of
 *    `priority_reasons` (a CHECK). So the queue's ordering key is a function of
 *    the row rather than a number a service computed and might have got wrong.
 * 4. **The refresh budget binds the FLEET, not a process.** A per-process token
 *    bucket answers a different question per ECS task and their sum is whatever
 *    the task count happens to be. `catalog_source_refresh_leases` is
 *    `supplier_call_leases` (#122) pointed at an inbound catalogue source
 *    instead of an outbound supplier: a slot is a ROW so concurrency is a row
 *    lock, and the per-minute allowance rides the same row so the rate bound is
 *    serialized by that same lock.
 * 5. **A quarantine is a decision about CONTENT and only a person or a
 *    corrected run clears it.** `catalog_source_run_quarantines` records the
 *    statistic, the baseline it was compared against and how it ended; there is
 *    no UPDATE that could delete the finding, and re-delivering the same feed
 *    does not answer it (#62's per-object rule, restated for a distribution).
 *
 * ## What is deliberately NOT here
 *
 * - **No stored freshness STATE on an offer.** `#57`'s rule, unchanged: a level
 *   beside the deadline that determines it is two representations of one fact,
 *   and the stored one is wrong for exactly as long as nobody has swept it. The
 *   level is derived at read time by `assessOfferFreshness`.
 * - **No price-history table.** ADR 0002 D18 assigns it to #78. What #68 must
 *   not lose is the observed history, and that already exists: `source_records`
 *   is append-only per content hash, and retirement is a status transition, so
 *   an expired offer keeps its whole chain (#68 scheduler 8).
 * - **No product availability/price PROJECTION.** #61 measured the alternative
 *   at one million offers and adopted no materialized view;
 *   `docs/performance/canonical-graph-benchmarks.md` carries the numbers.
 *   `readProductOfferSummary` derives it live, which is why "rebuild after
 *   eligible-offer changes" needs no rebuild — there is nothing to fall out of
 *   date.
 * - **No per-source THRESHOLD constants in code.** The anomaly thresholds are
 *   columns on the policy for the reason the TTL is: "how far may this feed's
 *   median move before we stop believing it" is a different number for a
 *   supermarket and for an auction house.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CATALOG_REFRESH_MODES,
  CATALOG_SOURCE_ANOMALY_KINDS,
  CATALOG_SOURCE_POLICY_STATUSES,
  CATALOG_SOURCE_QUARANTINE_RESOLUTIONS,
  OFFER_REFRESH_PRIORITY_CLASSES,
  OFFER_REFRESH_PRIORITY_RANK,
  OFFER_REFRESH_REFUSALS,
  OFFER_REFRESH_TASK_STATUSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { catalogSources } from './provenance';
import { catalogSourceRuns } from './ingestion';
import { offers } from './offers';

/** Bound on any stored note, error or detail in this domain. */
export const OFFER_FRESHNESS_MAX_TEXT_LENGTH = 2_000;

/**
 * What a source's anomaly detectors are calibrated to before anybody publishes
 * a freshness version for it.
 *
 * Exported and used as the COLUMN DEFAULTS below, so a source with no published
 * version and a source with a freshly published one are detected against the
 * same numbers — and there is exactly one place the four are written down. A
 * hand-typed second copy in the resolver could drift silently, in the direction
 * that makes the detectors disagree with the board an operator is reading.
 *
 * They are not a global TTL and could not become one: none of them is a
 * duration. `minimumSampleSize` is the vacuity floor that keeps a thin page and
 * a legitimate sale out of the quarantine board, and `priceScaleFactor` is the
 * number that tells a sale (well under 2x) from a minor/major units error
 * (exactly 100x).
 */
export const DEFAULT_SOURCE_ANOMALY_THRESHOLDS = {
  minimumSampleSize: 50,
  zeroPriceShareBps: 5_000,
  priceScaleFactor: 10,
  disappearanceShareBps: 5_000,
} as const;

/**
 * What a refresh task is ABOUT.
 *
 * `source` is a whole-source pass (a snapshot or an incremental sweep) and its
 * `subject_key` is the sentinel below; `external_object` names one object the
 * source publishes, which is what a priority refresh actually needs. They are
 * one table because they share a queue, a lease, a budget and a backoff, and
 * two tables would need all four twice.
 */
export const OFFER_REFRESH_SUBJECT_KINDS = ['source', 'external_object'] as const;

/**
 * The `subject_key` a whole-source task carries.
 *
 * A sentinel rather than NULL, because the convergence key
 * `UNIQUE(source_id, mode, subject_key)` is what makes five requests for one
 * snapshot owe ONE snapshot — and Postgres treats NULLs as DISTINCT, so a
 * nullable column would let five identical whole-source tasks coexist. The
 * `offers.source_key` device: collapse to a text value the unique can see.
 *
 * `*` cannot collide with a real external id because the CHECK below refuses it
 * for `external_object`.
 */
export const OFFER_REFRESH_SOURCE_SUBJECT_KEY = '*';

/**
 * `case "priority_class" when 'alerted' then 0 … end`, rendered from the SAME
 * ordering the scheduler reads.
 *
 * A stored GENERATED column needs an IMMUTABLE expression, and a `case` over a
 * text column is one. Writing the ranks out here rather than storing a number a
 * service computed is what makes "the queue's order is a function of the row"
 * true against a service bug, a replay and a hand-written `UPDATE` alike.
 *
 * `else` is deliberately a rank BELOW everything named: an unrecognised class
 * (only reachable with the class CHECK removed) sorts last rather than first,
 * so a widening that forgot this expression starves the new class instead of
 * pre-empting every real one.
 */
const PRIORITY_RANK_CASE_SQL = [
  'case "priority_class"',
  ...OFFER_REFRESH_PRIORITY_CLASSES.map(
    (value) => `when '${value}' then ${OFFER_REFRESH_PRIORITY_RANK[value]}`,
  ),
  `else ${OFFER_REFRESH_PRIORITY_CLASSES.length} end`,
].join(' ');

/**
 * `catalog_source_freshness_policies` — how long ONE source's facts stay
 * trustworthy, and how far its feed may move before Mercaria stops believing it
 * (#68 §"Freshness model", §"Anomaly protection").
 *
 * ### Why a versioned table rather than more columns on `catalog_source_configs`
 *
 * The config is operational state a dispatcher writes on every run — health,
 * leases, the next due time. These numbers are a POLICY somebody decided, and
 * two of the three things they encode are contractual: a cache term negotiated
 * with a provider and a retention obligation. Putting them on a row a worker
 * rewrites every fifteen minutes would make "what were the terms in March"
 * unanswerable, and #62 already established the shape for exactly this
 * (`catalog_source_policies`, the RIGHTS version).
 *
 * A source with NO published version still has a policy — derived from its own
 * config row by `resolveSourceFreshnessPolicy`, basis `source_configuration`.
 * That is what keeps #62's existing sources working on the deploy that adds
 * this, rather than withdrawing every external offer from comparison at once
 * (ADR 0002 D24's rule about a rollout lever never being introduced in the
 * position that removes a live surface).
 */
export const catalogSourceFreshnessPolicies = pgTable(
  'catalog_source_freshness_policies',
  {
    id: generatedId(),
    /** RESTRICT: nothing deletes a provenance registry row (#62's reasoning). */
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** Monotonic per source. Cited by every decision made under it. */
    version: integer().notNull(),
    status: text({ enum: asEnumValues(CATALOG_SOURCE_POLICY_STATUSES) })
      .notNull()
      .default('draft'),

    // ── The freshness contract (#68 freshness model 1, 6, 7) ─────────────────
    /** How often this source is expected to be refreshed at all. */
    expectedRefreshIntervalSeconds: integer().notNull(),
    /** How long after the last successful observation an offer enters `warning`. */
    warningAfterSeconds: integer().notNull(),
    /** How long after the last successful observation an offer EXPIRES. */
    expiryAfterSeconds: integer().notNull(),
    /**
     * Extra survival granted to the RETIREMENT sweep while the source is in a
     * FETCH failure (#68 scheduler 6, acceptance 1).
     *
     * It never changes what a buyer sees: display stops at the expiry deadline,
     * derived, with no sweep involved. Grace delays only the durable
     * retirement, so a transient outage does not cost the catalogue.
     */
    outageGraceSeconds: integer().notNull(),
    /**
     * Whether an object the source declares GONE retires immediately.
     *
     * Defaults TRUE. eBay's API License Agreement requires deleting content
     * once a listing is no longer publicly available, and retaining something a
     * source says is gone is the direction that breaks a contract rather than a
     * page.
     */
    retireOnSourceUnavailable: boolean().notNull().default(true),
    /**
     * Which refresh modes this source may be scheduled in.
     *
     * EMPTY means UNRESTRICTED — the `catalog_source_configs.territories`
     * semantics, not the `supplier_agreements` grant ones. It narrows what the
     * ADAPTER declares and can never widen it: an adapter that cannot enumerate
     * completely does not gain the ability because a policy listed the mode.
     */
    permittedRefreshModes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    // ── The anomaly thresholds (#68 anomaly 1 and 3) ─────────────────────────
    /**
     * Below this many records in a pass, NOTHING is anomalous.
     *
     * The floor is what keeps a thin category page and a legitimate sale out of
     * the quarantine board: a distribution over nine rows is not evidence about
     * a catalogue, and a detector that fired on it would be switched off by
     * whoever hit it next.
     */
    anomalyMinimumSampleSize: integer()
      .notNull()
      .default(DEFAULT_SOURCE_ANOMALY_THRESHOLDS.minimumSampleSize),
    /** Basis points. The share of priced records at zero that reads as broken. */
    anomalyZeroPriceShareBps: integer()
      .notNull()
      .default(DEFAULT_SOURCE_ANOMALY_THRESHOLDS.zeroPriceShareBps),
    /**
     * How far the median may move, as a FACTOR either way.
     *
     * The number that tells a sale from a scale error: a seasonal sale moves a
     * catalogue's median well under 2×, while publishing majors where minors
     * were published moves it by exactly 100×. Per source, so a feed with a
     * genuinely volatile median can raise its own rather than everybody
     * lowering theirs.
     */
    anomalyPriceScaleFactor: integer()
      .notNull()
      .default(DEFAULT_SOURCE_ANOMALY_THRESHOLDS.priceScaleFactor),
    /** Basis points. The share of known objects a COMPLETE snapshot may drop. */
    anomalyDisappearanceShareBps: integer()
      .notNull()
      .default(DEFAULT_SOURCE_ANOMALY_THRESHOLDS.disappearanceShareBps),

    // ── The review stamp, `catalog_source_policies`' arrangement ─────────────
    reviewedAt: timestamptz(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    reviewedByOxyUserId: text(),
    reviewNote: text(),
    activatedAt: timestamptz(),
    supersededAt: timestamptz(),
    /** The version this one replaced, so the chain reads backwards in time. */
    supersedesVersion: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_source_freshness_policies_status_check',
      t.status,
      CATALOG_SOURCE_POLICY_STATUSES,
    ),
    checkEveryElementOf(
      'catalog_source_freshness_policies_modes_check',
      t.permittedRefreshModes,
      CATALOG_REFRESH_MODES,
    ),
    check('catalog_source_freshness_policies_version_check', sql`${t.version} >= 1`),
    check(
      'catalog_source_freshness_policies_supersedes_check',
      sql`${t.supersedesVersion} is null or ${t.supersedesVersion} < ${t.version}`,
    ),
    /**
     * The three durations are ORDERED, and the ordering is the contract.
     *
     * A warning threshold at or past the expiry is a state no offer could ever
     * reach, so a policy that published one would silently have no warning
     * state at all — which is exactly the interval a refresh scheduler exists
     * to act in. The floor of 60 seconds matches
     * `catalog_source_configs_ttl_check`, one table over, because two different
     * floors on one quantity is the disagreement these conventions prevent.
     */
    check(
      'catalog_source_freshness_policies_durations_check',
      sql`${t.expectedRefreshIntervalSeconds} >= 60
          and ${t.warningAfterSeconds} >= 60
          and ${t.expiryAfterSeconds} >= 60
          and ${t.outageGraceSeconds} >= 0
          and ${t.warningAfterSeconds} < ${t.expiryAfterSeconds}`,
    ),
    check(
      'catalog_source_freshness_policies_thresholds_check',
      sql`${t.anomalyMinimumSampleSize} >= 1
          and ${t.anomalyZeroPriceShareBps} between 1 and 10000
          and ${t.anomalyDisappearanceShareBps} between 1 and 10000
          and ${t.anomalyPriceScaleFactor} >= 2`,
    ),
    /** An active version was reviewed by somebody, on a date — #62's rule. */
    check(
      'catalog_source_freshness_policies_active_review_check',
      sql`${t.status} = 'draft'
          or (${t.reviewedAt} is not null and ${t.reviewedByOxyUserId} is not null
              and ${t.activatedAt} is not null)`,
    ),
    check(
      'catalog_source_freshness_policies_superseded_shape_check',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    check(
      'catalog_source_freshness_policies_note_length_check',
      sql`${t.reviewNote} is null
          or length(${t.reviewNote}) <= ${sql.raw(String(OFFER_FRESHNESS_MAX_TEXT_LENGTH))}`,
    ),
    /** PROPERTY 2 — one version number per source, and one ACTIVE version. */
    uniqueIndex('catalog_source_freshness_policies_version_key').on(t.sourceId, t.version),
    uniqueIndex('catalog_source_freshness_policies_active_key')
      .on(t.sourceId)
      .where(sql`${t.status} = 'active'`),
    index('catalog_source_freshness_policies_source_idx').on(t.sourceId, t.version),
  ],
);

/**
 * `offer_refresh_tasks` — the durable promise that something will be re-read
 * (#68 §"Scheduler and jobs" 1–4).
 *
 * ### A CONVERGENCE queue, like `offer_outboxes` and unlike the outboxes
 *
 * `UNIQUE(source_id, mode, subject_key)` and an `ON CONFLICT DO UPDATE` enqueue
 * that RAISES the priority and bumps `requested_revision`. Five buyers opening
 * one product page owe ONE refresh of the offers on it, not five, and a
 * delivery queue keyed on an event id would make the answer "five" — with five
 * calls against a provider's quota to show for it.
 *
 * The `requested_revision` / `claimed_revision` pair is #57's, for its reason:
 * a request that lands mid-run must not be swallowed by the completion that
 * follows it, or an alert raised one millisecond after a claim waits for the
 * next unrelated refresh of that source.
 *
 * ### The priority is a class, its rank is GENERATED, and its reasons are kept
 *
 * An offer can be popular AND alerted; the queue orders on one number. The
 * class is the worst of the reasons (the `deriveRetailCompleteness` severity
 * rule), the rank is computed from the class by the database, and every reason
 * survives beside them so an operator can see why a row is where it is.
 */
export const offerRefreshTasks = pgTable(
  'offer_refresh_tasks',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    mode: text({ enum: asEnumValues(CATALOG_REFRESH_MODES) }).notNull(),
    subjectKind: text({ enum: asEnumValues(OFFER_REFRESH_SUBJECT_KINDS) }).notNull(),
    /** The source's own id for the object, or {@link OFFER_REFRESH_SOURCE_SUBJECT_KEY}. */
    subjectKey: text().notNull(),
    /**
     * The offer this task exists for, when it was raised from one.
     *
     * A pointer for the operator trace and nothing the scheduler reads —
     * the SUBJECT is the external object, because an offer can be retired and
     * revived while the object it names stays the same thing. RESTRICT: an
     * offer is retired and never deleted (#57), so this can only be blocked by
     * a deletion that does not happen.
     */
    offerId: text().references(() => offers.id, { onDelete: 'restrict' }),

    priorityClass: text({ enum: asEnumValues(OFFER_REFRESH_PRIORITY_CLASSES) }).notNull(),
    /** Every reason that has been raised for this subject, deduped by the writer. */
    priorityReasons: text()
      .array()
      .notNull(),
    /** PROPERTY 3 — the ordering key, computed by the database from the class. */
    priorityRank: integer()
      .notNull()
      .generatedAlwaysAs(sql.raw(PRIORITY_RANK_CASE_SQL)),

    status: text({ enum: asEnumValues(OFFER_REFRESH_TASK_STATUSES) }).notNull().default('pending'),
    /** Bumped by every enqueue. Monotonic per row; never a clock. */
    requestedRevision: bigint({ mode: 'number' }).notNull().default(1),
    /** The revision this claim is answering. NULL before the first claim. */
    claimedRevision: bigint({ mode: 'number' }),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    /**
     * Why the last attempt refused, when it did.
     *
     * A closed vocabulary rather than free text, because these four are the
     * operator's diagnosis: `unsupported_mode` means the adapter cannot do what
     * was asked and the request needs re-planning, `rate_limited` means the
     * budget needs raising, `adapter_missing` means nobody shipped one. A
     * sentence would need parsing to tell them apart.
     */
    lastRefusal: text({ enum: asEnumValues(OFFER_REFRESH_REFUSALS) }),
    processedAt: timestamptz(),
    /** The Oxy operator who asked for this by hand. NULL for everything else. */
    requestedByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('offer_refresh_tasks_mode_check', t.mode, CATALOG_REFRESH_MODES),
    checkOneOf('offer_refresh_tasks_subject_kind_check', t.subjectKind, OFFER_REFRESH_SUBJECT_KINDS),
    checkOneOf('offer_refresh_tasks_status_check', t.status, OFFER_REFRESH_TASK_STATUSES),
    checkOneOf('offer_refresh_tasks_refusal_check', t.lastRefusal, OFFER_REFRESH_REFUSALS),
    checkOneOf(
      'offer_refresh_tasks_priority_class_check',
      t.priorityClass,
      OFFER_REFRESH_PRIORITY_CLASSES,
    ),
    checkEveryElementOf(
      'offer_refresh_tasks_priority_reasons_check',
      t.priorityReasons,
      OFFER_REFRESH_PRIORITY_CLASSES,
    ),
    /**
     * The class is one of the reasons, and there is at least one reason.
     *
     * Containment is expressible in a CHECK and MAXIMALITY is not (it would
     * need an ordering over an array), so the two halves live in different
     * places on purpose: the database refuses a class nobody asked for, and
     * `highestRefreshPriority` plus its mutation test hold the "worst of them"
     * half. A class outside its own reasons is the failure that would silently
     * re-order the queue; a class that is merely not the worst one delays a row
     * behind rows that are genuinely more urgent, which is visible.
     */
    check(
      'offer_refresh_tasks_priority_membership_check',
      // `coalesce(array_length(…), 0)`: `array_length` of an EMPTY array is
      // NULL, and a CHECK rejects only FALSE — so the bare comparison would
      // admit a task with no reasons at all, which is the row this constraint
      // exists to refuse.
      sql`coalesce(array_length(${t.priorityReasons}, 1), 0) >= 1
          and ${t.priorityClass} = any(${t.priorityReasons})`,
    ),
    /**
     * The subject sentinel belongs to whole-source tasks and to nothing else.
     *
     * Without this, an external object whose id happened to be `*` would share
     * a convergence key with its source's snapshot task and one would silently
     * absorb the other.
     */
    check(
      'offer_refresh_tasks_subject_shape_check',
      sql`case ${t.subjectKind}
        when 'source' then ${t.subjectKey} = ${sql.raw(`'${OFFER_REFRESH_SOURCE_SUBJECT_KEY}'`)}
        when 'external_object' then
          btrim(${t.subjectKey}) <> ''
          and ${t.subjectKey} <> ${sql.raw(`'${OFFER_REFRESH_SOURCE_SUBJECT_KEY}'`)}
        else false
      end`,
    ),
    /**
     * A TARGETED refresh names an object; a SNAPSHOT cannot.
     *
     * "Re-read exactly these five" and "enumerate the whole feed" are different
     * requests, and a full snapshot carrying an object id would read as the
     * first while spending the quota of the second.
     */
    check(
      'offer_refresh_tasks_mode_subject_check',
      sql`(${t.mode} = 'targeted') = (${t.subjectKind} = 'external_object')`,
    ),
    check('offer_refresh_tasks_attempts_check', sql`${t.attempts} >= 0`),
    check('offer_refresh_tasks_requested_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'offer_refresh_tasks_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    /** Half a lease is unrepresentable — the `reconciliation_cursors` CHECK. */
    check(
      'offer_refresh_tasks_lease_complete_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
    check(
      'offer_refresh_tasks_last_error_length_check',
      sql`${t.lastError} is null
          or length(${t.lastError}) <= ${sql.raw(String(OFFER_FRESHNESS_MAX_TEXT_LENGTH))}`,
    ),
    /** PROPERTY — one outstanding task per (source, mode, subject), ever. */
    uniqueIndex('offer_refresh_tasks_convergence_key').on(t.sourceId, t.mode, t.subjectKey),
    /**
     * The claim: due PENDING work, most urgent first.
     *
     * `priority_rank` leads, then the due time, then the row's age — so an
     * alerted offer pre-empts a scheduled sweep and two equally urgent rows are
     * served oldest first. Partial on `pending`, so the index is the size of
     * the backlog rather than of every refresh ever performed.
     */
    index('offer_refresh_tasks_pending_idx')
      .on(t.priorityRank, t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    /** Reclaiming a dead task's lease — its own partial index, the outbox shape. */
    index('offer_refresh_tasks_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
    /** The per-source queue read the health surface runs. */
    index('offer_refresh_tasks_source_idx').on(t.sourceId, t.status, t.availableAt),
    index('offer_refresh_tasks_offer_idx')
      .on(t.offerId)
      .where(sql`${t.offerId} is not null`),
  ],
);

/**
 * `catalog_source_refresh_leases` — the fleet-wide bound on how hard Mercaria
 * may knock on one source (#68 scheduler 3).
 *
 * `supplier_call_leases` (#122), pointed the other way: that table bounds calls
 * OUT to a supplier during checkout, this one bounds calls out to a catalogue
 * source during refresh. The argument is identical and worth restating, because
 * the tempting alternative is wrong in a way that is invisible until a provider
 * disables the integration: **"how many calls per minute may this source
 * receive, across every ECS task" is not a question an in-process token bucket
 * can answer** — every task answers it separately and their sum is whatever the
 * task count happens to be.
 *
 * A slot is a ROW, so concurrency is exact (a row lock cannot be taken twice).
 * The per-minute allowance rides the SAME row as that slot's equal share, so
 * the rate bound is serialized by that same lock. The trade is stated rather
 * than hidden: an uneven arrival pattern can leave one slot's share unused
 * while another is spent, so the limiter can UNDER-admit — which errs toward
 * not exceeding the provider's published limit, the direction a provider's own
 * limiter punishes.
 *
 * This does NOT replace #62's source lease. That lease says "this task is
 * responsible for feeding this source" and is about ownership; this one is
 * about how fast, and a source with a concurrency of four wants four holders of
 * this and still exactly one owner of that.
 */
export const catalogSourceRefreshLeases = pgTable(
  'catalog_source_refresh_leases',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** 0-based concurrency slot. The row count IS the concurrency bound. */
    slot: integer().notNull(),
    /** The claiming process. NULL = free. */
    leaseOwner: text(),
    /** When the claim lapses and another task may reclaim it. */
    leaseUntil: timestamptz(),
    /** The start of the minute this slot's counter is counting. */
    windowStart: timestamptz().notNull(),
    /** Calls this slot has STARTED inside `window_start`. */
    callsInWindow: integer().notNull().default(0),
    /** This slot's share of the source's per-minute allowance, snapshotted. */
    windowAllowance: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('catalog_source_refresh_leases_slot_check', sql`${t.slot} >= 0`),
    // A lease is an owner AND a deadline, together. Half of one is a slot no
    // task can prove it holds and no sweep can safely reclaim.
    check(
      'catalog_source_refresh_leases_lease_shape_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseUntil}) in (0, 2)`,
    ),
    check(
      'catalog_source_refresh_leases_window_check',
      sql`${t.callsInWindow} >= 0 and ${t.windowAllowance} >= 1
          and ${t.callsInWindow} <= ${t.windowAllowance}`,
    ),
    uniqueIndex('catalog_source_refresh_leases_source_slot_key').on(t.sourceId, t.slot),
    /** The claim: this source's free slots. */
    index('catalog_source_refresh_leases_source_free_idx').on(t.sourceId, t.leaseUntil),
  ],
);

/**
 * `catalog_source_distributions` — the last SOUND distribution one source
 * published, and the only thing a new pass is compared against (#68 anomaly 3).
 *
 * ### One CURRENT row per source, not a history
 *
 * The question this table exists to answer is "does what arrived just now look
 * like what this feed normally looks like", which needs the baseline and not a
 * time series of them. A history would also make the comparison ambiguous —
 * against which of the last thirty? — and the runs themselves already carry
 * their own counters for anybody reconstructing a trend.
 *
 * ### It is written only by a run that was NOT quarantined
 *
 * The baseline is what a suspicious run is judged against, so accepting one
 * from a run nobody believed would let a broken feed re-base its own normal in
 * two passes and then look healthy. `recordSourceDistribution` is the single
 * writer and takes the run's quarantine verdict as an argument for that reason.
 */
export const catalogSourceDistributions = pgTable(
  'catalog_source_distributions',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /**
     * The run that produced this baseline.
     *
     * `set null`, deliberately, and it is the one FK in this domain worth
     * arguing about. The baseline is a fact about the SOURCE — what its feed
     * normally looks like — and the run pointer is provenance for it. CASCADE
     * would delete a live baseline with a run, which is the opposite of what a
     * baseline is for; RESTRICT would make the run undeletable, which reads as
     * a stronger guarantee and is really just a blocked teardown: #62's own
     * contract suite deletes runs, and `catalog_source_rejections` already
     * models that by CASCADing. `set null` keeps the fact and loses only the
     * pointer — the `product_save_sources.save_id` reasoning (#80).
     */
    capturedFromRunId: text().references(() => catalogSourceRuns.id, { onDelete: 'set null' }),
    /** How many records the distribution was computed over. */
    sampleSize: integer().notNull(),
    pricedCount: integer().notNull(),
    zeroPricedCount: integer().notNull(),
    /**
     * The median price in minor units of `dominant_currency`.
     *
     * `bigint` for the `columns.ts` reason — FAIR's eight decimals overflow a
     * signed `integer` at 21.47 ⊜ — and NULL when nothing in the pass was
     * priced, which is a real state for an `informational` source.
     */
    medianPriceMinor: bigint({ mode: 'number' }),
    dominantCurrency: text(),
    /** Basis points. A feed with two currencies is not itself an anomaly. */
    dominantCurrencyShareBps: integer().notNull().default(0),
    /** How many objects this source was known to publish when the baseline was taken. */
    objectCount: integer().notNull().default(0),
    capturedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'catalog_source_distributions_counts_check',
      sql`${t.sampleSize} >= 0 and ${t.pricedCount} >= 0 and ${t.zeroPricedCount} >= 0
          and ${t.objectCount} >= 0
          and ${t.pricedCount} <= ${t.sampleSize}
          and ${t.zeroPricedCount} <= ${t.pricedCount}`,
    ),
    check(
      'catalog_source_distributions_share_check',
      sql`${t.dominantCurrencyShareBps} between 0 and 10000`,
    ),
    /**
     * A median is a price and a price is an amount AND a currency.
     *
     * The `offers_price_paired_check` device: an amount with no currency is not
     * a price, and a baseline that carried one would make the currency-change
     * detector compare a number against nothing.
     */
    check(
      'catalog_source_distributions_median_paired_check',
      sql`(${t.medianPriceMinor} is null) = (${t.dominantCurrency} is null)`,
    ),
    check(
      'catalog_source_distributions_median_shape_check',
      sql`${t.medianPriceMinor} is null
          or (${t.medianPriceMinor} >= 0 and ${t.dominantCurrency} ~ '^[A-Z]{3,4}$')`,
    ),
    /** PROPERTY — exactly one baseline per source. */
    uniqueIndex('catalog_source_distributions_source_key').on(t.sourceId),
  ],
);

/**
 * `catalog_source_run_quarantines` — a run whose OUTPUT was held back before
 * publication (#68 anomaly 2, 4, 5).
 *
 * ### Why this is not `catalog_source_objects.state = 'quarantined'`
 *
 * #62 quarantines one OBJECT whose own price jumped. These four findings are
 * statements about a DISTRIBUTION and cannot be seen one row at a time: a feed
 * that started publishing majors where it used to publish minors looks entirely
 * reasonable in every individual record. So the finding is recorded against the
 * RUN, and the objects it covers are held through #62's existing per-object
 * mechanism — one quarantine vocabulary at the row, one at the pass, neither a
 * copy of the other.
 *
 * ### The row is append-only in the way that matters
 *
 * There is no UPDATE that removes a finding: resolution ADDS the verdict, the
 * actor and the date beside it. `released` and `corrected` are different facts
 * and are kept apart — one is a person taking responsibility for publishing
 * something the detectors did not believe, the other is the feed itself coming
 * back into range, and an incident review needs to know which.
 */
export const catalogSourceRunQuarantines = pgTable(
  'catalog_source_run_quarantines',
  {
    id: generatedId(),
    /**
     * The pass whose output is held. CASCADE, matching
     * `catalog_source_rejections`: a run is the parent of its own evidence, and
     * nothing deletes runs anyway.
     */
    runId: text()
      .notNull()
      .references(() => catalogSourceRuns.id, { onDelete: 'cascade' }),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(CATALOG_SOURCE_ANOMALY_KINDS) }).notNull(),
    /** The statistic this pass produced — a ratio or a factor, never a payload. */
    observedValue: doublePrecision().notNull(),
    /** What it was compared against. NULL for a detector that needs no baseline. */
    baselineValue: doublePrecision(),
    /** Field names and ratios. `describeRejection`'s rule, one table over. */
    detail: text().notNull(),
    /** How many objects this finding held out of the pipeline. */
    heldObjects: integer().notNull().default(0),

    resolution: text({ enum: asEnumValues(CATALOG_SOURCE_QUARANTINE_RESOLUTIONS) }),
    resolvedAt: timestamptz(),
    /** An Oxy account id — no foreign key. NULL when a later run corrected it. */
    resolvedByOxyUserId: text(),
    resolutionNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_source_run_quarantines_kind_check', t.kind, CATALOG_SOURCE_ANOMALY_KINDS),
    checkOneOf(
      'catalog_source_run_quarantines_resolution_check',
      t.resolution,
      CATALOG_SOURCE_QUARANTINE_RESOLUTIONS,
    ),
    check('catalog_source_run_quarantines_held_check', sql`${t.heldObjects} >= 0`),
    check('catalog_source_run_quarantines_detail_check', sql`btrim(${t.detail}) <> ''`),
    check(
      'catalog_source_run_quarantines_detail_length_check',
      sql`length(${t.detail}) <= ${sql.raw(String(OFFER_FRESHNESS_MAX_TEXT_LENGTH))}`,
    ),
    /** A resolution carries its time, or it is not one anybody can audit. */
    check(
      'catalog_source_run_quarantines_resolved_shape_check',
      sql`(${t.resolution} is not null) = (${t.resolvedAt} is not null)`,
    ),
    /**
     * A RELEASE is somebody's decision and names them; a CORRECTION is the feed
     * coming back and names nobody.
     *
     * #68 anomaly 4 asks that a quarantine need an explicit release or a
     * corrected run. Making the actor mandatory on one and forbidden on the
     * other is what stops the two being told apart by a note somebody wrote.
     */
    check(
      'catalog_source_run_quarantines_actor_shape_check',
      sql`(${t.resolvedByOxyUserId} is not null) = (${t.resolution} = 'released')`,
    ),
    check(
      'catalog_source_run_quarantines_note_length_check',
      sql`${t.resolutionNote} is null
          or length(${t.resolutionNote}) <= ${sql.raw(String(OFFER_FRESHNESS_MAX_TEXT_LENGTH))}`,
    ),
    /** One finding of each kind per run — a repeat converges rather than piling up. */
    uniqueIndex('catalog_source_run_quarantines_run_kind_key').on(t.runId, t.kind),
    /** The quarantine board: this source's OPEN findings, newest first. */
    index('catalog_source_run_quarantines_open_idx')
      .on(t.sourceId, t.createdAt)
      .where(sql`${t.resolution} is null`),
    index('catalog_source_run_quarantines_source_idx').on(t.sourceId, t.kind, t.createdAt),
  ],
);

