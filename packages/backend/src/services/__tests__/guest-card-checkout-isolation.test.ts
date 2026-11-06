/**
 * The guest card checkout path's structural boundaries (#107, ADR 0006), on
 * the Peable rail (ADR 0009 D13), asserted by SCAN rather than by fixture.
 *
 * `checkout-contact-isolation.test.ts` makes this argument for #105's contact
 * path and this file makes it for the payment one: a behavioural test can only
 * ever say "it did not this time", while a module that cannot NAME a provider
 * Customer cannot create one, a metadata composer that cannot reach a token
 * cannot put one in a provider object, and a webhook handler that cannot read a
 * rollout flag cannot strand a captured payment when somebody flips it.
 * `checkout.guest-card.realdb.test.ts` is the behavioural half: it proves the
 * metadata a guest payment really carries; this proves what the modules that
 * compose it cannot reach.
 *
 * Both defences from `~/Oxy/AGENTS.md` are carried: a vacuity floor (a moved or
 * emptied file fails the gate instead of shrinking it silently) and a mutation
 * self-test (every detector runs against seeded text that should trip it, so a
 * regex broken into matching nothing fails here rather than passing every scan).
 *
 * ## It no longer scans the storefront, and why
 *
 * Three of this gate's claims used to be about a client — "no Customer is
 * configured", "no save-my-info surface exists", "no FairCoin copy" — and it
 * walked `frontend/components/payment` for them. D13 deleted that directory
 * with the direct Stripe rail: the storefront has no card payer UI at all and
 * says card payments are unavailable. There is no client population left to
 * scan, and a wall over an empty one would report the same green as a clean
 * directory. A Peable payer UI is one of D13's open gaps; whoever builds it
 * owns bringing the client half of these walls back over it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkOwnedDirectory } from '../../__tests__/domain-population.js';

/** `packages/`, so a path below names its package explicitly. */
const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The backend modules a GUEST payment is composed in — NAMED, and honestly.
 *
 * A deliberate selection, not a population (#460's second sanctioned
 * resolution): two of them (`checkout-payment.service`, `peable-provider`) are
 * named for neither `guest` nor the rail's checkout, and the patterns that
 * would reach them pull in modules carrying the OPPOSITE obligation —
 * `guest-rollout.ts` exists to read the flag the durable half may not. The
 * exact-size assertion below is a change-detector for this list and claims
 * nothing more.
 *
 * `peable/peable-provider.ts` replaced `stripe/stripe-provider.ts` under D13:
 * it is the adapter that turns the composed metadata into the gateway request,
 * so it is where a Customer, a token or a contact value would cross the
 * boundary.
 */
const GUEST_PAYMENT_PATHS = [
  'backend/src/services/payments/checkout-payment.service.ts',
  'backend/src/services/payments/guest-correlation.ts',
  'backend/src/services/payments/peable/peable-provider.ts',
  'backend/src/services/checkout/guest-rollout.ts',
];

/**
 * The paths that decide what a payment DOES once the rail has spoken.
 *
 * Separate from the list above because they carry a different prohibition:
 * ADR 0006 G17 says a rollout flag gates ISSUANCE and nothing durable, so a
 * guest checkout switched off while an intent is open must still reach a
 * terminal state. The way to make that true is for these modules to have no way
 * to read the flag.
 *
 * WALKED, not listed (#460): a module added to `services/payments/` — a new
 * Peable event handler, a new reconciliation sweep — is under this wall by
 * default.
 *
 * ## Why this gate gets no whole-tree assertion
 *
 * There is no domain NAME to sweep for: the two modules actually named for this
 * work are `guest-correlation.ts` and `guest-rollout.ts`, so a pattern narrow
 * enough to be right would assert over two files, while `/peable/i` or
 * `/guest/i` would pull in domains carrying the OPPOSITE obligation. The walk
 * is the guarantee instead.
 */
const DURABLE_PAYMENT_PATHS = walkOwnedDirectory('services/payments').map(
  (relative) => `backend/src/${relative}`,
);

