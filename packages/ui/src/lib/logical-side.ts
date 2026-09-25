/**
 * Turning a LOGICAL side (`start` / `end`) into the PHYSICAL one a surface
 * anchored to a screen edge needs (#429 item 4).
 *
 * ## Why this exists at all
 *
 * Almost everything a mirrored layout needs is already logical, and the whole
 * point of #397/#434 is that it stays that way: `ms-`, `pe-`, `start-`,
 * `rounded-s-` and `insetInlineStart` all re-resolve on their own when the
 * direction changes, so no component has to know which way round it is.
 *
 * A side-sheet cannot be expressed that way. Bloom's `Dialog` takes a PHYSICAL
 * `placement` (`left` / `right`) and parks the sheet off screen with a physical
 * `translateX` — a CSS transform is never mirrored by `dir`, and React Native
 * applies transforms after Yoga's layout pass, so neither platform mirrors it.
 * A screen that means "the trailing edge of the reading direction" therefore
 * has to resolve that to a screen edge itself, and this is the one place that
 * does it (`./logical-dialog-placement` is its caller).
 *
 * #429 shipped two more functions here — the parked `translateX` sign and the
 * physical divider class — for the hand-rolled `Panel` and `Sheet`. Both
 * components are gone (Bloom owns the side-sheet's slide now), and the
 * functions went with them.
 *
 * ## Why it imports nothing
 *
 * The same reason `./../i18n/rtl-locales` imports nothing. A
 * `scripts/validate-*.mjs` guard is the only place a property of this module
 * can be asserted by RUNNING it, and a guard can only run a module a plain
 * `bun scripts/…` can import. Anything touching `I18nManager` or
 * `react-native` is unreachable from there, which is why READING the direction
 * lives in Bloom's `useIsRtl` and DECIDING what follows from it lives here.
 * `scripts/validate-logical-side.mjs` executes this function.
 *
 * ## What it cannot tell you
 *
 * Whether a mirrored sheet actually slides in from the correct edge. That is a
 * rendering property of a real foregrounded tab and a real device build, and
 * neither this module nor any guard nor CI runs one. It remains #429 item 2.
 */

/** Which edge of the reading direction a surface is anchored to. */
export type LogicalSide = "start" | "end";

/** Which edge of the SCREEN that resolves to, once the direction is known. */
export type PhysicalSide = "left" | "right";

/**
 * The screen edge `side` occupies when the layout direction is `rtl`.
 *
 * `start` is the left edge reading left-to-right and the right edge reading
 * right-to-left, and `end` is the other one. The guard pins this truth table
 * directly, and separately asserts that the two directions disagree.
 */
export function resolvePhysicalSide(side: LogicalSide, rtl: boolean): PhysicalSide {
  if (side === "start") {
    return rtl ? "right" : "left";
  }
  return rtl ? "left" : "right";
}
