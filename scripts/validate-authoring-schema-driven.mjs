#!/usr/bin/env bun

/**
 * The dashboard's product form must stay SCHEMA-DRIVEN (#367 step 10, ADR 0007
 * D10).
 *
 * ## Why a guard rather than a memory
 *
 * The acceptance criterion the whole authoring epic is arranged around is that
 * **adding a product type is a data change**. `services/catalog-authoring/`
 * composes an `AuthoringSchema` — fields, requirements, controlled values,
 * groups, order, labels — and the dashboard renders it. The moment a React
 * component knows that "smartphones need a storage capacity", a schema change
 * needs a frontend release and the two go out of step in production. Nothing
 * else in CI can see that happen: the JSX is valid, `tsc` is happy, every build
 * job passes, and the merchant selling a product type nobody hardcoded just
 * gets a form missing half its fields.
 *
 * It gets undone one line at a time — `if (productTypeKey === 'x')` in a hotfix,
 * a `COLOURS` array somebody needed for a demo — each individually invisible.
 *
 * ## The four walls
 *
 *   1. NO BRANCH ON A CONCEPT'S IDENTITY. A comparison or a `switch` whose
 *      subject is one of ADR 0007 D1's identity names (`key`, `attributeKey`,
 *      `productTypeKey`, `categoryId`, `enumValueId`, …) and whose other side is
 *      a string LITERAL — or an in-file constant BOUND to one, which is the
 *      two-step version of the same thing. Plus a membership test against a
 *      hardcoded LIST of values.
 *
 *      Membership is narrowed to a list this tree AUTHORED — an array literal,
 *      a `new Set([...])`, or an in-file constant bound to either — because the
 *      correct implementation does exactly the same call against a set built
 *      from the schema at runtime (`controlled.has(entry.enumValueId)`,
 *      `axisKeys.has(field.key)`). A rule that fired on those would be flagging
 *      the code it exists to protect, and the first person to hit it would
 *      switch it off.
 *
 *      The schema's own closed VOCABULARIES — `valueType`, `cardinality`,
 *      `valuePolicy`, `requirement`, `scope`, `severity`, `kind` — are
 *      deliberately absent from the identity list. A renderer MUST switch on
 *      them, for the same reason.
 *
 *   2. NO NAMESPACED CONCEPT KEY IN THE WIZARD'S OWN TREE. A dotted lowercase
 *      key (`electronics.phones.smartphones`) stored in a constant is how wall 1
 *      is walked around. Two subtractions make the shape rule usable: the app's
 *      own `en.json` (a translation key has the identical shape, and a literal
 *      that RESOLVES to one is copy — a real data source rather than a
 *      heuristic about naming), and ADR 0007 D10's validation PATHS, which are a
 *      published vocabulary of the same shape. The second is not a pattern and
 *      cannot be one, so each path is named against the FILE it stands in and
 *      the number of findings it covers, reconciled both ways after the scan
 *      ({@link KNOWN_FINDING_PATH_EXCEPTIONS}).
 *
 *      Scoped to the authoring subtree rather than the whole dashboard, and
 *      that is a real limit rather than a preference: a dotted lowercase string
 *      is also what an AsyncStorage key looks like
 *      (`mercaria.dashboard.bloom.theme` is one, today, in an unrelated file),
 *      so repo-wide this rule cannot tell a concept key from storage plumbing.
 *      The residual it leaves — a product-type key parked in a constant OUTSIDE
 *      the wizard's tree and imported into it — is caught by wall 1 the moment
 *      it is compared against anything, which is the only way it does damage.
 *
 *   3. NO HARDCODED FIELD IDENTITY IN A PAYLOAD. `{ attributeKey: 'storage' }`
 *      or `{ enumValueId: 'black' }` — an answer whose subject was decided here
 *      rather than read off the schema. Every payload is composed in ONE module
 *      (`lib/authoring/answers.ts`), from an `AuthoringField`.
 *
 *   4. NO TRANSLATED LABEL AS IDENTITY. A `t(...)` call in the value position of
 *      an identity property. #367 step 10's own words: the wizard submits
 *      `attributeId` + `definitionVersion` + a typed value or a
 *      `controlledValueId`, never a label. A label is presentation and is never
 *      identity (ADR 0007 D1).
 *
 * ## What this guard measures if the thing it measures is absent
 *
 * Nothing — which is why it carries a vacuity floor on BOTH the whole scanned
 * tree and the authoring subtree, a positive control per wall run through
 * production's own analyser, and negative controls over the code the correct
 * implementation actually writes. A `git ls-files` that returns nothing, a
 * prefix that matches no path and a rule that stopped matching all report a
 * clean tree otherwise.
 *
 * Usage:  bun scripts/validate-authoring-schema-driven.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Overridable so the self-test points the REAL guard at a scratch checkout. */
