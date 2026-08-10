/**
 * The walls around the price-alert domain, as SCANS rather than conventions.
 *
 * Six directions, each with the two defences `~/Oxy/AGENTS.md` requires of a
 * gate: a VACUITY FLOOR (every scanned file must exist and be non-trivial, so a
 * moved or emptied file fails the gate instead of passing it by having nothing
 * to match) and a MUTATION SELF-TEST (each detector is run against a seeded
 * positive and a seeded negative, so a regex that rotted cannot pass by matching
 * nothing).
 *
 * The reachability detectors scan COMMENT-STRIPPED source — `checkout-contact-isolation.test.ts`'s
 * rule — because these modules document what they refuse to do in exactly the
 * vocabulary the detectors look for. The FairCoin/OxyPay detector is the
 * exception and scans RAW source, COPY included, for #78's reason: a hard-coded
 * currency name in a comment or a string is how one arrives.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS,
  PRICE_ALERT_FORBIDDEN_SCOPES,
  PRICE_ALERT_SELLER_SCOPES,
  PRICE_ALERT_AVAILABILITY_REQUIREMENTS,
  PRICE_ALERT_PROXIMITY_SCOPES,
  PRICE_ALERT_COMPARISON_BASES,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every file of the domain, enumerated from the real directories. */
function enumerateDomain(): string[] {
  const roots = [
    join(SRC_ROOT, 'services', 'price-alerts'),
    join(SRC_ROOT, 'db', 'priceAlerts'),
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
  files.push(join(SRC_ROOT, 'controllers', 'price-alerts.controller.ts'));
  files.push(join(SRC_ROOT, 'routes', 'price-alerts.ts'));
  files.push(join(SRC_ROOT, 'routes', 'internal-price-alerts.ts'));
  files.push(join(SRC_ROOT, 'middleware', 'price-alert-schemas.ts'));
  files.push(join(SRC_ROOT, 'db', 'schema', 'priceAlerts.ts'));
  return files;
}

/**
 * The enumeration FLOOR, read off the real directories rather than hard-coded as
 * a list of names. A file that moves out of the domain shrinks the scanned set
 * silently, and a shrinking scan looks exactly like a clean one.
 */
const MINIMUM_DOMAIN_FILES = 14;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The fee, referral and plan domains — what may never decide whose price a buyer hears about. */
const COMMERCIAL_REFERENCE =
  /\/fees\/|fee_schedules|\/referrals\/|referral_touches|commissionAmount|merchant_plans?\b|sponsored|\/ledger|ledger_entries/;

/** A FairCoin or OxyPay assumption, in code OR in copy. */
const FAIRCOIN_REFERENCE = /FairCoin|faircoin|OxyPay|oxy_pay|oxyPay|\bFAIR\b|⊜/;

/** A CONTACT of any kind. The transactional channel is Oxy's own feed. */
const CONTACT_REFERENCE =
  /guest_checkouts|emailHash|email_hash|encryptEmail|decryptEmail|recipientEmail|toAddress|smtp|nodemailer|@aws-sdk\/client-ses|push_tokens|web_push_subscriptions/;

/** An outbound destination — notification 3's "now-unvalidated destination". */
const DESTINATION_REFERENCE =
  /destinationUrl|destination_url|affiliateTrackingTemplate|affiliate_tracking_template|buildAffiliateUrl|services\/outbound\//;

/**
 * The DELIVERY path may not evaluate a price (acceptance 6).
 *
 * Scanned over the two delivery modules only: everywhere else in the domain
 * legitimately reaches the comparison.
 */
const EVALUATION_REFERENCE =
  /qualifyAlert|evaluatePriceAlertsForProduct|insertPriceAlertTrigger|buildAlertComparison|selectEligibleOffers\(/;

/** The domain must not re-derive freshness, staleness or a TTL of its own (#68). */
const LOCAL_FRESHNESS_REFERENCE =
  /const\s+\w*(TTL|Ttl|StaleSeconds|FRESHNESS_SECONDS)\w*\s*=|function\s+isStale|OFFER_TTL_SECONDS/;

/** The organic discovery surface — the OTHER direction, as #78 and #80 both scan. */
const RANKING_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'controllers/feed.controller.ts',
  'controllers/listings.controller.ts',
  'routes/feed.ts',
  'routes/listings.ts',
  'db/catalog/listingRepository.ts',
  'services/ranking/eligibility.ts',
  'services/ranking/ranking.ts',
  'services/ranking/labels.ts',
  'services/ranking/facts.ts',
  'services/ranking/comparison.service.ts',
  'controllers/offer-comparison.controller.ts',
  'routes/offer-comparison.ts',
];

const ALERT_DOMAIN_REFERENCE =
  /price-alerts\/|priceAlerts\/|price_alerts\b|price_alert_triggers|priceAlertTriggers|qualifyAlert/;

/** The three levers, none of which may gate a durable record. */
const LEVER_REFERENCE = /config\.priceAlerts\.(enabled|evaluationEnabled|notificationsEnabled)/;

/** The modules that write the durable records a lever must never reach. */
const DURABLE_WRITERS = [
  'db/priceAlerts/priceAlertRepository.ts',
  'db/priceAlerts/priceAlertEvaluationRepository.ts',
  'db/priceAlerts/priceAlertTriggerRepository.ts',
  'db/priceAlerts/priceAlertNotificationRepository.ts',
  'services/price-alerts/evaluation.service.ts',
];

describe('the price-alert domain cannot reach what it must not', () => {
  const files = enumerateDomain();

  it('scans a domain that has not silently shrunk', () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
    for (const file of files) {
      expect(readFileSync(file, 'utf8').length, `${file} looks empty — did it move?`).toBeGreaterThan(
        200,
      );
    }
  });

  it('references no fee, referral, plan or ledger — a payment cannot decide whose price a buyer hears about', () => {
    for (const file of files) {
      expect(
        COMMERCIAL_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a commercial domain; a commission must not decide which offer notifies somebody`,
      ).toBe(false);
    }
  });

  it('names no FairCoin or OxyPay assumption, in code or in copy', () => {
    for (const file of files) {
      expect(
        FAIRCOIN_REFERENCE.test(readFileSync(file, 'utf8')),
        `${file} names FairCoin or OxyPay; an alert names ONE currency and the caller supplies it`,
      ).toBe(false);
    }
  });

  it('stores and reads NO contact of any kind', () => {
    for (const file of files) {
      expect(
        CONTACT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches a contact; the transactional channel is Oxy's own notification service`,
      ).toBe(false);
    }
  });

  it('composes no outbound destination — notification 3', () => {
    for (const file of files) {
      expect(
        DESTINATION_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches an outbound destination; a notification links to the canonical product and the offer`,
      ).toBe(false);
    }
  });

  it('defines no TTL, staleness rule or freshness lifetime of its own — that is #68', () => {
    for (const file of files) {
      expect(
        LOCAL_FRESHNESS_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} defines a local freshness rule; #68's per-source policy is the single authority`,
      ).toBe(false);
    }
  });

  it('the DELIVERY path cannot evaluate a price — acceptance 6', () => {
    // The property is an IMPORT-GRAPH fact rather than a rule somebody follows:
    // a retry re-reads the trigger row and never the offers it was derived from.
    for (const relative of [
      'services/price-alerts/delivery.service.ts',
      'services/price-alerts/delivery-dispatcher.ts',
      'services/price-alerts/notification.ts',
      'services/price-alerts/transport.ts',
    ]) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        EVALUATION_REFERENCE.test(stripComments(source)),
        `${relative} can evaluate a price; a delivery retry must never create a second trigger`,
      ).toBe(false);
    }
  });

  it('NO lever gates a durable record', () => {
    let scanned = 0;
    for (const relative of DURABLE_WRITERS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        LEVER_REFERENCE.test(stripComments(source)),
        `${relative} reads a price-alert lever; a flag must stop a LOOP and never a row`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(DURABLE_WRITERS.length);
  });

  it('is not reachable FROM the organic ranking surface either', () => {
    let scanned = 0;
    for (const relative of RANKING_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        ALERT_DOMAIN_REFERENCE.test(stripComments(source)),
        `${relative} references price alerts; how many people are waiting for a price is one join from ordering by it`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_PATHS.length);
  });
});

