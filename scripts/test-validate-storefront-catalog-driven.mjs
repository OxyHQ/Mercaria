#!/usr/bin/env bun

/**
 * Mutation-tests `validate-storefront-catalog-driven.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail, and this one fails QUIET in four separate ways: a
 * `git ls-files` that returns nothing reports a clean tree, a prefix filter
 * matching no path reports a clean tree, a detector whose AST shape stopped
 * matching reports a clean tree, and an exemption entry that has stopped
 * describing the tree silences a finding forever. Every POSITIVE case below
 * breaks exactly one thing, asserts the break LANDED in the fixture, and
 * requires the guard to fail with the words that identify the right wall.
 *
 * The NEGATIVE cases matter as much. This guard runs over the code that
 * implements the thing it protects, and that code legitimately does almost
 * exactly what the detectors look for: it switches on the catalog's own closed
 * vocabularies (`origin`, `shape`, `kind`, `availability`), it asks whether a
 * bucket key is in a set built from a server response at runtime, and it holds
 * copy in a `Record` over a shared-types union. A rule that fired on any of
 * those would be flagging the correct implementation, and the first person to
 * hit it would switch the guard off.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_PATH_LITERAL_COUNT,
  KNOWN_CONCEPT_BRANCH_COUNT,
  KNOWN_VOCABULARY_EXCEPTION_COUNT,
} from "./validate-storefront-catalog-driven.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-storefront-catalog-driven.mjs");

const CATALOG_LIB = "packages/frontend/lib/catalog";
const CATALOG_COMPONENTS = "packages/frontend/components/catalog";
const BUNDLE = "packages/frontend/lib/i18n/locales/en.json";

// The two trees #478 added. A fixture has to carry a file and a bundle in each,
// or every case fails on a per-tree floor instead of on the wall it is testing —
// which is itself the floors working, and is asserted directly below.
const UI_MARKETPLACE = "packages/ui/src/components/marketplace";
const UI_BUNDLE = "packages/ui/src/i18n/locales/en.json";
const POS_BUNDLE = "packages/pos/lib/i18n/locales/en.json";

/**
 * A fixture bundle carrying the keys the negative controls resolve.
 *
 * Wall 2 subtracts real translation keys, so a control asserting that
 * `t('catalog.filters.title')` does NOT fire needs that key to exist —
 * otherwise the control would pass for the wrong reason.
 */
const FIXTURE_BUNDLE = JSON.stringify({
  catalog: {
    filters: { title: "Filters", clear: "Clear all" },
    specs: { title: "Specifications" },
  },
});

/** Enough files in every scanned tree and catalog subtree to clear the floors. */
function baseTree(extra = {}) {
  return {
    [BUNDLE]: FIXTURE_BUNDLE,
    [UI_BUNDLE]: FIXTURE_BUNDLE,
    [POS_BUNDLE]: FIXTURE_BUNDLE,
    [`${CATALOG_LIB}/navigation.ts`]: "export const navigation = 1;\n",
    [`${CATALOG_COMPONENTS}/FacetRail.tsx`]: "export const rail = 1;\n",
    "packages/frontend/app/(app)/categories/index.tsx": "export const categories = 1;\n",
    "packages/frontend/lib/other.ts": "export const other = 1;\n",
    [`${UI_MARKETPLACE}/PriceDisplay.tsx`]: "export const price = 1;\n",
    "packages/pos/lib/other.ts": "export const other = 1;\n",
    ...extra,
  };
}

/** Run the REAL guard against a scratch checkout. */
async function runAgainst(files, { realFloors = false, removeAfterAdd = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "storefront-catalog-validator-"));
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

    const environment = { ...process.env, STOREFRONT_CATALOG_VALIDATOR_ROOT: root };
    if (!realFloors) environment.STOREFRONT_CATALOG_VALIDATOR_FIXTURE_FLOORS = "1";

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
  "a comparison against a facet key fails",
  baseTree({
    [`${CATALOG_COMPONENTS}/Rail.tsx`]:
      "export function render(facet: { key: string }) {\n" +
      "  return facet.key === 'condition' ? 1 : 0;\n" +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: "facet.key === 'condition'" },
);

