#!/usr/bin/env bun

/**
 * A sliding panel must come in from the edge the reader's language starts from
 * (#429 item 4).
 *
 * ## What can actually go wrong here
 *
 * Almost all of RTL is class names, and `validate-rtl-logical-classes.mjs`
 * gates those. `Panel` and `SheetContent` are the residual that guard could not
 * touch, and the reason is that two of their facts have no logical spelling:
 *
 *   * `translateX` is PHYSICAL on both platforms — a CSS transform is never
 *     mirrored by `dir`, and RN applies transforms after Yoga's layout pass — so
 *     the sign of the parked position has to be computed from the direction.
 *   * the divider on the panel's inner face has to stay a physical border
 *     utility, because the logical ones emit `borderInline*` and RN 0.85.3 drops
 *     them on native (#429 item 3, an upstream capability).
 *
 * Both are ARITHMETIC over a boolean, and arithmetic over a boolean fails in the
 * one way nothing else here can see: the panel renders, animates, and comes in
 * from the wrong side. `tsc` is happy — every wrong answer has the right type.
 * The export succeeds. The class guard sees nothing, because the offending value
 * is a number and a ternary rather than a class name.
 *
 * ## Why a script rather than a unit test
 *
 * `packages/ui` has no test runner — its `test` script is an `echo` — and it
 * owns `lib/logical-side.ts`, the module asserted below. The three Expo apps do
 * each have one (`vitest run`, run by `ci.yml`'s `Test Dashboard`, `Test App`
 * and `Test POS` steps), so the claim is not that a test is impossible here; it
 * is that a test cannot live in the package that owns this code, and that the
 * panel/sheet call sites this guard also checks are spread across all four
 * packages. A behaviour observable from inside one app is now cheaper and
 * stronger to assert in that app's own suite than by widening this scan.
 *
 * `validate-rtl-direction.mjs` is the precedent and this follows it exactly:
 * import the REAL module and run it, rather than scan the source for a spelling.
 *
 * `packages/ui/src/lib/logical-side.ts` is importable here precisely because it
 * imports nothing itself. Its sibling `use-layout-direction.ts` needs
 * `I18nManager` and cannot run outside a bundler — which is why READING the
 * direction was split from DECIDING what follows from it, the same split
 * `rtl-locales.ts` and `layout-direction.ts` already have.
 *
 * ## What this cannot tell you
 *
 * Whether a mirrored sheet visibly slides in from the correct edge. That is a
 * rendering property of a real foregrounded tab and a real device build, and
 * nothing in this repository or in CI runs one. It remains #429 item 2, and this
 * guard must not be read as having closed it.
 *
 * Usage:  bun scripts/validate-logical-side.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  innerEdgeBorderClassName,
  offscreenTranslateX,
  oppositeLogicalSide,
  resolvePhysicalSide,
} from "../packages/ui/src/lib/logical-side.ts";
// The same module as a namespace, so the consumer census below can enumerate
// what it exports rather than repeat a hand-written list of names (#491).
import * as logicalSideModule from "../packages/ui/src/lib/logical-side.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];

// ------------------------------------------------------- the resolution table ---

/**
 * The whole domain: two logical sides times two directions. Stated as data so
 * the coverage assertions below can count it, rather than as four hand-written
 * `if`s whose gaps nobody would notice.
 */
const SIDES = ["start", "end"];
const DIRECTIONS = [false, true];

/** The one table everything else is derived from. Spelled out, not computed. */
const EXPECTED_PHYSICAL = [
  { side: "start", rtl: false, physical: "left" },
  { side: "start", rtl: true, physical: "right" },
  { side: "end", rtl: false, physical: "right" },
  { side: "end", rtl: true, physical: "left" },
];

if (EXPECTED_PHYSICAL.length !== SIDES.length * DIRECTIONS.length) {
  failures.push(
    `the expected table has ${EXPECTED_PHYSICAL.length} rows but the domain is `
    + `${SIDES.length} sides x ${DIRECTIONS.length} directions — a table that does not cover every `
    + "combination leaves whichever one it omits unasserted, which is the combination a bug lives in",
  );
}

for (const row of EXPECTED_PHYSICAL) {
  const actual = resolvePhysicalSide(row.side, row.rtl);
  if (actual === row.physical) continue;
  failures.push(
    `resolvePhysicalSide(${JSON.stringify(row.side)}, ${row.rtl}) returned ${JSON.stringify(actual)}, `
    + `expected ${JSON.stringify(row.physical)}. The logical start edge is the LEFT of a left-to-right `
    + "layout and the RIGHT of a mirrored one; every other value in this module is derived from that.",
  );
}

