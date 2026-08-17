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
 * All four client packages: `packages/frontend` and `packages/ui` (the storefront
 * path, #397) plus `packages/dashboard` and `packages/pos` (#434).
 *
 * The two apps were deliberately NOT scanned until #434, because a gate over an
 * unmigrated tree is one whoever hits it first disables. They joined in the SAME
 * change that migrated them — four class conversions, measured with these very
 * regexes rather than hand-written ones — which is the only ordering that does
 * not leave a red gate sitting on somebody else's branch.
 *
 * What those two apps do NOT yet have is an `ar` bundle, so nothing in them
 * mirrors today. That is not a reason to defer the gate: the migration is what
 * decays, one `ml-2` at a time in unrelated PRs, and it decays in exactly the
 * window between the classes landing and the copy landing.
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

/** The mirrored surface: all four client packages (#397 the first two, #434 the rest). */
const SCANNED_PREFIXES = [
  "packages/frontend/",
  "packages/ui/",
  "packages/dashboard/",
  "packages/pos/",
];

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
 * matched text contains `pattern`, EXACTLY `count` times.
 *
 * The list must only SHRINK: an entry that stops matching anything FAILS the
 * run, so a workaround cannot outlive the thing it worked around — the same
 * discipline `validate-no-mongo.mjs` uses, for the same reason. That property is
 * also this guard's positive control: every entry below names text that is
 * really in the tree, so a matcher that silently stopped matching turns the run
 * red instead of green.
 *
 * ## `count` is not decoration (#448)
 *
 * Matching on file + text is a PREDICATE, not an identity. Without a count, an
 * entry excuses EVERY occurrence of its shape in its file, so a second physical
 * utility rides in behind the reasoned one — silently, in exactly the seven
 * files most likely to grow one, because they are the ones that legitimately
 * have them. Reproduced against this guard before the count existed: adding an
 * unreasoned `border-l-4 border-l-red-500` to `notifications.tsx`, whose entry
 * excuses only the priority stripe, left the run at exit 0 still printing
 * `7 of 7 known exceptions honoured` — the sentence a reader takes as proof
 * nothing slipped through.
 *
 * So the count is asserted EXACTLY, and BOTH directions fail. Higher means a new
 * violation rode in. Lower means the entry has stopped describing the tree,
 * which is how a list of exemptions decays into one nobody can audit —
 * `validate-money-formatting.mjs` is the reference implementation (#446).
 */
const KNOWN_EXCEPTIONS = [
  {
    file: "packages/frontend/app/(app)/notifications.tsx",
    pattern: "border-l",
    count: 5,
    reason:
      "Notification priority stripe: the border-l-2 WIDTH on the row, plus the four PRIORITY_COLORS "
      + "variants (red-500 / orange-400 / blue-400 / muted-foreground) that colour that one stripe. "
      + "border-s-2 emits borderInlineStartWidth and border-s-red-500 emits borderInlineStartColor, "
      + "neither of which RN 0.85.3 registers, so converting would remove the stripe entirely on "
      + "native — width and colour alike. Waiting on upstream support.",
  },
  {
    file: "packages/frontend/components/sidebar.tsx",
    pattern: "border-r",
    count: 2,
    reason:
      "Sidebar divider, once in each of the component's two return branches — collapsed (desktop rail) "
      + "and expanded. One divider, two renderings. Same borderInline* limitation as above.",
  },
  {
    file: "packages/ui/src/lib/logical-side.ts",
    pattern: "border-",
    count: 2,
    reason:
      "The divider on the inner face of a sliding surface, for BOTH Panel and Sheet, in the one function "
      + "that resolves a logical side to a physical one. TWO findings, ONE decision: the two arms of a "
      + "single ternary on the resolved direction. #429 replaced those components' physical "
      + "side prop with a logical one, so the anchor is now insetInlineStart/insetInlineEnd and the "
      + "corner is rounded-s-/rounded-e-, both of which mirror on their own. The divider cannot follow "
      + "them: the logical spellings emit borderInline*, which RN 0.85.3 does not register, so it would "
      + "vanish on native while looking right on web. Waiting on upstream support, like the storefront "
      + "entries above — and it is ONE entry rather than three because centralising it is what let the "
      + "panel.tsx and sheet.tsx entries be deleted.",
  },
  {
    file: "packages/ui/src/components/ui/scroll-area.tsx",
    pattern: "border-l",
    count: 2,
    reason:
      "Radix scrollbar gutter, web-only component: the `border-l` width and the `border-l-transparent` "
      + "colour that makes it a gutter rather than a visible rule, both on the vertical-orientation line. "
      + "Same borderInline* limitation, and the scrollbar side is decided by the browser from the "
      + "document direction.",
  },
  {
    file: "packages/dashboard/components/catalog-authoring/ReviewPanel.tsx",
    pattern: "text-right",
    count: 2,
    reason:
      "The wizard review panel's value column, right-aligned against its label. TWO findings, ONE "
      + "decision: the class on the <Text>, and the comment above it that explains why it is the "
      + "physical spelling — this guard matches on text and does not strip comments, so a docblock "
      + "naming the utility it documents counts as an occurrence. text-start is rejected outright by "
      + "react-native-css's parseTextAlign (auto|left|right|center|justify only), so the logical "
      + "spelling compiles to nothing at all. Arrived with #367 while #434 was widening this scan; "
      + "the author had already measured it and said so in that comment.",
  },
  {
    file: "packages/pos/app/(app)/index.tsx",
    pattern: "border-l",
    count: 1,
    reason:
      "The POS register's cart panel divider — `md:border-l` on the desktop-only right-hand column, "
      + "one occurrence. The single physical utility left in either app after #434's migration: the "
      + "other four findings (two ml-auto, one pr-4, one left-2) all converted. border-s emits "
      + "borderInlineStartWidth, which RN 0.85.3 does not register, so converting would drop the "
      + "divider entirely on a native till while looking correct on web. Same upstream limitation as "
      + "the storefront entries above.",
  },
  {
    file: "packages/ui/src/components/ui/dialog.tsx",
    pattern: "text-left",
    count: 1,
    reason:
      "react-native-css rejects text-align: start outright (parseTextAlign allows only "
      + "auto|left|right|center|justify), so text-start compiles to nothing at all.",
  },
];

/**
 * Below this, the file listing is broken — and a broken listing reports a clean
 * tree.
 *
 * DERIVED, not picked: the floor has to catch the silent loss of any ONE entry
 * from `SCANNED_PREFIXES` — a typo'd prefix, or a package moved without this
 * list following it. At #429 the four prefixes carry 451 source files
 * (frontend 171, ui 98, dashboard 118, pos 64), so dropping the SMALLEST of them
 * still leaves 387. A floor ABOVE that number fails on every single-prefix loss,
 * including the cheapest one to make.
 *
 * 392 keeps the same character the 200-of-266 floor had before the scope
 * widened: it catches any one prefix going missing, with ~60 files of headroom
 * so ordinary deletions do not turn it red for the wrong reason.
 *
 * RE-DERIVE IT WHEN THE TREE MOVES — IN EITHER DIRECTION — and note that it goes
 * stale in the safe-LOOKING direction, so the run stays green. Twice now, both
 * times inside the PR that moved the tree. #434 set 360 against a 422-file tree,
 * then #367 and #437 landed 30 files and 360 stopped covering the loss of
 * `packages/pos/`; it was raised to 390 against 452. #429 then added two files
 * to `packages/ui`, which put drop-the-smallest at EXACTLY 390 — and the
 * comparison is `<`, so the floor had become inert for that case while still
 * reading as a floor. The counts above were themselves re-measured after
 * rebasing behind #435a, which DELETED three storefront files: a floor derived
 * before a rebase describes the tree the author had, not the one that merges.
 */
const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 392;

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

/**
 * An entry must declare an integer `count` of at least 1, or the reconciliation
 * below silently compares against `undefined` and every entry reports a
 * mismatch it cannot explain. Checked here so the FIRST entry added without one
 * fails naming itself, rather than turning the whole list red at once.
 */
for (const entry of KNOWN_EXCEPTIONS) {
  if (Number.isInteger(entry.count) && entry.count >= 1) continue;
  failures.push(
    `KNOWN_EXCEPTIONS entry "${entry.pattern}" in ${entry.file} declares no integer count >= 1 `
    + `(got ${JSON.stringify(entry.count)}). Without one it excuses EVERY occurrence of its shape in `
    + "that file, which is the hole #448 closed — declare exactly how many findings it covers.",
  );
}

const honoured = new Map(KNOWN_EXCEPTIONS.map((entry) => [entry, 0]));
const unexcused = findings.filter((finding) => {
  const entry = KNOWN_EXCEPTIONS.find(
    (exception) => exception.file === finding.file && finding.match.includes(exception.pattern),
  );
  if (!entry) return true;
  honoured.set(entry, honoured.get(entry) + 1);
  return false;
});

for (const entry of KNOWN_EXCEPTIONS) {
  const actual = honoured.get(entry);
  if (actual === entry.count) continue;

  if (actual === 0) {
    failures.push(
      `KNOWN_EXCEPTIONS excuses "${entry.pattern}" in ${entry.file} ${entry.count} time(s), which no `
      + "longer matches anything — the count went DOWN to 0. Either the class was migrated or the file "
      + "moved: delete the entry so the list keeps describing the tree, and so its standing positive "
      + "control keeps standing.",
    );
    continue;
  }

  if (actual < entry.count) {
    failures.push(
      `KNOWN_EXCEPTIONS excuses "${entry.pattern}" in ${entry.file} ${entry.count} time(s), but only `
      + `${actual} matched — the count went DOWN. Part of what it excused is gone, so the entry has `
      + `stopped describing the tree: lower the count to ${actual}, or restore what was removed.`,
    );
    continue;
  }

  failures.push(
    `KNOWN_EXCEPTIONS excuses "${entry.pattern}" in ${entry.file} ${entry.count} time(s), but ${actual} `
    + "finding(s) matched it — the count went UP. An excusing entry is a PREDICATE, not an identity, so "
    + "a NEW physical utility of the same shape in the same file would otherwise ride in behind the "
    + "reasoned one. Fix the new occurrence, or raise the count with a reason covering it too.",
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
  + `${SCANNED_PREFIXES.join(", ")} (floor ${MINIMUM_SOURCE_FILES}); `
  + `${RULES.length} rules positively controlled; `
  + `${KNOWN_EXCEPTIONS.length} known exceptions each matched their exact declared count `
  + `(${findings.length - unexcused.length} findings excused in total).`,
);