await mustFail(
  "a comparison against a categoryId fails, in either operand order",
  baseTree({
    [`${CATALOG_LIB}/branch.ts`]:
      "export function render(categoryId: string) {\n" +
      "  return 'cat_electronics' === categoryId;\n" +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: "'cat_electronics' === categoryId" },
);

await mustFail(
  "the two-step evasion — a literal bound to a constant first — fails",
  baseTree({
    [`${CATALOG_LIB}/branch.ts`]:
      "const PHONES = 'cat_phones';\n" +
      "export function render(node: { categoryId: string }) {\n" +
      "  return node.categoryId === PHONES;\n" +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: "node.categoryId === PHONES" },
);

await mustFail(
  "a switch over an attribute key fails",
  baseTree({
    [`${CATALOG_LIB}/branch.ts`]:
      "export function render(attributeKey: string) {\n" +
      "  switch (attributeKey) {\n" +
      "    case 'storage_capacity':\n" +
      "      return 1;\n" +
      "    default:\n" +
      "      return 0;\n" +
      "  }\n" +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: "case 'storage_capacity':" },
);

await mustFail(
  "a membership test over a hardcoded value list fails",
  baseTree({
    [`${CATALOG_LIB}/branch.ts`]:
      "const HIDDEN = ['color', 'size'];\n" +
      "export function render(facet: { key: string }) {\n" +
      "  return HIDDEN.includes(facet.key);\n" +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: "HIDDEN.includes(facet.key)" },
);

// -------------------------------------------------- wall 2: namespaced key ---

await mustFail(
  "a namespaced concept key in the catalog subtree fails",
  baseTree({
    [`${CATALOG_LIB}/keys.ts`]: "export const DEFAULT = 'electronics.phones.smartphones';\n",
  }),
  { expect: "[namespaced-key]", mutationMarker: "electronics.phones.smartphones" },
);

// --------------------------------------------- wall 3: hardcoded identity ----

await mustFail(
  "a hardcoded categoryId in a payload fails",
  baseTree({
    [`${CATALOG_LIB}/request.ts`]:
      "export const scope = { kind: 'category', categoryId: 'cat_phones' };\n",
  }),
  { expect: "[hardcoded-identity]", mutationMarker: "categoryId: 'cat_phones'" },
);

// ------------------------------------------- wall 4: a label used as identity ---

await mustFail(
  "a translated string in an identity position fails",
  baseTree({
    [`${CATALOG_LIB}/request.ts`]:
      "export function compose(t: (key: string) => string) {\n" +
      "  return { facetKey: t('catalog.filters.title') };\n" +
      "}\n",
  }),
  { expect: "[label-as-identity]", mutationMarker: "facetKey: t('catalog.filters.title')" },
);

// ---------------------------------------- wall 5: a re-listed vocabulary -----

await mustFail(
  "an array re-listing a shared-types vocabulary fails",
  baseTree({
    "packages/frontend/app/(app)/screen.tsx":
      "import type { ConditionGroup } from '@mercaria/shared-types';\n" +
      "const GROUPS: readonly ConditionGroup[] = ['new', 'used'];\n" +
      "export const groups = GROUPS;\n",
  }),
  { expect: "[vocabulary-relisting]", mutationMarker: "['new', 'used']" },
);

await mustFail(
  "a {value,label} choice list re-listing a vocabulary fails",
  baseTree({
    "packages/frontend/app/(app)/screen.tsx":
      "import type { BasketObjective } from '@mercaria/shared-types';\n" +
      "const CHOICES: readonly { value: BasketObjective; label: string }[] = [\n" +
      "  { value: 'all_native', label: 'Buy on Mercaria' },\n" +
      "  { value: 'fewest_merchants', label: 'Fewest merchants' },\n" +
      "];\n" +
      "export const choices = CHOICES;\n",
  }),
  { expect: "[vocabulary-relisting]", mutationMarker: "value: 'all_native'" },
);

await mustFail(
  "a `new Set([...])` re-listing a vocabulary fails",
  baseTree({
    "packages/frontend/app/(app)/screen.tsx":
      "import type { ConditionGroup } from '@mercaria/shared-types';\n" +
      "const GROUPS: ReadonlySet<ConditionGroup> = new Set<ConditionGroup>(['new', 'used']);\n" +
      "export const groups = GROUPS;\n",
  }),
  { expect: "[vocabulary-relisting]", mutationMarker: "new Set<ConditionGroup>(['new', 'used'])" },
);

// ------------------------- #478: the shared and POS trees are really scanned ---

// The historical offender, verbatim, in the package that had no gate.
//
// `VariantSwatches` picked a colour widget from `COLOR_OPTION_NAMES` — three
// English words — so `Colour` got swatches and `Tono` got pills. The shape was
// refused in `packages/frontend` and permitted in `packages/ui`, which the
// storefront imports, and PR #571 removed it from the component. This is the
// standing proof that moving it BACK, one package sideways, is now refused:
// without a case like it, "no findings in the shared tree" and "the shared tree
// is not being read" print the same line.
await mustFail(
  "the #478 offender is refused in packages/ui, not only in packages/frontend",
  baseTree({
    [`${UI_MARKETPLACE}/VariantSwatches.tsx`]:
      'const COLOR_OPTION_NAMES = new Set(["color", "colour", "shade"]);\n' +
      "export function isColor(option: { name: string }) {\n" +
      "  return COLOR_OPTION_NAMES.has(option.name.trim().toLowerCase());\n" +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: 'new Set(["color", "colour", "shade"])' },
);

// The same shape one package further over. POS had no catalog gate of ANY kind
// before #478, so this is the whole of its coverage proof.
await mustFail(
  "the same shape is refused in packages/pos, which had no catalog gate at all",
  baseTree({
    "packages/pos/components/OptionPicker.tsx":
      "export function isSize(option: { name: string }) {\n" +
      '  return option.name === "size";\n' +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: 'option.name === "size"' },
);

// The exemptions cover `facet-labels.ts` by FILE, so the same literal elsewhere
// in the shared tree must still be refused. An excusing entry is a predicate
// scoped to one file, not a permanent pardon for the word "condition".
await mustFail(
  "an exempted literal in a DIFFERENT shared-tree file is still refused",
  baseTree({
    [`${UI_MARKETPLACE}/Elsewhere.tsx`]:
      "export function pick(facet: { key: string }) {\n" +
      '  return facet.key === "condition";\n' +
      "}\n",
  }),
  { expect: "[concept-branch]", mutationMarker: 'facet.key === "condition"' },
);

// ------------------------------------------------------- the vacuity floors ---

await mustFail(
  // ALL THREE bundles are present deliberately: without one the guard exits
  // earlier on the unreadable bundle, which is a correct refusal for a DIFFERENT
  // reason — and a control that passes on any refusal at all is not a control on
  // this floor. It was one bundle until #478 widened the population to three.
  "an empty tree fails the scanned-files floor rather than reporting clean",
  {
    "README.md": "nothing here\n",
    [BUNDLE]: FIXTURE_BUNDLE,
    [UI_BUNDLE]: FIXTURE_BUNDLE,
    [POS_BUNDLE]: FIXTURE_BUNDLE,
  },
  { expect: "the file listing is broken", realFloors: true },
);

await mustFail(
  "a storefront with no catalog subtree fails the catalog floor",
  {
    [BUNDLE]: FIXTURE_BUNDLE,
    [UI_BUNDLE]: FIXTURE_BUNDLE,
    [POS_BUNDLE]: FIXTURE_BUNDLE,
    ...Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [
        `packages/frontend/lib/file${String(index)}.ts`,
        "export const value = 1;\n",
      ]),
    ),
  },
  { expect: "catalog source files under", realFloors: true },
);

// #478. THE case for the widening, and it is a floor case rather than a wall
// case because the failure it describes is silent: a full storefront clears a
// scanned floor of 120 on its own, so one total would have let `packages/ui/src`
// vanish from the population with the guard still printing a pass. Only a
// PER-TREE floor can tell "the shared tree is clean" from "the shared tree is
// not being read". The fixture is a complete, passing storefront with the shared
// tree removed.
await mustFail(
  "a full storefront with NO shared ui tree fails that tree's own floor",
  {
    [BUNDLE]: FIXTURE_BUNDLE,
    [UI_BUNDLE]: FIXTURE_BUNDLE,
    [POS_BUNDLE]: FIXTURE_BUNDLE,
    [`${CATALOG_LIB}/navigation.ts`]: "export const navigation = 1;\n",
    ...Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [
        `packages/frontend/lib/file${String(index)}.ts`,
        "export const value = 1;\n",
      ]),
    ),
    ...Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `packages/pos/lib/file${String(index)}.ts`,
        "export const value = 1;\n",
      ]),
    ),
  },
  { expect: "source files under packages/ui/src/", realFloors: true },
);