/**
 * #107's "Future OxyPay and FairCoin boundary", rules 1-5, and `AGENTS.md`'s
 * standing exclusion. No provider, no mock, no flag, no wallet screen, no quote
 * flow, no selectable option — and no COPY, which is why this one detector runs
 * against raw source rather than comment-stripped code.
 *
 * `FAIR` the CURRENCY CODE is excluded from the pattern deliberately: it is the
 * marketplace's preferred presentment currency. What is forbidden is FairCoin as
 * a payment rail.
 *
 * **This applies to the GUEST half only, since ADR 0009.** OxyPay is Peable,
 * and Peable is now Mercaria's card rail, so a durable payment module may NAME
 * the gateway and its other rail. The guest rule is untouched and is the
 * sharper one anyway: a guest has no Oxy identity, so a chain payment is not a
 * thing they could complete.
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * What the durable half is still forbidden from doing, now that naming the
 * gateway is legitimate: BUILDING the FairCoin rail. Mercaria creates
 * `rail: 'card'` intents and nothing else; the chain rail is the gateway's.
 */
/**
 * ADR 0019: the module that chooses a checkout's rail, which since FairCoin is
 * always offered names both rails. A GUEST may pay in FairCoin like anyone
 * else — the payer needs a wallet, not an Oxy session — and the modules NAMED
 * for the guest path (`guest-correlation.ts`, `guest-rollout.ts`) and the card
 * adapter still may not name it.
 */
const RAIL_CHOOSING_PATHS = new Set(['backend/src/services/payments/checkout-payment.service.ts']);

/**
 * ADR 0019: the FairCoin adapter, the seller-account module that opens a
 * seller's FairCoin half, and the opener that hands the buyer its instruction.
 */
const FAIRCOIN_RAIL_PATHS = new Set([
  'backend/src/services/payments/peable/faircoin-provider.ts',
  'backend/src/services/payments/peable/accounts.ts',
  'backend/src/services/payments/checkout-payment.service.ts',
]);