const repositoryRoot = process.env.AUTHORING_VALIDATOR_ROOT
  ? resolve(process.env.AUTHORING_VALIDATOR_ROOT)
  : resolve(here, "..");

/** Fixture trees are a handful of files; this lowers the floors to 1, never 0. */
const fixtureFloors = process.env.AUTHORING_VALIDATOR_FIXTURE_FLOORS === "1";

const ts = createRequire(resolve(here, "../package.json"))("typescript");

/**
 * The trees that must stay schema-driven, each with the vocabulary wall 2
 * subtracts inside it and the floor below which its traversal is broken.
 *
 * `packages/ui/src` joined with #478. Every app consumes it FROM SOURCE — all
 * three `tsconfig.json` files alias `@mercaria/ui` to `../ui/src`, and 55
 * dashboard files import from it — so a `ui` file is compiled into the
 * dashboard's program exactly as one of its own is, and a prefix-scoped gate had
 * a documented workaround: move the hardcoding one package sideways and the gate
 * that forbids it cannot see it, while the wizard that renders it is unchanged.
 *
 * `validate-storefront-catalog-driven.mjs` scans the same shared tree, and that
 * is not two authorities over one property. It is two DIFFERENT properties whose
 * populations overlap on the tree both programs compile, and NEITHER analyser is
 * a superset of the other — this one has `canonicalRefId` and the `controlled`
 * key receiver, that one has `bucketKey`, `facetKey`, `brandId` and a fifth wall.
 *
 * `packages/pos` is deliberately absent: it has no authoring surface. Its routes
 * are cart, charge, customer, sales, receipt and store-setup, and a scan for
 * `createProduct`, `productTypeKey`, `attributeDefinition` and `wizard` across
 * the package returns nothing, so scanning it here would assert a property over
 * a surface that does not exist. It is under the storefront guard's READ walls.
 *
 * The floors are per TREE and not one total: a total is satisfied by whichever
 * tree did not empty, so `ui` moving would leave the dashboard's own count
 * clearing it and this guard silently back to scanning one package.
 */
const SCANNED_TREES = [
  {
    prefix: "packages/dashboard/",
    bundle: "packages/dashboard/lib/i18n/locales/en.json",
    floor: fixtureFloors ? 1 : 60,
  },
  {
    prefix: "packages/ui/src/",
    bundle: "packages/ui/src/i18n/locales/en.json",
    floor: fixtureFloors ? 1 : 60,
  },
];

/**
 * Where the authoring surface lives, and where the floor is measured.
 *
 * Wall 2's scope, and it stays dashboard-only. The shared tree holds no
 * authoring subtree — the wizard, its answers and its field components are all
 * the dashboard's — and turning wall 2 on across `packages/ui/src` was measured
 * at 16 findings that were every one of them SF Symbol names (`star.fill`,
 * `pencil.tip`), a storage key and two plural-suffixed translation keys. The
 * other three walls still read every shared file; only this one is scoped.
 */
const AUTHORING_PREFIXES = [
  "packages/dashboard/lib/authoring/",
  "packages/dashboard/components/catalog-authoring/",
  "packages/dashboard/app/(app)/products/wizard/",
];

