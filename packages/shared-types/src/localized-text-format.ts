/**
 * Which localized fields carry PLAIN text and which carry STRUCTURED rich text
 * (#367 line 187, ADR 0007 D4).
 *
 * `lib/authored-text.ts` sanitizes seller-authored free text where it enters the
 * catalogue, and `sanitizeAuthoredText` is applied in exactly two production
 * modules — `middleware/catalog-authoring-schemas.ts` and
 * `middleware/catalog-proposal-schemas.ts`. Neither is a LOCALIZATION writer:
 * every localized text column enumerated below took its value as
 * `z.string().trim().max(N)` and stored it untransformed, including the one an
 * ordinary seller reaches. `PUT /seller/listings/:id/localizations/:locale` is
 * authenticated by ownership alone — no store permission, no operator list — and
 * writes `listing_localizations.title` and `.description` straight through.
 *
 * The base-locale comparison is worth stating accurately, because the obvious
 * version of it is wrong: a listing's own title and description have TWO write
 * paths with two different controls. The draft-authoring path sanitizes; the
 * direct `POST`/`PATCH /seller/listings` path (`middleware/schemas.ts`) does
 * not. So the guarantee attached to a listing's text already varied by which
 * door a seller came through, and the localization door was the third and
 * weakest. Converging the direct base-locale path is #367 steps 5 and 6's, not
 * this box's, and it is recorded rather than quietly folded in.
 *
 * ## Why the declaration comes FIRST, and is not decoration
 *
 * You cannot sanitize correctly without knowing which fields are allowed to
 * carry markup at all, and the two answers are not the same shape:
 *
 * - a field that should be PLAIN needs its markup REFUSED. Cleaning it silently
 *   accepts input the contract forbids, and the caller — a seller's editor, a
 *   bulk importer, a translation vendor — never learns that what it sent is not
 *   what was stored.
 * - a field that carries RICH text needs a CLOSED allow-list of the structure it
 *   may carry. Everything outside that list is refused, so "rich" can never
 *   become "whatever the last writer happened to send".
 *
 * Both fall out of ONE rule once the declaration is data:
 * {@link LocalizedTextFieldDescriptor.structures} is the permitted set, anything
 * a value exhibits outside it is refused, and markup is in no field's permitted
 * set because it is not in {@link LOCALIZED_RICH_TEXT_STRUCTURES} at all. A
 * `plain` field is exactly a field whose permitted set is EMPTY. There is no
 * second code path for the two kinds and therefore no branch to get backwards.
 *
 * ## What "structured rich text" means in this repository, measured
 *
 * It is line structure, and it is not HTML. No consumer in `packages/frontend`,
 * `packages/dashboard`, `packages/pos` or `packages/ui` renders catalogue text
 * as markup: the three `dangerouslySetInnerHTML` sites in the four packages are
 * the web shell's static site description and two JSON-LD embeddings, and
 * `frontend/lib/catalog/structured-data.ts` escapes `<`, `>` and `&` into their
 * `\uXXXX` forms precisely because `JSON.stringify` does not. Everywhere else a
 * description reaches a React Native `<Text>` that honours `\n`, which is why
 * `sanitizeAuthoredText` goes out of its way to preserve paragraph breaks while
 * collapsing every other whitespace run. So the honest allow-list is two
 * members, and the fourteen prohibitions below are what carry the weight:
 * they name, as VALUES, the structures that may never join it, and a test holds
 * the two tuples disjoint. A future rich renderer arrives by moving a member
 * across that line in a diff somebody reviews — not by a writer discovering that
 * its markup happened to survive.
 *
 * ## The key space is the STORAGE, not the resolver's registry
 *
 * {@link CATALOG_LOCALIZED_FIELDS} answers "what may a reader ask the resolver
 * for" and covers eighteen fields. The nine family tables hold twenty-two
 * localized text columns. The four it does not cover — `attribute_value`'s
 * description and all three of `navigation_node_localizations` — are real
 * columns a real writer writes, and a sanitization policy keyed on the resolver
 * registry would have left every one of them out. So this map is keyed on
 * `<table>.<column>` as PostgreSQL spells them.
 *
 * ## How the population is DERIVED, and what a first pass missed
 *
 * A missed write path is not a smaller finding for a control like this — it is
 * the whole finding — so the population is walked rather than listed, in two
 * stages, and both stages are asserted in `localized-text-format.test.ts`.
 *
 * 1. **Every table carrying a `locale` column** is enumerated from the drizzle
 *    barrel at RUNTIME. Runtime reflection matters: eight of the nine family
 *    tables get `locale` from the `localizationColumns()` spread in
 *    `db/schema/localizationFamily.ts`, so a source grep for `locale:` finds
 *    one of them. `sqlColumnName` matters too — 5,278 of this schema's 7,018
 *    columns have a SQL name that differs from the TypeScript property, so a
 *    membership test built from the property answers "absent" for every
 *    snake_case probe.
 * 2. **Every one of those tables gets a disposition.** A table is either
 *    IN SCOPE — its free-text columns each carry a declaration below — or it is
 *    named in {@link LOCALE_SCOPED_TABLES_WITHOUT_LOCALIZED_COPY} with the
 *    reason. The census asserts the two sets PARTITION the walked set exactly,
 *    in both directions, so a new locale-bearing table fails the build until
 *    somebody decides which it is. Silence is not a disposition — the
 *    `merge-plan-census` device, pointed at a text policy.
 *
 * The first pass at this took the nine-member family as the population and
 * scoped everything else out without recording it, which is indistinguishable
 * from having missed it: `canonical_images.alt` — locale-scoped alt text an
 * operator writes and a screen reader speaks — was dropped that way and is
 * declared here. The exclusions below are what stop the same thing happening
 * silently again.
 *
 * The family itself is derived rather than trusted: a table is a member exactly
 * when it carries all seven {@link LOCALIZATION_FAMILY_COLUMNS}, and the census
 * asserts that walk reproduces {@link CATALOG_LOCALIZATION_TEXT_TABLES}
 * element for element.
 *
 * ## The classification is per FIELD, not a rule over column names
 *
 * It reads almost like one — every `description` and `help_text` is rich, every
 * name, label and title is plain — and that is a fact about what this catalogue
 * happens to hold, never the derivation. `example` and `accessibility_label` are
 * the two that show the difference: `example` is a VALUE a seller would type
 * into the box beside it, and `accessibility_label` is one utterance a screen
 * reader speaks, so both are plain despite being neither a name nor a title.
 * Each entry below states the slot that renders it.
 */

