/**
 * Jumping from an error-summary line to the control it names.
 *
 * ## What this covers, and what it honestly does not
 *
 * The summary's line already changes the STEP, which works on every platform
 * and is the actionable half — a merchant told "the price is missing on the
 * 128 GB row" and put on the pricing screen can act. This adds the second half
 * on WEB only, where React Native Web renders `nativeID` as a DOM `id` and
 * `scrollIntoView` is a real API.
 *
 * On native it is a no-op, and that is stated rather than papered over: the
 * equivalent needs a `measureLayout` against the enclosing scroll view and a
 * ref per control, which is a mechanism worth building when somebody is
 * authoring on a phone with forty fields — not one to half-build now and leave
 * looking finished.
 *
 * The scroll runs on the NEXT frame, because the step it jumps to has not been
 * rendered yet at the moment the summary is pressed: `setStep` and this call
 * happen in the same handler, and the target element does not exist until React
 * has committed.
 */

import { Platform } from "react-native";
import type { LocatedFinding } from "./findings";

/** The anchor id one finding names, or `null` when it names no control. */
export function anchorForFinding(finding: LocatedFinding): string | null {
  const target = finding.target;
  switch (target.kind) {
    case "product_field":
      return `authoring-field-${target.attributeKey}`;
    case "variant_field":
      return `authoring-variant-${target.position}`;
    case "variant":
      return `authoring-variant-${target.position}`;
    default:
      return null;
  }
}

/** Bring the control a finding names into view. Web only; see the module note. */
export function scrollToFinding(finding: LocatedFinding): void {
  if (Platform.OS !== "web") return;
  const id = anchorForFinding(finding);
  if (id === null) return;
  // `requestAnimationFrame` rather than a timeout: the target is rendered by the
  // step change that just happened, so the wait is exactly one commit.
  requestAnimationFrame(() => {
    const element = document.getElementById(id);
    if (element === null) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
