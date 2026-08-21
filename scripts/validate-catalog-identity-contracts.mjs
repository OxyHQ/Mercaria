#!/usr/bin/env bun

/**
 * A PUBLIC catalog contract never names a concept with an ambiguous bare string.
 *
 * Epic #367 line 104: *"Add linting/review guidance that prevents new ambiguous
 * `category: string`, `optionName: string` or similar public catalog
 * contracts."* This is that gate for the DTO surface.
 *
 * ## What is already covered, and what was not
 *
 * `packages/backend/src/db/__tests__/catalog-identity-isolation.test.ts` is ADR
 * 0007 D1's enforcement. It has three clauses: no foreign key targets a
 * presentation column, every foreign key targets `id`, and — CLAUSE 3 — no NEW
 * bare identity-shaped string appears in a **request schema** under
 * `packages/backend/src/middleware/`. Its own docblock names this epic
 * checkbox.
 *
 * Its population is `middleware/` and nothing else. So the half of the public
 * contract a client actually holds in its hands was ungated:
 *
 *   * the RESPONSE direction entirely. A zod schema says what the server will
 *     accept; it says nothing about what a serializer emits, and `Listing`,
 *     `ProductVariantDTO` and `OrderItem` are read by four packages.
 *   * every INPUT DTO in `@mercaria/shared-types`, which is the type a client
 *     compiles against. A zod schema and its DTO can disagree, and when they do
 *     it is the DTO that a mobile build shipped.
 *
 * Measured on the tree this landed against: CLAUSE 3 sees 7 legacy fields
 * across 60+ middleware modules. The same vocabulary over
 * `packages/shared-types/src` finds 16, in 11 files, none of which CLAUSE 3 can
 * see — plus 16 more of the `optionName` shape that has no `optionName`
 * spelling anywhere in the repository (see check B).
 *
 * ## The vocabulary is READ OUT OF THE BACKEND GATE, never copied
 *
 * Two lists of "which field names are identity-shaped" would be two answers to
 * one question, and they would diverge in the permissive direction — somebody
 * widens the one they are looking at. So check A parses
 * `IDENTITY_SHAPED_FIELDS` out of that test file with the TypeScript compiler
 * and fails if the declaration is missing, renamed or short. An unmatched
 * pattern is a FAILURE here, not a pass: a vocabulary that came back empty
 * would report a perfectly clean tree.
 *
 * ## Two checks, and why one alone would miss half of it
 *
 *   A. **THE AMBIGUOUS NAME.** A field whose NAME is one of the shared
 *      vocabulary's (`category`, `productType`, `brandName`, …) and whose
 *      declared type is a bare `string`. This is `Listing.category` — a free
 *      string that cannot say which taxonomy, which locale, or whether it is a
 *      label or a key.
 *
 *   B. **THE AMBIGUOUS POSITION.** `optionName: string` does not exist in this
 *      repository. The shape the epic line names is spelled
 *      `ListingOption.name` / `VariantOptionValue.value` / `optionValues: {
 *      name: string; value: string }[]` — a generic member inside an
 *      option-shaped owner. A detector keyed on the identifier `name` would
 *      match a few thousand legitimate fields and be deleted by whoever hit it
 *      first, so this one is keyed on the OWNER PATH: the member is `name`,
 *      `value` or `values`, and the type or property chain above it names an
 *      option or an axis. That is the epic's "key it on the use, not the
 *      spelling" applied to a field whose own spelling carries nothing.
 *
 * ## Everything found today is EXCUSED, at an exact count, with a disposition
 *
 * Both checks compare against `LEGACY_AMBIGUOUS_CONTRACTS` — an exact set with
 * exact per-entry counts, not a ceiling and not a floor. A NEW ambiguous
 * contract fails; REMOVING one fails too, which is correct: the removal is the
 * moment somebody should be reading the retirement condition beside it.
 *
 * Each entry carries a `disposition` from a closed set, and the retirement
 * condition is a property of the DISPOSITION rather than a sentence written 32
 * slightly different ways (the `claim-methods.ts` device). Four of the six
 * dispositions retire NEVER and say so — a display string beside a typed id, a
 * historical snapshot, a platform's own vocabulary and an adapter's raw
 * observation are not defects waiting to be fixed, and pretending they are
 * would make the list unreadable for the entries that ARE.
 *
 * ## What this cannot tell you
 *
 * Whether a bare string in an INTERNAL type is right. The population is the
 * published package and nothing else; a DTO declared inline in a controller is
 * out of scope, and the convention that keeps them here is not enforced by this
 * file.
 *
 * It also cannot tell you whether a category slug is CORRECT. "Is this string a
 * category" is undecidable from a type; "is this field's type a bare string"
 * is not. `catalog-identity-isolation.test.ts` makes the same distinction one
 * layer down.
 *
 * Usage:  bun scripts/validate-catalog-identity-contracts.mjs
 */

import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Overridable so the self-test can point the REAL guard at a COPY of the real
 * tree.
 *
 * There is deliberately no companion variable that lowers a floor. The
 * self-test copies `packages/shared-types/src` and the producer file verbatim
 * and mutates one line of the copy, so every floor below stays the production
 * one on every invocation — including the self-test's. A guard with a
 * documented way to make its own floors meaningless has a documented way to
 * measure almost nothing.
 */
const repositoryRoot = process.env.CATALOG_CONTRACT_VALIDATOR_ROOT
  ? resolve(process.env.CATALOG_CONTRACT_VALIDATOR_ROOT)
  : resolve(here, "..");

// The real compiler, resolved from the repository's own `package.json` the way
// `validate-facet-label-copy.mjs` does, so a copied tree with no
// `node_modules` of its own still parses.
const ts = createRequire(resolve(here, "../package.json"))("typescript");

