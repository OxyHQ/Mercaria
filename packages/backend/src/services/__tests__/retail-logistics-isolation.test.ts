/**
 * #126 acceptance criterion 2, asserted by SCAN and by a walk of the real
 * drizzle tables: **Mercaria contains no carrier adapter, tracking poller or
 * carrier-state mapping for this flow.**
 *
 * A behavioural test can only ever say "it did not this time". The argument,
 * the vacuity floor and the mutation self-test are
 * `retail-checkout-isolation.test.ts`'s and `fee-ranking-isolation.test.ts`'s,
 * reused deliberately rather than reinvented — a second scanner shape would be
 * a second thing to keep correct.
 *
 * Seven walls, and the reason each is a scan rather than a branch:
 *
 *  1. **No carrier client.** A `dhl.ts` or an `easypost.ts` under this domain
 *     is the whole of what acceptance 2 forbids, and it would arrive as a
 *     helpful shortcut while #159 was still open.
 *  2. **No outbound HTTP at all.** Every Moovo call goes through
 *     `moovo.port.ts`; a `fetch` here is either a carrier call or a Moovo call
 *     that skipped the port, and both are the same defect.
 *  3. **No tracking poller.** A scheduled loop asking anybody where a parcel is
 *     is Moovo's job (its ownership item 8). A timer in this domain is how one
 *     starts.
 *  4. **No carrier-state mapping.** Moovo owns *versioned carrier status
 *     normalization*; a second normalization in Mercaria disagrees with the
 *     first in the direction nobody notices.
 *  5. **No carrier, package, label or scan COLUMN**, walked over the real
 *     tables rather than grepped — a column is the durable half of the same
 *     mistake, and the walk cannot be fooled by a name the grep did not
 *     anticipate.
 *  6. **No guest portal credential and no Mercaria service credential** reach
 *     this domain (#126 privacy 3 and 4).
 *  7. **No payment-domain import.** ADR 0004 D1's separation: a supplier's
 *     dispatch is not payment truth, and a transport booking must not be able
 *     to reach a charge.
 *
 * Plus the two disjointness properties the vocabularies rest on.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  RETAIL_DELIVERY_PROMISE_KINDS,
  RETAIL_FULFILMENT_FORBIDDEN_FACTS,
  RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES,
  RETAIL_FULFILMENT_INTENT_STATUSES,
  RETAIL_FULFILMENT_MODES,
  MOOVO_TRANSPORT_PROJECTION_STATES,
} from '@mercaria/shared-types';
import {
  retailDeliveryPromises,
  retailFulfilmentIntents,
  retailFulfilmentLineAllocations,
  retailOrderRoleSnapshots,
} from '../../db/schema/index.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOMAIN_DIR = join(SRC_ROOT, 'services', 'retail-fulfilment');

/**
 * Every module in the domain, DISCOVERED rather than listed.
 *
 * `ingestion-isolation.test.ts` scans the `adapters/` directory for the same
 * reason: a hard-coded list protects the files somebody remembered, and the
 * file that breaks a wall is by definition the one nobody was thinking about.
 * Tests are excluded — this very file names the forbidden vocabulary.
 */
function domainModules(): string[] {
  return readdirSync(DOMAIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(DOMAIN_DIR, entry.name));
}

/** The domain plus the two files outside it that belong to the same wall. */
function scannedPaths(): string[] {
  return [
    ...domainModules(),
    join(SRC_ROOT, 'db', 'retailFulfilment', 'retailFulfilmentRepository.ts'),
    join(SRC_ROOT, 'db', 'schema', 'retailFulfilment.ts'),
  ];
}

