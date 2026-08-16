#!/usr/bin/env bun

/**
 * The storefront must lay out correctly in Arabic. This refuses to let a
 * PHYSICAL directional utility back into the mirrored surface.
 *
 * ## Why a guard rather than a memory
 *
 * `I18nManager.forceRTL(true)` flips flex direction and nothing else. Every
 * `ml-1`, `pr-4`, `left-4` and `border-l-2` stays exactly where it was, so a
 * screen half-mirrors: the row order reverses while the padding, the absolute
 * offsets and the badge stay on the LTR side. That is worse than not mirroring
 * at all, and it is invisible to `tsc`, to lint and to every build job — the
 * classes are valid Tailwind and the app renders.
 *
 * Issue #397 migrated `packages/frontend` and `packages/ui` to logical
 * utilities. The migration is a one-time act; keeping it is a standing
 * requirement, and the way it gets undone is one `ml-2` at a time in unrelated
 * PRs, each individually invisible. So this is a decision gate: a physical
 * utility is allowed, it just has to be a decision somebody makes on purpose and
 * writes down, by adding a reasoned `KNOWN_EXCEPTIONS` entry.
 *
 * ## Scope
 *
 * `packages/frontend` and `packages/ui` only — the storefront path #397 covers.
 * The dashboard and POS are issue #398 and are deliberately NOT scanned: a gate
 * over an unmigrated tree is one whoever hits it first disables.
 *
 * ## What "physical" means here, and what it deliberately does not match
 *
 * A directional utility is matched only when it carries a Tailwind-shaped VALUE
 * (`4`, `1.5`, `0.5`, `1/2`, `px`, `auto`, `full`, `[10px]`, `space-12`). That
 * restriction is what lets the guard run over a repository whose comments
 * describe layout in prose: `left-anchored` and `left-to-right` are real strings
 * in this tree, and a `\bleft-` matcher would fire on both. Two self-test cases
 * stand over exactly those spellings.
 *
 * Bare `border-l` / `border-r` and `text-left` / `text-right` take no value, so
 * they are matched on their own word boundary instead.
 *
 * ## The exceptions are MEASURED, not preferences
 *
 * Two logical utilities do not survive this stack, which was measured through
 * the real pipeline (tailwindcss 4.2.2 -> react-native-css 3.0.7 -> the RN
 * 0.85.3 style registry) rather than assumed:
 *
 *   * `text-start` / `text-end` compile to `text-align: start|end`, which
 *     react-native-css's `parseTextAlign` rejects outright — it allows only
 *     `auto|left|right|center|justify`. The rule is DROPPED and the compiler
 *     emits a warning nobody reads.
 *
 *   * `border-s-*` / `border-e-*` compile to `borderInlineStartWidth`,
 *     `borderInlineStartColor` and `borderInlineStartStyle`. React Native 0.85.3
 *     registers `borderStartWidth` and `borderStartColor` and has never heard of
 *     the `borderInline*` spellings (they appear nowhere under
 *     `node_modules/react-native/Libraries`). So `border-s-2` renders correctly
 *     in a browser and SILENTLY DROPS THE BORDER on iOS and Android.
 *
 * That second one is the reason #397 was not a `sed`. Converting
 * `border-l-2` to `border-s-2` would have deleted the notification priority
 * stripe and the sidebar divider on native while looking perfect on web — a
 * regression strictly worse than the mis-mirroring it was meant to fix.
 *
 * The entries below are therefore not debt to pay down by converting them; they
 * are waiting on an upstream capability. They are listed so the residual is
 * visible in the tree rather than only in a PR description.
 *
 * Usage:  bun scripts/validate-rtl-logical-classes.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tree to scan. Overridable so the self-test can point the REAL guard at a
 * scratch checkout instead of asserting against a copy of its own logic.
 */