const CONTRACT_DIR = join(repositoryRoot, "packages/shared-types/src");

/** The backend gate that owns the vocabulary. */
const PRODUCER = "packages/backend/src/db/__tests__/catalog-identity-isolation.test.ts";
const PRODUCER_DECLARATION = "IDENTITY_SHAPED_FIELDS";

const failures = [];
const notes = [];

/* -------------------------------------------------------------------------- */
/*  Floors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Floors, per SHAPE. One total would let a shape collapse to zero unnoticed:
 * a parse that produced no exported types and a package with no ambiguous
 * contract in it print the same clean line.
 */
const MINIMUM_CONTRACT_FILES = 110;
const MINIMUM_EXPORTED_TYPES = 2000;
/**
 * Every PROPERTY SIGNATURE anywhere under an exported interface or type alias,
 * in the 121 non-`index` modules of `packages/shared-types/src`, nested type
 * literals and generic type arguments included, counted once per declaration
 * site.
 *
 * The population is spelled out because the number is not self-describing and
 * three defensible rules give three different answers over the same files:
 * DIRECT members of an exported declaration is 7,270; every signature under one
 * (this rule) is 7,563; every signature in the files regardless of export is
 * 7,634. A floor derived from one and compared against a count from another is
 * a floor that fails for reasons unrelated to the property it guards.
 */
const MINIMUM_SCANNED_MEMBERS = 6500;
const MINIMUM_VOCABULARY = 9;

/**
 * The two names the epic line spells out.
 *
 * Asserted against the vocabulary recovered from the producer, so this gate
 * goes red if the backend list is narrowed past the requirement that created
 * both of them — rather than silently scanning for a smaller set.
 */
const VOCABULARY_MUST_CONTAIN = ["category", "optionName"];

/* -------------------------------------------------------------------------- */
/*  Dispositions — a table, not a switch                                        */
/* -------------------------------------------------------------------------- */

/**
 * Why an ambiguous-looking field is allowed to stay, and what would retire it.
 *
 * `retiresWhen` lives here rather than on each entry because thirty-two
 * hand-written retirement sentences drift into thirty-two different promises.
 * `requiresSupersededBy` is the one property that separates a contract with a
 * successor from one without: an entry claiming `versioned_contract` and naming
 * nothing that replaces it is a field nobody has decided about.
 */
const CONTRACT_DISPOSITIONS = {
  versioned_contract: {
    requiresSupersededBy: true,
    retiresWhen:
      "no supported client version still sends or reads the field AND the typed replacement named "
      + "in `supersededBy` is on the wire. A shipped mobile build cannot be recalled, so #367 "
      + "deliberately did not break these (ADR 0007 D13; the `LEGACY_CONDITION_CONTRACT` shape).",
  },
  external_mirror: {
    requiresSupersededBy: false,
    retiresWhen:
      "never by Mercaria alone. The field mirrors a vocabulary an external platform owns and is "
      + "round-tripped back to it by the connector, so typing it would be a promise about somebody "
      + "else's data. It retires when the connector stops carrying that platform field.",
  },
  external_observation: {
    requiresSupersededBy: false,
    retiresWhen:
      "never. An ingestion adapter reports what a source SAID; #62's write boundary is that an "
      + "adapter cannot name a Mercaria concept, and normalizing here would move that decision "
      + "into the adapter. #58 is what resolves an observation to a typed concept.",
  },
  immutable_snapshot: {
    requiresSupersededBy: false,
    retiresWhen:
      "never. This is a historical commercial record captured at the moment of the sale, and ADR "
      + "0007 D13 restates that order, payment and refund snapshots are never rewritten — which is "
      + "exactly what re-typing the field would require of every existing row.",
  },
  presentation: {
    requiresSupersededBy: false,
    retiresWhen:
      "never. ADR 0007 D1: a label, name, description or slug IS presentation and is never "
      + "identity. The field is a display string; identity is the typed sibling named in `why`, and "
      + "removing the string would remove the words a person reads, not an ambiguity.",
  },
  scoped_key: {
    requiresSupersededBy: false,
    retiresWhen:
      "never. The value is a stable machine key in ADR 0007 D1's own sense, made unambiguous by a "
      + "typed sibling in the SAME type that says which registry it belongs to. Without that "
      + "sibling it would be ambiguous, which is why the sibling is named in `why`.",
  },
};

/* -------------------------------------------------------------------------- */
/*  The excused set — exact, with counts                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every ambiguous-looking bare string in the published contract today.
 *
 * `path` is the OWNER chain the walk produces, so a nested member reads
 * `IngestProduct.options.name`. `count` closes the hole an entry without one
 * leaves: a single excusing row silently covering a SECOND occurrence of the
 * same field on the same type.
 */
