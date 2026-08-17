#!/usr/bin/env bun

/**
 * The dashboard and the POS must stay translated (#398).
 *
 * ## Why a guard rather than a memory
 *
 * Extracting a surface's strings is a one-time act; keeping it extracted is a
 * standing requirement, and the way it gets undone is one `<Text>Save</Text>` at
 * a time in unrelated PRs. Every one of those is invisible to everything else in
 * CI: the JSX is valid, `tsc` is happy, lint is happy and every build job passes.
 * The merchant whose device is in German just sees one English word, and nobody
 * finds out until somebody reads that screen in German.
 *
 * The second failure it exists for is quieter still. `i18n-js` runs with
 * `enableFallback` on, so a key missing from `de.json` silently renders the
 * ENGLISH string, and a key missing from EVERY bundle renders `missingBehavior:
 * 'guess'` — a humanised spelling of the key, which in review looks like a
 * translation somebody wrote. Both look correct. Neither is.
 *
 * ## What it checks
 *
 *   A. NO HARDCODED USER-FACING STRING in the migrated surface — JSX text, a
 *      string in a JSX child expression, a user-facing JSX attribute, a
 *      user-facing object property, or an argument to one of a short NAMED list
 *      of calls that carry copy through a plain function (`Alert.alert`,
 *      `toast.*`, `useRailTooltip`).
 *
 *   B. BUNDLE PARITY — every non-`en` bundle has exactly `en`'s key set (missing
 *      AND extra), and every value carries exactly `en`'s `%{placeholders}`. A
 *      missing key falls back to English and looks fine; a renamed placeholder
 *      renders the literal `%{count}` to a merchant.
 *
 *   C. REFERENTIAL INTEGRITY — every `t('literal')` names a key that exists in
 *      that app's `en.json`, and every key in `en.json` is named by some string
 *      literal in that app's source.
 *
 *   D. THE RESERVED NAMESPACE (#437) — `@mercaria/ui` ships its OWN copy, which
 *      `mergeSharedUiCopy` merges into every app's i18n instance under the
 *      top-level key `ui`. So every shared bundle's only top-level key is `ui`,
 *      and no APP bundle may have one. Both lists are derived from the tracked
 *      file listing rather than written out here, so a fourth app is covered on
 *      the day it appears.
 *
 *   E. THE PROVIDER IS MOUNTED (#437) — every app's root layout mounts
 *      `<SharedUiTranslationProvider>`. Without it a shared component silently
 *      resolves against `@mercaria/ui`'s own English, which is what shipped
 *      before #437 and is therefore invisible in review.
 *
 * ## What C buys that A cannot
 *
 * A decides only the positions it can decide from the syntax. It cannot see a
 * plain map of status labels — `{ paid: 'Paid', shipped: 'Shipped' }` — because
 * the property names there are statuses, not user-facing prop names, and a
 * detector loose enough to catch it would fire on every Tailwind class and
 * permission string in the tree.
 *
 * The migrated code stores KEYS in those maps (`{ paid: 'orders.status.paid' }`)
 * and calls `t()` at the use site. So writing English back into one leaves
 * `orders.status.paid` referenced by nothing, and C fails naming it. That is the
 * mutation this guard was tested on, and it is why C refuses UNUSED keys rather
 * than only missing ones.
 *
 * ## Scope
 *
 * Check A runs over `packages/dashboard` and `packages/pos`. `packages/frontend`
 * is deliberately NOT scanned by it: its own extraction (#396) covers part of
 * the app and adding it here would be a gate over an unmigrated tree, which is
 * one whoever hits it first disables. Converging it onto the shared registry is
 * #435.
 *
 * `packages/ui` is scanned by B and C and deliberately NOT by A, for exactly
 * that reason one package over: #437 converted the condition and offer-label
 * copy and the rest of the package's component prose is still English. What B
 * and C buy there is the whole point of #437 — a shared sentence exists in
 * twelve languages and stays referenced — and neither of them needs the package
 * to be finished first. Widening A to `packages/ui` is the residual on #437.
 *
 * D and E cover every app, including the storefront: they are about the
 * PLUMBING (a reserved namespace, a mounted provider) rather than about copy,
 * so an unmigrated tree has nothing to be excused from.
 *
 * Usage:  bun scripts/validate-i18n-strings.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The tree to scan. Overridable so the self-test can point the REAL guard at a
 * scratch checkout instead of asserting against a copy of its own logic.
 */
const repositoryRoot = process.env.I18N_VALIDATOR_ROOT
  ? resolve(process.env.I18N_VALIDATOR_ROOT)
  : resolve(here, "..");

/**
 * Fixture trees are a handful of files and a handful of keys, so the real floors
 * would fail every self-test case for the wrong reason. This lowers them to 1 —
 * it never removes them, so a fixture run still catches a traversal that found
 * nothing.
 */
const fixtureFloors = process.env.I18N_VALIDATOR_FIXTURE_FLOORS === "1";

