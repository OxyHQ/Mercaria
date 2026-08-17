#!/usr/bin/env bun

/**
 * Mutation-tests `validate-authoring-schema-driven.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail, and this one fails QUIET in three separate ways: a
 * `git ls-files` that returns nothing reports a clean tree, a prefix filter
 * matching no path reports a clean tree, and a detector whose AST shape stopped
 * matching reports a clean tree. Every POSITIVE case below breaks exactly one
 * thing, asserts the break LANDED in the fixture, and requires the guard to
 * fail with the words that identify the right wall.
 *
 * The NEGATIVE cases matter as much. This guard runs over the code that
 * implements the thing it protects, and that code legitimately does almost
 * exactly what the detectors look for: it switches on the schema's own closed
 * vocabularies, and it asks whether an id is in a set built from the schema at
 * runtime. A rule that fired on either would be flagging the correct
 * implementation, and the first person to hit it would switch the guard off.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORING_FINDING_PATH_COUNT } from "./validate-authoring-schema-driven.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-authoring-schema-driven.mjs");

const AUTHORING_DIR = "packages/dashboard/lib/authoring";
const WIZARD_DIR = "packages/dashboard/components/catalog-authoring";
const BUNDLE = "packages/dashboard/lib/i18n/locales/en.json";

/**
 * A fixture bundle carrying the keys the negative controls resolve.
 *
 * Wall 2 subtracts real translation keys, so a control asserting that
 * `t('products.wizard.fields.required')` does NOT fire needs that key to exist
 * — otherwise the control would pass for the wrong reason.
 */
const FIXTURE_BUNDLE = JSON.stringify({
  products: {
    wizard: {
      fields: { required: "Required", storage: "Storage" },
      steps: { details: "Details" },
    },
  },
});

/** Enough authoring files to clear the subtree floor under fixture floors. */
function baseTree(extra = {}) {
  return {
    [BUNDLE]: FIXTURE_BUNDLE,
    [`${AUTHORING_DIR}/answers.ts`]: "export const answers = 1;\n",
    [`${WIZARD_DIR}/SchemaField.tsx`]: "export const field = 1;\n",
    "packages/dashboard/lib/other.ts": "export const other = 1;\n",
    ...extra,
  };
}