const LEGACY_AMBIGUOUS_CONTRACTS = [
  /* ---- check A: an ambiguous NAME on a bare string ---------------------- */
  {
    file: "authoring-schema.ts",
    path: "AuthoringCanonicalCandidate.brandName",
    count: 1,
    disposition: "presentation",
    supersededBy: null,
    why:
      "The candidate's identity is the `id` and `canonicalProductId` beside it; the authoring "
      + "surface selects a row by id and shows this name so two similar products are "
      + "distinguishable.",
  },
  {
    file: "catalog-external-mapping.ts",
    path: "CatalogExternalTarget.controlledValue",
    count: 1,
    disposition: "scoped_key",
    supersededBy: null,
    why:
      "An `attribute_enum_values.value` — already normalized — and the `attributeKey` in the SAME "
      + "union member says which attribute's enumeration it belongs to. Both keys are frozen from "
      + "insert by a trigger (ADR 0007 D1 rule 2).",
  },
  {
    file: "catalog-page.ts",
    path: "CatalogStructuredData.brandName",
    count: 1,
    disposition: "presentation",
    supersededBy: null,
    why:
      "schema.org JSON-LD output. The `Organization.brand` property IS a name in that vocabulary, "
      + "so an id here would be unpublishable; the identity behind the page is `BrandPage.brandId`.",
  },
  {
    file: "integration.ts",
    path: "IngestProduct.productType",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why:
      "The plugin push contract's mirror of the platform's own `product_type` free-text field. "
      + "`catalog-identity-isolation.test.ts` excuses the matching `ingestProductSchema` field in "
      + "the same words. Distinct from a product type DEFINITION, which is "
      + "`listings.product_type_definition_id`.",
  },
  {
    file: "listing.ts",
    path: "Listing.category",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "categoryId (the typed identity exists as `listings.category_id`; it is not on the wire yet)",
    why:
      "The v1 read contract. Served as the LEAF of the materialized slug path — "
      + "`catalog-hydration.service.ts` derives it from `listing.categorySlugs`, the "
      + "`condition` <- `itemCondition.key` projection shape. ADR 0007 D13 keeps the slug path as a "
      + "v1 read contract, superseded by ids and retired once no reader remains.",
  },
  {
    file: "listing.ts",
    path: "Listing.productType",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why:
      "The Shopify/WooCommerce merchandising string, written by `connector-sync.service.ts` on "
      + "import and pushed BACK to the platform on export. Not a product type definition.",
  },
  {
    file: "listing.ts",
    path: "CreateP2PListingInput.category",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "categoryId (the typed identity exists as `listings.category_id`; it is not on the wire yet)",
    why:
      "The v1 write contract, the DTO half of `createP2PListingSchema` — which "
      + "`catalog-identity-isolation.test.ts` already excuses on the request side. A shipped mobile "
      + "build sends this field.",
  },
  {
    file: "listing.ts",
    path: "CreateStoreProductInput.category",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "categoryId (the typed identity exists as `listings.category_id`; it is not on the wire yet)",
    why:
      "The v1 write contract, the DTO half of `createStoreProductSchema` — excused on the request "
      + "side by `catalog-identity-isolation.test.ts` in the same words.",
  },
  {
    file: "listing.ts",
    path: "CreateStoreProductInput.productType",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why: "The Shopify merchandising string a merchant types, mirrored to and from the platform.",
  },
  {
    file: "listing.ts",
    path: "UpdateListingInput.productType",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why:
      "The same platform field on the PATCH shape; `connector-sync.service.ts` merges it under the "
      + "pin policy rather than re-deriving it.",
  },
  {
    file: "listing.ts",
    path: "ListingQuery.category",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "categoryId (the typed identity exists as `listings.category_id`; it is not on the wire yet)",
    why:
      "The v1 browse filter — a single category SLUG, matched against the GIN-indexed "
      + "`listings.category_slugs`. ADR 0007 D13 retains those browse reads until no client sends "
      + "the parameter.",
  },
  {
    file: "listing.ts",
    path: "ListingQuery.productType",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why: "Filters on the mirrored platform string a merchant's imported catalogue carries.",
  },
  {
    file: "merchant-page.ts",
    path: "MerchantBrandStanding.brandName",
    count: 1,
    disposition: "presentation",
    supersededBy: null,
    why: "Sits directly beside `brandId` and `brandSlug` in the same type; identity is the id.",
  },
  {
    file: "product.ts",
    path: "ProductSummary.brand",
    count: 1,
    disposition: "presentation",
    supersededBy: null,
    why:
      "A browse-card display string — its own docblock says \"Brand / seller short name shown above "
      + "the title\", i.e. it is whichever of the two the card has. Identity for the card is `id`.",
  },
  {
    file: "sell-yours.ts",
    path: "SellerMatchCandidateDTO.brand",
    count: 1,
    disposition: "presentation",
    supersededBy: null,
    why:
      "One candidate offered to a seller during identify. Its identity is the "
      + "`canonicalProductId`/`canonicalVariantId` above it; this is the word that lets a person "
      + "tell two candidates apart.",
  },
  {
    file: "seo.ts",
    path: "SeoVisibleFacts.brandName",
    count: 1,
    disposition: "presentation",
    supersededBy: null,
    why: "The words that go in a title tag and a meta description. Nothing resolves it.",
  },

  /* ---- check B: an ambiguous POSITION inside an option-shaped owner ------ */
  {
    file: "draft-order.ts",
    path: "DraftOrderLineItem.optionValues.name",
    count: 1,
    disposition: "immutable_snapshot",
    supersededBy: null,
    why:
      "Captured onto the POS line \"at the time the line was added\", beside the snapshotted "
      + "`unitPrice` and `variantTitle`, and carried into the paid `Order` when the draft "
      + "completes.",
  },
  {
    file: "draft-order.ts",
    path: "DraftOrderLineItem.optionValues.value",
    count: 1,
    disposition: "immutable_snapshot",
    supersededBy: null,
    why:
      "The value half of the same snapshotted assignment — a POS line records \"Size: M\" as two "
      + "free strings and the paid `Order` carries them forward unchanged.",
  },
  {
    file: "ingestion.ts",
    path: "NormalizedSourceOption.name",
    count: 1,
    disposition: "external_observation",
    supersededBy: null,
    why:
      "\"One observed option assignment\" as an adapter read it. #62's adapter signature returns no "
      + "canonical id and has nowhere to put one; #58 is what resolves it.",
  },
  {
    file: "ingestion.ts",
    path: "NormalizedSourceOption.value",
    count: 1,
    disposition: "external_observation",
    supersededBy: null,
    why:
      "The value half of the same observation. An adapter reports \"Colour: Black\" as the source "
      + "spelled it, in the source's own language, and resolving it is #58's decision to make.",
  },
  {
    file: "integration.ts",
    path: "IngestOptionValue.name",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why: "The plugin push contract's mirror of the platform's own option-value pair.",
  },
  {
    file: "integration.ts",
    path: "IngestOptionValue.value",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why:
      "The value half of the same mirrored pair. The plugin sends whatever the platform stored, "
      + "and Mercaria pushes it back on export rather than reinterpreting it.",
  },
  {
    file: "integration.ts",
    path: "IngestProduct.options.name",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why: "The option NAME as the external platform publishes it on the pushed product.",
  },
  {
    file: "integration.ts",
    path: "IngestProduct.options.values",
    count: 1,
    disposition: "external_mirror",
    supersededBy: null,
    why:
      "The allowed values as the external platform publishes them, in the platform's own order and "
      + "spelling. Normalizing them here would silently rewrite a merchant's catalogue.",
  },
  {
    file: "listing.ts",
    path: "ListingOption.name",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "NativeVariantAxisSummary.attributeKey / attributeDefinitionId (`variant-axis.ts`)",
    why:
      "ADR 0007 D6: `listing_options` and `product_variant_option_values` are RETAINED as legacy "
      + "claims — \"Not dropped, not silently normalized\" — beside the typed axes, and the legacy "
      + "free-text path survives the whole rollout.",
  },
  {
    file: "listing.ts",
    path: "ListingOption.values",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "NativeVariantAxisSummary (`variant-axis.ts`), whose values are enum rows or base-unit magnitudes",
    why:
      "The values half of the same D6 legacy claim. An ambiguous legacy value stays text and stays "
      + "in a review queue — `resolveLegacyOptionName` refuses a near-miss rather than inventing a "
      + "normalization, because a near-miss is a miss.",
  },
  {
    file: "listing.ts",
    path: "CreateStoreProductVariantInput.optionValues.name",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "TypedVariantAxisAssignment.attributeDefinitionId (`variant-axis.ts`)",
    why:
      "The v1 write shape a store product is created with. D6 keeps it accepting free text until "
      + "the typed authoring path replaces the caller.",
  },
  {
    file: "listing.ts",
    path: "CreateStoreProductVariantInput.optionValues.value",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "TypedVariantAxisAssignment.normalizedValue (`variant-axis.ts`)",
    why:
      "The value half of the same v1 write shape. A merchant types \"Rojo\"; nothing on this path "
      + "claims to know which registry value that is.",
  },
  {
    file: "order.ts",
    path: "OrderItem.optionValues.name",
    count: 1,
    disposition: "immutable_snapshot",
    supersededBy: null,
    why:
      "\"Variant option assignments at purchase time\", beside `unitPrice` and `variantTitle` at "
      + "purchase time. Re-typing it would rewrite what a buyer bought.",
  },
  {
    file: "order.ts",
    path: "OrderItem.optionValues.value",
    count: 1,
    disposition: "immutable_snapshot",
    supersededBy: null,
    why:
      "The value half of the same purchase-time snapshot. What the buyer selected is part of the "
      + "commercial record and is never recomputed from the variant's current axes.",
  },
  {
    file: "variant.ts",
    path: "VariantOptionValue.name",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "NativeVariantAxisAssignmentSummary.attributeKey (`variant-axis.ts`)",
    why:
      "The read projection of a D6 legacy claim — `ProductVariantDTO.optionValues` is what every "
      + "current client renders a variant picker from.",
  },
  {
    file: "variant.ts",
    path: "VariantOptionValue.value",
    count: 1,
    disposition: "versioned_contract",
    supersededBy: "NativeVariantAxisAssignmentSummary.displayValue / normalizedValue (`variant-axis.ts`)",
    why:
      "The value half of the same read projection. Every current variant picker renders this pair, "
      + "so it is served until the typed axes are on the wire.",
  },
];

