#!/usr/bin/env bun

/**
 * An RTL language with NO message bundle must stay LEFT-TO-RIGHT.
 *
 * ## The failure this exists for
 *
 * `createAppI18n` sets `enableFallback` with a `defaultLocale` of `en`, so a
 * locale nobody has shipped copy for renders ENGLISH. If layout direction were
 * read off the language subtag alone — the obvious implementation, and the one
 * `syncLayoutDirection` would have if its bundle check were ever dropped — an
 * Arabic device would get a MIRRORED layout full of ENGLISH text. That screen is
 * wrong in a way neither half can explain on its own: the strings look like a
 * missing translation, the layout looks like a bug, and nothing in the app
 * reports either. It is strictly worse than not mirroring at all.
 *
 * This is live, not hypothetical. #434 mirrored the dashboard and POS LAYOUTS;
 * their `ar.json` bundles are the separate half that follows. So both apps sit,
 * deliberately and for as long as that takes, in exactly the state this guard is
 * about: an RTL language the platform knows and the app has no copy for.
 *
 * ## Why a script rather than a unit test
 *
 * None of the four client packages has a test runner — CI says so on both the
 * RTL and the bidi steps, and `validate-bidi-isolation.mjs` is the precedent:
 * import the REAL module and assert its behaviour, rather than scan the source
 * for a spelling. A scan would pass against an `isRtlLocale` that takes the
 * bundle list and never reads it.
 *
 * `packages/ui/src/i18n/rtl-locales.ts` is importable here precisely because it
 * imports nothing itself. Its sibling `layout-direction.ts` needs `I18nManager`
 * and so cannot run outside a bundler — which is why the DECISION was split out
 * from the APPLICATION rather than living in one file.
 *
 * ## What this cannot tell you
 *
 * Whether the mirrored layout is CORRECT. That is a rendering property of a real
 * device, and neither this nor `validate-rtl-classes` runs one.
 *
 * Usage:  bun scripts/validate-rtl-direction.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isRtlLocale,
  languageOf,
  RTL_LANGUAGE_CODES,
} from "../packages/ui/src/i18n/rtl-locales.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every app whose direction is derived from its own shipped bundles. */
const APPS = [
  { name: "frontend", locales: "packages/frontend/lib/i18n/locales" },
  { name: "dashboard", locales: "packages/dashboard/lib/i18n/locales" },
  { name: "pos", locales: "packages/pos/lib/i18n/locales" },
];

/**
 * An app shipping fewer than this many bundles means the listing broke, and a
 * broken listing makes every "no bundle, so no mirroring" assertion below pass
 * for the wrong reason — there would be no bundles at all.
 */
const MINIMUM_BUNDLES_PER_APP = 5;

const failures = [];