/**
 * ADR 0007 D1's identity names.
 *
 * A concept has an opaque `id` and a stable machine `key` and NOTHING ELSE, and
 * these are the property names those travel under in this app. Branching on one
 * against a literal is per-concept truth, whatever the branch is for.
 *
 * `id` on its own is deliberately absent: it is far too general — a row id, a
 * React key, a DOM anchor — and a guard that fired on `if (option.id === row.id)`
 * would be switched off the day it landed. The narrow spellings below are the
 * ones that name a CATALOGUE concept.
 */
const IDENTITY_NAMES = new Set([
  "attributeDefinitionId",
  "attributeKey",
  "attributeName",
  "canonicalRefId",
  "categoryId",
  "categoryKey",
  "controlledValueId",
  "enumValueId",
  "optionName",
  "productTypeKey",
]);

/**
 * `key` is in wall 1 too, but only when the object it is read from is a schema
 * concept — `field.key`, `axis.key`. A bare `key` is a React prop and a map
 * entry, so it is matched only as a property ACCESS with one of these
 * receivers, which are the schema shapes that carry one.
 */
const KEY_RECEIVERS = new Set([
  "field",
  "axis",
  "attribute",
  "definition",
  "productType",
  "category",
  "option",
  "value",
  "controlled",
]);

/**
 * Property names whose VALUE is a concept's identity — wall 3 and wall 4.
 *
 * `attributeKey` and `enumValueId` are the two a draft answer carries, and
 * `canonicalRefId`/`productTypeKey`/`categoryId` are the other three a request
 * schema accepts. Every one has to be read off the composed schema or off a
 * search result, never authored here.
 */
const IDENTITY_PROPERTIES = new Set([
  "attributeDefinitionId",
  "attributeKey",
  "canonicalRefId",
  "categoryId",
  "enumValueId",
  "productTypeKey",
]);

/** Calls whose subject is a membership test — wall 1's third shape. */
const MEMBERSHIP_METHODS = new Set(["includes", "has", "startsWith", "endsWith"]);

/**
 * Receivers whose `.name` is a catalog concept's FREE TEXT — wall 1, #478.
 *
 * `IDENTITY_NAMES` carries `attributeName` and `optionName`, so
 * `a.attributeName === "colour"` was refused while `attribute.name === "colour"`
 * — the spelling every DTO here actually uses — was SILENT. Measured on the real
 * #478 source: the guard produced ZERO findings on it.
 *
 * Deliberately NARROWER than {@link KEY_RECEIVERS}: a `.key` is a machine
 * identity whoever the receiver is, while `.name` is an ordinary English word,
 * so `store.name`, `user.name` and `file.name` must not fire. `controlled`,
 * `field` and `value` are in `KEY_RECEIVERS` and none is here.
 *
 * Kept in step with `validate-storefront-catalog-driven.mjs`'s set on purpose:
 * both scan `packages/ui/src`, and a shape one refuses and the other permits in
 * one shared file is a rule nobody can state.
 */
const NAME_RECEIVERS = new Set([
  "attribute",
  "axis",
  "category",
  "definition",
  "option",
  "productType",
]);

/**
 * String methods wall 1 reads THROUGH when looking for a concept identity.
 *
 * `NAMES.has(option.name.trim().toLowerCase())` is the real #478 line, and
 * without this the identity is hidden behind two calls. Every member is case- or
 * whitespace-normalising and none changes which concept is being named; a
 * `.slice(...)` or a `.replace(...)` is a different value and is absent.
 */
const IDENTITY_NORMALIZERS = new Set([
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "normalize",
]);

/** A dotted lowercase machine key — `PRODUCT_TYPE_KEY_PATTERN`, one dot minimum. */
const NAMESPACED_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