// Resolved from THIS repository rather than from the tree being scanned, so a
// fixture root with no node_modules of its own still parses.
const ts = createRequire(resolve(here, "../package.json"))("typescript");

/**
 * Everything that OWNS a bundle set.
 *
 * `hardcodedStrings` is what separates a migrated app from a package that is
 * only PART way through: `packages/ui` is scanned for literals (part C needs
 * them) and its check-A findings are discarded, because most of that package's
 * component prose is still English and a gate over it would be switched off by
 * whoever hit it. It is a real distinction, not a special case — the next
 * package to start extracting joins the list with the flag off, and turns it on
 * in the change that finishes.
 */
const OWNERS = [
  {
    name: "dashboard",
    prefix: "packages/dashboard/",
    locales: "packages/dashboard/lib/i18n/locales",
    hardcodedStrings: true,
    // Per-owner rather than one total: a traversal that broke for one of them
    // would otherwise hide behind another's count.
    minimumSourceFiles: 60,
    minimumTranslatedPositions: 300,
    minimumKeys: 300,
    // Part B compares every sibling bundle against `en`, so with the siblings
    // gone it compares nothing and reports clean. Eleven of the registry's
    // twelve locales; `ar` waits on the layout mirroring (#434).
    minimumLocales: 11,
  },
  {
    name: "pos",
    prefix: "packages/pos/",
    locales: "packages/pos/lib/i18n/locales",
    hardcodedStrings: true,
    minimumSourceFiles: 30,
    minimumTranslatedPositions: 60,
    minimumKeys: 60,
    minimumLocales: 11,
  },
  {
    name: "ui",
    prefix: "packages/ui/",
    locales: "packages/ui/src/i18n/locales",
    hardcodedStrings: false,
    minimumSourceFiles: 50,
    // No translated-position floor, deliberately. `inspectUserFacing` credits
    // any value it cannot follow to a literal as "translated", and in a package
    // that is mostly UNextracted that count would be large, stable and
    // meaningless — a floor whose passing says nothing is worse than none,
    // because it reads as coverage. The floors that bite here are the source
    // file count above and the key count below, and the check that actually
    // catches a map put back on English is C.
    minimumTranslatedPositions: null,
    // The 51 leaves #437 landed. All twelve registry locales: this package IS
    // the registry's home, so it can never be behind an app — and that it has
    // one bundle per `SupportedLocale` is enforced where it belongs, by
    // `SHARED_UI_COPY` being a `Record` rather than a `Partial<Record>`, which
    // `bun run --filter @mercaria/ui typecheck` decides.
    minimumKeys: 51,
    minimumLocales: 12,
  },
];

/** The reserved top-level key `mergeSharedUiCopy` merges shared copy under. */
const SHARED_UI_NAMESPACE = "ui";

/** The owner whose bundles ARE the shared copy — the only one that may use it. */
const SHARED_UI_OWNER = "ui";

/** The component every app's root layout must mount (#437 check E). */
const SHARED_UI_PROVIDER = "SharedUiTranslationProvider";

/**
 * Every app root, DERIVED from the tracked listing rather than written out.
 *
 * A hand list would silently skip a fourth app — and "the guard found fewer
 * roots" looks exactly like "there are fewer roots". The floor below is what
 * tells them apart.
 */
const ROOT_LAYOUT = /^packages\/[^/]+\/app\/_layout\.tsx$/;
const MINIMUM_ROOT_LAYOUTS = fixtureFloors ? 1 : 3;

/** Every app's locale directory, derived the same way, for check D. */
const APP_LOCALE_BUNDLE = /^packages\/[^/]+\/lib\/i18n\/locales\/[^/]+\.json$/;
const MINIMUM_APP_BUNDLES = fixtureFloors ? 1 : 30;

// Bundles are DATA and are never analysed for hardcoded strings — every value in
// one IS a user-facing string. They are read as JSON by parts B and C instead.
const SOURCE_FILE = /\.tsx?$/;

/**
 * JSX attributes whose string value a person reads.
 *
 * Derived from a census of what actually carries prose in these two packages,
 * plus the near neighbours a new component would reach for. Everything the
 * census showed carrying an IDENTIFIER rather than prose — `className`,
 * `variant`, `size`, `permission`, `href`, `name`, `content`, `type`,
 * `keyboardType`, `accessibilityRole` — is deliberately absent: a guard that
 * flagged `className="px-4"` would be switched off the day it landed.
 */
const USER_FACING_JSX_ATTRIBUTES = new Set([
  "accessibilityHint",
  "accessibilityLabel",
  "actionLabel",
  "alt",
  "body",
  "cancelText",
  "confirmText",
  "description",
  "emptyText",
  "heading",
  "headline",
  "hint",
  "label",
  "message",
  "placeholder",
  "submitText",
  "subtitle",
  "title",
]);

