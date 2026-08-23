/**
 * Catalog observability: metric definitions, measurement states and the
 * vocabulary of what cannot be measured (#367 Workstreams 16 and 17).
 *
 * ## Metrics are DATA, and a metric with an unstated denominator does not
 * compile
 *
 * `CatalogMetricDefinition` is #77's `AnalyticsMetricDefinition` applied to the
 * catalog graph, and it keeps that type's one load-bearing property: apart from
 * `unmeasured` there is **no optional field**, so a number whose denominator,
 * window, source or attribution limit nobody stated cannot be added to the
 * registry — and `CATALOG_METRIC_KEYS`, derived from the registry rather than
 * written a second time, is what a read surface resolves against, so it cannot
 * be served either.
 *
 * ## `unmeasured` is a first-class state and it is NOT zero
 *
 * This is the whole reason the file exists. Eleven catalog domains landed in one
 * night and a sweep that computed the thirty-one metrics it could reach and
 * reported `0` for the other seven would tell an operator the catalogue is clean
 * when seven of the questions were never asked. `CatalogMetricReading` is therefore a
 * string-discriminated union whose `unmeasured` branch has **no `value`, no
 * `numerator` and no `denominator` property at all** — there is no field a
 * caller could read as a quantity, so rendering an unmeasured metric as a number
 * is a type error rather than a judgement call.
 *
 * String discriminants, not booleans: the backend compiles with `strict: false`,
 * and without `strictNullChecks` TypeScript does not narrow a union on the
 * truthiness of a boolean-literal discriminant, so `if (!reading.measured)`
 * would leave the caller holding the whole union.
 *
 * ## `0 / 0` is not 100%, and it is not `unmeasured` either
 *
 * A ratio whose denominator is zero is MEASURED — the read ran, the population
 * is genuinely empty — so it stays in the `measured` branch carrying
 * `denominator: 0`, and `ratio` is omitted. That is
 * `catalog-governance/quality.service.ts`'s `cell()` decision, and the
 * distinction matters: "nobody has published a category yet" and "nothing
 * measured translation coverage" lead an operator to opposite actions.
 *
 * ## Every unmeasured metric names WHY, from a closed set
 *
 * `CATALOG_UNMEASURED_REASONS` is closed so that "we have not built it" and "the
 * fact does not exist to be measured" cannot be spelled two ways and counted as
 * one. The `seam` beside it names the issue or the exact module that owes the
 * input, which is what makes the gap a piece of work rather than a permanent
 * apology.
 */

/* -------------------------------------------------------------------------- */
/* Definition vocabulary                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where a catalog metric's numbers come from.
 *
 * Each member is a table or an existing owning reader, never "the catalog" —
 * a source that does not name what was read cannot be checked by whoever reads
 * the number later. `route_observations` is the in-process HTTP timer this
 * domain owns; it is listed as a source precisely because it is the one that
 * resets on deploy, and `freshnessSeconds` alone would not say so.
 */
export const CATALOG_METRIC_SOURCES = [
  'catalog_authoring_drafts',
  'catalog_proposals',
  'catalog_external_mappings',
  'catalog_external_token_observations',
  'catalog_external_mapping_runs',
  'catalog_backfill_runs',
  'catalog_backfill_records',
  'catalog_consistency_findings',
  'attribute_reindex_requests',
  'native_listing_links',
  'match_queue',
  'native_listing_attribute_claims',
  'category_localizations',
  'product_type_localizations',
  'attribute_value_localizations',
  'navigation_node_localizations',
  'categories',
  'product_type_definitions',
  'catalog_governance_quality',
  'catalog_governance_queues',
  /**
   * The translation desk's completeness reads
   * (`db/catalogLocalization/completenessRepository.ts`).
   *
   * Distinct from `catalog_governance_quality` and from the individual
   * localization tables, and that distinction is the point: the desk counts its
   * denominator from the ENTITY population per (domain, locale), which no
   * localization row participates in, and reports `absent` — an entity with no
   * row at all — which a `group by` over those tables structurally cannot see.
   */
  'catalog_localization_completeness',
  'analytics_search_queries',
  'facet_scope_sweep',
  'route_observations',
  /**
   * The in-process record of what a PUBLICATION attempt was refused for
   * (#367 W17 line 768). Counted where `publish.service.ts` calls
   * `validateDraftRow`, which is the one site a publication is decided at —
   * `draft.service.ts`'s standalone validate is NOT an attempt and is not
   * counted, or the rate would report every keystroke a form validated.
   */
  'authoring_publication_attempts',
  /**
   * The in-process record of how a localized field was answered (#367 W17
   * line 771) — exact, a language truncation, the base locale, or not at all.
   * Counted in the SERVING path and never in `resolve.ts`, whose purity is
   * load-bearing and argued in its own header.
   */
  'localization_resolutions',
  /**
   * The shadow comparison in `services/variant-axes/projection.ts` (#367 line
   * 324), counted as each listing is hydrated.
   *
   * Process-local like `route_observations`, and it resets on deploy for the
   * same reason. It differs in one way worth naming here rather than in every
   * metric that reads it: it records NOTHING unless `VARIANT_AXIS_READS` is
   * `shadow` or `on`, so a zero denominator means the lever is off rather than
   * that nobody browsed.
   */
  'variant_axis_shadow',
] as const;

export type CatalogMetricSource = (typeof CATALOG_METRIC_SOURCES)[number];

/**
 * The sources that are MODULE-SCOPE COUNTERS in this process rather than a read
 * of something durable.
 *
 * A subset of `CATALOG_METRIC_SOURCES`, and the reason it is named rather than
 * spelled at each use is the biconditional `contract-gates.test.ts` holds:
 * `freshnessSeconds === 0` exactly when the source is one of these. A metric
 * over a Postgres aggregate declaring zero staleness would tell a dashboard its
 * number is never stale; an in-process counter declaring 300 would suggest a
 * cache in front of an integer. Written as ONE tuple so a third in-process
 * source joins both halves of that rule in a single edit, rather than passing a
 * gate keyed on a literal.
 *
 * They share the other property worth stating once: **they reset on deploy and
 * on every task restart**, so a fleet reading is the sum over tasks and no
 * single task's number is the answer.
 */
export const CATALOG_IN_PROCESS_METRIC_SOURCES: readonly CatalogMetricSource[] = [
  'route_observations',
  'variant_axis_shadow',
  'authoring_publication_attempts',
  'localization_resolutions',
];

/**
 * The window a metric is computed over.
 *
 * `instant` is a gauge — a queue depth, a backlog, a coverage ratio — and is
 * kept apart from the rolling rates on purpose: an operator reading "12%" needs
 * to know whether that is twelve percent of what exists right now or of what
 * happened last week, and the two go in opposite directions during an incident.
 */
