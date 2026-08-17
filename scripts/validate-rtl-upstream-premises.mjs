#!/usr/bin/env bun

/**
 * The two UPSTREAM facts that `KNOWN_EXCEPTIONS` rests on, re-measured (#429
 * item 3).
 *
 * ## The hole this closes
 *
 * `validate-rtl-logical-classes.mjs` excuses fifteen physical directional
 * utilities, in seven reasoned `KNOWN_EXCEPTIONS` entries with exact per-file
 * counts. Those counts are rigorous and fail in BOTH directions — but they are
 * counts over OUR OWN SOURCE TREE. That guard opens no file outside it, so it
 * measures our drift and cannot see upstream's.
 *
 * The exceptions are not stylistic. Each says a LOGICAL spelling would compile
 * and then silently do nothing on a device, and each names a specific upstream
 * capability as the reason. #429 item 3 states that when those capabilities
 * arrive "the exception entries fail the run for being stale, which is how this
 * gets noticed."
 *
 * **They would not.** If `react-native-css` added `start` to its allowed set
 * tomorrow, all seven entries would keep matching their fifteen occurrences,
 * the gate would stay green, and fifteen classes would sit there indefinitely
 * with an expired reason. An exception whose justification has quietly lapsed is
 * worse than no exception at all: the count still reconciles, so nothing looks
 * wrong, and the next reader inherits the rationale as settled fact.
 *
 * This is the thing that notices. It reads the INSTALLED packages, so it goes
 * red the day either premise expires.
 *
 * ## Failing here is GOOD NEWS, and the message has to say so
 *
 * Every other guard in this repository fails because somebody broke something.
 * This one fails because somebody UPSTREAM fixed something — the remedy is to
 * convert the classes and delete the exceptions, not to repair a regression.
 * A gate whose cheapest green is deleting the gate is worse than none, so the
 * failure text names the conversion as the action and never suggests silencing
 * the check.
 *
 * ## Every premise carries its own positive control
 *
 * Both measurements are ABSENCE claims, and absence is what a broken search
 * reports. A moved directory, a renamed dist layout, a package not installed
 * and a genuinely-absent symbol all produce "0 occurrences". So each premise
 * asserts something that MUST be found in the same place by the same mechanism,
 * and a control that goes missing fails the run rather than passing it.
 *
 * ## What this cannot tell you
 *
 * Whether a converted class would actually render correctly on a device. It
 * reads what upstream SHIPS, not what a phone does with it — so a premise
 * expiring here is the signal to go and measure on hardware, which is #429
 * item 2 and is still open.
 *
 * Usage:  bun scripts/validate-rtl-upstream-premises.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Set by the self-test to point the premises at a fixture tree. */
const overrideRoot = process.env.RTL_PREMISES_MODULES_ROOT;
const modulesRoot = overrideRoot
  ? resolve(overrideRoot)
  : join(repositoryRoot, "node_modules");

const failures = [];
const notes = [];

/**
 * Read every file under a directory, bounded by extension.
 *
 * `.js`, `.ts` and `.flow` because React Native ships its style registry as
 * source plus Flow type files, and the spelling we care about can appear in
 * either — a scan of `.js` alone would miss a props definition and report a
 * comfortable zero.
 */
const READ_EXTENSIONS = [".js", ".ts", ".tsx", ".flow", ".d.ts"];

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!READ_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    yield full;
  }
}

/** How many files under `directory` contain `needle`. */
function filesContaining(directory, needle) {
  let count = 0;
  for (const file of walk(directory)) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (source.includes(needle)) count += 1;
  }
  return count;
}

// ─── Premise (a): React Native does not register the `borderInline*` spellings ───
//
// `border-s-*` / `border-e-*` compile to `borderInlineStartWidth`,
// `borderInlineStartColor` and `borderInlineStartStyle`. React Native registers
// `borderStartWidth` / `borderStartColor` / `borderStartStyle` and has never
// heard of the CSS logical spellings, so a converted class renders correctly in
// a browser and drops the border entirely on iOS and Android.

const REACT_NATIVE_LIBRARIES = join(modulesRoot, "react-native", "Libraries");

