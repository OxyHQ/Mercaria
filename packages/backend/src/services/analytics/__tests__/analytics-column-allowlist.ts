/**
 * The analytics column ALLOW-LIST, its deny-list, and the pure audit both feed
 * (#77).
 *
 * `db/schema/analytics.ts` states the domain's central property in one
 * sentence: **the whole domain is an allow-list of typed columns, and the
 * columns that are ABSENT are the enforcement.** Until this module existed the
 * gate behind that sentence was a DENY-LIST — one regex naming eighteen tokens
 * somebody had thought of, admitting everything else. `shipping_address`,
 * `full_name`, `latitude` and `subject_hash` would every one have passed, and
 * `hash` is named in the schema's own docblock as a thing that must be
 * impossible. Its mutation self-test proved only that the pattern matched the
 * names the pattern already listed, which is a check that cannot fail on the
 * thing it exists for.
 *
 * So the shape is inverted. Every column of every table in the analytics schema
 * is enumerated here with a REASON, and **anything not enumerated fails the
 * build until somebody decides it is allowed.**
 * `services/curation/merge-plan.ts` is the precedent — "a new table referencing
 * a mergeable entity fails the build until somebody decides what a merge does
 * with it" — including its posture on silence: a decision recorded WITH a
 * reason is what the census accepts, and saying nothing is not.
 *
 * ## Two layers, and they fail differently
 *
 * The ALLOW-LIST catches the column nobody anticipated: a name no pattern was
 * ever going to carry, arriving in a diff whose author was thinking about
 * something else.
 *
 * The DENY-LIST catches the column somebody appended to the allow-list without
 * thinking, under a name that looks like it belongs. An allow-list is only as
 * good as the judgement applied at the moment a line is added to it, and the
 * moment a line is added to it is exactly when judgement is scarce — so the
 * deny-list runs over the allow-list's OWN entries as well as over the real
 * schema, and `buyer_email` cannot be admitted by being written down.
 *
 * Neither subsumes the other and both are cheap.
 *
 * ## Names are SQL identifiers, and that is not cosmetic
 *
 * `column.name` is the TypeScript PROPERTY name — `@oxyhq/db` owns the casing
 * authority (`DATABASE_CASING`) and drizzle converts at query time — so the
 * previous gate was matching `/ip_address|user_agent|order_note/` against
 * strings that read `ipAddress`, `userAgent` and `orderNote`. Three of its
 * eighteen tokens could never fire, and its self-test could not show it because
 * the self-test fed the pattern snake_case literals the scan never sees.
 * Everything here is `sqlColumnName`, which is what the database actually has.
 *
 * ## Matching is by SEGMENT, never by substring
 *
 * A prohibition names one or more adjacent underscore-separated segments.
 * `latency_ms` is not a location because `latency` is not `lat`; `oxy_user_id`
 * survives a prohibition on `user_agent` because that one names two adjacent
 * segments. A substring pattern has to be either too loose (banning `latency`
 * to ban `lat`) or too tight (a `\b` that matches nothing inside a snake_case
 * identifier, since `_` is a word character).
 */

/** One reason, and the columns it covers. */
export interface AnalyticsColumnGroup {
  /** Why these columns may exist in a domain that stores no identity. */
  readonly reason: string;
  /** SQL identifiers, as `sqlColumnName` renders them. */
  readonly columns: readonly string[];
}

/** Every column one analytics table may carry. */
export interface AnalyticsTableAllowance {
  readonly table: string;
  readonly groups: readonly AnalyticsColumnGroup[];
}

/** What the drizzle traversal hands the auditor. */
export interface AnalyticsTableColumns {
  readonly table: string;
  readonly columns: readonly string[];
}

/** A prohibition, stated as a sequence of adjacent segments. */
export interface AnalyticsColumnProhibition {
  /** Adjacent underscore-separated segments, in order. */
  readonly segments: readonly string[];
  /** What it is a prohibition ON — the message an offender is reported with. */
  readonly prohibition: string;
}

/** A column admitted despite matching a prohibition, with the reason it is. */
export interface AnalyticsColumnExemption {
  /** Qualified `table.column`. Never a pattern: an exemption names ONE column. */
  readonly column: string;
  readonly reason: string;
}

