/**
 * The walls around the price-signal domain, as SCANS rather than conventions
 * (#82 statistical policy 10, §"Recommendations", acceptance 5 and 6).
 *
 * Seven directions, each with the two defences `~/Oxy/AGENTS.md` requires of a
 * gate: a VACUITY FLOOR (every scanned file must exist and be non-trivial, so a
 * moved or emptied file fails the gate instead of passing it by having nothing to
 * match) and a MUTATION SELF-TEST (each detector is run against a seeded positive
 * and a seeded negative, so a regex that rotted cannot pass by matching nothing).
 *
 * The reachability detectors scan COMMENT-STRIPPED source, because these modules
 * document what they refuse to do in exactly the vocabulary the detectors look
 * for. The FairCoin/OxyPay detector is the exception and scans RAW source, COPY
 * included: a hard-coded currency name in a comment or a string is how a
 * currency-generic domain acquires a favourite.
 *
 * ## The direction that matters most is the REVERSE one
 *
 * #82 acceptance 6: "price signals do not alter organic ranking except through
 * the separately defined, transparent policy in #74". #74 already forbids its own
 * modules reaching fees, referrals, plans and commissions; this extends that wall
 * to competitiveness, because a merchant's measured position is one join from
 * "merchants who price aggressively rank higher" — an undocumented ranking input
 * wearing the name of a dashboard metric.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS,
  PRICE_SIGNAL_FORBIDDEN_INPUTS,
  PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS,
  PRICE_SIGNAL_INPUTS,
  PRICE_SIGNAL_RECOMMENDATION_KINDS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every file of the domain, enumerated from the real directories. */
function enumerateDomain(): string[] {
  const roots = [
    join(SRC_ROOT, 'services', 'price-signals'),
    join(SRC_ROOT, 'db', 'priceSignals'),
  ];
  const files: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) continue;
      if (!entry.endsWith('.ts')) continue;
      files.push(full);
    }
  }
  files.push(join(SRC_ROOT, 'controllers', 'price-signals.controller.ts'));
  files.push(join(SRC_ROOT, 'routes', 'price-signals.ts'));
  files.push(join(SRC_ROOT, 'routes', 'merchant-competitiveness.ts'));
  files.push(join(SRC_ROOT, 'routes', 'internal-price-signals.ts'));
  files.push(join(SRC_ROOT, 'middleware', 'price-signal-schemas.ts'));
  files.push(join(SRC_ROOT, 'db', 'schema', 'priceSignals.ts'));
  return files;
}

/**
 * The enumeration FLOOR, read off the real directories rather than hard-coded as
 * a list of names.
 *
 * A file that moves out of the domain shrinks the scanned set silently, and a
 * shrinking scan looks exactly like a clean one — so the count is asserted, and
 * raising it when the domain grows is the point rather than an annoyance.
 */
const MINIMUM_DOMAIN_FILES = 17;

/** Every module of #74's ranking domain — the REVERSE direction. */
function enumerateRanking(): string[] {
  const root = join(SRC_ROOT, 'services', 'ranking');
  return readdirSync(root)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(root, entry));
}

const MINIMUM_RANKING_FILES = 10;

/** Strip comments, so a module that DESCRIBES what it refuses is not read as doing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A commercial term reaching a calculation — statistical policy 10. */
const COMMERCIAL_REFERENCE =
  /services\/fees\/|services\/referrals\/|services\/retail-pricing\/|db\/fees\/|db\/ledger|ledger_entries|ledgerRepository|feeSchedule|fee_schedules|commissionAmount|commissionRate|merchantPlan|planTier|affiliateEarnings|sponsoredPlacement/;

/** A FairCoin or OxyPay assumption, in code OR in copy. */
const FAIRCOIN_REFERENCE = /FairCoin|faircoin|OxyPay|oxy_pay|oxyPay|\bFAIR\b|⊜/;

