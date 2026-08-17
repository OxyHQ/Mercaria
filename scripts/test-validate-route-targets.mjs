#!/usr/bin/env bun

/**
 * Mutation-tests `validate-route-targets.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail, and this one is a route walker, a comment blanker and an
 * expression scanner over a file listing — four things that fail QUIET. A walker
 * that matched no directory reports a clean tree. A blanker that ate a whole
 * file reports a clean tree. A scanner that stopped recognising `router.push`
 * reports a clean tree. A matcher that says yes to everything reports a clean
 * tree. Every case below breaks exactly one of those and requires the guard to
 * fail with the words that identify the right cause.
 *
 * The cases that must PASS matter as much as the ones that must fail. These apps
 * are full of legitimate targets a careless guard would fire on — an
 * interpolated query string, an explicit `(app)` group segment, a static asset
 * on a lowercase `<link>`, a path built inside a ternary — and a guard that
 * reported those would be deleted by whoever hit it first.
 *
 * The LAST case is the one that matters most: it mutates a REAL call site in the
 * REAL working tree, proves the mutation applied by diffing before believing any
 * exit code, requires the guard to go red naming that file and line, restores,
 * and requires it to go green again. A fixture tree can only ever prove the
 * guard works on a fixture tree.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-route-targets.mjs");

let failures = 0;

function report(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}`);
  if (detail) console.error(`       ${detail.split("\n").join("\n       ")}`);
}

/** Run the REAL guard against a scratch checkout. */
async function runAgainst(files, { realFloors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "route-target-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root });
    spawnSync("git", ["add", "-A", "-f"], { cwd: root });

    const env = { ...process.env, ROUTE_TARGET_VALIDATOR_ROOT: root };
    if (!realFloors) env.ROUTE_TARGET_VALIDATOR_FIXTURE_FLOORS = "1";

    const proc = spawnSync("bun", [validator], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { exitCode: proc.status, output: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A minimal but REAL three-app tree: a dynamic route sitting above a deeper
 * static one, which is the exact shape that defeats `tsc`.
 */
function cleanTree(extra = {}) {
  return {
    "packages/frontend/app/(app)/index.tsx": "export default function Home() { return null; }\n",
    "packages/frontend/app/(app)/products/[id].tsx": "export default function P() { return null; }\n",
    "packages/frontend/app/(app)/products/wizard/[draftId].tsx":
      "export default function W() { return null; }\n",
    "packages/frontend/app/(app)/checkout.tsx": "export default function C() { return null; }\n",
    "packages/frontend/components/Nav.tsx":
      "export function Nav() {\n"
      + "  const router = useRouter();\n"
      + "  return <Button onPress={() => router.push(`/products/${id}`)} />;\n"
      + "}\n",

    "packages/dashboard/app/(app)/index.tsx": "export default function D() { return null; }\n",
    "packages/dashboard/app/(app)/orders/[id].tsx": "export default function O() { return null; }\n",
    "packages/dashboard/components/Rows.tsx":
      "export function Rows() {\n"
      + "  const router = useRouter();\n"
      + "  return <Row onPress={() => router.push(`/orders/${order.id}`)} />;\n"
      + "}\n",

    "packages/pos/app/(app)/index.tsx": "export default function R() { return null; }\n",
    "packages/pos/app/(app)/receipt/[id].tsx": "export default function Rc() { return null; }\n",
    "packages/pos/components/Sales.tsx":
      "export function Sales() {\n"
      + "  const router = useRouter();\n"
      + "  return <Row onPress={() => router.push({ pathname: '/receipt/[id]', params: { id } })} />;\n"
      + "}\n",
    ...extra,
  };
}

console.log("validate-route-targets self-test\n");

// ------------------------------------------------------------ must PASS ---

{
  const { exitCode, output } = await runAgainst(cleanTree());
  report("a clean three-app tree passes", exitCode === 0, output);
}

{
  // The discriminator for the case below: the CORRECT spelling of the same shape
  // must pass, or the failure there would be about the shape rather than the typo.
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Deep.tsx":
        "const go = () => router.push(`/products/wizard/${draft.id}`);\n",
    }),
  );
  report("a correct deep template target passes", exitCode === 0, output);
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Query.tsx":
        "const go = () => router.push(`/checkout?${query.toString()}`);\n",
    }),
  );
  report("an interpolated QUERY on a real route passes", exitCode === 0, output);
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Group.tsx":
        "const go = () => router.push('/(app)/checkout');\n",
    }),
  );
  report("an explicit (app) group segment passes", exitCode === 0, output);
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/app/+html.tsx":
        "export default function Root() {\n"
        + "  return <link rel=\"icon\" href=\"/icon-192.png\" />;\n"
        + "}\n",
    }),
  );
  report("a static asset href in the web HTML shell passes", exitCode === 0, output);
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Seo.tsx":
        "export const Seo = () => <link rel=\"canonical\" href=\"/not-a-route-at-all\" />;\n",
    }),
  );
  report("a lowercase <link> href is not read as a route", exitCode === 0, output);
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Commented.tsx":
        "// const dead = () => router.push(`/prodcuts/${id}`);\n"
        + "/* router.push('/also-not-real') */\n"
        + "export const A = () => null;\n",
    }),
  );
  report("a commented-out dead target is not a finding", exitCode === 0, output);
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Helper.tsx":
        "const go = () => router.push(buildHref('products', id));\n",
    }),
  );
  report("a non-literal argument is unresolvable, not a failure", exitCode === 0, output);
}

