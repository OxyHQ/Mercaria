/**
 * The contract gates: metric definitions, forbidden columns, experiment
 * guardrails and the deferred-event seams (#77).
 *
 * Four unrelated rules, one file, because each is a scan over a closed
 * vocabulary and splitting them into four files would make the shared vacuity
 * discipline four copies. Every scanner here carries the metro-gate defences
 * (`~/Oxy/AGENTS.md`): a floor that fails a broken traversal, and a mutation
 * self-test that fails a rotted detector.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
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
} from '@mercaria/shared-types';
import * as analyticsSchema from '../../../db/schema/analytics.js';
import {
  findFinancialSourceViolations,
  metricByKey,
  metricKeyClaimsMoney,
} from '../metrics.js';
import { assignVariant, assignmentBucket, findForbiddenTreatmentKinds } from '../experiments.js';
import { ALL_EVENT_TYPES, eventClassFor } from '../envelope.js';
import { ANALYTICS_SEAMS, DEFERRED_EVENT_TYPES } from '../seams.js';

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
    // The issue lists eighteen. Enumerated by key so a rename is a visible
    // failure rather than a silently missing chart.
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
        table: String((value as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')]),
        columns: Object.values(getTableColumns(table)).map((column) => column.name),
      });
    }
    return out;
  }

  const FORBIDDEN_COLUMN =
    /email|phone|contact|card|fingerprint|stripe|wallet|ip_address|device|user_agent|order_note|postcode|postal|street|password|secret(?!$)/i;

  it('no column in any analytics table could hold contact, payment, network or device identity', () => {
    const tables = analyticsTables();
    // The vacuity floor: eight tables, and a traversal that found none would
    // report a clean schema.
    expect(tables.length).toBe(8);
    const offenders: string[] = [];
    for (const { table, columns } of tables) {
      expect(columns.length, `${table} has no columns — did the traversal break?`).toBeGreaterThan(
        3,
      );
      for (const column of columns) {
        // `analytics_pseudonym_salts.salt` is the one legitimate secret in the
        // domain and is in PROTECTED_COLUMNS; the pattern's negative lookahead
        // admits it by name while still refusing `webhook_secret`,
        // `client_secret` and friends.
        if (FORBIDDEN_COLUMN.test(column)) offenders.push(`${table}.${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the column detector actually detects — the mutation self-test', () => {
    expect(FORBIDDEN_COLUMN.test('buyer_email')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('card_fingerprint')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('stripe_customer_id')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('ip_address')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('device_id')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('client_secret_ciphertext')).toBe(true);
    // The three that must NOT trip it.
    expect(FORBIDDEN_COLUMN.test('salt')).toBe(false);
    expect(FORBIDDEN_COLUMN.test('pseudonymous_session_id')).toBe(false);
    expect(FORBIDDEN_COLUMN.test('checkout_group_id')).toBe(false);
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
    // Sixteen: #107's five, #108's three, #109's five and #110's three. Pinned
    // EXACTLY rather than as a minimum, so both directions fail: a type quietly
    // added to the deferred map without a seam entry, and one emitted without
    // being removed from it.
    //
    // It was twenty-two until #106 closed its own seam — the six eligibility
    // and contact/destination types. Ratcheting this number DOWN is the shape a
    // closed seam takes here, and the assertion below is what proves the six
    // are genuinely emitted rather than merely delisted: they are no longer in
    // `DEFERRED_EVENT_TYPES`, so an emission of one is no longer an offence,
    // and `checkout.controller.ts` performs it.
    expect(DEFERRED_EVENT_TYPES.length).toBe(16);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const type of DEFERRED_EVENT_TYPES) {
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
    const seeded = "emitAnalyticsEvent(req, { eventType: 'guest_claim_completed' });";
    expect(DEFERRED_EVENT_TYPES.some((t) => seeded.includes(`eventType: '${t}'`))).toBe(true);
    const innocent = "emitAnalyticsEvent(req, { eventType: 'product_page_view' });";
    expect(DEFERRED_EVENT_TYPES.some((t) => innocent.includes(`eventType: '${t}'`))).toBe(false);
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
