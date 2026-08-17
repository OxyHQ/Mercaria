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
 *      heuristic about naming), and ADR 0007 D10's closed set of validation
 *      PATHS, which is a published vocabulary of the same shape.
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

/** The tree that must stay schema-driven. */
const SCANNED_PREFIX = "packages/dashboard/";

/** Where the authoring surface lives, and where the floor is measured. */
const AUTHORING_PREFIXES = [
  "packages/dashboard/lib/authoring/",
  "packages/dashboard/components/catalog-authoring/",
  "packages/dashboard/app/(app)/products/wizard/",
];

/** The app's own translation vocabulary, which wall 2 subtracts. */
const EN_BUNDLE = "packages/dashboard/lib/i18n/locales/en.json";

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

/** A dotted lowercase machine key — `PRODUCT_TYPE_KEY_PATTERN`, one dot minimum. */
const NAMESPACED_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

/**
 * ADR 0007 D10's validation PATHS — the one spelling every producer uses.
 *
 * Wall 2's shape rule cannot tell these from a concept key, because they are
 * the same shape. They are subtracted by NAME rather than by a pattern, and the
 * self-test asserts this set's EXACT size: a list of exemptions that can grow
 * without anybody noticing is a hole rather than a decision.
 *
 * `variants[<n>].…` and `fields.<key>[<n>]` are not here because the bracket
 * takes them out of the shape; only the six bare dotted forms need naming.
 */
const AUTHORING_FINDING_PATHS = new Set([
  "classification.categoryId",
  "classification.productType",
  "draft.schemaEtag",
  "draft.status",
  "listing.description",
  "listing.title",
]);

export const AUTHORING_FINDING_PATH_COUNT = AUTHORING_FINDING_PATHS.size;

/** Below these, the traversal is broken — and a broken traversal reports clean. */
const MINIMUM_SCANNED_FILES = fixtureFloors ? 1 : 60;
const MINIMUM_AUTHORING_FILES = fixtureFloors ? 1 : 10;

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
  const name = accessedName(node);
  if (name === null) return false;
  if (IDENTITY_NAMES.has(name)) return true;
  if (name !== "key") return false;
  const receiver = accessReceiver(node);
  return receiver !== null && KEY_RECEIVERS.has(receiver.replace(/^_+/u, ""));
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

    // WALL 2 — a namespaced concept key that is neither a translation key nor
    // one of D10's published validation paths. Authoring subtree only.
    const asLiteral = namespacedKeys ? literalText(node) : null;
    if (
      asLiteral !== null &&
      NAMESPACED_KEY.test(asLiteral) &&
      !translationKeys.has(asLiteral) &&
      !AUTHORING_FINDING_PATHS.has(asLiteral) &&
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
  const files = trackedFiles();

  let bundleRaw;
  try {
    bundleRaw = await readFile(resolve(repositoryRoot, EN_BUNDLE), "utf8");
  } catch {
    console.error(`\n  ${EN_BUNDLE} could not be read; wall 2 cannot tell a concept key from copy.\n`);
    process.exit(1);
  }
  const translationKeys = bundleKeys(JSON.parse(bundleRaw));

  const inTree = files.filter(
    (path) =>
      path.startsWith(SCANNED_PREFIX) && SOURCE_FILE.test(path) && !GUARD_OWN_FILES.has(path),
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
    for (const finding of analyseSource(path, text, translationKeys, {
      namespacedKeys: inAuthoringTree,
    })) {
      // The wall KEY is in the line as well as the sentence: it is what a
      // reader greps for and what this guard's own controls assert on, and a
      // control that could only match the prose would pass on any refusal at
      // all — including one from a different rule.
      failures.push(
        `${finding.file}:${finding.line} [${finding.wall}] ${finding.detail} — ${WALL_TEXT[finding.wall]}`,
      );
    }
  }

  // The vacuity floors. Both are needed: the whole tree could be scanned while
  // the authoring subtree was renamed out from under the prefixes, and a clean
  // report over zero authoring files is the exact shape of a guard that is on
  // and measuring nothing.
  if (scanned.length < MINIMUM_SCANNED_FILES) {
    failures.push(
      `only ${scanned.length} source files under ${SCANNED_PREFIX} (floor ${MINIMUM_SCANNED_FILES}) — the file listing is broken, and a broken listing reports a clean tree`,
    );
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
        "  values and the labels. Adding a product type is a DATA change; anything in this\n" +
        "  tree that knows one product type, category, attribute or value by name breaks that\n" +
        "  and breaks it silently — tsc, lint and every build job stay green.\n",
    );
    process.exit(1);
  }

  console.log(
    `authoring schema-driven guard passed — ${scanned.length} source files under ${SCANNED_PREFIX} ` +
      `(${authoring.length} of them the wizard's, ${String(skippedTests)} test files skipped); 4 walls; ` +
      `${translationKeys.size} translation keys subtracted by wall 2.`,
  );
}

// The self-test imports `analyseSource`; only a direct run scans the repository.
if (import.meta.main) {
  await main();
}