/**
 * ADR 0007 D10's validation PATHS that wall 2 subtracts — each scoped to a FILE,
 * carrying an EXACT count, and reconciled in BOTH directions after the scan.
 *
 * Wall 2's shape rule cannot tell one of these from a concept key, because they
 * are the same shape, so they are subtracted by NAME rather than by a pattern.
 * What that name is worth is the whole question. Until #494 this was a bare
 * `Set` of six strings subtracted ANYWHERE under `packages/dashboard/`, with no
 * count and no check that any of them still matched anything — and the self-test
 * pinned only the list's SIZE, which six wrong strings satisfy exactly as well
 * as six right ones.
 *
 * Measured by emptying the list and reading the findings the guard then
 * reported: **four of the six subtracted nothing**, and three of those could
 * never have subtracted anything.
 *
 *   - `classification.categoryId`, `classification.productType` and
 *     `draft.schemaEtag` were STRUCTURALLY INERT. `NAMESPACED_KEY` matches
 *     `[a-z][a-z0-9_]*` segments, so a camelCase segment — `categoryId`,
 *     `productType`, `schemaEtag` — cannot match it at all, and each entry
 *     excused a finding that could not occur. That is
 *     `validate-storefront-catalog-driven.mjs`'s `category_tree` entry exactly,
 *     one guard over, and it is why that list is reconciled too.
 *   - `draft.status` was STALE. Production spells the branch
 *     `path.startsWith("draft.")`, whose argument has no second segment and so
 *     never matches the shape; the only literal occurrences are in
 *     `__tests__/findings.test.ts`, which every wall skips (#469).
 *
 * So an entry now names the file it applies to and exactly how many findings it
 * covers, and both directions fail. FEWER means it has stopped describing the
 * tree, which is how a list of exemptions decays into one nobody can audit.
 * MORE means a new hardcoded path rode in behind a reasoned one — the direction
 * a set of bare names can never report, because it can only ever ask "did this
 * fire at least once". `validate-rtl-logical-classes.mjs` and
 * `validate-storefront-catalog-driven.mjs` are the reference implementations.
 *
 * `variants[<n>].…` and `fields.<key>[<n>]` never needed naming: the bracket
 * takes them out of the shape.
 */
const KNOWN_FINDING_PATH_EXCEPTIONS = [
  {
    file: "packages/dashboard/lib/authoring/findings.ts",
    literal: "listing.title",
    count: 1,
    reason:
      "ADR 0007 D10's validation path for the listing title, in `parseFindingPath`'s branch on it. "
      + "The path vocabulary is the server's and this function is the one place that maps it to a "
      + "wizard control, so the string is a PATH rather than a catalogue concept.",
  },
  {
    file: "packages/dashboard/lib/authoring/findings.ts",
    literal: "listing.description",
    count: 1,
    reason:
      "The same, for the listing description — the sibling branch one line down. TWO entries rather "
      + "than one because they are two distinct literals and the count is per literal, so a second "
      + "occurrence of either is reported instead of being absorbed by the other's allowance.",
  },
];

export const KNOWN_FINDING_PATH_EXCEPTION_COUNT = KNOWN_FINDING_PATH_EXCEPTIONS.length;

/** Below this, the traversal is broken — and a broken traversal reports clean. */
const MINIMUM_AUTHORING_FILES = fixtureFloors ? 1 : 10;
// The per-tree scanned floors live on SCANNED_TREES, because one total is
// satisfied by whichever tree did not empty.

/** The guard cannot be its own subject; neither file lives under the prefix anyway. */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-authoring-schema-driven.mjs",
  "scripts/test-validate-authoring-schema-driven.mjs",
]);

const SOURCE_FILE = /\.tsx?$/;

/**
 * A test file, which every wall deliberately skips (#469).
 *
 * The same decision `validate-storefront-catalog-driven.mjs` records, reached
 * the same way and for the same reason. A test's job is to name specific values:
 * a finding path of `fields.material`, an expected `attributeKey: "shoe_size"`,
 * a variant position. Every one of those is what the walls exist to refuse in
 * PRODUCTION code and what a test of a path parser cannot do without — the
 * parser's whole contract is which concrete strings map to which control.
 * Measured: `lib/authoring/__tests__/findings.test.ts` produced thirteen
 * findings, all of them fixtures, none of them a defect.
 *
 * This is a CATEGORY rather than a hand-maintained list of paths, which is what
 * keeps it from being the kind of exemption that rots — there is nothing to
 * update when a test is added. What keeps it honest is the control in the
 * self-test: the SAME source, at a non-test path, must still be refused by every
 * wall. An exclusion able to swallow production code would pass that case.
 *
 * The count of skipped files is REPORTED on success, so a tree where production
 * modules had been renamed into `__tests__` to quieten this guard shows up as a
 * number nobody expected rather than as silence.
 */