/** Source with comments removed — what every REACHABILITY detector scans. */
function readCode(path: string): string {
  const source = readFileSync(path, 'utf8');
  expect(source.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${path} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(150);
  return stripped;
}

/**
 * A carrier's own client, by import or by identifier.
 *
 * Named carriers plus the label aggregators, because the realistic shortcut is
 * not writing a DHL client from scratch — it is adding `easypost` to
 * `package.json` and a twenty-line wrapper.
 */
const CARRIER_CLIENT_REFERENCE =
  /from\s+['"][^'"]*(dhl|fedex|\bups\b|usps|correos|seur|\bgls\b|\bdpd\b|royalmail|shippo|easypost|aftership|shipengine)[^'"]*['"]|\b(dhlClient|fedexClient|upsClient|easyPostClient|shippoClient|aftershipClient)\b/i;

/** Any outbound HTTP. Everything Moovo goes through the port. */
const OUTBOUND_HTTP_REFERENCE =
  /\bfetch\s*\(|\bsafeFetch\b|from\s+['"](axios|undici|node-fetch|got|node:http|node:https)['"]/;

/** A scheduled loop. A poller in this domain is how a tracking poller starts. */
const SCHEDULER_REFERENCE = /\bsetInterval\s*\(|\bsetTimeout\s*\(|\bstart[A-Za-z]*Dispatcher\b/;

/** A second normalization of a carrier's own status strings. */
const CARRIER_STATE_MAPPING_REFERENCE =
  /CARRIER_STATUS|CARRIER_STATE|carrierStatusMap|mapCarrierStatus|normali[sz]eCarrierStatus|toCarrierState/;

/** #126 privacy 3 and 4. */
const CREDENTIAL_REFERENCE =
  /guestPortalGrant|guest_portal_grants|resolveGuestPortalSubject|\bmgp_|\bmgx_|configureServiceAuth|OXY_SERVICE_KEY|serviceCredential/;

/** ADR 0004 D1: this domain never reaches the money. */
const PAYMENT_DOMAIN_REFERENCE = /services\/payments\/|db\/payments\/|\bstripe\b/i;

describe('#126 acceptance 2 — no carrier system inside Mercaria', () => {
  it('scans every module in the domain, and there are some', () => {
    // The vacuity floor. `expect([]).toEqual([])` on a broken traversal is
    // exactly what a passing scan looks like, so the count is asserted first
    // and a new module raises it deliberately.
    const paths = scannedPaths();
    expect(paths.length).toBeGreaterThanOrEqual(9);
    expect(domainModules().some((path) => path.endsWith('moovo.port.ts'))).toBe(true);
  });

  it('contains no carrier client', () => {
    for (const path of scannedPaths()) {
      expect(CARRIER_CLIENT_REFERENCE.test(readCode(path)), `${path} reaches a carrier`).toBe(
        false,
      );
    }
  });

  it('makes no outbound HTTP call of its own', () => {
    for (const path of scannedPaths()) {
      expect(OUTBOUND_HTTP_REFERENCE.test(readCode(path)), `${path} calls out directly`).toBe(
        false,
      );
    }
  });

  it('schedules nothing', () => {
    for (const path of scannedPaths()) {
      expect(SCHEDULER_REFERENCE.test(readCode(path)), `${path} runs a loop`).toBe(false);
    }
  });

  it('maps no carrier status', () => {
    for (const path of scannedPaths()) {
      expect(
        CARRIER_STATE_MAPPING_REFERENCE.test(readCode(path)),
        `${path} normalizes a carrier status`,
      ).toBe(false);
    }
  });

  it('reaches no guest portal or service credential', () => {
    for (const path of scannedPaths()) {
      expect(CREDENTIAL_REFERENCE.test(readCode(path)), `${path} reaches a credential`).toBe(
        false,
      );
    }
  });

  it('reaches no payment module', () => {
    for (const path of scannedPaths()) {
      expect(PAYMENT_DOMAIN_REFERENCE.test(readCode(path)), `${path} reaches the money`).toBe(
        false,
      );
    }
  });

  it('mutation self-test: every detector fires on source that breaks its wall', () => {
    // Without this the six assertions above would pass identically against a
    // regex that matches nothing — the "check that cannot distinguish success
    // from failure" this repository refuses. Each probe is written in the shape
    // the real violation would take.
    expect(CARRIER_CLIENT_REFERENCE.test("import DHL from '@dhl/express-sdk';")).toBe(true);
    expect(CARRIER_CLIENT_REFERENCE.test('const client = new EasyPostClient(key);')).toBe(true);
    expect(OUTBOUND_HTTP_REFERENCE.test('const r = await fetch(url);')).toBe(true);
    expect(OUTBOUND_HTTP_REFERENCE.test("import axios from 'axios';")).toBe(true);
    expect(SCHEDULER_REFERENCE.test('const t = setInterval(pollTracking, 60_000);')).toBe(true);
    expect(
      CARRIER_STATE_MAPPING_REFERENCE.test("const CARRIER_STATUS = { NT: 'in_transit' };"),
    ).toBe(true);
    expect(CREDENTIAL_REFERENCE.test('const token = grant.mgp_token;')).toBe(true);
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../payments/payment.service.js';"),
    ).toBe(false);
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../../services/payments/payment.service.js';"),
    ).toBe(true);
  });
});

describe('#126 acceptance 2 — no carrier COLUMN in the schema', () => {
  const tables = [
    retailOrderRoleSnapshots,
    retailFulfilmentIntents,
    retailFulfilmentLineAllocations,
    retailDeliveryPromises,
  ];

  /**
   * A column that would be the durable half of a carrier system.
   *
   * `tracking` and `transport` are deliberately NOT here: `moovo_transport_*`
   * is a REFERENCE to a movement another service owns, which is the whole
   * design, and banning the word would ban the seam it exists for. What is
   * banned is anything Mercaria would have to MODEL — a carrier, a package, a
   * label, a scan, a weight, a dimension, a manifest, a poll cursor.
   */
  const FORBIDDEN_COLUMN = /carrier|package|parcel|label|scan|weight|dimension|manifest|poll|proof_of_delivery|service_code/i;

  it('walks the real tables, and there are columns to walk', () => {
    const names = tables.flatMap((table) =>
      Object.values(getTableColumns(table)).map((column) => `${getTableName(table)}.${column.name}`),
    );
    // The vacuity floor for the walk. A `getTableColumns` that returned nothing
    // would pass the assertion below without inspecting a thing.
    expect(names.length).toBeGreaterThanOrEqual(40);
    const offending = names.filter((name) => FORBIDDEN_COLUMN.test(name.split('.')[1] ?? ''));
    expect(offending).toEqual([]);
  });

  it('mutation self-test: the column detector fires on the names it exists for', () => {
    for (const probe of [
      'carrier_account_id',
      'package_weight_grams',
      'shipping_label_url',
      'last_scan_status',
      'tracking_poll_cursor',
      'carrier_service_code',
    ]) {
      expect(FORBIDDEN_COLUMN.test(probe), `${probe} should be refused`).toBe(true);
    }
    // And does NOT fire on the seam columns that must survive.
    for (const probe of ['moovo_transport_request_id', 'moovo_source_reference', 'fulfilment_mode']) {
      expect(FORBIDDEN_COLUMN.test(probe), `${probe} must be permitted`).toBe(false);
    }
  });
});

describe('the vocabularies are disjoint from their prohibitions', () => {
  it('no fulfilment-intent status asserts a physical fact', () => {
    const overlap = RETAIL_FULFILMENT_INTENT_STATUSES.filter((status) =>
      (RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES as readonly string[]).includes(status),
    );
    expect(overlap).toEqual([]);
    expect(RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES.length).toBeGreaterThanOrEqual(8);
  });

  it('no recorded vocabulary names a forbidden carrier fact', () => {
    // The union of everything this domain can record, against the ten things it
    // may never record. Moovo's own projection states are included on the
    // recorded side deliberately: they are the words a BUYER uses, handed over
    // already normalized, and the test is what keeps that claim honest.
    const recorded: readonly string[] = [
      ...RETAIL_FULFILMENT_INTENT_STATUSES,
      ...RETAIL_FULFILMENT_MODES,
      ...RETAIL_DELIVERY_PROMISE_KINDS,
      ...MOOVO_TRANSPORT_PROJECTION_STATES,
    ];
    const overlap = RETAIL_FULFILMENT_FORBIDDEN_FACTS.filter((fact) => recorded.includes(fact));
    expect(overlap).toEqual([]);
    expect(RETAIL_FULFILMENT_FORBIDDEN_FACTS.length).toBeGreaterThanOrEqual(10);
    expect(recorded.length).toBeGreaterThanOrEqual(20);
  });
});
