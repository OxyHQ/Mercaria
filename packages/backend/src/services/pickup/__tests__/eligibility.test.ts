/**
 * The two derivations (#93), driven as a table.
 *
 * The fixture law applies hardest here, because almost every clause is a
 * boolean and a fixture set that never flips one cannot tell a working
 * conjunction from a missing one. So the base fixture is ELIGIBLE and every
 * case flips exactly ONE fact — which is also what makes the expected reason
 * exact rather than a `toContain`.
 *
 * The staleness case is the one worth reading: it uses the LOCATION's own
 * interval, and there are two cases with the SAME age and DIFFERENT intervals,
 * because a shared deployment-wide TTL would pass a single-interval fixture and
 * fail exactly that pair (#68's prohibition, at the grain that varies).
 */

import { describe, expect, it } from 'vitest';
import {
  derivePickupEligibility,
  deriveLocationDiscoverability,
  type PickupActorFacts,
  type PickupInventoryFacts,
  type PickupLevers,
  type PickupLocationFacts,
} from '../eligibility.js';

const NOW = new Date('2026-08-10T10:00:00Z');

const OPEN_LOCATION: PickupLocationFacts = {
  publicationState: 'published',
  pickupOffered: true,
  pickupPaused: false,
  restricted: false,
  geocoded: true,
  locationActive: true,
  storeActive: true,
  schedule: {
    timezone: 'Europe/Madrid',
    hours: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      opensMinute: 9 * 60,
      closesMinute: 20 * 60,
    })),
    closures: [],
  },
};

const IN_STOCK: PickupInventoryFacts = {
  listingActive: true,
  availableQuantity: 4,
  stockConfirmedAt: new Date('2026-08-10T09:55:00Z'),
  stockConfirmationIntervalSeconds: 3_600,
};

const OXY_STORE_BUYER: PickupActorFacts = { actorKind: 'oxy', sellerType: 'store' };

const LEVERS_ON: PickupLevers = {
  storePickupEnabled: true,
  guestPickupEnabled: true,
  guestSellerActivated: false,
  guestSellerActivationRequired: false,
  guestNotificationTransportAvailable: false,
  guestNotificationTransportRequired: false,
};

describe('deriveLocationDiscoverability', () => {
  it('admits the base fixture, so every case below flips exactly one fact', () => {
    expect(deriveLocationDiscoverability(OPEN_LOCATION, IN_STOCK, NOW)).toEqual([]);
  });

  const cases: readonly [string, Partial<PickupLocationFacts>, string][] = [
    ['a draft publication', { publicationState: 'draft' }, 'location_not_published'],
    ['a withdrawn publication', { publicationState: 'withdrawn' }, 'location_not_published'],
    ['an inactive location', { locationActive: false }, 'location_not_active'],
    ['an inactive store', { storeActive: false }, 'store_unavailable'],
    ['an operator restriction', { restricted: true }, 'location_restricted'],
    ['no coordinate', { geocoded: false }, 'location_not_geocoded'],
    ['collection not offered', { pickupOffered: false }, 'pickup_not_offered'],
    ['a merchant pause', { pickupPaused: true }, 'pickup_paused'],
  ];
  for (const [label, patch, reason] of cases) {
    it(`refuses ${label}`, () => {
      expect(deriveLocationDiscoverability({ ...OPEN_LOCATION, ...patch }, IN_STOCK, NOW)).toEqual([
        reason,
      ]);
    });
  }

  it('refuses a restricted listing', () => {
    expect(
      deriveLocationDiscoverability(OPEN_LOCATION, { ...IN_STOCK, listingActive: false }, NOW),
    ).toEqual(['listing_unavailable']);
  });

  it('refuses an empty shelf', () => {
    expect(
      deriveLocationDiscoverability(OPEN_LOCATION, { ...IN_STOCK, availableQuantity: 0 }, NOW),
    ).toEqual(['no_collectable_stock']);
  });

  it('reads staleness against the LOCATION’s own interval, not a shared one', () => {
    // ONE age, TWO intervals, opposite verdicts. A deployment-wide TTL would
    // agree with whichever of these it happened to be set to and would pass a
    // fixture set that only ever used one.
    const twoHoursOld = new Date('2026-08-10T08:00:00Z');
    expect(
      deriveLocationDiscoverability(
        OPEN_LOCATION,
        { ...IN_STOCK, stockConfirmedAt: twoHoursOld, stockConfirmationIntervalSeconds: 3_600 },
        NOW,
      ),
    ).toEqual(['inventory_stale']);
    expect(
      deriveLocationDiscoverability(
        OPEN_LOCATION,
        { ...IN_STOCK, stockConfirmedAt: twoHoursOld, stockConfirmationIntervalSeconds: 86_400 },
        NOW,
      ),
    ).toEqual([]);
  });

  it('treats a FUTURE confirmation as fresh rather than as an error', () => {
    // Clock skew between a task and Postgres is real and small; refusing on it
    // would delist a location for a fact about our own clocks.
    expect(
      deriveLocationDiscoverability(
        OPEN_LOCATION,
        { ...IN_STOCK, stockConfirmedAt: new Date('2026-08-10T10:00:05Z') },
        NOW,
      ),
    ).toEqual([]);
  });

  it('refuses a location shut across the whole horizon', () => {
    expect(
      deriveLocationDiscoverability(
        {
          ...OPEN_LOCATION,
          schedule: {
            ...OPEN_LOCATION.schedule,
            // Covers the WHOLE 7-day horizon from the clock passed below, which
            // is a week earlier than the file's `NOW` precisely so both the
            // closure's end date and the horizon it has to span sit in the
            // PAST. A fixture the real clock is still travelling toward passes
            // until the day it arrives, then fails for whoever pushes that day.
            closures: [{ id: 'c', fromDate: '2026-08-01', throughDate: '2026-08-11' }],
          },
        },
        IN_STOCK,
        new Date('2026-08-03T10:00:00Z'),
      ),
    ).toEqual(['location_closed']);
  });

  it('accumulates every reason rather than stopping at the first', () => {
    // A merchant fixing one of four and reloading four times is how somebody
    // gives up.
    expect(
      deriveLocationDiscoverability(
        { ...OPEN_LOCATION, geocoded: false, pickupOffered: false },
        { ...IN_STOCK, availableQuantity: 0 },
        NOW,
      ),
    ).toEqual(['location_not_geocoded', 'no_collectable_stock', 'pickup_not_offered'].sort());
  });
});