/** Exact, so a thirty-third entry is a deliberate edit rather than a wildcard. */
const EXPECTED_EXCUSED_ENTRIES = 32;

/* -------------------------------------------------------------------------- */
/*  Check B's vocabulary — an option-shaped owner, a generic member             */
/* -------------------------------------------------------------------------- */

/**
 * The owner WORDS that make a generic member an option assignment.
 *
 * Kept narrow on purpose. `attribute` and `category` are NOT here: their fields
 * already carry their own discriminating names (`attributeKey`, `categoryId`)
 * and check A's vocabulary covers the ambiguous spellings, so adding them would
 * fire on `AttributeDefinition.name` — a label, which ADR 0007 D1 says is
 * presentation and expects to be a string.
 *
 * `axes` is here beside `axis` because it is the plural this repository
 * actually writes, and the first version of this guard matched a substring
 * `axis` and therefore did NOT fire on `axes: { value: string }[]`. Its own
 * positive control caught that, which is the entire reason the control exists.
 */
const OPTION_SHAPED_OWNER_WORDS = new Set(["option", "options", "axis", "axes"]);

/**
 * Whole WORDS, never a substring.
 *
 * `taxes`, `taxonomy` and `Taxable` all contain `axes`/`ax`, and a substring
 * match would file `TaxLine.value` as an option assignment. Splitting on `.`
 * and on camelCase boundaries is what makes "names an option axis" a claim
 * about the identifier's words rather than about its letters.
 */
function namesAnOptionAxis(ownerPath) {
  return ownerPath
    .split(".")
    .flatMap((segment) => segment.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[^A-Za-z0-9]+/u))
    .some((word) => OPTION_SHAPED_OWNER_WORDS.has(word.toLowerCase()));
}

/** Members whose own name says nothing about what they identify. */
const GENERIC_MEMBERS = new Set(["name", "value", "values"]);

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** `string`, `string | null`, `string | undefined` — a bare string either way. */
function isBareString(type) {
  if (type.kind === ts.SyntaxKind.StringKeyword) return true;
  if (!ts.isUnionTypeNode(type)) return false;
  const hasString = type.types.some((part) => part.kind === ts.SyntaxKind.StringKeyword);
  if (!hasString) return false;
  return type.types.every(
    (part) =>
      part.kind === ts.SyntaxKind.StringKeyword
      || part.kind === ts.SyntaxKind.UndefinedKeyword
      || (ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword),
  );
}

