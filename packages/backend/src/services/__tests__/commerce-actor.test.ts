/**
 * `actorRateKey` — the stable key idempotency claims and actor-aware rate
 * limits hash on (ADR 0003 D1). Pure; the resolver that PRODUCES actors is
 * tested in `middleware/__tests__/commerce-actor.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { actorRateKey, type CommerceActor } from '../commerce-actor.js';

describe('actorRateKey', () => {
  it('keys each actor kind into its own namespace', () => {
    expect(actorRateKey({ kind: 'oxy', oxyUserId: 'u1' }, '1.2.3.4')).toBe('oxy:u1');
    expect(
      actorRateKey({ kind: 'guest', guestSessionId: 'gs1', transport: 'cookie' }, '1.2.3.4'),
    ).toBe('guest:gs1');
    expect(actorRateKey({ kind: 'anonymous' }, '1.2.3.4')).toBe('ip:1.2.3.4');
  });

  it('keys off the ACTOR, not the transport — one guest is one bucket on both carriages', () => {
    const cookie: CommerceActor = { kind: 'guest', guestSessionId: 'gs1', transport: 'cookie' };
    const header: CommerceActor = { kind: 'guest', guestSessionId: 'gs1', transport: 'header' };
    expect(actorRateKey(cookie, 'a')).toBe(actorRateKey(header, 'b'));
  });

  it('ignores the IP for identified actors, so NAT churn cannot split their budget', () => {
    expect(actorRateKey({ kind: 'oxy', oxyUserId: 'u1' }, 'ip-a')).toBe(
      actorRateKey({ kind: 'oxy', oxyUserId: 'u1' }, 'ip-b'),
    );
  });
});
