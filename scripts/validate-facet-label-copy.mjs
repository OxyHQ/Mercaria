#!/usr/bin/env bun

/**
 * A shopper must never read a machine key where a filter name belongs (#367,
 * "public clients never display raw internal keys as normal UX").
 *
 * ## What actually went wrong, measured
 *
 * `services/facets/labels.ts` resolves every facet string Mercaria holds a
 * localization row for and reports the rest through `stableKeyLabel`, which
 * returns `{ text: <the machine key>, source: 'stable_key' }`. Its own docblock
 * explains why that is right: there is no `commerce_dimension` entity, no
 * localization table for one, and no place a translator could put "Precio", so
 * inventing English server-side would look like copy nobody needs to translate.
 * The client owns it.
 *
 * The client did not own it. `FacetRail.tsx` rendered `facet.label.text` and
 * `bucket.label.text` directly, so every commerce dimension and the taxonomy
 * refinement reached a shopper as its key — `offer_price`, `availability`,
 * `condition`, `market`, `offer_channel`, `category`, with raw bucket keys
 * beneath them, in every locale including English. Nothing could see it:
 * `validate-i18n-strings.mjs` check A looks for hardcoded string LITERALS and
 * these are member expressions; checks B and C gate the bundles, and there were
 * no bundle keys to gate. `tsc` is happy — a key has the same type as a word.
 *
 * ## The three checks, and what each one alone would miss
 *
 *   A. **THE RENDERING WALL.** No client package reads `.label.text` or
 *      `.groupLabel.text` outside `packages/ui/src/lib/facet-labels.ts`. Walked
 *      as a TypeScript AST rather than grepped, which matters more than usual
 *      here: the only two occurrences in the tree today are in the DOCBLOCKS
 *      explaining this rule, so a text scan fires on its own explanation. An AST
 *      excludes comments by construction and cannot be fooled by a `//` inside a
 *      string either.
 *
 *   B. **THE RESOLUTION PROPERTY, by running the real functions.** A wall alone
 *      is satisfied by a resolver that returns the key it was given. So every
 *      value of every closed vocabulary is put through the REAL
 *      `facetStableBucketText` against the REAL `en.json`, and the answer must
 *      differ from the input key. Both directions of the `source` branch are
 *      asserted too — a `stable_key` label must be TRANSLATED and a
 *      `localization` label must pass through UNCHANGED. A resolver that
 *      translated everything would corrupt real copy and still satisfy the
 *      first half.
 *
 *   C. **COVERAGE DERIVED FROM THE PRODUCER.** Two of the vocabularies are not
 *      shared-types tuples and so are invisible to `tsc`: the channel pair and
 *      the market sentinel are SQL literals in
 *      `db/facets/facetRepository.ts`. They are read out of that file — the
 *      producer — and each must resolve. Asserting the ui module against a
 *      second hand-written list here would prove only that somebody copied one
 *      list into two places.
 *
 * The closed vocabularies that ARE shared-types tuples are additionally gated by
 * `tsc` through `Readonly<Record<…>>`, which is why check B does not stop at
 * "the map has an entry" — it asks whether the entry resolves to a sentence.
 *
 * ## What this cannot tell you
 *
 * Whether the rail visibly reads correctly in Arabic, or whether "Market" is the
 * right word for `coalesce(o.country, '*')`. The first is a rendering property of
 * a real foregrounded tab and nothing in this repository runs one (#429 item 2);
 * the second is a copy review. This guard proves that no stable key reaches a
 * render site unresolved, and nothing more.
 *
 * Usage:  bun scripts/validate-facet-label-copy.mjs
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..");

// The real compiler, the way `validate-i18n-strings.mjs` already does it, so a
// fixture root with no `node_modules` of its own still parses.
const ts = createRequire(resolve(here, "../package.json"))("typescript");

import {
  FACET_AVAILABILITY_LABEL_KEYS,
  FACET_CHANNEL_LABEL_KEYS,
  FACET_MARKET_ANY_BUCKET,
  FACET_TITLE_LABEL_KEYS,
  facetBucketText,
  facetStableBucketText,
  facetTitleText,
} from "../packages/ui/src/lib/facet-labels.ts";

import { CONDITION_GROUPS } from "../packages/shared-types/src/condition.ts";
import {
  FACET_COMMERCE_DIMENSIONS,
  FACET_TAXONOMY_KEY,
} from "../packages/shared-types/src/facets.ts";
import { OFFER_AVAILABILITY_STATES } from "../packages/shared-types/src/offer.ts";

const failures = [];
const notes = [];

// There is no fixture-root escape hatch, deliberately.
//
// The house pattern pairs a `validate-X.mjs` with a `test-validate-X.mjs` that
// runs it against a tiny fixture tree, which needs every population floor to
// drop to 1. This guard follows `validate-bidi-isolation.mjs` instead: its
// controls are INTERNAL — check A self-tests its detector on ten synthetic cases
// in the same invocation, check B runs the real resolvers, and check C fails
// rather than skips when its pattern finds nothing. So the floors below are
// always the real ones. An environment variable that lowered them would be a
// documented way to make this guard measure almost nothing, with no caller to
// justify it.
const root = repositoryRoot;

// --------------------------------------------------------------- utilities ---

/** Every file git tracks under `root`, so ignored and generated files cannot count. */
function trackedFiles() {
  const result = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`git ls-files failed in ${root}: ${result.stderr ?? "(no stderr)"}`);
    return [];
  }
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** The `en.json` bundle of `@mercaria/ui`, flattened to dotted keys. */
function readSharedCopy() {
  const path = resolve(root, "packages/ui/src/i18n/locales/en.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`could not read ${path}: ${String(error)}`);
    return new Map();
  }
  const flat = new Map();
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node)) {
      const key = prefix === "" ? name : `${prefix}.${name}`;
      if (typeof value === "string") flat.set(key, value);
      else if (value !== null && typeof value === "object") walk(value, key);
    }
  };
  walk(parsed, "");
  return flat;
}

