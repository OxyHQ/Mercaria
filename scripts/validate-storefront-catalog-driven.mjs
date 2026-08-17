#!/usr/bin/env bun

/**
 * The storefront must stay catalog-driven (#367 workstream 9).
 *
 * The epic's non-negotiable for this workstream is one sentence:
 *
 * > No category-specific or product-type-specific field list, filter list, spec
 * > list or controlled value anywhere in `packages/frontend`.
 *
 * `scripts/validate-authoring-schema-driven.mjs` is the precedent and the four
 * walls below are its four, re-aimed at the READ surfaces. The fifth is this
 * workstream's own, and it is the one that had four live findings when it was
 * written.
 *
 * ## Why a guard rather than a review note
 *
 * Every shape it catches type-checks, lints, builds and renders. A storefront
 * that knows one category's filters by name looks exactly like one that reads
 * them from the server, right up until an operator publishes a new attribute and
 * nobody's screen changes — which is a defect with no error, no log line and no
 * failing job anywhere in this repository.
 *
 * ## The five walls
 *
 * **1. NO BRANCH ON A CATALOG CONCEPT'S IDENTITY.** A comparison or a `switch`
 * whose subject is one of ADR 0007 D1's identity names (`categoryId`,
 * `attributeKey`, `facetKey`, `productTypeKey`, `enumValueId`, …) and whose
 * other side is a string LITERAL — or an in-file constant BOUND to one, which
 * is the two-step version of the same thing. Plus a membership test against a
 * hardcoded LIST of values.
 *
 * Membership is narrowed to a list this tree AUTHORED — an array literal, a
 * `new Set([...])`, or an in-file constant bound to either — because the correct
 * implementation does exactly the same call against a set built from the server's
 * answer at runtime (`selected.includes(bucket.key)`), and a rule that fired on
 * those would flag the code it exists to protect.
 *
 * The catalog's closed VOCABULARIES — `origin`, `shape`, `kind`, `state`,
 * `level`, `valueType`, `availability`, `scope` — are deliberately absent from
 * the identity list. A renderer MUST switch on them: that is what makes it
 * schema-driven rather than what makes it hardcoded, and the difference is
 * whether the subject is one concept's NAME or the finite set of forms a concept
 * can take.
 *
 * **2. NO NAMESPACED CONCEPT KEY IN THE CATALOG SUBTREE.** A dotted lowercase
 * key (`electronics.phones.smartphones`, `screen_size.diagonal`) stored in a
 * constant is how wall 1 is walked around. Two subtractions make the shape rule
 * usable: the app's own `en.json` keys, and this workstream's own two path
 * literals. Scoped to the catalog subtree rather than the whole storefront, and
 * that is a real limit rather than a preference: a dotted lowercase string is
 * also what an AsyncStorage key and a package specifier look like, so repo-wide
 * this rule cannot tell a concept key from plumbing.
 *
 * **3. NO HARDCODED CONCEPT IDENTITY IN A PAYLOAD.** `{ categoryId: 'abc' }` or
 * `{ facetKey: 'condition' }` — a request whose subject was decided here rather
 * than read off a server answer. Every catalog request in this package is
 * composed from a response.
 *
 * **4. NO TRANSLATED LABEL AS IDENTITY.** A `t(...)` call in the value position
 * of an identity property. A label is presentation and is never identity
 * (ADR 0007 D1); the storefront sends the id or the stable key beside it, and
 * `lib/catalog/facet-selection.ts` is the URL grammar that has nowhere to put a
 * label.
 *
 * **5. NO RE-LISTED SERVER VOCABULARY.** An array or `new Set([...])` of two or
 * more string literals, whose declaration's type annotation mentions a type
 * IMPORTED from `@mercaria/shared-types` in that file. That is a client copy of
 * a server-owned closed set, and the reason it is a defect rather than a style
 * is enforceability: a `Record<Union, string>` cannot omit a member, so adding
 * one to the union fails `tsc` at the copy — while an ARRAY is a SUBSET that
 * goes on compiling while the control silently stops offering the new value.
 *
 * Measured: this wall had FOUR findings when it was written —
 * `compare.tsx`'s condition groups (which had silently omitted `for_parts`
 * since #90 added it), its channel and objective choice lists, and
 * `p/[handle].tsx`'s two copies of the offer-intent list. Each is now the
 * tuple plus a `Record` over the union. Copy MAPS are therefore untouched by
 * this rule, deliberately, and `analyseSource`'s controls assert both
 * directions.
 *
 * ## What this CANNOT see, stated rather than implied
 *
 * Nothing here does type resolution. A vocabulary re-listed with NO type
 * annotation is invisible to wall 5, and a cross-file constant is invisible to
 * wall 1's binding resolution. Both are residuals this guard states rather than
 * cases it silently half-covers; the shapes it does cover are the shapes the
 * findings in this repository actually took.
 *
 * Usage:  bun scripts/validate-storefront-catalog-driven.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Overridable so the self-test points the REAL guard at a scratch checkout. */