/**
 * A catalogue WRITE — "do not automatically change merchant prices".
 *
 * The `catalog-write.service` import is the one that matters; the rest are the
 * spellings a later reader would reach for first.
 */
const CATALOG_WRITE_REFERENCE =
  /catalog-write\.service|updateListing\(|updateVariant\(|setVariantPrice|applyPriceChange|repriceOffer/;

/**
 * A BUYER-side measurement — a click, a conversion, an order, a session.
 *
 * This domain reads what SELLERS published and nothing about who bought. That is
 * why #77's suppress-below-ten posture has nothing here to apply to, and it is
 * why the `demand_without_native_offer` seam refuses rather than reaching for a
 * save count.
 */
const BUYER_MEASUREMENT_REFERENCE =
  /analytics_events|analyticsEvents|recordAnalyticsEvent|emitAnalyticsEvent|readTopQueries|product_save_aggregates|productSaveAggregates|db\/orders\/|orderRepository|conversionRate/;

/**
 * The ranking modules this domain may NOT import.
 *
 * The admission half — `eligibility.ts`, `facts.ts`, `money.ts` — is deliberately
 * permitted and is the whole point of the narrowing: eligibility is #74's single
 * authority over "may this offer appear", and a second spelling here would be
 * wrong for exactly as long as the two disagreed. What must stay unreachable is
 * the POLICY, the SCORE, the LABELS and the dominance detector — anything that
 * decides an ORDER. #74 narrowed #55's gate to one module for the same reason.
 */
const RANKING_SCORING_REFERENCE =
  /ranking\/policy(\.service)?\.js|ranking\/ranking\.js|ranking\/labels\.js|ranking\/dominance\.js|ranking\/comparison\.service\.js|rankOffers|rankOfferComparison|resolveRankingPolicy|BUILTIN_RANKING_POLICY/;

/** The price-signal domain, seen from anywhere else. */
const PRICE_SIGNAL_REFERENCE =
  /price-signals\/|priceSignals\/|price_signal_evaluations|priceSignalEvaluations|derivePriceSignals|readMerchantCompetitiveness|competitiveness/i;

/** Reading the RECORDING as though it were a serving cache. */
const EVALUATION_READ_REFERENCE =
  /listEvaluationsForSubject|priceSignalEvaluations|price_signal_evaluations/;

/** The two live read paths, which must derive and never select a recorded verdict. */
const LIVE_READ_PATHS = [
  'services/price-signals/read.service.ts',
  'services/price-signals/competitiveness.service.ts',
  'services/price-signals/signals.ts',
  'services/price-signals/context.service.ts',
];

describe('the price-signal domain cannot reach what it must not', () => {
  const files = enumerateDomain();

  it('scans a domain that has not silently shrunk', () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
    for (const file of files) {
      // The vacuity floor: an empty or moved file must fail here, not pass the
      // scans below by having nothing to match.
      expect(
        readFileSync(file, 'utf8').length,
        `${file} looks empty — did it move?`,
      ).toBeGreaterThan(200);
    }
  });

  it('reads no fee, referral, retail-margin, ledger, plan or commission', () => {
    for (const file of files) {
      expect(
        COMMERCIAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a commercial term; statistical policy 10 forbids one entering a signal`,
      ).toBe(false);
    }
  });

  it('names no FairCoin or OxyPay assumption, in code or in copy', () => {
    for (const file of files) {
      expect(
        FAIRCOIN_REFERENCE.test(readFileSync(file, 'utf8')),
        `${file} names FairCoin or OxyPay; a signal names the currency its CALLER asked for`,
      ).toBe(false);
    }
  });

  it('writes no catalogue price — a recommendation is informational', () => {
    for (const file of files) {
      expect(
        CATALOG_WRITE_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a catalogue write; "do not automatically change merchant prices"`,
      ).toBe(false);
    }
  });

  it('reads no buyer-side measurement — no click, conversion, order or save', () => {
    for (const file of files) {
      expect(
        BUYER_MEASUREMENT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reads buyer behaviour; this domain measures what SELLERS published`,
      ).toBe(false);
    }
  });

  it('reaches #74 only through the ADMISSION half, never the score', () => {
    for (const file of files) {
      expect(
        RANKING_SCORING_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches #74's scoring; only eligibility.ts, facts.ts and money.ts are permitted`,
      ).toBe(false);
    }
  });

  it('serves no read from the recorded evaluations — they are evidence, not a cache', () => {
    let scanned = 0;
    for (const relative of LIVE_READ_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        EVALUATION_READ_REFERENCE.test(stripComments(source)),
        `${relative} reads a recorded evaluation; a cached "good price" survives the ` +
          `moderation restriction that should have withdrawn it`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(LIVE_READ_PATHS.length);
  });
});

describe('a competitiveness score can never become a ranking input (acceptance 6)', () => {
  const rankingFiles = enumerateRanking();

  it('scans a ranking domain that has not silently shrunk', () => {
    expect(rankingFiles.length).toBeGreaterThanOrEqual(MINIMUM_RANKING_FILES);
    for (const file of rankingFiles) {
      expect(
        readFileSync(file, 'utf8').length,
        `${file} looks empty — did it move?`,
      ).toBeGreaterThan(200);
    }
  });

  it('no ranking module references the price-signal domain', () => {
    for (const file of rankingFiles) {
      expect(
        PRICE_SIGNAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} references price signals; a measured position is one join from ` +
          `"merchants who price aggressively rank higher"`,
      ).toBe(false);
    }
  });
});

describe('the prohibitions are stated as VALUES a test can walk', () => {
  it('the forbidden inputs are disjoint from the allowed ones, and neither is empty', () => {
    expect(PRICE_SIGNAL_INPUTS.length).toBeGreaterThanOrEqual(8);
    expect(PRICE_SIGNAL_FORBIDDEN_INPUTS.length).toBeGreaterThanOrEqual(8);
    const allowed = new Set<string>(PRICE_SIGNAL_INPUTS);
    for (const forbidden of PRICE_SIGNAL_FORBIDDEN_INPUTS) {
      expect(allowed.has(forbidden)).toBe(false);
    }
  });

  it('the forbidden recommendations are disjoint from the allowed ones', () => {
    expect(PRICE_SIGNAL_RECOMMENDATION_KINDS.length).toBeGreaterThanOrEqual(4);
    expect(PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set<string>(PRICE_SIGNAL_RECOMMENDATION_KINDS);
    for (const forbidden of PRICE_SIGNAL_FORBIDDEN_RECOMMENDATIONS) {
      expect(allowed.has(forbidden)).toBe(false);
    }
  });

  it('the competitiveness DTO declares none of the forbidden fields', () => {
    const source = readFileSync(
      join(SRC_ROOT, '..', '..', 'shared-types', 'src', 'price-signals.ts'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(2_000);
    expect(MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS.length).toBeGreaterThanOrEqual(12);
    for (const field of MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS) {
      // The list itself is the one legitimate mention, so the check is on the
      // FIELD DECLARATION shape rather than on the bare name — otherwise the
      // prohibition would trip over stating itself.
      const declaration = new RegExp(`readonly\\s+${field}\\s*[?:]`);
      expect(declaration.test(source), `price-signals.ts declares \`${field}\``).toBe(false);
    }
  });

  it('the forbidden field list is disjoint from what the domain DOES emit', () => {
    // A vacuity floor on the list itself: a prohibition that accidentally named
    // an emitted field would fail every response walk instead of catching a leak.
    const emitted = ['kind', 'state', 'subject', 'sample', 'value', 'reason', 'offerId'];
    for (const field of emitted) {
      expect(MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS).not.toContain(field);
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the commercial detector sees a fee import and not an innocent one', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planFees } from '../fees/fee.service.js';"),
    ).toBe(false);
    expect(
      COMMERCIAL_REFERENCE.test("import { planFees } from '../../services/fees/fee.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const commissionRate = 0.1;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const merchantPlan = readPlan();')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getRates } from '../fx.service.js';")).toBe(false);
  });

  it('the FairCoin detector sees the code name, the symbol and the copy', () => {
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'FAIR';")).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('// FairCoin prices are labelled first')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('label: `⊜ 12.00`')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'EUR';")).toBe(false);
    // `FAIRLY` and `AFFAIR` are not the currency — a bare substring test would
    // fail the build on ordinary prose.
    expect(FAIRCOIN_REFERENCE.test('a fairly ordinary comparison')).toBe(false);
  });

  it('the catalogue-write detector sees a reprice and not the word price', () => {
    expect(
      CATALOG_WRITE_REFERENCE.test("import { updateListing } from '../catalog-write.service.js';"),
    ).toBe(true);
    expect(CATALOG_WRITE_REFERENCE.test('await setVariantPrice(variantId, 1000);')).toBe(true);
    expect(CATALOG_WRITE_REFERENCE.test('const itemPrice = entry.amount;')).toBe(false);
  });

  it('the buyer-measurement detector sees an analytics read and not a sample count', () => {
    expect(BUYER_MEASUREMENT_REFERENCE.test('await readTopQueries({ storeId });')).toBe(true);
    expect(BUYER_MEASUREMENT_REFERENCE.test('select * from analytics_events')).toBe(true);
    expect(BUYER_MEASUREMENT_REFERENCE.test('const observations = kept.length;')).toBe(false);
  });

  it('the ranking-scoring detector sees the score and PERMITS the admission half', () => {
    expect(
      RANKING_SCORING_REFERENCE.test("import { rankOffers } from '../ranking/ranking.js';"),
    ).toBe(true);
    expect(
      RANKING_SCORING_REFERENCE.test("import { resolveRankingPolicy } from '../ranking/policy.service.js';"),
    ).toBe(true);
    // The three permitted modules must NOT trip it, or the narrowing would be a
    // prohibition on the thing this domain is required to reuse.
    expect(
      RANKING_SCORING_REFERENCE.test("import { selectEligibleOffers } from '../ranking/eligibility.js';"),
    ).toBe(false);
    expect(
      RANKING_SCORING_REFERENCE.test("import { buildOfferRankingFacts } from '../ranking/facts.js';"),
    ).toBe(false);
    expect(
      RANKING_SCORING_REFERENCE.test("import { convertOfferMoney } from '../ranking/money.js';"),
    ).toBe(false);
  });

  it('the reverse detector sees a price-signal import from a ranking module', () => {
    expect(
      PRICE_SIGNAL_REFERENCE.test(
        "import { derivePriceSignals } from '../price-signals/signals.js';",
      ),
    ).toBe(true);
    expect(PRICE_SIGNAL_REFERENCE.test('const competitivenessBoost = 0.2;')).toBe(true);
    expect(PRICE_SIGNAL_REFERENCE.test("import { listOffers } from '../offers/offer.service.js';")).toBe(
      false,
    );
  });

  it('the evaluation-read detector sees a select and not a write', () => {
    expect(EVALUATION_READ_REFERENCE.test('await listEvaluationsForSubject(key, 10);')).toBe(true);
    expect(EVALUATION_READ_REFERENCE.test('select * from price_signal_evaluations')).toBe(true);
    expect(EVALUATION_READ_REFERENCE.test('const signals = derivePriceSignals(input);')).toBe(false);
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    // The stripper is itself load-bearing: if it removed too much, every scan
    // above would pass vacuously.
    const stripped = stripComments(
      "import { x } from '../../services/fees/y.js'; // a note",
    );
    expect(COMMERCIAL_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* services/fees/ */').trim()).toBe('');
  });
});
