import { useIsRtl } from "@oxy.so/bloom/hooks";

import { resolvePhysicalSide, type LogicalSide, type PhysicalSide } from "./logical-side";

/**
 * The Bloom `Dialog` side placement for a LOGICAL edge (#429 item 4).
 *
 * Bloom's `Dialog` anchors a side-sheet with a PHYSICAL `placement`
 * (`left` / `right`) and parks it off screen with a physical `translateX` —
 * both are resolved inside Bloom, from that value alone. A Mercaria screen that
 * means "the trailing edge of the reading direction" therefore has to turn its
 * logical side into the physical one before handing it over, or a mirrored
 * till opens the variant picker from the leading edge. This is that turn, and
 * the only one: every sheet that sits on a logical edge asks here instead of
 * writing its own `rtl ? … : …`.
 *
 * It goes through `resolvePhysicalSide` rather than restating the truth table
 * — `scripts/validate-logical-side.mjs` pins that table, and requires this
 * module to keep calling it.
 *
 * The direction is READ through Bloom's `useIsRtl`, never re-derived from a
 * locale, so the side agrees with the layout the platform actually mirrored (a
 * second derivation could disagree with the platform doing the mirroring).
 *
 * ## What it cannot fix
 *
 * On web this is exactly right: react-native-web treats `left` / `right` and a
 * transform as physical in both directions. On a NATIVE build running mirrored,
 * React Native swaps a `left` / `right` inset under `I18nManager.isRTL` while
 * leaving the transform alone, so Bloom's own anchor and its own slide already
 * disagree there whatever side is passed in. That is Bloom's to resolve, and
 * native Arabic has never been rendered anyway — #429 item 2.
 */
export function useLogicalDialogPlacement(side: LogicalSide): PhysicalSide {
  return resolvePhysicalSide(side, useIsRtl());
}