describe('derivePickupEligibility', () => {
  const base = {
    location: OPEN_LOCATION,
    inventory: IN_STOCK,
    actor: OXY_STORE_BUYER,
    levers: LEVERS_ON,
    at: NOW,
  };

  it('admits an Oxy buyer at a healthy location', () => {
    expect(derivePickupEligibility(base)).toEqual({ verdict: 'eligible' });
  });

  it('admits a GUEST at the same location — the store guest-pickup case', () => {
    expect(
      derivePickupEligibility({ ...base, actor: { actorKind: 'guest', sellerType: 'store' } }),
    ).toEqual({ verdict: 'eligible' });
  });

  it('refuses a P2P seller for EVERY actor, which is acceptance 13', () => {
    // Store guest pickup being on cannot make P2P guest pickup reachable, and
    // there is no lever that would — #112 owns any reversal.
    for (const actorKind of ['oxy', 'guest', 'anonymous'] as const) {
      expect(
        derivePickupEligibility({ ...base, actor: { actorKind, sellerType: 'user' } }),
      ).toEqual({ verdict: 'blocked', reasons: ['p2p_pickup_not_available'] });
    }
  });

  it('refuses when the deployment lever is off', () => {
    expect(
      derivePickupEligibility({ ...base, levers: { ...LEVERS_ON, storePickupEnabled: false } }),
    ).toEqual({ verdict: 'blocked', reasons: ['store_pickup_disabled'] });
  });

  it('refuses a GUEST when only the guest lever is off, leaving Oxy alone', () => {
    const levers = { ...LEVERS_ON, guestPickupEnabled: false };
    expect(
      derivePickupEligibility({ ...base, levers, actor: { actorKind: 'guest', sellerType: 'store' } }),
    ).toEqual({ verdict: 'blocked', reasons: ['guest_pickup_disabled'] });
    // The direction #93 operations rule 10 needs: withdrawing guest collection
    // leaves authenticated collection working.
    expect(derivePickupEligibility({ ...base, levers })).toEqual({ verdict: 'eligible' });
  });

  it('refuses EVERY guest when #85 activation is demanded, because nothing can be activated', () => {
    // `guestSellerActivated` cannot be `true` today: there is no table. Turning
    // the flag on therefore refuses every guest collection BY NAME, which is
    // the fail-closed direction and the whole value of shipping the lever.
    expect(
      derivePickupEligibility({
        ...base,
        actor: { actorKind: 'guest', sellerType: 'store' },
        levers: { ...LEVERS_ON, guestSellerActivationRequired: true },
      }),
    ).toEqual({ verdict: 'blocked', reasons: ['guest_seller_not_activated'] });
  });

  it('refuses a guest when a transport is DEMANDED and none is registered', () => {
    expect(
      derivePickupEligibility({
        ...base,
        actor: { actorKind: 'guest', sellerType: 'store' },
        levers: { ...LEVERS_ON, guestNotificationTransportRequired: true },
      }),
    ).toEqual({ verdict: 'blocked', reasons: ['guest_notifications_unavailable'] });
  });

  it('admits a guest with no transport when this deployment does not demand one', () => {
    // The default. #108 ships with an EMPTY transport registry and a buyer
    // reaches their order through the pulled confirmation grant, so demanding
    // one unconditionally would make guest collection unreachable everywhere.
    expect(
      derivePickupEligibility({
        ...base,
        actor: { actorKind: 'guest', sellerType: 'store' },
        levers: { ...LEVERS_ON, guestNotificationTransportAvailable: false },
      }),
    ).toEqual({ verdict: 'eligible' });
  });

  it('refuses an unpayable seller, and IGNORES an unasked question', () => {
    expect(
      derivePickupEligibility({
        ...base,
        actor: { ...OXY_STORE_BUYER, sellerPaymentReady: false },
      }),
    ).toEqual({ verdict: 'blocked', reasons: ['seller_not_payment_ready'] });
    // `undefined` means the question was not asked — a public browse does not
    // spend an indexed read per location on it — and must not block.
    expect(
      derivePickupEligibility({ ...base, actor: { ...OXY_STORE_BUYER } }),
    ).toEqual({ verdict: 'eligible' });
  });

  it('is a SUPERSET of discoverability, never a different answer', () => {
    const blockedLocation = { ...OPEN_LOCATION, pickupPaused: true };
    const discoverability = deriveLocationDiscoverability(blockedLocation, IN_STOCK, NOW);
    const eligibility = derivePickupEligibility({ ...base, location: blockedLocation });
    expect(eligibility.verdict).toBe('blocked');
    if (eligibility.verdict !== 'blocked') return;
    for (const reason of discoverability) expect(eligibility.reasons).toContain(reason);
  });
});