const repositoryRoot = process.env.RTL_CLASS_VALIDATOR_ROOT
  ? resolve(process.env.RTL_CLASS_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fixture trees are a handful of files, so the real vacuity floor would fail
 * every self-test case for the wrong reason. This lowers it to 1 — it never
 * removes it, so a fixture run still catches a traversal that finds nothing.
 */
const fixtureFloors = process.env.RTL_CLASS_VALIDATOR_FIXTURE_FLOORS === "1";

/** The mirrored surface. Dashboard and POS belong to #398. */
const SCANNED_PREFIXES = ["packages/frontend/", "packages/ui/"];

const SOURCE_FILE = /\.(?:tsx?|jsx?)$/;

/**
 * A Tailwind utility value. Anything a directional utility can legitimately
 * carry in this repository, and nothing an English sentence carries.
 */
const VALUE = String.raw`(?:\d+(?:\.\d+)?(?:\/\d+)?|px|auto|full|screen|min|max|fit|\[[^\]\s]*\]|(?:space|radius)-[a-z0-9]+(?:-[a-z0-9]+)*)`;

/** Variant prefixes: `md:`, `web:`, `sm:`, `web:sm:`, `group-hover:`, … */
const VARIANTS = String.raw`(?:[\w-]+(?:\[[^\]]*\])?:)*`;

/**
 * Not preceded by a word character, dot, slash or dash — so `arrow-left-24`,
 * `tpl-name` and the second half of `left-to-right` cannot start a match.
 */
const START = String.raw`(?<![\w./-])`;

/**
 * Each rule names the logical utility that replaces it. `suggestion` is the
 * whole user-facing value of this gate: whoever trips it should not have to go
 * and look up what `pr-` becomes.
 */
const RULES = [
  {
    id: "physical-margin",
    pattern: new RegExp(`${START}${VARIANTS}-?m([lr])-${VALUE}`, "g"),
    suggestion: "use the logical margin: ml- -> ms-, mr- -> me-",
  },
  {
    id: "physical-padding",
    pattern: new RegExp(`${START}${VARIANTS}-?p([lr])-${VALUE}`, "g"),
    suggestion: "use the logical padding: pl- -> ps-, pr- -> pe-",
  },
  {
    id: "physical-inset",
    pattern: new RegExp(`${START}${VARIANTS}-?(left|right)-${VALUE}`, "g"),
    suggestion: "use the logical inset: left- -> start-, right- -> end-",
  },
  {
    id: "physical-border-side",
    pattern: new RegExp(`${START}${VARIANTS}border-([lr])(?:-[a-z0-9[\\]/.-]+|(?![\\w-]))`, "g"),
    suggestion:
      "border-s-/border-e- emit borderInline* which React Native does not support — "
      + "keep the physical class and add a reasoned KNOWN_EXCEPTIONS entry",
  },
  {
    id: "physical-text-align",
    pattern: new RegExp(`${START}${VARIANTS}text-(left|right)(?![\\w-])`, "g"),
    suggestion:
      "text-start/text-end are dropped by react-native-css — "
      + "keep the physical class and add a reasoned KNOWN_EXCEPTIONS entry",
  },
  {
    id: "physical-corner-radius",
    pattern: new RegExp(`${START}${VARIANTS}rounded-(l|r|tl|tr|bl|br)(?:-[a-z0-9[\\]/.-]+|(?![\\w-]))`, "g"),
    suggestion: "use the logical corner: rounded-l- -> rounded-s-, rounded-r- -> rounded-e-",
  },
];

/**
 * Deliberate, reasoned survivals. Each entry excuses findings in ONE file whose
 * matched text contains `pattern`.
 *
 * The list must only SHRINK: an entry that stops matching anything FAILS the
 * run, so a workaround cannot outlive the thing it worked around — the same
 * discipline `validate-no-mongo.mjs` uses, for the same reason. That property is
 * also this guard's positive control: every entry below names text that is
 * really in the tree, so a matcher that silently stopped matching turns the run
 * red instead of green.
 */
const KNOWN_EXCEPTIONS = [
  {
    file: "packages/frontend/app/(app)/notifications.tsx",
    pattern: "border-l",
    reason:
      "Notification priority stripe. border-s-2 emits borderInlineStartWidth, which RN 0.85.3 does not "
      + "register, so converting would remove the stripe entirely on native. Waiting on upstream support.",
  },
  {
    file: "packages/frontend/components/sidebar.tsx",
    pattern: "border-r",
    reason: "Sidebar divider. Same borderInline* limitation as above.",
  },
  {
    file: "packages/ui/src/components/ui/panel.tsx",
    pattern: "border-",
    reason:
      "Panel takes an explicit physical `side: 'left' | 'right'` prop and animates with translateX. "
      + "Making the panel direction-aware is an API change plus an animation change, not a class swap (#429).",
  },
  {
    file: "packages/ui/src/components/ui/sheet.tsx",
    pattern: "border-l",
    reason:
      "Sheet slides in on a physical translateX and pairs the border with rounded-l-2xl. "
      + "Mirroring it needs the animation flipped too, so the whole component moves at once (#429).",
  },
  {
    file: "packages/ui/src/components/ui/sheet.tsx",
    pattern: "rounded-l-2xl",
    reason:
      "The matching corner for the border above. rounded-s-2xl IS safe on native, but converting the radius "
      + "while the border it sits on stays physical would split one edge across two conventions (#429).",
  },
  {
    file: "packages/ui/src/components/ui/scroll-area.tsx",
    pattern: "border-l",
    reason:
      "Radix scrollbar gutter, web-only component. Same borderInline* limitation, and the scrollbar side "
      + "is decided by the browser from the document direction.",
  },
  {
    file: "packages/ui/src/components/ui/dialog.tsx",
    pattern: "text-left",
    reason:
      "react-native-css rejects text-align: start outright (parseTextAlign allows only "
      + "auto|left|right|center|justify), so text-start compiles to nothing at all.",
  },
];

/** Below this, the file listing is broken — and a broken listing reports a clean tree. */
const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 200;

/**
 * The guard cannot be its own subject: this file and its self-test both spell
 * out every physical utility they exist to catch. Neither lives under a scanned
 * prefix today, so this is belt-and-braces against someone moving them.
 */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-rtl-logical-classes.mjs",
  "scripts/test-validate-rtl-logical-classes.mjs",
]);

