/**
 * Every path that opens a payment passes the guest P2P gate — asserted by SCAN
 * (#112 checkout behaviour 2, acceptance 6).
 *
 * ## Why this is a scan and not a behavioural test
 *
 * The property is "no path reaches the rail around the gate", and a behavioural
 * test can only ever say "these three paths did not, this time". `checkout()`
 * opens a payment from THREE places — the fresh path, the Redis idempotency
 * fast-path and the unique-violation converge — and the last two go through
 * `summarizePriorGroup`, which opens the same payment for a group it did not
 * create. When #112 first landed the gate sat inline beside the fresh-path call
 * and the other two went straight past it.
 *
 * That was harmless while `GuestP2PAuthorization` has no member meaning yes:
 * any order reachable through a converge path was created by an earlier run of
 * the same `checkout()`, which gated it at group construction. It stops being
 * harmless the moment a `go` decision makes the authorization something that
 * can change, which is precisely what the payment-stage call exists for — a
 * seller can lose readiness, a listing can be restricted and a cohort can be
 * withdrawn between order placement and the charge.
 *
 * So the fix was structural (ONE `openGatedCheckoutPayment` chokepoint) and
 * this is what keeps it structural. Both defences from `~/Oxy/AGENTS.md` are
 * here: a vacuity floor (an emptied or moved file fails rather than passing
 * against nothing) and a mutation self-test on every counter.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKOUT_SERVICE = 'services/checkout.service.ts';

/** The rail entry point. Counted as an IMPORT plus its call sites. */
const OPEN_PAYMENT = /\bopenCheckoutPayment\b/g;
/** The chokepoint that gates before delegating. */
const GATED_OPEN_PAYMENT = /\bopenGatedCheckoutPayment\b/g;
/** The payment-stage guest P2P gate. */
const PAYMENT_GATE = /\bassertGuestP2PPaymentAllowed\b/g;

/**
 * The service with comments removed — what every count below reads.
 *
 * The file DOCUMENTS this arrangement in the same vocabulary the counters look
 * for (`openGatedCheckoutPayment`'s own docblock names `openCheckoutPayment`
 * twice), so counting raw source would make an honest explanation fail the
 * gate, which is how a gate gets deleted by whoever hits it next.
 */
function checkoutServiceCode(): string {
  const source = readFileSync(join(SRC_ROOT, CHECKOUT_SERVICE), 'utf8');
  expect(source.length, `${CHECKOUT_SERVICE} looks empty — did it move?`).toBeGreaterThan(10_000);
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    'almost no code left after comment stripping — check the stripper',
  ).toBeGreaterThan(10_000);
  return stripped;
}

/** How many times a pattern occurs. */
function count(source: string, pattern: RegExp): number {
  return source.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
}

describe('no checkout path can open a payment around the guest P2P gate', () => {
  it('names the rail entry point exactly twice: the import and ONE call', () => {
    const code = checkoutServiceCode();
    // Two, and no more: `import { openCheckoutPayment }` plus the single call
    // inside `openGatedCheckoutPayment`. A third occurrence is a second path to
    // the rail, whether or not whoever added it remembered the gate.
    expect(
      count(code, OPEN_PAYMENT),
      'checkout.service.ts reaches openCheckoutPayment from more than one place; ' +
        'route it through openGatedCheckoutPayment instead',
    ).toBe(2);
  });

  it('gates inside the chokepoint, and the chokepoint is what the paths call', () => {
    const code = checkoutServiceCode();
    // Its definition plus the fresh path plus `summarizePriorGroup` — which is
    // itself reached from both converge paths.
    expect(count(code, GATED_OPEN_PAYMENT)).toBeGreaterThanOrEqual(3);
    // Exactly one payment-stage gate call, and it is the chokepoint's. A second
    // would mean a path gating itself, which is the arrangement this replaced.
    expect(count(code, PAYMENT_GATE)).toBe(2); // the import, and the one call
  });

  it('puts the gate BEFORE the rail call inside the chokepoint', () => {
    const code = checkoutServiceCode();
    const gateAt = code.search(/assertGuestP2PPaymentAllowed\(\{/);
    const railAt = code.search(/return openCheckoutPayment\(\{/);
    expect(gateAt).toBeGreaterThan(-1);
    expect(railAt).toBeGreaterThan(-1);
    expect(gateAt, 'the gate must run before the rail is opened').toBeLessThan(railAt);
  });

  it('reaches the chokepoint from the converge path, not just the fresh one', () => {
    const code = checkoutServiceCode();
    // `summarizePriorGroup` serves both converge paths and must not open a
    // payment itself. Asserted on its BODY rather than on the whole file, so a
    // future third converge path inherits the property.
    const body = code.slice(code.indexOf('async function summarizePriorGroup'));
    const end = body.indexOf('async function openGatedCheckoutPayment');
    expect(end).toBeGreaterThan(0);
    const summarize = body.slice(0, end);
    expect(summarize).toContain('openGatedCheckoutPayment');
    expect(count(summarize, OPEN_PAYMENT)).toBe(0);
  });

  /**
   * The mutation self-test. Each counter runs against text that SHOULD trip it,
   * so a pattern broken into matching nothing fails here rather than reporting
   * a clean file forever.
   */
  it('each counter actually counts (mutation self-test)', () => {
    const ungated = `
      const payment = await openCheckoutPayment({ rail, orders: prior });
      payment = await openCheckoutPayment({ rail, orders: created });
    `;
    expect(count(ungated, OPEN_PAYMENT)).toBe(2);
    expect(count(ungated, PAYMENT_GATE)).toBe(0);
    expect(count('assertGuestP2PPaymentAllowed({ actor, orders });', PAYMENT_GATE)).toBe(1);
    expect(count('await openGatedCheckoutPayment({ actor, owner });', GATED_OPEN_PAYMENT)).toBe(1);
    // …and the near-miss that must NOT count as the rail entry point: the
    // chokepoint's own name contains neither substring by accident.
    expect(count('openGatedCheckoutPayment', OPEN_PAYMENT)).toBe(0);
  });
});