/**
 * How much structure one localized field may carry.
 *
 * Two members, deliberately: a third would need a renderer that can tell it from
 * the other two, and this repository has one text renderer.
 */
export const LOCALIZED_TEXT_FORMATS = ['plain', 'rich'] as const;

/** How much structure one localized field may carry. */
export type LocalizedTextFormat = (typeof LOCALIZED_TEXT_FORMATS)[number];

/**
 * The CLOSED allow-list of structure a `rich` localized field may carry.
 *
 * A `plain` field permits none of it. Growing this tuple is the only way a
 * localized field can come to carry anything new, and the tuple is disjoint from
 * {@link LOCALIZED_FORBIDDEN_TEXT_STRUCTURES} by a test — so the growth that
 * would matter is refused at the type level rather than reviewed for.
 */
export const LOCALIZED_RICH_TEXT_STRUCTURES = [
  /** A single `\n`. A shipping note under a paragraph, an address block. */
  'line_break',
  /**
   * A blank line between paragraphs. Implies `line_break`, which is why
   * `localized-text-format.test.ts` asserts every descriptor permitting this one
   * permits that one — a set admitting a blank line and refusing the newlines it
   * is made of is a rule no writer could satisfy.
   */
  'paragraph_break',
] as const;

/** One structure a `rich` localized field may carry. */
export type LocalizedRichTextStructure = (typeof LOCALIZED_RICH_TEXT_STRUCTURES)[number];