/**
 * Object-literal properties whose string value a person reads — the nav model's
 * `label`, an empty state's `heading`, a channel warning's `body`.
 *
 * `action` is here and NOT in the attribute set above: the census found it only
 * as a property (`action: "Set up payouts"`), while as a JSX attribute it is far
 * more likely to be a handler or a form target.
 */
const USER_FACING_OBJECT_PROPERTIES = new Set([
  "action",
  "actionLabel",
  "body",
  "description",
  "heading",
  "headline",
  "hint",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "title",
]);

/**
 * Calls whose string arguments are shown to a person.
 *
 * The three shapes in this surface that carry copy through a plain function
 * rather than through a prop: a native alert, a toast, and the sidebar rail's
 * hover tooltip. Deliberately a short, named list — "any call taking a string"
 * would flag every `fetch`, every query key and every `router.push`.
 */
const USER_FACING_CALLEES = new Set([
  "Alert.alert",
  "Alert.prompt",
  "toast.error",
  "toast.info",
  "toast.success",
  "toast.warning",
  "useRailTooltip",
]);

/** Below this, the file listing is broken — and a broken listing reports a clean tree. */
const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 60;

/** Fixture trees are tiny, so the per-app floors above drop to 1 — never to 0. */
const floorFor = (value) => (fixtureFloors ? 1 : value);

/**
 * The guard cannot be its own subject: this file and its self-test both spell
 * out the shapes they exist to catch. Neither lives under a scanned prefix, so
 * this is belt-and-braces against someone moving them.
 */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-i18n-strings.mjs",
  "scripts/test-validate-i18n-strings.mjs",
]);

/**
 * There is deliberately NO exception list.
 *
 * Every other guard in `scripts/` carries one, because each excuses a real
 * constraint somebody hit (a `borderInline*` React Native never registered, a
 * dependency that cannot be removed yet). This one has no such case: a string in
 * these two apps is either COPY, in which case the remedy is one key and costs
 * nothing, or an IDENTIFIER, in which case no detector here looks at it.
 *
 * That matters because the cheapest way to go green decides what people
 * actually do. With an exception list, the cheapest green for an awkward string
 * is an entry nobody revisits. Without one it is `t('some.key')`, which is the
 * correct action — and for a string that genuinely must read the same in every
 * language (a brand name, a currency symbol) a key holding it is right anyway:
 * some languages transliterate, and the decision then lives in the bundle where
 * a translator can see it.
 *
 * The escape hatch that DOES exist is renaming a prop out of the detector sets
 * above, and it is a visible, reviewable edit to this file rather than a silent
 * one to a screen.
 */

// --------------------------------------------------------------- utilities ---

const failures = [];
const findings = [];

/** Every file git tracks, repo-relative — so ignored and generated files cannot count. */
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

const hasLetter = (value) => /\p{L}/u.test(value);

/** The literal chunks of a template, so `` `${n} items` `` is seen as "items". */
function templateChunks(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
}

/** A string-ish literal's readable text, or `null` if the node is not one. */
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    const chunks = templateChunks(node).filter(hasLetter);
    return chunks.length > 0 ? chunks.join(" ") : null;
  }
  return null;
}

/**
 * A translation call: the bare `t(...)` every screen uses, or a `.t(...)` on
 * something (`i18n.t(...)`). Matched by the callee's NAME rather than by
 * resolving it — this is a syntactic guard, and the cost of the loose match is
 * that a variable called `t` holding something else would read as translated.
 * Nothing in either app has one, and part C is what keeps the far end honest.
 */
const isTranslateCall = (node) =>
  ts.isCallExpression(node)
  && ((ts.isIdentifier(node.expression) && node.expression.text === "t")
    || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t"));

/** The dotted name of a call's callee, for the `Alert.alert` check. */
function calleeName(node) {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    return `${target.expression.text}.${target.name.text}`;
  }
  return null;
}

// ----------------------------------------------------------- the analyser ---

/**
 * Analyse ONE source file.
 *
 * Returns the hardcoded-string findings, the number of TRANSLATED positions it
 * saw, and every string literal in the file (part C reads the last of these to
 * decide which keys are referenced).
 *
 * `knownKeys` is the app's own vocabulary — every key its `en.json` can resolve,
 * including the parent of a pluralised pair. It is what lets rule 3's remedy
 * through: module-scope data holds KEYS (`{ label: "nav.register" }`), and a
 * guard that flagged those would be flagging the fix. Passing the REAL key set
 * rather than matching a key-SHAPED string is the difference that matters — a
 * typo'd `"nav.regsiter"` still fails, where a shape rule would wave it past and
 * the screen would render a humanised guess of the misspelling.
 *
 * Exported shape rather than inline code so the positive and negative controls
 * below run production's own code path over control SOURCE, rather than
 * asserting against a second copy of the rules.
 */
