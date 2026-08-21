#!/usr/bin/env bun

/**
 * Mutation-tests `validate-catalog-identity-contracts.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail. This one is a TypeScript AST walk over 121 files whose
 * verdict is a set comparison against a hand-written list of excuses, plus a
 * vocabulary parsed out of a THIRD file — four things that fail quiet. A walk
 * that returned nothing reports a clean surface. A vocabulary that came back
 * empty reports a clean surface. A `scanMember` that stopped descending into
 * nested literals reports a clean surface. An excusing entry that covers a
 * second occurrence reports a clean surface.
 *
 * ## Why the fixture is a COPY of the real tree, not a synthetic one
 *
 * The house pattern (`test-validate-money-formatting.mjs`) builds a tiny tree
 * and relaxes the guard's floors to 1 through an environment variable. That is
 * wrong for this guard: its floors are the only thing standing between "walked
 * 121 modules and found 32 excused occurrences" and "walked 0 modules". A
 * documented way to set them to 1 is a documented way to make the guard measure
 * almost nothing, and it would be reachable in production the moment somebody
 * copied the variable into a workflow.
 *
 * So every case here copies `packages/shared-types/src` and the vocabulary's
 * producer VERBATIM and mutates one line of the copy. The floors stay the
 * production ones on every run — including the case that deliberately truncates
 * the tree to prove the file floor fires.
 *
 * ## Every mutation is proved to have APPLIED before its exit code is believed
 *
 * A mutation that never applied is indistinguishable from one that survived,
 * and the usual proof (`git diff`) is EMPTY for an untracked file — which every
 * file in a copied tree is. So `mutate()` compares the bytes it read against the
 * bytes it wrote and throws if they match, before the guard is ever run.
 *
 * ## The arms with no live match
 *
 * Measured: five of the nine identity-shaped names in the shared vocabulary
 * (`category`, `productType`, `brand`, `brandName`, `controlledValue`) match
 * real declarations in the scanned tree. The other four — `categoryName`,
 * `optionName`, `attributeName`, `productTypeName` — match nothing, and an arm
 * that is unfired AND unmutated is indistinguishable from one that is
 * misspelled, mis-anchored or pointed at the wrong population: both print a
 * clean zero. The guard itself derives a positive control per vocabulary member
 * on every run; the cases below additionally drive all four through the REAL
 * file walk, so the arms are proven end to end and not only inside the matcher.
 *
 * Usage:  bun scripts/test-validate-catalog-identity-contracts.mjs
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-catalog-identity-contracts.mjs");

const CONTRACT_RELATIVE = "packages/shared-types/src";
const PRODUCER_RELATIVE = "packages/backend/src/db/__tests__/catalog-identity-isolation.test.ts";

const failures = [];
let cases = 0;

/** A scratch root holding a verbatim copy of both populations the guard reads. */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "catalog-contract-validator-"));
  mkdirSync(join(root, CONTRACT_RELATIVE), { recursive: true });
  cpSync(join(repositoryRoot, CONTRACT_RELATIVE), join(root, CONTRACT_RELATIVE), {
    recursive: true,
  });
  mkdirSync(join(root, dirname(PRODUCER_RELATIVE)), { recursive: true });
  cpSync(join(repositoryRoot, PRODUCER_RELATIVE), join(root, PRODUCER_RELATIVE));
  return root;
}

/**
 * Apply one edit and PROVE it landed.
 *
 * `git diff` cannot do this job here — every path in the copied tree is
 * untracked, and `git diff` is empty for an untracked file, which reads exactly
 * like an edit that changed nothing.
 */
function mutate(root, relativePath, transform) {
  const path = join(root, relativePath);
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) {
    throw new Error(
      `mutation for ${relativePath} produced identical bytes — it never applied, which is `
        + "indistinguishable from a mutation the guard survived",
    );
  }
  writeFileSync(path, after);
  const readBack = readFileSync(path, "utf8");
  if (readBack !== after) {
    throw new Error(`mutation for ${relativePath} did not read back as written`);
  }
}

