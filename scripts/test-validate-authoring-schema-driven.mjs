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
import { KNOWN_FINDING_PATH_EXCEPTION_COUNT } from "./validate-authoring-schema-driven.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-authoring-schema-driven.mjs");

const AUTHORING_DIR = "packages/dashboard/lib/authoring";
const WIZARD_DIR = "packages/dashboard/components/catalog-authoring";
const BUNDLE = "packages/dashboard/lib/i18n/locales/en.json";

// The shared tree #478 added to this guard's population. A fixture has to carry
// a file and a bundle in it, or every case fails on that tree's own floor
// instead of on the wall it is testing — which is itself the floor working, and
// is asserted directly by its own case below.
const UI_DIR = "packages/ui/src/components/marketplace";
const UI_BUNDLE = "packages/ui/src/i18n/locales/en.json";

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

/**
 * The two reasoned validation-path exceptions, reproduced so that a fixture
 * which is supposed to PASS satisfies the both-directions reconciliation.
 *
 * Spreading this into every passing case is not boilerplate — it IS the
 * reconciliation working. Without it each `mustPass` below would fail on two
 * unmatched entries, which is precisely the behaviour that stops the list
 * rotting into one nobody can audit.
 *
 * The path and the content both matter: the entries are scoped to
 * `lib/authoring/findings.ts`, so the same literals at another path are NOT
 * excused, and a case below asserts exactly that.
 */
function exceptionFixture() {
  return {
    [`${AUTHORING_DIR}/findings.ts`]:
      "export function parseFindingPath(path: string) {\n" +
      "  if (path === 'listing.title') return { kind: 'listing', field: 'title' };\n" +
      "  if (path === 'listing.description') return { kind: 'listing', field: 'description' };\n" +
      "  return { kind: 'unknown' };\n" +
      "}\n",
  };
}

/** Enough authoring files to clear the subtree floor under fixture floors. */
function baseTree(extra = {}) {
  return {
    [BUNDLE]: FIXTURE_BUNDLE,
    [UI_BUNDLE]: FIXTURE_BUNDLE,
    [`${AUTHORING_DIR}/answers.ts`]: "export const answers = 1;\n",
    [`${WIZARD_DIR}/SchemaField.tsx`]: "export const field = 1;\n",
    "packages/dashboard/lib/other.ts": "export const other = 1;\n",
    [`${UI_DIR}/PriceDisplay.tsx`]: "export const price = 1;\n",
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
  // BOTH bundles are present deliberately: without one the guard exits earlier on
  // the unreadable bundle, which is a correct refusal for a DIFFERENT reason. It
  // was one bundle until #478 widened the population to two.
  "a broken file listing cannot pass silently (whole-tree floor)",
  { [BUNDLE]: FIXTURE_BUNDLE, [UI_BUNDLE]: FIXTURE_BUNDLE },
  { expect: "the file listing is broken", realFloors: true },
);

await mustFail(
  "an authoring tree that vanished cannot pass silently (subtree floor)",
  {
    [BUNDLE]: FIXTURE_BUNDLE,
    [UI_BUNDLE]: FIXTURE_BUNDLE,
    "packages/dashboard/lib/other.ts": "export const other = 1;\n",
  },
  { expect: "this guard is measuring nothing" },
);

// #478. THE case for the widening, and it is a floor case rather than a wall
// case because the failure it describes is silent: a full dashboard clears a
// scanned floor of 60 on its own, so ONE total would have let `packages/ui/src`
// vanish from the population with the guard still printing a pass. Only a
// PER-TREE floor can tell "the shared tree is clean" from "the shared tree is
// not being read". The fixture is a complete, passing dashboard with the shared
// tree removed.
await mustFail(
  "a full dashboard with NO shared ui tree fails that tree's own floor",
  {
    [BUNDLE]: FIXTURE_BUNDLE,
    [UI_BUNDLE]: FIXTURE_BUNDLE,
    [`${AUTHORING_DIR}/answers.ts`]: "export const answers = 1;\n",
    ...Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `packages/dashboard/lib/file${String(index)}.ts`,
        "export const value = 1;\n",
      ]),
    ),
  },
  { expect: "source files under packages/ui/src/", realFloors: true },
);

// The shared tree is really READ, not merely counted. `packages/ui/src` had no
// authoring gate before #478, so without a case like this "no findings there"
// and "that tree is not being scanned" print the same line.
await mustFail(
  "a concept branch in the shared ui tree is refused, not only one in the dashboard",
  baseTree({
    [`${UI_DIR}/AttributeRow.tsx`]:
      "export function render(attribute: { name: string }) {\n" +
      '  return attribute.name === "colour" ? 1 : 0;\n' +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: 'attribute.name === "colour"' },
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
    ...exceptionFixture(),
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
    ...exceptionFixture(),
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
    ...exceptionFixture(),
  }),
);