export function analyseSource(relativePath, text, knownKeys) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fileFindings = [];
  const literals = [];
  /** `{ key, line }` for every `t('literal')`, so part C can resolve each one. */
  const translateKeys = [];
  let translatedPositions = 0;

  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const report = (node, kind, value) => {
    fileFindings.push({
      file: relativePath,
      line: lineOf(node),
      kind,
      text: value.trim().replace(/\s+/g, " ").slice(0, 120),
    });
  };

  /**
   * Walk an expression that sits in a user-facing POSITION and report any
   * readable literal in it.
   *
   * Descends through the shapes a screen legitimately uses — a ternary, `??`,
   * a `&&`, a parenthesis — and stops at the two boundaries that have their own
   * handling: a `t()` argument (that is the remedy, not the defect) and nested
   * JSX (whose children and attributes are visited by the main walk).
   */
  const inspectUserFacing = (node, kind) => {
    if (!node) return;
    if (isTranslateCall(node)) {
      translatedPositions += 1;
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return;

    const value = literalText(node);
    if (value !== null) {
      if (knownKeys.has(value)) {
        translatedPositions += 1;
        return;
      }
      if (hasLetter(value)) report(node, kind, value);
      return;
    }
    if (ts.isParenthesizedExpression(node)) return inspectUserFacing(node.expression, kind);
    if (ts.isConditionalExpression(node)) {
      inspectUserFacing(node.whenTrue, kind);
      inspectUserFacing(node.whenFalse, kind);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      inspectUserFacing(node.left, kind);
      inspectUserFacing(node.right, kind);
      return;
    }
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)
      || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) {
      // A value composed elsewhere. Following it is a type-checker's job, not a
      // syntactic guard's; part C is what keeps the far end honest.
      translatedPositions += 1;
    }
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
    }

    // C. every `t('literal')` names a key the bundle must hold.
    if (isTranslateCall(node)) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        translateKeys.push({ key: first.text, line: lineOf(first) });
      }
    }

    // A. JSX text: `<Text>Save</Text>`
    if (ts.isJsxText(node) && hasLetter(node.text)) {
      report(node, "jsx-text", node.text);
    }

    // A. A JSX CHILD expression: `<Text>{"Save"}</Text>`, `{n} item{n === 1 ? "" : "s"}`
    if (
      ts.isJsxExpression(node)
      && node.expression
      && node.parent
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      inspectUserFacing(node.expression, "jsx-child");
    }

    // A. A user-facing ATTRIBUTE: `placeholder="Search"`
    if (
      ts.isJsxAttribute(node)
      && ts.isIdentifier(node.name)
      && USER_FACING_JSX_ATTRIBUTES.has(node.name.text)
      && node.initializer
    ) {
      const value = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      inspectUserFacing(value, `attribute:${node.name.text}`);
    }

    // A. A user-facing object PROPERTY: `{ label: "Register" }`
    if (
      ts.isPropertyAssignment(node)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && USER_FACING_OBJECT_PROPERTIES.has(node.name.text)
    ) {
      inspectUserFacing(node.initializer, `property:${node.name.text}`);
    }

    // A. `Alert.alert("Deleted", "The product is gone.")`, `toast.error("…")`,
    // `useRailTooltip("Expand sidebar")`
    {
      const callee = ts.isCallExpression(node) ? calleeName(node) : null;
      if (callee !== null && USER_FACING_CALLEES.has(callee)) {
        for (const argument of node.arguments) inspectUserFacing(argument, `call:${callee}`);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { findings: fileFindings, translatedPositions, literals, translateKeys };
}

/**
 * Does this source MOUNT `<SharedUiTranslationProvider>`? (check E)
 *
 * Written from the IDIOM — a JSX element whose tag is that name — rather than
 * from a substring or a regex. The difference is what the three negative
 * controls below cover: an import of the symbol, a comment naming it and a
 * string mentioning it are all things a repository legitimately contains, and a
 * substring check would accept every one of them as proof the provider is
 * mounted. It cannot tell WHERE in the tree the element sits, which is stated
 * in `ui-translation.tsx` rather than implied here.
 *
 * Exported for the same reason `analyseSource` is: the controls run production's
 * own code path over control SOURCE rather than asserting against a second copy
 * of the rule.
 */
export function mountsSharedUiProvider(relativePath, text) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let mounted = false;
  const visit = (node) => {
    if (mounted) return;
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName)
      && node.tagName.text === SHARED_UI_PROVIDER
    ) {
      mounted = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mounted;
}

/** Flatten a bundle to `a.b.c` -> string, refusing a non-string leaf. */
function flatten(value, prefix, into, file) {
  for (const [name, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof child === "string") {
      into.set(path, child);
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      flatten(child, path, into, file);
    } else {
      failures.push(
        `${file}: "${path}" is ${Array.isArray(child) ? "an array" : typeof child}. A bundle holds `
        + "strings and nested objects only — i18n-js renders anything else as [object Object].",
      );
    }
  }
}

