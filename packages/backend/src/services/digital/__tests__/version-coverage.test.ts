/**
 * The update-policy rule — ADR 0010 D4, #1015 acceptance criterion 5.
 *
 * `coveredVersion` and `coversVersion` are PURE over (purchased version, policy,
 * every version that exists), which is why this file needs no database and why it
 * can be exhaustive instead of illustrative: every policy is driven against every
 * interesting version shape, including the two that look like edge cases and are
 * the whole point — a version published BEFORE the one the buyer bought, and a
 * version the creator has since withdrawn.
 *
 * ## The two directions are different questions, and conflating them is the bug
 *
 * `coveredVersion` answers *"what is the newest thing this buyer may fetch"* and
 * `coversVersion` answers *"may this buyer fetch THAT"*. The tempting
 * implementation of the second is `coveredVersion(...).id === versionId`, and it is
 * wrong in a way no product page would reveal: a buyer entitled to v3 is entitled
 * to v2 and v1 as well, because what they bought does not stop being theirs when
 * something newer arrives. So there is a case below for exactly that.
 */

import { describe, expect, it } from 'vitest';
import {
  coveredVersion,
  coversVersion,
  majorVersionOf,
  type CoverableVersion,
} from '../version-coverage.js';

/** `2026-01-0N`, so publication order is legible in the test names. */
const at = (day: number): Date => new Date(Date.UTC(2026, 0, day));

const version = (
  id: string,
  major: number,
  day: number,
  state: CoverableVersion['state'] = 'superseded',
): CoverableVersion => ({ id, label: `${major}.${day}`, majorVersion: major, state, publishedAt: at(day) });

const V1 = version('v1', 1, 1);
const V1_1 = version('v1_1', 1, 2);
const V2 = version('v2', 2, 3);
const V3 = version('v3', 2, 4, 'published');

const ALL = [V1, V1_1, V2, V3];

describe('coveredVersion — what a right currently reaches', () => {
  it('answers the purchased version itself under `purchased_version_only`', () => {
    expect(coveredVersion(V1, 'purchased_version_only', ALL).id).toBe('v1');
  });

  it('answers the newest version of the SAME major under `same_major_version`', () => {
    // v1_1 and not v3: v3 is newer and is major 2, which this policy does not buy.
    expect(coveredVersion(V1, 'same_major_version', ALL).id).toBe('v1_1');
  });

  it('answers the newest version of any major under `all_future_versions`', () => {
    expect(coveredVersion(V1, 'all_future_versions', ALL).id).toBe('v3');
  });

  it('NEVER answers less than the version that was bought', () => {
    // The load-bearing default. A function that could answer "nothing" would make
    // a creator's publication schedule able to revoke a purchase — so a buyer who
    // bought the NEWEST version still gets it back under every policy, and so does
    // one whose purchase is the only version that exists.
    for (const policy of ['purchased_version_only', 'same_major_version', 'all_future_versions'] as const) {
      expect(coveredVersion(V3, policy, ALL).id, policy).toBe('v3');
      expect(coveredVersion(V1, policy, [V1]).id, policy).toBe('v1');
    }
  });

  it('skips a RESTRICTED version even under `all_future_versions`', () => {
    // Moderation is the one state that stops access. `superseded` and `withdrawn`
    // do not — ADR 0010 D7 — and the case below proves this test is not simply
    // filtering everything.
    const restricted = version('v4', 2, 5, 'restricted');
    expect(coveredVersion(V1, 'all_future_versions', [...ALL, restricted]).id).toBe('v3');
  });

  it('INCLUDES a withdrawn version, because a withdrawal is not a revocation', () => {
    const withdrawn = version('v4', 2, 5, 'withdrawn');
    expect(coveredVersion(V1, 'all_future_versions', [...ALL, withdrawn]).id).toBe('v4');
  });

  it('ignores a version that was never published', () => {
    const draft: CoverableVersion = {
      id: 'v5',
      label: '3.0',
      majorVersion: 3,
      state: 'draft',
      publishedAt: null,
    };
    expect(coveredVersion(V1, 'all_future_versions', [...ALL, draft]).id).toBe('v3');
  });
});

describe('coversVersion — whether ONE version is reachable', () => {
  it('covers the purchased version under every policy', () => {
    for (const policy of ['purchased_version_only', 'same_major_version', 'all_future_versions'] as const) {
      expect(coversVersion(V1, policy, ALL, 'v1'), policy).toBe(true);
    }
  });

  it('covers an INTERMEDIATE version, not only the newest one', () => {
    // The case `coveredVersion(...).id === versionId` would get wrong: v1_1 sits
    // between the purchase and the ceiling, and a buyer entitled to v3 is
    // entitled to it.
    expect(coversVersion(V1, 'all_future_versions', ALL, 'v1_1')).toBe(true);
    expect(coversVersion(V1, 'all_future_versions', ALL, 'v2')).toBe(true);
    expect(coversVersion(V1, 'all_future_versions', ALL, 'v3')).toBe(true);
  });

  it('refuses a version NEWER than the policy reaches', () => {
    expect(coversVersion(V1, 'purchased_version_only', ALL, 'v1_1')).toBe(false);
    expect(coversVersion(V1, 'same_major_version', ALL, 'v2')).toBe(false);
    expect(coversVersion(V1, 'same_major_version', ALL, 'v3')).toBe(false);
  });

  it('refuses a version OLDER than the one that was bought', () => {
    // A buyer who paid for v2 did not buy the v1 the creator had already replaced,
    // and handing it over would leak a release withdrawn for a reason.
    expect(coversVersion(V2, 'all_future_versions', ALL, 'v1')).toBe(false);
    expect(coversVersion(V2, 'all_future_versions', ALL, 'v1_1')).toBe(false);
  });

  it('refuses a RESTRICTED version the policy would otherwise reach', () => {
    const restricted = version('v4', 2, 5, 'restricted');
    expect(coversVersion(V1, 'all_future_versions', [...ALL, restricted], 'v4')).toBe(false);
  });

  it('refuses a version that does not exist', () => {
    expect(coversVersion(V1, 'all_future_versions', ALL, 'nope')).toBe(false);
  });
});

describe('majorVersionOf', () => {
  it('reads the leading integer', () => {
    expect(majorVersionOf('1.4')).toBe(1);
    expect(majorVersionOf('12')).toBe(12);
    expect(majorVersionOf(' 3.0.1 ')).toBe(3);
  });

  it('answers 0 for a label with no leading integer, which is a REAL answer', () => {
    // ADR 0010 D4 states this rather than leaving it to be discovered: a creator
    // numbering releases `spring-2026` gets 0 for all of them, so
    // `same_major_version` behaves as `purchased_version_only` for them.
    expect(majorVersionOf('spring-2026')).toBe(0);
    expect(majorVersionOf('v2')).toBe(0);
    expect(majorVersionOf('')).toBe(0);
  });

  it('makes `same_major_version` degrade to the purchased version for such labels', () => {
    // The consequence of the line above, asserted rather than implied.
    const a: CoverableVersion = { id: 'a', label: 'spring-2026', majorVersion: 0, state: 'superseded', publishedAt: at(1) };
    const b: CoverableVersion = { id: 'b', label: 'summer-2026', majorVersion: 0, state: 'published', publishedAt: at(2) };
    // Both are major 0, so they ARE the same major — which is the honest reading
    // of "no numbering": the policy cannot distinguish them, so it includes them.
    expect(coveredVersion(a, 'same_major_version', [a, b]).id).toBe('b');
  });
});