const repositoryRoot = process.env.STOREFRONT_CATALOG_VALIDATOR_ROOT
  ? resolve(process.env.STOREFRONT_CATALOG_VALIDATOR_ROOT)
  : resolve(here, "..");

/** Fixture trees are a handful of files; this lowers the floors to 1, never 0. */
const fixtureFloors = process.env.STOREFRONT_CATALOG_VALIDATOR_FIXTURE_FLOORS === "1";

const ts = createRequire(resolve(here, "../package.json"))("typescript");

/** The tree that must stay catalog-driven. */
const SCANNED_PREFIX = "packages/frontend/";

/** Where the catalog surfaces live, and where the second floor is measured. */
const CATALOG_PREFIXES = [
  "packages/frontend/lib/catalog/",
  "packages/frontend/components/catalog/",
  "packages/frontend/app/(app)/categories/",
];

/** The app's own translation vocabulary, which wall 2 subtracts. */
const EN_BUNDLE = "packages/frontend/lib/i18n/locales/en.json";

/**
 * ADR 0007 D1's identity names, as this package spells them.
 *
 * A catalog concept has an opaque `id` and a stable machine `key` and NOTHING
 * ELSE. Branching on one against a literal is per-concept truth, whatever the
 * branch is for.
 *
 * `id` on its own is deliberately absent: it is far too general — a listing id,
 * a React key, an order id — and a guard that fired on `if (a.id === b.id)`
 * would be switched off the day it landed. The narrow spellings below are the
 * ones that name a CATALOGUE concept.
 */
const IDENTITY_NAMES = new Set([
  "attributeDefinitionId",
  "attributeKey",
  "attributeName",
  "brandId",
  "bucketKey",
  "canonicalProductId",
  "canonicalVariantId",
  "categoryId",
  "categoryKey",
  "categorySlug",
  "controlledValueId",
  "enumValueId",
  "facetKey",
  "optionName",
  "productFamilyId",
  "productTypeKey",
  "rowKey",
  "valueKey",
]);

/**
 * `key` is in wall 1 too, but only when the object it is read from is a catalog
 * concept — `facet.key`, `axis.key`, `row.key`.
 *
 * A bare `key` is a React prop and a map entry, so it is matched only as a
 * property ACCESS with one of these receivers, which are the shapes that carry a
 * catalog identity under that name. `row` is here because a comparison row's
 * `key` IS the registry attribute key, and `node`/`entry` because a navigation
 * node's and a facet bucket's are identities the server minted.
 */
const KEY_RECEIVERS = new Set([
  "attribute",
  "axis",
  "bucket",
  "category",
  "definition",
  "entry",
  "facet",
  "field",
  "node",
  "option",
  "productType",
  "row",
  "tree",
  "value",
]);

/**
 * Property names whose VALUE is a concept's identity — walls 3 and 4.
 *
 * Every one has to be read off a server answer or off a route parameter, never
 * authored here.
 */
const IDENTITY_PROPERTIES = new Set([
  "attributeDefinitionId",
  "attributeKey",
  "canonicalProductId",
  "canonicalVariantId",
  "categoryId",
  "categoryKey",
  "enumValueId",
  "facetKey",
  "productTypeKey",
]);

/** Calls whose subject is a membership test — wall 1's third shape. */
const MEMBERSHIP_METHODS = new Set(["includes", "has", "startsWith", "endsWith"]);

/** A dotted lowercase machine key, one dot minimum. */
const NAMESPACED_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