/**
 * CLDR plural categories. A pluralised key is a nested object, so `en.json`
 * flattens to `cart.lineCount.one` / `.other` while the call site names only
 * `cart.lineCount` — part C would otherwise report both leaves as unused.
 *
 * Deliberately narrow: the parent is credited only when the LAST segment is one
 * of these six words. A general "any prefix counts" rule would let the stray
 * literal `"orders"` in a query key mark every `orders.*` key used, which is
 * most of a bundle.
 */
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);

function pluralParentOf(key) {
  const cut = key.lastIndexOf(".");
  if (cut < 0) return null;
  return PLURAL_CATEGORIES.has(key.slice(cut + 1)) ? key.slice(0, cut) : null;
}

const PLACEHOLDER = /%\{([^}]+)\}/g;
const placeholdersOf = (value) =>
  [...value.matchAll(PLACEHOLDER)].map((match) => match[1]).sort().join(",");

/** Every key `t()` can resolve: the leaves, plus the parent of a plural pair. */
function resolvableKeys(flat) {
  const keys = new Set(flat.keys());
  for (const key of flat.keys()) {
    const parent = pluralParentOf(key);
    if (parent !== null) keys.add(parent);
  }
  return keys;
}

/**
 * Read a tracked file, or record WHY it could not be read and carry on.
 *
 * `git ls-files` reports the INDEX, which can name a file the working tree does
 * not have. Reading that as a FAILURE keeps the run loud rather than ending it
 * with a stack trace and no verdict.
 */
async function readTracked(path) {
  try {
    return await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    failures.push(
      `${path} is tracked by git but could not be read (${error.code ?? error.message}) — `
      + "the working tree disagrees with the index, so this scan was incomplete",
    );
    return null;
  }
}

// --------------------------------------------------------- the vocabularies ---

// Read BEFORE the sources, because the analyser needs each app's key set: rule
// 3's remedy puts KEYS into module-scope data, and only the real vocabulary can
// tell `label: "nav.register"` (correct) from `label: "nav.regsiter"` (a typo
// that renders a humanised guess at a merchant).

const tracked = trackedFiles();

/** owner name -> locale path -> flattened `a.b.c` -> value. */
const bundlesByApp = new Map();
/** Every bundle path anywhere -> its TOP-LEVEL keys, for check D. */
const topLevelKeysByPath = new Map();
for (const app of OWNERS) {
  const bundlePaths = tracked.filter(
    (path) => path.startsWith(`${app.locales}/`) && path.endsWith(".json"),
  );
  if (bundlePaths.length === 0) {
    failures.push(
      `${app.name}: no locale bundles under ${app.locales} — the scan found nothing to check`,
    );
  }
  const flatByLocale = new Map();
  for (const path of bundlePaths) {
    const text = await readTracked(path);
    if (text === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      failures.push(`${path}: not valid JSON (${error.message})`);
      continue;
    }
    topLevelKeysByPath.set(path, Object.keys(parsed));
    const flat = new Map();
    flatten(parsed, "", flat, path);
    flatByLocale.set(path, flat);
  }
  bundlesByApp.set(app.name, flatByLocale);
}

const knownKeysByApp = new Map(
  OWNERS.map((app) => [
    app.name,
    resolvableKeys(bundlesByApp.get(app.name)?.get(`${app.locales}/en.json`) ?? new Map()),
  ]),
);

// -------------------------------------------------------------- controls ----

/**
 * POSITIVE AND NEGATIVE CONTROLS.
 *
 * Both run the REAL `analyseSource` over control SOURCE, on every invocation
 * including in CI — a control that only runs in the self-test says nothing about
 * the run that actually gated the merge. A detector that silently stopped
 * detecting (a renamed `ts` predicate, a lost `parent` link, an editor mangling
 * the file) would otherwise report a clean tree, which is what a clean tree
 * reports.
 */
const CONTROL_MUST_FIND = [
  { id: "jsx-text", source: "const A = () => <Text>Save changes</Text>;" },
  { id: "jsx-child-string", source: 'const A = () => <Text>{"Save changes"}</Text>;' },
  { id: "jsx-child-template", source: "const A = () => <Text>{`${n} items in cart`}</Text>;" },
  { id: "jsx-child-ternary", source: 'const A = () => <Text>{n === 1 ? "item" : "items"}</Text>;' },
  { id: "attribute", source: 'const A = () => <Input placeholder="Search products" />;' },
  { id: "attribute-expression", source: 'const A = () => <Input placeholder={"Search products"} />;' },
  { id: "object-property", source: 'export const NAV = [{ key: "a", label: "Register" }];' },
  { id: "alert-argument", source: 'Alert.alert("Deleted", "The product is gone.");' },
  { id: "toast-argument", source: 'toast.error("Could not save the product.");' },
  { id: "tooltip-argument", source: 'const tip = useRailTooltip("Expand sidebar");' },
];

/**
 * Spellings that must NEVER fire. The Tailwind class, the route, the permission
 * and the query key are all real in this tree, and a guard that flagged them
 * would be turned off within a day. The last four are the remedy itself.
 */