// ------------------------------------------------------------ must FAIL ---

{
  // THE BUG THIS GUARD EXISTS FOR. `/products/[id]` sits above `wizard`, so tsc
  // absorbs the typo and exits 0. Measured, on the real dashboard.
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Deep.tsx":
        "const go = () => router.push(`/products/wizrd/${draft.id}`);\n",
    }),
  );
  report(
    "a deep-segment typo under a dynamic route FAILS (the #456 case)",
    exitCode === 1 && output.includes("packages/frontend/components/Deep.tsx"),
    output,
  );
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/First.tsx":
        "const go = () => router.push(`/prodcuts/${id}`);\n",
    }),
  );
  report(
    "a first-segment typo FAILS",
    exitCode === 1 && output.includes("packages/frontend/components/First.tsx"),
    output,
  );
}

{
  // The gap a census found in the first version: only the value immediately
  // after `(` was read, so both branches of a conditional went unchecked.
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Ternary.tsx":
        "const go = () => router.push(orderId ? `/orders/${orderId}` : '/ordrs');\n",
    }),
  );
  report(
    "a dead target in the SECOND branch of a ternary FAILS",
    exitCode === 1 && output.includes("packages/frontend/components/Ternary.tsx"),
    output,
  );
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Card.tsx":
        "export const Card = () => <Link href=\"/nowhere-at-all\">go</Link>;\n",
    }),
  );
  report(
    "a capitalised <Link href> to a dead route FAILS",
    exitCode === 1 && output.includes("packages/frontend/components/Card.tsx"),
    output,
  );
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Obj.tsx":
        "const go = () => router.push({ pathname: '/products/wizrd/[draftId]', params: {} });\n",
    }),
  );
  report(
    "an object-form pathname to a dead route FAILS",
    exitCode === 1 && output.includes("packages/frontend/components/Obj.tsx"),
    output,
  );
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/components/Renamed.tsx":
        "const nav = useRouter();\nconst go = () => nav.push('/nowhere');\n",
    }),
  );
  report(
    "binding useRouter() to another name FAILS rather than going unscanned",
    exitCode === 1 && output.includes("Renamed.tsx"),
    output,
  );
}

{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/ui/src/components/Bad.tsx":
        "const go = () => router.push('/products/1');\n",
    }),
  );
  report(
    "a navigation call inside the shared ui package FAILS",
    exitCode === 1 && output.includes("packages/ui"),
    output,
  );
}

{
  // An app whose tree vanished. The per-app floor is what must catch this, and
  // it is the assertion that cannot rot as the other apps grow.
  const tree = cleanTree();
  delete tree["packages/pos/app/(app)/index.tsx"];
  delete tree["packages/pos/app/(app)/receipt/[id].tsx"];
  delete tree["packages/pos/components/Sales.tsx"];
  const { exitCode, output } = await runAgainst(tree);
  report(
    "an app contributing no files FAILS its per-app floor by name",
    exitCode === 1 && output.includes("pos"),
    output,
  );
}