/**
 * Dotted lowercase strings in the catalog subtree that are NOT concept keys.
 *
 * Wall 2's shape rule cannot tell these from a category key, because they are
 * the same shape, so they are subtracted by NAME rather than by a pattern.
 *
 * **It is EMPTY, and that is a measured state rather than an oversight.** Every
 * dotted lowercase literal in the catalog subtree today is a translation key,
 * and those are subtracted from the bundle. The first draft of this guard
 * carried one entry — `category_tree`, `useCategoryTree`'s cache-key
 * discriminant — which was INERT: `NAMESPACED_KEY` requires at least one dot
 * and that string has none, so the exemption excused a finding that could never
 * occur. An exemption that cannot fire is indistinguishable from one doing real
 * work, which is the hole this repository's exemption discipline exists to
 * close.
 *
 * So the list is reconciled in BOTH directions after the scan: an entry that
 * subtracted nothing fails the build, the same rule
 * {@link KNOWN_VOCABULARY_EXCEPTIONS} is under. Adding one is a decision with a
 * reason attached; adding a dead one is a failure.
 */
const CATALOG_PATH_LITERALS = new Set([]);

export const CATALOG_PATH_LITERAL_COUNT = CATALOG_PATH_LITERALS.size;

/** The package a re-listed vocabulary is copied FROM — wall 5. */
const VOCABULARY_PACKAGE = "@mercaria/shared-types";

/**
 * How many string literals make an array a re-listing rather than a pair.
 *
 * TWO. One string literal in an annotated array is a single-member default and
 * is not a copy of a set; two is a client deciding which members exist.
 */
const VOCABULARY_RELIST_MINIMUM = 2;

/**
 * Wall 5 findings that are reasoned and are NOT catalog vocabulary.
 *
 * Each entry names the exact declaration and why it stands. The set is
 * reconciled in BOTH directions after the scan — an entry that no longer fires
 * fails the build too — so it cannot rot into a list of things somebody once
 * silenced. Widening it is a diff with a reason attached, which is the point.
 *
 * There is deliberately only one, and it is not a catalog vocabulary: it is a
 * POLICY subset of a server-owned union — "which order statuses permit a buyer
 * cancellation" — which is legitimately a subset of the set rather than a copy
 * of it. The shape is identical to a vocabulary copy and the risk is real (the
 * backend adding a cancellable status does not reach this screen), so it is
 * recorded rather than pattern-exempted. #110 publishes
 * `CancellationEligibility` derived server-side; wiring this screen to it
 * deletes the declaration and this entry together.
 */
const KNOWN_VOCABULARY_EXCEPTIONS = [
  {
    file: "packages/frontend/app/(app)/orders/[id].tsx",
    declaration: "BUYER_CANCELLABLE",
    reason:
      "a policy subset of OrderStatus, not a catalog vocabulary; closed by reading #110's CancellationEligibility",
  },
];

export const KNOWN_VOCABULARY_EXCEPTION_COUNT = KNOWN_VOCABULARY_EXCEPTIONS.length;

/** Below these, the traversal is broken — and a broken traversal reports clean. */
const MINIMUM_SCANNED_FILES = fixtureFloors ? 1 : 120;
const MINIMUM_CATALOG_FILES = fixtureFloors ? 1 : 8;

/** The guard cannot be its own subject; neither file lives under the prefix anyway. */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-storefront-catalog-driven.mjs",
  "scripts/test-validate-storefront-catalog-driven.mjs",
]);

const SOURCE_FILE = /\.tsx?$/;

/**
 * A test file, which every wall deliberately skips.
 *
 * A test's job is to name specific values: a fixture facet keyed `color`, a
 * variant axis called `storage`, a subject with a known variant id. Every one of
 * those is what the walls exist to refuse in PRODUCTION code and what a test
 * cannot do without. Measured: `lib/catalog/__tests__/composition.test.ts`
 * produced eleven findings, all of them fixtures, none of them a defect.
 *
 * This is a CATEGORY rather than a hand-maintained list of paths, which is what
 * keeps it from being the kind of exemption that rots — there is nothing to
 * update when a test is added. What keeps it honest is the control in the
 * self-test: the SAME source, at a non-test path, must still be refused by every
 * wall. An exclusion that could swallow production code would fail that case.
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

/** The elements of an array literal or a `new Set([...])`, or `null`. */
function listElements(node) {
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Set" &&
    node.arguments !== undefined &&
    node.arguments[0] !== undefined &&
    ts.isArrayLiteralExpression(node.arguments[0])
  ) {
    return node.arguments[0].elements;
  }
  return null;
}

