/**
 * The walls around merchant plans (#89), asserted STRUCTURALLY.
 *
 * Product policy 3 — "a plan never buys organic rank, official status, reviews,
 * reputation or moderation preference" — and acceptance 7 — "no entitlement or
 * plan field enters organic ranking or official relationship logic" — are not
 * things a behavioural fixture can establish: a fixture shows that today's code
 * does not rank by plan, and the risk is tomorrow's. A ranking function that
 * cannot REACH plan data cannot rank by it, which is the stronger statement.
 *
 * Six walls, in both directions:
 *
 *  1. No discovery module may reach the plan domain.
 *  2. No plan or billing module may reach ranking, search or the relationship
 *     and review layers.
 *  3. No plan or billing module may reach the CONNECTED-ACCOUNT half of the
 *     payment domain (acceptance 2) — the ONE permitted import is the shared
 *     Stripe client, named explicitly.
 *  4. The entitlement RESOLUTION reads no feature flag (entitlement rule 8).
 *  5. The two capability tuples are disjoint, and so are the forbidden benefits.
 *  6. `merchant_subscription_plan` is already a forbidden ranking and relevance
 *     signal, in both vocabularies.
 *
 * Every scan carries a vacuity floor (a minimum scanned-file count, so a moved
 * or renamed directory fails the gate instead of passing it by having nothing to
 * match) and a mutation self-test (the detector is run against a seeded
 * positive, so a rotted regex cannot pass by matching nothing).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MERCHANT_ENTITLEMENT_CAPABILITIES,
  MERCHANT_PLAN_FORBIDDEN_BENEFITS,
  MERCHANT_UNGATEABLE_CAPABILITIES,
  OFFER_FORBIDDEN_RANKING_SIGNALS,
  SEARCH_FORBIDDEN_RELEVANCE_SIGNALS,
} from '@mercaria/shared-types';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Source with its comments removed — what a REACHABILITY detector must scan.
 *
 * The #105 finding: these modules document what they refuse to do in the same
 * vocabulary they would use to do it, so a detector reading raw source fires on
 * a docblock explaining the prohibition. It caught `projection.ts` on its first
 * run, which is the gate working — and the fix is to scan what the compiler
 * sees, not to weaken the pattern.
 *
 * Lines are dropped whole rather than by an inline `//` match, so a URL inside a
 * string cannot swallow the rest of its own line.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/** Every `.ts` file under a directory, tests excluded — the scan's own input. */