const CONTROL_MUST_NOT_FIND = [
  'const A = () => <View className="flex-row items-center gap-2 px-4" />;',
  'export const NAV = [{ key: "orders", href: "/orders", permission: "orders:read" }];',
  'const key = ["stores", storeId, "products"] as const;',
  'const A = () => <Input keyboardType="url" autoCapitalize="none" />;',
  'const A = () => <Text>{t("register.title")}</Text>;',
  'const A = () => <Input placeholder={t("products.searchPlaceholder")} />;',
  'export const NAV = [{ key: "a", label: "nav.register" }];',
  'Alert.alert(t("products.deleted"), t("products.deletedBody"));',
  'toast.error(error.message);',
  'const tip = useRailTooltip(t("nav.register"));',
  'const response = await fetch("/api/products", { method: "POST" });',
];

/**
 * The vocabulary the controls are measured against. Written out rather than
 * borrowed from an app, so a control keeps meaning the same thing after somebody
 * renames a real key — and so the "a key-shaped string that is NOT a key still
 * fails" case below has something to be absent from.
 */
const CONTROL_KEYS = new Set([
  "a.b",
  "c.d",
  "nav.register",
  "products.deleted",
  "products.deletedBody",
  "products.searchPlaceholder",
  "register.title",
]);

for (const control of CONTROL_MUST_FIND) {
  const { findings: found } = analyseSource(
    `control/${control.id}.tsx`,
    control.source,
    CONTROL_KEYS,
  );
  if (found.length === 0) {
    failures.push(
      `positive control failed: ${control.id} produced no finding for ${JSON.stringify(control.source)} — `
      + "the analyser is broken, and a broken analyser reports a clean tree",
    );
  }
}
for (const source of CONTROL_MUST_NOT_FIND) {
  const { findings: found } = analyseSource("control/negative.tsx", source, CONTROL_KEYS);
  if (found.length > 0) {
    failures.push(
      `negative control failed: ${JSON.stringify(source)} produced ${found.length} finding(s) `
      + `(${found.map((f) => f.kind).join(", ")}) — the analyser is too broad and would be `
      + "disabled by whoever hit it",
    );
  }
}
// The remedy must also register as translated, or the vacuity floor below is
// measuring something other than what it claims to.
{
  const remedy = analyseSource(
    "control/translated.tsx",
    'const A = () => <><Text>{t("a.b")}</Text><Input placeholder={t("c.d")} /></>;',
    CONTROL_KEYS,
  );
  if (remedy.translatedPositions < 2) {
    failures.push(
      `positive control failed: a file with two t() positions counted ${remedy.translatedPositions} — `
      + "the translated-position floor cannot detect a broken traversal",
    );
  }
}

/**
 * Controls for check E's detector, run on every invocation for the same reason.
 *
 * The three that must NOT fire are the whole point: an import, a comment and a
 * string all name the provider without mounting it, and a substring check —
 * which is the obvious way to write this — accepts all three. So does a root
 * layout that imports the provider and then forgets the element, which is
 * exactly the regression E exists for.
 */
const PROVIDER_CONTROL_MOUNTED = [
  `const A = () => <${SHARED_UI_PROVIDER} t={t}><Stack /></${SHARED_UI_PROVIDER}>;`,
  `const A = () => <Boundary><${SHARED_UI_PROVIDER} t={t}><Stack /></${SHARED_UI_PROVIDER}></Boundary>;`,
  `const A = () => <${SHARED_UI_PROVIDER} t={t} />;`,
];
const PROVIDER_CONTROL_NOT_MOUNTED = [
  `import { ${SHARED_UI_PROVIDER} } from "@mercaria/ui";\nconst A = () => <Stack />;`,
  `// mount the ${SHARED_UI_PROVIDER} here\nconst A = () => <Stack />;`,
  `const name = "${SHARED_UI_PROVIDER}";`,
  "const A = () => <BloomThemeProvider><Stack /></BloomThemeProvider>;",
];
for (const source of PROVIDER_CONTROL_MOUNTED) {
  if (!mountsSharedUiProvider("control/provider.tsx", source)) {
    failures.push(
      `positive control failed: ${JSON.stringify(source)} did not read as mounting `
      + `${SHARED_UI_PROVIDER} — the detector is broken, and a broken detector reports every app `
      + "as un-mounted, which is loud; this direction is the quiet one",
    );
  }
}
for (const source of PROVIDER_CONTROL_NOT_MOUNTED) {
  if (mountsSharedUiProvider("control/provider.tsx", source)) {
    failures.push(
      `negative control failed: ${JSON.stringify(source)} read as mounting ${SHARED_UI_PROVIDER} — `
      + "the detector is a substring match, so an app that imports the provider and never renders "
      + "it would pass while every shared sentence fell back to English",
    );
  }
}

// -------------------------------------------------------------- the scan ----