/**
 * The spelling that MUST be present, by the same walk, or the search is broken.
 *
 * This is the control that separates "React Native does not use these" from
 * "this guard read nothing at all" — the two states an absence check cannot
 * otherwise tell apart.
 */
const REACT_NATIVE_CONTROL = "borderStartWidth";

/** The spellings that must remain ABSENT while the exceptions stand. */
const BORDER_INLINE_SPELLINGS = [
  "borderInlineStartWidth",
  "borderInlineStartColor",
  "borderInlineStartStyle",
  "borderInlineEndWidth",
  "borderInlineEndColor",
  "borderInlineEndStyle",
];

if (!existsSync(REACT_NATIVE_LIBRARIES) || !statSync(REACT_NATIVE_LIBRARIES).isDirectory()) {
  failures.push(
    `Premise (a) could not be measured: ${REACT_NATIVE_LIBRARIES} is not a directory. Without it `
    + "every `borderInline*` search below returns zero, which is indistinguishable from the premise "
    + "holding. Run `bun install`, or update this path if React Native moved its style registry.",
  );
} else {
  const controlHits = filesContaining(REACT_NATIVE_LIBRARIES, REACT_NATIVE_CONTROL);
  if (controlHits === 0) {
    failures.push(
      `Premise (a)'s positive control failed: "${REACT_NATIVE_CONTROL}" was found in 0 files under `
      + `${REACT_NATIVE_LIBRARIES}. That spelling is what React Native uses INSTEAD of the CSS `
      + "logical one, so it cannot legitimately be absent — the walk, the extension filter or the "
      + "path is broken, and every absence reported below is therefore worthless.",
    );
  } else {
    notes.push(
      `premise (a) control "${REACT_NATIVE_CONTROL}" present in ${controlHits} file(s)`,
    );
    const present = BORDER_INLINE_SPELLINGS
      .map((spelling) => ({ spelling, hits: filesContaining(REACT_NATIVE_LIBRARIES, spelling) }))
      .filter((result) => result.hits > 0);

    if (present.length > 0) {
      failures.push(
        "PREMISE (a) HAS EXPIRED — and this is good news, not a regression.\n"
        + `      React Native now mentions ${present.map((r) => `${r.spelling} (${r.hits} file(s))`).join(", ")}.\n`
        + "      `border-s-*` / `border-e-*` may now survive to a device, which means the physical\n"
        + "      border entries in `KNOWN_EXCEPTIONS` (validate-rtl-logical-classes.mjs) have lost\n"
        + "      their reason. THE ACTION IS TO CONVERT, not to silence this check:\n"
        + "        1. verify on a real device build that the logical spelling renders (#429 item 2);\n"
        + "        2. convert the border classes those entries excuse;\n"
        + "        3. delete the entries — their exact counts will fail until you do;\n"
        + "        4. update this premise, or delete it if it is now permanently satisfied.",
      );
    } else {
      notes.push(`premise (a) holds — ${BORDER_INLINE_SPELLINGS.length} borderInline* spellings absent`);
    }
  }
}

// ─── Premise (b): react-native-css's `parseTextAlign` rejects `start` / `end` ───
//
// `text-start` / `text-end` compile to `text-align: start`, which
// `parseTextAlign` refuses outright — it warns and returns `undefined`, so the
// declaration is dropped and the text keeps its inherited alignment.

const DECLARATIONS = join(
  modulesRoot, "react-native-css", "dist", "commonjs", "compiler", "declarations.js",
);

/** Exactly what the allowed set must contain while the exceptions stand. */
const EXPECTED_TEXT_ALIGN = ["auto", "left", "right", "center", "justify"];

/** The logical values whose ARRIVAL would retire the `text-left` exception. */
const LOGICAL_TEXT_ALIGN = ["start", "end"];