/** `string[]` and `readonly string[]`. */
function isBareStringArray(type) {
  const inner =
    ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword
      ? type.type
      : type;
  return ts.isArrayTypeNode(inner) && inner.elementType.kind === ts.SyntaxKind.StringKeyword;
}

/**
 * Every ambiguous field in one source text, with the count of members scanned.
 *
 * Returned rather than pushed to a module global so the detector controls below
 * run through THIS function — the same code path the tree is scanned with. A
 * control that exercised a copy of the matcher would prove the copy works.
 *
 * Comments are excluded by construction: an AST has no comment nodes on this
 * walk, and this file's own docblocks spell out every shape it looks for. A
 * text scan of this repository fires on its own explanations.
 */
function findAmbiguousContracts(fileName, text, vocabulary) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const found = [];
  let members = 0;
  let exportedTypes = 0;

  const unwrapReadonlyArray = (type) => {
    let current = type;
    if (ts.isTypeOperatorNode(current) && current.operator === ts.SyntaxKind.ReadonlyKeyword) {
      current = current.type;
    }
    return current;
  };

  const scanMember = (node, ownerPath) => {
    if (!ts.isPropertySignature(node) || node.name === undefined || node.type === undefined) return;
    members += 1;
    const name = node.name.getText(source);
    const path = `${ownerPath}.${name}`;

    if (isBareString(node.type) && vocabulary.has(name)) {
      found.push({ file: fileName, path, line: at(node), check: "A", field: name });
    }
    if (
      GENERIC_MEMBERS.has(name)
      && (isBareString(node.type) || isBareStringArray(node.type))
      && namesAnOptionAxis(ownerPath)
    ) {
      found.push({ file: fileName, path, line: at(node), check: "B", field: name });
    }

    // Nested object literals: `optionValues: { name: string; value: string }[]`
    // is the shape the epic line names and it has no named type to walk into.
    //
    // A GENERIC's type ARGUMENTS are in the descent because a type literal hides
    // there just as well — and the shape that proved it is
    // `SellerPrefillField<{ key: string; value: string }>` on
    // `SellerDraftPrefill.variantAttributes`, an attribute key/value pair, which
    // is precisely the class this gate exists to catch. Without this branch a
    // `SellerPrefillField<{ optionName: string }>` would be invisible.
    //
    // This branch is what makes the walk's population "every property signature
    // under an exported declaration" with no qualifier. It was five members
    // short of that before, and the five were found by comparing this walker
    // against a plain `forEachChild` collector rather than by anything failing.
    const descend = (type) => {
      const bare = unwrapReadonlyArray(type);
      if (ts.isTypeLiteralNode(bare)) {
        for (const nested of bare.members) scanMember(nested, path);
      } else if (ts.isArrayTypeNode(bare)) {
        descend(bare.elementType);
      } else if (ts.isUnionTypeNode(bare) || ts.isIntersectionTypeNode(bare)) {
        for (const part of bare.types) descend(part);
      } else if (ts.isParenthesizedTypeNode(bare)) {
        descend(bare.type);
      } else if (ts.isTypeReferenceNode(bare) && bare.typeArguments !== undefined) {
        for (const argument of bare.typeArguments) descend(argument);
      }
    };
    descend(node.type);
  };

  /** Every property signature reachable from an exported declaration's type. */
  const scanDeclaration = (declaration, ownerName) => {
    if (ts.isInterfaceDeclaration(declaration)) {
      for (const member of declaration.members) scanMember(member, ownerName);
      return;
    }
    // A type alias: walk any type literal in it, including every member of a
    // discriminated union (`CatalogStructuredData`) and both sides of an
    // intersection (`UpdateListingInput`).
    const walk = (node) => {
      if (ts.isTypeLiteralNode(node)) {
        for (const member of node.members) scanMember(member, ownerName);
        return;
      }
      ts.forEachChild(node, walk);
    };
    if (declaration.type !== undefined) walk(declaration.type);
  };

  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const exported = (node.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (exported) {
        exportedTypes += 1;
        scanDeclaration(node, node.name.text);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { found, members, exportedTypes };
}

/* -------------------------------------------------------------------------- */
/*  check 0 — the vocabulary comes from the producer                            */
/* -------------------------------------------------------------------------- */

/**
 * Read `IDENTITY_SHAPED_FIELDS` out of the backend gate.
 *
 * Its members are written as concatenated fragments (`'categ' + 'ory'`) so a
 * text search for the forbidden shape does not land on that file — which is
 * also why this is an AST walk that FOLDS the concatenation rather than a
 * regex. `eval` is not used: a `+` chain of string literals is folded by hand,
 * and anything else in the array is reported rather than skipped.
 */
function readProducerVocabulary() {
  const path = join(repositoryRoot, PRODUCER);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    failures.push(
      `check 0: could not read the vocabulary's producer at ${PRODUCER}: ${String(error)}. `
        + "The vocabulary is not copied here on purpose — two lists of which field names are "
        + "identity-shaped would be two answers to one question.",
    );
    return new Set();
  }

  const source = ts.createSourceFile(PRODUCER, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let literal = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === PRODUCER_DECLARATION
      && node.initializer !== undefined
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      literal = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (literal === null) {
    failures.push(
      `check 0: ${PRODUCER} no longer declares \`${PRODUCER_DECLARATION}\` as an array literal. `
        + "An unmatched pattern is a FAILURE here, not a pass — a vocabulary that came back empty "
        + "would report a perfectly clean tree. If the declaration moved, point this at its new "
        + "home in the same change.",
    );
    return new Set();
  }

  /** Fold a `'a' + 'b' + 'c'` chain of string literals, or return null. */
  const fold = (node) => {
    if (ts.isStringLiteral(node)) return node.text;
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = fold(node.left);
      const right = fold(node.right);
      return left === null || right === null ? null : left + right;
    }
    return null;
  };

  const names = new Set();
  for (const element of literal.elements) {
    const folded = fold(element);
    if (folded === null) {
      failures.push(
        `check 0: \`${PRODUCER_DECLARATION}\` carries an element this reader cannot fold `
          + `(${element.getText(source)}). Skipping it would narrow the scan silently, so it fails.`,
      );
      continue;
    }
    names.add(folded);
  }
  return names;
}

