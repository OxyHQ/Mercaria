/**
 * An assertion loop over a HAND-WRITTEN list, carrying the floor that list needs.
 *
 * ## The defect (#706)
 *
 * A gate asserts something about each member of a list written inline in the
 * `for` header:
 *
 *     for (const foreign of ['services/supplier-orders/submission.service.ts']) {
 *       expect(population, `${foreign} belongs to another domain`).not.toContain(foreign);
 *     }
 *
 * Replace the array with `[]` and the body never runs, so the whole clause
 * asserts nothing — and nothing goes red. The array is the thing being defended
 * and the loop is its only reader, so **both shrink together**. That is
 * `expect(scanned).toBe(LIST.length)` (#460's founding defect) in a different
 * costume, and it is not hypothetical: #691 shipped one, and emptying its array
 * left all 26 tests in the file green. #697 fixed that single instance by moving
 * it to `assertDirectoriesAreFlat` in `domain-population.ts`, which carries its
 * floor so the next caller cannot forget it. This is the same remedy, generic.
 *
 * ## Why it needs a helper rather than a convention
 *
 * An INLINE array literal has no identifier, so nothing can floor it — there is
 * no `LIST.length` to assert on. Writing the floor therefore means naming the
 * list first, which is a two-step edit at every site and reads as ceremony, so
 * it does not get done. Passing the count as an ARGUMENT keeps the number beside
 * the entries it counts, where a reader can check it by counting.
 *
 * ## Why the floor is MANDATORY, and why it may not be zero
 *
 * An OPTIONAL floor reproduces the defect one layer up: a caller who omitted it
 * looks exactly like a caller who had nothing to floor, and only the author
 * knows which. So it is a required positional parameter — the type refuses a
 * call without one.
 *
 * And it is refused BELOW ONE, which is the half that makes the requirement
 * real. `[].length >= 0` is true, so a `floor` of zero admits precisely the
 * empty array this exists to refuse, and `assertEachOf([], 0, …)` would be a
 * two-token edit away from the original defect wearing the fix's name.
 *
 * ## What the number should be
 *
 * **Today's count.** These lists are hand-written sets of named things, so the
 * only direction that moves silently is SHRINKAGE — an addition passes a `>=`
 * floor freely and needs no edit here. A floor at the count therefore is not the
 * "pin wearing a floor's name" that `OutsidePopulationOptions.sweepFloor`
 * warns about: that warning is about a DERIVED sweep, whose count grows on its
 * own and where a floor at today's value makes "bump the number" the cheapest
 * green for a legitimate change. Nothing grows this list except a person editing
 * these very lines.
 *
 * What the floor buys against a deletion is not that it is impossible — it is
 * that removing a member now forces the number down in the same diff, so a
 * narrowing that was invisible becomes a visible one somebody has to justify.
 *
 * ## What it deliberately does NOT do
 *
 * It takes no position on whether the list is the RIGHT list, and it cannot: a
 * hand list of sibling-domain modules is a claim about the tree that no
 * derivation could produce (`docs/isolation-gates.md` §"Domain populations").
 * It also cannot tell that `assertOne` asserts anything — a callback with an
 * empty body is a loop with an empty body. This closes exactly one hole: the
 * list going empty, or shrinking, without a reader noticing.
 */

import { expect } from 'vitest';

/**
 * Run `assertOne` over every member of `items`, refusing a list that has fallen
 * below `floor`.
 *
 * @param items    the hand-written list — normally an array literal written here
 * @param floor    the smallest length that still defends what this loop defends;
 *                 set it to today's count, and it must be at least 1
 * @param assertOne what is asserted about one member
 */
export function assertEachOf<T>(
  items: readonly T[],
  floor: number,
  assertOne: (item: T, index: number) => void,
): void {
  expect(
    floor,
    'a floor of zero admits the empty list this floor exists to refuse — pass the number of ' +
      'entries the loop below needs in order to defend what it defends',
  ).toBeGreaterThanOrEqual(1);
  expect(
    items.length,
    `this list has ${items.length} entries and needs at least ${floor} — entries were removed ` +
      'without the floor beside them being moved, so the loop below now defends less than it did',
  ).toBeGreaterThanOrEqual(floor);
  items.forEach((item, index) => {
    assertOne(item, index);
  });
}