function runAgainst(root) {
  const proc = Bun.spawnSync({
    cmd: ["bun", validator],
    cwd: repositoryRoot,
    env: { ...process.env, CATALOG_CONTRACT_VALIDATOR_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

/**
 * @param {string} name
 * @param {(root: string) => void} arrange  the mutation, or a no-op
 * @param {{ expect: 'red' | 'green', mentions?: string[] }} expectation
 */
function check(name, arrange, expectation) {
  cases += 1;
  const root = makeTree();
  try {
    arrange(root);
    const { exitCode, output } = runAgainst(root);
    const red = exitCode !== 0;
    if (red !== (expectation.expect === "red")) {
      failures.push(
        `${name}: expected ${expectation.expect.toUpperCase()} but the guard exited ${exitCode}.\n`
          + output.split("\n").map((line) => `      ${line}`).join("\n"),
      );
      return;
    }
    for (const phrase of expectation.mentions ?? []) {
      if (output.includes(phrase)) continue;
      failures.push(
        `${name}: the guard produced the right verdict but did not name ${JSON.stringify(phrase)}. `
          + "A failure that does not identify the offending symbol and file sends the next reader "
          + `to the wrong place.\n${output.split("\n").map((line) => `      ${line}`).join("\n")}`,
      );
    }
  } catch (error) {
    failures.push(`${name}: ${String(error)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Append a declaration to a real contract module. */
const append = (source, declaration) => `${source}\n${declaration}\n`;

/* -------------------------------------------------------------------------- */
/*  The control                                                                 */
/* -------------------------------------------------------------------------- */

// Without this every RED below could be red because the copy is broken, the
// floors are unmet or the producer did not come across — none of which has
// anything to do with the mutation under test.
check("CONTROL — an unmutated copy of the real tree is GREEN", () => {}, {
  expect: "green",
  mentions: [
    // Counted from the guard's own output, never by arithmetic on the previous
    // figure: #367 W1's `taxonomy-classification.ts` added one module, and
    // deriving 122 by adding one would also have had to guess the type and
    // property deltas, which is how a pin stops describing the tree it pins.
    "walked 122 contract module(s), 2237 exported type(s), 7586 property signature(s)",
    "check A arms exercised by real declarations: 5/9",
  ],
});

/* -------------------------------------------------------------------------- */
/*  check A — every vocabulary arm, driven through the REAL file walk           */
/* -------------------------------------------------------------------------- */

const LIVE_ARMS = ["category", "productType", "brand", "brandName", "controlledValue"];
const CONTROL_ONLY_ARMS = ["categoryName", "optionName", "attributeName", "productTypeName"];

for (const field of [...LIVE_ARMS, ...CONTROL_ONLY_ARMS]) {
  const live = LIVE_ARMS.includes(field);
  check(
    `check A — a NEW \`${field}: string\` in a real contract module turns it RED `
      + `(${live ? "an arm with live matches" : "an arm with NO live match"})`,
    (root) => {
      mutate(root, `${CONTRACT_RELATIVE}/product.ts`, (source) =>
        append(source, `export interface MutantSurface {\n  ${field}: string;\n}`),
      );
    },
    {
      expect: "red",
      mentions: [
        "NEW ambiguous public catalog contract",
        `product.ts:MutantSurface.${field}`,
      ],
    },
  );
}

check(
  "check A — the typed replacement beside it does NOT turn it red",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/product.ts`, (source) =>
      append(
        source,
        "export interface MutantTyped {\n  categoryId: string;\n  productTypeKey: string;\n"
          + "  attributeDefinitionId: string;\n  categorySlug: string;\n}",
      ),
    );
  },
  { expect: "green" },
);

check(
  "check A — a closed union is not a bare string",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/product.ts`, (source) =>
      append(source, "export interface MutantUnion {\n  category: 'a' | 'b';\n}"),
    );
  },
  { expect: "green" },
);

check(
  "check A — an UNEXPORTED type is not a public contract",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/product.ts`, (source) =>
      append(source, "interface MutantPrivate {\n  category: string;\n}"),
    );
  },
  { expect: "green" },
);

check(
  "check A — a nested object literal is reached (the descent is what finds `optionValues`)",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/product.ts`, (source) =>
      append(source, "export interface MutantNested {\n  rows: { category: string }[];\n}"),
    );
  },
  { expect: "red", mentions: ["product.ts:MutantNested.rows.category"] },
);

// The shape that was invisible until the descent entered generic type
// arguments. `SellerPrefillField<{ key: string; value: string }>` is live on
// `SellerDraftPrefill.variantAttributes` — an attribute key/value pair — so the
// hole was one identifier away from hiding exactly what this gate is for. It
// was found by comparing this walker against a plain `forEachChild` collector,
// not by anything failing: the two disagreed by five members.
check(
  "check A — a type literal inside a GENERIC's type arguments is reached",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/product.ts`, (source) =>
      append(
        source,
        "export interface MutantGeneric {\n  prefill: SellerPrefillField<{ category: string }>;\n"
          + "  groups: Readonly<Record<string, { productType: string }>>;\n}",
      ),
    );
  },
  {
    expect: "red",
    mentions: [
      "product.ts:MutantGeneric.prefill.category",
      "product.ts:MutantGeneric.groups.productType",
    ],
  },
);

check(
  "check B — an option pair inside a GENERIC's type arguments is reached",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/variant.ts`, (source) =>
      append(
        source,
        "export interface MutantGenericOption {\n"
          + "  optionValues: SellerPrefillField<{ name: string; value: string }>;\n}",
      ),
    );
  },
  { expect: "red", mentions: ["variant.ts:MutantGenericOption.optionValues.name"] },
);