/**
 * THE MIRROR PROPERTY, asserted separately from the table above.
 *
 * A `resolvePhysicalSide` that ignored `rtl` entirely would still return a real
 * physical side for every input and would still satisfy a check that only asked
 * "is the answer left or right". It is caught here and only here: the two
 * directions must DISAGREE, for each side.
 */
for (const side of SIDES) {
  const ltr = resolvePhysicalSide(side, false);
  const rtl = resolvePhysicalSide(side, true);
  if (ltr !== rtl) continue;
  failures.push(
    `resolvePhysicalSide(${JSON.stringify(side)}, …) answered ${JSON.stringify(ltr)} in BOTH `
    + "directions. A logical side that resolves the same way whichever way the layout reads is a "
    + "physical side wearing a logical name, and the layout around it would mirror without it.",
  );
}

/** Both physical answers must actually occur, or the table is asserting one constant. */
const observedPhysical = new Set(
  SIDES.flatMap((side) => DIRECTIONS.map((rtl) => resolvePhysicalSide(side, rtl))),
);
if (observedPhysical.size !== 2) {
  failures.push(
    `resolvePhysicalSide produced ${observedPhysical.size} distinct answer(s) `
    + `(${[...observedPhysical].join(", ")}) across the whole domain — expected both`,
  );
}

// ------------------------------------------------------------ the opposite edge ---

for (const side of SIDES) {
  const opposite = oppositeLogicalSide(side);
  if (opposite === side) {
    failures.push(
      `oppositeLogicalSide(${JSON.stringify(side)}) returned its own input — the inner face of a panel `
      + "is the edge it is NOT anchored to",
    );
    continue;
  }
  if (oppositeLogicalSide(opposite) !== side) {
    failures.push(
      `oppositeLogicalSide is not an involution: ${JSON.stringify(side)} -> `
      + `${JSON.stringify(opposite)} -> ${JSON.stringify(oppositeLogicalSide(opposite))}`,
    );
  }
}

// --------------------------------------------------------- the animation sign ---

/**
 * The parked position is off the screen edge the panel OCCUPIES.
 *
 * Cross-checked against `resolvePhysicalSide` rather than against a second
 * hand-written table: a sign flip in one of the two functions is exactly the bug
 * this file exists for, and two independent tables would let them drift apart
 * while both looked right on their own.
 */
const DISTANCE = 375;
for (const side of SIDES) {
  for (const rtl of DIRECTIONS) {
    const physical = resolvePhysicalSide(side, rtl);
    const parked = offscreenTranslateX(side, rtl, DISTANCE);
    const expected = physical === "right" ? DISTANCE : -DISTANCE;
    if (parked === expected) continue;
    failures.push(
      `offscreenTranslateX(${JSON.stringify(side)}, ${rtl}, ${DISTANCE}) returned ${parked}, expected `
      + `${expected}: the panel resolves to the ${physical} edge, and a positive translateX moves right `
      + "on BOTH platforms (a CSS transform is not mirrored by dir, and RN applies transforms after "
      + "layout). The wrong sign parks the panel on top of the content instead of off screen, and it "
      + "then slides in from the opposite edge.",
    );
  }
}

/** Both signs must occur, or the sign is not a function of the direction at all. */
const observedSigns = new Set(
  SIDES.flatMap((side) => DIRECTIONS.map((rtl) => Math.sign(offscreenTranslateX(side, rtl, DISTANCE)))),
);
if (observedSigns.size !== 2) {
  failures.push(
    `offscreenTranslateX produced ${observedSigns.size} distinct sign(s) across the whole domain — `
    + "expected both, or the parked position does not depend on the direction",
  );
}

/**
 * The caller's sign is not an input. A caller passing a width it had already
 * negated must get the same parked position, or the direction would be decided
 * by whichever variable happened to be in scope.
 */
for (const side of SIDES) {
  for (const rtl of DIRECTIONS) {
    const positive = offscreenTranslateX(side, rtl, DISTANCE);
    const negative = offscreenTranslateX(side, rtl, -DISTANCE);
    if (positive === negative) continue;
    failures.push(
      `offscreenTranslateX(${JSON.stringify(side)}, ${rtl}, ±${DISTANCE}) answered ${positive} and `
      + `${negative}. The parked position is a function of the side and the direction; a caller that `
      + "negated the width first must not be able to flip it.",
    );
  }
}