function sourceFilesUnder(relative: string): string[] {
  const root = join(SRC_ROOT, relative);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue;
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/*
 * The organic discovery surface is `__tests__/ranking-surface.ts` — WALKED and
 * derived from the import graph, shared with every other gate that asserts a
 * domain cannot influence what a buyer sees.
 *
 * It used to be a nineteen-entry `DISCOVERY_PATHS` array here, under a comment
 * saying it "mirrors `fee-ranking-isolation.test.ts`'s list, because the
 * question 'what ranks things' has one answer and two lists of it would drift."
 * Both halves of that had stopped being true. #483 replaced eleven such copies
 * with the shared derivation and `fee-ranking` was one of them, so the sentence
 * pointed at a list that no longer existed — and the copy had drifted exactly as
 * predicted. Measured on `origin/main` at 2771c695: nineteen entries against the
 * derivation's forty-two, missing all of `db/ranking/`, all of `db/search/`,
 * five modules of `services/ranking/` (`dominance`, `money`, `policy`,
 * `policy.service`, `seams`), five of `services/search/`, and eleven derived
 * controllers and routes including both operator surfaces.
 *
 * So wall 1 — "no discovery module references the plan domain" — was being
 * computed over 45% of the discovery surface, and the 55% it skipped was, by
 * construction, the part nobody had reviewed against this rule. The copy was
 * spelled `DISCOVERY_PATHS`, which is why a census keyed on `RANKING_PATHS`
 * did not find it (#460).
 */

/** Reaching the plan domain, from any direction. */
const PLAN_REFERENCE =
  /entitlements\/|merchantPlans|merchant_plans|plan_entitlements|entitlement_definitions|entitlement_grants|merchant_subscriptions|resolveMerchantEntitlements|checkCapability/;

/** Reaching ranking, search, relationships or reviews from the plan domain. */
const DISCOVERY_REFERENCE =
  /services\/ranking\/|services\/search\/|db\/ranking\/|db\/search\/|commerce-graph\/relationship|services\/reviews\/|rankOffers|relevanceScore/;

/**
 * Reaching the CONNECTED-ACCOUNT half of the payment domain.
 *
 * Narrow on purpose: the shared Stripe CLIENT is a legitimate and deliberate
 * import (one configured SDK instance, one pinned API version, one retry
 * policy), and so are the ledger repository and the provider error class. What
 * must never be reachable is a seller's Connect account, which is the object
 * acceptance 2 says can never be cross-linked with a billing customer.
 */
const CONNECTED_ACCOUNT_REFERENCE =
  /provider-account\.service|providerAccountRepository|provider_accounts|onboarding-state|createStripeConnectedAccount/;

/** Reading a deployment feature flag. */
const CONFIG_REFERENCE = /from '.*config\/index\.js'|config\.[a-z]/;

describe('a merchant plan cannot reach organic discovery', () => {
  it('no discovery module references the plan domain', () => {
    // The derivation's own floors, per SHAPE: this assertion is only as wide as
    // the walk behind it, and a walk that collapsed to nothing produces exactly
    // the zero violations a healthy run produces.
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = withoutComments(readRankingSurfaceFile(relative));
      expect(
        PLAN_REFERENCE.test(source),
        `${relative} references the merchant plan domain; a plan must never influence ranking`,
      ).toBe(false);
    }
  });

  it('no plan or billing module references ranking, search, relationships or reviews', () => {
    // A floor PER DIRECTORY, never one total: a single number stays satisfied
    // while one walk returns nothing and the other carries it, which is the
    // failure a two-directory scan is prone to. Each is today's count, so a
    // module REMOVED goes red rather than quietly narrowing the wall.
    const entitlements = sourceFilesUnder('services/entitlements');
    const billing = sourceFilesUnder('services/billing');
    expect(entitlements.length, 'the entitlements walk found too few files').toBeGreaterThanOrEqual(
      5,
    );
    expect(billing.length, 'the billing walk found too few files').toBeGreaterThanOrEqual(6);
    const files = [...entitlements, ...billing];
    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(
        DISCOVERY_REFERENCE.test(source),
        `${file} reaches a discovery module; a plan must not be able to see what ranks`,
      ).toBe(false);
    }
  });

  it('the detectors actually detect — the mutation self-test', () => {
    expect(
      PLAN_REFERENCE.test("import { checkCapability } from '../entitlements/usage.js';"),
    ).toBe(true);
    expect(PLAN_REFERENCE.test('select * from merchant_subscriptions')).toBe(true);
    expect(PLAN_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);

    expect(
      DISCOVERY_REFERENCE.test("import { rankOffers } from '../ranking/ranking.js';"),
    ).toBe(true);
    expect(DISCOVERY_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });
});

describe('a billing customer cannot be confused with a Connect account', () => {
  it('no plan or billing module reaches the connected-account half of payments', () => {
    // Three walks, three floors. `db/merchantPlans` is the one that would go
    // missing silently: it is the smallest, and under a single total the other
    // two carry the number on its behalf.
    const entitlements = sourceFilesUnder('services/entitlements');
    const billing = sourceFilesUnder('services/billing');
    const repositories = sourceFilesUnder('db/merchantPlans');
    expect(entitlements.length, 'the entitlements walk found too few files').toBeGreaterThanOrEqual(
      5,
    );
    expect(billing.length, 'the billing walk found too few files').toBeGreaterThanOrEqual(6);
    expect(repositories.length, 'the merchantPlans walk found too few files').toBeGreaterThanOrEqual(
      4,
    );
    const files = [...entitlements, ...billing, ...repositories];
    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(
        CONNECTED_ACCOUNT_REFERENCE.test(source),
        `${file} reaches a seller's connected account; acceptance 2 forbids cross-linking it ` +
          'with a subscription billing customer',
      ).toBe(false);
    }
  });

  it('the detector actually detects — the mutation self-test', () => {
    expect(
      CONNECTED_ACCOUNT_REFERENCE.test(
        "import { readProviderAccount } from '../payments/provider-account.service.js';",
      ),
    ).toBe(true);
    expect(CONNECTED_ACCOUNT_REFERENCE.test('select * from provider_accounts')).toBe(true);
    expect(
      CONNECTED_ACCOUNT_REFERENCE.test(
        "import { getStripeClient } from '../../payments/stripe/client.js';",
      ),
    ).toBe(false);
  });

  it('the billing tables carry no column that could hold a connected account', async () => {
    const { billingCustomers, merchantSubscriptions } = await import(
      '../../db/schema/merchantPlans.js'
    );
    const { getTableColumns } = await import('drizzle-orm');
    for (const table of [billingCustomers, merchantSubscriptions]) {
      for (const name of Object.keys(getTableColumns(table))) {
        expect(
          /connect|providerAccount|accountId/i.test(name),
          `${name} is a column a connected-account id could be written into`,
        ).toBe(false);
      }
    }
    // Vacuity floor: an emptied table would satisfy the loop above.
    expect(Object.keys(getTableColumns(billingCustomers)).length).toBeGreaterThanOrEqual(6);
  });
});