/** Every file git tracks, repo-relative — so ignored and generated files cannot count. */
function trackedFiles() {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed in ${repositoryRoot}: ${listed.stderr ?? listed.error}`);
  }
  return listed.stdout.split("\0").filter(Boolean);
}

const findings = [];
const failures = [];

/**
 * POSITIVE CONTROL.
 *
 * Every rule is run against a line that is KNOWN to contain what it looks for,
 * and against a line that is known NOT to. A regex that silently stopped
 * matching — a bad escape, a lost group, an editor mangling the source — would
 * otherwise report a clean tree, which is exactly what a clean tree reports.
 *
 * This runs before the scan and on every invocation, including in CI, because a
 * control that only runs in the self-test says nothing about the run that
 * actually gated the merge.
 */
const CONTROL_MUST_MATCH = {
  "physical-margin": ['<View className="ml-2 mr-4" />', '<View className="-ml-4 md:mr-1.5" />'],
  "physical-padding": ['<View className="pl-8 pr-space-12" />', '<View className="md:pl-0" />'],
  "physical-inset": ['<View className="absolute left-4 top-4" />', '<View className="-right-0.5" />'],
  "physical-border-side": ['<View className="border-l-2 border-r" />'],
  "physical-text-align": ['<View className="sm:text-left text-right" />'],
  "physical-corner-radius": ['<View className="rounded-l-2xl rounded-br-md" />'],
};

/**
 * Spellings that must NEVER fire. The first two are real prose in this tree; the
 * rest are the logical utilities the migration introduced, and a guard that
 * flagged its own remedy would be turned off within a day.
 */
const CONTROL_MUST_NOT_MATCH = [
  " * A left-anchored, brand-themed store-menu sheet mirroring Shopify's store",
  " /** Items rendered left-to-right in the horizontal scroller. */",
  '<View className="ms-1 me-2 ps-3 pe-4 ms-auto -ms-4" />',
  '<View className="absolute start-4 end-2 -end-0.5 start-space-12" />',
  '<View className="border-s-2 rounded-s-2xl text-start" />',
  'import { ArrowLeft } from "lucide-react-native";',
  '<Image source={require("../../assets/arrow-left-24.png")} />',
];

for (const rule of RULES) {
  for (const sample of CONTROL_MUST_MATCH[rule.id] ?? []) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(sample)) {
      failures.push(
        `positive control failed: rule ${rule.id} did not match ${JSON.stringify(sample)} — `
        + "the matcher is broken, and a broken matcher reports a clean tree",
      );
    }
  }
}
for (const sample of CONTROL_MUST_NOT_MATCH) {
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(sample)) {
      failures.push(
        `negative control failed: rule ${rule.id} matched ${JSON.stringify(sample)}, which is not a `
        + "physical directional utility — the matcher is too broad and would be disabled by whoever hit it",
      );
    }
  }
}

/**
 * Read a tracked file, or record WHY it could not be read and carry on.
 *
 * `git ls-files` reports the INDEX, which can name a file the working tree does
 * not have. Reading that as a FAILURE keeps the run loud rather than ending it
 * with a stack trace and no verdict.
 */
async function readTrackedFile(path) {
  try {
    return await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    failures.push(
      `${path} is tracked by git but could not be read (${error.code ?? error.message}) — `
      + "the working tree disagrees with the index, so this scan was incomplete",
    );
    return null;
  }
}

const sources = trackedFiles().filter(
  (path) =>
    SOURCE_FILE.test(path)
    && SCANNED_PREFIXES.some((prefix) => path.startsWith(prefix))
    && !GUARD_OWN_FILES.has(path),
);

for (const path of sources) {
  const text = await readTrackedFile(path);
  if (text === null) continue;

  for (const [index, line] of text.split("\n").entries()) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({
          file: path,
          line: index + 1,
          match: match[0],
          context: line.trim().slice(0, 160),
          rule: rule.id,
          suggestion: rule.suggestion,
        });
      }
    }
  }
}

// ------------------------------------------------------------- exceptions ---

const honoured = new Set();
const unexcused = findings.filter((finding) => {
  const entry = KNOWN_EXCEPTIONS.find(
    (exception) => exception.file === finding.file && finding.match.includes(exception.pattern),
  );
  if (!entry) return true;
  honoured.add(entry);
  return false;
});

for (const entry of KNOWN_EXCEPTIONS) {
  if (honoured.has(entry)) continue;
  failures.push(
    `KNOWN_EXCEPTIONS still excuses "${entry.pattern}" in ${entry.file}, which no longer matches anything. `
    + "Either the class was migrated or the file moved — delete the entry so the list keeps describing the tree.",
  );
}

// ---------------------------------------------------------- vacuity floor ---

if (sources.length < MINIMUM_SOURCE_FILES) {
  failures.push(
    `${sources.length} source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}

// ------------------------------------------------------------------ verdict ---

if (unexcused.length > 0 || failures.length > 0) {
  console.error("RTL logical-class guard failed:\n");
  for (const finding of unexcused) {
    console.error(`  ${finding.file}:${finding.line}: physical directional utility "${finding.match}"`);
    console.error(`    ${finding.context}`);
    console.error(`    ${finding.suggestion}\n`);
  }
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  The storefront ships an Arabic bundle (#396) and mirrors its layout from logical utilities (#397).\n"
    + "  A physical directional class half-mirrors the screen it is on, which no build job can see.\n",
  );
  process.exit(1);
}

console.log(
  `RTL logical-class guard passed — ${sources.length} source files scanned across `
  + `${SCANNED_PREFIXES.join(" and ")}; ${RULES.length} rules positively controlled; `
  + `${honoured.size} of ${KNOWN_EXCEPTIONS.length} known exceptions honoured.`,
);
