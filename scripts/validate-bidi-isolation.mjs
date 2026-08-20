#!/usr/bin/env bun

/**
 * The storefront's display formatters must emit BIDI-ISOLATED strings
 * (#429 item 1). This asserts that they do, by CODE POINT.
 *
 * ## Why this exists rather than a review
 *
 * `FSI` (U+2068) and `PDI` (U+2069) are `Cf` format characters: zero-width and
 * default-ignorable. Isolation that was never applied, applied to eight of nine
 * formatters, applied twice, or applied with the wrong character renders
 * IDENTICALLY to isolation that is correct — in every screenshot, every diff
 * view and every code review. There is no appearance to check. The only
 * observable is the code point sequence, so that is what this reads.
 *
 * It runs the REAL functions out of `packages/ui/src/lib/`, not a copy of their
 * logic and not a scan for a U+2068 escape in the source. A source scan
 * would pass against a `format.ts` that imports `isolateBidi` and never calls
 * it, and against one that calls it on a string it then discards.
 *
 * ## Why a script under `scripts/` and not a unit test
 *
 * Neither `packages/ui` nor `packages/frontend` has a test runner — CI's own
 * comment on the RTL guard says so, and `validate-rtl-logical-classes.mjs`,
 * `validate-no-mongo.mjs` and `check-agents-md-size.mjs` are the shape a
 * checkable property takes in this repository. `bun` transpiles the TypeScript
 * on import, so the module under test is the one the apps compile.
 *
 * ## The LTR case is half the point
 *
 * Isolation is for Arabic, and every existing user is not reading Arabic. The
 * regression this change risks is a corrupted English string — a stray
 * character in a price, a lost symbol, an off-by-one in the wrap. So every
 * money case asserts the VISIBLE text (the string with the isolate characters
 * removed) is byte-identical to what shipped before this change, and asserts
 * the isolate count is exactly one pair. In an LTR paragraph an isolate around
 * an LTR run is a no-op under the Unicode Bidirectional Algorithm, so "visible
 * text unchanged + exactly one balanced pair" IS the statement that LTR output
 * is unaffected.
 *
 * ## Vacuity floors
 *
 * A gate over a hand-listed set of functions goes useless the moment another
 * is added, so the covered set is checked for EXACT equality against the
 * functions `format.ts` actually exports — a new or renamed formatter fails the
 * build until it is covered here.
 *
 * That covered set is DERIVED from the cases that ran, not declared in a list
 * beside them. The difference is what a deleted case does: against a hand
 * list, removing every `formatMoney` case leaves the list still naming
 * `formatMoney`, the census still reconciles and the gate goes on reporting
 * four covered formatters while exercising three. Against the derived set it
 * goes red naming the formatter nothing touched.
 *
 * Every expected visible string is also asserted non-empty, so a formatter
 * reduced to returning nothing but its own isolate pair cannot pass.
 *
 * Usage:  bun scripts/validate-bidi-isolation.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatDistance,
  formatMoney,
  formatPercent,
  formatRating,
  formatReviewCount,
  formatSourceMoney,
} from "../packages/ui/src/lib/format.ts";
import { formatDate, formatDateTime, formatWeekday } from "../packages/ui/src/lib/date.ts";
import { formatRegionName } from "../packages/ui/src/lib/region.ts";
// The SAME modules again, as namespaces, so the census below can enumerate what
// they export rather than pattern-match the text that declares them (#491).
import * as formatModule from "../packages/ui/src/lib/format.ts";
// #488/#489's formatters live in their OWN modules — see each module's note on
// why they are not in `format.ts`. Censused HERE rather than in a second guard,
// because a date and a price have the same bidi problem and two scripts
// answering that question could disagree about it.
import * as dateModule from "../packages/ui/src/lib/date.ts";
import * as regionModule from "../packages/ui/src/lib/region.ts";
import { isolateBidi } from "../packages/ui/src/lib/bidi.ts";

/**
 * The isolate code points, written as NUMBERS and defined here rather than
 * imported from the module under test. Importing them would make this a check
 * that two representations agree, which stays green when both move together —
 * exactly the failure a gate for an invisible property must not have.
 */
