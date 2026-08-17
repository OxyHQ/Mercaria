#!/usr/bin/env bun

/**
 * Mutation-tests `validate-rtl-logical-classes.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail, and this one is a pile of regexes over a file listing —
 * both of which fail QUIET. A bad escape reports a clean tree. A `git ls-files`
 * that returns nothing reports a clean tree. A prefix filter that matches no
 * path reports a clean tree. Every case below breaks exactly one thing and
 * requires the guard to fail with the words that identify the right rule.
 *
 * The cases that must PASS matter as much as the ones that must fail. This
 * repository describes layout in prose — `left-anchored` and `left-to-right`
 * are both real strings in the migrated tree — and a guard that fired on either
 * would be disabled by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-rtl-logical-classes.mjs");

/**
 * Run the REAL guard against a scratch checkout.
 *
 * `realFloors` runs it with the production vacuity floor, which is the only way
 * to see that floor fire; every other case relaxes it, since a fixture tree of
 * three files would otherwise fail for a reason that has nothing to do with RTL.
 */
async function runAgainst(files, { realFloors = false, removeAfterAdd = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rtl-class-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    // Deleted AFTER `git add`, so the path stays in the index while the working
    // tree loses it — a real divergence (a half-applied checkout, an interrupted
    // rebase) and the only way to reach the unreadable-file branch.
    for (const path of removeAfterAdd) await rm(join(root, path), { force: true });

    const environment = { ...process.env, RTL_CLASS_VALIDATOR_ROOT: root };
    if (!realFloors) environment.RTL_CLASS_VALIDATOR_FIXTURE_FLOORS = "1";

    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A migrated tree.
 *
 * It carries one file per live `KNOWN_EXCEPTIONS` entry, holding the text that
 * entry excuses AT ITS EXACT DECLARED COUNT — so every case below also exercises
 * the exception path, and the guard's "the list must only shrink, at its exact
 * count" check has something to be satisfied by. The stale-, over- and
 * under-count cases are the trees that deliberately change them.
 *
 * THIS IS COUPLED TO THE LIVE LIST ON PURPOSE: the self-test then proves the
 * real exceptions match real text, rather than proving a synthetic list matches
 * synthetic text. Adding an entry to the guard — or changing a count — means
 * changing this fixture, and forgetting turns every case below red with a
 * message naming the entry and the direction it moved.
 */
function migratedTree(extra = {}) {
  return {
    "packages/frontend/components/clean.tsx":
      'export const A = () => <View className="ms-1 me-2 ps-3 pe-4 ms-auto -ms-4" />;\n'
      + 'export const B = () => <View className="absolute start-4 end-2 -end-0.5 start-space-12" />;\n'
      + 'export const C = () => <View className="rounded-s-2xl md:ps-0 web:end-space-12" />;\n',
    "packages/ui/src/components/prose.tsx":
      "/** A left-anchored, brand-themed store-menu sheet mirroring Shopify's store */\n"
      + "/** Items rendered left-to-right in the horizontal scroller. */\n"
      + 'import { ArrowLeft } from "lucide-react-native";\n'
      + "export const D = () => <ArrowLeft />;\n",
    // One file per KNOWN_EXCEPTIONS entry, at the entry's exact declared count.
    // `border-l` x5: the stripe WIDTH plus its four PRIORITY_COLORS variants.
    "packages/frontend/app/(app)/notifications.tsx":
      "const PRIORITY = { urgent: 'border-l-red-500', high: 'border-l-orange-400',\n"
      + "  normal: 'border-l-blue-400', low: 'border-l-muted-foreground' };\n"
      + 'export const E = () => <View className="border-b border-border border-l-2" />;\n',
    // `border-r` x2: one divider, rendered in the collapsed and expanded branches.
    "packages/frontend/components/sidebar.tsx":
      'export const F1 = () => <View className="h-full border-r border-border" />;\n'
      + 'export const F2 = () => <View className="h-full w-full border-r border-border" />;\n',
    // `border-` x4: one two-armed ternary, written in the desktop and mobile branches.
    "packages/ui/src/components/ui/panel.tsx":
      'export const G1 = (side) => side === "right" ? "border-l border-border" : "border-r border-border";\n'
      + 'export const G2 = (side) => side === "right" ? "border-l border-border" : "border-r border-border";\n',
    "packages/ui/src/components/ui/sheet.tsx":
      'export const H = () => <View className="border-l border-border rounded-l-2xl" />;\n',
    // `border-l` x2: the gutter width and its transparent colour, on one line.
    "packages/ui/src/components/ui/scroll-area.tsx":
      'export const I = () => <View className="h-full w-2.5 border-l border-l-transparent" />;\n',
    "packages/ui/src/components/ui/dialog.tsx":
      "export const J = () => <View className={cn('flex-col gap-2 text-center sm:text-left')} />;\n",
    // `border-l` x1 (#434): the POS cart-panel divider, the one physical utility
    // left in either app after the migration. `md:border-border` deliberately
    // sits beside it — it is NOT a border SIDE, so a rule that matched it would
    // push this entry's count to 2 and fail.
    "packages/pos/app/(app)/index.tsx":
      'export const Z = () => <View className="hidden md:flex md:border-l md:border-border" />;\n',
    // `text-right` x2 (#434, arrived with #367): ONE decision, two matches — the
    // class, and the comment explaining why it is the physical spelling. This
    // guard does not strip comments, so the fixture carries both or the count
    // cannot be reproduced.
    "packages/dashboard/components/catalog-authoring/ReviewPanel.tsx":
      "// `text-right` and not `text-end`: parseTextAlign rejects the logical one.\n"
      + 'export const Z2 = () => <Text className="flex-1 text-right text-sm" />;\n',
    ...extra,
  };
}

const cases = [
  {
    name: "a fully migrated tree passes",
    files: migratedTree(),
    expectExit: 0,
    expectOutput: "RTL logical-class guard passed",
  },

  // --------------------------------------------------- the mutation cases ---
  // Each reintroduces exactly ONE physical utility and must be caught by name.

  {
    name: "a reintroduced ml-2 fails",
    files: migratedTree({
      "packages/frontend/components/regressed.tsx":
        'export const K = () => <View className="ml-2 flex-row" />;\n',
    }),
    expectExit: 1,
    expectOutput: 'physical directional utility "ml-2"',
  },
  {
    name: "a reintroduced pr-4 fails",
    files: migratedTree({
      "packages/ui/src/components/regressed.tsx":
        'export const L = () => <View className="py-2 pr-4" />;\n',
    }),
    expectExit: 1,
    expectOutput: 'physical directional utility "pr-4"',
  },
  {
    name: "a reintroduced absolute left-4 fails",
    files: migratedTree({
      "packages/frontend/components/regressed.tsx":
        'export const M = () => <View className="absolute left-4 top-4" />;\n',
    }),
    expectExit: 1,
    expectOutput: 'physical directional utility "left-4"',
  },
  {
    name: "a negative -right-0.5 fails",
    files: migratedTree({
      "packages/frontend/components/regressed.tsx":
        'export const N = () => <View className="absolute -right-0.5 -top-0.5" />;\n',
    }),
    expectExit: 1,
    expectOutput: "-right-0.5",
  },
  {
    name: "a variant-prefixed md:pl-0 fails",
    files: migratedTree({
      "packages/ui/src/components/regressed.tsx":
        'export const O = () => <View className="min-w-0 flex-1 md:p-2 md:pl-0" />;\n',
    }),
    expectExit: 1,
    expectOutput: "md:pl-0",
  },
  {
    name: "a custom-token pl-space-12 fails",
    files: migratedTree({
      "packages/ui/src/components/regressed.tsx":
        'export const P = () => <View className="gap-space-8 pl-space-12" />;\n',
    }),
    expectExit: 1,
    expectOutput: "pl-space-12",
  },
  {
    name: "a physical corner radius rounded-tl-lg fails",
    files: migratedTree({
      "packages/ui/src/components/regressed.tsx":
        'export const Q = () => <View className="rounded-tl-lg" />;\n',
    }),
    expectExit: 1,
    expectOutput: "rounded-tl-lg",
  },
  {
    name: "a border side in a file with no exception fails",
    files: migratedTree({
      "packages/ui/src/components/regressed.tsx":
        'export const R = () => <View className="border-l-2 border-border" />;\n',
    }),
    expectExit: 1,
    expectOutput: "border-l-2",
  },
  {
    name: "a text-left in a file with no exception fails",
    files: migratedTree({
      "packages/ui/src/components/regressed.tsx":
        'export const S = () => <View className="text-left" />;\n',
    }),
    expectExit: 1,
    expectOutput: "text-left",
  },

  // ------------------------------------------------ the must-NOT-fire cases ---

  {
    name: "prose describing layout does NOT fire",
    files: migratedTree({
      "packages/ui/src/components/more-prose.tsx":
        "/**\n * The drawer is left-anchored and reads left-to-right; the right-hand rail\n"
        + " * stays put. Nothing here is a class name.\n */\nexport const T = () => null;\n",
    }),
    expectExit: 0,
    expectOutput: "RTL logical-class guard passed",
  },
  {
    name: "an icon import and an asset path do NOT fire",
    files: migratedTree({
      "packages/frontend/components/icons.tsx":
        'import { ArrowLeft, ChevronRight } from "lucide-react-native";\n'
        + 'const a = require("../../assets/arrow-left-24.png");\n'
        + "export const U = () => <ArrowLeft />;\n",
    }),
    expectExit: 0,
    expectOutput: "RTL logical-class guard passed",
  },
  {
    name: "a physical utility in the DASHBOARD fails (#434 widened the scope)",
    // Was the inverse case until #434: the dashboard used to be out of scope and
    // this tree had to PASS. Kept as two separate cases rather than one covering
    // both apps, because a widening that added only ONE of the two prefixes
    // would leave a single combined case green on the half it did add.
    files: migratedTree({
      "packages/dashboard/app/index.tsx":
        'export const V = () => <View className="ml-2 pl-4 absolute left-0 text-left" />;\n',
    }),
    expectExit: 1,
    expectOutput: 'packages/dashboard/app/index.tsx:1: physical directional utility "ml-2"',
  },
  {
    name: "a physical utility in the POS fails (#434 widened the scope)",
    files: migratedTree({
      "packages/pos/app/index.tsx":
        'export const W = () => <View className="mr-2 pr-4 absolute right-0" />;\n',
    }),
    expectExit: 1,
    expectOutput: 'packages/pos/app/index.tsx:1: physical directional utility "mr-2"',
  },
  {
    name: "a non-source file in the scanned tree does NOT fire",
    files: migratedTree({
      "packages/ui/src/theme/notes.md": "Use `ml-2` and `left-4` here to explain the old convention.\n",
      "packages/frontend/global.css": ".legacy { margin-left: 4px; }\n",
    }),
    expectExit: 0,
    expectOutput: "RTL logical-class guard passed",
  },

  // ------------------------------------------------------ the meta failures ---

  {
    name: "a stale KNOWN_EXCEPTIONS entry fails the run",
    // No exception files at all, so every live entry matches nothing.
    files: {
      "packages/frontend/components/clean.tsx":
        'export const X = () => <View className="ms-1 me-2 ps-3 pe-4" />;\n',
    },
    expectExit: 1,
    expectOutput: "no longer matches anything",
  },
  {
    name: "an excusing entry cannot cover a SECOND occurrence in the same file",
    // The #448 hole. file + text is a PREDICATE, not an identity, so an
    // unreasoned physical utility in an EXCUSED file used to ride in silently
    // behind the reasoned one — leaving the run at exit 0 still printing
    // "7 of 7 known exceptions honoured", the sentence a reader takes as proof
    // nothing slipped through. Every other case here is blind to it, because
    // they all add their violation to a file with NO exception.
    files: migratedTree({
      "packages/frontend/app/(app)/notifications.tsx":
        "const PRIORITY = { urgent: 'border-l-red-500', high: 'border-l-orange-400',\n"
        + "  normal: 'border-l-blue-400', low: 'border-l-muted-foreground' };\n"
        + 'export const E = () => <View className="border-b border-border border-l-2" />;\n'
        + 'export const E2 = () => <View className="border-l-4 border-l-red-500" />;\n',
    }),
    expectExit: 1,
    expectOutput: "the count went UP",
  },
  {
    name: "an entry that stops covering ONE of several occurrences fails as a DECREASE",
    // The other direction, and it must not be reported as the one above: a
    // decrease means the list has stopped describing the tree, and telling that
    // reader to go and find "a new violation" sends them looking for something
    // that is not there. The sidebar renders its one divider in two branches;
    // this tree keeps only the collapsed one.
    files: migratedTree({
      "packages/frontend/components/sidebar.tsx":
        'export const F1 = () => <View className="h-full border-r border-border" />;\n',
    }),
    expectExit: 1,
    expectOutput: "the count went DOWN",
  },
  {
    name: "the DECREASE names the file and the number to lower the count to",
    // A guard that failed with "exception mismatch" would send the next person
    // to read this script instead of their own diff.
    files: migratedTree({
      "packages/frontend/components/sidebar.tsx":
        'export const F1 = () => <View className="h-full border-r border-border" />;\n',
    }),
    expectExit: 1,
    expectOutput: 'excuses "border-r" in packages/frontend/components/sidebar.tsx 2 time(s), but only 1',
  },
  {
    name: "a broken file listing cannot pass silently (vacuity floor)",
    files: migratedTree(),
    realFloors: true,
    expectExit: 1,
    // Tracks MINIMUM_SOURCE_FILES deliberately: #434 widened the scope to four
    // packages and re-derived the floor from them (390, above the 388 that would
    // survive losing the smallest prefix), so a floor edited without a reason
    // fails here rather than passing quietly at a number nobody chose.
    expectOutput: "below the 390 floor",
  },
  {
    name: "a tracked file the working tree lost is a loud failure, not a stack trace",
    files: migratedTree({
      "packages/frontend/components/vanished.tsx": 'export const Y = () => <View className="ms-1" />;\n',
    }),
    removeAfterAdd: ["packages/frontend/components/vanished.tsx"],
    expectExit: 1,
    expectOutput: "could not be read",
  },
];

/**
 * The guard's own positive/negative controls run on every invocation, so they
 * are already exercised by every case above. This asserts the SOURCE still
 * carries them — a control that got deleted would otherwise leave every case
 * green, since none of them depends on the controls existing.
 */
async function assertGuardSource() {
  const source = await readFile(validator, "utf8");
  const required = [
    "CONTROL_MUST_MATCH",
    "CONTROL_MUST_NOT_MATCH",
    "positive control failed",
    "negative control failed",
  ];
  const missing = required.filter((token) => !source.includes(token));
  if (missing.length > 0) {
    return `guard source no longer carries ${missing.join(", ")} — its self-controls were removed`;
  }
  if (!/count:\s*\d+/.test(source)) {
    return "guard source no longer declares an exact `count` per exception — an excusing entry "
      + "without one covers every occurrence of its shape in its file (#448)";
  }
  if (!source.includes("the count went UP") || !source.includes("the count went DOWN")) {
    return "guard source no longer names the DIRECTION a count moved — a failure reading "
      + "\"exception mismatch\" sends the next reader to this script instead of their own diff";
  }
  return null;
}

let failed = 0;

for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files, {
    realFloors: testCase.realFloors,
    removeAfterAdd: testCase.removeAfterAdd,
  });

  const problems = [];
  if (exitCode !== testCase.expectExit) {
    problems.push(`expected exit ${testCase.expectExit}, got ${exitCode}`);
  }
  if (!output.includes(testCase.expectOutput)) {
    problems.push(`expected output to contain ${JSON.stringify(testCase.expectOutput)}`);
  }

  if (problems.length > 0) {
    failed += 1;
    console.error(`FAIL  ${testCase.name}`);
    for (const problem of problems) console.error(`        ${problem}`);
    console.error(`        --- guard output ---\n${output.replace(/^/gm, "        ")}`);
  } else {
    console.log(`ok    ${testCase.name}`);
  }
}

const sourceProblem = await assertGuardSource();
if (sourceProblem) {
  failed += 1;
  console.error(`FAIL  the guard keeps its own controls\n        ${sourceProblem}`);
} else {
  console.log("ok    the guard keeps its own controls");
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 1} guard cases failed.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length + 1} guard cases passed.`);
