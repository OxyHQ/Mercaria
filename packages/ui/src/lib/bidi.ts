/**
 * Unicode bidirectional isolation for values interpolated into localized prose
 * (#429 item 1, the residual #397 item 3 left).
 *
 * ## The hazard
 *
 * The storefront ships an Arabic bundle and mirrors its layout (#396/#397). In
 * an RTL paragraph the Unicode Bidirectional Algorithm resolves every NEUTRAL
 * character from its surroundings, and a formatted price is mostly neutrals: a
 * currency symbol is `ET` (European Terminator), a space is `WS`, and the
 * digits are `EN` rather than a strong `L`. So `$148.00` dropped into Arabic
 * text has no strong left-to-right character to anchor it, and the symbol
 * migrates to the far side of the number — the shopper is shown `148.00$`, or
 * worse, the symbol lands against the neighbouring word entirely. The same
 * applies to `148.00 RON`, to `1.5 km`, and to any Latin brand name sitting
 * beside a number.
 *
 * `FIRST STRONG ISOLATE` (U+2068) ... `POP DIRECTIONAL ISOLATE` (U+2069) fixes
 * it in the way the standard intends: the run inside is laid out on its own,
 * taking its direction from its own first strong character, and the surrounding
 * paragraph sees the whole run as a single neutral object. It therefore neither
 * affects nor is affected by the text around it. That is precisely the property
 * wanted — the price reads correctly, and it does not reorder the sentence.
 *
 * FSI rather than LRI: the price is not always left-to-right. An Arabic-script
 * currency name or an RTL brand inside the run should lay itself out RTL, and
 * first-strong detection gets that right without the caller having to know.
 *
 * ## Why this is invisible, and what stands in for looking at it
 *
 * U+2068/U+2069 are `Cf` format characters — zero-width and default-ignorable.
 * A wrong implementation renders identically to a right one in every screenshot
 * and every code review, while silently changing the string's length and
 * equality. `scripts/validate-bidi-isolation.mjs` therefore asserts the emitted
 * CODE POINTS of the real formatters rather than their appearance, and it holds
 * the LTR output to the exact visible text so isolation cannot be traded for a
 * corrupted English string.
 *
 * ## Assistive technology
 *
 * These are the characters screen readers are specified to skip, which is the
 * reason to reach for them rather than for a visible mark or a per-locale
 * reordering. VoiceOver and TalkBack ignore default-ignorable format
 * characters, so an `accessibilityLabel` built from an isolated figure (see
 * `OfferLabelBadge`) reads exactly as it did before.
 */

/** FIRST STRONG ISOLATE — opens a run whose direction is read off its own content. */
const FIRST_STRONG_ISOLATE = "\u2068";

/** POP DIRECTIONAL ISOLATE — closes the innermost open isolate. */
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/**
 * Every character that OPENS an isolate: `LRI` (U+2066), `RLI` (U+2067) and
 * `FSI` (U+2068). All three are recognised so text a caller deliberately
 * isolated left-to-right is left exactly as it is rather than wrapped again.
 */
const ISOLATE_INITIATORS: ReadonlySet<string> = new Set([
  "\u2066",
  "\u2067",
  FIRST_STRONG_ISOLATE,
]);

/**
 * Whether `text` is ALREADY exactly one balanced isolate spanning the whole
 * string — the check that makes {@link isolateBidi} idempotent.
 *
 * This walks the isolate DEPTH rather than testing the first and last
 * characters, and the difference is the whole point: `FSI a PDI FSI b PDI`
 * begins with an initiator and ends with a `PDI` while being TWO isolates side
 * by side. A `startsWith`/`endsWith` test reports it as already isolated and
 * returns the concatenation unwrapped, which is the one case that needs
 * wrapping most — two independently-isolated fragments joined together have no
 * isolation around the join.
 */
function isSingleBalancedIsolate(text: string): boolean {
  // Code points, not code units: content may carry astral characters (emoji in
  // a merchant name), and splitting a surrogate pair would misread the length.
  const characters = Array.from(text);
  if (characters.length < 2) {
    return false;
  }
  if (!ISOLATE_INITIATORS.has(characters[0])) {
    return false;
  }

  let depth = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (ISOLATE_INITIATORS.has(character)) {
      depth += 1;
    } else if (character === POP_DIRECTIONAL_ISOLATE) {
      depth -= 1;
      // The opening isolate closed here. It spans the whole string only if
      // there is nothing after it; otherwise what follows sits outside it.
      if (depth === 0) {
        return index === characters.length - 1;
      }
    }
  }

  // Depth never returned to zero: the isolate is unterminated, so the string is
  // not a well-formed single isolate and wrapping it balances the run.
  return false;
}

/**
 * Wrap `text` in `FSI` ... `PDI` so it lays out as a self-contained run
 * whatever direction the surrounding paragraph has.
 *
 * IDEMPOTENT: text that is already one balanced isolate is returned unchanged,
 * so composing formatters cannot nest isolates. Note that repeated RENDERS
 * cannot double-wrap regardless — every caller in `./format` builds its string
 * from a `Money` (or a number) on each call, so a formatter's own output is
 * never fed back into it and there is no state to accumulate. The idempotence
 * here is for the composition case, not the re-render one.
 *
 * An empty string is returned unchanged: it has nothing that could reorder, and
 * emitting a bare `FSI PDI` pair would put two invisible characters into a slot
 * a caller is treating as absent.
 */
export function isolateBidi(text: string): string {
  if (text.length === 0 || isSingleBalancedIsolate(text)) {
    return text;
  }
  return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}
