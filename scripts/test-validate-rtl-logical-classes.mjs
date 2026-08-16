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
 * entry excuses — so every case below also exercises the exception path, and the
 * guard's "the list must only shrink" check has something to be satisfied by.
 * The stale-exception case is the one tree that deliberately omits them.
 *
 * THIS IS COUPLED TO THE LIVE LIST ON PURPOSE: the self-test then proves the
 * real exceptions match real text, rather than proving a synthetic list matches
 * synthetic text. Adding an entry to the guard means adding its file here, and
 * forgetting turns every case below red with a message naming the entry.
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
    // One file per KNOWN_EXCEPTIONS entry, carrying the excused text.
    "packages/frontend/app/(app)/notifications.tsx":
      "const priority = { urgent: 'border-l-red-500' };\n"
      + 'export const E = () => <View className="border-b border-border border-l-2" />;\n',
    "packages/frontend/components/sidebar.tsx":
      'export const F = () => <View className="h-full border-r border-border" />;\n',
    "packages/ui/src/components/ui/panel.tsx":
      'export const G = (side) => side === "right" ? "border-l border-border" : "border-r border-border";\n',
    "packages/ui/src/components/ui/sheet.tsx":
      'export const H = () => <View className="border-l border-border rounded-l-2xl" />;\n',
    "packages/ui/src/components/ui/scroll-area.tsx":
      'export const I = () => <View className="h-full w-2.5 border-l border-l-transparent" />;\n',
    "packages/ui/src/components/ui/dialog.tsx":
      "export const J = () => <View className={cn('flex-col gap-2 text-center sm:text-left')} />;\n",
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
    name: "the dashboard and POS are out of scope and do NOT fire (#398)",
    files: migratedTree({
      "packages/dashboard/app/index.tsx":
        'export const V = () => <View className="ml-2 pl-4 absolute left-0 border-l-2 text-left" />;\n',
      "packages/pos/app/index.tsx":
        'export const W = () => <View className="mr-2 pr-4 absolute right-0" />;\n',
    }),
    expectExit: 0,
    expectOutput: "RTL logical-class guard passed",
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
    name: "a broken file listing cannot pass silently (vacuity floor)",
    files: migratedTree(),
    realFloors: true,
    expectExit: 1,
    expectOutput: "below the 200 floor",
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