/* -------------------------------------------------------------------------- */
/*  check B — the `optionName` shape, which has no `optionName` spelling         */
/* -------------------------------------------------------------------------- */

check(
  "check B — a NEW option-shaped owner with a bare `name` turns it RED",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/variant.ts`, (source) =>
      append(source, "export interface MutantOption {\n  name: string;\n  value: string;\n}"),
    );
  },
  {
    expect: "red",
    mentions: ["variant.ts:MutantOption.name", "variant.ts:MutantOption.value"],
  },
);

check(
  "check B — a NEW inline `optionValues: { name; value }[]` turns it RED",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/variant.ts`, (source) =>
      append(
        source,
        "export interface MutantLine {\n  optionValues: { name: string; value: string }[];\n}",
      ),
    );
  },
  { expect: "red", mentions: ["variant.ts:MutantLine.optionValues.name"] },
);

check(
  "check B — the plural `axes` is matched, not only `axis`",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/variant.ts`, (source) =>
      append(source, "export interface MutantAxes {\n  axes: { value: string }[];\n}"),
    );
  },
  { expect: "red", mentions: ["variant.ts:MutantAxes.axes.value"] },
);

check(
  "check B — a substring is not a word: `taxes`, `taxonomy` and `adoptions` stay green",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/variant.ts`, (source) =>
      append(
        source,
        "export interface MutantTaxes {\n  taxes: { value: string }[];\n"
          + "  taxonomyRefinement: { name: string }[];\n  adoptions: { name: string }[];\n}",
      ),
    );
  },
  { expect: "green" },
);

check(
  "check B — the typed axis assignment is not an ambiguous option",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/variant.ts`, (source) =>
      append(
        source,
        "export interface MutantTypedAxis {\n"
          + "  optionValues: { attributeDefinitionId: string; normalizedValue: string }[];\n}",
      ),
    );
  },
  { expect: "green" },
);

/* -------------------------------------------------------------------------- */
/*  the excused set, in the OTHER direction                                     */
/* -------------------------------------------------------------------------- */

check(
  "an excused contract that DISAPPEARS turns it RED — the retirement is when somebody reads the entry",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/listing.ts`, (source) => {
      // Byte-exact and COUPLED to the live declaration on purpose: the guard
      // below refuses rather than skipping when it stops matching, so editing
      // that docblock turns this case red with "the fixture premise moved"
      // instead of silently removing nothing and reporting a pass. It has
      // already fired once, on the commit that declared
      // `LEGACY_LISTING_CATEGORY_CONTRACT` beside the field.
      const target =
        "  /**\n"
        + "   * Category slug the listing belongs to (e.g. `electronics`) — the v1 spelling,\n"
        + "   * DERIVED on every read from the leaf of `listings.category_slugs` and stored\n"
        + "   * nowhere. See `LEGACY_LISTING_CATEGORY_CONTRACT` for what retires it.\n"
        + "   */\n"
        + "  category: string;\n";
      if (!source.includes(target)) {
        throw new Error("could not find `Listing.category` to remove — the fixture premise moved");
      }
      return source.replace(target, "");
    });
  },
  {
    expect: "red",
    mentions: ["excuses `listing.ts:Listing.category` 1 time(s) but the walk found 0"],
  },
);

