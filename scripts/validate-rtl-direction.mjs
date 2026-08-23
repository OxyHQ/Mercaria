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
 * impossible in the package that owns this code. Note what those runners cannot
 * do, since "the app has a runner" invites a conclusion they do not support:
 * all three collect from `lib` only under `environment: 'node'` with no
 * renderer (#469), so a component cannot be mounted in any of them — importing
 * `react-native` dies at its `index.js:27` with `RollupError: Parse failure:
 * Expected 'from', got 'typeOf'`, measured in all three separately. The usable
 * form is that config's own rule: extract the derivation into `lib/` and assert
 * it by running it.
 *
 * The second reason is the one
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

// ------------------------------- the set is not the POPULATION (#367 line 202) ---

/**
 * `RTL_LANGUAGE_CODES` is HAND-WRITTEN, and every loop above iterates IT.
 *
 * That is the gap this block closes, and it is worth stating precisely because
 * the guard's own output hides it: a language absent from the set is not
 * "checked and found LTR", it is **never a subject**. Ship `ks.json` (Kashmiri)
 * or `syr.json` (Syriac) — both genuinely right-to-left, neither in the set —
 * and `isRtlLocale` answers `false`, `syncLayoutDirection` leaves the app
 * left-to-right, and every assertion in this file passes while the summary line
 * cheerfully reports `(0 RTL)`. The bundle ships, the copy renders, and the
 * layout is silently wrong.
 *
 * It is the hand-maintained-map failure applied to a locale list, and it has the
 * asymmetry every curated list has: it notices a locale REMOVED (the floor above
 * fires) and never notices one ADDED.
 *
 * ## The fix is derivation, not a bigger list
 *
 * RTL-ness is a property of the SCRIPT, and the script is derivable from the
 * tag. `Intl.Locale` carries CLDR's own answer, so the population becomes the
 * locales each app actually SHIPS and the verdict comes from an authority that
 * is not a second copy of the first. A locale added tomorrow is a subject on the
 * day its bundle lands; one that is not RTL costs nothing.
 *
 * ## Two runtimes, two spellings, and why the control below is load-bearing
 *
 * The accessor is NOT portable and the difference is silent. Measured on this
 * machine: bun 1.3.14 exposes `getTextInfo()` as a function and leaves
 * `textInfo` UNDEFINED; node 22 exposes `textInfo` as an object and leaves
 * `getTextInfo` undefined. These scripts run under bun — but a check written
 * against one spelling returns `undefined` under the other, every comparison
 * below reads "no opinion", and the whole block reports clean while measuring
 * nothing. `assertProbeWorks` is what makes that a loud failure instead.
 */
const ICU_UNAVAILABLE = "unavailable";

function icuDirection(tag) {
  try {
    const locale = new Intl.Locale(tag);
    // Both spellings, because neither runtime has both. See the note above.
    const info = locale.textInfo ?? locale.getTextInfo?.();
    return info?.direction ?? ICU_UNAVAILABLE;
  } catch {
    return ICU_UNAVAILABLE;
  }
}

/**
 * Tags where CLDR is WRONG and `RTL_LANGUAGE_CODES` is right.
 *
 * An exception rather than a silent skip: a table somebody has to read is the
 * difference between "we know CLDR disagrees here and why" and "the check
 * quietly stopped covering this one".
 *
 * `dv` (Dhivehi) is written in THAANA, which runs right to left — ICU maximizes
 * it to `dv-Thaa-MV` correctly and then reports `direction: "ltr"` anyway. Not
 * shipped today, so this exception is not load-bearing yet; it is here so that
 * shipping `dv.json` does not fail this guard for CLDR's mistake.
 */
const ICU_DIRECTION_EXCEPTIONS = new Map([
  ["dv", "ICU/CLDR reports ltr for Thaana, which is a right-to-left script"],
]);

/**
 * The probe answers at all, in BOTH directions.
 *
 * Without the negative half a probe hardwired to `"rtl"` would satisfy every
 * `ar` comparison in the block below.
 */
const PROBE_CONTROLS = [
  { tag: "ar", expected: "rtl" },
  { tag: "he", expected: "rtl" },
  { tag: "en", expected: "ltr" },
  { tag: "ja", expected: "ltr" },
];

let probeWorks = true;
for (const control of PROBE_CONTROLS) {
  const actual = icuDirection(control.tag);
  if (actual === control.expected) continue;
  probeWorks = false;
  failures.push(
    `the Intl direction probe answered ${JSON.stringify(actual)} for "${control.tag}", expected `
    + `"${control.expected}". Every cross-check below compares against this probe, so a broken one `
    + "makes the whole block pass while measuring nothing. This runtime may expose the accessor "
    + "under the other spelling (`textInfo` vs `getTextInfo()`) or ship without full ICU data.",
  );
}

if (probeWorks) {
  /**
   * The population is the SHIPPED bundles, deduplicated across apps — not
   * `RTL_LANGUAGE_CODES`. That inversion is the whole point of this block.
   */
  const shippedLanguages = new Set();
  for (const app of APPS) {
    for (const tag of shipped.get(app.name)) shippedLanguages.add(languageOf(tag));
  }

  for (const language of [...shippedLanguages].sort()) {
    const icu = icuDirection(language);
    if (icu === ICU_UNAVAILABLE) {
      failures.push(
        `Intl has no direction for the shipped language "${language}", so this guard cannot say `
        + "whether it should mirror. Add it to ICU_DIRECTION_EXCEPTIONS with the reason, or "
        + "establish the direction another way — do not leave it unanswered.",
      );
      continue;
    }
    const listedAsRtl = RTL_LANGUAGE_CODES.has(language);
    const exception = ICU_DIRECTION_EXCEPTIONS.get(language);
    if (exception !== undefined) continue;
    if ((icu === "rtl") === listedAsRtl) continue;
    failures.push(
      listedAsRtl
        ? `"${language}" is in RTL_LANGUAGE_CODES but Intl reports its script runs ${icu}. An LTR `
          + "language in that set mirrors a layout that should not be mirrored."
        : `"${language}" ships a bundle and Intl reports its script runs RIGHT-TO-LEFT, but it is `
          + "NOT in RTL_LANGUAGE_CODES (packages/ui/src/i18n/rtl-locales.ts). Every loop in this "
          + "guard iterates that set, so this language is not checked and found LTR — it is never a "
          + "subject. The app ships its copy and lays it out left-to-right, with every guard green.",
    );
  }

  /**
   * The set's OWN members, so a typo'd or wrongly-added entry is caught even
   * for a language nothing ships yet. Scoped by the exception table above.
   */
  for (const language of RTL_LANGUAGE_CODES) {
    if (ICU_DIRECTION_EXCEPTIONS.has(language)) continue;
    const icu = icuDirection(language);
    if (icu === "rtl" || icu === ICU_UNAVAILABLE) continue;
    failures.push(
      `RTL_LANGUAGE_CODES contains "${language}", but Intl reports its script runs ${icu}. Either `
      + "it is a typo, or CLDR disagrees for a reason worth recording in ICU_DIRECTION_EXCEPTIONS.",
    );
  }

  /**
   * The exception table cannot outlive its reason.
   *
   * An entry CLDR has since corrected is a permanent hole in the cross-check
   * that reads exactly like a covered case, so it fails here rather than
   * lingering. This is the one assertion in the block that gets BETTER when
   * upstream improves.
   */
  for (const [language, why] of ICU_DIRECTION_EXCEPTIONS) {
    if (icuDirection(language) !== "rtl") continue;
    failures.push(
      `ICU_DIRECTION_EXCEPTIONS excuses "${language}" because ${why} — but Intl now reports it as `
      + "rtl, so the exception is stale and is excusing nothing. Delete the entry.",
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

const crossChecked = new Set();
for (const app of APPS) {
  for (const tag of shipped.get(app.name)) crossChecked.add(languageOf(tag));
}

console.log(
  `RTL direction guard passed — ${summary}; `
  // Where each number comes from, because "checks N RTL locales" is not a claim
  // a reader can act on without knowing whether N is a hand-written list or a
  // derived population. The first is the LIST; the second is the POPULATION.
  + `${RTL_LANGUAGE_CODES.size} hand-listed RTL languages probed against each app's shipped `
  + `bundles, ${CASES.length} synthetic cases covering both answers, storefront Arabic control `
  + `anchored, one shared RTL set (#435 deleted the storefront's copy; the drift comparison went `
  + `with it); and ${crossChecked.size} SHIPPED languages cross-checked against Intl's own script `
  + `direction with ${ICU_DIRECTION_EXCEPTIONS.size} recorded CLDR exception(s), so a right-to-left `
  + `locale added to the product without being added to the list fails here (#367 line 202).`,
);