/**
 * Structures no localized field may carry, stated as VALUES.
 *
 * Disjoint from {@link LOCALIZED_RICH_TEXT_STRUCTURES} by a test, which is what
 * makes the prohibition checkable rather than a sentence in a docblock. Every
 * member is something a writer could plausibly want and a renderer here cannot
 * safely show: each would need an escaping contract with every consumer of the
 * column — a storefront, a dashboard, a CSV export, a partner feed, an operator
 * tool — and today those consumers have exactly one guarantee between them,
 * which is that the stored text is not markup.
 */
export const LOCALIZED_FORBIDDEN_TEXT_STRUCTURES = [
  'html_markup',
  'raw_html_passthrough',
  'script',
  'style',
  'iframe',
  'embedded_object',
  'svg',
  'remote_image',
  'data_uri',
  'hyperlink',
  'heading',
  'list',
  'table',
  'inline_emphasis',
] as const;

/** A structure no localized field may carry. */
export type LocalizedForbiddenTextStructure = (typeof LOCALIZED_FORBIDDEN_TEXT_STRUCTURES)[number];

/**
 * Every localized text column in the family, `<table>.<column>` as PostgreSQL
 * spells them.
 *
 * A literal union rather than a `string`, which is what makes an undeclared
 * column a compile error at every call site and what makes
 * {@link LOCALIZED_TEXT_FIELDS} the only place a text policy exists.
 */
export const LOCALIZED_TEXT_COLUMN_KEYS = [
  'category_localizations.name',
  'category_localizations.description',
  'product_type_localizations.name',
  'product_type_localizations.description',
  'product_type_localizations.help_text',
  'product_type_field_localizations.label',
  'product_type_field_localizations.help_text',
  'product_type_field_localizations.placeholder',
  'product_type_field_localizations.example',
  'canonical_product_localizations.name',
  'canonical_product_localizations.description',
  'canonical_product_family_localizations.name',
  'canonical_product_family_localizations.description',
  'attribute_value_localizations.label',
  'attribute_value_localizations.description',
  'attribute_labels.label',
  'attribute_labels.description',
  'navigation_node_localizations.label',
  'navigation_node_localizations.description',
  'navigation_node_localizations.accessibility_label',
  'listing_localizations.title',
  'listing_localizations.description',
  // The one member outside the family. See the header: it was dropped by a
  // first pass that took the family as the population, and dropping it silently
  // is the failure the disposition table below exists to prevent.
  'canonical_images.alt',
] as const;

/** One localized text column. */
export type LocalizedTextColumnKey = (typeof LOCALIZED_TEXT_COLUMN_KEYS)[number];

/**
 * Every table carrying a `locale` column whose text is NOT localized copy, with
 * the reason.
 *
 * This is the other half of the population walk, and it is what makes the census
 * a gate rather than a list: a locale-bearing table is in exactly one of these
 * two sets, the union is asserted equal to the walk, and a new one fails the
 * build until somebody says which.
 *
 * The recurring distinction is between a table whose ROW IS a translation — one
 * entity's field in one locale, `UNIQUE(entity_id, locale)` — and a table that
 * merely RECORDS which locale something happened in. Only the first holds
 * localized copy. Where a table's text is nonetheless authored and rendered, the
 * reason names the domain that already governs it rather than claiming there is
 * nothing to govern.
 */
