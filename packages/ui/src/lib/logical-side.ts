/**
 * Turning a LOGICAL side (`start` / `end`) into the physical facts a sliding
 * panel needs (#429 item 4).
 *
 * ## Why this exists at all
 *
 * Almost everything a mirrored layout needs is already logical, and the whole
 * point of #397/#434 is that it stays that way: `ms-`, `pe-`, `start-`,
 * `rounded-s-` and `insetInlineStart` all re-resolve on their own when the
 * direction changes, so no component has to know which way round it is.
 *
 * Two things in a sliding panel cannot be expressed that way, and this module is
 * exactly those two:
 *
 *   * **`translateX` is physical on BOTH platforms.** On web it compiles to a
 *     CSS transform, and CSS transforms are never mirrored by `dir`. On native
 *     it is applied after layout, and React Native consults `I18nManager`
 *     nowhere under `Libraries/StyleSheet` or `Libraries/Animated` — Yoga's RTL
 *     mirroring is a LAYOUT pass and does not reach a transform. So a panel
 *     anchored to the trailing edge slides out to `+distance` in an LTR
 *     document and to `-distance` in an RTL one, and the sign has to be
 *     computed.
 *
 *   * **The divider on a panel's inner edge has no logical spelling that
 *     survives.** `border-s-*` / `border-e-*` compile to `borderInlineStartWidth`
 *     and friends, which React Native 0.85.3 does not register — they appear
 *     nowhere under `node_modules/react-native/Libraries` — so the border renders
 *     in a browser and SILENTLY DISAPPEARS on iOS and Android. That is #429
 *     item 3, an upstream capability rather than debt, and the workaround is to
 *     keep the physical class and choose it from the resolved direction.
 *     Choosing it HERE is what keeps that workaround to one file with one
 *     reason, instead of one reasoned exception per component per branch.
 *
 * Anything a logical utility can already express is deliberately NOT here. The
 * anchor inset is `insetInlineStart` / `insetInlineEnd` (registered by RN 0.85.3
 * and passed through as a real CSS logical property by react-native-web 0.21.2),
 * and the inner corner radius is `rounded-s-` / `rounded-e-`, both chosen from
 * the LOGICAL side alone with no direction read at all.
 *
 * ## Why it imports nothing
 *
 * The same reason `./../i18n/rtl-locales` imports nothing. None of the four
 * client packages has a test runner, so a `scripts/validate-*.mjs` guard is the
 * only place a property of theirs can be asserted — and a guard can only run a
 * module a plain `bun scripts/…` can import. Anything touching `I18nManager` or
 * `react-native` is unreachable from there, which is why READING the direction
 * lives in `./use-layout-direction` and DECIDING what follows from it lives
 * here. `scripts/validate-logical-side.mjs` executes these four functions.
 *
 * ## What it cannot tell you
 *
 * Whether a mirrored sheet actually slides in from the correct edge. That is a
 * rendering property of a real foregrounded tab and a real device build, and
 * neither this module nor any guard nor CI runs one. It remains #429 item 2.
 */

/** Which edge of the reading direction a panel is anchored to. */
export type LogicalSide = "start" | "end";

/** Which edge of the SCREEN that resolves to, once the direction is known. */
export type PhysicalSide = "left" | "right";

/**
 * The screen edge `side` occupies when the layout direction is `rtl`.
 *
 * The whole content of this module: `start` is the left edge reading
 * left-to-right and the right edge reading right-to-left, and `end` is the other
 * one. Every other function here is derived from it, so a bug in it is a bug in
 * all of them at once — which is why the guard pins this truth table directly
 * rather than only its consequences.
 */
export function resolvePhysicalSide(side: LogicalSide, rtl: boolean): PhysicalSide {
  if (side === "start") {
    return rtl ? "right" : "left";
  }
  return rtl ? "left" : "right";
}

/**
 * The other logical edge.
 *
 * A panel anchored at one edge presents its INNER face at the opposite one — the
 * face carrying the divider and the rounded corner — and that relationship is
 * itself logical, so both follow from this without consulting the direction.
 */
export function oppositeLogicalSide(side: LogicalSide): LogicalSide {
  return side === "start" ? "end" : "start";
}

/**
 * How far to translate a panel anchored at `side` to park it entirely off
 * screen, given a positive `distance` (its own width).
 *
 * Positive moves right on both platforms; see the module docblock for why that
 * is true of a transform even in a mirrored layout. `Math.abs` is applied so a
 * caller that already negated the width cannot double-negate it — the parked
 * position is a function of the side, never of the sign the caller happened to
 * pass.
 */
export function offscreenTranslateX(side: LogicalSide, rtl: boolean, distance: number): number {
  const magnitude = Math.abs(distance);
  return resolvePhysicalSide(side, rtl) === "right" ? magnitude : -magnitude;
}

/**
 * The border-WIDTH utility for the divider on the inner face of a panel
 * anchored at `side`.
 *
 * Physical, deliberately and under protest: the logical spellings compile to
 * `borderInline*`, which RN 0.85.3 drops on native. The colour is the caller's
 * (`border-border`) — this decides only which edge the rule is drawn on.
 *
 * A panel occupying the right of the screen is divided from the content on its
 * LEFT, and vice versa, so this is the opposite edge to the anchor.
 */
export function innerEdgeBorderClassName(side: LogicalSide, rtl: boolean): string {
  return resolvePhysicalSide(side, rtl) === "right" ? "border-l" : "border-r";
}