await mustPass(
  "a payload composed from the field does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/compose.ts`]:
      "export function compose(field: { key: string }, values: unknown[]) {\n" +
      "  return { attributeKey: field.key, values };\n}\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "a real translation key does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/copy.ts`]:
      "export const REQUIRED = 'products.wizard.fields.required';\n" +
      "export const DETAILS = 'products.wizard.steps.details';\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "the two reasoned validation paths do NOT fire in the file that owns them",
  baseTree({ ...exceptionFixture() }),
);

/**
 * The positive control on the DELETION (#494 finding 4).
 *
 * `classification.categoryId`, `classification.productType` and
 * `draft.schemaEtag` were three of the six original exemptions. They are gone
 * because `NAMESPACED_KEY` matches `[a-z][a-z0-9_]*` segments and a camelCase
 * segment cannot match one — so each excused a finding that could not occur.
 * This case is what says that out loud: the literals are present, in the
 * authoring subtree, exempted by nothing, and the guard is still silent.
 *
 * Without it, "we removed four dead entries" rests on a measurement taken once.
 */
await mustPass(
  "a camelCase validation path does not fire at all — the shape rule cannot match one",
  baseTree({
    [`${AUTHORING_DIR}/paths.ts`]:
      "export function step(path: string) {\n" +
      "  if (path === 'classification.categoryId') return 1;\n" +
      "  if (path === 'classification.productType') return 2;\n" +
      "  if (path === 'draft.schemaEtag') return 3;\n" +
      "  return 0;\n}\n",
    ...exceptionFixture(),
  }),
);

// File scope is the other half of the fix, and it is the half a bare list of
// names cannot express: `listing.title` was excused ANYWHERE under
// packages/dashboard/, so parking it in a wizard component was free.
await mustFail(
  "an excused validation path in ANOTHER file is NOT excused",
  baseTree({
    [`${AUTHORING_DIR}/keys.ts`]: "export const TITLE = 'listing.title';\n",
    ...exceptionFixture(),
  }),
  { expect: "[namespaced-key]", mutationMarker: "export const TITLE = 'listing.title'" },
);

await mustPass(
  "a dotted storage key OUTSIDE the wizard's tree does NOT fire",
  baseTree({
    "packages/dashboard/lib/themePersistence.ts":
      "export const KEY = 'mercaria.dashboard.bloom.theme';\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "comparing bare row ids does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/rows.ts`]:
      "export function same(row: { id: string }, other: { id: string }) {\n" +
      "  return row.id === other.id;\n}\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "an import specifier that looks like a namespaced key does NOT fire",
  baseTree({
    [`${AUTHORING_DIR}/imports.ts`]: "import 'expo.router.shim';\nexport const x = 1;\n",
    ...exceptionFixture(),
  }),
);

// ------------------------------- the exemption list, reconciled BOTH ways ---

await mustFail(
  "a reasoned exception that no longer fires is refused",
  baseTree(),
  { expect: "the count went DOWN to 0" },
);

/**
 * The direction the audited guards were all missing, and the one that lets a new
 * violation through.
 *
 * An excusing entry is a PREDICATE over (file, literal), so without a count it
 * excuses unboundedly many occurrences and the reconciliation can only ever ask
 * "did this fire at least once". Here a second, unreasoned use of the excused
 * path — parked in a constant, which is the evasion wall 2 exists for — rides in
 * behind the reasoned branch.
 */
await mustFail(
  "a SECOND use of an excused validation path in the same file cannot ride in",
  baseTree({
    [`${AUTHORING_DIR}/findings.ts`]:
      "export const TITLE_PATH = 'listing.title';\n" +
      "export function parseFindingPath(path: string) {\n" +
      "  if (path === 'listing.title') return { kind: 'listing', field: 'title' };\n" +
      "  if (path === 'listing.description') return { kind: 'listing', field: 'description' };\n" +
      "  return { kind: 'unknown' };\n" +
      "}\n",
  }),
  { expect: "the count went UP", mutationMarker: "export const TITLE_PATH = 'listing.title'" },
);

// ------------------------------- test files are skipped, and ONLY test files ---

/**
 * The source both cases below use (#469).
 *
 * It carries one finding for each of the walls that can fire on a single file,
 * so a partial exclusion — one that swallowed a wall it should not — shows up as
 * a wall that stopped reporting rather than as a green run.
 */
const FIXTURE_SHAPED_SOURCE =
  "export function probe(target: { attributeKey: string }) {\n" +
  "  const path = 'fields.material';\n" +
  "  return target.attributeKey === 'shoe_size' ? { attributeKey: 'shoe_size', path } : null;\n" +
  "}\n";

await mustPass(
  "a TEST file naming attribute fixtures is skipped by every wall",
  baseTree({
    [`${AUTHORING_DIR}/__tests__/findings.test.ts`]: FIXTURE_SHAPED_SOURCE,
    ...exceptionFixture(),
  }),
);

await mustFail(
  // The control that makes the exclusion honest. Byte-identical source at a
  // NON-test path must still be refused — an exclusion able to swallow
  // production code would pass this and hide the thing the guard exists for.
  "the SAME source outside a test path is still refused",
  baseTree({
    [`${AUTHORING_DIR}/probe.ts`]: FIXTURE_SHAPED_SOURCE,
  }),
  { expect: "[hardcoded-identity]", mutationMarker: "attributeKey: 'shoe_size'" },
);

await mustFail(
  "and by the namespaced-key wall too, not only the first one",
  baseTree({
    [`${AUTHORING_DIR}/probe.ts`]: FIXTURE_SHAPED_SOURCE,
  }),
  { expect: "[namespaced-key]", mutationMarker: "'fields.material'" },
);

// ------------------------------------------- the exemption list is BOUNDED ---

record(
  "the validation-path exemption list has an exact, asserted size",
  KNOWN_FINDING_PATH_EXCEPTION_COUNT === 2,
  `KNOWN_FINDING_PATH_EXCEPTIONS holds ${KNOWN_FINDING_PATH_EXCEPTION_COUNT}, expected 2. ` +
    "Wall 2 subtracts every one of them by name, so a list that grew silently is a hole. " +
    "Adding one is a decision: state why the new path cannot be told from a concept key. " +
    "The size alone proves little on its own — six wrong strings satisfy a size of six, which is " +
    "how four of the original entries came to excuse nothing (#494 finding 4) — so the guard also " +
    "reconciles each entry against its FILE and an exact count, in both directions.",
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
