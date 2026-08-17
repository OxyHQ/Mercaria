#!/usr/bin/env bun

/**
 * Mutation-tests `validate-money-formatting.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail, and this one is a pile of regexes over a file listing, run
 * through a hand-written comment blanker — three things that fail QUIET. A bad
 * escape reports a clean tree. A `git ls-files` that returns nothing reports a
 * clean tree. A blanker that eats a whole file reports a clean tree. An excusing
 * entry that covers more than it says reports a clean tree. Every case below
 * breaks exactly one of those and requires the guard to fail with the words that
 * identify the right cause.
 *
 * The cases that must PASS matter as much as the ones that must fail. The four
 * scanned packages are full of legitimate `.amount` reads — sums, comparisons,
 * percentage arithmetic, object literals handed straight to a formatter — and a
 * guard that fired on those would be disabled by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 *
 * This is the COMMITTED half of the mutation evidence. The other half was run
 * against the real working tree (reintroduce one bypass, confirm RED naming file
 * and line, restore, confirm GREEN, with every mutation proved applied by diff
 * before its exit code was believed) and is reported in the PR body. That run is
 * what found the `KNOWN_EXCEPTIONS` over-count hole the `count` field now
 * closes — case "an excusing entry cannot cover a SECOND occurrence" below.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-money-formatting.mjs");

/**
 * Run the REAL guard against a scratch checkout.
 *
 * `realFloors` runs it with the production vacuity floors, which is the only way
 * to see the file-count floor fire; every other case relaxes them, since a
 * fixture tree of four files would otherwise fail for a reason that has nothing
 * to do with money.
 */
async function runAgainst(files, { realFloors = false, removeAfterAdd = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "money-format-validator-"));
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

    const environment = { ...process.env, MONEY_FORMAT_VALIDATOR_ROOT: root };
    if (!realFloors) environment.MONEY_FORMAT_VALIDATOR_FIXTURE_FLOORS = "1";

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
 * A tree whose money rendering all goes through the chokepoint.
 *
 * It carries one file per live `KNOWN_EXCEPTIONS` entry, holding the text that
 * entry excuses — so every case below also exercises the exception path, and the
 * guard's "the list must only shrink, at its exact count" check has something to
 * be satisfied by. The stale- and over-count cases are the trees that
 * deliberately change them.
 *
 * THIS IS COUPLED TO THE LIVE LIST ON PURPOSE: the self-test then proves the
 * real exceptions match real text, rather than proving a synthetic list matches
 * synthetic text. Adding an entry to the guard means adding its file here, and
 * forgetting turns every case below red with a message naming the entry.
 */
function cleanTree(extra = {}) {
  return {
    // The three `packages/ui/src/lib/format.ts` entries: the chokepoint's own
    // `1234.00 RON` return, and the two un-localized fallbacks `formatNumber`
    // degrades to when the runtime refuses an Intl option (#500).
    //
    // Note what this file no longer contains: a `${major.toFixed(2)}` inside a
    // template. That WAS `formatMoney` before #500 and is now a `formatNumber`
    // call, so modelling it here would be this fixture asserting against a
    // version of the chokepoint that no longer exists.
    "packages/ui/src/lib/format.ts":
      "export function formatSourceMoney(money) {\n"
      + "  return `${figure} ${money.currency}`;\n"
      + "}\n"
      + "const kmFallback = () => `${kilometres.toFixed(1)} km`;\n"
      + "const pctFallback = () => `${(magnitude / BASIS_POINTS_PER_PERCENT).toFixed(1)}%`;\n",
    // KNOWN_EXCEPTIONS[1] — the target-price TextInput prefill.
    "packages/frontend/app/(app)/price-alerts.tsx":
      "const prefill = (suggested.amount / 10 ** precision).toFixed(precision);\n"
      + "export const A = () => <Text>{formatMoney(suggested)}</Text>;\n",
    // The legitimate shapes the scanned packages are full of.
    "packages/ui/src/components/clean.tsx":
      "export const B = () => <PriceDisplay price={{ amount: p.amount, currency: c }} />;\n"
      + "export const C = () => <Text>{formatMoney(price)}</Text>;\n"
      + "export const D = () => <Text>Price published in {price.currency}</Text>;\n"
      + "const cheapest = (a, b) => a.price.amount - b.price.amount;\n"
      + "const free = (d) => d.cost.amount === 0;\n"
      + "const off = Math.round((1 - p.price.amount / p.compareAtPrice.amount) * 100);\n"
      + "const total = groups.reduce((acc, g) => acc + g.subtotal.amount, 0);\n",
    ...extra,
  };
}