/** Run the REAL guard against a scratch checkout. */
async function runAgainst(files, { realFloors = false, removeAfterAdd = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "authoring-schema-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    // Deleted AFTER `git add`, so the path stays in the index while the working
    // tree loses it — a real divergence (a half-applied checkout, an
    // interrupted rebase) and the only way to reach the unreadable-file branch.
    for (const path of removeAfterAdd) await rm(join(root, path), { force: true });

    const environment = { ...process.env, AUTHORING_VALIDATOR_ROOT: root };
    if (!realFloors) environment.AUTHORING_VALIDATOR_FIXTURE_FLOORS = "1";

    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode,
      output: `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
let failed = false;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
}

/**
 * A case the guard MUST refuse.
 *
 * `mutationMarker` is asserted present in the fixture before the guard runs —
 * a mutation that never applied is indistinguishable from one that survived,
 * and both look like a passing test here.
 */
async function mustFail(name, files, { expect, mutationMarker, ...options }) {
  const source = Object.values(files).join("\n");
  if (mutationMarker !== undefined && !source.includes(mutationMarker)) {
    record(name, false, `the mutation never landed: ${mutationMarker} is not in the fixture`);
    return;
  }
  const { code, output } = await runAgainst(files, options);
  if (code === 0) {
    record(name, false, "the guard PASSED a tree it must refuse");
    return;
  }
  if (!output.includes(expect)) {
    record(name, false, `refused, but for the wrong reason. Wanted ${expect}\n${output}`);
    return;
  }
  record(name, true);
}

/** A case the guard MUST accept. */
async function mustPass(name, files, options = {}) {
  const { code, output } = await runAgainst(files, options);
  record(name, code === 0, code === 0 ? undefined : output);
}

// ------------------------------------------------------- wall 1: branching ---

await mustFail(
  "a comparison against a concept key fails",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "export function render(field: { key: string }) {\n" +
      "  if (field.key === 'storage_capacity') return 1;\n" +
      "  return 0;\n}\n",
  }),
  { expect: "concept-branch", mutationMarker: "field.key === 'storage_capacity'" },
);

await mustFail(
  "the SAME comparison through an in-file constant fails",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "const SMARTPHONE = 'electronic_phone_key';\n" +
      "export function render(attributeKey: string) {\n" +
      "  return attributeKey === SMARTPHONE;\n}\n",
  }),
  { expect: "concept-branch", mutationMarker: "attributeKey === SMARTPHONE" },
);

await mustFail(
  "a switch over a concept key fails",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "export function render(field: { attributeKey: string }) {\n" +
      "  switch (field.attributeKey) {\n    case 'colour':\n      return 1;\n" +
      "    default:\n      return 0;\n  }\n}\n",
  }),
  { expect: "concept-branch", mutationMarker: "case 'colour'" },
);

await mustFail(
  "membership over a hardcoded field list fails",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "const SMARTPHONE_FIELDS = ['storage_capacity', 'screen_size'];\n" +
      "export function render(field: { key: string }) {\n" +
      "  return SMARTPHONE_FIELDS.includes(field.key);\n}\n",
  }),
  { expect: "concept-branch", mutationMarker: "SMARTPHONE_FIELDS.includes(field.key)" },
);

await mustFail(
  "membership over an inline Set of values fails",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "export function render(field: { key: string }) {\n" +
      "  return new Set(['colour', 'size']).has(field.key);\n}\n",
  }),
  { expect: "concept-branch", mutationMarker: "new Set(['colour', 'size']).has(field.key)" },
);

await mustFail(
  "a prefix test on a concept key fails",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "export function render(productTypeKey: string) {\n" +
      "  return productTypeKey.startsWith('electronic');\n}\n",
  }),
  { expect: "concept-branch", mutationMarker: "productTypeKey.startsWith('electronic')" },
);

// -------------------------------------------------- wall 2: namespaced keys ---

await mustFail(
  "a namespaced concept key parked in a constant fails",
  baseTree({
    [`${AUTHORING_DIR}/keys.ts`]: "export const TYPE = 'electronics.phones.smartphones';\n",
  }),
  { expect: "namespaced-key", mutationMarker: "electronics.phones.smartphones" },
);

// ---------------------------------------------- walls 3 and 4: the payload ---

await mustFail(
  "a hardcoded attribute key in a payload fails",
  baseTree({
    [`${AUTHORING_DIR}/compose.ts`]:
      "export const payload = { attributeKey: 'storage_capacity', values: [] };\n",
  }),
  { expect: "hardcoded-identity", mutationMarker: "attributeKey: 'storage_capacity'" },
);

await mustFail(
  "a hardcoded controlled-value id in a payload fails",
  baseTree({
    [`${AUTHORING_DIR}/compose.ts`]: "export const answer = { enumValueId: 'black' };\n",
  }),
  { expect: "hardcoded-identity", mutationMarker: "enumValueId: 'black'" },
);

await mustFail(
  "a TRANSLATED label sent as identity fails",
  baseTree({
    [`${AUTHORING_DIR}/compose.ts`]:
      "export function compose(t: (key: string) => string) {\n" +
      "  return { attributeKey: t('products.wizard.fields.storage'), values: [] };\n}\n",
  }),
  {
    expect: "label-as-identity",
    mutationMarker: "attributeKey: t('products.wizard.fields.storage')",
  },
);

// ------------------------------------------------ the traversal itself ------

await mustFail(
  "a broken file listing cannot pass silently (whole-tree floor)",
  { [BUNDLE]: FIXTURE_BUNDLE },
  { expect: "the file listing is broken", realFloors: true },
);

await mustFail(
  "an authoring tree that vanished cannot pass silently (subtree floor)",
  {
    [BUNDLE]: FIXTURE_BUNDLE,
    "packages/dashboard/lib/other.ts": "export const other = 1;\n",
  },
  { expect: "this guard is measuring nothing" },
);

await mustFail(
  "a tracked file the working tree lost is a loud failure",
  baseTree({ [`${AUTHORING_DIR}/render.ts`]: "export const render = 1;\n" }),
  {
    expect: "tracked but unreadable",
    removeAfterAdd: [`${AUTHORING_DIR}/render.ts`],
  },
);

await mustFail(
  "a missing en.json is a loud failure, not a silent wall-2 bypass",
  {
    [`${AUTHORING_DIR}/answers.ts`]: "export const answers = 1;\n",
    [`${WIZARD_DIR}/SchemaField.tsx`]: "export const field = 1;\n",
    "packages/dashboard/lib/other.ts": "export const other = 1;\n",
  },
  { expect: "wall 2 cannot tell a concept key from copy" },
);

// ------------------------------------------------ negative controls ---------

await mustPass(
  "switching on the schema's own value type does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "export function render(field: { validation: { valueType: string } }) {\n" +
      "  switch (field.validation.valueType) {\n" +
      "    case 'boolean':\n      return 1;\n" +
      "    case 'enum':\n      return 2;\n" +
      "    default:\n      return 0;\n  }\n}\n",
  }),
);

await mustPass(
  "comparing a requirement, a scope or a cardinality does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/render.ts`]:
      "export function render(field: { requirement: string; scope: string }) {\n" +
      "  if (field.requirement === 'required') return 1;\n" +
      "  if (field.scope === 'variant') return 2;\n" +
      "  return 0;\n}\n",
  }),
);

