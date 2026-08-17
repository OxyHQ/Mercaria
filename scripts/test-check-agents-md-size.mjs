#!/usr/bin/env bun

/**
 * Mutation-tests `check-agents-md-size.mjs`.
 *
 * A budget gate is the easiest kind to leave inert: every part of it is a file
 * listing or a byte count, and both fail QUIET. A broken `git ls-files` reports
 * a clean tree. A regex with a typo reports a clean tree. A budget nobody is
 * near reports a clean tree forever, including after somebody has deleted the
 * comparison.
 *
 * Each case below breaks exactly one thing and requires the gate to fail with
 * the words that identify the right rule. The cases that must PASS matter as
 * much: this repository's prose names issue numbers constantly, on purpose, and
 * a gate that fired on body text would be disabled by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the gate's actual file
 * listing runs rather than a stand-in for it.
 *
 * ## Why some fixtures are deliberately NOT ASCII
 *
 * Every fixture here was once pure ASCII — `"#".repeat(20 * 1024)`,
 * `"x".repeat(10 * 1024)` — and on pure ASCII `Buffer.byteLength(s, "utf8")` and
 * `s.length` return the same number. So the one line the gate's correctness
 * rests on was the one line no case could see: a "simplification" to `.length`
 * passed all of them while quietly raising the real budget. The straddling
 * fixtures below are under budget by CHARACTERS and over it by BYTES, so the two
 * measures give opposite verdicts and the gate has to pick the right one.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NESTED_BUDGET_BYTES,
  ROOT_BUDGET_BYTES,
  checkAgentsMdSize,
  issueHeadings,
} from "./check-agents-md-size.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;

function report(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

/** Build a scratch checkout and run the REAL gate against it. */
async function runAgainst(files, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "agents-md-budget-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    try {
      return { result: await checkAgentsMdSize({ root, ...options }) };
    } catch (error) {
      return { error };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const withinBudget = "# Mercaria\n\nA rule.\n";

console.log("check-agents-md-size self-test\n");

// --- the vacuity floors -----------------------------------------------------

{
  const { error } = await runAgainst({ "README.md": "no instructions here\n" });
  report(
    "floor: a tree with no AGENTS.md is a FAILURE, not a clean scan",
    Boolean(error) && /found NO tracked AGENTS\.md/.test(error.message),
    error ? error.message : "the gate returned success",
  );
}

{
  const { error } = await runAgainst({ "packages/backend/AGENTS.md": withinBudget });
  report(
    "floor: a tree whose ROOT AGENTS.md is missing is a FAILURE",
    Boolean(error) && /root AGENTS\.md is not in the tracked file listing/.test(error.message),
    error ? error.message : "the gate returned success",
  );
}

// --- the size rule ----------------------------------------------------------

{
  const { result } = await runAgainst({ "AGENTS.md": withinBudget });
  report(
    "a small root AGENTS.md passes",
    result?.failures.length === 0,
    result ? result.failures.join("; ") : "threw",
  );
}

{
  const { result } = await runAgainst({ "AGENTS.md": "#".repeat(20 * 1024) + "\n" });
  report(
    "an over-budget root AGENTS.md fails, naming the budget",
    result?.failures.length === 1 && /over its 12 KB budget/.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // The nested budget is a DIFFERENT number and must actually be applied: a gate
  // that used the root budget everywhere would pass this.
  const { result } = await runAgainst({
    "AGENTS.md": withinBudget,
    "packages/backend/AGENTS.md": "x".repeat(10 * 1024) + "\n",
  });
  report(
    "a nested AGENTS.md is held to the SMALLER budget",
    result?.failures.length === 1 &&
      /packages\/backend\/AGENTS\.md/.test(result.failures[0]) &&
      /over its 8 KB budget/.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // Same bytes, root path: proves the previous case failed on the BUDGET rather
  // than on the size alone. 10 KB sits strictly between the two budgets, which
  // is what makes the pair a discriminator at all.
  const { result } = await runAgainst({ "AGENTS.md": "x".repeat(10 * 1024) + "\n" });
  report(
    "control: the same 10 KB passes at the ROOT path",
    result?.failures.length === 0,
    result ? result.failures.join("; ") : "threw",
  );
}

// --- bytes, not characters --------------------------------------------------

/**
 * A file that is UNDER `budget` by character count and OVER it by byte count.
 *
 * The gap is not hypothetical and it is not small. Measured on the live root
 * `AGENTS.md` at `4b30d5a2`: 12241 bytes against 12190 characters — 22 em-dashes
 * at three bytes each, 5 middle-dots and an en-dash — so the two measures differ
 * by 51 bytes while only 47 bytes remain under the 12288 ceiling. The em-dash is
 * this repository's own house punctuation, so that gap widens with ordinary
 * editing rather than needing anybody to do something unusual.
 */
function straddlesBudgetInBytesOnly(budget) {
  const emDashes = 64; // U+2014: one character, THREE bytes.
  return `${"—".repeat(emDashes)}${"x".repeat(budget - 32 - emDashes)}\n`;
}

{
  // The positive control on the INPUT, not on the gate. A fixture that stopped
  // straddling — because a budget moved, or because somebody "tidied" the
  // em-dashes out — would let the two cases below pass under EITHER measure,
  // which is exactly the vacuity they exist to remove.
  const rootFixture = straddlesBudgetInBytesOnly(ROOT_BUDGET_BYTES);
  const nestedFixture = straddlesBudgetInBytesOnly(NESTED_BUDGET_BYTES);
  const straddles = (contents, budget) =>
    contents.length < budget && Buffer.byteLength(contents, "utf8") > budget;
  report(
    "fixture control: both multi-byte fixtures are UNDER budget by characters and OVER it by bytes",
    straddles(rootFixture, ROOT_BUDGET_BYTES) && straddles(nestedFixture, NESTED_BUDGET_BYTES),
    `root ${rootFixture.length} chars / ${Buffer.byteLength(rootFixture, "utf8")} bytes vs ${ROOT_BUDGET_BYTES}; ` +
      `nested ${nestedFixture.length} chars / ${Buffer.byteLength(nestedFixture, "utf8")} bytes vs ${NESTED_BUDGET_BYTES}`,
  );
}

{
  const { result } = await runAgainst({
    "AGENTS.md": straddlesBudgetInBytesOnly(ROOT_BUDGET_BYTES),
  });
  report(
    "a root AGENTS.md over budget only in BYTES fails — a .length measure would pass it",
    result?.failures.length === 1 && /over its 12 KB budget/.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // The nested budget separately: the two budgets are two comparisons, and a
  // measure swapped in one of them is the likelier edit.
  const { result } = await runAgainst({
    "AGENTS.md": withinBudget,
    "packages/backend/AGENTS.md": straddlesBudgetInBytesOnly(NESTED_BUDGET_BYTES),
  });
  report(
    "a NESTED AGENTS.md over budget only in BYTES fails too",
    result?.failures.length === 1 &&
      /packages\/backend\/AGENTS\.md/.test(result.failures[0]) &&
      /over its 8 KB budget/.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // Control: multi-byte content is not itself the offence. Same characters, far
  // fewer of them, so the BYTE count lands under budget. Without this, the two
  // cases above would also be satisfied by a gate that had simply learned to
  // dislike em-dashes.
  const contents = `${"—".repeat(64)}${"x".repeat(64)}\n`;
  const { result } = await runAgainst({ "AGENTS.md": contents });
  report(
    "control: multi-byte content whose BYTES are under budget passes",
    Buffer.byteLength(contents, "utf8") < ROOT_BUDGET_BYTES && result?.failures.length === 0,
    result ? result.failures.join("; ") : "threw",
  );
}

// --- the per-issue-heading rule --------------------------------------------

{
  const { result } = await runAgainst({
    "AGENTS.md": "# Mercaria\n\n## The unified offer model (#57, ADR 0002)\n\nprose\n",
  });
  report(
    "a per-issue HEADING fails and says where it goes",
    result?.failures.length === 1 &&
      /per-issue heading/.test(result.failures[0]) &&
      /docs\//.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  const { result } = await runAgainst({
    "AGENTS.md": "# Mercaria\n\n## Offers\n\n#57 owns the offer row; see docs/commerce-graph.md (#55, #58).\n",
  });
  report(
    "an issue number in BODY prose passes",
    result?.failures.length === 0,
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // A one-digit "#1" in a heading is far likelier to be a step number or an
  // anchor than an issue, so the rule requires two digits. Pin that boundary,
  // or a later tightening breaks headings nobody meant to forbid.
  report(
    "a one-digit '#1' in a heading does not fire; '#57' does",
    issueHeadings("## Step #1\n").length === 0 && issueHeadings("## Offers (#57)\n").length === 1,
  );
}

// --- the real repository ----------------------------------------------------

{
  const { result, error } = await checkAgentsMdSize({ root: repositoryRoot })
    .then((result) => ({ result }))
    .catch((error) => ({ error }));
  report(
    "the real repository is within budget",
    !error && result?.failures.length === 0,
    error ? error.message : result?.failures.join("\n       "),
  );
}

console.log("");
if (failed > 0) {
  console.error(`${failed} self-test case(s) FAILED.`);
  process.exit(1);
}
console.log("All self-test cases passed.");