export interface AnalyticsColumnAudit {
  /** A real column no group lists. The inversion's whole point. */
  readonly unlisted: readonly string[];
  /** A listed column no table has — the list rotting into a stale permission. */
  readonly missing: readonly string[];
  /** A name a prohibition refuses, from either side. */
  readonly forbidden: readonly { column: string; prohibition: string }[];
  /** A real table with no allowance at all. */
  readonly unlistedTables: readonly string[];
  /** An allowance for a table that no longer exists. */
  readonly missingTables: readonly string[];
}

/* -------------------------------------------------------------------------- */

/**
 * Every column of every table in `db/schema/analytics.ts`.
 *
 * Grouped rather than annotated one by one: 128 columns each carrying its own
 * sentence would be 128 sentences nobody reads, and the question a reviewer
 * actually has to answer is what KIND of fact a column is. A group whose reason
 * does not cover a column is the signal to open a new group, not to widen the
 * sentence.
 */
export const ANALYTICS_COLUMN_ALLOWLIST: readonly AnalyticsTableAllowance[] = [
  {
    table: 'analytics_events',
    groups: [
      {
        reason:
          "Mercaria's own row bookkeeping. `expires_at` is the retention sweep's deadline (`db/expiryTargets.ts`), which is why DELETE is permitted on this table where the ledger refuses it.",
        columns: ['id', 'created_at', 'expires_at'],
      },
      {
        reason:
          'The versioned envelope and its retention class. `event_type` is CHECKed against the closed tuple, so an event nothing defines cannot be stored.',
        columns: ['envelope_version', 'event_type', 'event_class'],
      },
      {
        reason:
          'Envelope field 2. `received_at` is the SERVER clock and is never client-supplied, so a client cannot backdate itself out of a retention window.',
        columns: ['occurred_at', 'received_at'],
      },
      {
        reason:
          'Envelope fields 3, 4, 11 and 12 — the actor, and neither column is a person. `oxy_user_id` only for a verified account whose consent is not denied; `pseudonymous_session_id` is a truncated one-way hash under a salt that rotates and is then deleted. A CHECK holds that at most one is set.',
        columns: [
          'oxy_user_id',
          'pseudonymous_session_id',
          'pseudonym_epoch',
          'actor_kind',
          'consent_state',
          'collection_mode',
          'buyer_origin',
        ],
      },
      {
        reason:
          'Envelope fields 6 and 10 — the surface and the traffic class, all shape-CHECKed closed sets or bounded strings, so none can carry prose. `market` is a country, never a coordinate.',
        columns: ['client_surface', 'app_version', 'market', 'traffic_class'],
      },
      {
        reason:
          'Envelope field 7 — entity IDS and nothing derived from them. A name, a title or a label would be a copy of a fact another domain owns; an id is a join.',
        columns: [
          'listing_id',
          'product_variant_id',
          'canonical_product_id',
          'canonical_variant_id',
          'offer_id',
          'merchant_id',
          'storefront_id',
          'category_id',
          'store_id',
          'query_event_id',
        ],
      },
      {
        reason:
          'Envelope field 5 — the commerce correlation, RESTRICTED by CHECK to the event types at or after checkout begins, so a `product_page_view` carrying a checkout group is refused by the database.',
        columns: ['checkout_group_id', 'order_id'],
      },
      {
        reason:
          'Envelope field 8 — which versioned policy produced what was measured. #74 stamps the ranking one on every `offer_impression`.',
        columns: ['search_policy_version', 'ranking_policy_version'],
      },
      {
        reason:
          'Envelope field 9 — the experiment assignment, which travels whole or not at all (a CHECK). The bucket is keyed on a unit, never on a person.',
        columns: ['experiment_key', 'experiment_version', 'experiment_variant'],
      },
      {
        reason:
          'The five typed MEASURES. A sixth is a schema change with a migration, and that friction is the feature — it is the alternative to a property bag.',
        columns: ['position', 'result_count', 'latency_ms', 'quantity', 'item_count'],
      },
      {
        reason:
          'Bounded code vocabularies, CHECKed against their tuples. `reason_code` is why a gate refused; `payment_method_category` is a coarse class and never an instrument, a fingerprint or a token.',
        columns: ['reason_code', 'payment_method_category'],
      },
    ],
  },
  {
    table: 'analytics_search_queries',
    groups: [
      {
        reason:
          'Row bookkeeping plus the SECOND deadline: `text_expires_at` nulls the redacted text in place at 30 days while the normalized tokens survive, a redaction the shared expiry sweep cannot perform.',
        columns: ['id', 'created_at', 'expires_at', 'text_expires_at'],
      },
      {
        reason:
          "#77's own correlation handle, which authorizes nothing and is what makes the query record joinable to the event without an actor column existing on this table.",
        columns: ['query_event_id'],
      },
      {
        reason:
          'The query itself, and only ever in redacted form. Tokens are derived FROM the redacted text and never from the original; `redaction_kinds` records which rules fired, so a rule regression is visible without keeping what it removed.',
        columns: ['redacted_text', 'redaction_kinds', 'normalized_tokens'],
      },
      {
        reason: 'The typed measures a search produces.',
        columns: ['result_count', 'duplicate_result_count', 'latency_ms'],
      },
      {
        reason:
          'Coarse reporting dimensions. `analytics_search_queries` has NO actor column of any kind, which is privacy rule 3 as a fact rather than as a rule about when to populate one.',
        columns: ['market', 'category_id', 'traffic_class'],
      },
      {
        reason: 'Which versioned policies answered the query.',
        columns: ['search_policy_version', 'ranking_policy_version'],
      },
    ],
  },
  {
    table: 'analytics_query_aggregates',
    groups: [
      {
        reason:
          'Row bookkeeping and the retention deadline. The aggregate outlives the raw queries it was computed from, which is what lets those be deleted on their own clock.',
        columns: ['id', 'created_at', 'updated_at', 'expires_at'],
      },
      {
        reason:
          'The aggregate key. A phrase plus a market plus a day, and `readTopQueries` applies the 25-occurrence floor on the row AND after the range SUM, for operators and merchants alike.',
        columns: ['normalized_query', 'market', 'bucket_date'],
      },
      {
        reason: 'The counts the floor is applied to.',
        columns: ['occurrences', 'zero_result_occurrences', 'click_occurrences'],
      },
    ],
  },
  {
    table: 'analytics_rollups',
    groups: [
      {
        reason:
          'Row bookkeeping. `computed_at` is when the bucket was derived, which is what a freshness claim on a dashboard is read from.',
        columns: ['id', 'created_at', 'updated_at', 'expires_at', 'computed_at'],
      },
      {
        reason:
          'The metric identity. `metric_key` CHECKs against the `ANALYTICS_METRICS` tuple, so a number whose definition is unstated cannot be stored.',
        columns: ['metric_key', 'source', 'bucket_date'],
      },
      {
        reason:
          'The two halves of the figure, stored separately so a rate is never persisted as a number nobody can re-derive.',
        columns: ['numerator', 'denominator'],
      },
      {
        reason:
          'The dimensions a bucket may be cut by — all coarse, all closed sets or entity ids. Rollups are computed BEFORE the raw sweep runs, so deleting events costs a report nothing.',
        columns: [
          'actor_kind',
          'buyer_origin',
          'client_surface',
          'market',
          'merchant_id',
          'store_id',
        ],
      },
    ],
  },
  {
    table: 'analytics_experiments',
    groups: [
      {
        reason: 'Row bookkeeping. This table is not swept — a definition outlives its data.',
        columns: ['id', 'created_at', 'updated_at'],
      },
      {
        reason:
          'The experiment identity and its lifecycle. An active version is frozen by trigger, because editing the salt re-buckets every unit mid-flight and nothing in the data would say so.',
        columns: [
          'experiment_key',
          'version',
          'status',
          'activated_at',
          'stopped_at',
          'stop_reason',
        ],
      },
      {
        reason:
          'What is being tried. `treatment_kind` is CHECKed against the permitted tuple, and the forbidden list is scanned against it so a plausible coercive addition fails the build.',
        columns: ['hypothesis', 'treatment_kind'],
      },
      {
        reason:
          'The allocation. The bucket preimage is a UNIT plus a salt — the unit is an Oxy id or a rotating pseudonym, and a unit outside the allocation gets `undefined` rather than `control`.',
        columns: ['assignment_unit', 'assignment_salt', 'traffic_allocation_bps', 'variants'],
      },
      {
        reason:
          'What the experiment is judged on. `guardrail_metric_keys` may not be empty, so trust guardrails are a constraint rather than an intention.',
        columns: ['primary_metric_key', 'guardrail_metric_keys', 'stop_conditions'],
      },
      {
        reason:
          "#74's seam: an arm may name a ranking policy version, which is the only way a catalogue-side policy and a person-side experiment are joined.",
        columns: ['ranking_policy_version'],
      },
    ],
  },
  {
    table: 'analytics_experiment_exposures',
    groups: [
      {
        reason:
          'Row bookkeeping and the retention deadline. An exposure is swept on its own class, so a comparison survives the raw events it was drawn from.',
        columns: ['id', 'created_at', 'expires_at'],
      },
      {
        reason:
          'Which arm of which version this unit saw. The version is part of the key because an active version is frozen, so an arm cannot be reinterpreted after the fact.',
        columns: ['experiment_key', 'experiment_version', 'variant'],
      },
      {
        reason:
          'The assignment unit, which is an Oxy id or a rotating pseudonym and never a device, a cookie or an address. `assignment_unit` names which, so the ref cannot be read as the wrong kind.',
        columns: ['assignment_unit', 'assignment_unit_ref'],
      },
      {
        reason:
          'First exposure only. A per-view row would make the table a session trail; one row per unit per version is what a comparison needs.',
        columns: ['first_exposed_at'],
      },
    ],
  },
  {
    table: 'analytics_pseudonym_salts',
    groups: [
      {
        reason: 'Row bookkeeping and the retention deadline the whole design turns on.',
        columns: ['id', 'created_at', 'expires_at'],
      },
      {
        reason:
          'The epoch and its window. The salt is swept at 45 days — deliberately SHORTER than the events derived under it — which is what makes two epochs unlinkable rather than merely inconvenient to link.',
        columns: ['epoch', 'active_from', 'active_until'],
      },
      {
        reason:
          "The domain's ONE legitimate secret, in `PROTECTED_COLUMNS`. 32 CSPRNG bytes; once swept, nobody including Mercaria can recompute an old epoch's pseudonym from a session handle.",
        columns: ['salt'],
      },
    ],
  },
  {
    table: 'analytics_rollup_cursors',
    groups: [
      {
        reason:
          'Row bookkeeping. This table is not swept: it holds one cursor per rollup job, so its size is a function of the job catalogue rather than of traffic.',
        columns: ['id', 'created_at', 'updated_at'],
      },
      {
        reason:
          'Where the rollup job got to and how it went. `last_error` is a bounded operator message about a JOB, never about a request or a person.',
        columns: ['last_completed_date', 'last_run_at', 'last_error'],
      },
      {
        reason:
          'The lease. `lease_owner` is a task identity — the process holding the claim — and carries nothing about whoever the events belonged to.',
        columns: ['lease_owner', 'lease_expires_at'],
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */

/**
 * The SECOND layer: names that may not be admitted even by being written down.
 *
 * Each entry is a sequence of adjacent segments. Most are one segment; the
 * multi-segment ones exist because the single segment is legitimate on its own
 * (`oxy_user_id` carries `user`, so the prohibition is `user` followed by
 * `agent`).
 *
 * Six of these are the tokens `db/schema/analytics.ts` has always claimed and
 * the old regex lacked — `hash`, `token`, `address`, `name`, the coordinate
 * family and `session` — and each is a name a reviewer would wave through on a
 * table whose other columns look exactly like it.
 */
export const ANALYTICS_FORBIDDEN_COLUMN_SEGMENTS: readonly AnalyticsColumnProhibition[] = [
  // Contact.
  { segments: ['email'], prohibition: 'an email address, in any form' },
  { segments: ['phone'], prohibition: 'a telephone number' },
  { segments: ['msisdn'], prohibition: 'a telephone number' },
  { segments: ['contact'], prohibition: 'a contact detail' },
  {
    segments: ['address'],
    prohibition: 'a postal address (and `ip_address`, which is the same segment)',
  },
  { segments: ['street'], prohibition: 'a street' },
  { segments: ['postal'], prohibition: 'a postal code' },
  { segments: ['postcode'], prohibition: 'a postal code' },
  { segments: ['zip'], prohibition: 'a postal code' },
  {
    segments: ['name'],
    prohibition:
      "a human-readable name. This domain stores entity IDS: a name is either a person or a copy of a label another domain owns, and a copy is what erasure cannot reach",
  },
  {
    segments: ['handle'],
    prohibition: 'a reusable account or session handle, which is a correlation key with a friendly face',
  },

  // Payment.
  { segments: ['card'], prohibition: 'a payment card detail' },
  { segments: ['pan'], prohibition: 'a payment card number' },
  { segments: ['cvv'], prohibition: 'a payment card verification value' },
  { segments: ['iban'], prohibition: 'a bank account identifier' },
  { segments: ['bank'], prohibition: 'a bank account identifier' },
  { segments: ['fingerprint'], prohibition: 'a card or device fingerprint' },
  { segments: ['stripe'], prohibition: 'a payment provider object id' },
  { segments: ['wallet'], prohibition: 'a wallet identity' },
  { segments: ['customer'], prohibition: 'a payment provider customer id' },
  { segments: ['payout'], prohibition: 'a payout destination' },

  // Network and device.
  { segments: ['ip'], prohibition: 'an IP address' },
  { segments: ['agent'], prohibition: 'a user agent string' },
  { segments: ['device'], prohibition: 'a device identity or fingerprint' },
  { segments: ['cookie'], prohibition: 'a cookie value' },

  // Credentials and one-way oracles.
  { segments: ['token'], prohibition: 'a bearer credential' },
  { segments: ['tokens'], prohibition: 'a bearer credential' },
  { segments: ['secret'], prohibition: 'a secret' },
  { segments: ['password'], prohibition: 'a password' },
  { segments: ['credential'], prohibition: 'a credential' },
  { segments: ['bearer'], prohibition: 'a bearer credential' },
  {
    segments: ['hash'],
    prohibition:
      "a keyed or unkeyed digest. A digest of an address is an exact-match ORACLE, not an anonymisation — `guest_checkouts.email_hash` is PROTECTED for exactly this reason",
  },
  { segments: ['digest'], prohibition: 'a digest, which is an exact-match oracle' },
  { segments: ['hmac'], prohibition: 'a keyed digest, which is an exact-match oracle' },

  // Session and correlation.
  {
    segments: ['session'],
    prohibition:
      'a session handle. The only pseudonym this domain may hold is derived under a rotating salt that is then deleted',
  },

  // Location.
  { segments: ['lat'], prohibition: 'a latitude' },
  { segments: ['latitude'], prohibition: 'a latitude' },
  { segments: ['lon'], prohibition: 'a longitude' },
  { segments: ['lng'], prohibition: 'a longitude' },
  { segments: ['longitude'], prohibition: 'a longitude' },
  { segments: ['geo'], prohibition: 'a position' },
  { segments: ['geohash'], prohibition: 'a position' },
  { segments: ['coord'], prohibition: 'a position' },
  { segments: ['coordinate'], prohibition: 'a position' },
  { segments: ['coordinates'], prohibition: 'a position' },
  {
    segments: ['cell'],
    prohibition: 'a coarse position cell, which is still where somebody was',
  },

  // Free content — the property bag arriving under a column name.
  { segments: ['note'], prohibition: 'a note somebody typed' },
  { segments: ['notes'], prohibition: 'a note somebody typed' },
  { segments: ['comment'], prohibition: 'free text somebody typed' },
  { segments: ['message'], prohibition: 'free text somebody typed' },
  { segments: ['body'], prohibition: 'a request or page body' },
  {
    segments: ['payload'],
    prohibition:
      'an open property bag. The `jsonb` gate catches the TYPE; this catches a `text` column doing the same job under a name',
  },
  { segments: ['properties'], prohibition: 'an open property bag' },
  { segments: ['props'], prohibition: 'an open property bag' },
  { segments: ['metadata'], prohibition: 'an open property bag' },
  { segments: ['attributes'], prohibition: 'an open property bag' },
  { segments: ['raw'], prohibition: 'an unredacted value' },
  { segments: ['json'], prohibition: 'an open property bag' },
  { segments: ['blob'], prohibition: 'an open property bag' },
];

/**
 * Columns admitted DESPITE a prohibition, each naming the one column and why.
 *
 * The count is asserted EXACTLY rather than as a ceiling: an exemption list
 * that only grows is the gate switching itself off one defensible line at a
 * time. Each is also asserted to be a live exemption — it must name a column
 * that EXISTS and that a prohibition genuinely refuses, or it is a decision
 * nobody is making that reads as one.
 */
export const ANALYTICS_COLUMN_DENY_EXEMPTIONS: readonly AnalyticsColumnExemption[] = [
  {
    column: 'analytics_events.pseudonymous_session_id',
    reason:
      'Matches `session`. It is not a session handle: it is `sha256(epochSalt || ":" || handle)` truncated to 32 hex characters, under a salt that rotates every 24 hours and is DELETED at 45 days — so two epochs are unlinkable rather than merely inconvenient to link. Refusing it would refuse the one identity column #77 designed.',
  },
  {
    column: 'analytics_search_queries.normalized_tokens',
    reason:
      'Matches `tokens`. These are search terms, derived from the REDACTED text and never from the original, and they are what survives when `text_expires_at` nulls the text at 30 days. The prohibition is on a bearer credential; the plural is carried anyway so `subject_tokens` cannot arrive by pluralisation.',
  },
];

/* -------------------------------------------------------------------------- */

/** Does `segments` contain `needle` as a contiguous run? */
function containsRun(segments: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > segments.length) return false;
  for (let start = 0; start + needle.length <= segments.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (segments[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The prohibition a qualified `table.column` falls under, or `null`.
 *
 * Pure and exported so the mutation self-test can probe it with names that are
 * not in the schema — a detector proven only against the schema it passes on is
 * proven against nothing.
 */
export function analyticsColumnProhibition(
  qualified: string,
  exemptions: readonly AnalyticsColumnExemption[] = ANALYTICS_COLUMN_DENY_EXEMPTIONS,
): string | null {
  if (exemptions.some((exemption) => exemption.column === qualified)) return null;
  const column = qualified.slice(qualified.indexOf('.') + 1);
  const segments = column.split('_');
  for (const entry of ANALYTICS_FORBIDDEN_COLUMN_SEGMENTS) {
    if (containsRun(segments, entry.segments)) return entry.prohibition;
  }
  return null;
}

/**
 * Compare the real schema against the allow-list, in BOTH directions, and run
 * the deny-list over the union of what each side names.
 *
 * The union rather than either side alone: if the two disagree the equality
 * assertion is what fails, and the deny scan must still be able to say which of
 * the two names is the dangerous one.
 */
export function auditAnalyticsColumns(
  tables: readonly AnalyticsTableColumns[],
  allowList: readonly AnalyticsTableAllowance[] = ANALYTICS_COLUMN_ALLOWLIST,
): AnalyticsColumnAudit {
  const allowed = new Map<string, Set<string>>();
  for (const allowance of allowList) {
    const columns = new Set<string>();
    for (const group of allowance.groups) for (const column of group.columns) columns.add(column);
    allowed.set(allowance.table, columns);
  }

  const unlisted: string[] = [];
  const missing: string[] = [];
  const unlistedTables: string[] = [];
  const seenTables = new Set<string>();
  const union = new Set<string>();

  for (const { table, columns } of tables) {
    seenTables.add(table);
    const permitted = allowed.get(table);
    if (permitted === undefined) unlistedTables.push(table);
    for (const column of columns) {
      union.add(`${table}.${column}`);
      if (permitted !== undefined && !permitted.has(column)) unlisted.push(`${table}.${column}`);
    }
  }

  const missingTables: string[] = [];
  for (const [table, columns] of allowed) {
    if (!seenTables.has(table)) {
      missingTables.push(table);
      continue;
    }
    const actual = new Set(tables.find((entry) => entry.table === table)?.columns ?? []);
    for (const column of columns) {
      union.add(`${table}.${column}`);
      if (!actual.has(column)) missing.push(`${table}.${column}`);
    }
  }

  const forbidden: { column: string; prohibition: string }[] = [];
  for (const qualified of [...union].sort()) {
    const prohibition = analyticsColumnProhibition(qualified);
    if (prohibition !== null) forbidden.push({ column: qualified, prohibition });
  }

  return {
    unlisted: unlisted.sort(),
    missing: missing.sort(),
    forbidden,
    unlistedTables: unlistedTables.sort(),
    missingTables: missingTables.sort(),
  };
}

/** Every column the allow-list names, qualified. The vacuity floor reads it. */
export function allowListedColumnCount(
  allowList: readonly AnalyticsTableAllowance[] = ANALYTICS_COLUMN_ALLOWLIST,
): number {
  return allowList.reduce(
    (total, allowance) =>
      total + allowance.groups.reduce((sum, group) => sum + group.columns.length, 0),
    0,
  );
}