await mustPass(
  "membership against a set built from the SCHEMA does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/check.ts`]:
      "export function check(\n" +
      "  controlled: Set<string>,\n" +
      "  axisKeys: Set<string>,\n" +
      "  entry: { enumValueId: string },\n" +
      "  field: { key: string },\n" +
      ") {\n" +
      "  if (!controlled.has(entry.enumValueId)) return 1;\n" +
      "  if (!axisKeys.has(field.key)) return 2;\n" +
      "  return 0;\n}\n",
  }),
);

await mustPass(
  "a payload composed from the field does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/compose.ts`]:
      "export function compose(field: { key: string }, values: unknown[]) {\n" +
      "  return { attributeKey: field.key, values };\n}\n",
  }),
);

await mustPass(
  "a real translation key does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/copy.ts`]:
      "export const REQUIRED = 'products.wizard.fields.required';\n" +
      "export const DETAILS = 'products.wizard.steps.details';\n",
  }),
);

await mustPass(
  "ADR 0007 D10's validation paths do NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/paths.ts`]:
      "export function step(path: string) {\n" +
      "  if (path === 'listing.title') return 1;\n" +
      "  if (path === 'classification.categoryId') return 2;\n" +
      "  return 0;\n}\n",
  }),
);

await mustPass(
  "a dotted storage key OUTSIDE the wizard's tree does NOT fire",
  baseTree({
    "packages/dashboard/lib/themePersistence.ts":
      "export const KEY = 'mercaria.dashboard.bloom.theme';\n",
  }),
);

await mustPass(
  "comparing bare row ids does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/rows.ts`]:
      "export function same(row: { id: string }, other: { id: string }) {\n" +
      "  return row.id === other.id;\n}\n",
  }),
);

await mustPass(
  "an import specifier that looks like a namespaced key does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/imports.ts`]: "import 'expo.router.shim';\nexport const x = 1;\n",
  }),
);

// ------------------------------------------- the exemption list is BOUNDED ---

record(
  "the validation-path exemption list has an exact, asserted size",
  AUTHORING_FINDING_PATH_COUNT === 6,
  `AUTHORING_FINDING_PATHS holds ${AUTHORING_FINDING_PATH_COUNT}, expected 6. ` +
    "Wall 2 subtracts every one of them by name, so a list that grew silently is a hole. " +
    "Adding one is a decision: state why the new path cannot be told from a concept key.",
);

// ---------------------------------------------------------------- report ----

for (const { name, ok, detail } of results) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${detail}`);
}
const passed = results.filter((entry) => entry.ok).length;
console.log(
  failed
    ? `\n${results.length - passed} of ${results.length} guard cases FAILED.`
    : `\nAll ${results.length} guard cases passed.`,
);
process.exit(failed ? 1 : 0);