const vocabulary = readProducerVocabulary();

if (vocabulary.size < MINIMUM_VOCABULARY) {
  failures.push(
    `check 0: recovered ${vocabulary.size} identity-shaped field name(s) from ${PRODUCER} but `
      + `expected at least ${MINIMUM_VOCABULARY}. A short vocabulary scans for less and reports `
      + "the same clean tree as a codebase with nothing to find.",
  );
}
for (const required of VOCABULARY_MUST_CONTAIN) {
  if (vocabulary.has(required)) continue;
  failures.push(
    `check 0: the vocabulary recovered from ${PRODUCER} does not contain ${JSON.stringify(required)}, `
      + "which epic #367 line 104 names by hand. Narrowing the backend list past the requirement "
      + "that created it would silently narrow this gate too.",
  );
}
if (vocabulary.size > 0) {
  notes.push(
    `check 0: ${vocabulary.size} identity-shaped field name(s) read out of ${PRODUCER} `
      + `(${[...vocabulary].sort().join(", ")}).`,
  );
}

/* -------------------------------------------------------------------------- */
/*  detector controls — every run, through the same function                    */
/* -------------------------------------------------------------------------- */

/**
 * EVERY vocabulary member is proven able to fire, on every run, derived from
 * the vocabulary rather than hand-listed.
 *
 * This is the check that stops an arm being decoration. Measured on the tree
 * this landed against, the backend gate's CLAUSE 3 has nine identity-shaped
 * names and only TWO of them (`category`, `productType`) match anything in its
 * population — the other seven produce a clean zero, and a clean zero is what a
 * misspelled, mis-anchored or population-mismatched arm produces too. Over
 * `packages/shared-types/src` five of the nine fire against real declarations;
 * the remaining four would be unmeasured for exactly the same reason.
 *
 * So each name is put through the REAL matcher as a synthetic declaration and
 * must be caught, and its `<name>Id` form must not be. A hand-written control
 * list cannot do this job: the one it would omit is the one somebody added
 * last, which is the arm with no live match.
 */
const derivedControls = [];
for (const name of [...vocabulary].sort()) {
  derivedControls.push({
    code: `export interface T { ${name}: string; }`,
    check: "A",
    detected: true,
    why: `the vocabulary member ${JSON.stringify(name)} as a bare string`,
  });
  derivedControls.push({
    code: `export interface T { ${name}Id: string; }`,
    check: "A",
    detected: false,
    why: `${name}Id — the opaque-id form the vocabulary member must not swallow`,
  });
}

/**
 * Shape controls, beside the derived ones above.
 *
 * These cover the DECLARATION shapes rather than the vocabulary: an optional
 * member, a `string | null`, a union member, a nested literal, a comment. Every
 * negative is a shape that really sits in the scanned tree — `categoryId` is on
 * eleven types, `attributeKey` on nine — and a detector that fired on those
 * would be narrowed by whoever hit it first, in the permissive direction.
 */
const DETECTOR_CONTROLS = [
  ...derivedControls,
  // A — must fire
  { code: "export interface T { category?: string; }", check: "A", detected: true, why: "optional" },
  { code: "export interface T { readonly brandName: string | null; }", check: "A", detected: true, why: "string | null" },
  { code: "export type T = { productType: string };", check: "A", detected: true, why: "type alias literal" },
  { code: "export type T = { kind: 'a' } | { kind: 'b'; category: string };", check: "A", detected: true, why: "union member" },
  { code: "export interface T { nested: { category: string }[]; }", check: "A", detected: true, why: "nested object literal" },
  { code: "export interface T { prefill: Field<{ category: string }>; }", check: "A", detected: true, why: "a type literal inside a generic's type arguments" },
  { code: "export interface T { groups: Readonly<Record<string, { productType: string }>>; }", check: "A", detected: true, why: "a type literal two generics deep" },
  // A — must NOT fire
  { code: "export interface T { categoryKey: string; }", check: "A", detected: false, why: "a stable machine key" },
  { code: "export interface T { categorySlug: string; }", check: "A", detected: false, why: "declared presentation" },
  { code: "export interface T { productTypeKey: string; }", check: "A", detected: false, why: "a stable machine key" },
  { code: "export interface T { category: CategoryRef; }", check: "A", detected: false, why: "already typed" },
  { code: "export interface T { category: 'a' | 'b'; }", check: "A", detected: false, why: "a closed union" },
  { code: "interface T { category: string; }", check: "A", detected: false, why: "not exported" },
  { code: "// category: string\nexport interface T { id: string; }", check: "A", detected: false, why: "a line comment" },
  { code: "/** category: string */\nexport interface T { id: string; }", check: "A", detected: false, why: "a docblock" },
  { code: "export const x = { category: 'string' };", check: "A", detected: false, why: "a value, not a type" },
  // B — must fire
  { code: "export interface ListingOption { name: string; }", check: "B", detected: true, why: "an option-shaped owner" },
  { code: "export interface O { optionValues: { name: string; value: string }[]; }", check: "B", detected: true, why: "a nested option pair" },
  { code: "export interface VariantAxisClaim { values: string[]; }", check: "B", detected: true, why: "an axis-shaped owner, string[]" },
  { code: "export interface O { axes: { value: string }[]; }", check: "B", detected: true, why: "an axis-shaped member path" },
  { code: "export interface O { optionValues: readonly { name: string }[]; }", check: "B", detected: true, why: "readonly array" },
  { code: "export interface O { optionValues: Field<{ name: string }>; }", check: "B", detected: true, why: "an option pair inside a generic's type arguments" },
  // B — must NOT fire
  { code: "export interface Store { name: string; }", check: "B", detected: false, why: "an ordinary name" },
  { code: "export interface ListingOption { position: number; }", check: "B", detected: false, why: "not a generic member" },
  { code: "export interface ListingOption { name: OptionName; }", check: "B", detected: false, why: "already typed" },
  { code: "export interface O { optionValues: { attributeDefinitionId: string }[]; }", check: "B", detected: false, why: "the typed replacement" },
  { code: "export interface Category { name: string; }", check: "B", detected: false, why: "a label is presentation (D1)" },
  { code: "export interface TaxLine { value: string; }", check: "B", detected: false, why: "`taxes` contains `axes` — a substring match would file a tax line as an option" },
  { code: "export interface T { taxonomyRefinement: { name: string }[]; }", check: "B", detected: false, why: "`taxonomy` contains `ax` and names no axis" },
  { code: "export interface T { adoptions: { name: string }[]; }", check: "B", detected: false, why: "`adoptions` contains `option` as a substring and is not one" },
];