const FIRST_STRONG_ISOLATE = 0x2068;
const POP_DIRECTIONAL_ISOLATE = 0x2069;
const LEFT_TO_RIGHT_ISOLATE = 0x2066;
const RIGHT_TO_LEFT_ISOLATE = 0x2067;

const ISOLATE_CODE_POINTS = new Set([
  FIRST_STRONG_ISOLATE,
  POP_DIRECTIONAL_ISOLATE,
  LEFT_TO_RIGHT_ISOLATE,
  RIGHT_TO_LEFT_ISOLATE,
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formatModulePath = resolve(repositoryRoot, "packages/ui/src/lib/format.ts");

/**
 * Every module whose exported formatters must return isolated strings.
 *
 * A LIST rather than one module, because #488/#489's formatters moved out of
 * `format.ts` (#500 is rewriting that file) and a census that still read only
 * that file would have gone quietly NARROWER — reconciling cleanly over a
 * population three functions smaller than the real one, which is the failure a
 * census has instead of a bug. Each entry is floored individually below.
 */
const FORMATTER_MODULES = [
  { path: "packages/ui/src/lib/format.ts", module: formatModule, minimum: 6 },
  { path: "packages/ui/src/lib/date.ts", module: dateModule, minimum: 3 },
  { path: "packages/ui/src/lib/region.ts", module: regionModule, minimum: 1 },
];

/** `"abc"` → `"U+0061 U+0062 U+0063"`, so a failure message names what it saw. */
function describeCodePoints(text) {
  return Array.from(text)
    .map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ");
}

/** The text a reader actually sees: every isolate character removed. */
function visibleText(text) {
  return Array.from(text)
    .filter((character) => !ISOLATE_CODE_POINTS.has(character.codePointAt(0)))
    .join("");
}

const failures = [];
let assertionCount = 0;

function check(description, condition, detail) {
  assertionCount += 1;
  if (!condition) {
    failures.push(`${description}${detail === undefined ? "" : `\n      ${detail}`}`);
  }
}

/**
 * Every formatter a case below actually EXERCISED. Coverage is derived from the
 * cases that ran rather than declared in a list beside them: a hand-maintained
 * list keeps reporting a formatter as covered after its last case is deleted,
 * which is a gate that measures its own good intentions.
 */
const exercisedFormatters = new Set();

/**
 * The full contract for one formatter output: exactly one leading FSI, exactly
 * one trailing PDI, no other isolate characters anywhere (which is what rules
 * out a double wrap and a stray mark in the middle), and the visible text
 * EXACTLY as it read before isolation.
 *
 * `formatterName` must be the exported identifier, because it is what the
 * source census below is reconciled against.
 */
function checkIsolatedExactly(formatterName, caseName, actual, expectedVisible) {
  exercisedFormatters.add(formatterName);
  const label = `${formatterName} ${caseName}`;
  check(
    `${label}: expected visible text is non-empty (vacuity floor)`,
    expectedVisible.length > 0,
    `the case itself asserts nothing if it expects ""`,
  );

  const characters = Array.from(actual);
  check(
    `${label}: starts with FSI (U+2068)`,
    characters[0]?.codePointAt(0) === FIRST_STRONG_ISOLATE,
    `got ${describeCodePoints(actual)}`,
  );
  check(
    `${label}: ends with PDI (U+2069)`,
    characters[characters.length - 1]?.codePointAt(0) === POP_DIRECTIONAL_ISOLATE,
    `got ${describeCodePoints(actual)}`,
  );

  const isolateCount = characters.filter((character) =>
    ISOLATE_CODE_POINTS.has(character.codePointAt(0)),
  ).length;
  check(
    `${label}: carries exactly one isolate pair (no double wrap, no stray mark)`,
    isolateCount === 2,
    `found ${isolateCount} isolate characters in ${describeCodePoints(actual)}`,
  );

  check(
    `${label}: visible text is unchanged for an LTR reader`,
    visibleText(actual) === expectedVisible,
    `expected ${JSON.stringify(expectedVisible)}, got ${JSON.stringify(visibleText(actual))}`,
  );
}

// ---------------------------------------------------------------------------
// The six formatters in ENGLISH. Every expected string below is the PRE-#500
// output, byte for byte, which is what makes this half a regression floor
// rather than a restatement: #500 made these locale-aware, and the one thing it
// must not have done is move what an English reader already sees.
//
// The single deliberate exception is grouping — `toFixed` emitted none, `en`
// CLDR does — so the money cases below stay under 1000 and the grouped case is
// asserted explicitly further down as a CHANGE.
// ---------------------------------------------------------------------------

const EN = "en";

checkIsolatedExactly(
  "formatMoney",
  "USD/en",
  formatMoney({ amount: 14800, currency: "USD" }, EN),
  "$148.00",
);
checkIsolatedExactly(
  "formatMoney",
  "FAIR (8dp)/en",
  formatMoney({ amount: 14_800_000_000, currency: "FAIR" }, EN),
  "⊜148.00",
);
checkIsolatedExactly(
  "formatMoney",
  "zero/en",
  formatMoney({ amount: 0, currency: "EUR" }, EN),
  "€0.00",
);
// A negative amount puts the minus BETWEEN the symbol and the digits, which is
// the shape `ShoppingAgentFindingCard` avoids by rendering the sign as a word.
// Isolation must not move it: this pins the whole token, sign included.
checkIsolatedExactly(
  "formatMoney",
  "negative/en",
  formatMoney({ amount: -500, currency: "USD" }, EN),
  "$-5.00",
);

checkIsolatedExactly(
  "formatSourceMoney",
  "convertible currency/en",
  formatSourceMoney({ amount: 12_999, currency: "USD" }, EN),
  "129.99 USD",
);

checkIsolatedExactly("formatDistance", "metres/en", formatDistance(450, EN), "450 m");
checkIsolatedExactly("formatDistance", "kilometres/en", formatDistance(2500, EN), "2.5 km");

checkIsolatedExactly("formatReviewCount", "bare/en", formatReviewCount(349, EN), "349");
checkIsolatedExactly(
  "formatReviewCount",
  "abbreviated/en",
  formatReviewCount(10_300, EN),
  "10.3K",
);
checkIsolatedExactly("formatReviewCount", "rounded/en", formatReviewCount(1000, EN), "1K");

checkIsolatedExactly("formatPercent", "en", formatPercent(820, EN), "8.2%");
// The sign is carried by which SENTENCE the caller selected, never by a minus.
checkIsolatedExactly("formatPercent", "negative bps/en", formatPercent(-820, EN), "8.2%");
// The `fractionDigits` parameter (#544). A published RATE cannot use the
// default: at one decimal an 8.25% programme renders as `8.3%`, a WRONG NUMBER
// rather than a rounding preference — so both ends of the range are pinned.
checkIsolatedExactly("formatPercent", "0 digits/en", formatPercent(500, EN, 0), "5%");
checkIsolatedExactly("formatPercent", "2 digits/en", formatPercent(825, EN, 2), "8.25%");
// …and in a locale whose decimal separator differs, which is the whole reason
// the numeral goes through a formatter rather than `.toFixed`.
checkIsolatedExactly(
  "formatPercent",
  "2 digits/de",
  formatPercent(825, "de", 2),
  new Intl.NumberFormat("de", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(825 / 10000),
);

checkIsolatedExactly("formatRating", "en", formatRating(4.5, EN), "4.5");
checkIsolatedExactly("formatRating", "whole/en", formatRating(5, EN), "5.0");

// ---------------------------------------------------------------------------
// The #488/#489 formatters.
//
// Their visible text comes from ICU rather than from arithmetic this repo
// controls, so unlike `"$148.00"` above it is NOT hardcoded here. The
// expectation is the SAME `Intl` call without the isolation, which is exactly
// the property this gate is for — "isolation was not traded for a corrupted
// string" — while being immune to an ICU version bump reformatting a date.
//
// That is not the circular "two representations of our own logic agree": the
// reference is the PLATFORM's formatter, and what is under test is what
// `formatDate` adds to it. A `formatDate` that dropped the isolation, wrapped
// twice, or returned some other date all still fail.
// ---------------------------------------------------------------------------

/** A fixed instant, mid-day UTC so no plausible zone offset moves the DATE. */
const SAMPLE_INSTANT = new Date("2026-08-17T12:00:00.000Z");

checkIsolatedExactly(
  "formatDate",
  "en",
  formatDate(SAMPLE_INSTANT, "en"),
  new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(SAMPLE_INSTANT),
);
// A non-Latin locale, because the isolate has to survive a script whose digits
// and month names are not the ones the LTR case exercises.
checkIsolatedExactly(
  "formatDate",
  "ja",
  formatDate(SAMPLE_INSTANT, "ja"),
  new Intl.DateTimeFormat("ja", { dateStyle: "medium" }).format(SAMPLE_INSTANT),
);
checkIsolatedExactly(
  "formatDateTime",
  "en",
  formatDateTime(SAMPLE_INSTANT, "en"),
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(SAMPLE_INSTANT),
);

/**
 * The reference week `formatWeekday` names days from — 2023-01-01 was a Sunday,
 * so `1 + weekday` is `Date#getDay`'s numbering.
 */
const WEEKDAY_REFERENCE = (weekday) => new Date(Date.UTC(2023, 0, 1 + weekday));
const WEEKDAY_OPTIONS = { weekday: "long", timeZone: "UTC" };

checkIsolatedExactly(
  "formatWeekday",
  "en/Monday",
  formatWeekday(1, "en"),
  new Intl.DateTimeFormat("en", WEEKDAY_OPTIONS).format(WEEKDAY_REFERENCE(1)),
);
// `ar` is the case that matters: an RTL weekday name beside LTR opening hours
// is exactly the mixed run the isolate exists for.
checkIsolatedExactly(
  "formatWeekday",
  "ar/Sunday",
  formatWeekday(0, "ar"),
  new Intl.DateTimeFormat("ar", WEEKDAY_OPTIONS).format(WEEKDAY_REFERENCE(0)),
);
// The out-of-range answer is "" — NOT an isolated empty string, because an
// opening-hours row with no day renders as nothing. Asserted here so a future
// change that starts isolating it is caught: `\u2068\u2069` is not empty, and
// a caller testing `.length` would silently start rendering a blank chip.
check(
  "formatWeekday out of range is a bare empty string",
  formatWeekday(7, "en") === "",
  `got ${JSON.stringify(formatWeekday(7, "en"))}`,
);

// `formatRegionName` resolves a name on this engine, so the LOCALIZED branch is
// what gets pinned. "United States" is stable across ICU versions in a way a
// date format is not, so it is written out.
checkIsolatedExactly("formatRegionName", "resolved", formatRegionName("US", "en"), "United States");
checkIsolatedExactly("formatRegionName", "localized", formatRegionName("ES", "es"), "España");
// The FALLBACK branch — a well-formed but unassigned subtag. `fallback: "none"`
// answers `undefined` for it, and the code comes back isolated rather than the
// engine echoing it back as though it had resolved.
checkIsolatedExactly("formatRegionName", "unassigned code", formatRegionName("XX", "en"), "XX");
// Lowercase input, which an API or a hand-typed form can supply: the name still
// resolves, so the guard cannot be satisfied by a formatter that only handles
// the canonical spelling.
checkIsolatedExactly("formatRegionName", "lowercase", formatRegionName("gb", "en"), "United Kingdom");

// ---------------------------------------------------------------------------
// A MALFORMED locale tag must DEGRADE, never throw.
//
// The locale reaching these is the OS's raw value (`getLocales()[0]
// .languageTag`), and `new Intl.DateTimeFormat("en_US")` — underscore rather
// than hyphen — raises `RangeError`. Measured against what #513 shipped:
// `en_US`, `es_ES` and `zh_Hans_CN` all threw. Uncaught in a render path, that
// white-screens the screen, so this is a real defect rather than a hypothetical.
//
// The expectation is the RUNTIME DEFAULT's rendering, because that is the rung
// the fallback lands on: a runtime that cannot honour the app's locale renders
// exactly as it did before #488, never worse.
// ---------------------------------------------------------------------------

for (const malformed of ["en_US", "zh_Hans_CN"]) {
  checkIsolatedExactly(
    "formatDate",
    `malformed tag ${malformed} degrades`,
    formatDate(SAMPLE_INSTANT, malformed),
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(SAMPLE_INSTANT),
  );
}
checkIsolatedExactly(
  "formatDateTime",
  "malformed tag degrades",
  formatDateTime(SAMPLE_INSTANT, "en_US"),
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(SAMPLE_INSTANT),
);
// The same tag through the region formatter, which retries on the runtime
// default before giving up — so a device with an odd tag still gets NAMES
// rather than falling all the way back to bare codes.
checkIsolatedExactly(
  "formatRegionName",
  "malformed tag still resolves a name",
  formatRegionName("US", "en_US"),
  new Intl.DisplayNames(undefined, { type: "region", fallback: "none" }).of("US"),
);

// ---------------------------------------------------------------------------
// The refusal path is deliberately NOT isolated: absence has nothing to lay out,
// and a `null` that had become an isolate pair would render as a price of "".
// ---------------------------------------------------------------------------

check(
  "formatSourceMoney refuses an unknown precision with null, not an isolated empty string",
  formatSourceMoney({ amount: 129_900, currency: "RON" }, EN) === null,
  `got ${JSON.stringify(formatSourceMoney({ amount: 129_900, currency: "RON" }, EN))}`,
);

// ---------------------------------------------------------------------------
// LOCALIZATION (#500), and the control that makes the rest of it mean anything.
//
// ## Why these are mostly properties rather than exact strings
//
// The expected values below were read from `Intl` DIRECTLY rather than from the
// module under test — a guard whose expectations come from the code it checks
// asserts only that the code equals itself. But CLDR data moves between ICU
// releases, and the parts likeliest to move are exactly the invisible ones:
// `de` puts U+00A0 before its percent sign and `es` puts one before "mil",
// while `de` uses a plain U+0020 before "km". Pinning those exactly would make
// this gate fail on a `bun` upgrade for a reason that has nothing to do with
// Mercaria.
//
// So the EXACT assertions are limited to spellings that are stable and
// load-bearing — a decimal comma, a 万 grouping, a non-Latin digit — and the
// rest are asserted as the PROPERTY the issue is actually about.
// ---------------------------------------------------------------------------

checkIsolatedExactly(
  "formatMoney",
  "USD/de — decimal comma",
  formatMoney({ amount: 14800, currency: "USD" }, "de"),
  "$148,00",
);
checkIsolatedExactly(
  "formatMoney",
  "USD/es — decimal comma",
  formatMoney({ amount: 14800, currency: "USD" }, "es"),
  "$148,00",
);
checkIsolatedExactly(
  "formatSourceMoney",
  "convertible currency/de",
  formatSourceMoney({ amount: 12_999, currency: "USD" }, "de"),
  "129,99 USD",
);
checkIsolatedExactly(
  "formatDistance",
  "kilometres/de",
  formatDistance(2500, "de"),
  "2,5 km",
);
checkIsolatedExactly("formatRating", "de", formatRating(4.5, "de"), "4,5");
// Abbreviation is a property of the LANGUAGE, not of the number: Japanese
// groups by ten thousand and German does not abbreviate at this magnitude at
// all. A hardcoded "K" is not a smaller version of either.
checkIsolatedExactly(
  "formatReviewCount",
  "abbreviated/ja — 万, not K",
  formatReviewCount(10_300, "ja"),
  "1万",
);
checkIsolatedExactly(
  "formatReviewCount",
  "abbreviated/de — not abbreviated at all",
  formatReviewCount(10_300, "de"),
  "10.300",
);

/**
 * THE CONTROL FOR THE WHOLE CHANGE.
 *
 * Every assertion above would still pass on a runtime whose `Intl` ignored the
 * locale and answered `en` for everything — the English cases by definition,
 * and the localized cases would simply go red one at a time in a way that reads
 * as "CLDR moved". This asserts the thing itself: that the locale is REACHING
 * the formatter and CHANGING the output.
 *
 * It is the question worth asking of any check — what would it report if the
 * property it measures were absent? Without this, a `format.ts` that took a
 * `locale` parameter and dropped it on the floor would fail the exact cases
 * above with a confusing diff; with it, the failure names the defect.
 *
 * Note what it does NOT prove: it runs under `bun`, which has full ICU. It says
 * nothing about a constrained Hermes build, where `formatNumber`'s documented
 * fallback would take over and every locale WOULD collapse to the English
 * spelling. That gap is real and is stated in the PR rather than papered over —
 * no gate that runs here can close it.
 */
const localizedPairs = [
  ["formatMoney", formatMoney({ amount: 14800, currency: "USD" }, EN), formatMoney({ amount: 14800, currency: "USD" }, "de")],
  ["formatSourceMoney", formatSourceMoney({ amount: 12_999, currency: "USD" }, EN), formatSourceMoney({ amount: 12_999, currency: "USD" }, "de")],
  ["formatDistance", formatDistance(2500, EN), formatDistance(2500, "de")],
  ["formatReviewCount", formatReviewCount(10_300, EN), formatReviewCount(10_300, "ja")],
  ["formatPercent", formatPercent(820, EN), formatPercent(820, "de")],
  ["formatRating", formatRating(4.5, EN), formatRating(4.5, "de")],
];

for (const [name, english, localized] of localizedPairs) {
  check(
    `${name}: the locale reaches the output (en and a non-en locale differ)`,
    english !== localized,
    `both rendered ${JSON.stringify(english)} — the locale argument is being ignored, `
    + "so every reader gets English no matter what they chose",
  );
}

/**
 * `ar` renders Arabic-Indic digits, which is the case that most needs isolation
 * and the one a Latin-digit assumption breaks silently. Asserted as a property
 * — no ASCII digit survives — rather than as a literal, because the point is
 * the numbering system and not one particular spelling of 148.
 */
const arabicMoney = visibleText(formatMoney({ amount: 14800, currency: "USD" }, "ar"));
check(
  "formatMoney/ar uses the locale's own digits (no ASCII digit in the figure)",
  !/[0-9]/.test(arabicMoney.replace("$", "")),
  `got ${JSON.stringify(arabicMoney)} — ${describeCodePoints(arabicMoney)}`,
);

/**
 * A malformed tag must DEGRADE, never throw. The locale in force is the OS's
 * raw BCP-47 tag, and `Intl` throws `RangeError` on a structurally invalid one
 * (`en_US` does). This is a price formatter: an uncaught throw white-screens a
 * product page, so the fallback path is load-bearing rather than defensive
 * decoration — and this is the only place it is exercised.
 */
check(
  "formatMoney degrades to the pre-#500 spelling on a malformed locale tag rather than throwing",
  visibleText(formatMoney({ amount: 14800, currency: "USD" }, "en_US")) === "$148.00",
  `got ${JSON.stringify(visibleText(formatMoney({ amount: 14800, currency: "USD" }, "en_US")))}`,
);

/**
 * English money GAINS grouping separators, which `toFixed` never emitted. This
 * is the one way existing English rendering moves, so it is asserted rather
 * than left to be discovered in a screenshot.
 */
checkIsolatedExactly(
  "formatMoney",
  "grouped/en — the one English change",
  formatMoney({ amount: 123_456, currency: "USD" }, EN),
  "$1,234.56",
);

// ---------------------------------------------------------------------------
// `isolateBidi` itself: the properties the formatters rest on.
// ---------------------------------------------------------------------------

const wrapped = isolateBidi("$1.00");
check(
  "isolateBidi wraps plain text in one FSI/PDI pair",
  describeCodePoints(wrapped) === describeCodePoints(`\u2068$1.00\u2069`),
  `got ${describeCodePoints(wrapped)}`,
);

check(
  "isolateBidi is idempotent — an already-isolated string is returned unchanged",
  isolateBidi(wrapped) === wrapped,
  `got ${describeCodePoints(isolateBidi(wrapped))}`,
);

check(
  "isolateBidi applied to formatter output does not double wrap",
  isolateBidi(formatMoney({ amount: 100, currency: "USD" }, EN)) ===
    formatMoney({ amount: 100, currency: "USD" }, EN),
  `got ${describeCodePoints(isolateBidi(formatMoney({ amount: 100, currency: "USD" }, EN)))}`,
);

// The case a `startsWith`/`endsWith` idempotence test gets WRONG. Two isolated
// fragments joined together begin with an initiator and end with a PDI, but the
// JOIN between them is unprotected, so the concatenation must be wrapped again.
const twoFragments = `${isolateBidi("a")}${isolateBidi("b")}`;
check(
  "isolateBidi wraps two concatenated isolates (the join is not protected by either)",
  isolateBidi(twoFragments) !== twoFragments &&
    Array.from(isolateBidi(twoFragments))[0].codePointAt(0) === FIRST_STRONG_ISOLATE,
  `got ${describeCodePoints(isolateBidi(twoFragments))}`,
);

check(
  "isolateBidi leaves an empty string empty rather than emitting a bare isolate pair",
  isolateBidi("") === "",
  `got ${describeCodePoints(isolateBidi(""))}`,
);

// An LRI-isolated string is already isolated and must not be re-wrapped, or a
// caller that chose a direction on purpose would have it overridden.
check(
  "isolateBidi respects an existing LRI/PDI isolate",
  isolateBidi("\u2066x\u2069") === "\u2066x\u2069",
  `got ${describeCodePoints(isolateBidi("\u2066x\u2069"))}`,
);

// ---------------------------------------------------------------------------
// Vacuity floor: the covered set must be EXACTLY what `format.ts` exports.
// A fifth formatter added there fails this until it is covered above.
// ---------------------------------------------------------------------------

const coveredFormatters = Array.from(exercisedFormatters);

/**
 * What `format.ts` exports, read from the MODULE rather than from its text.
 *
 * This was `/^export function (\w+)/gm` over the source, and that pattern is a
 * model of one declaration syntax rather than of the module (#491). The
 * language has several others, and every one of them was invisible to it:
 *
 *     export const formatX = (n) => …      // an arrow, the common modern spelling
 *     export async function formatX(n) {}  // `async` sits between the two words
 *     export default function formatX() {} // `default` likewise
 *     export { formatX };                  // declared above, exported below
 *
 * Measured before the fix: appending a real `export const formatAuditProbe` to
 * `format.ts` and running the UNMUTATED guard printed "passed — 61 assertions
 * over 4 formatters" and exited 0, never naming it. The census reconciled
 * perfectly because the new formatter was not in the population it compared
 * against — which is the failure mode a census has instead of a bug.
 *
 * A namespace import has no syntax to miss: whatever the module exports is what
 * this sees. Types erase at runtime, so the `typeof` filter leaves exactly the
 * callable exports — which is the right population, because a formatter that a
 * screen renders is by definition a function.
 */
const exportedFormatters = FORMATTER_MODULES.flatMap(({ module }) =>
  Object.entries(module)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name),
);

check(
  "the module census found the formatters at all (a broken census reads as a clean zero)",
  exportedFormatters.length > 0,
  `no callable exports found on ${formatModulePath}`,
);

// A PER-MODULE floor, not only a floor on the union. Without it, a module that
// resolved to zero callable exports — renamed, moved, or an import that silently
// answered an empty namespace — would subtract its formatters from the
// population while the union stayed comfortably above any total floor, and the
// exact reconciliation below would then reconcile the smaller set perfectly.
for (const { path, module, minimum } of FORMATTER_MODULES) {
  const own = Object.entries(module).filter(([, value]) => typeof value === "function");
  check(
    `${path} contributes at least ${minimum} formatter(s) to the census`,
    own.length >= minimum,
    `found ${own.length} (${own.map(([name]) => name).join(", ") || "none"}) — the census shrank `
    + "silently rather than failing. If you deliberately removed one, lower this module's "
    + "`minimum` AND the union floor below, in the same change",
  );
}

/**
 * How many MODULES the census must cover, written out rather than counted from
 * `FORMATTER_MODULES.length` — which would assert the array has as many entries
 * as it has, true of any array including an empty one.
 *
 * This is the number that catches an entry being DELETED from the list, which
 * neither floor below can see: removing one takes its formatters and its own
 * minimum away together, so every remaining comparison still balances.
 */
const MINIMUM_FORMATTER_MODULES = 3;
check(
  `the census covers at least ${MINIMUM_FORMATTER_MODULES} modules`,
  FORMATTER_MODULES.length >= MINIMUM_FORMATTER_MODULES,
  `only ${FORMATTER_MODULES.length} listed — a module dropped from FORMATTER_MODULES takes its `
  + "own floor with it, so nothing else here would notice",
);

/**
 * A floor on the whole population, HAND-WRITTEN and deliberately not the sum of
 * the per-module minimums above: a sum moves whenever one of its terms does, so
 * it could never disagree with them and would measure nothing.
 *
 * It was **4 while the tree exported 7**, because #513 added three formatters
 * and did not re-derive it. A floor below its population is green forever and
 * can no longer catch the narrowing it exists for — the failure it is named
 * after. Re-derive on every change to the population, INCLUDING a rebase: two
 * branches can raise this on different lines, merge with no conflict, and
 * silently keep one number.
 */
const MINIMUM_EXPORTED_FORMATTERS = 9;
check(
  `at least ${MINIMUM_EXPORTED_FORMATTERS} formatters were found (vacuity floor on the census)`,
  exportedFormatters.length >= MINIMUM_EXPORTED_FORMATTERS,
  `found ${exportedFormatters.length}: ${exportedFormatters.join(", ")}`,
);

const uncovered = exportedFormatters.filter((name) => !coveredFormatters.includes(name));
const stale = coveredFormatters.filter((name) => !exportedFormatters.includes(name));
check(
  "every formatter exported by format.ts is covered by a case above",
  uncovered.length === 0,
  `exported but never exercised: ${uncovered.join(", ")} — add a checkIsolatedExactly case`,
);
check(
  "every formatter this gate exercises still exists in format.ts",
  stale.length === 0,
  `exercised here but not exported by format.ts: ${stale.join(", ")}`,
);

/**
 * A floor on the assertion count itself. If an edit above collapses the case
 * list, this reports it rather than passing with two checks — the census needs
 * its own census.
 */
// 189 run today. Was 40 while 97 ran — the same omission as the formatter floor
// above: #513 added cases and left the number where it was. Both are
// hand-written on purpose, and both must be re-derived when the case list moves.
const MINIMUM_ASSERTIONS = 180;
check(
  `at least ${MINIMUM_ASSERTIONS} assertions ran (vacuity floor on the gate itself)`,
  assertionCount >= MINIMUM_ASSERTIONS,
  `only ${assertionCount} ran`,
);

if (failures.length > 0) {
  console.error(`\nBidi isolation guard FAILED — ${failures.length} of ${assertionCount} checks:\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    "\nDisplay formatters in packages/ui/src/lib/format.ts must return strings wrapped in",
    "\nFSI (U+2068) ... PDI (U+2069). See packages/ui/src/lib/bidi.ts for why.\n",
  );
  process.exit(1);
}

console.log(`Bidi isolation guard passed — ${assertionCount} assertions over ${exportedFormatters.length} formatters.`);
