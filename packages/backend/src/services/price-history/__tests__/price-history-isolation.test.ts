/**
 * The walls around the price-history domain, as SCANS rather than conventions
 * (#78 §"Referral boundary", currency rules 8 and 9, and the #79 seam).
 *
 * Five directions, each with the two defences `~/Oxy/AGENTS.md` requires of a
 * gate: a VACUITY FLOOR (every scanned file must exist and be non-trivial, so a
 * moved or emptied file fails the gate instead of passing it by having nothing
 * to match) and a MUTATION SELF-TEST (each detector is run against a seeded
 * positive and a seeded negative, so a regex that rotted cannot pass by matching
 * nothing).
 *
 * The reachability detectors scan COMMENT-STRIPPED source — `checkout-contact-isolation.test.ts`'s
 * rule — because these modules document what they refuse to do in exactly the
 * vocabulary the detectors look for. The FairCoin/OxyPay detector is the
 * exception and scans RAW source, COPY included: #78 currency rule 9 forbids
 * FairCoin-specific *fixtures and assumptions*, and a hard-coded currency name
 * in a comment or a string is how one arrives.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICE_HISTORY_FORBIDDEN_DTO_FIELDS } from '@mercaria/shared-types';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every file of the domain, enumerated from the real directories. */
function enumerateDomain(): string[] {
  const roots = [
    join(SRC_ROOT, 'services', 'price-history'),
    join(SRC_ROOT, 'db', 'priceHistory'),
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
  files.push(join(SRC_ROOT, 'controllers', 'price-history.controller.ts'));
  files.push(join(SRC_ROOT, 'routes', 'price-history.ts'));
  files.push(join(SRC_ROOT, 'routes', 'internal-price-history.ts'));
  files.push(join(SRC_ROOT, 'middleware', 'price-history-schemas.ts'));
  files.push(join(SRC_ROOT, 'db', 'schema', 'priceHistory.ts'));
  return files;
}

/**
 * The enumeration FLOOR, read off the real directories rather than hard-coded
 * as a list of names.
 *
 * A file that moves out of the domain shrinks the scanned set silently, and a
 * shrinking scan looks exactly like a clean one — so the count is asserted, and
 * raising it when the domain grows is the point rather than an annoyance.
 */
const MINIMUM_DOMAIN_FILES = 11;

/** Strip comments, so a module that DESCRIBES what it refuses is not read as doing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Reaching the referral domain, from any direction. */
const REFERRAL_REFERENCE =
  /referrals\/|referralTouch|referral_touches|referral_partners|referralPartner|affiliateEarnings|commissionAmount|attributionId/;

/** A FairCoin or OxyPay assumption, in code OR in copy. */
const FAIRCOIN_REFERENCE = /FairCoin|faircoin|OxyPay|oxy_pay|oxyPay|\bFAIR\b|⊜/;

/** A price ALERT, a threshold or a subscription — #79's, not this domain's. */
const ALERT_REFERENCE =
  /price[_-]?alert|alert_subscriptions|watchlist|enqueueNotification\w*\(|sendNotification\w*\(|createNotification\w*\(|subscribeTo\w*\(/i;

/** Ranking — #74's, and a chart is not a signal an ordering consumes. */
const RANKING_REFERENCE =
  /(^|[/'"])(feed|search)\.service|rankingPolicy|ranking_policy_versions|scoreListing|boostScore/;

/** A payment rail — a display conversion is not a way to pay (currency rule 8). */
const PAYMENT_REFERENCE =
  /payments\/|checkout\/|stripe|Stripe|PaymentIntent|payment_provider_events|ledger_entries|createPayment\w*\(/;


const PRICE_HISTORY_REFERENCE =
  /price-history\/|priceHistory\/|offer_price_points|offer_price_snapshots|offerPricePoints|offerPriceSnapshots|derivePriceSeries|readPriceHistory/;

describe('the price-history domain cannot reach what it must not', () => {
  const files = enumerateDomain();

  it('scans a domain that has not silently shrunk', () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
    for (const file of files) {
      // The vacuity floor: an empty or moved file must fail here, not pass the
      // scans below by having nothing to match.
      expect(readFileSync(file, 'utf8').length, `${file} looks empty — did it move?`).toBeGreaterThan(
        200,
      );
    }
  });

  it('references no referral partner, commission, campaign or attribution', () => {
    for (const file of files) {
      expect(
        REFERRAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches the referral domain; a commission cannot alter a historical price`,
      ).toBe(false);
    }
  });

  it('names no FairCoin or OxyPay assumption, in code or in copy', () => {
    for (const file of files) {
      expect(
        FAIRCOIN_REFERENCE.test(readFileSync(file, 'utf8')),
        `${file} names FairCoin or OxyPay; #78 is currency-generic until a real integration defines them`,
      ).toBe(false);
    }
  });

  it('builds no price alert, threshold or subscription — that is #79', () => {
    for (const file of files) {
      expect(
        ALERT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches an alert path; #80's ProductSavePriceAlert seam stays unsupported until #79`,
      ).toBe(false);
    }
  });

  it('reads no ranking module — that is #74', () => {
    for (const file of files) {
      expect(
        RANKING_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches ranking; a chart is an answer to a buyer's question, not an ordering input`,
      ).toBe(false);
    }
  });

  it('reads no payment rail — a display conversion is not a way to pay', () => {
    for (const file of files) {
      expect(
        PAYMENT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches the payment domain; a representable currency is not a supported checkout rail`,
      ).toBe(false);
    }
  });

  it('is not reachable FROM the organic ranking surface either', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relative);
      expect(
        PRICE_HISTORY_REFERENCE.test(stripComments(source)),
        `${relative} references price history; measured price movement is one join from ranking by it`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });
});

describe('no price-history DTO can carry a referral identity', () => {
  it('the shared-types module declares none of the forbidden fields', () => {
    const source = readFileSync(
      join(SRC_ROOT, '..', '..', 'shared-types', 'src', 'price-history.ts'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(2_000);
    for (const field of PRICE_HISTORY_FORBIDDEN_DTO_FIELDS) {
      // The list itself is the one legitimate mention, so the check is on the
      // FIELD DECLARATION shape rather than on the bare name — otherwise the
      // prohibition would trip over stating itself.
      const declaration = new RegExp(`readonly\\s+${field}\\s*[?:]`);
      expect(declaration.test(source), `price-history.ts declares \`${field}\``).toBe(false);
    }
  });

  it('the forbidden list is non-empty and disjoint from what the domain does emit', () => {
    // A vacuity floor on the list itself: an empty prohibition passes every
    // check above while forbidding nothing.
    expect(PRICE_HISTORY_FORBIDDEN_DTO_FIELDS.length).toBeGreaterThanOrEqual(10);
    const emitted = ['offerId', 'observationId', 'bucketStart', 'segment', 'measure', 'value'];
    for (const field of emitted) {
      expect(PRICE_HISTORY_FORBIDDEN_DTO_FIELDS).not.toContain(field);
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the referral detector sees a real import and not an innocent one', () => {
    expect(
      REFERRAL_REFERENCE.test("import { recordTouch } from '../referrals/touch.service.js';"),
    ).toBe(true);
    expect(REFERRAL_REFERENCE.test('const commissionAmount = 0;')).toBe(true);
    expect(REFERRAL_REFERENCE.test("import { getRates } from '../fx.service.js';")).toBe(false);
  });

  it('the FairCoin detector sees the code name, the symbol and the copy', () => {
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'FAIR';")).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('// FairCoin prices are shown first')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('label: `⊜ 12.00`')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'EUR';")).toBe(false);
    // `FAIRLY` and `AFFAIR` are not the currency — a bare substring test would
    // fail the build on ordinary prose.
    expect(FAIRCOIN_REFERENCE.test('a fairly ordinary comparison')).toBe(false);
  });

  it('the alert detector sees a subscription and not a refusal that names one', () => {
    expect(ALERT_REFERENCE.test('await createPriceAlert({ productId });')).toBe(true);
    expect(ALERT_REFERENCE.test('select * from price_alerts')).toBe(true);
    expect(ALERT_REFERENCE.test("reason: 'price_alerts_not_implemented'")).toBe(true);
    expect(ALERT_REFERENCE.test('const points = derivePriceSeries(input);')).toBe(false);
  });

  it('the ranking detector sees a feed import', () => {
    expect(RANKING_REFERENCE.test("import { buildFeed } from '../feed.service.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const rankingPolicy = 1;')).toBe(true);
    expect(RANKING_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

  it('the payment detector sees a rail and not the word price', () => {
    expect(PAYMENT_REFERENCE.test("import { openCheckoutPayment } from '../payments/x.js';")).toBe(
      true,
    );
    expect(PAYMENT_REFERENCE.test('const intent = new PaymentIntent();')).toBe(true);
    expect(PAYMENT_REFERENCE.test('const itemPrice = { amount: 1, currency: "EUR" };')).toBe(false);
  });

  it('the reverse ranking detector sees a price-history import', () => {
    expect(
      PRICE_HISTORY_REFERENCE.test("import { readPriceHistory } from '../price-history/read.service.js';"),
    ).toBe(true);
    expect(PRICE_HISTORY_REFERENCE.test('select * from offer_price_points')).toBe(true);
    expect(PRICE_HISTORY_REFERENCE.test("import { listOffers } from './offers/offer.service.js';")).toBe(
      false,
    );
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    // The stripper is itself load-bearing: if it removed too much, every scan
    // above would pass vacuously.
    const stripped = stripComments("import { x } from '../referrals/y.js'; // a note");
    expect(REFERRAL_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* referrals */').trim()).toBe('');
  });
});
