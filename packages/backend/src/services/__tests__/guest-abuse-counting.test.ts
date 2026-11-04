/**
 * The ORDER of `checkGuestAbuse` (M8-03): count first, consult the friction flag
 * second.
 *
 * The M8 review found the flag read on the first line and a `return` before
 * the counter, under a docblock promising the opposite — so a deployment with
 * friction off wrote no counter, and turning friction on started from zero.
 * The real-server half of this is `guest-erasure.realdb.test.ts`, which reads
 * the counter row back; this file pins the branch order across all three
 * configurations, which a database cannot distinguish from "the row was
 * written for some other reason".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const governance = {
  abuseControlsEnabled: false,
  abuseSubjectHashKey: 'k'.repeat(64),
};

vi.mock('../../config/index.js', () => ({
  config: {
    guest: {
      get governance() {
        return governance;
      },
    },
  },
}));

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

describe('checkGuestAbuse counts whether or not friction is on (M8-03)', () => {
  it('friction OFF, key set: the attempt is COUNTED and nothing is refused', async () => {
    governance.abuseControlsEnabled = false;
    governance.abuseSubjectHashKey = 'k'.repeat(64);
    const verdict = await checkGuestAbuse({
      scope: 'session_issuance',
      subjectValue: '203.0.113.0/24',
      now: NOW,
    });
    expect(verdict).toEqual({ outcome: 'permitted' });
    expect(countAbuseAttempt).toHaveBeenCalledTimes(1);
    // An intervention IS friction; with friction off none is read or written.
    expect(findLiveIntervention).not.toHaveBeenCalled();
    expect(recordIntervention).not.toHaveBeenCalled();
  });

  it('friction ON: counts, and still reads the live intervention first', async () => {
    governance.abuseControlsEnabled = true;
    governance.abuseSubjectHashKey = 'k'.repeat(64);
    await checkGuestAbuse({ scope: 'session_issuance', subjectValue: '203.0.113.0/24', now: NOW });
    expect(findLiveIntervention).toHaveBeenCalledTimes(1);
    expect(countAbuseAttempt).toHaveBeenCalledTimes(1);
    expect(findLiveIntervention.mock.invocationCallOrder[0]).toBeLessThan(
      countAbuseAttempt.mock.invocationCallOrder[0] as number,
    );
  });

  it('no KEY: nothing is counted, because no subject can be named safely', async () => {
    governance.abuseControlsEnabled = false;
    governance.abuseSubjectHashKey = '';
    const verdict = await checkGuestAbuse({
      scope: 'session_issuance',
      subjectValue: '203.0.113.0/24',
      now: NOW,
    });
    expect(verdict).toEqual({ outcome: 'permitted' });
    expect(countAbuseAttempt).not.toHaveBeenCalled();
  });

  it('a scope no policy watches is permitted without a write', async () => {
    governance.abuseControlsEnabled = true;
    governance.abuseSubjectHashKey = 'k'.repeat(64);
    await checkGuestAbuse({ scope: 'cart_write', subjectValue: 'actor-1', now: NOW });
    expect(countAbuseAttempt).not.toHaveBeenCalled();
  });
});
