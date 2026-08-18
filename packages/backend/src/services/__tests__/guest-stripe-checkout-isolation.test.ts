/**
 * The guest Stripe checkout path's structural boundaries (#107, ADR 0006),
 * asserted by SCAN rather than by fixture.
 *
 * `checkout-contact-isolation.test.ts` makes this argument for #105's contact
 * path and this file makes it for the payment one: a behavioural test can only
 * ever say "it did not this time", while a module that cannot NAME a Stripe
 * Customer cannot create one, a metadata composer that cannot reach a token
 * cannot put one in a provider object, and a webhook handler that cannot read a
 * rollout flag cannot strand a captured payment when somebody flips it.
 *
 * Both defences from `~/Oxy/AGENTS.md` are carried: a vacuity floor (a moved or
 * emptied file fails the gate instead of shrinking it silently) and a mutation
 * self-test (every detector runs against seeded text that should trip it, so a
 * regex broken into matching nothing fails here rather than passing every scan).
 *
 * ## It scans the STOREFRONT too
 *
 * Three of these claims are about a client — "no Customer is configured", "no
 * save-my-info surface exists", "no FairCoin copy" — and the client is where
 * they would be broken, by adding one option to a Stripe SDK call. The
 * storefront has no test runner of its own, which is the same reason
 * `seller-identity-isolation.test.ts` reaches across the package boundary.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkOwnedDirectory } from '../../__tests__/domain-population.js';

/** `packages/`, so a path below can name either package explicitly. */
const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The guest Stripe checkout path, end to end, across both packages.
 *
 * A new module in this path belongs on the list; the vacuity floor is what
 * forces whoever adds one to look here.
 */
const GUEST_PAYMENT_PATHS = [
  'backend/src/services/payments/checkout-payment.service.ts',
  'backend/src/services/payments/guest-correlation.ts',
  'backend/src/services/payments/stripe/stripe-provider.ts',
  'backend/src/services/checkout/guest-rollout.ts',
  'frontend/components/payment/CardPaymentStep.tsx',
  'frontend/components/payment/CardPaymentStep.native.tsx',
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
 * WALKED, not listed (#460). It was NINE hand-named paths and the domain is
 * **44** modules: the list held three of the thirteen under
 * `services/payments/stripe/`, so `event-dispatcher.ts`, `verify.ts`,
 * `account.service.ts` and seven more — every one of them a durable path a
 * captured payment travels — could have read the rollout flag with nothing
 * saying so. Measured before widening: **zero of the 44 trip the detector**, so
 * this is a widening rather than a false wall.
 *
 * ## Why this gate gets no whole-tree assertion
 *
 * #460's device does not fit here and forcing it would produce something broad
 * and green. The population is a deliberate CROSS-PACKAGE selection — paths
 * relative to `packages/`, naming backend modules and storefront components —
 * while the shared `assertNothingOutsideDomainPopulation` derives one relative
 * to `packages/backend/src`. And there is no domain NAME to sweep for: the two
 * modules actually named for this work are `guest-correlation.ts` and
 * `guest-rollout.ts`, so a pattern narrow enough to be right would assert over
 * two files, while `/stripe/i` or `/guest/i` would pull in domains carrying the
 * OPPOSITE obligation — `guest-rollout.ts` exists to read the flag these
 * modules may not.
 *
 * What the walk above buys instead is the same guarantee for the half that has
 * a directory: a module added to `services/payments/` is under this wall by
 * default.
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
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * ADR 0006 G4/G5: a guest payment creates NO Stripe Customer and saves NO
 * payment method, and neither client surface can offer saving — the Payment
 * Element's save flows and PaymentSheet's "Save my info" checkbox exist only
 * when a Customer and a CustomerSession are configured, so configuring none is
 * what removes the surface.
 *
 * The pattern names the API surfaces that would create one, rather than the
 * word "customer" alone: `customerId`, a `customer:` option on an intent, a
 * `SetupIntent`, `setup_future_usage`, an ephemeral key. Each is a specific
 * thing somebody would have to write.
 */
const STRIPE_CUSTOMER_REFERENCE =
  /setup_future_usage|SetupIntent|setupIntent|customerEphemeralKeySecret|CustomerSession|customerSessionClientSecret|customers\.create|stripeCustomerId|allowsRemovalOfLastSavedPaymentMethod|savePaymentMethod/;

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
 * buyer identity and never enters payment authority or Stripe metadata.
 */
const REFERRAL_REFERENCE =
  /referrals?\/|referralAttribution|referral_attributions|referral_touches|partnerId/;

/** Read a path in either package, refusing an empty or moved file. */
function readSource(relative: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what the REACHABILITY detectors scan.
 *
 * Not a convenience: every module in these lists documents what it refuses to
 * do in exactly the vocabulary the detectors look for ("no Stripe Customer",
 * "the token never reaches the payment domain", "a card fingerprint cannot
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

describe('the guest Stripe checkout path cannot reach what it must not', () => {
  it('no module names OxyPay or FairCoin, in code OR in copy', () => {
    let scanned = 0;
    for (const relative of [...GUEST_PAYMENT_PATHS, ...DURABLE_PAYMENT_PATHS]) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readSource(relative)),
        `${relative} names OxyPay or FairCoin; #107 excludes both outright`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(GUEST_PAYMENT_PATHS.length + DURABLE_PAYMENT_PATHS.length);
  });

  it('creates no Stripe Customer and offers no payment-method saving', () => {
    expectNoneOf(
      GUEST_PAYMENT_PATHS,
      STRIPE_CUSTOMER_REFERENCE,
      (relative) =>
        `${relative} reaches a Stripe Customer or a saving surface; ADR 0006 G4/G5 create neither`,
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
    expect(STRIPE_CUSTOMER_REFERENCE.test("setup_future_usage: 'off_session',")).toBe(true);
    expect(STRIPE_CUSTOMER_REFERENCE.test('await stripe.customers.create({});')).toBe(true);
    expect(STRIPE_CUSTOMER_REFERENCE.test('customerSessionClientSecret: secret,')).toBe(true);
    expect(GUEST_CREDENTIAL_REFERENCE.test('metadata: { guestSessionId: actor.guestSessionId }')).toBe(
      true,
    );
    expect(GUEST_CREDENTIAL_REFERENCE.test("metadata: { emailHash: hash }")).toBe(true);
    expect(PROVIDER_IDENTITY_REFERENCE.test('const f = charge.payment_method_details.card;')).toBe(
      true,
    );
    expect(GUEST_ROLLOUT_CONFIG_REFERENCE.test('if (!config.guest.enabled) return;')).toBe(true);
    expect(REFERRAL_REFERENCE.test('await recordReferralAttribution(partnerId);')).toBe(true);

    // …and the values these modules legitimately carry, which must NOT trip.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("const currency: CurrencyCode = 'FAIR';")).toBe(false);
    // The ONE guest value G7 puts in metadata. A detector that caught it would
    // make the correct implementation unshippable.
    expect(GUEST_CREDENTIAL_REFERENCE.test('metadata: { guestCheckoutId }')).toBe(false);
    expect(STRIPE_CUSTOMER_REFERENCE.test('const payment = await ensurePayment({ … });')).toBe(
      false,
    );
    expect(GUEST_ROLLOUT_CONFIG_REFERENCE.test('config.payments.stripe.enabled')).toBe(false);
  });
});