const FAIRCOIN_RAIL_CONSTRUCTION =
  /rail:\s*['"]faircoin['"]|['"]faircoin['"]\s*(?:as const)?\s*,?\s*\/\/\s*provider|PAYMENT_PROVIDER_IDS[^;]*faircoin/;

/**
 * ADR 0006 G4/G5: a guest payment creates NO provider Customer and saves NO
 * payment method.
 *
 * The pattern names the API surfaces that would create one — on the gateway's
 * SDK (`customers.create`, `setupIntents`, `paymentMethods.attach`, a
 * `customer:` or `setup_future_usage` on an intent) and the acquirer-shaped
 * spellings that preceded it — rather than the word "customer" alone. Each is a
 * specific thing somebody would have to write.
 */
const PROVIDER_CUSTOMER_REFERENCE =
  /setup_future_usage|SetupIntent|setupIntent|customerEphemeralKeySecret|CustomerSession|customerSessionClientSecret|customers\.create|paymentMethods\.attach|\bcustomer\s*:|stripeCustomerId|allowsRemovalOfLastSavedPaymentMethod|savePaymentMethod/;

/**
 * ADR 0006 B4/G7: no token, no session id, no email and no hash may reach a
 * provider object — so the modules that compose one must not be able to name
 * them.
 *
 * `guestCheckoutId` is deliberately NOT here: it is the one guest value G7 puts
 * in metadata, and it is inert (it authorizes nothing and outlives the session).
 */
const GUEST_CREDENTIAL_REFERENCE =
  /guestSessionId|guest_sessions|tokenHash|token_hash|emailHash|email_hash|emailCiphertext|magicLink|portalToken|mgs_|mgx_|mgp_/;

/**
 * ADR 0006 G16/B6: provider identity is evidence about payment instruments,
 * never about people holding Mercaria orders. A card fingerprint, a Link
 * account or a wallet identity has no Mercaria consumer, and the way to keep it
 * that way is for the payment path to have no name for one.
 */
const PROVIDER_IDENTITY_REFERENCE =
  /fingerprint|linkAccount|link_account|walletIdentity|wallet_identity|payment_method_details|billing_details/;

/**
 * ADR 0006 G17: the rollout levers gate the checkout REQUEST and nothing
 * durable. A webhook, an outbox handler or a settlement step that could read
 * one would be able to strand a captured payment.
 *
 * `config.guest` as a whole, not just the rollout block: an outbox handler
 * reading `guest.enabled` would have exactly the same effect.
 */
const GUEST_ROLLOUT_CONFIG_REFERENCE = /checkoutRollout|guest-rollout|config\.guest/;

/**
 * #107 identity rule 13 and #105's own rule: referral attribution is not a
 * buyer identity and never enters payment authority or provider metadata.
 */
const REFERRAL_REFERENCE =
  /referrals?\/|referralAttribution|referral_attributions|referral_touches|partnerId/;

/** Read a path, refusing an empty or moved file. */
function readSource(relative: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what the REACHABILITY detectors scan.
 *
 * Not a convenience: every module in these lists documents what it refuses to
 * do in exactly the vocabulary the detectors look for ("no Customer", "the
 * token never reaches the payment domain", "a card fingerprint cannot
 * authorize"). Scanning prose would make every honest explanation a violation,
 * and a gate that cries wolf gets disabled by whoever hits it next.
 *
 * The OxyPay/FairCoin detector deliberately does NOT use this: #107 excludes
 * copy as well as code, so a comment naming either is exactly what it must
 * catch.
 */
function readCode(relative: string): string {
  const stripped = readSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

/** Run one detector over one list, with the vacuity floor the list implies. */
function expectNoneOf(
  paths: readonly string[],
  pattern: RegExp,
  why: (relative: string) => string,
): void {
  let scanned = 0;
  for (const relative of paths) {
    expect(pattern.test(readCode(relative)), why(relative)).toBe(false);
    scanned += 1;
  }
  expect(scanned).toBe(paths.length);
}

describe('the guest card checkout path cannot reach what it must not', () => {
  it('scans a real population, and the durable half is the whole payment domain', () => {
    // Vacuity floors PER SHAPE (#460): `expect(scanned).toBe(LIST.length)`
    // alone holds for ANY list including an empty one, so a shrunk walk would
    // scan clean and report the same green as a domain with no violations.
    // Measured at D13: 39 modules, 7 of them the Peable rail.
    expect(
      DURABLE_PAYMENT_PATHS.length,
      'the payment-domain walk found too few modules; a shrunk population scans clean and ' +
        'reports the same green as a domain with no violations',
    ).toBeGreaterThanOrEqual(35);
    expect(
      DURABLE_PAYMENT_PATHS.filter((path) =>
        path.startsWith('backend/src/services/payments/peable/'),
      ).length,
      'the Peable rail left the payment-domain population',
    ).toBeGreaterThanOrEqual(7);
    // The guest half is a deliberate selection and stays EXACT (#448).
    expect(GUEST_PAYMENT_PATHS.length, 'the named guest half changed size').toBe(4);
    // …and every member of both is a file that exists, so a listing that has
    // started returning stale names goes red rather than handing the walls
    // paths that no longer resolve.
    for (const relative of [...GUEST_PAYMENT_PATHS, ...DURABLE_PAYMENT_PATHS]) {
      expect(readSource(relative).length, `${relative} looks empty — did it move?`).toBeGreaterThan(
        200,
      );
    }
  });

  it('no GUEST module names OxyPay or FairCoin, in code OR in copy', () => {
    let scanned = 0;
    for (const relative of GUEST_PAYMENT_PATHS.filter((path) => !RAIL_CHOOSING_PATHS.has(path))) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readSource(relative)),
        `${relative} names OxyPay or FairCoin; #107 excludes both from the guest path outright`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(GUEST_PAYMENT_PATHS.length - RAIL_CHOOSING_PATHS.size);
  });

  /**
   * The durable half's rule since ADR 0019: the FairCoin rail is built in
   * exactly ONE adapter, and the one module that chooses a checkout's rail may
   * name it. Every other durable payment module — events, the outbox,
   * settlement, refunds, reconciliation — stays rail-agnostic and reaches
   * FairCoin only through the `PaymentProvider` seam.
   */
  it('no durable payment module BUILDS the FairCoin rail outside its adapter', () => {
    let scanned = 0;
    for (const relative of DURABLE_PAYMENT_PATHS.filter((path) => !FAIRCOIN_RAIL_PATHS.has(path))) {
      expect(
        FAIRCOIN_RAIL_CONSTRUCTION.test(readSource(relative)),
        `${relative} constructs a FairCoin rail; Mercaria mints card intents only (ADR 0009)`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(DURABLE_PAYMENT_PATHS.length - FAIRCOIN_RAIL_PATHS.size);
  });

  it('creates no provider Customer and offers no payment-method saving', () => {
    expectNoneOf(
      GUEST_PAYMENT_PATHS,
      PROVIDER_CUSTOMER_REFERENCE,
      (relative) =>
        `${relative} reaches a provider Customer or a saving surface; ADR 0006 G4/G5 create neither`,
    );
  });

  it('no guest credential, token or contact value can reach a provider object', () => {
    expectNoneOf(
      GUEST_PAYMENT_PATHS,
      GUEST_CREDENTIAL_REFERENCE,
      (relative) => `${relative} names a guest credential or contact value; ADR 0006 B4 forbids it`,
    );
  });

  it('no provider identity signal is read anywhere in the payment path', () => {
    expectNoneOf(
      [...GUEST_PAYMENT_PATHS, ...DURABLE_PAYMENT_PATHS],
      PROVIDER_IDENTITY_REFERENCE,
      (relative) =>
        `${relative} reads a fingerprint, wallet or Link identity; ADR 0006 G16 makes them inert`,
    );
  });

  it('the payment path never reaches the referral domain', () => {
    expectNoneOf(
      [...GUEST_PAYMENT_PATHS, ...DURABLE_PAYMENT_PATHS],
      REFERRAL_REFERENCE,
      (relative) => `${relative} reaches the referral domain; it may never enter payment authority`,
    );
  });

  it('no durable payment path can read a guest rollout flag (ADR 0006 G17)', () => {
    expectNoneOf(
      DURABLE_PAYMENT_PATHS,
      GUEST_ROLLOUT_CONFIG_REFERENCE,
      (relative) =>
        `${relative} reads guest configuration; disabling new guest checkout must never stop a ` +
        'pending provider event reaching a terminal state',
    );
  });

  /**
   * The mutation self-test. Every detector runs against text that SHOULD trip
   * it, so a regex broken into matching nothing fails here rather than passing
   * every scan silently — and against text that must NOT, so a detector that
   * matched everything would fail too.
   */
  it('each detector actually detects, and does not over-detect', () => {
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("provider: 'oxy_pay'")).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// FairCoin checkout coming soon')).toBe(true);
    expect(FAIRCOIN_RAIL_CONSTRUCTION.test("{ rail: 'faircoin', amount }")).toBe(true);
    expect(PROVIDER_CUSTOMER_REFERENCE.test("setup_future_usage: 'off_session',")).toBe(true);
    expect(PROVIDER_CUSTOMER_REFERENCE.test('await peable.customers.create({});')).toBe(true);
    expect(PROVIDER_CUSTOMER_REFERENCE.test('this.client.setupIntents.create(params)')).toBe(true);
    expect(PROVIDER_CUSTOMER_REFERENCE.test("{ rail: 'card', customer: 'cus_1' }")).toBe(true);
    expect(PROVIDER_CUSTOMER_REFERENCE.test('customerSessionClientSecret: secret,')).toBe(true);
    expect(
      GUEST_CREDENTIAL_REFERENCE.test('metadata: { guestSessionId: actor.guestSessionId }'),
    ).toBe(true);
    expect(GUEST_CREDENTIAL_REFERENCE.test('metadata: { emailHash: hash }')).toBe(true);
    expect(PROVIDER_IDENTITY_REFERENCE.test('const f = charge.payment_method_details.card;')).toBe(
      true,
    );
    expect(GUEST_ROLLOUT_CONFIG_REFERENCE.test('if (!config.guest.enabled) return;')).toBe(true);
    expect(REFERRAL_REFERENCE.test('await recordReferralAttribution(partnerId);')).toBe(true);

    // …and the values these modules legitimately carry, which must NOT trip.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("const currency: CurrencyCode = 'FAIR';")).toBe(false);
    expect(FAIRCOIN_RAIL_CONSTRUCTION.test("{ rail: 'card', amount }")).toBe(false);
    // The ONE guest value G7 puts in metadata. A detector that caught it would
    // make the correct implementation unshippable.
    expect(GUEST_CREDENTIAL_REFERENCE.test('metadata: { guestCheckoutId }')).toBe(false);
    expect(PROVIDER_CUSTOMER_REFERENCE.test('const payment = await ensurePayment({ … });')).toBe(
      false,
    );
    expect(GUEST_ROLLOUT_CONFIG_REFERENCE.test('config.payments.peable.enabled')).toBe(false);
  });
});