// ------------------------------------------------------------- the inner border ---

/**
 * The divider sits on the face turned towards the content, which is the edge
 * OPPOSITE the anchor. Asserted against `resolvePhysicalSide` for the same
 * reason the sign is: one table, one place to be wrong.
 */
for (const side of SIDES) {
  for (const rtl of DIRECTIONS) {
    const physical = resolvePhysicalSide(side, rtl);
    const expected = physical === "right" ? "border-l" : "border-r";
    const actual = innerEdgeBorderClassName(side, rtl);
    if (actual === expected) continue;
    failures.push(
      `innerEdgeBorderClassName(${JSON.stringify(side)}, ${rtl}) returned ${JSON.stringify(actual)}, `
      + `expected ${JSON.stringify(expected)}: a panel occupying the ${physical} of the screen is `
      + "divided from the content on its other side. Drawing it on the anchored edge puts a rule down "
      + "the outside of the screen, where nothing can see it.",
    );
  }
}

/**
 * It must never emit a LOGICAL border utility, however tempting that reads.
 * `border-s-*` and `border-e-*` compile to `borderInlineStartWidth` and friends,
 * which React Native 0.85.3 does not register — the border renders in a browser
 * and silently disappears on iOS and Android, which is strictly worse than the
 * mis-mirroring it would be fixing. That measurement is #429 item 3 and it is
 * the whole reason this function exists rather than a class.
 */
for (const side of SIDES) {
  for (const rtl of DIRECTIONS) {
    const actual = innerEdgeBorderClassName(side, rtl);
    if (!/^border-[se](?![\w-])/.test(actual)) continue;
    failures.push(
      `innerEdgeBorderClassName(${JSON.stringify(side)}, ${rtl}) returned the LOGICAL utility `
      + `${JSON.stringify(actual)}. It compiles to borderInline*, which RN 0.85.3 does not register, so `
      + "the divider would vanish on native while looking correct on web. Keep the physical spelling and "
      + "the reasoned KNOWN_EXCEPTIONS entry that covers it.",
    );
  }
}

// ------------------------------------------ the components must actually call it ---

/**
 * A mechanism can be correct and INERT. Everything above would pass unchanged
 * against a `Panel` that had quietly gone back to a hardcoded sign, so the two
 * consumers are checked for the calls themselves.
 *
 * Read as bytes rather than imported: these are `.tsx` files that pull in
 * `react-native`, which cannot be imported outside a bundler — the same
 * constraint that shaped the module split in the first place.
 */
/**
 * WHO imports this module is DERIVED from the tree, not listed here (#491).
 *
 * It was a two-entry literal, and setting it to `[]` made this guard PASS,
 * exit 0, printing "0 consumers confirmed to call it". Every assertion below
 * lives inside a `for` over that list, so emptying it removed them all and left
 * the reassuring sentence. It defeated the exact failure the block's own
 * docstring names — "A mechanism can be correct and INERT" — and no floor on
 * the list existed anywhere in the file.
 *
 * A hand list has a second, quieter failure the floor alone would not fix: a
 * THIRD consumer added later is not in it, so the guard goes on reporting two
 * while the new one derives its own sign. Deriving the list fixes both, and a
 * new consumer is covered on the day it appears.
 */
const SOURCE_ROOTS = ["packages"];
const SOURCE_FILE = /\.tsx?$/;
const SKIP_DIRECTORY = /^(node_modules|dist|build|\.expo|\.next|ios|android)$/;

