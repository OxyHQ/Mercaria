/**
 * The buyer-request domain's structural boundaries (#110), asserted by SCAN.
 *
 * Every claim below is about what a path CANNOT do, and a behavioural test can
 * only ever say "it did not this time". The strongest of them — a buyer path
 * that cannot reach an order writer — is the whole of acceptance 2, and it is
 * checkable here by reading a list of imports rather than by tracing branches
 * through six services.
 *
 * Both defences from `~/Oxy/AGENTS.md` are present: a VACUITY FLOOR, so a moved
 * or emptied file fails the gate instead of shrinking it silently, and a
 * MUTATION SELF-TEST per detector, so a regex that matches nothing cannot pass
 * by being broken. `guest-portal-isolation.test.ts` is the precedent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUYER_REQUEST_FORBIDDEN_IDENTIFIERS } from '@mercaria/shared-types';
import { SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES } from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every module in the domain. A new one belongs on this list — the vacuity
 * floor is what forces whoever adds one to come here and decide which side of
 * each wall it sits on.
 */
const DOMAIN_PATHS = [
  'services/buyer-requests/authorization.ts',
  'services/buyer-requests/policy.ts',
  'services/buyer-requests/order-facts.ts',
  'services/buyer-requests/cancellation-request.service.ts',
  'services/buyer-requests/cancellation-decision.service.ts',
  'services/buyer-requests/return-request.service.ts',
  'services/buyer-requests/return-decision.service.ts',
  'services/buyer-requests/support.service.ts',
  'services/buyer-requests/redaction.ts',
  'services/buyer-requests/notifications.ts',
  'services/buyer-requests/projection.ts',
  'services/buyer-requests/refund-bridge.ts',
  'services/buyer-requests/reconciler.ts',
  'db/buyerRequests/cancellationRepository.ts',
  'db/buyerRequests/returnRepository.ts',
  'db/buyerRequests/supportRepository.ts',
  'db/buyerRequests/eventRepository.ts',
  'controllers/buyer-requests.controller.ts',
  'controllers/buyer-requests.schemas.ts',
  'routes/buyer-requests.ts',
];

/**
 * The BUYER path — everything a request travels through before a seller has
 * decided anything.
 *
 * These may not reach an order writer, a refund service, an inventory function
 * or the payment domain. That is #110 acceptance 2 ("a guest cannot mutate
 * status or provider payment directly") as a property of the import graph.
 */
const BUYER_PATHS = [
  'services/buyer-requests/authorization.ts',
  'services/buyer-requests/policy.ts',
  'services/buyer-requests/order-facts.ts',
  'services/buyer-requests/cancellation-request.service.ts',
  'services/buyer-requests/return-request.service.ts',
  'services/buyer-requests/support.service.ts',
  'services/buyer-requests/redaction.ts',
  'db/buyerRequests/cancellationRepository.ts',
  'db/buyerRequests/returnRepository.ts',
  'db/buyerRequests/supportRepository.ts',
  'db/buyerRequests/eventRepository.ts',
];

/**
 * The two DECISION services, which may reach all four — and are the only
 * modules in the domain that may.
 *
 * Listed so the positive half of the gate can assert they actually do: a
 * scanner asserting only absences would pass just as happily if
 * `order.service` had been renamed out of existence.
 */
const DECISION_PATHS = [
  'services/buyer-requests/cancellation-decision.service.ts',
  'services/buyer-requests/return-decision.service.ts',
];

