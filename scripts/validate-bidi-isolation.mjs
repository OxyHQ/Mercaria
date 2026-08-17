#!/usr/bin/env bun

/**
 * The storefront's display formatters must emit BIDI-ISOLATED strings
 * (#429 item 1). This asserts that they do, by CODE POINT.
 *
 * ## Why this exists rather than a review
 *
 * `FSI` (U+2068) and `PDI` (U+2069) are `Cf` format characters: zero-width and
 * default-ignorable. Isolation that was never applied, applied to three of four
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
 * A gate over four hand-listed functions goes quietly useless the moment a
 * fifth is added, so the covered set is checked for EXACT equality against the
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
  formatReviewCount,
  formatSourceMoney,
} from "../packages/ui/src/lib/format.ts";
// The SAME module again, as a namespace, so the census below can enumerate what
// it exports rather than pattern-match the text that declares them (#491).
import * as formatModule from "../packages/ui/src/lib/format.ts";
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
// The four formatters. Expected visible strings are the pre-#429 outputs.
// ---------------------------------------------------------------------------

checkIsolatedExactly(
  "formatMoney",
  "USD",
  formatMoney({ amount: 14800, currency: "USD" }),
  "$148.00",
);
checkIsolatedExactly(
  "formatMoney",
  "FAIR (8dp)",
  formatMoney({ amount: 14_800_000_000, currency: "FAIR" }),
  "⊜148.00",
);
checkIsolatedExactly("formatMoney", "zero", formatMoney({ amount: 0, currency: "EUR" }), "€0.00");
// A negative amount puts the minus BETWEEN the symbol and the digits, which is
// the shape `ShoppingAgentFindingCard` avoids by rendering the sign as a word.
// Isolation must not move it: this pins the whole token, sign included.
checkIsolatedExactly(
  "formatMoney",
  "negative",
  formatMoney({ amount: -500, currency: "USD" }),
  "$-5.00",
);

checkIsolatedExactly(
  "formatSourceMoney",
  "convertible currency",
  formatSourceMoney({ amount: 12_999, currency: "USD" }),
  "129.99 USD",
);

checkIsolatedExactly("formatDistance", "metres", formatDistance(450), "450 m");
checkIsolatedExactly("formatDistance", "kilometres", formatDistance(2500), "2.5 km");

checkIsolatedExactly("formatReviewCount", "bare", formatReviewCount(349), "349");
checkIsolatedExactly("formatReviewCount", "abbreviated", formatReviewCount(10_300), "10.3K");
checkIsolatedExactly("formatReviewCount", "rounded", formatReviewCount(1000), "1K");

// ---------------------------------------------------------------------------
// The refusal path is deliberately NOT isolated: absence has nothing to lay out,
// and a `null` that had become an isolate pair would render as a price of "".
// ---------------------------------------------------------------------------

check(
  "formatSourceMoney refuses an unknown precision with null, not an isolated empty string",
  formatSourceMoney({ amount: 129_900, currency: "RON" }) === null,
  `got ${JSON.stringify(formatSourceMoney({ amount: 129_900, currency: "RON" }))}`,
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
  isolateBidi(formatMoney({ amount: 100, currency: "USD" })) ===
    formatMoney({ amount: 100, currency: "USD" }),
  `got ${describeCodePoints(isolateBidi(formatMoney({ amount: 100, currency: "USD" })))}`,
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
const exportedFormatters = Object.entries(formatModule)
  .filter(([, value]) => typeof value === "function")
  .map(([name]) => name);

check(
  "the module census found the formatters at all (a broken census reads as a clean zero)",
  exportedFormatters.length > 0,
  `no callable exports found on ${formatModulePath}`,
);

/**
 * A floor on the population itself, not only on its non-emptiness. `format.ts`
 * has carried at least these four since #429; a census reporting fewer has
 * resolved the wrong module or been narrowed, and the reconciliation below
 * would then pass while exercising a subset.
 */
const MINIMUM_EXPORTED_FORMATTERS = 4;
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
const MINIMUM_ASSERTIONS = 40;
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