export const LOCALE_SCOPED_TABLES_WITHOUT_LOCALIZED_COPY: Readonly<Record<string, string>> =
  Object.freeze({
    canonical_attribute_values:
      'An OBSERVED source value and the normalizer output beside it (#94). Not authored copy: ' +
      'the display value is what a source published, and refusing markup in it would refuse the ' +
      'observation rather than the claim. `services/attributes/` owns its normalization.',
    catalog_authoring_drafts:
      'A base-locale draft. `locale` records which locale a seller is authoring IN, not which ' +
      'locale a translation is OF. Its title and description already go through ' +
      '`sanitizeAuthoredText` in `middleware/catalog-authoring-schemas.ts`.',
    catalog_localization_revisions:
      'An append-only COPY of family text, written by eight database TRIGGERS and by nothing ' +
      'else. There is no writer to refuse, and a constraint here would refuse a revision OF a ' +
      'row that predates this policy — which is the trail, not a new claim.',
    category_aliases:
      'Search synonyms, stored beside a normalized form and matched against rather than ' +
      'rendered. Written only by the vertical-package apply, whose text is a code constant.',
    product_type_aliases:
      'The same synonyms, one entity over, and with no writer at all today — so there is not ' +
      'even a surface on which a text policy could be applied.',
    category_localized_slugs:
      'A URL slug, not prose: frozen against UPDATE by ' +
      '`mercaria_category_localized_slug_frozen`, so a link somebody shared cannot be edited.',
    navigation_trees:
      '`internal_label` is an operator-facing version name and never reaches a shopper; the ' +
      "tree's `locale` is which locale the tree SERVES. Its nodes' copy is " +
      '`navigation_node_localizations`, which IS in scope.',
    guest_checkouts:
      "A buyer's contact snapshot. `locale` is the language to write to them in; the text " +
      'columns are ciphertext, a hash and a redacted form, all in `PROTECTED_COLUMNS`.',
    guest_portal_messages:
      'A queue row. It deliberately holds no recipient, subject or body — the template is code ' +
      'and `locale` selects it.',
    price_alerts:
      "One buyer's own alert. `locale` is which language to notify in; nothing here is copy.",
    referral_codes: 'A campaign handle and its routing refs. `locale` scopes the destination.',
    referral_links:
      'One issued link. The same routing refs a code carries, plus an opaque token; `locale` ' +
      'scopes the destination and none of it is rendered as copy.',
    referral_terms_acceptances:
      'A signed acceptance. `locale` records which rendering of the terms was shown.',
    relationship_evidence:
      'Evidence quoted to a reviewer (#55), whose `locale` is the source document\'s. Kept ' +
      'verbatim on purpose — the same ruling `abuse_reports` takes, and for the same reason.',
    reviews:
      'Buyer-authored review copy (#76), rendered to shoppers and governed by CrowdSource ' +
      'moderation rather than by a catalogue text policy. `locale` is the language it was ' +
      'written in, not a translation of anything.',
    search_intent_sessions: 'A parse session (#95). No copy; `locale` is the query language.',
    search_intent_turns:
      'One parse. `redacted_query` is the REDACTED form of what somebody typed, retained 30 ' +
      'days; refusing markup in it would refuse recording a search that contained one.',
    shopping_agents:
      "An agent's own name and description (#81's posture), authored by its owner and rendered " +
      'to that owner alone. `locale` is which language to answer in.',
  });

/**
 * Free-text columns ON an in-scope table that are still not localized copy.
 *
 * The table-level partition above is not enough on its own: `canonical_images`
 * holds one column of localized copy and two that are machine references, so a
 * census that demanded a declaration for every free-text column of every
 * in-scope table would force a text policy onto a URL. Named here with the
 * reason for the same purpose the table list serves — a new column on an
 * in-scope table fails the build until it is declared or excused.
 */
export const LOCALIZED_TEXT_COLUMNS_WITHOUT_LOCALIZED_COPY: Readonly<Record<string, string>> =
  Object.freeze({
    'canonical_images.source_url':
      'The URL the image was observed at, validated as an absolute URL by its own schema. Not ' +
      'copy, and refusing a `<` in it would refuse a legitimate query string.',
    'canonical_images.image_ref':
      "A provider's own opaque handle for the asset, stored verbatim so an operator can find it " +
      'on the source. Nothing renders it to a shopper.',
  });