/** Whether a node is an array literal or a `new Set([...])` of string literals. */
function literalValueList(node) {
  const elements = listElements(node);
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
 * This is what makes the two-step evasion visible: binding a category's key to a
 * constant and comparing against THAT is the same branch with one more line.
 * Resolution is per FILE and deliberately shallow — see the header's residuals.
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

/**
 * Every type name this file imports from `@mercaria/shared-types` — wall 5.
 *
 * The import LIST is the signal, not a type checker: a name bound here to that
 * package is a server-owned vocabulary, and an array annotated with it is a
 * client copy of a closed set. Both `import type {…}` and a value import count,
 * because `import { CONDITION_GROUPS, type ConditionGroup }` is one statement.
 */
function vocabularyTypeNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (literalText(statement.moduleSpecifier) !== VOCABULARY_PACKAGE) continue;
    const clause = statement.importClause;
    if (clause?.namedBindings === undefined) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) names.add(element.name.text);
  }
  return names;
}

/** Whether a type node mentions any of the given names, anywhere in its subtree. */
function typeMentions(typeNode, names) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return found;
}

/**
 * How many string literals a list-shaped initializer carries.
 *
 * Counts both a bare member (`['new', 'used']`) and a member's `value`, `key`
 * or `id` property (`[{ value: 'new', label: … }]`) — the second is the shape
 * both of `compare.tsx`'s findings took, and a rule reading only the first
 * would have flagged one of the three real cases.
 */
