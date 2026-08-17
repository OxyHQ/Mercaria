/**
 * What a seller-authored free-text value may contain when it ENTERS the
 * catalogue (#367 steps 5 and 6).
 *
 * The authoring and proposal surfaces take a title, a description, a free-text
 * attribute answer, a proposed label and a submitter's note as
 * `z.string().trim().max(N)` and store them untransformed. On publish the
 * description reaches the `listings` row exactly as it arrived. The only thing
 * standing between that and an injected `<script>` today is React's default JSX
 * escaping on the one storefront path that renders it — which is not a backend
 * control and reaches no other consumer: a transactional email, a PDF export, an
 * operator tool, a partner feed and a CSV export are each unprotected, and
 * `services/price-signals/` already guards a spreadsheet formula for the same
 * reason one layer over.
 *
 * ## It sanitizes on the way IN, not on the way out
 *
 * Sanitizing at render would leave the raw value in the column, so the next
 * consumer to read it directly is unprotected again and the protection has to be
 * remembered once per reader. Applied at the schema boundary the STORED value is
 * clean, and there is nothing for a later reader to remember.
 *
 * ## What stays RAW, deliberately
 *
 * - **Feed and connector text** (`catalog_source_objects`, and a listing
 *   description a connector wrote) keeps its publisher's words and passes through
 *   #63's own `strip_html` transform where a merchant configured one. An operator
 *   reviewing a source's claim has to see what the source actually said.
 * - **`abuse_reports` evidence and reporter text**, for the same reason: it is
 *   quoted to a jury.
 *
 * Both are named in `docs/reviews/2026-08-17-catalog-authoring-security-review.md`
 * with the consumer that escapes them.
 *
 * ## Why the composition is not `stripHtml`
 *
 * `services/feed-import/transforms.ts` owns the one tag pattern and the one
 * entity table in this repository, and both are imported from it rather than
 * copied — a second tag regex is a second thing to tighten, and the time it is
 * not tightened is the time somebody trusts it.
 *
 * What is NOT reused is the ORDER. `stripHtml` strips tags and then decodes, so
 * `&lt;script&gt;` becomes `<script>` — decoding after stripping can MANUFACTURE
 * the markup the strip removed, which is fine for a cosmetic feed transform and
 * disqualifying for a security control. Here the entities are decoded FIRST and
 * the tag strip runs over the decoded text, so the output holds no tag-shaped
 * substring whatever the input was encoded as. Stripping cannot reintroduce one:
 * `[^>]` cannot cross a `>`, so a removal never joins its neighbours into a tag.
 */

import { decodeHtmlEntities, stripHtmlTags } from '../services/feed-import/transforms.js';

/**
 * Sanitize one seller-authored free-text value.
 *
 * LINE BREAKS SURVIVE, and that is the one place this diverges from
 * `stripHtml`'s whitespace policy. A product description is long-form text whose
 * paragraph structure is meaningful and is rendered by an RN `<Text>` that
 * honours `\n`; collapsing it would turn every multi-paragraph description into
 * one line — a visible product regression smuggled in by a security fix, on
 * exactly the input the fix exists for. So runs of spaces and tabs collapse to
 * one space, runs of blank lines collapse to one blank line, and the paragraphs
 * stay.
 *
 * Bounding is the CALLER's: every field that reaches this already carries its own
 * `.max()`, checked on the raw input, and this function only ever shortens.
 */
export function sanitizeAuthoredText(value: string): string {
  return stripHtmlTags(decodeHtmlEntities(value))
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/[ ]*\n[ ]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