const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.tsx?$/;

// --------------------------------------------------------------- utilities ---

/** Every file git tracks, repo-relative — so ignored files cannot count. */
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

/** Every leaf key of a nested bundle, dotted. */
function bundleKeys(value, prefix = "", out = new Set()) {
  for (const [key, entry] of Object.entries(value)) {
    const path = `${prefix}${key}`;
    if (entry !== null && typeof entry === "object") bundleKeys(entry, `${path}.`, out);
    else out.add(path);
  }
  return out;
}

/** The dotted name of a property access chain's LAST segment, or `null`. */
function accessedName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

/** The receiver of `x.key` — `x` — or `null`. */
function accessReceiver(node) {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

/** Whether an expression names a catalogue concept's identity. */
function namesIdentity(node) {
  const subject = throughNormalizers(node);
  const name = accessedName(subject);
  if (name === null) return false;
  if (IDENTITY_NAMES.has(name)) return true;
  if (name !== "key" && name !== "name") return false;
  const receiver = accessReceiver(subject);
  if (receiver === null) return false;
  const bare = receiver.replace(/^_+/u, "");
  return name === "key" ? KEY_RECEIVERS.has(bare) : NAME_RECEIVERS.has(bare);
}

/**
 * A node with any case- or whitespace-normalising calls peeled off.
 *
 * `attribute.name.trim().toLowerCase()` names the same concept
 * `attribute.name` does. Loops, so a third wrapper does not walk out from
 * under it.
 */
function throughNormalizers(node) {
  let current = node;
  while (
    ts.isCallExpression(current) &&
    // `normalize("NFC")` and `toLocaleLowerCase(locale)` legitimately take one.
    current.arguments.length <= 1 &&
    ts.isPropertyAccessExpression(current.expression) &&
    IDENTITY_NORMALIZERS.has(current.expression.name.text)
  ) {
    current = current.expression.expression;
  }
  return current;
}

/** A string literal's text, or `null`. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** Whether a node is a translate call — `t(...)` or `something.t(...)`. */
const isTranslateCall = (node) =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && node.expression.text === "t") ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t"));

/** Whether a node is an array literal or a `new Set([...])` of string literals. */
function literalValueList(node) {
  const elements = ts.isArrayLiteralExpression(node)
    ? node.elements
    : ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Set" &&
        node.arguments !== undefined &&
        node.arguments[0] !== undefined &&
        ts.isArrayLiteralExpression(node.arguments[0])
      ? node.arguments[0].elements
      : null;
  if (elements === null) return null;
  const values = [];
  for (const element of elements) {
    const value = literalText(element);
    if (value === null) return null;
    values.push(value);
  }
  return values.length > 0 ? values : null;
}

/**
 * Every in-file `const NAME = <string literal | literal list>`.
 *
 * This is what makes the two-step evasion visible: binding a product type's key
 * to a constant and comparing against THAT is the same branch with one more
 * line. Resolution is per FILE and deliberately shallow — a cross-file constant
 * is a residual this guard states rather than a case it silently half-covers.
 */
function collectLiteralBindings(sourceFile) {
  const strings = new Map();
  const lists = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const value = literalText(node.initializer);
      if (value !== null) strings.set(node.name.text, value);
      const list = literalValueList(node.initializer);
      if (list !== null) lists.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { strings, lists };
}

/** A node's literal text, resolving an in-file constant binding. */
function resolvedLiteral(node, bindings) {
  const direct = literalText(node);
  if (direct !== null) return direct;
  if (ts.isIdentifier(node)) return bindings.strings.get(node.text) ?? null;
  return null;
}

/** Whether the receiver of a membership call is a list THIS TREE authored. */
function authoredValueList(node, bindings) {
  if (literalValueList(node) !== null) return true;
  if (ts.isIdentifier(node)) return bindings.lists.has(node.text);
  return false;
}