await mustFail(
  "a tracked file the working tree lost is reported, never skipped",
  baseTree({ [`${CATALOG_LIB}/gone.ts`]: "export const gone = 1;\n" }),
  { expect: "tracked but unreadable", removeAfterAdd: [`${CATALOG_LIB}/gone.ts`] },
);

// ------------------------------------------------ the exemption list is real ---

await mustFail(
  "a reasoned exception that no longer fires is refused",
  baseTree(),
  { expect: "the count went DOWN to 0", realFloors: false },
);

// The direction #448 asks for and #494 finding 2 found missing here. Matching is
// `detail.startsWith(declaration + " ")`, so TWO declarations of one name in one
// file both match the single entry; the old reconciliation recorded membership
// in a Set, which collapses them and can only ever ask "did it fire at least
// once". A second, differently-valued re-listing rode in behind the reasoned one
// and the guard printed "1 reasoned exception, all still firing".
await mustFail(
  "a SECOND re-listing under an excused declaration name cannot ride in",
  baseTree({
    // `exceptionFixture()`'s file, plus a second declaration of the SAME name in
    // a block scope — legal TypeScript, and both findings' details start
    // "BUYER_CANCELLABLE ", so both match the single entry.
    "packages/frontend/app/(app)/orders/[id].tsx":
      "import type { OrderStatus } from '@mercaria/shared-types';\n" +
      "const BUYER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([\n" +
      "  'pending_payment',\n" +
      "  'paid',\n" +
      "  'processing',\n" +
      "]);\n" +
      "export const cancellable = BUYER_CANCELLABLE;\n" +
      "{\n" +
      "  const BUYER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([\n" +
      "    'awaiting_pickup',\n" +
      "    'in_transit',\n" +
      "  ]);\n" +
      "  void BUYER_CANCELLABLE;\n" +
      "}\n",
  }),
  { expect: "the count went UP", realFloors: false },
);