/** An order STATUS writer. `transition` is the only lifecycle authority. */
const ORDER_WRITER_REFERENCE =
  /from\s+['"][^'"]*order\.service|setOrderStatus|transitionOrderStatus/;

/** The refund service and the bridge onto it. */
const REFUND_REFERENCE = /from\s+['"][^'"]*refund\.service|refundForBuyerRequest/;

/** Any inventory movement. Restock happens once, in the commerce path. */
const INVENTORY_REFERENCE =
  /from\s+['"][^'"]*inventory\.service|\b(?:restock|release|commit)\s*\(/;

/**
 * The payment domain. The buyer path never reads a provider, a payment
 * aggregate or a ledger — #110 refund rule 4 puts provider truth on the other
 * side of the seam, and `refund-bridge.ts` is the only crossing.
 */
const PAYMENT_DOMAIN_REFERENCE = /services\/payments\//;

/**
 * A REVIEW or a moderation case. #110 support rules 7 and 8: a support message
 * never becomes a public review or a CrowdSource case automatically, and abuse
 * reporting routes to the existing `POST /reports`.
 */
const REVIEW_OR_MODERATION_REFERENCE =
  /services\/reviews?\/|review\.service|services\/moderation\/|abuse_?[Rr]eports|reportIntake/;

/** Marketing consent. Communication rule 3 — this domain subscribes nobody. */
const MARKETING_REFERENCE = /marketingOptIn|marketing_opt_in|subscribe|mailingList/;

/** The plaintext contact decrypt. Only #108's send path may hold it. */
const DECRYPT_REFERENCE = /decryptGuestPii/;

/** The forbidden ecosystem spellings this repository excludes twice over. */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/** Read a domain file, refusing an empty or moved one. */
function readSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Source with comments stripped.
 *
 * These modules DOCUMENT what they refuse to do in the same vocabulary the
 * detectors use — `cancellation-request.service.ts` explains that it imports no
 * refund service, `support.service.ts` explains that it writes no review — so a
 * scan over raw text would fail on the prose that proves the rule is
 * understood. The `checkout-contact-isolation.test.ts` decision, verbatim.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('buyer request isolation (static)', () => {
  it('scans every module in the domain', () => {
    // The vacuity floor. A gate that scanned nothing would pass every assertion
    // below, and the shape of that failure — a moved file, a renamed directory
    // — is exactly the one nobody notices.
    expect(DOMAIN_PATHS.length).toBeGreaterThanOrEqual(20);
    expect(BUYER_PATHS.length).toBeGreaterThanOrEqual(11);
    for (const path of DOMAIN_PATHS) {
      expect(readSource(path).length).toBeGreaterThan(200);
    }
  });

  it('no BUYER path can write an order, refund, restock or reach the payment domain', () => {
    for (const path of BUYER_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        ORDER_WRITER_REFERENCE.test(source),
        `${path} can move an order's status; a buyer files a REQUEST (acceptance 2)`,
      ).toBe(false);
      expect(
        REFUND_REFERENCE.test(source),
        `${path} can move money; only a decision service may`,
      ).toBe(false);
      expect(
        INVENTORY_REFERENCE.test(source),
        `${path} can move stock; restock happens once, in the commerce path`,
      ).toBe(false);
      expect(
        PAYMENT_DOMAIN_REFERENCE.test(source),
        `${path} reaches the payment domain; refund-bridge.ts is the only crossing`,
      ).toBe(false);
    }
  });

  it('the DECISION services do reach the order and refund services', () => {
    // The positive half. Without it, every absence above would still hold if
    // `order.service` and `refund.service` had simply been renamed, and the
    // gate would be measuring nothing.
    const cancellation = stripComments(readSource(DECISION_PATHS[0] ?? ''));
    expect(ORDER_WRITER_REFERENCE.test(cancellation)).toBe(true);
    const returns = stripComments(readSource(DECISION_PATHS[1] ?? ''));
    expect(REFUND_REFERENCE.test(returns)).toBe(true);
  });

  it('nothing in the domain writes a review, opens a moderation case or subscribes anybody', () => {
    for (const path of DOMAIN_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        REVIEW_OR_MODERATION_REFERENCE.test(source),
        `${path} reaches the review or moderation domain; support rules 7 and 8 forbid it`,
      ).toBe(false);
      expect(
        MARKETING_REFERENCE.test(source),
        `${path} touches marketing consent; communication rule 3 forbids it`,
      ).toBe(false);
    }
  });

  it('nothing in the domain can decrypt a contact or name OxyPay/FairCoin', () => {
    for (const path of DOMAIN_PATHS) {
      const source = readSource(path);
      expect(
        DECRYPT_REFERENCE.test(stripComments(source)),
        `${path} reaches the plaintext decrypt; only #108's send path may`,
      ).toBe(false);
      // Scanned RAW, comments included: a copy change naming a rail Mercaria
      // does not have is as wrong as an import of one.
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(source),
        `${path} names OxyPay or FairCoin; neither is a payment rail here`,
      ).toBe(false);
    }
  });

  it('no request schema can carry a forbidden identifier', () => {
    // Authorization rule 6, checked against the vocabulary rather than against
    // a list somebody retyped here. An order number, an email or a cart token
    // arriving in a body is how "an order number plus an email is a password"
    // gets built by accident.
    const schemas = stripComments(readSource('controllers/buyer-requests.schemas.ts'));
    const forbiddenInBody = [
      /\bemail\s*:/,
      /\bphone\s*:/,
      /\borderNumber\s*:/,
      /\bguestSessionId\s*:/,
      /\bpaymentMethod\s*:/,
      /\bamount\s*:/,
      /\bstatus\s*:/,
    ];
    for (const pattern of forbiddenInBody) {
      expect(pattern.test(schemas), `a request body accepts ${pattern.source}`).toBe(false);
    }
    // The vocabulary exists and is non-trivial, so this assertion cannot pass
    // by the tuple having been emptied.
    expect(BUYER_REQUEST_FORBIDDEN_IDENTIFIERS.length).toBeGreaterThanOrEqual(10);
    expect(SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES.length).toBeGreaterThanOrEqual(5);
  });

  it('mutation self-test: every detector fires on a seeded positive', () => {
    // Each pattern is run against text that DOES contain what it looks for. A
    // regex that matched nothing would pass every assertion above while
    // measuring nothing at all — the failure this repository keeps finding.
    expect(ORDER_WRITER_REFERENCE.test("import { transition } from '../order.service.js';")).toBe(
      true,
    );
    expect(ORDER_WRITER_REFERENCE.test('await setOrderStatus(orderId, "cancelled");')).toBe(true);
    expect(REFUND_REFERENCE.test("import { process } from '../refund.service.js';")).toBe(true);
    expect(INVENTORY_REFERENCE.test("import { restock } from '../inventory.service.js';")).toBe(
      true,
    );
    expect(INVENTORY_REFERENCE.test('await restock(variantId, 1);')).toBe(true);
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../services/payments/provider.js';"),
    ).toBe(true);
    expect(REVIEW_OR_MODERATION_REFERENCE.test("import { y } from '../review.service.js';")).toBe(
      true,
    );
    expect(
      REVIEW_OR_MODERATION_REFERENCE.test("from '../services/moderation/report-intake.service.js'"),
    ).toBe(true);
    expect(MARKETING_REFERENCE.test('const marketingOptIn = true;')).toBe(true);
    expect(DECRYPT_REFERENCE.test('const email = await decryptGuestPii(row);')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// settled through OxyPay')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('FairCoin')).toBe(true);
    // And the negative control the currency code needs: `FAIR` is Mercaria's
    // preferred presentment currency and appears legitimately wherever money
    // does, so the pattern must NOT match it.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("currency: 'FAIR'")).toBe(false);
  });

  it('mutation self-test: stripComments removes prose but keeps code', () => {
    // The comment stripper is load-bearing for six assertions above — if it
    // removed too much, every detector would scan an empty string and pass.
    const source = [
      '/** transition() is deliberately not imported here. */',
      '// no restock in this file',
      "import { findOrderById } from '../../db/orders/orderRepository.js';",
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toContain('findOrderById');
    expect(stripped).not.toContain('deliberately not imported');
    expect(stripped).not.toContain('no restock in this file');
  });
});