for (const control of DETECTOR_CONTROLS) {
  const { found } = findAmbiguousContracts("control.ts", control.code, vocabulary);
  const detected = found.some((hit) => hit.check === control.check);
  if (detected === control.detected) continue;
  failures.push(
    `check ${control.check}: the detector's ${control.detected ? "POSITIVE" : "NEGATIVE"} control `
      + `(${control.why}) ${detected ? "fired when it must not" : "did NOT fire"}. `
      + `Source: ${JSON.stringify(control.code)}. A detector that cannot see a violation reports a `
      + "clean tree, which is the same output as a clean tree.",
  );
}

/* -------------------------------------------------------------------------- */
/*  the walk                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The published contract surface.
 *
 * `readdirSync` rather than `git ls-files`: an UNTRACKED file is exactly the
 * case this should catch on the day a contract is written, not on the day it is
 * committed (`validate-lint-coverage.mjs`'s reasoning). The directory is flat
 * and asserted to be, so a one-level read cannot silently skip a subtree.
 */
let contractFiles = [];
try {
  const entries = readdirSync(CONTRACT_DIR, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (directories.length > 0) {
    failures.push(
      `the walk reads ${CONTRACT_DIR} one level deep, and it now contains `
        + `${directories.length} subdirectory/subdirectories (${directories.join(", ")}). A `
        + "one-level read of a nested tree scans less and reports the same clean line; make the "
        + "walk recursive in the same change that adds the subdirectory.",
    );
  }
  contractFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts")
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  failures.push(`could not read ${CONTRACT_DIR}: ${String(error)}`);
}

let scannedMembers = 0;
let scannedTypes = 0;
const found = [];

for (const file of contractFiles) {
  const path = join(CONTRACT_DIR, file);
  let text;
  try {
    // A readdir that returned a cached or empty result reads exactly like a
    // clean scan; stat every path so it cannot.
    if (statSync(path).size === 0) {
      failures.push(`${file} is empty — an empty contract file scans as a clean one.`);
      continue;
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    failures.push(`could not read ${file}: ${String(error)}`);
    continue;
  }
  const result = findAmbiguousContracts(file, text, vocabulary);
  scannedMembers += result.members;
  scannedTypes += result.exportedTypes;
  found.push(...result.found);
}

if (contractFiles.length < MINIMUM_CONTRACT_FILES) {
  failures.push(
    `walked ${contractFiles.length} contract module(s) in packages/shared-types/src but expected at `
      + `least ${MINIMUM_CONTRACT_FILES}. A listing that came back short reports a clean surface, `
      + "which is indistinguishable from a clean surface.",
  );
}
if (scannedTypes < MINIMUM_EXPORTED_TYPES) {
  failures.push(
    `found ${scannedTypes} exported type(s) but expected at least ${MINIMUM_EXPORTED_TYPES}. A parse `
      + "that produced no declarations scans no members and reports nothing found.",
  );
}
if (scannedMembers < MINIMUM_SCANNED_MEMBERS) {
  failures.push(
    `scanned ${scannedMembers} property signature(s) but expected at least `
      + `${MINIMUM_SCANNED_MEMBERS}. The two floors above are about the WALK; this one is about the `
      + "recursion into it, and a `scanMember` that stopped descending would still meet them.",
  );
}

/* -------------------------------------------------------------------------- */
/*  the verdict — an exact set, in both directions                              */
/* -------------------------------------------------------------------------- */

const asKey = (entry) => `${entry.file}:${entry.path}`;

const foundCounts = new Map();
const foundLines = new Map();
for (const hit of found) {
  const key = asKey(hit);
  foundCounts.set(key, (foundCounts.get(key) ?? 0) + 1);
  if (!foundLines.has(key)) foundLines.set(key, []);
  foundLines.get(key).push(hit.line);
}

const excusedCounts = new Map();
for (const entry of LEGACY_AMBIGUOUS_CONTRACTS) {
  excusedCounts.set(asKey(entry), (excusedCounts.get(asKey(entry)) ?? 0) + entry.count);
}

for (const [key, count] of [...foundCounts].sort()) {
  const excused = excusedCounts.get(key) ?? 0;
  if (count === excused) continue;
  const lines = foundLines.get(key).join(", ");
  if (excused === 0) {
    failures.push(
      `NEW ambiguous public catalog contract: \`${key}\` (line ${lines}) is a bare string where a `
        + "typed catalog identity belongs. A free string cannot say which taxonomy it names, which "
        + "locale it is in, or whether it is a label or a key (ADR 0007 D1, epic #367 line 104). "
        + "Use an opaque id or a stable machine key — `categoryId`, `productTypeKey`, "
        + "`attributeDefinitionId` — or, if this genuinely is a shipped v1 contract, an external "
        + "platform's field, a purchase-time snapshot or presentation beside a typed id, add it to "
        + "`LEGACY_AMBIGUOUS_CONTRACTS` in this file with its disposition and reason.",
    );
  } else {
    failures.push(
      `\`${key}\` occurs ${count} time(s) (line ${lines}) but `
        + `LEGACY_AMBIGUOUS_CONTRACTS excuses ${excused}. An excusing entry that covers more than it `
        + "says is how a second occurrence lands unreviewed.",
    );
  }
}

for (const [key, count] of [...excusedCounts].sort()) {
  const actual = foundCounts.get(key) ?? 0;
  if (actual >= count) continue;
  failures.push(
    `LEGACY_AMBIGUOUS_CONTRACTS excuses \`${key}\` ${count} time(s) but the walk found ${actual}. `
      + "If the contract retired, delete the entry in the same change — reading its retirement "
      + "condition is the point of the entry existing. If the walk stopped seeing it, the detector "
      + "is broken and every other entry here is unverified too.",
  );
}

/* -------------------------------------------------------------------------- */
/*  the excused set is well-formed                                              */
/* -------------------------------------------------------------------------- */

if (LEGACY_AMBIGUOUS_CONTRACTS.length !== EXPECTED_EXCUSED_ENTRIES) {
  failures.push(
    `LEGACY_AMBIGUOUS_CONTRACTS has ${LEGACY_AMBIGUOUS_CONTRACTS.length} entries and `
      + `EXPECTED_EXCUSED_ENTRIES is ${EXPECTED_EXCUSED_ENTRIES}. A list of excuses that can grow `
      + "silently is the mechanism by which a gate erodes to `>= 0`; move the number in the same "
      + "commit that moves the list, so the diff shows both.",
  );
}

for (const entry of LEGACY_AMBIGUOUS_CONTRACTS) {
  const disposition = CONTRACT_DISPOSITIONS[entry.disposition];
  if (disposition === undefined) {
    failures.push(
      `${asKey(entry)} claims the disposition ${JSON.stringify(entry.disposition)}, which is not in `
        + `the closed set (${Object.keys(CONTRACT_DISPOSITIONS).join(", ")}). A free-text `
        + "disposition is a reason nobody can check.",
    );
    continue;
  }
  if (disposition.requiresSupersededBy && !entry.supersededBy) {
    failures.push(
      `${asKey(entry)} is a \`${entry.disposition}\` and names nothing in \`supersededBy\`. A `
        + "versioned contract with no successor is a field nobody has decided about, which is the "
        + "state this gate exists to end.",
    );
  }
  if (!disposition.requiresSupersededBy && entry.supersededBy) {
    failures.push(
      `${asKey(entry)} is a \`${entry.disposition}\` — which retires never — and names a successor. `
        + "Either it is a versioned contract or nothing replaces it; both cannot be true.",
    );
  }
  if (typeof entry.why !== "string" || entry.why.length < 60) {
    failures.push(
      `${asKey(entry)} carries no substantial reason. The reason is what the next reader uses to `
        + "decide whether the entry is still true.",
    );
  }
  if (!Number.isInteger(entry.count) || entry.count < 1) {
    failures.push(`${asKey(entry)} has a non-positive \`count\`.`);
  }
}

/* -------------------------------------------------------------------------- */
/*  verdict                                                                     */
/* -------------------------------------------------------------------------- */

const byCheck = (check) => found.filter((hit) => hit.check === check).length;
notes.push(
  `walked ${contractFiles.length} contract module(s), ${scannedTypes} exported type(s), `
    + `${scannedMembers} property signature(s).`,
);

/**
 * Which arms are exercised by REAL declarations, and which only by the derived
 * control.
 *
 * Printed on success because a green run erases exactly this distinction. An
 * arm with no live match is not a defect — the tree may simply be clean — but
 * it is unmeasured against real source, and the next reader needs to know which
 * of the two kinds of evidence each arm has before reading the count as
 * thoroughness.
 */
const liveByName = new Map();
for (const hit of found) {
  if (hit.check !== "A") continue;
  liveByName.set(hit.field, (liveByName.get(hit.field) ?? 0) + 1);
}
const armsLive = [...vocabulary].filter((name) => (liveByName.get(name) ?? 0) > 0).sort();
const armsControlOnly = [...vocabulary].filter((name) => (liveByName.get(name) ?? 0) === 0).sort();
notes.push(
  `check A arms exercised by real declarations: ${armsLive.length}/${vocabulary.size} `
    + `(${armsLive.map((n) => `${n}×${liveByName.get(n)}`).join(", ") || "none"}). `
    + `Proven only by the derived control: ${armsControlOnly.join(", ") || "none"}.`,
);
notes.push(
  `check A (ambiguous name): ${byCheck("A")} occurrence(s). `
    + `check B (ambiguous position in an option-shaped owner): ${byCheck("B")}. `
    + `All ${LEGACY_AMBIGUOUS_CONTRACTS.length} are excused with a disposition and a reason.`,
);

for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
  console.error(`\nvalidate-catalog-identity-contracts: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  "\nvalidate-catalog-identity-contracts: OK — no NEW ambiguous bare-string catalog identity in the "
    + "published contract.",
);