const sharedCopy = readSharedCopy();

/**
 * The `t` the real resolvers are handed.
 *
 * It THROWS on an unknown key rather than returning the key or a humanised
 * guess. Returning the key would make a missing sentence indistinguishable from
 * a resolver that declined to translate — which is the exact confusion this
 * whole guard exists to remove, so reproducing it in the harness would make
 * check B unable to fail.
 */
function translate(key) {
  const text = sharedCopy.get(key);
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(`ui bundle has no sentence for ${key}`);
  }
  return text;
}

/** A `stable_key` label as the facet service would emit it. */
const stableKeyLabel = (key) => ({ text: key, source: "stable_key" });

// ------------------------------------------------------ A. the rendering wall ---

/**
 * The one module allowed to read a `FacetLabel`'s text.
 *
 * A single entry, and it is the module whose whole job is to decide what to do
 * with `source`. An exception list is how a wall stops being one, so this stays
 * at one member; the next client that needs a facet label calls the resolver.
 */
const LABEL_TEXT_READERS = new Set(["packages/ui/src/lib/facet-labels.ts"]);

/** The client packages a shopper's or a merchant's screen can be built from. */
const CLIENT_PACKAGES = ["packages/frontend", "packages/dashboard", "packages/pos", "packages/ui"];

const MINIMUM_CLIENT_SOURCE_FILES = 300;

/** The property names whose `.text` is a `FacetLabel`'s. */
const LABEL_PROPERTY_NAMES = new Set(["label", "groupLabel"]);

const clientSources = trackedFiles().filter(
  (path) =>
    /\.tsx?$/u.test(path) && CLIENT_PACKAGES.some((pkg) => path.startsWith(`${pkg}/`)),
);

if (clientSources.length < MINIMUM_CLIENT_SOURCE_FILES) {
  failures.push(
    `check A scanned ${clientSources.length} client source files but expected at least `
      + `${MINIMUM_CLIENT_SOURCE_FILES}. A file listing that came back short reports a clean tree, `
      + "which is indistinguishable from a tree with no violations in it.",
  );
}