{
  // The one case that runs the PRODUCTION floors, so the global vacuity net is
  // seen to fire rather than assumed to.
  const { exitCode, output } = await runAgainst(cleanTree(), { realFloors: true });
  report(
    "the real global floors fire on a tree far too small",
    exitCode === 1 && output.includes("below the floor"),
    output,
  );
}

// ------------------------------------------- the exemption list is disciplined ---

{
  const source = readFileSync(validator, "utf8");
  const match = /const KNOWN_EXCEPTIONS = \[([\s\S]*?)\];/.exec(source);
  const body = match ? match[1].trim() : null;
  report(
    "KNOWN_EXCEPTIONS is empty, and adding one means adding a case here",
    body === "",
    "The list is empty on this branch because all three trees resolve clean. If you have added an "
    + "entry, add a fixture case above that proves it excuses exactly what it claims and no more — "
    + "an excusing entry is a predicate, not an identity. An entry must never be the way a genuinely "
    + "dead route is made green.",
  );
}

// ------------------------------------- THE REAL TREE, mutated and restored ---

/**
 * Everything above runs against fixtures, and a fixture can only prove the guard
 * works on a fixture. This mutates a REAL navigation call in the REAL working
 * tree.
 *
 * The site is FOUND rather than hardcoded: a file and line number written down
 * here would rot into a test that mutates a comment and proves nothing. The
 * mutation is proved applied by comparing bytes before the exit code is
 * believed, and the restore is verified byte-for-byte, in a `finally` so an
 * assertion failure cannot leave the tree dirty.
 */
{
  const candidates = spawnSync(
    "git",
    [
      "grep", "-l", "-E", "router\\.(push|replace)\\(`/",
      "--", "packages/frontend", "packages/dashboard", "packages/pos",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const file = (candidates.stdout ?? "").split("\n").filter(Boolean)[0];

  if (!file) {
    report(
      "a real template-literal call site exists to mutate",
      false,
      "Found none. Either every target has moved to the object form — in which case delete this "
      + "case deliberately — or the search stopped matching, in which case this whole case has been "
      + "silently asserting nothing.",
    );
  } else {
    const full = resolve(repositoryRoot, file);
    const original = readFileSync(full, "utf8");
    // Mutate the LAST static segment of the first template target in the file.
    const site = /router\.(?:push|replace)\(`(\/[A-Za-z0-9\-_/]*\/)\$\{/.exec(original);

    if (!site) {
      report(
        "the real call site has a static prefix to mutate",
        false,
        `${file} matched the file search but not the prefix pattern — the two have drifted apart, `
        + "so this case is measuring nothing.",
      );
    } else {
      const prefix = site[1];
      const segments = prefix.split("/").filter(Boolean);
      const mutatedPrefix = `/${[
        ...segments.slice(0, -1),
        `${segments[segments.length - 1]}-mercaria-not-a-route`,
      ].join("/")}/`;
      const mutated = original.replace(`\`${prefix}\${`, `\`${mutatedPrefix}\${`);
      const line = original.slice(0, site.index).split("\n").length;

      try {
        writeFileSync(full, mutated);

        // PROVE the mutation applied before believing any exit code.
        const onDisk = readFileSync(full, "utf8");
        if (onDisk === original) {
          report(
            "the real-tree mutation applied",
            false,
            `${file} is byte-identical after the write — the replacement matched nothing, and a `
            + "mutation that never applied is indistinguishable from one that survived.",
          );
        } else {
          const red = spawnSync("bun", [validator], {
            cwd: repositoryRoot,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          });
          const output = `${red.stdout ?? ""}${red.stderr ?? ""}`;
          report(
            `the real tree goes RED when ${file}:${line} is mistyped`,
            red.status === 1 && output.includes(file) && output.includes(`:${line}`),
            `exit ${red.status}; expected a failure naming ${file}:${line}\n${output}`,
          );
        }
      } finally {
        writeFileSync(full, original);
      }

      const restored = readFileSync(full, "utf8");
      report(`${file} is restored byte-for-byte`, restored === original);

      const green = spawnSync("bun", [validator], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      report(
        "the real tree is GREEN again after the restore",
        green.status === 0,
        `${green.stdout ?? ""}${green.stderr ?? ""}`,
      );
    }
  }
}

console.log("");
if (failures > 0) {
  console.error(`validate-route-targets self-test: ${failures} case(s) failed.\n`);
  process.exit(1);
}
console.log("validate-route-targets self-test passed.\n");