// ------------------------------------ the NEGATIVE controls — correct code ----

await mustPass(
  "switching on a closed VOCABULARY discriminant is fine",
  baseTree({
    [`${CATALOG_COMPONENTS}/Rail.tsx`]:
      "export function render(facet: { origin: string; values: { shape: string } }) {\n" +
      "  if (facet.origin === 'attribute') return 1;\n" +
      "  return facet.values.shape === 'buckets' ? 2 : 3;\n" +
      "}\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "a membership test against a set built from the SERVER's answer is fine",
  baseTree({
    [`${CATALOG_LIB}/selection.ts`]:
      "export function render(bucket: { key: string }, selected: string[]) {\n" +
      "  return selected.includes(bucket.key);\n" +
      "}\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "copy held in a Record over a shared-types union is fine",
  baseTree({
    "packages/frontend/app/(app)/screen.tsx":
      "import type { ConditionGroup } from '@mercaria/shared-types';\n" +
      "const LABELS: Readonly<Record<ConditionGroup, string>> = Object.freeze({\n" +
      "  new: 'New',\n" +
      "  open_box: 'Open box',\n" +
      "  refurbished: 'Refurbished',\n" +
      "  used: 'Used',\n" +
      "  for_parts: 'For parts',\n" +
      "});\n" +
      "export const labels = LABELS;\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "iterating the imported TUPLE is fine",
  baseTree({
    "packages/frontend/app/(app)/screen.tsx":
      "import { CONDITION_GROUPS } from '@mercaria/shared-types';\n" +
      "export const groups = CONDITION_GROUPS.map((group) => group);\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "an array of literals with NO shared-types annotation is fine",
  baseTree({
    [`${CATALOG_COMPONENTS}/Indent.tsx`]:
      "const INDENT_BY_DEPTH = ['ps-0', 'ps-space-16', 'ps-space-32'] as const;\n" +
      "export const indent = INDENT_BY_DEPTH;\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "an identity read off a route parameter is fine",
  baseTree({
    [`${CATALOG_LIB}/request.ts`]:
      "export function scope(categoryId: string) {\n" +
      "  return { kind: 'category', categoryId };\n" +
      "}\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "a namespaced string OUTSIDE the catalog subtree is fine",
  baseTree({
    "packages/frontend/lib/storage.ts": "export const KEY = 'mercaria.storefront.theme';\n",
    ...exceptionFixture(),
  }),
);

await mustPass(
  "a module specifier in the catalog subtree is fine",
  baseTree({
    [`${CATALOG_LIB}/imports.ts`]: "import 'expo.router.shim';\nexport const value = 1;\n",
    ...exceptionFixture(),
  }),
);

/**
 * Every reasoned exception, reproduced so a PASSING fixture satisfies the
 * both-directions reconciliation.
 *
 * That reconciliation is the point of the case above it: without this fixture
 * every `mustPass` here would fail on the unmatched exception, which is exactly
 * the behaviour that stops the lists rotting. #478 took it from one entry to
 * nine — four wall-5 declarations and five wall-1 branches — and the shape of
 * each reproduction is load-bearing, because an entry the fixture satisfies the
 * WRONG way (a `switch` where the real file has a comparison) would leave the
 * guard's exact-detail matching untested.
 */
function exceptionFixture() {
  return {
    "packages/frontend/app/(app)/orders/[id].tsx":
      "import type { OrderStatus } from '@mercaria/shared-types';\n" +
      "const BUYER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([\n" +
      "  'pending_payment',\n" +
      "  'paid',\n" +
      "  'processing',\n" +
      "]);\n" +
      "export const cancellable = BUYER_CANCELLABLE;\n",
    "packages/ui/src/lib/pickup-labels.ts":
      "import type { PickupBlockReason } from '@mercaria/shared-types';\n" +
      "const GUEST_ONLY_BLOCK_REASONS: readonly PickupBlockReason[] = [\n" +
      "  'guest_pickup_disabled',\n" +
      "  'guest_seller_not_activated',\n" +
      "  'guest_notifications_unavailable',\n" +
      "];\n" +
      "export const guestOnly = GUEST_ONLY_BLOCK_REASONS;\n",
    "packages/pos/lib/permissions.ts":
      "import type { StorePermission } from '@mercaria/shared-types';\n" +
      "const ALL_PERMISSIONS: readonly StorePermission[] = ['store:manage', 'products:read'];\n" +
      "const STAFF_PERMISSIONS: readonly StorePermission[] = ['products:read', 'orders:read'];\n" +
      "export const all = ALL_PERMISSIONS;\n" +
      "export const staff = STAFF_PERMISSIONS;\n",
    // All five wall-1 entries are COMPARISONS, matched on the exact detail
    // `compared against "<literal>"`. Written as comparisons here for that
    // reason: a `switch` over the same literals would satisfy nothing.
    "packages/ui/src/lib/facet-labels.ts":
      "export function bucketText(facetKey: string, bucketKey: string) {\n" +
      '  if (facetKey === "availability") return 1;\n' +
      '  if (facetKey === "offer_channel") return 2;\n' +
      '  if (facetKey === "condition") return 3;\n' +
      '  if (facetKey === "market") {\n' +
      '    const ANY = "*";\n' +
      "    return bucketKey === ANY ? 4 : 5;\n" +
      "  }\n" +
      "  return 0;\n" +
      "}\n",
  };
}

// The reconciliation itself, driven through the guard rather than asserted
// about. A fixture cannot add an entry to the guard's own frozen list, so this
// case instead proves the OTHER direction is live: a subtree literal that is not
// a translation key and not exempted must still be reported. If the subtraction
// branch ever swallowed everything, this is what would go red.
await mustFail(
  "wall 2 still reports a dotted literal that no list excuses",
  baseTree({
    [`${CATALOG_LIB}/keys.ts`]: "export const K = 'phones.smartphones.flagship';\n",
    ...exceptionFixture(),
  }),
  { expect: "[namespaced-key]", mutationMarker: "phones.smartphones.flagship" },
);

// ------------------------------- test files are skipped, and ONLY test files ---

/**
 * The source both cases below use.
 *
 * It contains one finding for each of the four walls that can fire on a single
 * file, so a partial exclusion — one that swallowed a wall it should not — is
 * visible as a wall that stopped reporting rather than as a green run.
 */
const FIXTURE_SHAPED_SOURCE =
  "import type { ConditionGroup } from '@mercaria/shared-types';\n" +
  "const GROUPS: readonly ConditionGroup[] = ['new', 'used'];\n" +
  "export function probe(facet: { key: string }, t: (key: string) => string) {\n" +
  "  const payload = { categoryId: 'cat_phones', facetKey: t('catalog.filters.title') };\n" +
  "  return facet.key === 'condition' ? [GROUPS, payload] : [];\n" +
  "}\n";

await mustPass(
  "a TEST file naming fixtures is skipped by every wall",
  baseTree({
    [`${CATALOG_LIB}/__tests__/composition.test.ts`]: FIXTURE_SHAPED_SOURCE,
    ...exceptionFixture(),
  }),
);

await mustFail(
  // The control that makes the exclusion honest. Byte-identical source at a
  // NON-test path must still be refused — an exclusion able to swallow
  // production code would pass this and hide the thing the guard exists for.
  "the SAME source outside a test path is still refused",
  baseTree({
    [`${CATALOG_LIB}/probe.ts`]: FIXTURE_SHAPED_SOURCE,
  }),
  { expect: "[concept-branch]", mutationMarker: "facet.key === 'condition'" },
);

await mustFail(
  "and it is refused by the vocabulary wall too, not only the first one",
  baseTree({
    [`${CATALOG_LIB}/probe.ts`]: FIXTURE_SHAPED_SOURCE,
  }),
  { expect: "[vocabulary-relisting]", mutationMarker: "['new', 'used']" },
);

await mustFail(
  "and by the identity and label walls",
  baseTree({
    [`${CATALOG_LIB}/probe.ts`]: FIXTURE_SHAPED_SOURCE,
  }),
  { expect: "[label-as-identity]", mutationMarker: "t('catalog.filters.title')" },
);

// ------------------------------------------- the bounded lists are asserted ---

record(
  "the catalog path-literal exemption list is EMPTY, and that is asserted",
  CATALOG_PATH_LITERAL_COUNT === 0,
  `CATALOG_PATH_LITERALS holds ${CATALOG_PATH_LITERAL_COUNT}, expected 0. ` +
    "Wall 2 subtracts every one of them by name, so a list that grew silently is a hole. " +
    "Adding one is a decision: state why the new literal cannot be told from a concept key, " +
    "and give it a FILE and an exact COUNT. It must also actually FIRE — the guard reconciles " +
    "the list in both directions, because the first draft of it carried an entry with no dot " +
    "in it, which `NAMESPACED_KEY` could never have matched. Because the list is empty, none " +
    "of the three outcomes is exercised from here; they were driven through the real guard " +
    "with a temporary entry and a scratch tree when the shape landed (#494).",
);

record(
  "the wall-5 exception list has an exact, asserted size",
  KNOWN_VOCABULARY_EXCEPTION_COUNT === 4,
  `KNOWN_VOCABULARY_EXCEPTIONS holds ${KNOWN_VOCABULARY_EXCEPTION_COUNT}, expected 4. ` +
    "Each entry silences a real finding, so a list that grew silently is a hole. " +
    "Adding one is a decision: state why the declaration is not a catalog vocabulary, " +
    "and give it an integer `count` — an entry without one used to fall through every branch " +
    "of the reconciliation in silence, because `actual < undefined` and `actual > undefined` " +
    "are both false (#494). It went 1 -> 4 at #478's widening, when a gate read " +
    "`packages/ui/src` and `packages/pos` for the first time and found three more policy " +
    "subsets of server-owned unions.",
);

record(
  "the wall-1 branch exemption list has an exact, asserted size",
  KNOWN_CONCEPT_BRANCH_COUNT === 5,
  `KNOWN_CONCEPT_BRANCHES holds ${KNOWN_CONCEPT_BRANCH_COUNT}, expected 5. ` +
    "The list is new with #478 and every entry is `facet-labels.ts`, the shared stable-key " +
    "copy table that falls back to server text and is gated by validate:facet-label-copy. " +
    "A SIXTH entry is a different claim and needs its own reason — in particular, do not add " +
    "one to silence a branch whose fix is to read the value off the server's answer.",
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