describe('the vocabularies are DISJOINT, so a forbidden scope has no value', () => {
  it('no forbidden scope appears in any alert vocabulary', () => {
    // A vacuity floor on the prohibition itself: an empty list passes every
    // check below while forbidding nothing.
    expect(PRICE_ALERT_FORBIDDEN_SCOPES.length).toBeGreaterThanOrEqual(8);
    const allowed = new Set<string>([
      ...PRICE_ALERT_SELLER_SCOPES,
      ...PRICE_ALERT_AVAILABILITY_REQUIREMENTS,
      ...PRICE_ALERT_PROXIMITY_SCOPES,
      ...PRICE_ALERT_COMPARISON_BASES,
    ]);
    for (const forbidden of PRICE_ALERT_FORBIDDEN_SCOPES) {
      expect(allowed.has(forbidden), `\`${forbidden}\` is both forbidden and allowed`).toBe(false);
    }
  });

  it('the schema declares no column for a forbidden scope', async () => {
    const { getTableColumns } = await import('drizzle-orm');
    const { priceAlerts } = await import('../../../db/schema/priceAlerts.js');
    const columns = Object.keys(getTableColumns(priceAlerts)).map((name) => name.toLowerCase());
    for (const forbidden of PRICE_ALERT_FORBIDDEN_SCOPES) {
      const collapsed = forbidden.replace(/_/g, '');
      expect(
        columns.some((column) => column.includes(collapsed)),
        `price_alerts has a column for the forbidden scope \`${forbidden}\``,
      ).toBe(false);
    }
  });
});