check(
  "a SECOND occurrence of an already-excused field turns it RED — one excuse cannot cover two",
  (root) => {
    mutate(root, `${CONTRACT_RELATIVE}/listing.ts`, (source) =>
      append(source, "export interface Listing {\n  category: string;\n}"),
    );
  },
  { expect: "red", mentions: ["occurs 2 time(s)", "excuses 1"] },
);

/* -------------------------------------------------------------------------- */
/*  the vocabulary's producer                                                   */
/* -------------------------------------------------------------------------- */

check(
  "a NARROWED vocabulary turns it RED rather than silently scanning for less",
  (root) => {
    mutate(root, PRODUCER_RELATIVE, (source) =>
      source.replace(
        /const IDENTITY_SHAPED_FIELDS = \[[\s\S]*?\];/u,
        "const IDENTITY_SHAPED_FIELDS = ['categ' + 'ory'];",
      ),
    );
  },
  {
    expect: "red",
    mentions: ["recovered 1 identity-shaped field name(s)", "does not contain \"optionName\""],
  },
);

check(
  "a RENAMED producer declaration turns it RED — an unmatched pattern is a failure, not a pass",
  (root) => {
    mutate(root, PRODUCER_RELATIVE, (source) =>
      source.replace(/IDENTITY_SHAPED_FIELDS/gu, "RENAMED_IDENTITY_FIELDS"),
    );
  },
  { expect: "red", mentions: ["no longer declares `IDENTITY_SHAPED_FIELDS`"] },
);

check(
  "an element the reader cannot FOLD turns it RED rather than being skipped",
  (root) => {
    mutate(root, PRODUCER_RELATIVE, (source) =>
      source.replace(
        "const IDENTITY_SHAPED_FIELDS = [",
        "const IDENTITY_SHAPED_FIELDS = [\n  SOME_IMPORTED_CONSTANT,",
      ),
    );
  },
  { expect: "red", mentions: ["cannot fold"] },
);

check(
  "a MISSING producer turns it RED — the vocabulary is never copied into the guard",
  (root) => {
    rmSync(join(root, PRODUCER_RELATIVE));
  },
  { expect: "red", mentions: ["could not read the vocabulary's producer"] },
);

/* -------------------------------------------------------------------------- */
/*  the floors                                                                  */
/* -------------------------------------------------------------------------- */

check(
  "a TRUNCATED contract surface turns it RED — a short walk reports a clean tree",
  (root) => {
    const dir = join(root, CONTRACT_RELATIVE);
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    if (files.length < 100) throw new Error("the copied tree is already short — the premise moved");
    for (const name of files) {
      if (["listing.ts", "variant.ts", "index.ts"].includes(name)) continue;
      rmSync(join(dir, name));
    }
  },
  { expect: "red", mentions: ["expected at least 110"] },
);

check(
  "an EMPTIED contract module turns it RED — an empty file scans as a clean one",
  (root) => {
    writeFileSync(join(root, `${CONTRACT_RELATIVE}/product.ts`), "");
  },
  { expect: "red", mentions: ["product.ts is empty"] },
);

check(
  "a SUBDIRECTORY under the flat population turns it RED — a one-level read would skip it",
  (root) => {
    mkdirSync(join(root, `${CONTRACT_RELATIVE}/catalog`), { recursive: true });
    writeFileSync(
      join(root, `${CONTRACT_RELATIVE}/catalog/nested.ts`),
      "export interface Nested {\n  category: string;\n}\n",
    );
  },
  { expect: "red", mentions: ["one level deep", "catalog"] },
);

/* -------------------------------------------------------------------------- */
/*  verdict                                                                     */
/* -------------------------------------------------------------------------- */

const MINIMUM_CASES = 26;
if (cases < MINIMUM_CASES) {
  failures.push(
    `ran ${cases} case(s) but expected at least ${MINIMUM_CASES}. A self-test that stopped running `
      + "its cases prints the same success line as one that ran them all.",
  );
}

if (failures.length > 0) {
  console.error(`\ntest-validate-catalog-identity-contracts: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `\ntest-validate-catalog-identity-contracts: OK — ${cases} cases; every vocabulary arm, both `
    + "checks, both directions of the excused set, the producer and every floor fire on a real "
    + "copy of the tree.",
);
