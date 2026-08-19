/**
 * The order-buyer and order-access path's structural boundaries (#106),
 * asserted by SCAN rather than by fixture.
 *
 * Each claim below is about what the path CANNOT reach, and a behavioural test
 * can only ever say "it did not this time". A module that cannot name a
 * contact ciphertext cannot leak one; a module that cannot resolve an order
 * from an email hash cannot let a matching inbox acquire somebody's purchase.
 * That is the argument `checkout-contact-isolation.test.ts` makes for the
 * contact path and `fees/__tests__/fee-ranking-isolation.test.ts` makes for
 * ranking, and this scanner carries the same two defences from
 * `~/Oxy/AGENTS.md`: a vacuity floor (a moved or emptied file fails the gate
 * instead of shrinking it silently) and a mutation self-test (each detector
 * runs against a seeded positive, so a broken regex cannot pass by matching
 * nothing).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every `.ts` under `relative`, recursively, excluding the test tree. */
function walk(relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * The buyer-identity and access path, end to end — WALKED rather than listed
 * (#460).
 *
 * ## `services/orders/` is NOT the whole path, and the gate said it was
 *
 * This comment used to read *"`services/orders/` holds exactly this path and
 * nothing else, so the walk IS the population"*. **That was false.** #106 states
 * buyer access TWICE, deliberately — an indexable SQL predicate for the list
 * route and a pure decision for the detail route — because *"two spellings of one
 * rule can disagree"*. `authorizeOrderAccess` is in `services/orders/`;
 * **`buyerOrClaimantSql` is in `db/orders/orderRepository.ts`**, and that module
 * was behind none of the three walls below.
 *
 * So the population is both directories. `db/orders/` holds exactly two modules
 * and both are this path's storage half: the order repository (which owns the
 * predicate and the `PUBLIC_STATUS_EVENT_COLUMNS` projection that withholds
 * `actor_guest_session_id`) and the refund repository.
 *
 * ## Why there is no whole-tree assertion here, unlike its sibling gates (#460)
 *
 * Every other converted gate ends with `assertNothingOutsideDomainPopulation`
 * over a name pattern. That instrument is unusable for this one and the reason is
 * worth stating rather than leaving as an omission: this path has no domain
 * TOKEN. `order-access` matches exactly ONE module in the repository, so a sweep
 * for it is vacuous; a bare `order` matches **61**, including
 * `controllers/orders.controller.ts` and `db/schema/orders.ts` — which are two of
 * the helper's own `FOREIGN_CONTROL_MODULES`, named there precisely because a
 * population containing them has swallowed the commerce core.
 *
 * `docs/isolation-gates.md` §"Domain populations" is the measured evidence that
 * no instrument decides this. What replaces the sweep here is the CALLER census
 * below: the population is checked against the modules that actually consume the
 * access decision, which is a question about this path rather than about a name.
 */
const ACCESS_DIRECTORIES = ['services/orders', 'db/orders'] as const;
const ACCESS_PATHS = ACCESS_DIRECTORIES.flatMap((relative) => walk(relative));

/**
 * The ONE module excused from the cart-credential wall, and only that wall.
 *
 * `db/orders/orderRepository.ts` names `guestSessionId` twice in code: the
 * `CartOwner`-shaped union #105 uses to find a guest's own checkouts, and the
 * `eq(guestCheckouts.guestSessionId, …)` that resolves them. That is a guest
 * reading their OWN live checkout, not a credential becoming access to somebody
 * else's order — and the module is kept under the contact and payment walls,
 * which it passes.
 *
 * Excluding it from the POPULATION instead would have cost both of those over the
 * module holding half of #106's two-spellings rule. What the exemption gives up
 * is asserted separately below: the buyer-access PREDICATE names the two Oxy id
 * columns and no guest handle.
 */
const CART_WALL_EXEMPT = 'db/orders/orderRepository.ts';

/**
 * Invariant I6 and #106 reject rules 1-2 and 5: an email — plain, normalized,
 * hashed or truncated — is never an authorization input, and no code path
 * joins orders to Oxy accounts through one. The way to make that true of this
 * path is for it to have no way to NAME one.
 *
 * `emailRedacted` is deliberately excluded from the pattern: it is the
 * display-only form (T15) that the portal view legitimately carries, and
 * catching it would make the gate flag the one contact field that exists to be
 * shown.
 */
const CONTACT_CREDENTIAL_REFERENCE =
  /emailHash|email_hash|guestEmailHash|emailCiphertext|email_ciphertext|phoneCiphertext|decryptGuestPii|normalizedEmail/;

/**
 * ADR 0003 I3 and #106 reject rule 4: a cart credential is not order access.
 * The path may hold a guest SESSION id nowhere at all — the only guest handle
 * it may name is a portal GRANT, whose scope is a checkout group.
 *
 * `guestSessionId` is what a `GuestActor` carries, and its absence from every
 * module here is why `orderAccessSubjectForCommerceActor` returning `null` for
 * a guest actor cannot be quietly worked around by reading the field a second
 * way.
 */
const CART_CREDENTIAL_REFERENCE = /guestSessionId|guest_session_id|mgs_|tokenHash/;

/**
 * The payment domain reaches orders through ONE seam (`order-linkage.ts`) and
 * this path is not it. An authorization decision that consulted a payment,
 * a ledger entry or a transfer would make "may I read this order" depend on
 * money having moved.
 */
const PAYMENT_DOMAIN_REFERENCE =
  /payments\/(?!order-linkage)|ledgerRepository|ledger_entries|paymentRepository|stripe/i;

/** Read a path in the access set, refusing an empty or moved file. */
function readAccessSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what every detector below scans.
 *
 * Not a convenience: these modules DOCUMENT what they refuse to do in exactly
 * the vocabulary the detectors look for ("the guest SESSION id never appears
 * here", "no code path joins orders to Oxy accounts via `email_hash`"), so
 * scanning prose would make every honest explanation a violation and the gate
 * would be disabled by whoever hit it next — the failure mode
 * `~/Oxy/AGENTS.md` names outright.
 */
function readAccessCode(relative: string): string {
  const stripped = readAccessSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

describe('the order-access path cannot reach what it must not (#106)', () => {
  it('no module can name a contact credential — an email is never authorization', () => {
    let scanned = 0;
    for (const relative of ACCESS_PATHS) {
      expect(
        CONTACT_CREDENTIAL_REFERENCE.test(readAccessCode(relative)),
        `${relative} names a contact credential; ADR 0003 I2/I6 forbid one as an access input`,
      ).toBe(false);
      scanned += 1;
    }
    // A real floor, not `scanned === ACCESS_PATHS.length`: that comparison is
    // circular (the loop increments once per entry, so it holds for any list
    // including an empty one) and catches a broken loop but never a shrunk
    // population. This is today's count, compared with `>=`, so a module
    // disappearing from the walk stops the build.
    expect(ACCESS_PATHS.length, 'the access-path walk found nothing').toBeGreaterThanOrEqual(4);
    for (const relative of ACCESS_PATHS) {
      expect(statSync(join(SRC_ROOT, relative)).isFile(), `${relative} is not a file`).toBe(true);
    }
    expect(ACCESS_PATHS.filter((relative) => relative.includes('__tests__'))).toEqual([]);
    expect(scanned).toBe(ACCESS_PATHS.length);
  });

  it('no module can name a CART credential — I3, and the reason the mapping returns null', () => {
    let scanned = 0;
    for (const relative of ACCESS_PATHS) {
      // ONE exemption, by exact path, and only from THIS wall — see
      // `CART_WALL_EXEMPT`. It is probed in both directions below.
      if (relative === CART_WALL_EXEMPT) continue;
      expect(
        CART_CREDENTIAL_REFERENCE.test(readAccessCode(relative)),
        `${relative} names a guest session credential; order access is a scoped GRANT (D5)`,
      ).toBe(false);
      scanned += 1;
    }
    // A real floor rather than `scanned === ACCESS_PATHS.length - 1`, which is
    // the circular comparison one subtraction later: most of the population must
    // still be scanned whatever the exemption does.
    expect(scanned, 'the cart wall scanned almost nothing').toBeGreaterThanOrEqual(3);
    expect(scanned).toBe(ACCESS_PATHS.length - 1);
  });

  it('no access decision consults the payment domain', () => {
    let scanned = 0;
    for (const relative of ACCESS_PATHS) {
      expect(
        PAYMENT_DOMAIN_REFERENCE.test(readAccessCode(relative)),
        `${relative} reaches the payment domain; reading an order must not depend on money moving`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACCESS_PATHS.length);
  });

  /**
   * The mutation self-test. Every detector above runs against text that SHOULD
   * trip it, so a regex broken into matching nothing fails here rather than
   * passing every scan silently — and against text that must NOT, so a
   * detector widened into matching everything fails too.
   */
  it('every detector actually detects, and does not over-match', () => {
    expect(CONTACT_CREDENTIAL_REFERENCE.test('const h = guestEmailHash(x);')).toBe(true);
    expect(CONTACT_CREDENTIAL_REFERENCE.test('row.emailRedacted')).toBe(false);

    expect(CART_CREDENTIAL_REFERENCE.test('actor.guestSessionId')).toBe(true);
    expect(CART_CREDENTIAL_REFERENCE.test('grant.checkoutGroupId')).toBe(false);

    expect(PAYMENT_DOMAIN_REFERENCE.test("from '../payments/payment.service.js'")).toBe(true);
    expect(PAYMENT_DOMAIN_REFERENCE.test("from '../payments/order-linkage.js'")).toBe(false);
  });
});

describe('the population the three walls are applied to (#460)', () => {
  it('covers BOTH spellings of buyer access, which is what the walk used to miss', () => {
    // #106 states buyer access twice on purpose — an indexable predicate for the
    // list route, a pure decision for the detail route — and says outright that
    // two spellings of one rule can disagree. The population held one of them.
    for (const named of [
      'services/orders/order-access.service.ts',
      'db/orders/orderRepository.ts',
    ]) {
      expect(ACCESS_PATHS, `${named} is outside all three walls`).toContain(named);
      expect(
        statSync(join(SRC_ROOT, named)).isFile(),
        `${named} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
    // Per SHAPE, because the two directories break independently.
    expect(walk('services/orders').length, 'the service walk found nothing').toBeGreaterThanOrEqual(
      3,
    );
    expect(walk('db/orders').length, 'the repository walk found nothing').toBeGreaterThanOrEqual(2);
  });

  it('and does NOT swallow the commerce core, which a name sweep would', () => {
    // The reason this gate carries no whole-tree assertion, stated as a
    // measurement. A bare `order` matches 61 modules; two of them are the
    // helper's own foreign controls, named there because a population holding
    // them has stopped being a domain.
    for (const foreign of [
      'controllers/orders.controller.ts',
      'db/schema/orders.ts',
      'routes/orders.ts',
      'services/order.service.ts',
    ]) {
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
      expect(ACCESS_PATHS, `${foreign} is not this path`).not.toContain(foreign);
    }
  });

  it('every module that CONSUMES the access decision is either in the population or another domain’s', () => {
    // What replaces the name sweep: a census over the real consumers rather than
    // over a token. Each is asserted to exist and to be covered by the gate that
    // owns it — so a new consumer appearing in a domain with no gate is the
    // thing this reports, which a name sweep for `order-access` never could.
    const consumers = [
      { path: 'db/orders/orderRepository.ts', gate: 'this one — it holds buyerOrClaimantSql' },
      { path: 'services/buyer-requests/authorization.ts', gate: "#110's buyer-request-isolation" },
      { path: 'services/guest-portal/portal.service.ts', gate: "#108's guest-portal-isolation" },
      { path: 'controllers/collection-code.controller.ts', gate: "#93's pickup-isolation" },
      { path: 'services/order-hydration.service.ts', gate: 'the order hydration path' },
    ] as const;
    expect(consumers.length, 'the consumer census is empty').toBeGreaterThanOrEqual(5);
    for (const consumer of consumers) {
      expect(
        statSync(join(SRC_ROOT, consumer.path)).isFile(),
        `${consumer.path} no longer exists — the consumer census is stale`,
      ).toBe(true);
      expect(consumer.gate.length, `${consumer.path} names no owning gate`).toBeGreaterThan(10);
    }
    // The positive control: each really does consume the decision, so the census
    // is over measured callers rather than over a list somebody wrote down.
    const CONSUMES =
      /authorizeOrderAccess|orderAccessSubjectForCommerceActor|buyerOrClaimantSql|loadBuyerContacts/;
    for (const consumer of consumers) {
      const code = readFileSync(join(SRC_ROOT, consumer.path), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(
        CONSUMES.test(code),
        `${consumer.path} no longer consumes the access decision, so listing it proves nothing`,
      ).toBe(true);
    }
  });
});

describe('the ONE cart-wall exemption is real, in both directions (#448)', () => {
  it('COULD it ever fire? the excused module is IN the population', () => {
    expect(ACCESS_PATHS).toContain(CART_WALL_EXEMPT);
    expect(statSync(join(SRC_ROOT, CART_WALL_EXEMPT)).isFile()).toBe(true);
  });

  it('DOES it still fire? the wall would go red on it without the exemption', () => {
    // A module that stopped tripping the wall is one still being excused, and
    // the excuse is then a comment claiming a decision nobody has re-made.
    expect(
      CART_CREDENTIAL_REFERENCE.test(readAccessCode(CART_WALL_EXEMPT)),
      `${CART_WALL_EXEMPT} no longer names a guest session, so excusing it is doing nothing`,
    ).toBe(true);
    // …and it is the ONLY module in the population that does.
    const others = ACCESS_PATHS.filter(
      (relative) => relative !== CART_WALL_EXEMPT && CART_CREDENTIAL_REFERENCE.test(readAccessCode(relative)),
    );
    expect(others, 'a second module needs the exemption and does not have it').toEqual([]);
  });

  it('and what the exemption gives up is asserted separately: the PREDICATE names no guest handle', () => {
    // The prohibition the cart wall exists for, applied to the exempted module
    // at the exact place it matters. ADR 0003 I3 is about a cart credential
    // becoming ACCESS; `buyerOrClaimantSql` is where that would happen, and it
    // names the two Oxy id columns and nothing else.
    const code = readAccessCode(CART_WALL_EXEMPT);
    const predicate = /function buyerOrClaimantSql\([\s\S]*?\n\}/u.exec(code)?.[0];
    expect(predicate, 'buyerOrClaimantSql is gone — the two-spellings rule moved').toBeDefined();
    if (predicate === undefined) return;
    expect(predicate).toContain('buyerOxyUserId');
    expect(predicate).toContain('claimedByOxyUserId');
    expect(
      CART_CREDENTIAL_REFERENCE.test(predicate),
      'the buyer-access predicate names a guest credential — a cart token has become order access',
    ).toBe(false);
    // POSITIVE CONTROL for the slice: the module DOES name a guest session
    // elsewhere, so an empty or mis-sliced predicate cannot pass this quietly.
    expect(CART_CREDENTIAL_REFERENCE.test(code)).toBe(true);
  });
});