/** What one localized text column may carry. */
export interface LocalizedTextFieldDescriptor {
  readonly key: LocalizedTextColumnKey;
  /** The SQL table name. */
  readonly table: string;
  /** The SQL column name. */
  readonly column: string;
  /**
   * The drizzle/TypeScript property name for {@link column}.
   *
   * STATED, not folded. A `_x` → `X` derivation is a content fold by
   * `script-coverage-census.test.ts`'s definition — an operation whose output
   * depends on the script of its input — and that census demanded Arabic,
   * Bengali, Cyrillic, Devanagari, Hiragana and Katakana fixtures for it. The
   * input here is a SQL identifier and is ASCII by construction, but "this fold
   * is safe because of where its input comes from" is exactly the exemption that
   * census exists to refuse. Removing the fold is cheaper than arguing with it.
   *
   * It is not a second spelling to keep in step either:
   * `localized-text-format.test.ts` walks the REAL drizzle table and asserts
   * every one of these against the property the schema actually declares.
   */
  readonly property: string;
  /** Derived from {@link structures}. Never stated independently. */
  readonly format: LocalizedTextFormat;
  /**
   * The permitted structure set, which IS the policy. Empty for a plain field.
   * Markup is absent from every set because it is not a member of the tuple.
   */
  readonly structures: readonly LocalizedRichTextStructure[];
}

/** The permitted set for every field that carries block copy. */
const BLOCK: readonly LocalizedRichTextStructure[] = Object.freeze([
  'line_break',
  'paragraph_break',
]);

/** The permitted set for a single-line field. Empty, which is what plain MEANS. */
const NONE: readonly LocalizedRichTextStructure[] = Object.freeze([]);

/**
 * `format` is DERIVED from the permitted set rather than stated beside it.
 *
 * Two representations of one fact can disagree, and the direction this one would
 * disagree in is a field declared `plain` whose permitted set still admits a
 * paragraph break — which reads as enforcement in every review and enforces
 * nothing.
 */
function describe(
  key: LocalizedTextColumnKey,
  structures: readonly LocalizedRichTextStructure[],
  /** Only where drizzle spells it differently from PostgreSQL. Identity, never a fold. */
  property?: string,
): LocalizedTextFieldDescriptor {
  const [table, column] = key.split('.');
  const sqlColumn = column ?? '';
  return {
    key,
    table: table ?? '',
    column: sqlColumn,
    property: property ?? sqlColumn,
    format: structures.length === 0 ? 'plain' : 'rich',
    structures,
  };
}

/**
 * What each localized text column may carry.
 *
 * A total `Record` over {@link LocalizedTextColumnKey}, so adding a key without
 * deciding its policy fails `tsc`, and a census walks the real drizzle tables so
 * adding a COLUMN without adding a key fails the build.
 */
export const LOCALIZED_TEXT_FIELDS: Readonly<
  Record<LocalizedTextColumnKey, LocalizedTextFieldDescriptor>