if (!existsSync(DECLARATIONS)) {
  failures.push(
    `Premise (b) could not be measured: ${DECLARATIONS} does not exist. A missing file makes the `
    + "parse below fail closed rather than silently reporting the premise holds. Run `bun install`, "
    + "or update this path if react-native-css moved its compiler.",
  );
} else {
  const source = readFileSync(DECLARATIONS, "utf8");
  const marker = "function parseTextAlign(";
  const start = source.indexOf(marker);

  if (start === -1) {
    failures.push(
      `Premise (b) could not be measured: "${marker}" was not found in ${DECLARATIONS}. The function `
      + "was renamed, inlined or minified. Do NOT assume the premise still holds — find where "
      + "`text-align` is parsed now and re-point this check at it.",
    );
  } else {
    // Bounded to the function body: the file defines dozens of parsers and an
    // unbounded search would happily match another one's allow-list.
    const body = source.slice(start, start + 600);
    const setMatch = body.match(/new Set\(\[([^\]]*)\]\)/);

    if (!setMatch) {
      failures.push(
        "Premise (b) could not be measured: `parseTextAlign` was found but its `new Set([...])` "
        + `allow-list was not, within 600 characters of ${DECLARATIONS}. The implementation changed `
        + "shape; read it and re-point this check rather than trusting the old reading.",
      );
    } else {
      const allowed = [...setMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);

      // The control: an allow-list that parsed to nothing would report every
      // logical value absent, which is exactly the passing answer.
      if (allowed.length === 0) {
        failures.push(
          "Premise (b)'s positive control failed: `parseTextAlign`'s allow-list parsed to ZERO "
          + "values. An empty set makes the `start`/`end` check below vacuous — it would report "
          + "them absent whatever upstream does. Fix the extraction.",
        );
      } else {
        notes.push(`premise (b) control — allow-list parsed to ${allowed.length} value(s)`);

        const admitted = LOGICAL_TEXT_ALIGN.filter((value) => allowed.includes(value));
        if (admitted.length > 0) {
          failures.push(
            "PREMISE (b) HAS EXPIRED — and this is good news, not a regression.\n"
            + `      react-native-css's parseTextAlign now admits ${admitted.map((v) => `"${v}"`).join(" and ")} `
            + `(allow-list: ${allowed.map((v) => `"${v}"`).join(", ")}).\n`
            + "      `text-start` / `text-end` may now survive compilation, so the `text-left` and\n"
            + "      `text-right` entries in `KNOWN_EXCEPTIONS` have lost their reason. THE ACTION IS\n"
            + "      TO CONVERT, not to silence this check — see premise (a)'s steps.",
          );
        } else if (
          allowed.length !== EXPECTED_TEXT_ALIGN.length
          || !EXPECTED_TEXT_ALIGN.every((value) => allowed.includes(value))
        ) {
          // Neither expired nor as measured. Reported rather than passed: the
          // exception's stated reason quotes this exact set, so a set that has
          // moved for some other reason is a rationale nobody has re-read.
          failures.push(
            "Premise (b) is neither the measured set nor an expiry. `parseTextAlign` now allows "
            + `${allowed.map((v) => `"${v}"`).join(", ")}, where #428 measured `
            + `${EXPECTED_TEXT_ALIGN.map((v) => `"${v}"`).join(", ")}. `
            + "`start`/`end` are still refused so the exception still stands, but its written reason "
            + "quotes the old set. Re-read the implementation and update EXPECTED_TEXT_ALIGN.",
          );
        } else {
          notes.push(`premise (b) holds — allow-list is exactly ${allowed.join("|")}, start/end refused`);
        }
      }
    }
  }
}

// ------------------------------------------------------------------- verdict ---

if (failures.length > 0) {
  console.error("RTL upstream-premise guard failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  These premises are the REASON `KNOWN_EXCEPTIONS` in validate-rtl-logical-classes.mjs\n"
    + "  excuses fifteen physical directional utilities. That guard reconciles their counts against\n"
    + "  our own source tree and never opens node_modules, so without this check an upstream fix\n"
    + "  would leave every entry green with its justification expired.\n",
  );
  process.exit(1);
}

console.log(
  "RTL upstream-premise guard passed — "
  + `${notes.join("; ")}. `
  + "Both premises behind KNOWN_EXCEPTIONS still hold, so the fifteen physical directional "
  + "utilities remain correct. This reads what upstream SHIPS, never what a device RENDERS — "
  + "#429 item 2 is still open.",
);
