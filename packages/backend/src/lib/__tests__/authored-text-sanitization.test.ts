/**
 * Seller-authored free text is sanitized where it ENTERS (#367 steps 5 and 6).
 *
 * The authoring and proposal surfaces took a title, a description, a free-text
 * attribute answer, a proposed label and a submitter's note as
 * `z.string().trim().max(N)` and stored them untransformed, and on publish the
 * description reached the `listings` row exactly as it arrived. The only thing
 * between that and an injected `<script>` was React's default JSX escaping on the
 * one storefront path that renders it — not a backend control, and no help at all
 * to a CSV export, a PDF, an operator tool or a partner feed.
 *
 * ## Every assertion goes through PRODUCTION's path
 *
 * The schema cases call `.parse()` on the exported zod objects the routes mount,
 * not on the transform. A control that feeds a detector its own literals is how
 * three of eighteen tokens were found inert and green one domain over, and a test
 * that called `sanitizeAuthoredText` directly would stay green after somebody
 * removed the `.transform()` from a field.
 *
 * ## The fixed-point assertion, and why it is not the tag regex again
 *
 * "The output contains no tag" is checked as `stripHtmlTags(out) === out` — the
 * OWNER's own pattern, applied a second time. Writing the pattern out here would
 * be a second copy that can disagree with the one under test, in the direction
 * where the test keeps passing.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeAuthoredText } from '../authored-text.js';
import { applyFeedTransform, stripHtmlTags } from '../../services/feed-import/transforms.js';
import {
  createProductDraftSchema,
  patchProductDraftSchema,
} from '../../middleware/catalog-authoring-schemas.js';
import { submitCatalogProposalSchema } from '../../middleware/catalog-proposal-schemas.js';

/** What an injection attempt actually looks like, in the four encodings. */
const PAYLOADS: readonly string[] = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&lt;img src=x onerror=alert(1)&gt;',
  '<a href="javascript:alert(1)">click</a>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<scr<b>ipt>alert(1)</scr<b>ipt>',
  '<div\nclass="x">newline inside a tag</div>',
];

/** A body `createProductDraftSchema` accepts, with the field under test filled in. */
function draftBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { categoryId: 'cat_1', productTypeKey: 'electronics.smartphone', market: 'es', ...fields };
}

/** A body `submitCatalogProposalSchema` accepts. */
function proposalBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'brand',
    storeId: 'store_1',
    proposedLabel: 'A real label',
    sourceLocale: 'es',
    ...fields,
  };
}