> = Object.freeze({
  // A breadcrumb segment, a facet heading and a `<title>`. One line.
  'category_localizations.name': describe('category_localizations.name', NONE),
  // The paragraph of copy under a category heading.
  'category_localizations.description': describe('category_localizations.description', BLOCK),
  // The form's name, shown in a picker and a heading.
  'product_type_localizations.name': describe('product_type_localizations.name', NONE),
  'product_type_localizations.description': describe(
    'product_type_localizations.description',
    BLOCK,
  ),
  // Guidance about the whole form — the field this repository's own sanitizer
  // docblock is describing when it says paragraph structure is meaningful.
  'product_type_localizations.help_text': describe(
    'product_type_localizations.help_text',
    BLOCK,
    'helpText',
  ),
  // The label beside one input. One line, always.
  'product_type_field_localizations.label': describe('product_type_field_localizations.label', NONE),
  'product_type_field_localizations.help_text': describe(
    'product_type_field_localizations.help_text',
    BLOCK,
    'helpText',
  ),
  // Ghost text INSIDE an input, which is a single line by construction.
  'product_type_field_localizations.placeholder': describe(
    'product_type_field_localizations.placeholder',
    NONE,
  ),
  // A specimen ANSWER — what a seller would type into the box beside it — and
  // therefore plain for the same reason the answer is, not because of its name.
  'product_type_field_localizations.example': describe(
    'product_type_field_localizations.example',
    NONE,
  ),
  // A product page heading and a card title.
  'canonical_product_localizations.name': describe('canonical_product_localizations.name', NONE),
  'canonical_product_localizations.description': describe(
    'canonical_product_localizations.description',
    BLOCK,
  ),
  'canonical_product_family_localizations.name': describe(
    'canonical_product_family_localizations.name',
    NONE,
  ),
  'canonical_product_family_localizations.description': describe(
    'canonical_product_family_localizations.description',
    BLOCK,
  ),
  // A controlled value's label — a chip, a facet row, a dropdown option.
  'attribute_value_localizations.label': describe('attribute_value_localizations.label', NONE),
  // The column the resolver registry does not cover. Declared anyway, because
  // the policy is about the COLUMN and a writer reaches it without the resolver.
  'attribute_value_localizations.description': describe(
    'attribute_value_localizations.description',
    BLOCK,
  ),
  // The attribute's own question — "Charging port". A table header and a facet
  // group heading.
  'attribute_labels.label': describe('attribute_labels.label', NONE),
  'attribute_labels.description': describe('attribute_labels.description', BLOCK),
  // A navigation entry's visible text. One line in a menu row.
  'navigation_node_localizations.label': describe('navigation_node_localizations.label', NONE),
  'navigation_node_localizations.description': describe(
    'navigation_node_localizations.description',
    BLOCK,
  ),
  // One utterance a screen reader speaks. A line break in it is a pause nobody
  // authored, which is why it is plain despite being neither a name nor a title.
  'navigation_node_localizations.accessibility_label': describe(
    'navigation_node_localizations.accessibility_label',
    NONE,
    'accessibilityLabel',
  ),
  // A seller's own title for one listing, in one locale. A card, a cart line, an
  // order line and a `<title>` — every one of them a single line.
  'listing_localizations.title': describe('listing_localizations.title', NONE),
  // A seller's own long-form copy. The field `sanitizeAuthoredText` preserves
  // paragraph breaks FOR, on the draft-authoring path.
  'listing_localizations.description': describe('listing_localizations.description', BLOCK),
  // Alt text for one canonical image in one locale — the only in-scope column
  // outside the family. A screen reader speaks it as one utterance, so a line
  // break is a pause nobody authored: the `accessibility_label` reasoning, on
  // the one column where the same decision had to be made twice.
  'canonical_images.alt': describe('canonical_images.alt', NONE),
});

/** The declaration for one localized text column. */
export function localizedTextFieldFor(key: LocalizedTextColumnKey): LocalizedTextFieldDescriptor {
  return LOCALIZED_TEXT_FIELDS[key];
}

/** Every localized text column declared `plain`. */
export const PLAIN_LOCALIZED_TEXT_COLUMN_KEYS: readonly LocalizedTextColumnKey[] =
  LOCALIZED_TEXT_COLUMN_KEYS.filter((key) => LOCALIZED_TEXT_FIELDS[key].format === 'plain');

/** Every localized text column declared `rich`. */
export const RICH_LOCALIZED_TEXT_COLUMN_KEYS: readonly LocalizedTextColumnKey[] =
  LOCALIZED_TEXT_COLUMN_KEYS.filter((key) => LOCALIZED_TEXT_FIELDS[key].format === 'rich');

/** The declared columns of one table, by SQL table name. */
export function localizedTextFieldsOfTable(
  table: string,
): readonly LocalizedTextFieldDescriptor[] {
  return LOCALIZED_TEXT_COLUMN_KEYS.filter((key) => LOCALIZED_TEXT_FIELDS[key].table === table).map(
    (key) => LOCALIZED_TEXT_FIELDS[key],
  );
}

/** Every table this policy declares columns on. */
export const LOCALIZED_TEXT_TABLES: readonly string[] = [
  ...new Set(LOCALIZED_TEXT_COLUMN_KEYS.map((key) => LOCALIZED_TEXT_FIELDS[key].table)),
];
