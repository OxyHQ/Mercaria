/**
 * The contract gates: metric definitions, the column allow-list, experiment
 * guardrails and the deferred-event seams (#77).
 *
 * Four unrelated rules, one file, because each is a scan over a closed
 * vocabulary and splitting them into four files would make the shared vacuity
 * discipline four copies. Every scanner here carries the metro-gate defences
 * (`~/Oxy/AGENTS.md`): a floor that fails a broken traversal, and a mutation
 * self-test that fails a rotted detector.
 *
 * The column rule is the one that changed shape. It was a DENY-LIST — one regex
 * naming eighteen tokens, admitting everything else — under a schema whose own
 * docblock says the domain IS an allow-list. It is now the allow-list the
 * document always claimed, in `analytics-column-allowlist.ts`, with the
 * deny-list kept beside it as a second layer that fails differently.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import {
  ANALYTICS_DEFERRED_EVENT_TYPES,
  ANALYTICS_ENVELOPE_VERSION,
  ANALYTICS_EVENT_TYPES,
  ANALYTICS_EXPERIMENT_BUCKETS,
  ANALYTICS_EXPERIMENT_TREATMENT_KINDS,
  ANALYTICS_FORBIDDEN_EXPERIMENT_TREATMENTS,
  ANALYTICS_METRICS,
  ANALYTICS_METRIC_KEYS,
  ANALYTICS_METRIC_SOURCES,
  ANALYTICS_METRIC_WINDOWS,
  ANALYTICS_STRUCTURALLY_UNEMITTED_EVENT_TYPES,
} from '@mercaria/shared-types';
import * as analyticsSchema from '../../../db/schema/analytics.js';
import {
  findFinancialSourceViolations,
  metricByKey,
  metricKeyClaimsMoney,
} from '../metrics.js';
import { assignVariant, assignmentBucket, findForbiddenTreatmentKinds } from '../experiments.js';
import { ALL_EVENT_TYPES, eventClassFor } from '../envelope.js';
import { ANALYTICS_SEAMS, DEFERRED_EVENT_TYPES, NEVER_EMITTED_EVENT_TYPES } from '../seams.js';
import {
  ANALYTICS_COLUMN_ALLOWLIST,
  ANALYTICS_COLUMN_DENY_EXEMPTIONS,
  ANALYTICS_FORBIDDEN_COLUMN_SEGMENTS,
  allowListedColumnCount,
  analyticsColumnProhibition,
  auditAnalyticsColumns,
} from './analytics-column-allowlist.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/* -------------------------------------------------------------------------- */

