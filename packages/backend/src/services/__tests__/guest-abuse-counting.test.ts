/**
 * The ORDER of `checkGuestAbuse` (M8-03): every watched attempt is COUNTED.
 *
 * The M8 review found a friction flag read on the first line and a `return`
 * before the counter, under a docblock promising the opposite — so a deployment
 * with friction off wrote no counter, and turning friction on started from
 * zero. There is no flag any more: the subject-digest key is derived from
 * `MERCARIA_SECRET_KEY`, so a subject can always be named, and friction is
 * applied by the published policy. The real-server half of this is
 * `guest-erasure.realdb.test.ts`, which reads the counter row back; this file
 * pins the branch order, which a database cannot distinguish from "the row was
 * written for some other reason".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/postgres.js', () => ({ getDb: () => ({}) }));

const countAbuseAttempt = vi.fn(async () => 1);
const findLiveIntervention = vi.fn(async () => null);
const recordIntervention = vi.fn(async () => undefined);
vi.mock('../../db/guestGovernance/abuseRepository.js', () => ({
  countAbuseAttempt: (...args: unknown[]) => countAbuseAttempt(...(args as [])),
  findLiveIntervention: (...args: unknown[]) => findLiveIntervention(...(args as [])),
  recordIntervention: (...args: unknown[]) => recordIntervention(...(args as [])),
}));

vi.mock('../guest-governance/security-signals.service.js', () => ({
  recordSecuritySignal: () => undefined,
}));

const { checkGuestAbuse } = await import('../guest-governance/abuse.service.js');

const NOW = new Date('2026-08-10T12:00:00.000Z');

beforeEach(() => {
  countAbuseAttempt.mockClear();
  findLiveIntervention.mockClear();
  recordIntervention.mockClear();
});

describe('checkGuestAbuse counts every watched attempt (M8-03)', () => {
  it('below the threshold: the attempt is COUNTED and nothing is refused', async () => {
    const verdict = await checkGuestAbuse({
      scope: 'session_issuance',
      subjectValue: '203.0.113.0/24',
      now: NOW,
    });
    expect(verdict).toEqual({ outcome: 'permitted' });
    expect(countAbuseAttempt).toHaveBeenCalledTimes(1);
    expect(recordIntervention).not.toHaveBeenCalled();
  });

  it('counts, and reads the live intervention first', async () => {
    await checkGuestAbuse({ scope: 'session_issuance', subjectValue: '203.0.113.0/24', now: NOW });
    expect(findLiveIntervention).toHaveBeenCalledTimes(1);
    expect(countAbuseAttempt).toHaveBeenCalledTimes(1);
    expect(findLiveIntervention.mock.invocationCallOrder[0]).toBeLessThan(
      countAbuseAttempt.mock.invocationCallOrder[0] as number,
    );
  });

  it('at the threshold: the published policy applies friction', async () => {
    countAbuseAttempt.mockImplementationOnce(async () => Number.MAX_SAFE_INTEGER);
    const verdict = await checkGuestAbuse({
      scope: 'session_issuance',
      subjectValue: '203.0.113.0/24',
      now: NOW,
    });
    expect(verdict.outcome).toBe('friction');
    expect(recordIntervention).toHaveBeenCalledTimes(1);
  });

  it('a scope no policy watches is permitted without a write', async () => {
    await checkGuestAbuse({ scope: 'cart_write', subjectValue: 'actor-1', now: NOW });
    expect(countAbuseAttempt).not.toHaveBeenCalled();
  });
});