export const CATALOG_METRIC_WINDOWS = [
  'instant',
  'rolling_1h',
  'rolling_24h',
  'rolling_7d',
  'since_process_start',
] as const;

export type CatalogMetricWindow = (typeof CATALOG_METRIC_WINDOWS)[number];

/**
 * What a metric is shaped like, so a consumer knows what it may do with the
 * number without reading the prose.
 *
 * `ratio` carries a numerator and a denominator and may be rendered as a
 * percentage; `count` is a bare quantity and may not; `latency` carries
 * percentiles and has no single value at all. Collapsing the three is how a
 * dashboard ends up averaging a p95.
 */
export const CATALOG_METRIC_KINDS = ['ratio', 'count', 'latency', 'age_seconds'] as const;

export type CatalogMetricKind = (typeof CATALOG_METRIC_KINDS)[number];

/**
 * One catalog metric, completely stated.
 *
 * `unmeasured` is the only optional field, and it is optional because its
 * ABSENCE is the assertion that this metric is produced today. A metric carrying
 * it is listed, is readable, and answers `unmeasured` — which is the difference
 * between "not built yet" and "measured as nothing". The collector reads exactly
 * this field to decide which branch a reading takes, so the registry and the
 * report cannot disagree about which metrics exist.
 */
export interface CatalogMetricDefinition {
  /** Stable. Appears in every reading and in the read surface's path. */
  readonly key: string;
  readonly title: string;
  readonly kind: CatalogMetricKind;
  /** Exactly what is counted on top. Never "matching rows". */
  readonly numerator: string;
  /** Exactly what is counted underneath. Never "everything". */
  readonly denominator: string;
  readonly window: CatalogMetricWindow;
  readonly source: CatalogMetricSource;
  /** How stale a reading may be before it stops meaning what it says. */
  readonly freshnessSeconds: number;
  /** What this metric CANNOT tell you. The field a dashboard footnote comes from. */
  readonly attributionLimit: string;
  /**
   * Present exactly when this deployment cannot produce the metric.
   *
   * ONE optional field carrying BOTH halves, rather than a `seam` beside an
   * `unmeasuredReason`: two optional fields can disagree — a seam with no reason,
   * or worse a reason with no owner — and the disagreement would land in the
   * collector, which decides `measured` versus `unmeasured` from exactly this
   * field's presence. Nested, the biconditional is unrepresentable.
   */
  readonly unmeasured?: {
    readonly reason: CatalogUnmeasuredReason;
    /** The issue or the exact module that owes the input. */
    readonly seam: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Measurement states                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Why a metric this registry defines could not be produced.
 *
 * Closed, because the whole point is that an operator can tell the six apart.
 * `no_dead_letter_state` is the one to read: #367's queues record `attempts` and
 * `last_error` and have no dead-letter state at all, so "zero dead letters" is
 * not a healthy reading — it is a category error, and reporting it as `0` would
 * put a permanently green tile on a dashboard for a condition that cannot occur.
 */
export const CATALOG_UNMEASURED_REASONS = [
  /** Nothing records the fact. A column or a counter is owed. */
  'not_instrumented',
  /** The fact is a client-side one and no client emits it. */
  'client_signal_absent',
  /** The queue this would measure has no consumer, so throughput is undefined. */
  'no_consumer_registered',
  /** The state this counts does not exist in the schema. Not the same as zero. */
  'no_dead_letter_state',
  /** The dimension asked for is not on the source table. */
  'dimension_absent_from_source',
  /** The owning domain's reader refused or was unavailable for this read. */
  'source_unavailable',
  /**
   * The route this metric observes is not mounted in this deployment.
   *
   * Distinct from a population of zero, and the distinction is the whole point:
   * `measured, numerator: 0` asserts that this task served none of those
   * requests, which is a fact about traffic. A route behind a rollout flag that
   * is off cannot be served at all, which is a fact about the deployment — and
   * reading the second as the first is how a dashboard shows a healthy,
   * quiet-looking surface for a feature nobody has switched on.
   *
   * TWO of the four budgeted routes sit behind a flag — the authoring schema
   * (`CATALOG_AUTHORING_ENABLED`) and facets (`FACETS_ENABLED`), both defaulting
   * to false — and FOUR metrics take this reading on a stock deployment, because
   * three of them hang off the one authoring route. Two routes, two flags, four
   * metrics; `/categories` and `/search` are mounted unconditionally.
   */
  'surface_not_mounted',
  /**
   * The measurement exists; the THRESHOLD it would be compared against does not.
   *
   * Distinct from `not_instrumented`, and the distinction is the reason this
   * member exists rather than being folded into it: `not_instrumented` says a
   * column or a counter is owed, which sends a reader to write code. This says
   * the input is already published and what is missing is somebody deciding what
   * an acceptable value is — which sends them to write a policy. Reporting the
   * second as the first is how a decision nobody has taken looks like a task
   * nobody has finished.
   *
   * ONE metric takes it, `proposal_sla_breach_count`: the proposal queue's
   * depth, its per-state aging and its waiting-age percentiles are all measured
   * (`readProposalQueueAging`), and no review-time target is defined anywhere in
   * this repository. A number invented to fill it would harden the first time
   * somebody quoted it, so the seam is named instead.
   */
  'policy_target_undefined',
] as const;

export type CatalogUnmeasuredReason = (typeof CATALOG_UNMEASURED_REASONS)[number];

/**
 * Latency percentiles. Nearest-rank, so every figure reported was actually
 * observed rather than interpolated between two that were.
 *
 * `observations` is how many samples the percentiles were computed over, which
 * is NOT the number of requests served: percentiles come from a bounded
 * reservoir of the most recent samples while the request counts are exact. The
 * two are separate fields precisely so neither can be read as the other.
 */
export interface CatalogLatencySample {
  readonly observations: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/**
 * A reading of one metric.
 *
 * The `unmeasured` branch carries no quantity of any kind. That is the
 * enforcement, not the `reason` string: a caller cannot render it as a number
 * because there is no number on it.
 *
 * On the `measured` branch, `ratio`, `count`, `latency` and `ageSeconds` are
 * each present only for the matching `kind`, and `ratio` is additionally absent
 * when `denominator` is zero — the read ran and the population is empty, which
 * is a fact and not a percentage.
 */
export type CatalogMetricReading =
  | {
      readonly state: 'measured';
      readonly key: string;
      readonly kind: CatalogMetricKind;
      /**
       * ALWAYS present, whatever the kind, and it is what makes the `measured`
       * branch meaningful: a reading that carried no number at all would be an
       * `unmeasured` wearing the wrong discriminant.
       *
       * For `ratio` it is the numerator; for `count` it IS the count (there is
       * deliberately no second `count` field — two spellings of one quantity can
       * disagree); for `latency` it is how many observations back the
       * percentiles; for `age_seconds` it is how many rows the age was taken over.
       */
      readonly numerator: number;
      /** `ratio` only. Zero is legal, is a fact, and suppresses `ratio`. */
      readonly denominator?: number;
      /** `ratio` only, and present exactly when `denominator > 0`. */
      readonly ratio?: number;
      /** `latency` only, and present exactly when `numerator > 0`. */
      readonly latency?: CatalogLatencySample;
      /** `age_seconds` only, and present exactly when `numerator > 0`. */
      readonly ageSeconds?: number;
      /** Optional breakdown. Every dimension value is a closed-set key, never free text. */
      readonly by?: readonly CatalogMetricBucket[];
    }
  | {
      readonly state: 'unmeasured';
      readonly key: string;
      readonly kind: CatalogMetricKind;
      readonly reason: CatalogUnmeasuredReason;
      /** What would close it. Required — an unmeasured metric with no owner is an apology. */
      readonly seam: string;
    };

/**
 * One bucket of a broken-down metric.
 *
 * `key` is a closed-set value (a locale, a market, a source id, a state) and
 * never a label, a query, a merchant name or anything a person typed.
 */
export interface CatalogMetricBucket {
  readonly key: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly ratio?: number;
}

/* -------------------------------------------------------------------------- */
/* Integrity checks                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The periodic integrity checks (#367 W17), each a question a CHECK constraint
 * cannot answer because it spans rows or tables.
 *
 * These are DETECTIONS and nothing here repairs: the `payment_discrepancies`
 * posture. Every one of them can mean an operator did something deliberate —
 * a category suppressed mid-migration, a redirect staged ahead of a cutover —
 * and a sweep that "fixed" it would undo a decision.
 */
export const CATALOG_INTEGRITY_CHECK_KINDS = [
  /** A row points at a category, product type or attribute definition that is gone. */
  'orphaned_reference',
  /** A redirect whose target is missing, itself redirecting, or pointing at its own source. */
  'invalid_redirect',
  /** `ancestor_ids` disagrees with `parent_id`, or a node reaches itself. */
  'category_cycle',
  /** A published row pins a schema version that can no longer be retrieved. */
  'schema_version_unavailable',
  /** `ancestor_ids` is not the path `parent_id` describes. A silent wrong answer. */
  'ancestry_path_drift',
  /** A queue row has been claimed past its lease with no progress. */
  'stalled_queue_lease',
] as const;

export type CatalogIntegrityCheckKind = (typeof CATALOG_INTEGRITY_CHECK_KINDS)[number];

/**
 * The outcome of one integrity check.
 *
 * `population` is mandatory and is the vacuity floor: a check that scanned
 * nothing and a check that scanned everything and found a clean catalogue both
 * report `findings: 0`, and `population` is the only thing that tells them
 * apart. A `population` of zero with `scanned: true` is itself worth seeing.
 */
export interface CatalogIntegrityResult {
  readonly kind: CatalogIntegrityCheckKind;
  /** How many rows the check actually examined. The vacuity floor. */
  readonly population: number;
  readonly findings: number;
  /** Bounded sample of offending subject keys, for an operator to open. Never a person. */
  readonly sample: readonly string[];
  readonly checkedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Latency budgets (#367 Workstream 16)                                        */
/* -------------------------------------------------------------------------- */

/**
 * A latency budget for one catalog read surface.
 *
 * The budget is on **p95**, not on the mean: a mean hides the tail that is the
 * entire reason a budget exists. `route` is the Express route TEMPLATE, never a
 * concrete path — a budget keyed on `/categories/electronics` would be one
 * budget per category and would measure nothing.
 */
export interface CatalogLatencyBudget {
  readonly route: string;
  readonly method: string;
  readonly title: string;
  readonly p95BudgetMs: number;
  /** Why this number. A budget with no reasoning is a number somebody will raise. */
  readonly rationale: string;
}

/**
 * The catalog read surfaces #367 W16 names, with budgets.
 *
 * ## Every entry names a route that is actually MOUNTED, verified against the
 * router files
 *
 * The first draft of this list was written from W16's wording — "category tree,
 * authoring schema, autocomplete, search and facet APIs" — and three of its five
 * entries named nothing: the authoring schema is
 * `/catalog-authoring/schemas/:productTypeKey` and not `/catalog-authoring/schema`,
 * facets is a **POST**, and `/categories/autocomplete` does not exist at all.
 * Each of those made its metric permanently blind, and blind is invisible here:
 * `readCatalogLatencyReport` omits the verdict (which looks exactly like a cold
 * task), the metrics read `numerator: 0` (which looks exactly like a task that
 * served none), and `unobservedRouteReports` cannot see it because the middleware
 * resolves the template before calling the store. `contract-gates.test.ts`
 * asserts every entry here against the real mounted routers so the next wrong
 * template fails the build instead of reporting a healthy zero.
 *
 * There is deliberately **no autocomplete entry**. W1's "APIs for localized
 * category search/autocomplete" is an open checkbox; `GET
 * /catalog-authoring/categories` is a localized BROWSE (`parentId`, `roots`,
 * `locale`, `limit`) with no text parameter, so budgeting it as autocomplete
 * would put a UX floor on a different operation. The budget is owed by whoever
 * ships the route.
 *
 * ## The numbers are incident thresholds, not performance targets
 *
 * Deliberately generous: the point at which a surface has gone WRONG. A budget
 * set at the current p95 turns green into "unchanged" and fires on every ordinary
 * fluctuation, which is how a latency alert gets muted in week two.
 */
export const CATALOG_LATENCY_BUDGETS: readonly CatalogLatencyBudget[] = [
  {
    route: '/categories',
    method: 'GET',
    title: 'Category tree',
    p95BudgetMs: 150,
    rationale:
      'A single-statement read over the materialized ancestry path on a tree of thousands of '
      + 'nodes. Measured at 1.1-2.6 ms p50 by the ancestry benchmark, so anything approaching '
      + 'this is a plan change rather than load.',
  },
  {
    route: '/catalog-authoring/schemas/:productTypeKey',
    method: 'GET',
    title: 'Authoring schema composition',
    p95BudgetMs: 400,
    rationale:
      'Composes a category, a product-type version, its field groups and every referenced '
      + 'attribute definition plus localizations. The memo serves the repeat and the ETag serves '
      + 'a returning client; this budget is for the cold composition, which is what a merchant '
      + 'opening a new form pays.',
  },
  {
    route: '/search',
    method: 'GET',
    title: 'Canonical search',
    p95BudgetMs: 600,
    rationale:
      "#61 measured every canonical read in single-digit milliseconds at a million offers; the "
      + 'headroom here is #70\'s staged retrieval and the per-page offer hydration on top of it.',
  },
  {
    route: '/facets',
    method: 'POST',
    title: 'Facet generation',
    p95BudgetMs: 500,
    rationale:
      'A POST because the facet request carries a filter set too large for a query string — not '
      + 'a mutation. Several bucket aggregations over one category scope, measured at ten '
      + 'statements per scope by the facet sweep, which is why the budget sits well above the '
      + 'category tree.',
  },
];

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every catalog metric #367 W17 asks for, produced or not.
 *
 * A metric this epic names and this deployment cannot produce is present with a
 * `seam` rather than absent, because absence is indistinguishable from nobody
 * having thought of it. Seven of these carry a seam today; each names the exact
 * module or column that would close it, and `docs/catalog-observability.md`
 * §"What is not measured, and why" is the same list in prose.
 */
export const CATALOG_METRICS: readonly CatalogMetricDefinition[] = [
  /* ---- Authoring schema (W17 item 1) ------------------------------------- */
  {
    key: 'authoring_schema_fetch_latency',
    title: 'Authoring schema fetch latency',
    kind: 'latency',
    numerator:
      'Wall-clock milliseconds from route entry to response finish for '
      + 'GET /catalog-authoring/schemas/:productTypeKey, observed in this process.',
    denominator:
      'The most recent bounded reservoir of such requests this process served, including 304s '
      + 'and refusals. The reservoir size is reported as `observations` and is smaller than the '
      + 'exact request count beside it.',
    window: 'since_process_start',
    source: 'route_observations',
    freshnessSeconds: 0,
    attributionLimit:
      'Per ECS task and reset by every deploy, so it is a health signal and never a historical '
      + 'series. Percentiles cover the reservoir rather than every request, so a task that has '
      + 'served millions reports the tail of the recent few thousand. It also cannot separate '
      + 'composition cost from memo service — read it beside '
      + 'authoring_schema_client_cache_hit_rate, which says how many of these did no work.',
  },
  {
    key: 'authoring_schema_error_rate',
    title: 'Authoring schema error rate',
    kind: 'ratio',
    numerator: 'GET /catalog-authoring/schema responses with status >= 500.',
    denominator: 'All GET /catalog-authoring/schema responses this process served.',
    window: 'since_process_start',
    source: 'route_observations',
    freshnessSeconds: 0,
    attributionLimit:
      'Counts only 5xx. A composition REFUSAL (an unknown product type, a category outside a '
      + "version's scope) is a 4xx and a correct answer, so folding it in would make a merchant "
      + 'typing a bad category read as a server fault.',
  },
  {
    key: 'authoring_schema_client_cache_hit_rate',
    title: 'Authoring schema client cache hit rate',
    kind: 'ratio',
    numerator: 'GET /catalog-authoring/schema responses answered 304 against a matching ETag.',
    denominator: 'All GET /catalog-authoring/schema responses this process served.',
    window: 'since_process_start',
    source: 'route_observations',
    freshnessSeconds: 0,
    attributionLimit:
      'This is the CLIENT-visible hit rate — how often a caller already held the composition. '
      + 'It is not the server memo hit rate, which is a different number about a different '
      + 'cache; see authoring_schema_memo_hit_rate, which is unmeasured.',
  },
  {
    key: 'authoring_schema_memo_hit_rate',
    title: 'Authoring schema memo hit rate',
    kind: 'ratio',
    numerator: 'Compositions served from the in-process memo without re-reading Postgres.',
    denominator: 'All calls to composeAuthoringSchema.',
    window: 'since_process_start',
    source: 'route_observations',
    freshnessSeconds: 0,
    attributionLimit:
      'Would say whether the revision-keyed memo is earning its place. A 304 rate cannot '
      + 'substitute: a client with no ETag and a warm memo is a miss on one and a hit on the other.',
    unmeasured: {
      reason: 'not_instrumented',
      seam:
        'services/catalog-authoring/schema.service.ts holds the memo (`remember`/`memo.get`) and '
        + 'exposes no counter. Closing it is one exported stats function beside the memo, the '
        + '`analyticsSinkStats` shape, and one call in each of the two branches.',
    },
  },

  /* ---- Drafts (W17 item 2) ----------------------------------------------- */
  {
    key: 'draft_completion_rate',
    title: 'Draft completion rate',
    kind: 'ratio',
    numerator: "catalog_authoring_drafts rows with status = 'published'.",
    denominator: 'All catalog_authoring_drafts rows created in the window.',
    window: 'rolling_7d',
    source: 'catalog_authoring_drafts',
    freshnessSeconds: 300,
    attributionLimit:
      'A draft still open at the moment of reading is in the denominator and not the numerator, '
      + 'so a healthy week of in-progress work depresses this. Read it with draft_open_count.',
  },
  {
    key: 'draft_abandonment_rate',
    title: 'Draft abandonment rate',
    kind: 'ratio',
    numerator:
      "catalog_authoring_drafts rows with status = 'discarded', plus rows still 'open' whose "
      + 'expires_at has passed.',
    denominator: 'All catalog_authoring_drafts rows created in the window.',
    window: 'rolling_7d',
    source: 'catalog_authoring_drafts',
    freshnessSeconds: 300,
    attributionLimit:
      'Cannot distinguish a merchant who gave up from one who started a draft twice and '
      + 'discarded the duplicate. It says nothing about WHICH field stopped them — that is '
      + 'draft_validation_failure_rate, which is unmeasured.',
  },
  {
    key: 'draft_open_count',
    title: 'Open drafts',
    kind: 'count',
    numerator: "catalog_authoring_drafts rows with status = 'open' and expires_at in the future.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_authoring_drafts',
    freshnessSeconds: 300,
    attributionLimit: 'A gauge. It says nothing about how long any of them has been open.',
  },
  {
    key: 'draft_validation_failure_rate',
    title: 'Publication attempts refused by validation',
    kind: 'ratio',
    numerator: 'Publication attempts this process refused because the draft did not validate.',
    denominator:
      'Publication attempts this process made. An attempt is a call that reached '
      + "`validateDraftRow` from the PUBLISH path; `draft.service.ts`'s standalone validate is "
      + 'not one, or the rate would report every keystroke a form validated.',
    window: 'since_process_start',
    source: 'authoring_publication_attempts',
    freshnessSeconds: 0,
    attributionLimit:
      'PROCESS-LOCAL and RESET BY EVERY DEPLOY — several tasks each count their own traffic, '
      + 'and a deploy zeroes all of them. Read it as a rate, never as a total. It carries NO '
      + 'per-code breakdown, deliberately: one refusal can carry several findings with '
      + 'different codes, so codes do not PARTITION attempts and a `by` here would count one '
      + 'refusal in several buckets while claiming to sum to the denominator. '
      + 'draft_validation_failure_code_share answers "which codes" over the population where '
      + 'they do partition. It also says nothing about whether the author fixed it: a merchant '
      + 'who corrects a field and republishes is two attempts and one refusal.',
  },
  {
    key: 'draft_validation_failure_code_share',
    title: 'Validation findings by code',
    kind: 'ratio',
    numerator:
      'Findings of one AuthoringValidationCode on refused publication attempts, per bucket.',
    denominator:
      'All findings on refused publication attempts. FINDINGS and not attempts, which is the '
      + 'whole reason this is a second metric: a code partitions findings exactly, and an '
      + 'attempt it does not partition at all.',
    window: 'since_process_start',
    source: 'authoring_publication_attempts',
    freshnessSeconds: 0,
    attributionLimit:
      'A SHARE of findings, so it cannot be read as "how many drafts failed this way" — one '
      + 'draft missing four required fields contributes four. Bucketed by the closed '
      + 'AUTHORING_VALIDATION_CODES tuple and never by attribute key, whose cardinality grows '
      + 'with the registry; a per-attribute instrument is a different one with its own '
      + 'disclosure argument. Process-local and reset by every deploy.',
  },

  /* ---- Resolution mix (W17 item 3) --------------------------------------- */
  {
    key: 'direct_canonical_selection_rate',
    title: 'Direct canonical selection rate',
    kind: 'ratio',
    numerator: "native_listing_links rows with method = 'merchant_declared'.",
    denominator: 'All active native_listing_links rows.',
    window: 'instant',
    source: 'native_listing_links',
    freshnessSeconds: 300,
    attributionLimit:
      'A stock of links, not a flow of decisions: a link created a year ago counts the same as '
      + 'one created today, so this moves slowly and a sudden change is a big change.',
  },
  {
    key: 'automated_match_rate',
    title: 'Automated match rate',
    kind: 'ratio',
    numerator:
      'native_listing_links rows whose method is an automated one (the matcher stages and '
      + 'backfill), i.e. every method that is not merchant_declared or seller_declared.',
    denominator: 'All active native_listing_links rows.',
    window: 'instant',
    source: 'native_listing_links',
    freshnessSeconds: 300,
    attributionLimit:
      'Says nothing about whether a match was CORRECT. #58 routes a heuristic match to review '
      + 'precisely because nobody has agreed it; this counts it as matched.',
  },
  {
    key: 'unresolved_subject_count',
    title: 'Unresolved matching subjects',
    kind: 'count',
    numerator: 'match_queue rows not yet completed.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'match_queue',
    freshnessSeconds: 60,
    attributionLimit:
      'Queue DEPTH, which is not the same as lag: a deep queue draining fast is healthier than '
      + 'a shallow one that is stuck. Read it with unresolved_subject_oldest_age.',
  },
  {
    key: 'unresolved_subject_oldest_age',
    title: 'Oldest unresolved matching subject',
    kind: 'age_seconds',
    numerator: 'Seconds since the oldest incomplete match_queue row was enqueued.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'match_queue',
    freshnessSeconds: 60,
    attributionLimit:
      'The lag signal. It is null-shaped when the queue is empty, which reads as measured with '
      + 'zero population rather than as a healthy zero.',
  },
  {
    key: 'match_queue_dead_letter_count',
    title: 'Dead-lettered matching subjects',
    kind: 'count',
    numerator: "match_queue rows with status = 'dead_letter'.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'match_queue',
    freshnessSeconds: 60,
    attributionLimit:
      'The ONE dead-letter state anywhere in this chain, and it belongs to #58\'s match queue '
      + "rather than to any of #367's own tables — which is why "
      + 'backfill_dead_letter_count next to it is unmeasured rather than zero. A subject here has '
      + 'exhausted its retries and will never be matched without an operator; it does not '
      + 'disappear from the catalogue, so the listing is live and unattached.',
  },
  {
    key: 'proposal_creation_count',
    title: 'Proposals created',
    kind: 'count',
    numerator: 'catalog_proposals rows created in the window.',
    denominator: 'Not a ratio.',
    window: 'rolling_7d',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'A rise can mean the taxonomy is missing concepts OR that more merchants are authoring. '
      + 'It does not separate them; the completeness metrics are the other half.',
  },
  {
    key: 'proposal_backlog_count',
    title: 'Proposal backlog',
    kind: 'count',
    numerator: 'catalog_proposals rows in an undecided state.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'Counts rows awaiting a person. A deferred proposal with a future deferred_until is in '
      + 'here, so a planned deferral reads as backlog.',
  },
  {
    key: 'proposal_backlog_oldest_age',
    title: 'Oldest undecided proposal',
    kind: 'age_seconds',
    numerator: 'Seconds since the oldest undecided catalog_proposals row was submitted.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'The oldest, not the median, because a queue is judged by the thing that has waited '
      + 'longest — but it is the oldest of ALL open states, so a proposal parked on a merchant '
      + 'who never replied dominates it forever. proposal_awaiting_operator_oldest_age is the '
      + 'one that measures Mercaria\'s own responsiveness, and the full distribution is at '
      + 'GET /internal/catalog-metrics/proposal-queue.',
  },
  {
    key: 'proposal_backlog_awaiting_operator_count',
    title: 'Proposals nobody has looked at',
    kind: 'count',
    numerator: "catalog_proposals rows in state 'submitted'.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'The share of the backlog that is Mercaria\'s to answer. It says nothing about how long '
      + 'any of them has waited — read it with proposal_awaiting_operator_oldest_age — and a '
      + 'proposal an operator has already opened and not decided is still in here, because '
      + 'reading is not a state.',
  },
  {
    key: 'proposal_backlog_awaiting_submitter_count',
    title: 'Proposals waiting on a merchant',
    kind: 'count',
    numerator: "catalog_proposals rows in state 'needs_information'.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'Open, and NOT Mercaria\'s to answer: an operator asked and is waiting. It is separated '
      + 'from the backlog for exactly that reason, and it is not a health signal on its own — a '
      + 'large number can mean the form asks for too little or that reviewers ask for too much, '
      + 'and this cannot tell those apart.',
  },
  {
    key: 'proposal_backlog_deferred_count',
    title: 'Deferred proposals',
    kind: 'count',
    numerator: "catalog_proposals rows in state 'deferred'.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'Every deferral, whether its date has passed or not. A deferral whose date has passed is '
      + 'back in the queue and is genuinely waiting; the split is deferredAheadCount on '
      + 'GET /internal/catalog-metrics/proposal-queue, which this count deliberately does not '
      + 'duplicate.',
  },
  {
    key: 'proposal_awaiting_operator_oldest_age',
    title: 'Oldest proposal nobody has looked at',
    kind: 'age_seconds',
    numerator: "Seconds since the oldest 'submitted' catalog_proposals row was created.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'Mercaria\'s own worst response time, with the two waits that are not Mercaria\'s '
      + '(needs_information, deferred) excluded. It is a MAXIMUM and says nothing about the '
      + 'shape behind it: the age bands and percentiles at '
      + 'GET /internal/catalog-metrics/proposal-queue are that, and the percentiles refuse to '
      + 'answer below a population of twenty.',
  },
  {
    key: 'proposal_decision_count',
    title: 'Proposals decided',
    kind: 'count',
    numerator: 'catalog_proposals rows whose decided_at falls in the window.',
    denominator: 'Not a ratio.',
    window: 'rolling_7d',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'The service rate to read against proposal_creation_count\'s arrival rate — a backlog is '
      + 'a stock and neither number alone says whether it is growing. It counts OPERATOR '
      + 'decisions only: a withdrawal is the submitter closing their own request and stamps no '
      + 'decided_at, so it is in neither this nor the backlog it left.',
  },
  {
    key: 'proposal_sla_breach_count',
    title: 'Proposals past their review target',
    kind: 'count',
    numerator: 'Open catalog_proposals rows older than the review-time target for their state.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_proposals',
    freshnessSeconds: 300,
    attributionLimit:
      'Would count rows past a target, which says nothing about how far past — the age bands '
      + 'and the percentiles are that. It is unmeasured because no target exists, not because '
      + 'the ages do not.',
    unmeasured: {
      reason: 'policy_target_undefined',
      seam:
        'No review-time target is defined for a catalogue proposal anywhere in this repository. '
        + 'The input is already published — depth and oldest age per open state, a five-band '
        + 'waiting-age distribution and nearest-rank percentiles, all from '
        + 'readProposalQueueAging — so what is owed is a decision on #367 Workstream 6 naming a '
        + 'target per open state, plus the second member on CatalogProposalSlaVisibility that '
        + 'carries it. Reporting zero here today would mean "nothing has breached a target that '
        + 'does not exist", which is true and reads as healthy.',
    },
  },

  /* ---- Completeness (W17 item 4) ----------------------------------------- */
  {
    key: 'taxonomy_completeness',
    title: 'Taxonomy completeness',
    kind: 'ratio',
    numerator: 'Published categories carrying the facts a category needs to be usable.',
    denominator: 'All published categories.',
    window: 'instant',
    source: 'catalog_governance_quality',
    freshnessSeconds: 900,
    attributionLimit:
      "Read through catalog-governance's readCatalogQuality, which is the one authority; this "
      + 'domain re-derives nothing. It measures presence, never correctness.',
  },
  {
    key: 'product_type_completeness',
    title: 'Product-type completeness',
    kind: 'ratio',
    numerator: 'Published product-type versions carrying at least one field group and field.',
    denominator: 'All published product-type versions.',
    window: 'instant',
    source: 'catalog_governance_quality',
    freshnessSeconds: 900,
    attributionLimit:
      'A version with fields is not a version that models its category well. This is a floor, '
      + 'not a quality score.',
  },
  {
    key: 'attribute_localized_label_completeness',
    title: 'Attribute localized-label completeness',
    kind: 'ratio',
    numerator: 'Active attribute definitions carrying at least one attribute_labels row.',
    denominator: 'All active attribute definitions.',
    window: 'instant',
    source: 'product_type_definitions',
    freshnessSeconds: 900,
    attributionLimit:
      'This is LOCALIZED label coverage and deliberately not "does the attribute have a label": '
      + 'attribute_definitions.label is NOT NULL, so a metric counting label presence would be '
      + 'vacuously 100% and could never fall. It says nothing about whether the localized labels '
      + 'that exist cover the locales this deployment serves — one label in one locale satisfies '
      + 'it — and nothing about whether any of them is correct.',
  },

  /* ---- Translation (W17 item 5) ------------------------------------------ */
  {
    key: 'translation_coverage',
    title: 'Translation coverage by locale',
    kind: 'ratio',
    numerator: "Localization rows with status 'reviewed' or 'approved'.",
    denominator: 'Eligible entity-locale pairs across categories, product types and values.',
    window: 'instant',
    source: 'catalog_localization_completeness',
    freshnessSeconds: 900,
    attributionLimit:
      'machine_translated is deliberately NOT in the numerator — counting it is how a locale '
      + "reports 98% while a shopper reads a machine's guess at a legal category name. "
      + 'The denominator is those THREE domains and not every localizable one: the desk also '
      + 'measures product-type fields, canonical products, families and attribute definitions, '
      + 'and widening this population would make the metric\'s own history incomparable, with '
      + 'nothing in a stored series saying so (#565).',
  },
  {
    key: 'translation_machine_share',
    title: 'Machine-translated share',
    kind: 'ratio',
    numerator: "Localization rows with status = 'machine_translated'.",
    denominator: 'All localization rows that exist for the locale.',
    window: 'instant',
    source: 'category_localizations',
    freshnessSeconds: 900,
    attributionLimit:
      'Of rows that EXIST. A locale with nothing translated has a machine share of zero and is '
      + 'the worst case, not the best — read it against translation_coverage.',
  },
  {
    key: 'translation_stale_count',
    title: 'Stale translations',
    kind: 'count',
    numerator: "Localization rows with status = 'stale'.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'category_localizations',
    freshnessSeconds: 900,
    attributionLimit:
      'Stale means the source moved after the translation was approved. It says nothing about '
      + 'how wrong the translation now is.',
  },
  {
    key: 'translation_missing_count',
    title: 'Missing translations',
    kind: 'count',
    numerator:
      'Eligible entity-locale pairs with no localization row at all, across categories, '
      + 'product types and values.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_localization_completeness',
    freshnessSeconds: 900,
    attributionLimit:
      "ABSENCE of a row, and NOT a row whose status is 'missing'. The two are different facts "
      + 'and are never summed: an absent pair is one nobody has looked at, and a `missing` row '
      + 'is one somebody OPENED to say a translation is owed. A desk that has triaged its whole '
      + 'backlog and one that has triaged none of it would otherwise report the same number '
      + "with completely different next actions. The triage backlog is the governance queue's "
      + '`missing_translation` depth, which is where a translator acts on it (#565).',
  },
  {
    key: 'translation_fallback_use_rate',
    title: 'Localized reads answered by a fallback',
    kind: 'ratio',
    numerator:
      'Field resolutions this process answered from a LANGUAGE truncation or the BASE locale '
      + 'rather than the locale asked for.',
    denominator:
      'Field resolutions this process performed, including the ones that resolved EXACTLY and '
      + 'the ones that could not be answered at all. Traffic, not catalogue size — so the rate '
      + 'falls when translation coverage rises rather than tracking how much catalogue exists.',
    window: 'since_process_start',
    source: 'localization_resolutions',
    freshnessSeconds: 0,
    attributionLimit:
      'PROCESS-LOCAL and RESET BY EVERY DEPLOY. It counts FIELD resolutions, not requests: one '
      + 'category page is many, so a page with one untranslated description is not "one '
      + 'fallback read". `unavailable` is in the denominator and in no fallback bucket — a '
      + 'field nobody could answer is not a fallback, and folding it in would make the rate '
      + 'rise when text is MISSING rather than when it is merely untranslated. '
      + 'translation_missing_count is the metric for that.',
  },

  /* ---- Search (W17 item 6) ----------------------------------------------- */
  {
    key: 'search_zero_result_rate_by_market',
    title: 'Search zero-result rate by market',
    kind: 'ratio',
    numerator: 'analytics_search_queries rows with result_count = 0, bucketed by market.',
    denominator: 'All analytics_search_queries rows in the window with a market.',
    window: 'rolling_24h',
    source: 'analytics_search_queries',
    freshnessSeconds: 900,
    attributionLimit:
      'Rows with a NULL market are excluded from both halves rather than pooled into one bucket, '
      + 'so this is a rate within known markets and not a rate over all search. Analytics '
      + 'collection is off by default, so an empty population means "not collecting", not "no '
      + 'searches".',
  },
  {
    key: 'search_zero_result_rate_by_locale',
    title: 'Search zero-result rate by locale',
    kind: 'ratio',
    numerator: 'analytics_search_queries rows with result_count = 0, bucketed by locale.',
    denominator: 'All analytics_search_queries rows in the window.',
    window: 'rolling_24h',
    source: 'analytics_search_queries',
    freshnessSeconds: 900,
    attributionLimit:
      'A market is not a locale: one market serves several languages, and a zero-result rate '
      + 'that is fine in one and terrible in another is exactly what the market split hides.',
    unmeasured: {
      reason: 'dimension_absent_from_source',
      seam:
        'analytics_search_queries has market and no locale column (#77 owns the table). Closing it '
        + 'is one nullable text column plus the emit site in search-instrumentation.ts.',
    },
  },

  /* ---- Facets (W17 item 7) ----------------------------------------------- */
  {
    key: 'facet_generation_latency',
    title: 'Facet generation latency',
    kind: 'latency',
    numerator: 'Wall-clock milliseconds from route entry to response finish for POST /facets.',
    denominator:
      'The most recent bounded reservoir of such requests this process served; `observations` '
      + 'reports its size.',
    window: 'since_process_start',
    source: 'route_observations',
    freshnessSeconds: 0,
    attributionLimit:
      'Per task, reset by every deploy, and percentiles cover the reservoir rather than every '
      + 'request. It measures the whole request, so a slow facet plan and a slow serializer are '
      + 'one number.',
  },
  {
    key: 'facet_scope_empty_rate',
    title: 'Category scopes generating no facets',
    kind: 'ratio',
    numerator: 'Sampled published, selectable categories for which facet planning yields no facet.',
    denominator: 'The sampled categories.',
    window: 'instant',
    source: 'facet_scope_sweep',
    freshnessSeconds: 3600,
    attributionLimit:
      'A property of the CATALOGUE, not of traffic: it says which categories would render a bare '
      + 'filter rail if somebody visited them, and nothing about whether anybody does. It is '
      + 'sampled, so it is an estimate with a stated population.',
  },
  {
    key: 'facet_usage_rate',
    title: 'Facet usage rate',
    kind: 'ratio',
    numerator: 'Search sessions in which a shopper applied at least one facet.',
    denominator: 'Search sessions that were shown facets.',
    window: 'rolling_7d',
    source: 'analytics_search_queries',
    freshnessSeconds: 900,
    attributionLimit:
      'Would say whether generated facets are worth generating. Distinct from '
      + 'facet_scope_empty_rate, which says whether they exist.',
    unmeasured: {
      reason: 'client_signal_absent',
      seam:
        '#77 defines no facet event and the storefront has no analytics client (#111 owns it). '
        + 'Closing it is a facet_applied client event type plus its emitter.',
    },
  },

  /* ---- External mappings (W17 item 8) ------------------------------------ */
  {
    key: 'external_mapping_coverage',
    title: 'External mapping coverage by source',
    kind: 'ratio',
    numerator: 'Observed external tokens resolved to a live approved mapping, by source.',
    denominator: 'All observed external tokens for that source.',
    window: 'instant',
    source: 'catalog_external_token_observations',
    freshnessSeconds: 900,
    attributionLimit:
      'Counts DISTINCT tokens, not occurrences, so one unmapped token seen a million times '
      + 'counts once. That is deliberate — coverage is about the vocabulary, and the occurrence '
      + 'count is on the observation row for whoever prioritises.',
  },
  {
    key: 'external_mapping_ambiguity',
    title: 'External mapping ambiguity by source',
    kind: 'ratio',
    numerator: 'Observed tokens whose unresolved reason is an ambiguity rather than an absence.',
    denominator: 'All unresolved observed tokens for that source.',
    window: 'instant',
    source: 'catalog_external_token_observations',
    freshnessSeconds: 900,
    attributionLimit:
      'Ambiguity and absence need opposite work — one is a decision, the other is a mapping — '
      + 'so the denominator is unresolved tokens and not all tokens.',
  },
  {
    key: 'external_mapping_review_backlog',
    title: 'Open external mapping reviews',
    kind: 'count',
    numerator: "catalog_external_mapping_reviews rows in state 'open'.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_external_mappings',
    freshnessSeconds: 300,
    attributionLimit: 'Rows, not sources. One source can hold the whole backlog.',
  },

  /* ---- Backfill and reindex (W17 item 9) --------------------------------- */
  {
    key: 'backfill_progress',
    title: 'Backfill progress',
    kind: 'ratio',
    numerator: 'catalog_backfill_runs rows in a terminal successful state.',
    denominator: 'All catalog_backfill_runs rows.',
    window: 'instant',
    source: 'catalog_backfill_runs',
    freshnessSeconds: 300,
    attributionLimit:
      'Runs, not records. A completed run over a cohort of one is a completed run; the record '
      + 'tally is the population half and is reported beside it.',
  },
  {
    key: 'backfill_retry_count',
    title: 'Backfill record retries',
    kind: 'count',
    numerator: 'catalog_backfill_records rows with attempts > 1.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_backfill_records',
    freshnessSeconds: 300,
    attributionLimit:
      'A record retried and then succeeded is counted the same as one retried and still failing. '
      + 'The outcome column separates them and is reported as a breakdown.',
  },
  {
    key: 'backfill_failed_run_count',
    title: 'Failed backfill runs',
    kind: 'count',
    numerator: "catalog_backfill_runs rows with status = 'failed'.",
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_backfill_runs',
    freshnessSeconds: 300,
    attributionLimit:
      'A failed run keeps its cursor and is resumable, so this is work outstanding rather than '
      + 'work lost.',
  },
  {
    key: 'backfill_dead_letter_count',
    title: 'Backfill dead letters',
    kind: 'count',
    numerator: 'Queue rows abandoned after exhausting their retries.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'catalog_backfill_runs',
    freshnessSeconds: 300,
    attributionLimit:
      'Would separate "still retrying" from "given up". Reporting this as zero would put a '
      + 'permanently green tile on a dashboard for a condition that cannot occur.',
    unmeasured: {
      reason: 'no_dead_letter_state',
      seam:
        "None of #367's own queues has a dead-letter state: catalog_backfill_runs, "
        + 'catalog_external_mapping_runs and catalog_external_token_observations record attempts '
        + 'and last_error only, so a run that has given up is indistinguishable from one still '
        + 'retrying. #58\'s match_queue DOES have one and is measured as '
        + 'match_queue_dead_letter_count — which is why this is unmeasured rather than zero: the '
        + 'concept exists one domain over, so a zero here would read as "none" instead of "not a '
        + 'state these tables have". Closing it is a terminal state on those three tables, or the '
        + 'explicit decision that their retries are unbounded — recorded either way.',
    },
  },
  {
    key: 'reindex_pending_count',
    title: 'Pending reindex requests',
    kind: 'count',
    numerator: 'attribute_reindex_requests rows with no processed_at.',
    denominator: 'Not a ratio.',
    window: 'instant',
    source: 'attribute_reindex_requests',
    freshnessSeconds: 300,
    attributionLimit:
      'This number only grows. The queue has enqueuers, a deterministic id and a lease-shaped '
      + 'schema, and NO consumer — nothing writes processed_at anywhere in the repository — so a '
      + 'rising count is the expected reading and not an incident. See '
      + 'reindex_throughput, which is unmeasured for the same reason.',
  },
  {
    key: 'reindex_throughput',
    title: 'Reindex throughput',
    kind: 'count',
    numerator: 'attribute_reindex_requests rows processed in the window.',
    denominator: 'Not a ratio.',
    window: 'rolling_24h',
    source: 'attribute_reindex_requests',
    freshnessSeconds: 300,
    attributionLimit:
      'Would be the indexing-lag signal W17 asks for. Until a consumer exists, a throughput of '
      + 'zero would be indistinguishable from a stalled one.',
    unmeasured: {
      reason: 'no_consumer_registered',
      seam:
        'attribute_reindex_requests has no consumer: listPendingReindexRequests has exactly one '
        + 'caller and it is a read-only operator listing, and processed_at is never written. '
        + '#61 declined to build the drain because the refresh semantics belong to a projection '
        + 'nobody has adopted. Closing it is that consumer.',
    },
  },

  /* ---- Typed variant axes on the catalogue read (#367 line 324) ----------- */
  {
    key: 'variant_axis_typed_coverage',
    title: 'Typed variant axis coverage',
    kind: 'ratio',
    numerator:
      'Listings hydrated while VARIANT_AXIS_READS was shadow or on that DECLARED at least one '
      + 'native_listing_variant_axes row.',
    denominator: 'All listings hydrated while that lever was shadow or on.',
    window: 'since_process_start',
    source: 'variant_axis_shadow',
    freshnessSeconds: 0,
    attributionLimit:
      'This is the migration backlog weighted by TRAFFIC, not by catalogue size: a listing '
      + 'nobody views is never counted. That is deliberate — it answers "how much of what '
      + 'people actually read is typed" — and it is why it is not a substitute for counting '
      + 'listing_options rows. Zero denominator means the lever is off, not that nobody '
      + 'browsed.',
  },
  {
    key: 'variant_axis_shadow_divergence',
    title: 'Typed vs legacy option divergence',
    kind: 'ratio',
    numerator:
      'Hydrated listings whose typed axes and legacy option values rendered DIFFERENT ordered '
      + 'value sequences for some variant.',
    denominator:
      'Hydrated listings where BOTH representations carried something — agreed plus diverged. A '
      + 'listing with no typed axes is not a disagreement and is excluded, or the rate would '
      + 'track the backlog instead of the drift.',
    window: 'since_process_start',
    source: 'variant_axis_shadow',
    freshnessSeconds: 0,
    attributionLimit:
      'Compares VALUES only. An axis NAME differing is ADR 0007 D6 working — one definition '
      + 'behind Color, Colour and Tono — so counting it would make every backfilled listing '
      + 'permanently diverged and hide the drift this exists to find. Non-zero means a write '
      + 'path moved product_variant_option_values without moving the typed axis (#905), which '
      + 'is what VARIANT_AXIS_READS=on would then serve.',
  },
];

/** Derived from the registry, never written a second time. */
export const CATALOG_METRIC_KEYS: readonly string[] = CATALOG_METRICS.map((metric) => metric.key);

/* -------------------------------------------------------------------------- */
/* The read surface's payload                                                  */
/* -------------------------------------------------------------------------- */

/** What `GET /internal/catalog-metrics` answers. */
export interface CatalogMetricsReport {
  readonly collectedAt: string;
  readonly readings: readonly CatalogMetricReading[];
  /** Every metric carrying a seam, so a dashboard can render the gap as a gap. */
  readonly awaitingSeams: readonly { readonly key: string; readonly seam: string }[];
  /**
   * Process-local counters that must stay ZERO. The `ledgerImbalanceAttempts`
   * precedent: a number nobody expects to be non-zero, put where somebody sees it.
   */
  readonly mustStayZero: Readonly<Record<string, number>>;
}

/** What `GET /internal/catalog-metrics/integrity` answers. */
export interface CatalogIntegrityReport {
  readonly checkedAt: string;
  readonly results: readonly CatalogIntegrityResult[];
  /** True when every check in the closed tuple ran. A partial sweep is not a clean one. */
  readonly complete: boolean;
}

/** What `GET /internal/catalog-metrics/latency` answers. */
export interface CatalogLatencyReport {
  readonly collectedAt: string;
  readonly budgets: readonly {
    readonly budget: CatalogLatencyBudget;
    /** Absent when this process has served no such request — never a zero. */
    readonly observed?: CatalogLatencySample;
    /** Absent for the same reason. A budget with no observation is not "within budget". */
    readonly withinBudget?: boolean;
  }[];
}