describe('the notification payload is an ALLOW-LIST, walked at runtime', () => {
  it('a REAL emitted payload carries none of the forbidden fields', async () => {
    const { priceAlertNotificationPayload } = await import('../notification.js');
    const payload = priceAlertNotificationPayload(
      {
        id: 'trigger-1',
        alertId: 'alert-1',
        offerId: 'offer-1',
        canonicalProductId: 'product-1',
        canonicalVariantId: 'variant-1',
        observedPriceVersion: 'snapshot-1',
        policyVersion: 'v1',
        basis: 'item_price',
        amount: { amount: 1_000, currency: 'EUR' },
        target: { amount: 2_000, currency: 'EUR' },
        nativeItemPrice: { amount: 1_000, currency: 'EUR' },
        quotes: [],
        offerKind: 'external',
        nativeCheckoutEligible: false,
        triggeredAt: new Date().toISOString(),
      },
      'es-ES',
    );
    // A static scan catches a DECLARED field; this catches one a serializer
    // spread in — the two gates #78 uses, for the same reason.
    expect(PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS.length).toBeGreaterThanOrEqual(8);
    for (const field of PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS) {
      expect(Object.keys(payload), `the payload carries \`${field}\``).not.toContain(field);
    }
    // The positive control: an empty payload would pass every assertion above.
    expect(Object.keys(payload).length).toBeGreaterThanOrEqual(9);
    expect(payload.canonicalProductId).toBe('product-1');
    expect(payload.offerId).toBe('offer-1');
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the commercial detector sees a fee import and not an innocent one', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/fee-plan.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from fee_schedules')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getRates } from '../fx.service.js';")).toBe(false);
  });

  it('the FairCoin detector sees the code name, the symbol and the copy', () => {
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'FAIR';")).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('// FairCoin alerts are shown first')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('label: `⊜ 12.00`')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test("const base: CurrencyCode = 'EUR';")).toBe(false);
    expect(FAIRCOIN_REFERENCE.test('a fairly ordinary comparison')).toBe(false);
  });

  it('the contact detector sees a mail client and a push registration', () => {
    expect(CONTACT_REFERENCE.test("import { SESClient } from '@aws-sdk/client-ses';")).toBe(true);
    expect(CONTACT_REFERENCE.test('select * from push_tokens')).toBe(true);
    expect(CONTACT_REFERENCE.test('const email = contact.emailHash;')).toBe(true);
    expect(CONTACT_REFERENCE.test('const alert = await findPriceAlertById(id);')).toBe(false);
  });

  it('the destination detector sees an outbound URL and not the word offer', () => {
    expect(DESTINATION_REFERENCE.test('payload.destinationUrl = offer.destinationUrl;')).toBe(true);
    expect(DESTINATION_REFERENCE.test("import { compose } from '../outbound/redirect.js';")).toBe(
      false,
    );
    expect(DESTINATION_REFERENCE.test("import { x } from '../services/outbound/redirect.js';")).toBe(
      true,
    );
    expect(DESTINATION_REFERENCE.test('const offerId = trigger.offerId;')).toBe(false);
  });

  it('the evaluation detector sees a qualification call', () => {
    expect(EVALUATION_REFERENCE.test('const verdict = qualifyAlert({ alert, candidates });')).toBe(
      true,
    );
    expect(EVALUATION_REFERENCE.test('await insertPriceAlertTrigger(input, tx);')).toBe(true);
    expect(EVALUATION_REFERENCE.test('const trigger = await findPriceAlertTrigger(id);')).toBe(
      false,
    );
  });

  it('the local-freshness detector sees a private TTL', () => {
    expect(LOCAL_FRESHNESS_REFERENCE.test('const ALERT_OFFER_TTL_SECONDS = 3600;')).toBe(true);
    expect(LOCAL_FRESHNESS_REFERENCE.test('function isStale(offer) { return false; }')).toBe(true);
    expect(
      LOCAL_FRESHNESS_REFERENCE.test('if (!mayAppearInComparison(offer.freshness)) return false;'),
    ).toBe(false);
  });

  it('the lever detector sees a durable write reading a flag', () => {
    expect(LEVER_REFERENCE.test('if (!config.priceAlerts.enabled) return;')).toBe(true);
    expect(LEVER_REFERENCE.test('if (!config.priceAlerts.evaluationEnabled) return;')).toBe(true);
    expect(LEVER_REFERENCE.test('config.priceAlerts.evaluationBatchSize')).toBe(false);
  });

  it('the reverse detector sees a price-alert import', () => {
    expect(
      ALERT_DOMAIN_REFERENCE.test("import { qualifyAlert } from '../price-alerts/qualification.js';"),
    ).toBe(true);
    expect(ALERT_DOMAIN_REFERENCE.test('select count(*) from price_alerts')).toBe(true);
    expect(ALERT_DOMAIN_REFERENCE.test("import { listOffers } from './offers/offer.service.js';")).toBe(
      false,
    );
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    const stripped = stripComments("import { x } from '../fees/y.js'; // a note");
    expect(COMMERCIAL_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* fee_schedules */').trim()).toBe('');
  });
});