/** Whether a literal sits in a module-specifier position, which wall 2 ignores. */
function isModuleSpecifier(node) {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = parent.expression;
    if (ts.isIdentifier(callee) && callee.text === "require") return true;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  }
  return ts.isImportTypeNode(parent) || ts.isExternalModuleReference(parent);
}

// ----------------------------------------------------------- the analyser ---

/**
 * Analyse ONE source file against the four walls.
 *
 * Exported so the controls run production's own code path over control SOURCE,
 * rather than asserting against a second copy of the rules.
 */
export function analyseSource(relativePath, text, translationKeys, options = {}) {
  const namespacedKeys = options.namespacedKeys ?? true;
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const bindings = collectLiteralBindings(sourceFile);
  const findings = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const report = (node, wall, detail) => {
    findings.push({ file: relativePath, line: lineOf(node), wall, detail });
  };

  const visit = (node) => {
    // WALL 1a — `concept.key === 'literal'`, in either operand order.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isComparison =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (isComparison) {
        const left = resolvedLiteral(node.left, bindings);
        const right = resolvedLiteral(node.right, bindings);
        if (right !== null && namesIdentity(node.left)) {
          report(node, "concept-branch", `compared against "${right}"`);
        } else if (left !== null && namesIdentity(node.right)) {
          report(node, "concept-branch", `compared against "${left}"`);
        }
      }
    }

    // WALL 1b — `switch (concept.key)` with any literal case.
    if (ts.isSwitchStatement(node) && namesIdentity(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const value = literalText(clause.expression);
        if (value !== null) report(clause, "concept-branch", `switch case "${value}"`);
      }
    }

    // WALL 1c — `LIST.includes(concept.key)` and `concept.key.startsWith('x')`.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (MEMBERSHIP_METHODS.has(method)) {
        const [argument] = node.arguments;
        // Only a list THIS TREE authored. A set built from the schema at
        // runtime is the correct implementation and must not fire.
        if (
          argument !== undefined &&
          namesIdentity(argument) &&
          authoredValueList(node.expression.expression, bindings)
        ) {
          report(node, "concept-branch", `${method}() over a hardcoded value list`);
        }
        const value = argument === undefined ? null : resolvedLiteral(argument, bindings);
        if (value !== null && namesIdentity(node.expression.expression)) {
          report(node, "concept-branch", `${method}("${value}") on a concept identity`);
        }
      }
    }

    // WALL 2 — a namespaced concept key that is not a translation key.
    // Authoring subtree only.
    //
    // D10's validation paths are NOT subtracted here. They are excused by the
    // caller, against a FILE and a count, so that the guard can tell an
    // exemption that is still doing work from one that stopped — which a
    // subtraction made inside the detector cannot, because the finding it
    // suppressed never existed to be counted.
    const asLiteral = namespacedKeys ? literalText(node) : null;
    if (
      asLiteral !== null &&
      NAMESPACED_KEY.test(asLiteral) &&
      !translationKeys.has(asLiteral) &&
      !isModuleSpecifier(node)
    ) {
      report(node, "namespaced-key", `"${asLiteral}"`);
    }

    // WALLS 3 and 4 — an identity property whose value was decided HERE.
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text
        : null;
      if (name !== null && IDENTITY_PROPERTIES.has(name)) {
        const value = literalText(node.initializer);
        if (value !== null && value.length > 0) {
          report(node, "hardcoded-identity", `${name}: "${value}"`);
        }
        if (isTranslateCall(node.initializer)) {
          report(node, "label-as-identity", `${name} was assigned a translated string`);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

// ------------------------------------------------------------------- main ---

const WALL_TEXT = {
  "concept-branch":
    "branches on a catalogue concept's identity. The schema decides which fields exist; a client that knows one product type's key holds truth a data change cannot reach (ADR 0007 D10).",
  "namespaced-key":
    "carries a namespaced concept key. A product type, category or attribute key in this tree is per-concept truth even when nothing branches on it yet.",
  "hardcoded-identity":
    "hardcodes a field or value identity into a payload. Every answer is composed in lib/authoring/answers.ts from an AuthoringField.",
  "label-as-identity":
    "sends a TRANSLATED string as identity. A label is presentation and is never identity (ADR 0007 D1); submit the id or the stable key beside it.",
};

async function main() {
  const failures = [];
  /** exception id -> how many findings it actually excused. */
  const matchedExceptions = new Map();
  const files = trackedFiles();

  // One bundle per tree, read up front. An unreadable one exits rather than
  // falling back to an empty key set: an empty set makes wall 2 fire on every
  // translation key in the tree, and the guard would be reporting the bundle's
  // absence as dozens of authoring findings. A tree carries its OWN bundle
  // rather than the union, or a dashboard key would excuse a literal authored in
  // `ui`, which is wall 2 subtracting a vocabulary that file cannot reach.
  const translationKeysByTree = new Map();
  for (const tree of SCANNED_TREES) {
    let bundleRaw;
    try {
      bundleRaw = await readFile(resolve(repositoryRoot, tree.bundle), "utf8");
    } catch {
      console.error(
        `\n  ${tree.bundle} could not be read; wall 2 cannot tell a concept key from copy in ${tree.prefix}.\n`,
      );
      process.exit(1);
    }
    translationKeysByTree.set(tree.prefix, bundleKeys(JSON.parse(bundleRaw)));
  }

  const inTree = files.filter(
    (path) =>
      SCANNED_TREES.some((tree) => path.startsWith(tree.prefix)) &&
      SOURCE_FILE.test(path) &&
      !GUARD_OWN_FILES.has(path),
  );
  const scanned = inTree.filter((path) => !TEST_FILE.test(path));
  const skippedTests = inTree.length - scanned.length;
  const authoring = scanned.filter((path) =>
    AUTHORING_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );

  for (const path of scanned) {
    let text;
    try {
      text = await readFile(resolve(repositoryRoot, path), "utf8");
    } catch (error) {
      // A tracked file the working tree lost. Loud, never a silent skip: a
      // traversal that quietly drops files is one that reports a clean tree.
      failures.push(`${path}: tracked but unreadable (${String(error)})`);
      continue;
    }
    const inAuthoringTree = AUTHORING_PREFIXES.some((prefix) => path.startsWith(prefix));
    const owningTree = SCANNED_TREES.find((tree) => path.startsWith(tree.prefix));
    for (const finding of analyseSource(path, text, translationKeysByTree.get(owningTree.prefix), {
      namespacedKeys: inAuthoringTree,
    })) {
      const excused = KNOWN_FINDING_PATH_EXCEPTIONS.find(
        (entry) =>
          finding.wall === "namespaced-key" &&
          entry.file === finding.file &&
          finding.detail === `"${entry.literal}"`,
      );
      if (excused !== undefined) {
        const id = `${excused.file}:${excused.literal}`;
        matchedExceptions.set(id, (matchedExceptions.get(id) ?? 0) + 1);
        continue;
      }
      // The wall KEY is in the line as well as the sentence: it is what a
      // reader greps for and what this guard's own controls assert on, and a
      // control that could only match the prose would pass on any refusal at
      // all — including one from a different rule.
      failures.push(
        `${finding.file}:${finding.line} [${finding.wall}] ${finding.detail} — ${WALL_TEXT[finding.wall]}`,
      );
    }
  }

  // An entry must declare an integer `count` of at least 1, or the
  // reconciliation below compares against `undefined` and every entry reports a
  // mismatch it cannot explain. Checked here so the FIRST entry added without
  // one fails naming itself, rather than turning the whole list red at once.
  for (const entry of KNOWN_FINDING_PATH_EXCEPTIONS) {
    if (Number.isInteger(entry.count) && entry.count >= 1) continue;
    failures.push(
      `KNOWN_FINDING_PATH_EXCEPTIONS entry "${entry.literal}" in ${entry.file} declares no integer `
      + `count >= 1 (got ${JSON.stringify(entry.count)}). Without one it excuses EVERY occurrence of `
      + "that literal in that file — declare exactly how many findings it covers",
    );
  }

  // The exemption list, reconciled in BOTH directions. An entry that no longer
  // fires has stopped describing the tree; an entry that fires more often than
  // it claims is excusing something nobody reasoned about.
  for (const entry of KNOWN_FINDING_PATH_EXCEPTIONS) {
    const id = `${entry.file}:${entry.literal}`;
    const actual = matchedExceptions.get(id) ?? 0;
    if (actual === entry.count) continue;

    if (actual === 0) {
      failures.push(
        `${id} is listed as a reasoned validation-path exception ${entry.count} time(s), which no `
        + "longer matches anything — the count went DOWN to 0. Either the path was removed or the file "
        + "moved: delete the entry so the list keeps describing the tree. Check first that the literal "
        + "CAN match NAMESPACED_KEY at all — a camelCase segment never could, which is how three of the "
        + "original six entries came to excuse nothing, a fourth being simply stale (#494)",
      );
      continue;
    }

    if (actual < entry.count) {
      failures.push(
        `${id} is listed as a reasoned validation-path exception ${entry.count} time(s), but only `
        + `${actual} matched — the count went DOWN. Part of what it excused is gone: lower the count to `
        + `${actual}, or restore what was removed`,
      );
      continue;
    }

    failures.push(
      `${id} is listed as a reasoned validation-path exception ${entry.count} time(s), but ${actual} `
      + "finding(s) matched it — the count went UP. An excusing entry is a PREDICATE, not an identity, "
      + "so a NEW hardcoded use of the same path in the same file would otherwise ride in behind the "
      + "reasoned one. Read the new occurrence off the schema, or raise the count with a reason "
      + "covering it too",
    );
  }

  // The vacuity floors, one per TREE plus the authoring subtree's. All are
  // needed: a whole tree could be scanned while the authoring subtree was
  // renamed out from under the prefixes, and a clean report over zero authoring
  // files is the exact shape of a guard that is on and measuring nothing.
  for (const tree of SCANNED_TREES) {
    const count = scanned.filter((path) => path.startsWith(tree.prefix)).length;
    if (count < tree.floor) {
      failures.push(
        `only ${count} source files under ${tree.prefix} (floor ${tree.floor}) — the file listing is broken, and a broken listing reports a clean tree`,
      );
    }
  }
  if (authoring.length < MINIMUM_AUTHORING_FILES) {
    failures.push(
      `only ${authoring.length} authoring source files (floor ${MINIMUM_AUTHORING_FILES}) — the wizard was moved or removed, so this guard is measuring nothing`,
    );
  }

  if (failures.length > 0) {
    console.error("\nThe dashboard product form must stay schema-driven (#367 step 10):\n");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "\n  services/catalog-authoring/ composes the fields, the requirements, the controlled\n" +
        "  values and the labels. Adding a product type is a DATA change; anything in these\n" +
        "  trees that knows one product type, category, attribute or value by name breaks that\n" +
        "  and breaks it silently — tsc, lint and every build job stay green.\n" +
        "\n  `packages/ui/src` is in scope since #478: the dashboard compiles the shared tree\n" +
        "  from source, so moving a hardcoded list one package sideways changes nothing about\n" +
        "  what the wizard renders.\n",
    );
    process.exit(1);
  }

  const perTree = SCANNED_TREES.map(
    (tree) => `${String(scanned.filter((path) => path.startsWith(tree.prefix)).length)} ${tree.prefix}`,
  ).join(", ");
  const translationKeyTotal = [...translationKeysByTree.values()].reduce(
    (total, keys) => total + keys.size,
    0,
  );
  console.log(
    `authoring schema-driven guard passed — ${scanned.length} source files (${perTree}) ` +
      `(${authoring.length} of them the wizard's, ${String(skippedTests)} test files skipped); 4 walls; ` +
      `${translationKeyTotal} translation keys across ${String(SCANNED_TREES.length)} bundles subtracted by wall 2, and ` +
      `${KNOWN_FINDING_PATH_EXCEPTIONS.length} reasoned validation-path exception(s) each matched ` +
      "their exact declared count.",
  );
}

// The self-test imports `analyseSource`; only a direct run scans the repository.
if (import.meta.main) {
  await main();
}