/** The locale tags an app actually ships, read off disk. */
function shippedLocaleTags(app) {
  const entries = readdirSync(resolve(repositoryRoot, app.locales));
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

const shipped = new Map();
for (const app of APPS) {
  const tags = shippedLocaleTags(app);
  shipped.set(app.name, tags);
  if (tags.length < MINIMUM_BUNDLES_PER_APP) {
    failures.push(
      `${app.name} lists ${tags.length} locale bundles, below the ${MINIMUM_BUNDLES_PER_APP} floor — `
      + "the listing is probably broken, and with no bundles every assertion below passes vacuously",
    );
  }
}

// ------------------------------------------------------------- the invariant ---

/**
 * THE RULE, stated so it survives the bundles arriving.
 *
 * Asserting "the dashboard does not mirror Arabic" as a flat fact would make this
 * guard fail on the very PR that ships `ar.json`, which is the wrong thing to
 * gate. The invariant is the BICONDITIONAL — mirror exactly when the language is
 * RTL *and* a bundle for it exists — and that holds identically before and after.
 */
for (const app of APPS) {
  const tags = shipped.get(app.name);
  for (const code of RTL_LANGUAGE_CODES) {
    const bundleExists = tags.some((tag) => languageOf(tag) === code);
    for (const probe of [code, `${code}-XY`]) {
      const mirrors = isRtlLocale(probe, tags);
      if (mirrors === bundleExists) continue;
      failures.push(
        `${app.name}: isRtlLocale(${JSON.stringify(probe)}) returned ${mirrors}, but a bundle for `
        + `"${code}" ${bundleExists ? "EXISTS" : "does NOT exist"} in ${app.locales}. Direction must `
        + "follow the SHIPPED BUNDLES, never the language subtag alone: enableFallback renders English "
        + "for a locale with no bundle, so mirroring one produces an English screen laid out "
        + "right-to-left.",
      );
    }
  }
}

// ------------------------------------------------------------- both branches ---

/**
 * Synthetic cases pinning BOTH answers unconditionally.
 *
 * The real-tree loop above only exercises whichever branches the tree happens to
 * be in today. These do not rot: without the second case, an `isRtlLocale` that
 * returned `false` for everything would satisfy every "must not mirror"
 * assertion in this file and report a clean run.
 */
const CASES = [
  { locale: "ar", available: ["en", "de", "es"], expected: false, why: "RTL language, no bundle" },
  { locale: "ar", available: ["en", "ar"], expected: true, why: "RTL language, bundle present" },
  { locale: "ar-EG", available: ["en", "ar"], expected: true, why: "regional RTL tag, base bundle" },
  { locale: "he", available: ["en", "he-IL"], expected: true, why: "base RTL tag, regional bundle" },
  { locale: "en", available: ["en", "ar"], expected: false, why: "LTR language stays LTR" },
  { locale: "de", available: ["en", "de"], expected: false, why: "LTR language with a bundle" },
  { locale: "", available: ["en", "ar"], expected: false, why: "empty tag is not RTL" },
];

for (const testCase of CASES) {
  const actual = isRtlLocale(testCase.locale, testCase.available);
  if (actual === testCase.expected) continue;
  failures.push(
    `isRtlLocale(${JSON.stringify(testCase.locale)}, ${JSON.stringify(testCase.available)}) `
    + `returned ${actual}, expected ${testCase.expected} — ${testCase.why}`,
  );
}

// -------------------------------------------------------- ground-truth control ---

/**
 * The storefront DOES ship `ar.json` (#396) and DOES mirror (#397). So the
 * positive branch is anchored to a real file in this tree, not only to the
 * synthetic case above: deleting that bundle turns this red instead of silently
 * turning the storefront's mirroring off.
 */
const frontendTags = shipped.get("frontend");
if (!isRtlLocale("ar", frontendTags)) {
  failures.push(
    "the storefront does not mirror Arabic, but it ships packages/frontend/lib/i18n/locales/ar.json "
    + "(#396/#397). Either the bundle was removed or the bundle check stopped reading the list — "
    + "and a check that can only answer `false` would pass every other assertion here.",
  );
}

// --------------------------------------------------------------- copy drift ---

/**
 * The storefront still runs its OWN copy of this rule
 * (`packages/frontend/lib/i18n/rtl.ts`), because #434 hoisted the mechanism for
 * the dashboard and POS without converging the storefront's hand-built `I18n`
 * and hand-rolled store — that is #435.
 *
 * Two copies of a list nobody diffs is how they drift, and the drift is silent
 * in the worst direction: a language added to one set mirrors in one app and not
 * in another, with both builds green. So they are compared here until #435
 * deletes the second one, at which point this block goes with it.
 */
const RTL_SET_SOURCES = [
  { label: "shared (@mercaria/ui)", path: "packages/ui/src/i18n/rtl-locales.ts" },
  { label: "storefront", path: "packages/frontend/lib/i18n/rtl.ts" },
];

/**
 * The quoted subtags inside a file's `RTL_LANGUAGE_CODES = new Set([...])`.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not defensive tidying — it was a real
 * hole, found by mutation-testing this check rather than by reading it. Every
 * entry in both sets carries a trailing `// Arabic`-style comment, so commenting
 * a subtag OUT is the most natural way to remove one. Against the un-stripped
 * text the quoted string is still there, the parser still finds it, and the two
 * sets still compare equal — the guard reported a clean run over a real
 * divergence. A census over source must exclude comments.
 */
function declaredRtlCodes(path) {
  const source = readFileSync(resolve(repositoryRoot, path), "utf8");
  const declaration = source.indexOf("RTL_LANGUAGE_CODES");
  if (declaration < 0) return null;
  const open = source.indexOf("new Set([", declaration);
  const close = source.indexOf("])", open);
  if (open < 0 || close < 0) return null;
  const body = source
    .slice(open, close)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
    .join("\n");
  return [...body.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

const declaredSets = RTL_SET_SOURCES.map((entry) => ({
  ...entry,
  codes: declaredRtlCodes(entry.path),
}));

for (const entry of declaredSets) {
  if (entry.codes === null) {
    failures.push(
      `could not read an RTL_LANGUAGE_CODES set out of ${entry.path} — the shape changed, and a `
      + "parser that finds nothing compares two empty sets and reports them equal",
    );
    continue;
  }
  // A parse that silently returned a handful would make the equality below pass
  // for the wrong reason. The real set is eleven subtags.
  if (entry.codes.length < 8) {
    failures.push(
      `${entry.path} declares only ${entry.codes.length} RTL subtags, which is fewer than any real `
      + "version of this list — the parse is broken, not the data",
    );
  }
}

const [sharedSet, storefrontSet] = declaredSets;
if (sharedSet.codes && storefrontSet.codes) {
  const shared = new Set(sharedSet.codes);
  const storefront = new Set(storefrontSet.codes);
  const onlyShared = [...shared].filter((code) => !storefront.has(code));
  const onlyStorefront = [...storefront].filter((code) => !shared.has(code));
  if (onlyShared.length > 0 || onlyStorefront.length > 0) {
    failures.push(
      "the storefront's RTL_LANGUAGE_CODES has drifted from the shared set"
      + (onlyShared.length > 0 ? ` — only in shared: ${onlyShared.join(", ")}` : "")
      + (onlyStorefront.length > 0 ? ` — only in the storefront: ${onlyStorefront.join(", ")}` : "")
      + ". A language in one set and not the other mirrors in one app and not another with both "
      + "builds green. Update both, or land #435 and delete the storefront's copy.",
    );
  }
}

// ------------------------------------------------------------------- verdict ---

if (failures.length > 0) {
  console.error("RTL direction guard failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

const summary = APPS.map((app) => {
  const tags = shipped.get(app.name);
  const rtl = tags.filter((tag) => isRtlLocale(tag, tags));
  return `${app.name} ${tags.length} bundles (${rtl.length} RTL)`;
}).join(", ");

console.log(
  `RTL direction guard passed — ${summary}; `
  + `${RTL_LANGUAGE_CODES.size} RTL languages probed against each app's shipped bundles, `
  + `${CASES.length} synthetic cases covering both answers, storefront Arabic control anchored, `
  + `${RTL_SET_SOURCES.length} declared RTL sets compared for drift (#435 removes the second).`,
);