function vocabularyLiteralCount(node) {
  const elements = listElements(node);
  if (elements === null) return 0;
  let count = 0;
  for (const element of elements) {
    if (literalText(element) !== null) {
      count += 1;
      continue;
    }
    if (!ts.isObjectLiteralExpression(element)) continue;
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
      if (name !== "value" && name !== "key" && name !== "id") continue;
      if (literalText(property.initializer) !== null) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

// ----------------------------------------------------------- the analyser ---

/**
 * Analyse ONE source file against the five walls.
 *
 * Exported so the controls run production's own code path over control SOURCE,
 * rather than asserting against a second copy of the rules.
 */
export function analyseSource(relativePath, text, translationKeys, options = {}) {
  const namespacedKeys = options.namespacedKeys ?? true;
  // Which path-literal exemptions actually subtracted a finding. The caller
  // reconciles it: an exemption that never fires is one nobody can tell from an
  // exemption doing real work.
  const subtracted = options.subtractedPathLiterals;
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = collectLiteralBindings(sourceFile);
  const vocabularyTypes = vocabularyTypeNames(sourceFile);
  const findings = [];

  const report = (node, wall, detail) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file: relativePath, line: line + 1, wall, detail });
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

    // WALL 2 — a namespaced concept key. Catalog subtree only.
    const asLiteral = namespacedKeys ? literalText(node) : null;
    if (
      asLiteral !== null &&
      NAMESPACED_KEY.test(asLiteral) &&
      !translationKeys.has(asLiteral) &&
      !isModuleSpecifier(node)
    ) {
      if (CATALOG_PATH_LITERALS.has(asLiteral)) subtracted?.add(asLiteral);
      else report(node, "namespaced-key", `"${asLiteral}"`);
    }

    // WALLS 3 and 4 — an identity property whose value was decided HERE.
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
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

    // WALL 5 — a server-owned vocabulary, re-listed under its own type.
    if (
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      node.initializer !== undefined &&
      vocabularyTypes.size > 0 &&
      typeMentions(node.type, vocabularyTypes)
    ) {
      const count = vocabularyLiteralCount(node.initializer);
      if (count >= VOCABULARY_RELIST_MINIMUM) {
        const declared = ts.isIdentifier(node.name) ? node.name.text : "a declaration";
        report(
          node,
          "vocabulary-relisting",
          `${declared} re-lists ${count} members of a ${VOCABULARY_PACKAGE} vocabulary`,
        );
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
    "branches on a catalogue concept's identity. The server decides which categories, attributes and values exist; a client that knows one by name holds truth a data change cannot reach (ADR 0007 D1).",
  "namespaced-key":
    "carries a namespaced concept key. A category, product type or attribute key in this tree is per-concept truth even when nothing branches on it yet.",
  "hardcoded-identity":
    "hardcodes a concept identity into a payload. Every catalog request here is composed from a server answer or a route parameter.",
  "label-as-identity":
    "sends a TRANSLATED string as identity. A label is presentation and is never identity (ADR 0007 D1); send the id or the stable key beside it.",
  "vocabulary-relisting":
    "re-lists a server-owned closed set as an ARRAY. Import the tuple and, where copy is needed, put it in a Record over the union — a Record cannot omit a member, an array silently can.",
};

async function main() {
  const failures = [];
  const matchedExceptions = new Set();
  const subtractedPathLiterals = new Set();
  const files = trackedFiles();

  let bundleRaw;
  try {
    bundleRaw = await readFile(resolve(repositoryRoot, EN_BUNDLE), "utf8");
  } catch {
    console.error(
      `\n  ${EN_BUNDLE} could not be read; wall 2 cannot tell a concept key from copy.\n`,
    );
    process.exit(1);
  }
  const translationKeys = bundleKeys(JSON.parse(bundleRaw));

  const inTree = files.filter(
    (path) =>
      path.startsWith(SCANNED_PREFIX) && SOURCE_FILE.test(path) && !GUARD_OWN_FILES.has(path),
  );
  const scanned = inTree.filter((path) => !TEST_FILE.test(path));
  const skippedTests = inTree.length - scanned.length;
  const catalog = scanned.filter((path) =>
    CATALOG_PREFIXES.some((prefix) => path.startsWith(prefix)),
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
    const inCatalogTree = CATALOG_PREFIXES.some((prefix) => path.startsWith(prefix));
    for (const finding of analyseSource(path, text, translationKeys, {
      namespacedKeys: inCatalogTree,
      subtractedPathLiterals,
    })) {
      const excused = KNOWN_VOCABULARY_EXCEPTIONS.find(
        (entry) =>
          finding.wall === "vocabulary-relisting" &&
          entry.file === finding.file &&
          finding.detail.startsWith(`${entry.declaration} `),
      );
      if (excused !== undefined) {
        matchedExceptions.add(`${excused.file}:${excused.declaration}`);
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

  // Both exemption lists, reconciled in BOTH directions. An entry that no
  // longer fires has stopped describing the tree, and a list that can only grow
  // is one nobody removes anything from.
  for (const literal of CATALOG_PATH_LITERALS) {
    if (!subtractedPathLiterals.has(literal)) {
      failures.push(
        `"${literal}" is listed as a non-concept path literal and subtracted nothing — remove the entry, or it excuses a finding that cannot occur`,
      );
    }
  }
  for (const entry of KNOWN_VOCABULARY_EXCEPTIONS) {
    const id = `${entry.file}:${entry.declaration}`;
    if (!matchedExceptions.has(id)) {
      failures.push(
        `${id} is listed as a reasoned wall-5 exception and no longer produces a finding — remove the entry`,
      );
    }
  }

  // The vacuity floors. Both are needed: the whole storefront could be scanned
  // while the catalog subtree was renamed out from under the prefixes, and a
  // clean report over zero catalog files is the exact shape of a guard that is
  // on and measuring nothing.
  if (scanned.length < MINIMUM_SCANNED_FILES) {
    failures.push(
      `only ${scanned.length} source files under ${SCANNED_PREFIX} (floor ${MINIMUM_SCANNED_FILES}) — the file listing is broken, and a broken listing reports a clean tree`,
    );
  }
  if (catalog.length < MINIMUM_CATALOG_FILES) {
    failures.push(
      `only ${catalog.length} catalog source files (floor ${MINIMUM_CATALOG_FILES}) — the catalog surfaces were moved or removed, so this guard is measuring nothing`,
    );
  }

  if (failures.length > 0) {
    console.error("\nThe storefront must stay catalog-driven (#367 workstream 9):\n");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "\n  The taxonomy, the navigation trees, the attribute registry and the facet rail\n" +
        "  decide which categories, filters, specifications and values exist. Adding one is\n" +
        "  a DATA change; anything in this tree that knows a category, product type,\n" +
        "  attribute or value by name breaks that and breaks it silently — tsc, lint and\n" +
        "  every build job stay green.\n",
    );
    process.exit(1);
  }

  console.log(
    `storefront catalog-driven guard passed — ${scanned.length} source files under ${SCANNED_PREFIX} ` +
      `(${catalog.length} of them the catalog surfaces', ${String(skippedTests)} test files ` +
      `skipped); 5 walls; ` +
      `${translationKeys.size} translation keys and ` +
      `${String(CATALOG_PATH_LITERALS.size)} named literals subtracted by wall 2; ` +
      `${String(KNOWN_VOCABULARY_EXCEPTIONS.length)} reasoned wall-5 exception(s), all still firing.`,
  );
}

// The self-test imports `analyseSource`; only a direct run scans the repository.
if (import.meta.main) {
  await main();
}