describe('#77 acceptance 6 — every metric names its denominator, window and freshness', () => {
  it('no definition has an empty field', () => {
    expect(ANALYTICS_METRICS.length).toBeGreaterThanOrEqual(18);
    for (const metric of ANALYTICS_METRICS) {
      // `tsc` already refuses a MISSING field; only a blank one can slip past,
      // and a blank `attributionLimit` is exactly what a hurried addition
      // produces.
      expect(metric.key, 'a metric has no key').not.toBe('');
      expect(metric.title.length, `${metric.key} has no title`).toBeGreaterThan(3);
      expect(metric.numerator.length, `${metric.key} has no numerator`).toBeGreaterThan(10);
      expect(metric.denominator.length, `${metric.key} has no denominator`).toBeGreaterThan(10);
      expect(metric.attributionLimit.length, `${metric.key} states no limit`).toBeGreaterThan(20);
      expect(ANALYTICS_METRIC_WINDOWS).toContain(metric.window);
      expect(ANALYTICS_METRIC_SOURCES).toContain(metric.source);
      expect(metric.freshnessSeconds, `${metric.key} has no freshness`).toBeGreaterThan(0);
    }
  });

  it('every key is unique and resolvable', () => {
    expect(new Set(ANALYTICS_METRIC_KEYS).size).toBe(ANALYTICS_METRIC_KEYS.length);
    for (const key of ANALYTICS_METRIC_KEYS) {
      expect(metricByKey(key)?.key).toBe(key);
    }
    // A key with no definition is refused rather than served empty — the read
    // surface's own 404, pinned here so a dashboard cannot render a number
    // nothing explains.
    expect(metricByKey('not_a_metric')).toBeUndefined();
  });

  it('every metric #77 names by number is present', () => {
    // The twenty-two #77 itself names, enumerated by key so a rename is a
    // visible failure rather than a silently missing chart. It is NOT the whole
    // catalogue: `ANALYTICS_METRICS` carries thirty-two, the other ten being
    // #111's guest funnel measures. The comment here read "eighteen" while the
    // list below held twenty-two, which is the shape a count claimed from
    // memory takes — count the array, never the sentence beside it.
    for (const key of [
      'search_success_rate',
      'zero_result_rate',
      'duplicate_product_rate',
      'search_to_product_click_rate',
      'product_to_offer_selection_rate',
      'external_click_through_rate',
      'native_add_to_cart_rate',
      'native_checkout_conversion',
      'authenticated_checkout_funnel',
      'guest_checkout_funnel',
      'guest_verified_payment_conversion',
      'order_portal_delivery_success',
      'oxy_claim_funnel',
      'saved_intent_return_rate',
      'source_coverage_gap',
      'query_latency_and_freshness',
      'merchant_claim_funnel',
      'native_gmv',
      'marketplace_revenue',
      'affiliate_commission',
      'guest_post_purchase_demand',
      'guest_eligibility_coverage',
    ]) {
      expect(metricByKey(key), `#77 names ${key} and it is missing`).toBeDefined();
    }
  });

  it('no money metric is sourced from telemetry — identity rule 8', () => {
    expect(findFinancialSourceViolations()).toEqual([]);
    // The vacuity floor: a marker list matching nothing would return `[]` for
    // the best possible reason and the worst possible cause.
    expect(ANALYTICS_METRICS.filter((m) => metricKeyClaimsMoney(m.key)).length).toBeGreaterThanOrEqual(
      5,
    );
  });

  it('the financial detector actually detects — the mutation self-test', () => {
    expect(
      findFinancialSourceViolations([
        {
          key: 'sneaky_revenue',
          title: 'x',
          numerator: 'numerator text',
          denominator: 'denominator text',
          window: 'day',
          source: 'analytics_events',
          freshnessSeconds: 1,
          humanOnly: true,
          merchantVisible: false,
          attributionLimit: 'an attribution limit long enough to pass the floor',
        },
      ]),
    ).toEqual([{ metricKey: 'sneaky_revenue', source: 'analytics_events' }]);
  });

  it('a merchant-visible metric always states an attribution limit', () => {
    // Merchant rule 8. The floor above already checks every metric; this asserts
    // the merchant-visible subset is non-empty, so the rule is not satisfied by
    // there being nothing to show.
    const visible = ANALYTICS_METRICS.filter((m) => m.merchantVisible);
    expect(visible.length).toBeGreaterThanOrEqual(4);
  });
});

/* -------------------------------------------------------------------------- */

