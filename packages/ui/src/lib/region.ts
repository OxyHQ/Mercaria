import { isolateBidi } from "./bidi";

/**
 * Country names in the app's locale (#489).
 *
 * A saved address stores `US`; the address book, the checkout confirmation and
 * the order-detail shipping card all rendered that code verbatim, in all twelve
 * languages. Its own module for the reason `./date` is: #500 is rewriting
 * `./format`, and the split that survives is by subject rather than by "needs a
 * locale".
 *
 * ## There is no bundle key for this, and there must not be
 *
 * ~250 region codes across twelve locales is 3,000 sentences of translated data
 * that CLDR already ships and keeps current. Hand-maintaining it would guarantee
 * a PARTIAL list rather than a wrong one — the codes nobody thought of simply
 * render as codes forever, and nothing says which those are. So the platform's
 * own data is the shared source, which is what #489 asks for.
 *
 * ## Why a fallback here is correct, when #489 says a fallback is the bug
 *
 * #489's rule is right for a CLOSED vocabulary: the five search-result kinds get
 * an exhaustive `Record` that fails `tsc`, because a fallback there silently
 * ships the identifier again. A region code is an OPEN standard vocabulary whose
 * authority is the platform, and its fallback is a legible answer rather than a
 * leaked internal token — `US` is what the screen showed yesterday.
 *
 * Four branches fall back, and the floor is exactly today's rendering — never a
 * crash, never a blank where a country belongs:
 *
 *   - `Intl.DisplayNames` is absent. Hermes' `Intl` surface is narrower than
 *     V8's, and this repository has already been bitten by a construct `hermesc`
 *     accepts and the Hermes RUNTIME rejects. **Unverified on a device:** all
 *     three apps deploy as Expo WEB exports today, so `Intl` is the browser's.
 *   - the code is not a well-formed alpha-2 subtag. Measured: `of("U1")`,
 *     `of("U")`, `of("USAA")` and `of("")` all throw `RangeError`, so testing
 *     the shape first is what makes the `catch` unreachable for anything this
 *     DTO can hold rather than load-bearing.
 *   - `fallback: "none"` answered `undefined` — a well-formed but UNASSIGNED
 *     code such as `XX`. Without that option the engine ECHOES the code back as
 *     though it had resolved, which is indistinguishable from success.
 *   - the call threw anyway.
 */

/**
 * A well-formed ISO 3166-1 alpha-2 region subtag — the shape `Address.country`
 * carries, and the ONLY shape handed to `Intl`.
 */
const ISO_ALPHA2_REGION = /^[A-Za-z]{2}$/u;

/**
 * One `Intl.DisplayNames` per locale, built once. Construction is an ICU lookup
 * and an address list renders many rows; `null` caches "this engine or this
 * locale cannot answer" so the failure is paid once too.
 */
const DISPLAY_NAMES_CACHE = new Map<string, Intl.DisplayNames | null>();

function displayNamesFor(locale: string): Intl.DisplayNames | null {
  const cached = DISPLAY_NAMES_CACHE.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  let resolved: Intl.DisplayNames | null = null;
  // Feature-detected rather than assumed: see the module note on Hermes.
  if (typeof (Intl as { DisplayNames?: unknown }).DisplayNames === "function") {
    try {
      resolved = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
    } catch {
      // A malformed OS tag (`en_US`) raises here exactly as it does for
      // `Intl.DateTimeFormat`. Retry on the runtime default before giving up,
      // so a device with an odd tag still gets names in SOME language rather
      // than bare codes.
      try {
        resolved = new Intl.DisplayNames(undefined, { type: "region", fallback: "none" });
      } catch {
        resolved = null;
      }
    }
  }
  DISPLAY_NAMES_CACHE.set(locale, resolved);
  return resolved;
}

/**
 * Name a country in the app's locale, falling back to its own code.
 *
 * The locale is required and comes from the one source — `useTranslation()
 * .locale` in an app, `useSharedUiLocale()` inside this package. Isolated per
 * `./format`'s module contract: a Latin name such as `Estados Unidos` sitting
 * inside an Arabic address line is precisely the run that reorders.
 */
export function formatRegionName(code: string, locale: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const upper = trimmed.toUpperCase();
  const fallback = isolateBidi(upper);
  if (!ISO_ALPHA2_REGION.test(upper)) {
    return fallback;
  }
  const displayNames = displayNamesFor(locale);
  if (displayNames === null) {
    return fallback;
  }
  try {
    const name = displayNames.of(upper);
    return typeof name === "string" && name.length > 0 ? isolateBidi(name) : fallback;
  } catch {
    // Unreachable for an alpha-2 code on a conforming engine — kept because the
    // cost of being wrong about that is a crashed checkout screen, and the
    // recovery is the same legible code the caller started with.
    return fallback;
  }
}