const sources = tracked.filter(
  (path) =>
    SOURCE_FILE.test(path)
    && OWNERS.some((owner) => path.startsWith(owner.prefix))
    && !GUARD_OWN_FILES.has(path),
);

let translatedPositions = 0;
/** Per owner, so one owner's count cannot cover for another's broken traversal. */
const translatedByApp = new Map(OWNERS.map((owner) => [owner.name, 0]));
/** Every string literal seen per owner — part C's evidence that a key is used. */
const literalsByApp = new Map(OWNERS.map((owner) => [owner.name, new Set()]));
/** Every `t('literal')` site per owner, so part C can name the file and line. */
const translateSitesByApp = new Map(OWNERS.map((owner) => [owner.name, []]));
/** Files scanned per owner — the per-owner half of the vacuity floor below. */
const filesByApp = new Map(OWNERS.map((owner) => [owner.name, 0]));

for (const path of sources) {
  const text = await readTracked(path);
  if (text === null) continue;
  const app = OWNERS.find((candidate) => path.startsWith(candidate.prefix));
  const result = analyseSource(path, text, knownKeysByApp.get(app.name));
  filesByApp.set(app.name, filesByApp.get(app.name) + 1);
  // An owner that is only PART way through extraction contributes its literals
  // (part C needs them) and none of its check-A findings.
  if (app.hardcodedStrings) findings.push(...result.findings);
  translatedPositions += result.translatedPositions;
  translatedByApp.set(app.name, translatedByApp.get(app.name) + result.translatedPositions);
  const seen = literalsByApp.get(app.name);
  for (const literal of result.literals) seen.add(literal);
  const sites = translateSitesByApp.get(app.name);
  for (const site of result.translateKeys) sites.push({ ...site, file: path });
}

// ------------------------------------------------- B and C: the bundles -----

for (const app of OWNERS) {
  const flatByLocale = bundlesByApp.get(app.name) ?? new Map();
  const englishPath = `${app.locales}/en.json`;
  const english = flatByLocale.get(englishPath);
  if (!english) {
    failures.push(`${app.name}: ${englishPath} is missing — every other locale falls back to it`);
    continue;
  }

  if (flatByLocale.size < floorFor(app.minimumLocales)) {
    failures.push(
      `${app.name} has ${flatByLocale.size} locale bundles, below the `
      + `${floorFor(app.minimumLocales)} floor — the parity check below compares every sibling `
      + "against en.json, so with the siblings missing it compares nothing and reports clean",
    );
  }

  if (english.size < floorFor(app.minimumKeys)) {
    failures.push(
      `${englishPath} holds ${english.size} keys, below the ${floorFor(app.minimumKeys)} floor — `
      + "a bundle that small means the extraction regressed or the file listing is broken",
    );
  }

  const scanned = filesByApp.get(app.name) ?? 0;
  if (scanned < floorFor(app.minimumSourceFiles)) {
    failures.push(
      `${scanned} source files scanned under ${app.prefix}, below the `
      + `${floorFor(app.minimumSourceFiles)} floor — a prefix that matches nothing reports a clean `
      + "tree, and the repository-wide floor below cannot see one owner drop out",
    );
  }

  const seen = translatedByApp.get(app.name) ?? 0;
  if (app.minimumTranslatedPositions !== null
    && seen < floorFor(app.minimumTranslatedPositions)) {
    failures.push(
      `${seen} translated positions seen in packages/${app.name}, below the `
      + `${floorFor(app.minimumTranslatedPositions)} floor — the analyser reached almost no `
      + "user-facing position there, which is exactly what a fully extracted app would also look "
      + "like if the traversal were broken",
    );
  }

  // B. parity
  for (const [path, flat] of flatByLocale) {
    if (path === englishPath) continue;
    for (const key of english.keys()) {
      if (!flat.has(key)) {
        failures.push(
          `${path}: missing key "${key}". enableFallback renders the ENGLISH string for it, so this `
          + "screen looks translated in review and is not.",
        );
      }
    }
    for (const key of flat.keys()) {
      if (!english.has(key)) {
        failures.push(`${path}: key "${key}" does not exist in en.json — it can never be rendered.`);
      }
    }
    for (const [key, value] of flat) {
      const source = english.get(key);
      if (source === undefined) continue;
      if (placeholdersOf(value) !== placeholdersOf(source)) {
        failures.push(
          `${path}: "${key}" carries placeholders {${placeholdersOf(value) || "none"}} but en.json `
          + `carries {${placeholdersOf(source) || "none"}}. A renamed placeholder renders the literal `
          + "%{name} to a merchant.",
        );
      }
    }
  }

  // C. referential integrity
  const literals = literalsByApp.get(app.name) ?? new Set();
  for (const key of english.keys()) {
    if (!literals.has(key) && !literals.has(pluralParentOf(key))) {
      failures.push(
        `${englishPath}: "${key}" is named by no string literal in packages/${app.name}. Either it is `
        + "dead copy, or the call site that used it was replaced with a hardcoded English string.",
      );
    }
  }
  // C. every `t('literal')` names a real key.
  const resolvable = knownKeysByApp.get(app.name) ?? new Set();
  for (const site of translateSitesByApp.get(app.name) ?? []) {
    if (resolvable.has(site.key)) continue;
    failures.push(
      `${site.file}:${site.line}: t(${JSON.stringify(site.key)}) names no key in ${englishPath}. `
      + "i18n-js renders a humanised guess of the key, which reads like real copy.",
    );
  }
}

