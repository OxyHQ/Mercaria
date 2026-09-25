#!/usr/bin/env bun

/**
 * A side-sheet must come in from the edge the reader's language names
 * (#429 item 4).
 *
 * ## What can actually go wrong here
 *
 * Almost all of RTL is class names, and `validate-rtl-logical-classes.mjs`
 * gates those. The POS variant picker's Bloom side-sheet is the residual that
 * guard cannot touch: Bloom's `Dialog` takes a PHYSICAL `placement`
 * (`left` / `right`) and parks the sheet with a physical `translateX` — a CSS
 * transform is never mirrored by `dir`, and RN applies transforms after Yoga's
 * layout pass — so the logical edge has to be resolved to a screen edge from the
 * direction before it is handed to Bloom. `useLogicalDialogPlacement` does that
 * through `resolvePhysicalSide`.
 *
 * (#429 shipped two more computed facts here — the parked sign and the physical
 * divider class — for the hand-rolled `Panel` and `Sheet`. Both components are
 * deleted, Bloom owns the slide, and those functions and their assertions went
 * with them.)
 *
 * The resolution is ARITHMETIC over a boolean, and arithmetic over a boolean
 * fails in the one way nothing else here can see: the sheet renders, animates,
 * and comes in from the wrong side. `tsc` is happy — every wrong answer has the
 * right type. The export succeeds. The class guard sees nothing, because the
 * offending value is a string chosen by a ternary rather than a class name.
 *
 * ## Why a script rather than a unit test
 *
 * `packages/ui` has no test runner — its `test` script is an `echo` — and it
 * owns `lib/logical-side.ts`, the module asserted below. The three Expo apps do
 * each have one (`vitest run`, run by `ci.yml`'s `Test Dashboard`, `Test App`
 * and `Test POS` steps), so the claim is not that a test is impossible here; it
 * is that a test cannot live in the package that owns this code, and that the
 * call sites this guard also checks could live in any of the four packages.
 *
 * And those three runners cannot mount a component, which is the half worth
 * writing down because the tempting inference goes the other way. All three
 * collect from `lib` only under `environment: 'node'` with no renderer (#469,
 * recorded in each `vitest.config.ts`): importing `react-native` dies at its
 * `index.js:27` with `RollupError: Parse failure: Expected 'from', got
 * 'typeOf'`, measured in all three separately. The call site below is a hook
 * over `react-native`, so it is not assertable in any app suite today. The usable form is that config's own rule: extract the
 * derivation into `lib/` and assert it by running it, which is exactly what
 * `logical-side.ts` is and why this guard can import and RUN it rather than
 * scan for a spelling.
 *
 * `validate-rtl-direction.mjs` is the precedent and this follows it exactly:
 * import the REAL module and run it, rather than scan the source for a spelling.
 *
 * `packages/ui/src/lib/logical-side.ts` is importable here precisely because it
 * imports nothing itself. The direction READ (Bloom's `useIsRtl`) needs
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

import { resolvePhysicalSide } from "../packages/ui/src/lib/logical-side.ts";
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

// ------------------------------------------ the consumers must actually call it ---

/**
 * A mechanism can be correct and INERT. Everything above would pass unchanged
 * against a placement hook that had quietly gone back to a hardcoded side, so
 * each consumer is checked for the calls themselves.
 *
 * Read as bytes rather than imported: consumers pull in `react-native` (the
 * placement hook through Bloom), which cannot be imported outside a bundler — the same
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
 * Non-zero. #429 shipped two consumers, `Panel` and `Sheet`; both are deleted,
 * and the one consumer left is the placement hook the variant picker calls. A
 * consumer that stops importing the module still fails below, through its
 * REQUIRED_CALLS entry, and the reachability check fails with it.
 */
const MINIMUM_CONSUMERS = 1;
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
 * strings, so a SECOND exported function is covered the day it is added instead
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
 * replaced. Measured while building it (against the since-deleted Panel and
 * Sheet): with only "every consumer calls something" and "every export is
 * called by someone", replacing panel.tsx's `offscreenTranslateX(` with a
 * hardcoded sign PASSED — sheet.tsx still called the function, so the export
 * was still reached. With one consumer today the two checks coincide; the map
 * is what keeps them apart the day a second consumer arrives.
 *
 * A consumer that appears in the tree and NOT here fails the build until
 * somebody says what it must call — the `merge-plan-census` device. That is a
 * deliberate cost: adding a consumer is exactly the moment to decide whether it
 * may compute a sign itself.
 */
const REQUIRED_CALLS = new Map([
  // Bloom's `Dialog` takes a PHYSICAL side-sheet placement, so the hook every
  // logical-edge sheet goes through must keep resolving it here rather than
  // writing its own `rtl ? … : …`.
  ["packages/ui/src/lib/logical-dialog-placement.ts", ["resolvePhysicalSide"]],
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

const MINIMUM_EXPORTED_FUNCTIONS = 1;
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
    + "against a consumer that had gone back to a hardcoded side — a mechanism can be correct and "
    + "inert, and this is the assertion that can tell the difference.",
  );
}

/**
 * Below this a file has been emptied, moved or truncated, and every `includes`
 * assertion over it would fail for a reason that has nothing to do with the
 * property under test. The placement hook is ~1.8 kB, most of it the docblock
 * that says why it exists.
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
      + "longer reaching the screen. A consumer that derives its own side is exactly what this file "
      + "exists to stop, and it looks identical to a working one everywhere else.",
    );
  }

  /**
   * The physical prop was a CLEAN CUT, not a rename with the old union left
   * beside it. `tsc` catches a call site passing `side="right"`; it does not
   * catch the union being widened back on the consumer itself, because
   * everything then compiles again. (The placement hook RETURNS a physical side
   * by design, and spells it `PhysicalSide`, never as an inline union.)
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
    "  A side-sheet is the one part of the mirrored layout that cannot be expressed in logical\n"
    + "  utilities: Bloom's placement is physical, so the edge is computed. Getting it wrong\n"
    + "  renders, animates, typechecks and exports — it just comes in from the wrong edge.\n",
  );
  process.exit(1);
}

console.log(
  `Logical-side guard passed — ${EXPECTED_PHYSICAL.length} side x direction combinations resolved, `
  + "mirror property asserted for both sides, "
  + `all ${EXPORTED_FUNCTIONS.length} exported function(s) `
  + `(${EXPORTED_FUNCTIONS.join(", ")}) reached from ${CONSUMERS.length} consumer(s) DERIVED from `
  + `${scanned.length} scanned files (${CONSUMERS.join(", ")}), none declaring a physical side union. `
  + "It does NOT verify that anything renders — #429 item 2 is still open.",
);