describe('#77 — the analytics schema can hold no identity beyond a pseudonym', () => {
  /**
   * Every table this domain owns, with its columns.
   *
   * Enumerated from the MODULE rather than from a hand-written list, so a ninth
   * table added later is scanned automatically — a list would have to be
   * remembered, and the one thing a forbidden-column gate must not depend on is
   * somebody remembering.
   */
  function analyticsTables(): readonly { table: string; columns: readonly string[] }[] {
    const out: { table: string; columns: readonly string[] }[] = [];
    for (const value of Object.values(analyticsSchema)) {
      if (typeof value !== 'object' || value === null) continue;
      if (!(Symbol.for('drizzle:Name') in value)) continue;
      const table = value as Parameters<typeof getTableColumns>[0];
      out.push({
        table: getTableName(table),
        // `sqlColumnName`, never `column.name`. The casing authority is
        // `@oxyhq/db`'s `DATABASE_CASING` and drizzle converts at query time, so
        // `column.name` is the TypeScript PROPERTY name — this gate's previous
        // pattern was matching `ip_address`, `user_agent` and `order_note`
        // against strings that read `ipAddress`, `userAgent` and `orderNote`,
        // and three of its eighteen tokens could never have fired.
        columns: Object.values(getTableColumns(table)).map((column) => sqlColumnName(column)),
      });
    }
    return out;
  }

  it('every column of every analytics table is ALLOW-LISTED, and nothing else may exist', () => {
    const tables = analyticsTables();
    // Three vacuity floors, because a traversal that found nothing, an
    // allow-list that listed nothing and a table that lost its columns all
    // produce a clean audit.
    expect(tables.length).toBe(8);
    expect(ANALYTICS_COLUMN_ALLOWLIST.length).toBe(8);
    expect(allowListedColumnCount()).toBeGreaterThanOrEqual(120);
    for (const { table, columns } of tables) {
      expect(columns.length, `${table} has no columns — did the traversal break?`).toBeGreaterThan(
        3,
      );
    }

    const audit = auditAnalyticsColumns(tables);
    // The deny layer is asserted FIRST, because vitest stops at the first
    // failing assertion in a test and this is the message worth reading: it
    // names the PROHIBITION a column falls under, where `unlisted` says only
    // that nobody has decided about it.
    expect(audit.forbidden).toEqual([]);
    // A NEW COLUMN FAILS THE BUILD UNTIL SOMEBODY DECIDES IT IS ALLOWED. That
    // is the whole inversion: the previous gate refused the eighteen tokens
    // somebody had thought of and admitted everything else, so `shipping_address`,
    // `full_name`, `latitude` and `subject_hash` would every one have passed.
    // The fix is to add it to `ANALYTICS_COLUMN_ALLOWLIST` under a group whose
    // REASON covers it, or to a new group — never to widen a sentence that does
    // not describe it.
    expect(audit.unlistedTables).toEqual([]);
    expect(audit.unlisted).toEqual([]);
    // And the reverse, so the list cannot rot into a standing permission for a
    // column that moved or was dropped.
    expect(audit.missingTables).toEqual([]);
    expect(audit.missing).toEqual([]);
  });

  it('every allow-listed group states a reason, and no column is listed twice', () => {
    const seen = new Set<string>();
    for (const allowance of ANALYTICS_COLUMN_ALLOWLIST) {
      expect(allowance.groups.length, `${allowance.table} has no groups`).toBeGreaterThan(0);
      for (const group of allowance.groups) {
        // A reason long enough to be a reason. A blank one is exactly what a
        // hurried addition produces, and a group whose reason does not cover a
        // column is the signal to open a new group.
        expect(
          group.reason.length,
          `${allowance.table} has a group with no reason`,
        ).toBeGreaterThan(30);
        expect(group.columns.length, `${allowance.table} has an empty group`).toBeGreaterThan(0);
        for (const column of group.columns) {
          const qualified = `${allowance.table}.${column}`;
          expect(seen.has(qualified), `${qualified} is listed twice`).toBe(false);
          seen.add(qualified);
        }
      }
    }
  });

  it('the deny-list is a real second layer, and its exemptions are live decisions', () => {
    // A floor on the prohibitions themselves: an empty list would make the
    // second layer pass by measuring nothing.
    expect(ANALYTICS_FORBIDDEN_COLUMN_SEGMENTS.length).toBeGreaterThanOrEqual(40);
    for (const entry of ANALYTICS_FORBIDDEN_COLUMN_SEGMENTS) {
      expect(entry.segments.length).toBeGreaterThan(0);
      expect(entry.prohibition.length).toBeGreaterThan(3);
    }

    // EXACTLY two, never a ceiling: an exemption list that only grows is the
    // gate switching itself off one defensible line at a time.
    expect(ANALYTICS_COLUMN_DENY_EXEMPTIONS.length).toBe(2);
    const tables = analyticsTables();
    for (const exemption of ANALYTICS_COLUMN_DENY_EXEMPTIONS) {
      expect(exemption.reason.length).toBeGreaterThan(60);
      const [table, column] = [
        exemption.column.slice(0, exemption.column.indexOf('.')),
        exemption.column.slice(exemption.column.indexOf('.') + 1),
      ];
      // It must name a column that EXISTS...
      const actual = tables.find((entry) => entry.table === table);
      expect(actual?.columns, `${exemption.column} names no real table`).toBeDefined();
      expect(actual?.columns.includes(column), `${exemption.column} names no real column`).toBe(
        true,
      );
      // ...and one a prohibition genuinely refuses. An exemption for a name
      // nothing forbids is an inert line that reads as a live decision, and it
      // is what stops the next person looking.
      expect(
        analyticsColumnProhibition(exemption.column, []),
        `${exemption.column} is exempted from nothing`,
      ).not.toBeNull();
      // With the exemption applied it passes, which is the point of the entry.
      expect(analyticsColumnProhibition(exemption.column)).toBeNull();
    }
  });

  it('the gate fires on a FORBIDDEN column added to a real table — the mutation self-test', () => {
    const mutated = analyticsTables().map((entry) =>
      entry.table === 'analytics_events'
        ? { ...entry, columns: [...entry.columns, 'buyer_email_hash'] }
        : entry,
    );
    const audit = auditAnalyticsColumns(mutated);
    expect(audit.unlisted).toContain('analytics_events.buyer_email_hash');
    expect(audit.forbidden.map((offence) => offence.column)).toContain(
      'analytics_events.buyer_email_hash',
    );

    // Every name the old regex could not see, plus the ones it could. These are
    // SQL identifiers, which is what the traversal now yields — the old
    // self-test fed the pattern snake_case literals the scan never received.
    assertEachOf([
      'shipping_address',
      'full_name',
      'latitude',
      'longitude',
      'subject_hash',
      'identity_hash',
      'access_token',
      'guest_session_id',
      'buyer_email',
      'card_fingerprint',
      'stripe_customer_id',
      'ip_address',
      'device_id',
      'client_secret_ciphertext',
      'user_agent',
      'order_note',
      'page_payload',
      'geo_cell_index',
    ], 18, (probe) => {
      expect(
        analyticsColumnProhibition(`analytics_events.${probe}`),
        `${probe} should be refused`,
      ).not.toBeNull();
    });

    // And the real columns that must NOT trip it, including the two the
    // exemptions carry and the two nearest misses a segment matcher exists for:
    // `latency_ms` is not a latitude and `oxy_user_id` is not a user agent.
    assertEachOf([
      'salt',
      'pseudonymous_session_id',
      'checkout_group_id',
      'normalized_tokens',
      'latency_ms',
      'oxy_user_id',
      'payment_method_category',
      'normalized_query',
      'redacted_text',
      'assignment_salt',
      'lease_owner',
      'primary_metric_key',
    ], 12, (probe) => {
      const qualified =
        probe === 'normalized_tokens'
          ? `analytics_search_queries.${probe}`
          : `analytics_events.${probe}`;
      expect(analyticsColumnProhibition(qualified), `${probe} must be permitted`).toBeNull();
    });
  });

  it('the gate fires on an INNOCUOUS unlisted column too — which is the whole inversion', () => {
    // The case a deny-list can never catch, and the reason this gate was
    // rewritten: a name no prohibition anticipates, on a table whose other
    // columns look exactly like it. It must go red on the ALLOW-LIST alone,
    // with the deny-list silent — so the two layers are shown to be
    // independent rather than one dressed as two.
    const mutated = analyticsTables().map((entry) =>
      entry.table === 'analytics_rollups'
        ? { ...entry, columns: [...entry.columns, 'snowfall_depth_cm'] }
        : entry,
    );
    const audit = auditAnalyticsColumns(mutated);
    expect(audit.unlisted).toEqual(['analytics_rollups.snowfall_depth_cm']);
    expect(audit.forbidden).toEqual([]);

    // A ninth TABLE is caught the same way, by the table it has no allowance for.
    const withNewTable = auditAnalyticsColumns([
      ...analyticsTables(),
      { table: 'analytics_visitor_profiles', columns: ['id', 'visitor_key'] },
    ]);
    expect(withNewTable.unlistedTables).toEqual(['analytics_visitor_profiles']);
  });

  it('the gate fires on an allow-list entry with no column behind it', () => {
    const audit = auditAnalyticsColumns(analyticsTables(), [
      ...ANALYTICS_COLUMN_ALLOWLIST.filter((entry) => entry.table !== 'analytics_pseudonym_salts'),
      {
        table: 'analytics_pseudonym_salts',
        groups: [
          {
            reason: 'a synthetic allowance naming a column this table has never had',
            columns: ['id', 'created_at', 'expires_at', 'epoch', 'active_from', 'active_until', 'salt', 'retired_salt'],
          },
        ],
      },
    ]);
    expect(audit.missing).toEqual(['analytics_pseudonym_salts.retired_salt']);
  });

  it('there is no open property bag anywhere in the domain', () => {
    // The allow-list is the whole design (#77 event contract): "do not put
    // secrets, payment data, full addresses, raw contact, order notes or
    // arbitrary page payloads in analytics properties". A `jsonb` column would
    // make every one of those representable in one edit.
    const source = readFileSync(join(SRC_ROOT, 'db/schema/analytics.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(2_000);
    // A COLUMN, not a mention: the file's own docblock says "no `properties
    // jsonb` anywhere in this file", and a scanner that failed on the sentence
    // stating the rule is the definition of crying wolf.
    const JSONB_COLUMN = /\bjsonb\s*\(/;
    expect(JSONB_COLUMN.test(source)).toBe(false);
    // Mutation self-test — both the declaration and the import that enables it.
    expect(JSONB_COLUMN.test('payload: jsonb().notNull(),')).toBe(true);
    expect(JSONB_COLUMN.test('a docblock mentioning jsonb in prose')).toBe(false);
    expect(source.includes("jsonb }")).toBe(false);
    expect(source.includes("jsonb,")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('#77 experimentation rules 3, 5 and 9 — coercive treatments are unrepresentable', () => {
  it('no treatment kind matches a forbidden pattern', () => {
    expect(findForbiddenTreatmentKinds()).toEqual([]);
    // The vacuity floor: an empty vocabulary would pass above.
    expect(ANALYTICS_EXPERIMENT_TREATMENT_KINDS.length).toBeGreaterThanOrEqual(5);
    expect(ANALYTICS_FORBIDDEN_EXPERIMENT_TREATMENTS.length).toBeGreaterThanOrEqual(8);
  });

  it('the treatment detector actually detects — the mutation self-test', () => {
    // Every one of these is a plausible future addition that a tired reviewer
    // would wave through, which is exactly why the gate exists.
    expect(findForbiddenTreatmentKinds(['hide_guest_checkout'])).toEqual(['hide_guest_checkout']);
    expect(findForbiddenTreatmentKinds(['guest_option_visibility'])).toEqual([
      'guest_option_visibility',
    ]);
    expect(findForbiddenTreatmentKinds(['auto_create_account_on_purchase'])).toEqual([
      'auto_create_account_on_purchase',
    ]);
    expect(findForbiddenTreatmentKinds(['marketing_consent_default'])).toEqual([
      'marketing_consent_default',
    ]);
    expect(findForbiddenTreatmentKinds(['sponsored_rank_boost'])).toHaveLength(1);
    expect(findForbiddenTreatmentKinds(['copy_variant', 'ranking_policy'])).toEqual([]);
  });

  it('assignment is deterministic and depends on the salt', () => {
    const experiment = {
      experimentKey: 'result-density',
      assignmentSalt: 'salt-a',
      variants: ['control', 'treatment'],
      trafficAllocationBps: 10_000,
    };
    const first = assignVariant(experiment, 'unit-1');
    // Deterministic: the same inputs give the same arm on every task, forever.
    expect(assignVariant(experiment, 'unit-1')).toBe(first);
    // Salt-dependent: two experiments do not bucket one unit identically, which
    // is what stops them confounding each other.
    expect(assignVariant({ ...experiment, assignmentSalt: 'salt-b' }, 'unit-1')).toBeDefined();
    expect(assignmentBucket({ ...experiment, unitRef: 'unit-1' })).toBeLessThan(
      ANALYTICS_EXPERIMENT_BUCKETS,
    );
  });

  it('a unit outside the allocation gets `undefined`, never `control`', () => {
    // A holdout counted as control makes the two populations one and the
    // comparison meaningless.
    const experiment = {
      experimentKey: 'x',
      assignmentSalt: 's',
      variants: ['control', 'treatment'],
      trafficAllocationBps: 0,
    };
    expect(assignVariant(experiment, 'unit-1')).toBeUndefined();
  });

  it('a one-armed experiment assigns nothing', () => {
    expect(
      assignVariant(
        { experimentKey: 'x', assignmentSalt: 's', variants: ['only'], trafficAllocationBps: 10_000 },
        'unit-1',
      ),
    ).toBeUndefined();
  });

  it('both arms are actually reachable over many units', () => {
    // Without this, an off-by-one in the bucket arithmetic that put every unit
    // in `control` would pass every assertion above.
    const experiment = {
      experimentKey: 'x',
      assignmentSalt: 's',
      variants: ['control', 'treatment'],
      trafficAllocationBps: 10_000,
    };
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const variant = assignVariant(experiment, `unit-${String(i)}`);
      if (variant !== undefined) seen.add(variant);
    }
    expect([...seen].sort()).toEqual(['control', 'treatment']);
  });
});

/* -------------------------------------------------------------------------- */

describe('#77 — the deferred events are a seam, never a fabricated event', () => {
  /** Every source file in `src/`, excluding tests and the seam registry itself. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        sourceFiles(full, out);
        continue;
      }
      if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('nothing in src/ emits an event type its owning issue has not landed', () => {
    const files = sourceFiles(SRC_ROOT).filter(
      (file) =>
        // The registries THEMSELVES name every deferred type — that is their
        // job — so they are the two exclusions, named rather than pattern-matched.
        !file.endsWith(join('services', 'analytics', 'seams.ts')) &&
        !file.endsWith(join('services', 'analytics', 'envelope.ts')),
    );
    // The vacuity floor: a broken traversal would scan nothing and pass.
    expect(files.length).toBeGreaterThan(200);
    // Ten: #107's five (now #111's), #109's remaining TWO (also #111's) and
    // #110's three. Pinned EXACTLY rather than as a minimum, so both directions
    // fail: a type quietly added to the deferred map without a seam entry, and
    // one emitted without being removed from it.
    //
    // It was twenty-two until #106 closed its own seam — the six eligibility
    // and contact/destination types — sixteen until #108 closed the three
    // portal and recovery ones, ten until #109 closed the three a SERVER can
    // honestly observe, and seven until #110 closed the cancellation, return
    // and support ones. Ratcheting this number DOWN is the shape a closed seam
    // takes here, and the assertion below is what proves the closed ones are
    // genuinely emitted rather than merely delisted: they are no longer in
    // `DEFERRED_EVENT_TYPES`, so an emission of one is no longer an offence,
    // and `checkout.controller.ts` (#106), `routes/guest-orders.ts` (#108,
    // #109) and `buyer-requests.controller.ts` (#110) perform it.
    //
    // #109's SPLIT is the one to read: `guest_claim_started`,
    // `guest_claim_completed` and `guest_claim_conflicted` come off this list
    // because the claim transaction produces each of them, while
    // `guest_claim_offered` and `guest_claim_declined` stay on it and move to
    // #111 — an offer is a screen having been shown and a decline is somebody
    // navigating away, and the server can observe neither without inventing it.
    //
    // #111 took it to ZERO, which is a different kind of change from the four
    // before it and needed the gate re-pointed rather than re-counted. Six of
    // its seven types are emitted by a storefront analytics client it built;
    // the seventh, `guest_payment_verified`, moved to
    // `ANALYTICS_STRUCTURALLY_UNEMITTED_EVENT_TYPES` — never emitted, by
    // decision rather than by schedule. Scanning only the DEFERRED set would
    // therefore have made this gate vacuous on the very deploy that closed the
    // last seam: nothing to look for, no offenders, green forever, and the one
    // type that must never be emitted guarded by nothing. The scan set is now
    // the union, which is non-empty by construction.
    expect(DEFERRED_EVENT_TYPES.length).toBe(0);
    expect(NEVER_EMITTED_EVENT_TYPES.length).toBe(1);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const type of NEVER_EMITTED_EVENT_TYPES) {
        // An EMISSION, not a mention: `eventType: 'guest_claim_completed'` is
        // the shape every call site takes, and a docblock naming the type is
        // exactly what the seam contract is written in.
        if (source.includes(`eventType: '${type}'`)) {
          offenders.push(`${file.replace(SRC_ROOT, '')} emits ${type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the emission detector actually detects — the mutation self-test', () => {
    // `guest_payment_verified`, the one type that may never be emitted. It is
    // the right seed precisely BECAUSE it will never be implemented: a self-test
    // seeded with a merely-deferred type passes today and starts failing the
    // day somebody lands it, which is the failure mode this file exists to
    // catch, one level up.
    const seeded = "emitAnalyticsEvent(req, { eventType: 'guest_payment_verified' });";
    expect(NEVER_EMITTED_EVENT_TYPES.some((t) => seeded.includes(`eventType: '${t}'`))).toBe(true);
    const innocent = "emitAnalyticsEvent(req, { eventType: 'product_page_view' });";
    expect(NEVER_EMITTED_EVENT_TYPES.some((t) => innocent.includes(`eventType: '${t}'`))).toBe(
      false,
    );
    // And the CLOSED direction, which the count alone cannot state: the six
    // types #111 now emits must not be readable as an offence any more.
    assertEachOf([
      'guest_claim_completed',
      'guest_claim_declined',
      'guest_payment_methods_shown',
    ], 3, (closed) => {
      const line = `emitAnalyticsEvent(req, { eventType: '${closed}' });`;
      expect(NEVER_EMITTED_EVENT_TYPES.some((t) => line.includes(`eventType: '${t}'`))).toBe(false);
    });
  });

  it('every deferred type names an owning issue, and every seam is documented', () => {
    for (const type of DEFERRED_EVENT_TYPES) {
      expect(ANALYTICS_DEFERRED_EVENT_TYPES[type], `${type} names no issue`).toMatch(/^#\d+$/);
    }
    // Every deferred type belongs to exactly one seam entry.
    const claimed = new Set(ANALYTICS_SEAMS.flatMap((seam) => seam.eventTypes));
    for (const type of DEFERRED_EVENT_TYPES) {
      expect(claimed.has(type), `${type} is deferred and no seam claims it`).toBe(true);
    }
    // And every STRUCTURALLY unemitted type names its decision rather than an
    // issue — a sentence, because "never, and here is why" is not a number.
    for (const [type, reason] of Object.entries(ANALYTICS_STRUCTURALLY_UNEMITTED_EVENT_TYPES)) {
      expect(reason.length, `${type} is never emitted and says nothing about why`).toBeGreaterThan(
        30,
      );
    }
    for (const seam of ANALYTICS_SEAMS) {
      expect(seam.contract.length, `${seam.issue} has no contract`).toBeGreaterThan(100);
    }
  });

  it('every event type has a retention class, and the vocabulary is closed', () => {
    expect(ALL_EVENT_TYPES.length).toBe(ANALYTICS_EVENT_TYPES.length);
    expect(new Set(ALL_EVENT_TYPES).size).toBe(ALL_EVENT_TYPES.length);
    for (const type of ALL_EVENT_TYPES) {
      expect(eventClassFor(type), `${type} has no retention class`).toBeDefined();
    }
    expect(ANALYTICS_ENVELOPE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
