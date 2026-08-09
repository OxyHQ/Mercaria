/**
 * The #58 seam, and the fail-closed default (#84 catalog rule 1).
 *
 * #58's matching pipeline is being built in parallel and is not on `main`. The
 * property that has to hold TODAY, and that a reviewer will look for, is that
 * the unimplemented side attaches nothing and guesses nothing — never that it
 * falls back to a title comparison so a product page looks populated, which
 * would be the name matching this issue forbids, one table over.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasCanonicalMatcher,
  registerCanonicalMatcher,
  requestCanonicalMatching,
  resetCanonicalMatcher,
  type CanonicalMatchTarget,
} from '../canonical-matcher.port.js';

const TARGETS: CanonicalMatchTarget[] = [
  { listingId: 'listing-1', productVariantId: 'variant-1' },
  { listingId: 'listing-1', productVariantId: 'variant-2' },
];

afterEach(() => {
  // A registration leaking into another file would make its fail-closed case
  // pass for the wrong reason — the one failure mode this seam has.
  resetCanonicalMatcher();
});

describe('with no matcher registered — the state on `main` today', () => {
  it('reports `matcher_unavailable` and attaches nothing', async () => {
    expect(hasCanonicalMatcher()).toBe(false);

    const outcome = await requestCanonicalMatching({ storeId: 'store-1', targets: TARGETS });

    expect(outcome.state).toBe('matcher_unavailable');
    expect(outcome.report.attached).toBe(0);
    // Every target is UNDECIDED, not zero-of-zero: the count is what tells an
    // operator that a catalogue is waiting rather than that it was empty.
    expect(outcome.report.requested).toBe(TARGETS.length);
    expect(outcome.report.undecided).toBe(TARGETS.length);
  });

  it('says `nothing_to_match` for an empty store rather than `matcher_unavailable`', async () => {
    // Two different facts, and an operator triaging "why is this shop's product
    // page empty" needs to tell them apart: a store with no listings is fine,
    // and a store whose listings nothing can match is waiting on #58.
    const outcome = await requestCanonicalMatching({ storeId: 'store-1', targets: [] });
    expect(outcome.state).toBe('nothing_to_match');
    expect(outcome.report.requested).toBe(0);
  });
});

describe('with a matcher registered — what #58 will plug in', () => {
  it('reports `matched` when every target got an answer', async () => {
    const matchNativeVariants = vi.fn().mockResolvedValue({
      requested: 2,
      attached: 2,
      undecided: 0,
    });
    registerCanonicalMatcher({ matchNativeVariants });

    expect(hasCanonicalMatcher()).toBe(true);
    const outcome = await requestCanonicalMatching({ storeId: 'store-1', targets: TARGETS });

    expect(outcome.state).toBe('matched');
    // The spy is asserted to have RECEIVED the call, not merely to exist: a
    // `vi.fn()` nobody wired in passes every assertion about its return value.
    expect(matchNativeVariants).toHaveBeenCalledWith({ storeId: 'store-1', targets: TARGETS });
  });

  it('reports `partial` when the matcher left some undecided', async () => {
    registerCanonicalMatcher({
      matchNativeVariants: vi.fn().mockResolvedValue({ requested: 2, attached: 1, undecided: 1 }),
    });
    const outcome = await requestCanonicalMatching({ storeId: 'store-1', targets: TARGETS });
    expect(outcome.state).toBe('partial');
    expect(outcome.report.undecided).toBe(1);
  });

  it('does NOT swallow a matcher that throws', async () => {
    // Attaching a catalogue to the wrong canonical products is worse than a
    // linkage that has to be retried, and the caller's resumable job already
    // knows how to record the error and leave the request claimable.
    registerCanonicalMatcher({
      matchNativeVariants: vi.fn().mockRejectedValue(new Error('matcher exploded')),
    });
    await expect(
      requestCanonicalMatching({ storeId: 'store-1', targets: TARGETS }),
    ).rejects.toThrow('matcher exploded');
  });

  it('is reset back to unavailable, so the fail-closed case is not stateful', async () => {
    registerCanonicalMatcher({
      matchNativeVariants: vi.fn().mockResolvedValue({ requested: 2, attached: 2, undecided: 0 }),
    });
    resetCanonicalMatcher();
    expect(hasCanonicalMatcher()).toBe(false);
    const outcome = await requestCanonicalMatching({ storeId: 'store-1', targets: TARGETS });
    expect(outcome.state).toBe('matcher_unavailable');
  });
});

describe('the port is narrow by construction', () => {
  it('takes ids and a store scope, and no name or threshold', async () => {
    // The fourth wall behind "no name-only automatic linkage": there is no
    // parameter through which a title, a display name or a similarity threshold
    // could reach a matcher. Asserted on the ARGUMENT the port actually passes.
    const matchNativeVariants = vi.fn().mockResolvedValue({
      requested: 1,
      attached: 1,
      undecided: 0,
    });
    registerCanonicalMatcher({ matchNativeVariants });
    await requestCanonicalMatching({
      storeId: 'store-1',
      targets: [{ listingId: 'l', productVariantId: 'v' }],
    });

    const [call] = matchNativeVariants.mock.calls;
    expect(Object.keys(call?.[0] ?? {}).sort()).toEqual(['storeId', 'targets']);
    expect(Object.keys(call?.[0]?.targets?.[0] ?? {}).sort()).toEqual([
      'listingId',
      'productVariantId',
    ]);
  });
});