/** Every `.ts`/`.tsx` under `packages/`, excluding build output. */
function sourceFiles(root) {
  const out = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORY.test(entry.name)) walk(join(directory, entry.name));
      } else if (SOURCE_FILE.test(entry.name)) {
        out.push(join(directory, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

const scanned = SOURCE_ROOTS.flatMap((root) => sourceFiles(resolve(repositoryRoot, root)));

/**
 * Below this the walk is broken, and a broken walk finds no consumers — which
 * would fail the floor below for a reason that has nothing to do with the
 * property under test, and say so unhelpfully. Measured: well over 1000.
 */
const MINIMUM_SCANNED_FILES = 400;
if (scanned.length < MINIMUM_SCANNED_FILES) {
  failures.push(
    `the source walk found ${scanned.length} files under ${SOURCE_ROOTS.join(", ")}, below the `
    + `${MINIMUM_SCANNED_FILES} floor — the walk is broken, and a broken walk finds no consumers `
    + "and reports the mechanism inert for the wrong reason",
  );
}

/**
 * A consumer IMPORTS the module. A barrel that only re-exports it (`export …
 * from`) is not one, and is excluded structurally rather than by "has no calls"
 * — the latter would silently reclassify a consumer that had STOPPED calling as
 * a barrel, which is precisely the regression this block exists to catch.
 */
const IMPORTS_LOGICAL_SIDE = /^\s*import\s[^;]*?["'][^"']*logical-side(?:\.ts)?["']/m;
const MODULE_ITSELF = resolve(repositoryRoot, "packages/ui/src/lib/logical-side.ts");

const CONSUMERS = scanned
  .filter((absolute) => absolute !== MODULE_ITSELF)
  .filter((absolute) => IMPORTS_LOGICAL_SIDE.test(readFileSync(absolute, "utf8")))
  .map((absolute) => relative(repositoryRoot, absolute))
  .sort();

/**
 * Non-zero, and specifically at least the two components #429 shipped. A floor
 * of 1 would let one of them drop out unnoticed; the guard exists because BOTH
 * a panel and a sheet compute a sign that nothing else can check.
 */
const MINIMUM_CONSUMERS = 2;
if (CONSUMERS.length < MINIMUM_CONSUMERS) {
  failures.push(
    `${CONSUMERS.length} module(s) import logical-side.ts, below the ${MINIMUM_CONSUMERS} floor `
    + `(found: ${CONSUMERS.join(", ") || "none"}). Either a component stopped importing it — in which `
    + "case it is deriving its own sign and this whole file is asserting a mechanism nothing runs — "
    + "or the census broke. Both are the inert-mechanism failure; neither is a passing state.",
  );
}

/**
 * Every callable export must be reached by some consumer.
 *
 * Enumerated from the module rather than repeated as a per-file list of call
 * strings, so a FIFTH exported function is covered the day it is added instead
 * of being inert until somebody remembers to name it here.
 */
const EXPORTED_FUNCTIONS = Object.entries(logicalSideModule)
  .filter(([, value]) => typeof value === "function")
  .map(([name]) => name);

/**
 * What each KNOWN consumer must call, per file.
 *
 * This map does NOT drive iteration — the DERIVED list above does — and that
 * separation is the whole point. Emptying this map cannot empty the check, the
 * way emptying the old `CONSUMERS` literal did: every derived consumer still
 * has to appear here (below), so an empty map fails once per consumer.
 *
 * It exists because deriving alone is measurably WEAKER than the hand list it
 * replaced. Measured while building this fix: with only "every consumer calls
 * something" and "every export is called by someone", replacing panel.tsx's
 * `offscreenTranslateX(` with a hardcoded sign PASSED — sheet.tsx still called
 * the function, so the export was still reached, and panel still called
 * `innerEdgeBorderClassName`, so it was still a caller. That is precisely the
 * inert-`Panel` this file was written for, and shipping the derivation on its
 * own would have traded one hole for another.
 *
 * A consumer that appears in the tree and NOT here fails the build until
 * somebody says what it must call — the `merge-plan-census` device. That is a
 * deliberate cost: adding a consumer is exactly the moment to decide whether it
 * may compute a sign itself.
 */
const REQUIRED_CALLS = new Map([
  ["packages/ui/src/components/ui/panel.tsx", ["offscreenTranslateX", "innerEdgeBorderClassName"]],
  [
    "packages/ui/src/components/ui/sheet.tsx",
    ["offscreenTranslateX", "innerEdgeBorderClassName", "resolvePhysicalSide"],
  ],
]);

/** A stale entry names a file that no longer imports the module — the exemption-list rule. */
for (const path of REQUIRED_CALLS.keys()) {
  if (CONSUMERS.includes(path)) continue;
  failures.push(
    `${path} has a required-call entry but does not import logical-side.ts. Either it stopped `
    + "importing — in which case it derives its own sign now — or it moved and the entry is stale, "
    + "and a stale entry is an assertion that runs against nothing.",
  );
}

const MINIMUM_EXPORTED_FUNCTIONS = 4;
if (EXPORTED_FUNCTIONS.length < MINIMUM_EXPORTED_FUNCTIONS) {
  failures.push(
    `the module exports ${EXPORTED_FUNCTIONS.length} function(s) (${EXPORTED_FUNCTIONS.join(", ")}), `
    + `below the ${MINIMUM_EXPORTED_FUNCTIONS} floor — the census resolved the wrong module, and the `
    + "reachability assertion below would then pass over a subset",
  );
}

const consumerSources = new Map(
  CONSUMERS.map((path) => [path, readFileSync(resolve(repositoryRoot, path), "utf8")]),
);

for (const name of EXPORTED_FUNCTIONS) {
  const callers = CONSUMERS.filter((path) => consumerSources.get(path).includes(`${name}(`));
  if (callers.length > 0) continue;
  failures.push(
    `${name} is exported by logical-side.ts and CALLED BY NOTHING that imports it `
    + `(checked: ${CONSUMERS.join(", ") || "no consumers"}). Everything asserted above would still pass `
    + "against a component that had gone back to a hardcoded sign — a mechanism can be correct and "
    + "inert, and this is the assertion that can tell the difference.",
  );
}

/**
 * Below this a file has been emptied, moved or truncated, and every `includes`
 * assertion over it would fail for a reason that has nothing to do with the
 * property under test. Both components are well over 3 kB.
 */
const MINIMUM_CONSUMER_BYTES = 1500;

for (const consumer of CONSUMERS) {
  const source = consumerSources.get(consumer);

  /**
   * BEFORE the byte floor, deliberately. A newly added consumer is usually
   * small, so running the floor first reports a brand-new file as "emptied,
   * truncated or moved" — which is both wrong and the kind of message that
   * gets a guard edited rather than answered. Measured: a 126-byte probe
   * consumer failed with the truncation message and never reached this check.
   */
  const required = REQUIRED_CALLS.get(consumer);
  if (required === undefined) {
    failures.push(
      `${consumer} imports logical-side.ts and has no entry in REQUIRED_CALLS. A new consumer of the `
      + "logical side is exactly the moment to decide which of its facts it may compute itself, so "
      + "state the calls it must make. Until then nothing here asserts that it makes any.",
    );
    continue;
  }

  if (source.length < MINIMUM_CONSUMER_BYTES) {
    failures.push(
      `${consumer} is ${source.length} bytes, below the ${MINIMUM_CONSUMER_BYTES} floor — the file `
      + "was emptied, truncated or moved, and a scan over it reports whatever it likes",
    );
    continue;
  }

  /**
   * An import that calls nothing is a component that went back to deriving its
   * own sign and left the import behind — which still reads as a consumer to
   * any census that counts imports.
   */
  for (const name of required) {
    if (source.includes(`${name}(`)) continue;
    failures.push(
      `${consumer} no longer calls ${name}(…) — the resolution above is still correct and is no `
      + "longer reaching the screen. A component that derives its own sign is exactly what this file "
      + "exists to stop, and it looks identical to a working one everywhere else.",
    );
  }

  /**
   * The physical prop was a CLEAN CUT, not a rename with the old union left
   * beside it. `tsc` catches a call site passing `side="right"`; it does not
   * catch the union being widened back on the component itself, because
   * everything then compiles again.
   */
  if (/["']left["']\s*\|\s*["']right["']|["']right["']\s*\|\s*["']left["']/.test(source)) {
    failures.push(
      `${consumer} declares a physical 'left' | 'right' union again. #429 replaced it with the `
      + "logical `LogicalSide`, deliberately without a back-compatible alias: a component that accepts "
      + "both spellings mirrors for whichever call sites remembered, and the ones that did not are "
      + "invisible because they still compile.",
    );
  }
}

// ------------------------------------------------------------------- verdict ---

if (failures.length > 0) {
  console.error("Logical-side guard failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  A sliding panel is the one part of the mirrored layout that cannot be expressed in logical\n"
    + "  utilities: the transform sign and the divider edge are both computed. Getting either wrong\n"
    + "  renders, animates, typechecks and exports — it just comes in from the wrong edge.\n",
  );
  process.exit(1);
}

console.log(
  `Logical-side guard passed — ${EXPECTED_PHYSICAL.length} side x direction combinations resolved, `
  + "mirror property asserted for both sides, translateX sign and inner border edge cross-checked "
  + `against the resolution, all ${EXPORTED_FUNCTIONS.length} exported functions `
  + `(${EXPORTED_FUNCTIONS.join(", ")}) reached from ${CONSUMERS.length} consumer(s) DERIVED from `
  + `${scanned.length} scanned files (${CONSUMERS.join(", ")}), none declaring a physical side union. `
  + "It does NOT verify that anything renders — #429 item 2 is still open.",
);
