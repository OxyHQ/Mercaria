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
 * `packages/ui` has no test runner — its `test` script is an `echo` — and it
 * owns `src/i18n/rtl-locales.ts`, the module asserted below. The three Expo apps
 * do each have one (`vitest run`, run by `ci.yml`'s `Test Dashboard`, `Test App`
 * and `Test POS` steps), so a test is not impossible in this repository; it is
 * impossible in the package that owns this code. The second reason is the one
 * that would survive even if `packages/ui` grew a runner tomorrow: this guard
 * compares the SHIPPED BUNDLES of all four packages against one shared locale
 * list, and no single app's suite can see the other three.
 *
 * `validate-bidi-isolation.mjs` is the precedent: import the REAL module and
 * assert its behaviour, rather than scan the source for a spelling. A scan would
 * pass against an `isRtlLocale` that takes the bundle list and never reads it.
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

import { readdirSync } from "node:fs";
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

// ------------------------------------------------------- the set is not empty ---

/**
 * There is now exactly ONE `RTL_LANGUAGE_CODES`, so there is nothing left to
 * compare it against.
 *
 * #434 left the storefront running a second copy in
 * `packages/frontend/lib/i18n/rtl.ts` and this file diffed the two declarations
 * on every run, because two copies of a list nobody diffs is how they drift.
 * #435 deleted that copy along with the hand-built `I18n` and hand-rolled store
 * it existed for, so the comparison can no longer FAIL — with one side gone it
 * would either read a missing file or compare the shared set against nothing.
 * A check whose cheapest green is the absence of the thing it measures is worse
 * than no check, so it goes, exactly as its own note said it would.
 *
 * What that block also happened to enforce is kept, because losing it silently
 * is the real risk: the loop over `RTL_LANGUAGE_CODES` above iterates the set,
 * so an EMPTY set makes every per-language assertion pass by never running. The
 * storefront Arabic control below is a genuine anchor for `ar` specifically;
 * this is the floor for the rest of the set.
 */
const MINIMUM_RTL_LANGUAGES = 8;

if (RTL_LANGUAGE_CODES.size < MINIMUM_RTL_LANGUAGES) {
  failures.push(
    `RTL_LANGUAGE_CODES has ${RTL_LANGUAGE_CODES.size} entries, below the `
    + `${MINIMUM_RTL_LANGUAGES} floor — the per-language loop above iterates this set, so a gutted `
    + "set makes every assertion in it pass by never running",
  );
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
  + `one shared RTL set (#435 deleted the storefront's copy; the drift comparison went with it).`,
);