describe('feature flags and entitlements stay separate', () => {
  it('the entitlement RESOLUTION reads no configuration', () => {
    // `resolve.ts` and `capabilities.ts` decide what a MERCHANT may do; a flag
    // decides what a DEPLOYMENT has switched on. Reading one to answer the other
    // would let a flag flip grant or remove a paid capability for every merchant
    // at once, with nothing in any audit trail saying so.
    for (const relative of ['services/entitlements/resolve.ts', 'services/entitlements/capabilities.ts']) {
      const raw = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(raw.length).toBeGreaterThan(500);
      const source = withoutComments(raw);
      expect(
        CONFIG_REFERENCE.test(source),
        `${relative} reads configuration; entitlements and feature flags solve different problems`,
      ).toBe(false);
    }
  });

  it('the detector actually detects — the mutation self-test', () => {
    expect(CONFIG_REFERENCE.test("import { config } from '../../config/index.js';")).toBe(true);
    expect(CONFIG_REFERENCE.test('if (config.merchantBilling.enabled) return;')).toBe(true);
    expect(CONFIG_REFERENCE.test('const at = input.at ?? new Date();')).toBe(false);
  });

  it('comment stripping does not hide a real import — the mutation self-test', () => {
    // The stripper is itself a detector: one that removed too much would make
    // every scan above pass vacuously.
    const stripped = withoutComments(
      [
        '/** A docblock naming provider_accounts, which must NOT count. */',
        "// A line comment naming provider_accounts, which must NOT count.",
        " * A continuation naming provider_accounts, which must NOT count.",
        "import { x } from '../payments/provider-account.service.js';",
      ].join('\n'),
    );
    expect(CONNECTED_ACCOUNT_REFERENCE.test(stripped)).toBe(true);
    expect(stripped.includes('docblock')).toBe(false);
    expect(stripped.includes('line comment')).toBe(false);
    expect(stripped.includes('continuation')).toBe(false);
  });
});

describe('the capability vocabulary makes the free tier structural', () => {
  it('gateable and ungateable capabilities are disjoint', () => {
    const gateable = new Set<string>(MERCHANT_ENTITLEMENT_CAPABILITIES);
    for (const ungateable of MERCHANT_UNGATEABLE_CAPABILITIES) {
      expect(
        gateable.has(ungateable),
        `${ungateable} is both gateable and ungateable; the free tier is not structural`,
      ).toBe(false);
    }
    // Vacuity floors on BOTH tuples: two empty lists are trivially disjoint.
    expect(MERCHANT_ENTITLEMENT_CAPABILITIES.length).toBeGreaterThanOrEqual(8);
    expect(MERCHANT_UNGATEABLE_CAPABILITIES.length).toBeGreaterThanOrEqual(14);
  });

  it('the ungateable list names the five things #89 says can never be paid-only', () => {
    // Not a restatement of the tuple: these five are the issue's own sentence
    // ("core safety, payments, refunds, data export and order management"), so a
    // list that drifted away from them would pass a disjointness check and fail
    // the requirement.
    for (const required of [
      'order_management',
      'refund_issuance',
      'data_export',
      'payment_onboarding',
      'financial_record_access',
    ]) {
      expect(MERCHANT_UNGATEABLE_CAPABILITIES).toContain(required);
    }
  });

  it('no forbidden benefit is a capability a plan could grant', () => {
    const gateable = new Set<string>(MERCHANT_ENTITLEMENT_CAPABILITIES);
    for (const benefit of MERCHANT_PLAN_FORBIDDEN_BENEFITS) {
      expect(gateable.has(benefit), `${benefit} is purchasable, which policy 3 forbids`).toBe(false);
    }
    expect(MERCHANT_PLAN_FORBIDDEN_BENEFITS.length).toBeGreaterThanOrEqual(10);
    expect(MERCHANT_PLAN_FORBIDDEN_BENEFITS).toContain('organic_rank');
    expect(MERCHANT_PLAN_FORBIDDEN_BENEFITS).toContain('official_status');
  });

  it('a plan is already a forbidden ranking AND relevance signal', () => {
    // #74 and #70 named it before this domain existed. Asserting it here is what
    // makes a later edit to either tuple fail in the domain that would benefit
    // from the edit, rather than only in the domain that made it.
    expect(OFFER_FORBIDDEN_RANKING_SIGNALS).toContain('merchant_subscription_plan');
    expect(SEARCH_FORBIDDEN_RELEVANCE_SIGNALS).toContain('merchant_pro_plan');
  });
});