// ------------------------------------------- D: the reserved `ui` namespace --

// `mergeSharedUiCopy` spreads `@mercaria/ui`'s bundle over the app's, so a
// top-level `ui` key on either side is one silently replacing the other. The
// runtime merge throws on it; this is what stops it reaching a runtime. Both
// populations are DERIVED from the tracked listing — a hand list would skip a
// fourth app, and "the guard found fewer" reads identically to "there are
// fewer", which is what the two floors are for.

const sharedOwner = OWNERS.find((owner) => owner.name === SHARED_UI_OWNER);
for (const [path, topLevel] of topLevelKeysByPath) {
  if (!path.startsWith(`${sharedOwner.locales}/`)) continue;
  if (topLevel.length !== 1 || topLevel[0] !== SHARED_UI_NAMESPACE) {
    failures.push(
      `${path}: a shared bundle's only top-level key must be "${SHARED_UI_NAMESPACE}", found `
      + `[${topLevel.join(", ")}]. Anything else is merged into every app's instance outside the `
      + "reserved namespace, where it silently overwrites app copy or is overwritten by it.",
    );
  }
}

const appBundlePaths = tracked.filter((path) => APP_LOCALE_BUNDLE.test(path));
if (appBundlePaths.length < MINIMUM_APP_BUNDLES) {
  failures.push(
    `${appBundlePaths.length} app locale bundles found, below the ${MINIMUM_APP_BUNDLES} floor — `
    + "the derivation matched almost nothing, and a derivation that matches nothing reports every "
    + "app clean of the reserved-namespace collision",
  );
}
for (const path of appBundlePaths) {
  const text = await readTracked(path);
  if (text === null) continue;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    failures.push(`${path}: not valid JSON (${error.message})`);
    continue;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, SHARED_UI_NAMESPACE)) {
    failures.push(
      `${path}: has a top-level "${SHARED_UI_NAMESPACE}" key, which is reserved for `
      + "@mercaria/ui's own copy (#437). mergeSharedUiCopy refuses this at boot; rename the app key.",
    );
  }
}

// ------------------------------------------- E: the provider is mounted ------

const rootLayouts = tracked.filter((path) => ROOT_LAYOUT.test(path));
if (rootLayouts.length < MINIMUM_ROOT_LAYOUTS) {
  failures.push(
    `${rootLayouts.length} app root layouts found, below the ${MINIMUM_ROOT_LAYOUTS} floor — `
    + "the derivation matched almost nothing, so this check verified almost nothing",
  );
}
for (const path of rootLayouts) {
  const text = await readTracked(path);
  if (text === null) continue;
  if (!mountsSharedUiProvider(path, text)) {
    failures.push(
      `${path}: does not mount <${SHARED_UI_PROVIDER}>. Every component in @mercaria/ui that renders `
      + "its own copy resolves through it; without one they fall back to that package's English "
      + "silently, in an app whose own screens are correctly translated (#437).",
    );
  }
}

// ---------------------------------------------------------- vacuity floors --

if (sources.length < MINIMUM_SOURCE_FILES) {
  failures.push(
    `${sources.length} source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}

// ------------------------------------------------------------------ verdict --

if (findings.length > 0 || failures.length > 0) {
  console.error("i18n string guard failed:\n");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}: hardcoded user-facing string [${finding.kind}]`);
    console.error(`    ${JSON.stringify(finding.text)}`);
    console.error(
      "    Move it to that app's lib/i18n/locales/en.json, render it with t('key'), "
      + "and translate it in every sibling bundle.\n",
    );
  }
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  The dashboard and POS were translated in #398. A hardcoded string is invisible to tsc,\n"
    + "  to lint and to every build job — it just renders in English to somebody who does not read it.\n",
  );
  process.exit(1);
}

console.log(
  `i18n string guard passed — ${sources.length} source files scanned across `
  + `${OWNERS.map((owner) => owner.prefix).join(", ")}; ${translatedPositions} translated positions seen; `
  + `${appBundlePaths.length} app bundles and ${rootLayouts.length} app roots checked for the `
  + `reserved "${SHARED_UI_NAMESPACE}" namespace and <${SHARED_UI_PROVIDER}>; `
  + `${CONTROL_MUST_FIND.length + PROVIDER_CONTROL_MOUNTED.length} positive and `
  + `${CONTROL_MUST_NOT_FIND.length + PROVIDER_CONTROL_NOT_MOUNTED.length} negative controls run.`,
);