/**
 * Every read of a label's rendered text in one file, as `{ line, shape }`.
 *
 * THREE shapes, and the second is why this is a function with a control rather
 * than a matcher written once and trusted. The first version of this guard
 * matched only `<expr>.label.text` and reported ZERO reads across the whole
 * tree — including inside `facet-labels.ts`, which does nothing but read them.
 * The resolver takes the label as a PARAMETER, so its reads are `label.text`:
 * a property access on an identifier, which the matcher's
 * `isPropertyAccessExpression(node.expression)` requirement excluded. A client
 * writing `const { label } = facet` would have walked straight through the wall,
 * and the guard would have gone green saying it had found nothing.
 */
function findLabelTextReads(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "text") {
      // 1. `<expr>.label.text` — the shape a component reading a whole facet writes.
      if (
        ts.isPropertyAccessExpression(node.expression)
        && LABEL_PROPERTY_NAMES.has(node.expression.name.text)
      ) {
        found.push({ line: at(node), shape: `.${node.expression.name.text}.text` });
      }
      // 2. `label.text` — the shape a destructure or a parameter produces.
      else if (
        ts.isIdentifier(node.expression)
        && LABEL_PROPERTY_NAMES.has(node.expression.text)
      ) {
        found.push({ line: at(node), shape: `${node.expression.text}.text` });
      }
    }
    // 3. `const { text } = <expr>.label` / `= label` — a destructure that lifts
    //    the string out with no property access to match at all.
    if (
      ts.isVariableDeclaration(node)
      && node.name !== undefined
      && ts.isObjectBindingPattern(node.name)
      && node.initializer !== undefined
      && node.name.elements.some(
        (element) =>
          element.propertyName === undefined
          && ts.isIdentifier(element.name)
          && element.name.text === "text",
      )
    ) {
      const init = node.initializer;
      const readsALabel =
        (ts.isPropertyAccessExpression(init) && LABEL_PROPERTY_NAMES.has(init.name.text))
        || (ts.isIdentifier(init) && LABEL_PROPERTY_NAMES.has(init.text));
      if (readsALabel) found.push({ line: at(node), shape: "destructured `text`" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The detector's own positive and negative controls, run through the SAME
 * function the tree is scanned with.
 *
 * Without these, "found 0 violations" and "the matcher cannot see a violation"
 * are the same output — and the first version of this guard produced exactly
 * that. Each violating case must be detected and each innocent one must not.
 */
const DETECTOR_CONTROLS = [
  { code: "const x = <Text>{facet.label.text}</Text>;", detected: true, why: "property chain" },
  { code: "const x = <Text>{b.groupLabel.text}</Text>;", detected: true, why: "groupLabel chain" },
  { code: "const { label } = facet; const x = label.text;", detected: true, why: "destructured label" },
  { code: "const { text } = facet.label; const x = text;", detected: true, why: "destructured text" },
  { code: "const { text } = label; const x = text;", detected: true, why: "destructured off identifier" },
  { code: "// renders facet.label.text raw\nconst x = t('a');", detected: false, why: "line comment" },
  { code: "/* facet.label.text */ const x = t('a');", detected: false, why: "block comment" },
  { code: "const u = 'http://x/label.text'; const y = t('a');", detected: false, why: "string literal" },
  { code: "const x = facetTitleText(f.key, f.label, t);", detected: false, why: "the sanctioned call" },
  { code: "const x = other.text;", detected: false, why: "an unrelated `.text`" },
];

for (const control of DETECTOR_CONTROLS) {
  const hits = findLabelTextReads("control.tsx", control.code);
  const detected = hits.length > 0;
  if (detected === control.detected) continue;
  failures.push(
    `check A: the detector's ${control.detected ? "POSITIVE" : "NEGATIVE"} control `
      + `(${control.why}) ${detected ? "fired when it must not" : "did NOT fire"}. A detector that `
      + "cannot see a violation reports a clean tree, which is the same output as a clean tree.",
  );
}

let labelTextReads = 0;
const wallViolations = [];

for (const path of clientSources) {
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch (error) {
    failures.push(`could not read ${path}: ${String(error)}`);
    continue;
  }
  for (const hit of findLabelTextReads(path, text)) {
    labelTextReads += 1;
    if (LABEL_TEXT_READERS.has(path)) continue;
    wallViolations.push(
      `${path}:${hit.line} reads \`${hit.shape}\` directly. A \`stable_key\` label's text IS the `
        + "machine key, so this renders `offer_price` to a shopper. Resolve it through "
        + "`facetTitleText`/`facetBucketText`/`facetGroupText` from `@mercaria/ui`.",
    );
  }
}

failures.push(...wallViolations);

/**
 * The allowed reader must actually read one.
 *
 * If `facet-labels.ts` stops reading `label.text` the resolvers have stopped
 * consulting `source`, and the wall would then be guarding an empty room while
 * every client called a passthrough. The floor is 1 rather than the real count
 * so ordinary edits to that module do not have to update a number here.
 */
if (labelTextReads < 1) {
  failures.push(
    "check A: found NO label-text read anywhere, including in the one module whose job is to make "
      + "them. Either the detector is broken or the resolvers no longer branch on `source` — and "
      + "both of those look exactly like a tree with no violations.",
  );
}

notes.push(
  `check A: walked ${clientSources.length} client source files across ${CLIENT_PACKAGES.length} `
    + `packages; found ${labelTextReads} label-text read(s), ${wallViolations.length} outside the `
    + `${LABEL_TEXT_READERS.size} allowed reader(s); detector self-tested on `
    + `${DETECTOR_CONTROLS.filter((c) => c.detected).length} positive and `
    + `${DETECTOR_CONTROLS.filter((c) => !c.detected).length} negative controls.`,
);

// ----------------------------------------- B. the resolution property (real) ---

/**
 * Every closed vocabulary, with the facet it belongs under.
 *
 * Built FROM the shared-types tuples, so a value added to one of them is covered
 * here without an edit — and `Readonly<Record<…>>` in the ui module is what makes
 * the missing copy a typecheck failure at the same time.
 */
const BUCKET_VOCABULARIES = [
  { facetKey: "availability", values: [...OFFER_AVAILABILITY_STATES], source: "OFFER_AVAILABILITY_STATES" },
  { facetKey: "condition", values: [...CONDITION_GROUPS], source: "CONDITION_GROUPS" },
  {
    facetKey: "offer_channel",
    values: Object.keys(FACET_CHANNEL_LABEL_KEYS),
    source: "FACET_CHANNEL_LABEL_KEYS (cross-checked against the producer in check C)",
  },
  {
    facetKey: "market",
    values: [FACET_MARKET_ANY_BUCKET],
    source: "FACET_MARKET_ANY_BUCKET (region codes go through Intl/CLDR, not a key map)",
  },
];

let bucketValuesChecked = 0;

for (const vocabulary of BUCKET_VOCABULARIES) {
  if (vocabulary.values.length === 0) {
    failures.push(
      `check B: the ${vocabulary.facetKey} vocabulary is EMPTY (from ${vocabulary.source}). `
        + "An empty vocabulary passes every assertion below by having nothing to assert.",
    );
    continue;
  }
  for (const value of vocabulary.values) {
    bucketValuesChecked += 1;
    let resolved;
    try {
      resolved = facetStableBucketText(vocabulary.facetKey, value, translate, "en");
    } catch (error) {
      failures.push(
        `check B: resolving the ${vocabulary.facetKey} bucket ${JSON.stringify(value)} threw — `
          + `${String(error)}. Every value of ${vocabulary.source} needs a sentence in `
          + "`packages/ui/src/i18n/locales/en.json`.",
      );
      continue;
    }
    if (resolved === null) {
      failures.push(
        `check B: the ${vocabulary.facetKey} bucket ${JSON.stringify(value)} resolved to null, so `
          + "the rail falls back to the server's text — which for a `stable_key` label is the key "
          + `itself. It is a member of ${vocabulary.source} and needs copy.`,
      );
      continue;
    }
    if (resolved === value) {
      failures.push(
        `check B: the ${vocabulary.facetKey} bucket ${JSON.stringify(value)} resolved to ITSELF. `
          + "A resolver that returns the key it was given satisfies the rendering wall and shows a "
          + "shopper the key anyway.",
      );
    }
  }
}

// The titles, through the same real function, including the `source` branch.
const EXPECTED_TITLE_KEYS = [...FACET_COMMERCE_DIMENSIONS, FACET_TAXONOMY_KEY];

if (EXPECTED_TITLE_KEYS.length !== Object.keys(FACET_TITLE_LABEL_KEYS).length) {
  failures.push(
    `check B: the title map has ${Object.keys(FACET_TITLE_LABEL_KEYS).length} entries but the `
      + `producer's vocabulary is ${EXPECTED_TITLE_KEYS.length} `
      + `(FACET_COMMERCE_DIMENSIONS + FACET_TAXONOMY_KEY). An extra entry is dead copy; a missing `
      + "one is a raw key, and `tsc` only catches the second.",
  );
}

for (const facetKey of EXPECTED_TITLE_KEYS) {
  let resolved;
  try {
    resolved = facetTitleText(facetKey, stableKeyLabel(facetKey), translate);
  } catch (error) {
    failures.push(`check B: resolving the ${facetKey} title threw — ${String(error)}`);
    continue;
  }
  if (resolved !== facetKey) continue;
  failures.push(
    `check B: the ${facetKey} facet title resolved to ITSELF, so the rail renders `
      + `${JSON.stringify(facetKey)} as a filter heading.`,
  );
}

/**
 * BOTH DIRECTIONS of the `source` branch, asserted separately.
 *
 * A resolver that translated unconditionally would pass every assertion above
 * and would replace a category's real localized name with whatever a lookup of
 * that name happened to return. It is caught here and only here.
 */
const REAL_COPY_SOURCES = ["localization", "registry_base", "attribute_label"];
for (const source of REAL_COPY_SOURCES) {
  const realText = "Colour";
  const passedThrough = facetTitleText("condition", { text: realText, source }, translate);
  if (passedThrough === realText) continue;
  failures.push(
    `check B: a \`${source}\` label's text was CHANGED (${JSON.stringify(realText)} became `
      + `${JSON.stringify(passedThrough)}). Only \`stable_key\` carries a machine key; every other `
      + "source is text somebody wrote and must pass through untouched.",
  );
}

const translatedTitle = facetTitleText("condition", stableKeyLabel("condition"), translate);
if (translatedTitle === "condition") {
  failures.push(
    "check B: a `stable_key` label was passed through UNCHANGED. The branch that distinguishes a "
      + "machine key from real copy is not doing anything, so the wall above is decorative.",
  );
}

// `facetBucketText` is the composed function the rail actually calls, so it is
// exercised too rather than trusted to agree with its own helper.
const composedBucket = facetBucketText("availability", "in_stock", stableKeyLabel("in_stock"), translate, "en");
if (composedBucket === "in_stock") {
  failures.push(
    "check B: `facetBucketText` — the function `FacetRail` calls — returned the raw bucket key for "
      + "a `stable_key` label, even though `facetStableBucketText` resolves it. The composed path "
      + "is the one that ships.",
  );
}

const MINIMUM_BUCKET_VALUES = 12;
if (bucketValuesChecked < MINIMUM_BUCKET_VALUES) {
  failures.push(
    `check B: only ${bucketValuesChecked} bucket values were checked, expected at least `
      + `${MINIMUM_BUCKET_VALUES}. The vocabularies are read from shared-types tuples, so a short `
      + "count means a tuple came back empty and every assertion over it was vacuous.",
  );
}

notes.push(
  `check B: resolved ${bucketValuesChecked} bucket values across ${BUCKET_VOCABULARIES.length} `
    + `vocabularies and ${EXPECTED_TITLE_KEYS.length} facet titles through the real functions; `
    + `asserted pass-through for ${REAL_COPY_SOURCES.length} non-stable label sources.`,
);

// -------------------------------------- C. coverage derived from the producer ---

/**
 * The two vocabularies `tsc` cannot see, read out of the SQL that produces them.
 *
 * `countOfferChannelBuckets` collapses four offer kinds to two with a `case`
 * expression, and `countOfferMarketBuckets` substitutes a sentinel for a NULL
 * country. Both are string literals inside a `sql` template, so nothing in the
 * type system relates them to the copy maps. Reading the producer is what makes
 * a third channel value, or a changed sentinel, fail the build here rather than
 * appear as a raw key on a rail.
 */
const FACET_REPOSITORY = "packages/backend/src/db/facets/facetRepository.ts";

let repositorySource = "";
try {
  repositorySource = readFileSync(resolve(root, FACET_REPOSITORY), "utf8");
} catch (error) {
  failures.push(
    `check C: could not read the producer ${FACET_REPOSITORY} — ${String(error)}. Without it the `
      + "channel pair and the market sentinel are asserted against nothing.",
  );
}

if (repositorySource !== "") {
  const channelExpression = /case\s+when\s+o\.kind\s*=\s*'([^']+)'\s+then\s+'([^']+)'\s+else\s+'([^']+)'\s+end/iu
    .exec(repositorySource);
  if (channelExpression === null) {
    failures.push(
      `check C: could not find the channel collapse expression in ${FACET_REPOSITORY}. A pattern `
        + "that matches nothing reports full coverage, so this is a failure rather than a skip — "
        + "if the SQL was legitimately rewritten, update the pattern in the same change.",
    );
  } else {
    const produced = new Set([channelExpression[2], channelExpression[3]]);
    for (const value of produced) {
      const resolvedChannel = facetStableBucketText("offer_channel", value, translate, "en");
      if (resolvedChannel !== null && resolvedChannel !== value) continue;
      failures.push(
        `check C: ${FACET_REPOSITORY} produces the channel bucket ${JSON.stringify(value)} and `
          + "`FACET_CHANNEL_LABEL_KEYS` does not resolve it. The producer decides this vocabulary; "
          + "the copy map has to follow it.",
      );
    }
    const mapped = new Set(Object.keys(FACET_CHANNEL_LABEL_KEYS));
    for (const value of mapped) {
      if (produced.has(value)) continue;
      failures.push(
        `check C: \`FACET_CHANNEL_LABEL_KEYS\` carries ${JSON.stringify(value)}, which `
          + `${FACET_REPOSITORY} no longer produces. Dead copy hides the value that replaced it.`,
      );
    }
    notes.push(
      `check C: read ${produced.size} channel bucket(s) out of the producer's SQL `
        + `(${[...produced].map((value) => JSON.stringify(value)).join(", ")}) and matched them `
        + "against the copy map in both directions.",
    );
  }

  const marketSentinel = /coalesce\(\s*o\.country\s*,\s*'([^']+)'\s*\)/iu.exec(repositorySource);
  if (marketSentinel === null) {
    failures.push(
      `check C: could not find the market sentinel in ${FACET_REPOSITORY}. See the channel note `
        + "above — an unmatched pattern is a failure, not a pass.",
    );
  } else {
    const sentinel = marketSentinel[1];
    if (sentinel !== FACET_MARKET_ANY_BUCKET) {
      failures.push(
        `check C: the producer substitutes ${JSON.stringify(sentinel)} for a NULL country but `
          + `\`FACET_MARKET_ANY_BUCKET\` is ${JSON.stringify(FACET_MARKET_ANY_BUCKET)}. The rail `
          + "would render the sentinel itself.",
      );
    }
    const resolvedSentinel = facetStableBucketText("market", sentinel, translate, "en");
    if (resolvedSentinel === null || resolvedSentinel === sentinel) {
      failures.push(
        `check C: the market sentinel ${JSON.stringify(sentinel)} does not resolve to copy.`,
      );
    }
    notes.push(`check C: the producer's market sentinel is ${JSON.stringify(sentinel)} and resolves.`);
  }
}

// ------------------------------------------------------------------ verdict ---

for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
  console.error(`\nvalidate-facet-label-copy: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nvalidate-facet-label-copy: OK — no stable facet key reaches a render site unresolved.");