const cases = [
  {
    name: "a tree that formats its money passes",
    files: cleanTree(),
    expectExit: 0,
    expectOutput: "Money-formatting guard passed",
  },

  // --------------------------------------------------- the mutation cases ---
  // Each reintroduces exactly ONE bypass and must be caught by name.

  {
    name: "a raw {price.amount} JSX child fails",
    files: cleanTree({
      "packages/ui/src/components/regressed.tsx":
        "export const E = () => <Text>{price.amount} {price.currency}</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: "raw-amount-jsx-child",
  },
  {
    name: "a raw ${lowestPrice.amount} template interpolation fails",
    files: cleanTree({
      "packages/ui/src/components/regressed.tsx":
        "export const F = () => <Text>{`${lowestPrice.amount} ${lowestPrice.currency}`}</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: "raw-amount-template",
  },
  {
    name: "an OPTIONALLY CHAINED total?.amount fails",
    // The guard's own positive control caught this while the matcher only
    // accepted `.`; `total?.amount` is how an optional money field is read here,
    // so a matcher that missed it would report a bypass as clean.
    files: cleanTree({
      "packages/ui/src/components/regressed.tsx":
        "export const G = () => <Text>{rows[0].total?.amount}</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: "raw-amount-jsx-child",
  },
  {
    name: "a hand-rolled minor-unit conversion fails",
    files: cleanTree({
      "packages/ui/src/components/regressed.tsx":
        "export const H = () => <Text>{(price.amount / 100).toFixed(2)}</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: "hand-rolled-minor-units",
  },
  {
    name: "a raw .toFixed() decimal reaching a reader fails, with no .amount in sight",
    // The shape `ReviewSummaryCard` carried until #500: a rating rendered with
    // `toFixed` in the SAME template as a localized review count, so a German
    // reader saw `10.300 unverified · 4.5`. No rule here could see it — every
    // other one keys on `.amount` or on a currency, and a rating is neither.
    files: cleanTree({
      "packages/ui/src/components/marketplace/regressed.tsx":
        "export const Summary = ({ average, unverified }) => (\n"
        + "  <Text>{average.toFixed(1)}</Text>\n"
        + ");\n",
    }),
    expectExit: 1,
    expectOutput: "raw-decimal-render",
  },
  {
    name: "a .toFixed() that is NOT on its way to a reader does not fire",
    // The discriminator is the brace. A parseable prefill and an intermediate
    // value are not this rule's business — a rule that flagged them would be
    // turned off by whoever hit it.
    files: cleanTree({
      "packages/ui/src/components/marketplace/intermediate.tsx":
        "const ratio = (a, b) => (a / b).toFixed(2);\n"
        + "export const E = () => <Text>{formatRating(score)}</Text>;\n",
    }),
    expectExit: 0,
    expectOutput: "Money-formatting guard passed",
  },
  {
    name: "a bare number rendered beside a currency fails, even with no .amount in sight",
    // The shape `families/[handle].tsx` used: the value had already been through
    // a parameter, so nothing named `.amount` appeared on the line at all.
    files: cleanTree({
      "packages/frontend/components/regressed.tsx":
        "function formatPrice(amount, currency) {\n"
        + "  return isKnown(currency) ? formatMoney({ amount, currency }) : `${amount} ${currency}`;\n"
        + "}\n",
    }),
    expectExit: 1,
    expectOutput: "amount-beside-currency",
  },
  {
    name: "the dashboard and the POS ARE in scope",
    // Deliberately unlike validate-rtl-logical-classes.mjs, which excludes them
    // pending #398. Both were measured clean for money before this gate was
    // scoped, so including them costs nothing — and narrowing to the packages
    // that happened to be broken is the version that reads as coverage.
    files: cleanTree({
      "packages/dashboard/app/index.tsx": "export const I = () => <Text>{total.amount}</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: "packages/dashboard/app/index.tsx",
  },

  // ------------------------------------------------ the must-NOT-fire cases ---

  {
    name: "prose describing the bug does NOT fire",
    files: cleanTree({
      "packages/ui/src/components/documented.tsx":
        "/**\n * Never render {price.amount} {price.currency} here — `.amount` is minor units,\n"
        + " * so `${p.amount}` prints 12345 for 123.45. Use formatMoney instead.\n */\n"
        + "// Also not this: {money.amount} and (money.amount / 100).toFixed(2)\n"
        + "export const J = () => <Text>{formatMoney(price)}</Text>;\n",
    }),
    expectExit: 0,
    expectOutput: "Money-formatting guard passed",
  },
  {
    name: "passing .amount as a PROP does NOT fire",
    files: cleanTree({
      "packages/ui/src/components/props.tsx":
        "export const K = () => <Gauge value={price.amount} max={cap.amount} />;\n"
        + "export const L = () => <Row amount={<PriceDisplay price={totals.subtotal} />} />;\n",
    }),
    expectExit: 0,
    expectOutput: "Money-formatting guard passed",
  },
  {
    name: "a URL in a string does not open a comment and hide the rest of the file",
    // The comment blanker is string-aware; if it were not, `//` inside this URL
    // would blank the bypass below it and the guard would pass.
    files: cleanTree({
      "packages/ui/src/components/urls.tsx":
        'const endpoint = "https://api.example.test/rates";\n'
        + "export const M = () => <Text>{price.amount}</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: "raw-amount-jsx-child",
  },
  {
    name: "the backend is out of scope and does NOT fire",
    files: cleanTree({
      "packages/backend/src/render.ts": "export const N = () => `${total.amount} ${currency}`;\n",
    }),
    expectExit: 0,
    expectOutput: "Money-formatting guard passed",
  },
  {
    name: "a non-source file in a scanned package does NOT fire",
    files: cleanTree({
      "packages/ui/src/notes.md": "Never write `{price.amount} {price.currency}` in a card.\n",
      "packages/frontend/fixtures/prices.json": '{ "amount": 12345, "currency": "EUR" }\n',
    }),
    expectExit: 0,
    expectOutput: "Money-formatting guard passed",
  },

  // ------------------------------------------------------ the meta failures ---

  {
    name: "a stale KNOWN_EXCEPTIONS entry fails the run",
    // No exception files at all, so every live entry matches nothing.
    files: {
      "packages/ui/src/components/clean.tsx":
        "export const O = () => <Text>{formatMoney(price)}</Text>;\n"
        + "const t = a.price.amount - b.price.amount;\n",
    },
    expectExit: 1,
    expectOutput: "no longer matches anything",
  },
  {
    name: "an excusing entry cannot cover a SECOND occurrence in the same file",
    // The hole the real-tree mutation run found: file+rule+text is a PREDICATE,
    // not an identity, so a new bypass of the same shape in the excused file
    // used to ride in silently behind the reasoned one.
    files: cleanTree({
      "packages/frontend/app/(app)/price-alerts.tsx":
        "const prefill = (suggested.amount / 10 ** precision).toFixed(precision);\n"
        + "const shown = `Best right now: ${(suggested.amount / 10 ** precision).toFixed(precision)}`;\n",
    }),
    expectExit: 1,
    expectOutput: "but 2 finding(s) matched it",
  },
  {
    name: "a broken file listing cannot pass silently (file-count floor)",
    files: cleanTree(),
    realFloors: true,
    expectExit: 1,
    expectOutput: "below the 250 floor",
  },
  {
    name: "a corpus with no `.amount` at all cannot report clean (subject floor)",
    // The floor that matters most: a file count proves files were read, not that
    // the thing being looked for was present to be found. Fixing bypasses can
    // never erode this one — `.amount` stays in the tree in every legitimate
    // position, so a floor on it is not a floor its own remedy pushes to zero.
    files: {
      "packages/ui/src/components/moneyless.tsx":
        "export const P = () => <Text>{formatMoney(price)}</Text>;\n",
    },
    expectExit: 1,
    expectOutput: "could not SEE the thing it exists to look for",
  },
  {
    name: "a corpus with no formatter calls cannot report clean (surface floor)",
    files: {
      "packages/ui/src/lib/format.ts":
        "export function render(money) {\n"
        + "  return `${major.toFixed(2)} ${money.currency}`;\n"
        + "}\n",
      "packages/frontend/app/(app)/price-alerts.tsx":
        "const prefill = (suggested.amount / 10 ** precision).toFixed(precision);\n",
    },
    expectExit: 1,
    expectOutput: "does not contain the money-rendering surface",
  },
  {
    name: "a tracked file the working tree lost is a loud failure, not a stack trace",
    files: cleanTree({
      "packages/ui/src/components/vanished.tsx":
        "export const Q = () => <Text>{formatMoney(price)}</Text>;\n",
    }),
    removeAfterAdd: ["packages/ui/src/components/vanished.tsx"],
    expectExit: 1,
    expectOutput: "could not be read",
  },
];

/**
 * The guard's own controls run on every invocation, so they are already
 * exercised by every case above. This asserts the SOURCE still carries them — a
 * control that got deleted would otherwise leave every case green, since none of
 * them depends on the controls existing.
 */
async function assertGuardSource() {
  const source = await readFile(validator, "utf8");
  const required = [
    "CONTROL_MUST_MATCH",
    "CONTROL_MUST_NOT_MATCH",
    "BLANKER_CASES",
    "positive control failed",
    "negative control failed",
    "comment-blanker control failed",
    "MINIMUM_AMOUNT_SIGHTINGS",
    "MINIMUM_FORMATTER_SIGHTINGS",
  ];
  const missing = required.filter((token) => !source.includes(token));
  if (missing.length > 0) {
    return `guard source no longer carries ${missing.join(", ")} — its self-controls were removed`;
  }
  if (!/count:\s*\d+/.test(source)) {
    return "guard source no longer declares an exact `count` per exception — an excusing entry "
      + "without one covers every occurrence of its shape in its file";
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
