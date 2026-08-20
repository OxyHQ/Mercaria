/**
 * `assertEachOf`, mutation-tested — the floor #706 exists for.
 *
 * Every converted gate inherits its floor from here, so this file is where the
 * floor is PROVEN to fire rather than merely to be present. Each case drives the
 * mutation it defends against (the list emptied, the list shrunk, the floor
 * zeroed) and asserts the helper throws; the two positive controls assert it
 * does NOT throw on a healthy list and that it genuinely visits every member,
 * because a helper that quietly skipped the callback would satisfy every
 * negative case above while asserting nothing at the forty-odd call sites.
 */

import { describe, expect, it } from 'vitest';
import { assertEachOf } from './assert-each-of.js';

describe('assertEachOf', () => {
  it('runs the assertion for every member, in order', () => {
    const seen: Array<[string, number]> = [];
    assertEachOf(['a', 'b', 'c'], 3, (item, index) => {
      seen.push([item, index]);
    });
    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('propagates a failing assertion rather than swallowing it', () => {
    expect(() =>
      assertEachOf(['a', 'b'], 2, (item) => {
        expect(item, 'the body ran').toBe('a');
      }),
    ).toThrow(/the body ran/);
  });

  /**
   * #691's defect verbatim: the array replaced with `[]`.
   *
   * Before this helper the loop body simply never ran and the file stayed green.
   */
  it('refuses an emptied list', () => {
    let ran = false;
    expect(() =>
      assertEachOf([] as string[], 3, () => {
        ran = true;
      }),
    ).toThrow(/at least 3/);
    expect(ran, 'the callback ran for a list that should have been refused').toBe(false);
  });

  /** The half a plain non-empty check misses: entries removed, not all of them. */
  it('refuses a list that shrank below its floor', () => {
    expect(() => assertEachOf(['a'], 3, () => undefined)).toThrow(/has 1 entries and needs at least 3/);
  });

  /**
   * The floor may not be zero, and this is what makes the requirement real.
   *
   * `[].length >= 0` holds, so a zero floor admits exactly the empty list above
   * — the original defect two tokens away from the fix's own spelling.
   */
  it('refuses a floor of zero, so an emptied list cannot be excused by zeroing it', () => {
    expect(() => assertEachOf([] as string[], 0, () => undefined)).toThrow(/floor of zero/);
    expect(() => assertEachOf(['a'], 0, () => undefined)).toThrow(/floor of zero/);
  });

  /** A floor BELOW the length is legal — it is a floor, not a pin. */
  it('admits a list longer than its floor, so adding an entry needs no edit here', () => {
    const seen: string[] = [];
    assertEachOf(['a', 'b', 'c', 'd'], 3, (item) => {
      seen.push(item);
    });
    expect(seen).toHaveLength(4);
  });
});