describe('sanitizeAuthoredText removes markup in every encoding', () => {
  it.each(PAYLOADS)('leaves no tag-shaped substring in `%s`', (payload) => {
    const out = sanitizeAuthoredText(`before ${payload} after`);
    // The fixed point: running the owner's stripper again changes nothing, so
    // there is nothing left for it to find.
    expect(stripHtmlTags(out)).toBe(out);
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it.each(PAYLOADS)('never lengthens `%s`', (payload) => {
    // Every caller bounds the RAW input with its own `.max()`. That is only a
    // bound on the stored value if the transform cannot grow it.
    expect(sanitizeAuthoredText(payload).length).toBeLessThanOrEqual(payload.length);
  });

  it('defeats entity-encoded markup, which is what the decode ORDER is for', () => {
    // Decoding AFTER stripping — `stripHtml`'s order — turns this input into
    // `<script>alert(1)</script>`: the strip runs first and finds no tag, and the
    // decode then manufactures one. Decoding first is what makes the payload
    // reachable by the stripper at all.
    expect(sanitizeAuthoredText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('alert(1)');
  });

  it('keeps a comparison operator a seller would legitimately type', () => {
    // The negative half. A sanitizer that ate this would be refusing real
    // descriptions, and nothing in a green suite would say so.
    expect(sanitizeAuthoredText('fits phones 12 < 15 cm wide')).toBe('fits phones 12 < 15 cm wide');
    expect(sanitizeAuthoredText('Bold &amp; brave')).toBe('Bold & brave');
  });

  it('preserves paragraph breaks and collapses only spaces and blank runs', () => {
    // `stripHtml` collapses ALL whitespace, which on a 20,000-character
    // description is one line where there were paragraphs — a visible product
    // regression, on exactly the field this fix exists for.
    expect(sanitizeAuthoredText('one\n\ntwo')).toBe('one\n\ntwo');
    expect(sanitizeAuthoredText('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
    expect(sanitizeAuthoredText('a  \t b')).toBe('a b');
    expect(sanitizeAuthoredText('a\r\nb')).toBe('a\nb');
    expect(sanitizeAuthoredText('  padded  ')).toBe('padded');
  });

  it('CONTRAST — the feed transform keeps its own order, and that is the divergence', () => {
    // Pinned rather than assumed. `strip_html` is a cosmetic transform a merchant
    // configured on a feed column, and changing what it emits would change stored
    // descriptions for every advertiser using it — so it keeps strip-then-decode
    // and this assertion is what stops somebody "unifying" the two by pointing
    // the authoring path at it. The residual (a feed CAN land `<script>` in a
    // listing row) is recorded in
    // `docs/reviews/2026-08-17-catalog-authoring-security-review.md`.
    expect(applyFeedTransform('&lt;script&gt;alert(1)&lt;/script&gt;', 'strip_html', ',')).toBe(
      '<script>alert(1)</script>',
    );
  });
});

describe('the authoring schemas sanitize at the boundary', () => {
  it('sanitizes a draft title and description on create', () => {
    const parsed = createProductDraftSchema.parse(
      draftBody({
        title: '<script>alert(1)</script>Pixel 9',
        description: 'Great phone.\n\n<img src=x onerror="alert(1)">Ships fast.',
      }),
    );
    expect(parsed.title).toBe('alert(1) Pixel 9');
    expect(stripHtmlTags(parsed.description)).toBe(parsed.description);
    expect(parsed.description).toContain('Great phone.');
    // The paragraph break survived the sanitizer.
    expect(parsed.description).toContain('\n\n');
  });

  it('sanitizes a draft title and description on patch, and keeps null a null', () => {
    const parsed = patchProductDraftSchema.parse({
      version: 3,
      title: '<b>Clearance</b>',
      description: null,
    });
    expect(parsed.title).toBe('Clearance');
    // `.nullable()` sits OUTSIDE the transform, so a clear is still a clear.
    expect(parsed.description).toBeNull();
  });

  it('sanitizes a free-text attribute ANSWER', () => {
    const parsed = patchProductDraftSchema.parse({
      version: 1,
      fields: [{ attributeKey: 'material', values: [{ text: '<i>leather</i>' }] }],
    });
    expect(parsed.fields?.[0]?.values?.[0]?.text).toBe('leather');
  });

  it('sanitizes a variant title', () => {
    const parsed = patchProductDraftSchema.parse({
      version: 1,
      variants: [{ inventoryAvailable: 1, axes: [], title: '<u>Blue / 256GB</u>' }],
    });
    expect(parsed.variants?.[0]?.title).toBe('Blue / 256GB');
  });

  it('VACUITY CONTROL — a clean value is returned unchanged', () => {
    // Without this every assertion above is satisfied by a transform that
    // returns the empty string, and so is a schema that rejects nothing and
    // stores nothing.
    const clean = 'Pixel 9 Pro, 256 GB, unlocked';
    const parsed = createProductDraftSchema.parse(draftBody({ title: clean, description: clean }));
    expect(parsed.title).toBe(clean);
    expect(parsed.description).toBe(clean);
  });
});

describe('the proposal schema sanitizes at the boundary', () => {
  it('sanitizes the label, the description and the submitter note', () => {
    const parsed = submitCatalogProposalSchema.parse(
      proposalBody({
        proposedLabel: '<b>Acme</b>',
        proposedDescription: 'Maker of <script>alert(1)</script> widgets',
        submitterNote: 'Please add <img src=x onerror="alert(1)"> this',
      }),
    );
    expect(parsed.proposedLabel).toBe('Acme');
    for (const value of [parsed.proposedDescription, parsed.submitterNote]) {
      expect(value).toBeDefined();
      expect(stripHtmlTags(String(value))).toBe(String(value));
    }
  });

  it('refuses a label that is only markup', () => {
    // `<b></b>` clears the raw `.min(1)` and sanitizes to the empty string. A
    // floor checked only before a shortening transform is a floor with a hole in
    // it, and what walks through this one becomes a controlled value's label on
    // approval.
    expect(() => submitCatalogProposalSchema.parse(proposalBody({ proposedLabel: '<b></b>' }))).toThrow();
    // The bound on the RAW input still holds, so markup cannot buy length.
    expect(() =>
      submitCatalogProposalSchema.parse(proposalBody({ proposedLabel: `<b>${'x'.repeat(200)}</b>` })),
    ).toThrow();
  });

  it('VACUITY CONTROL — a clean proposal parses', () => {
    const parsed = submitCatalogProposalSchema.parse(proposalBody({ proposedLabel: 'Acme Tools' }));
    expect(parsed.proposedLabel).toBe('Acme Tools');
  });
});
