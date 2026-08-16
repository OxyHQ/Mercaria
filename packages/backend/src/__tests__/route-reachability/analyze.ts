/**
 * Route reachability over the MODULE IMPORT GRAPH of an Expo app.
 *
 * The question this answers is "can a user get to this screen by tapping from
 * the app root", and the reason it is computed transitively rather than by grep
 * is #363's own finding: `components/sidebar.tsx` and
 * `components/settings/settings-sidebar.tsx` are a second sidebar carrying a
 * five-entry route table that NOTHING imports. A file-level grep counts those
 * five edges and reports the routes reachable. A screen linked only from an
 * unreachable screen is still unreachable, so reachability is a fixpoint from
 * the roots, not a set of edges.
 *
 * ## The model
 *
 * A route is reachable when some module in the CLOSURE of an already-reachable
 * route names it in a navigation position. The closure of a route is its own
 * screen file, every `_layout.tsx` above it (a layout renders whenever a screen
 * under it does, which is where tab bars and headers live), and everything
 * those transitively import inside the workspace. The seed is the index route,
 * which is what an app shows when it opens.
 *
 * ## Why a real parser
 *
 * `typed-routes-armed.test.ts` records what the hand-rolled predecessor cost.
 * WALL 6 read only the ARGUMENT of `router.push`, so a route composed in a
 * `buildHref` helper was invisible; and an interpolated segment became one
 * token containing `${`, which its resolver treated as a WILDCARD matching any
 * route of the same length. Both failed PERMISSIVE — they reported a route
 * reachable that was not, which is the exact direction this gate exists to
 * refuse. So:
 *
 *  - the walk is over the TypeScript AST, and it visits every navigation
 *    position in the file rather than the arguments of one call, which is what
 *    makes `buildHref`'s `pathname: '/p/[handle]'` an edge wherever it lives;
 *  - an interpolated segment matches ONLY a dynamic route segment. `${x}`
 *    cannot match a literal `general`, so `/settings/${page}` never reports
 *    `/settings/general` reachable.
 *
 * ## What it CANNOT see
 *
 * Read this before trusting a green run. Reachable is an UPPER BOUND, so the
 * unreachable set is a lower bound — every limitation below can only make a
 * route look MORE reachable than it is:
 *
 *  - **A target composed outside a navigation position.** `href={brand.canonicalPath}`
 *    takes a path from a server response; nothing static can resolve it. Such a
 *    route reports unreachable unless something else names it.
 *  - **Conditional rendering is not modelled.** An imported, mounted component
 *    behind a feature flag, a permission, a role or an empty-data branch counts
 *    as a live edge. A screen whose only link sits behind a flag that is off in
 *    production reads as reachable here.
 *  - **Deep links, push notifications and direct URL entry** are navigation
 *    this cannot see and does not claim to; a route is not "dead" merely
 *    because it appears here.
 *  - **Runtime behaviour of any kind** — a guard that redirects away, a screen
 *    that throws on mount, a link rendered off-screen.
 *  - **Platform variants are unioned, not split.** `x.native.tsx` and
 *    `x.web.tsx` both enter the closure, so a route linked only from the web
 *    fork reads as reachable on every platform.
 *
 * What it CAN see, and what nothing else does: a screen that no reachable
 * module mentions at all.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';

/** One segment of a route as expo-router's file tree declares it. */
export type RouteSegment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; value: string };

/** One segment of a navigation target read out of source. */
export type TargetSegment =
  | { kind: 'static'; value: string }
  /** An interpolation: `${...}`. Matches a dynamic route segment and nothing else. */
  | { kind: 'expr' };

/** A screen a user could be on. */
export interface RouteRecord {
  /** The URL path expo-router serves, e.g. `/`, `/p/[handle]`, `/settings/general`. */
  readonly route: string;
  /** Absolute path of the file declaring it. */
  readonly file: string;
  readonly segments: readonly RouteSegment[];
}

/** A navigation target found in source, with where it was found. */
export interface NavTarget {
  /** The literal as written, for the report. */
  readonly raw: string;
  readonly segments: readonly TargetSegment[];
  /** Absolute path of the module naming it. */
  readonly file: string;
}

export interface AppReachability {
  readonly app: string;
  readonly routes: readonly RouteRecord[];
  readonly reachable: ReadonlySet<string>;
  readonly unreachable: readonly string[];
  /** Every module in the closure of the reachable routes. */
  readonly modulesScanned: readonly string[];
  /** Every navigation target found in that closure. */
  readonly targets: readonly NavTarget[];
  /** `route` -> the modules that name it, for the report and for triage. */
  readonly inboundEdges: ReadonlyMap<string, readonly string[]>;
}

/**
 * Expo-router files that declare no navigable screen.
 *
 * An EXACT set rather than a prefix rule: `+html` is the web document shell and
 * `+not-found` is the fallback expo-router renders for an unmatched URL, which
 * is by definition not a destination anybody links to. Any OTHER `_`- or
 * `+`-prefixed file is refused rather than guessed at, because silently
 * dropping a file from the census is how a screen stops being counted.
 */
const NON_ROUTE_FILES: ReadonlySet<string> = new Set(['+html', '+not-found']);

/** Layout files, which are not routes but ARE part of a route's closure. */
const LAYOUT_FILE = '_layout';

/** Extensions a workspace import may resolve to, in expo/Metro precedence. */
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const;

/**
 * Platform suffixes Metro selects between. All existing variants are unioned
 * into the closure — a route linked only from the native fork is genuinely
 * reachable, on native.
 */
const PLATFORM_SUFFIXES = ['', '.native', '.web', '.ios', '.android'] as const;

/** The methods that navigate. */
const NAV_METHODS: ReadonlySet<string> = new Set([
  'push',
  'replace',
  'navigate',
  'prefetch',
  'dismissTo',
]);

/**
 * Property and attribute names that carry a route.
 *
 * `pathname` is the one that matters most: #330 moved the storefront's
 * composed hrefs to the OBJECT form precisely because a runtime-built string
 * satisfies no route union, and that is what makes a helper's target readable
 * here at all.
 */
const NAV_PROPERTY_NAMES: ReadonlySet<string> = new Set(['href', 'pathname', 'route', 'to']);

/**
 * The types this repository annotates a route literal with.
 *
 * This is the codebase's OWN marker, not a convention invented here:
 * `nav-items.ts` writes `href: RoutePath` and `account-section.tsx` writes
 * `go = (route: RoutePath) => router.push(route)`, both with a comment saying
 * the annotation is what makes the literals checkable. Reading it is what lets
 * a route travel through a helper and still be counted.
 *
 * It is also what keeps the extractor from being widened into uselessness. The
 * measured alternative — treating any route-shaped literal as an edge — reads
 * `shared-types/src/seo.ts`, whose sitemap table names EVERY route, and every
 * screen in the app then reports reachable forever.
 */
const ROUTE_TYPE_NAMES: ReadonlySet<string> = new Set(['RoutePath', 'Href']);

/**
 * Sentinel standing in for `${...}` while a target string is split.
 *
 * A NUL, because it is the one character a route literal cannot contain: a
 * printable stand-in could occur in a real path and would then be read as an
 * interpolation, flipping a static segment into one that matches only a
 * parameter. Written as an ESCAPE rather than as the byte — a raw NUL in this
 * file makes `grep` report every symbol in it as absent (`~/Oxy/AGENTS.md`),
 * which is exactly how a gate stops being findable by the next person.
 */
const EXPR_SENTINEL = '\u0000';

function listFilesRecursively(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function stripExtension(file: string): string {
  return file.replace(/\.(tsx|ts|jsx|js)$/, '');
}

/** `(group)` segments are organisational and do not appear in the URL. */
function isGroupSegment(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

/**
 * The URL path expo-router serves a file at.
 *
 * Throws on a segment shape this matcher does not model, rather than guessing:
 * a catch-all (`[...rest]`) matches a variable number of segments, and treating
 * one as an ordinary parameter would make every same-length target match it.
 */
export function routePathForFile(appDirectory: string, file: string): string {
  const relativePath = relative(appDirectory, stripExtension(file));
  const parts = relativePath.split(sep).filter((part) => part !== '' && !isGroupSegment(part));
  if (parts[parts.length - 1] === 'index') parts.pop();
  for (const part of parts) {
    if (part.startsWith('[...')) {
      throw new Error(
        `${file}: catch-all route segment "${part}" is not modelled by the reachability ` +
          'matcher. It matches a variable number of segments, so admitting it as an ordinary ' +
          'parameter would make every same-length target match it. Teach the matcher first.',
      );
    }
  }
  return `/${parts.join('/')}`.replace(/\/$/, '') || '/';
}

function parseRouteSegments(route: string): RouteSegment[] {
  if (route === '/') return [];
  return route
    .split('/')
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('[') && part.endsWith(']')
        ? { kind: 'param' as const, value: part }
        : { kind: 'static' as const, value: part },
    );
}

/**
 * Every route an app declares.
 *
 * A file under `app/` is a route, a layout, or one of the two expo-router
 * specials — and anything else THROWS. That is the same refusal
 * `merge-plan-census.test.ts` makes for a foreign key with no disposition: a
 * file quietly dropped from the census is a screen that stops being counted,
 * and "I found fewer routes" is indistinguishable from "there are fewer".
 */
export function enumerateRoutes(appDirectory: string): {
  routes: RouteRecord[];
  layouts: string[];
} {
  const routes: RouteRecord[] = [];
  const layouts: string[] = [];
  for (const file of listFilesRecursively(appDirectory)) {
    if (!/\.(tsx|ts|jsx|js)$/.test(file)) continue;
    const base = stripExtension(file.split(sep).pop() ?? '');
    if (base === LAYOUT_FILE) {
      layouts.push(file);
      continue;
    }
    if (NON_ROUTE_FILES.has(base)) continue;
    if (base.startsWith('_') || base.startsWith('+')) {
      throw new Error(
        `${file}: expo-router special file "${base}" is neither a known non-route ` +
          `(${[...NON_ROUTE_FILES].join(', ')}) nor a layout. Decide whether it declares a ` +
          'navigable screen and add it to one list or the other — being in neither must fail.',
      );
    }
    const route = routePathForFile(appDirectory, file);
    routes.push({ route, file, segments: parseRouteSegments(route) });
  }
  return { routes, layouts };
}

/** Every `_layout.tsx` above a screen, which render whenever it does. */
function layoutsAbove(appDirectory: string, file: string, layouts: readonly string[]): string[] {
  const owning = new Set<string>();
  let directory = dirname(file);
  const stop = dirname(appDirectory);
  while (directory !== stop && directory.length > stop.length) {
    for (const layout of layouts) {
      if (dirname(layout) === directory) owning.add(layout);
    }
    directory = dirname(directory);
  }
  return [...owning];
}

/**
 * Which names exist in a directory, cached.
 *
 * The resolver tries five platform suffixes against four extensions, twice —
 * up to forty candidate paths per import specifier. Asking the filesystem
 * directly is roughly half a million `statSync` calls across the three apps and
 * dominates the gate's runtime; one `readdirSync` per directory answers all
 * forty from memory.
 */
const directoryEntries = new Map<string, ReadonlySet<string>>();

function existingFile(candidate: string): boolean {
  const directory = dirname(candidate);
  let entries = directoryEntries.get(directory);
  if (entries === undefined) {
    try {
      entries = new Set(
        readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() || entry.isSymbolicLink())
          .map((entry) => entry.name),
      );
    } catch {
      entries = new Set<string>();
    }
    directoryEntries.set(directory, entries);
  }
  return entries.has(candidate.slice(directory.length + 1));
}

/**
 * Every workspace file an import specifier could resolve to.
 *
 * A LIST rather than one path: Metro picks a platform variant at bundle time
 * and all of them ship, so a route linked from `x.native.tsx` is reachable.
 * External packages resolve to nothing and are dropped — a route named inside
 * `node_modules` is not this repository's edge.
 */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  appRoot: string,
  packagesRoot: string,
): string[] {
  let base: string | null = null;
  if (specifier.startsWith('.')) {
    base = join(dirname(fromFile), specifier);
  } else if (specifier.startsWith('@/')) {
    base = join(appRoot, specifier.slice(2));
  } else if (specifier === '@mercaria/ui') {
    base = join(packagesRoot, 'ui', 'src');
  } else if (specifier.startsWith('@mercaria/ui/')) {
    base = join(packagesRoot, 'ui', 'src', specifier.slice('@mercaria/ui/'.length));
  } else if (specifier === '@mercaria/shared-types') {
    base = join(packagesRoot, 'shared-types', 'src');
  } else if (specifier.startsWith('@mercaria/shared-types/')) {
    base = join(packagesRoot, 'shared-types', 'src', specifier.slice('@mercaria/shared-types/'.length));
  }
  if (base === null) return [];

  const found: string[] = [];
  for (const suffix of PLATFORM_SUFFIXES) {
    for (const extension of RESOLVE_EXTENSIONS) {
      const candidate = `${base}${suffix}${extension}`;
      if (existingFile(candidate)) found.push(candidate);
    }
  }
  if (found.length === 0) {
    for (const suffix of PLATFORM_SUFFIXES) {
      for (const extension of RESOLVE_EXTENSIONS) {
        const candidate = join(base, `index${suffix}${extension}`);
        if (existingFile(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

const sourceFileCache = new Map<string, ts.SourceFile>();

/**
 * The parsed form of one file, cached.
 *
 * Exported so a caller re-walking the same modules pays for parsing once.
 * Re-parsing ~800 files a second time is most of this gate's runtime.
 */
export function parseSourceFile(file: string): ts.SourceFile {
  return parseFile(file);
}

/** Empty every cache, so a measurement reports a COLD run. */
export function clearSourceFileCache(): void {
  sourceFileCache.clear();
  directoryEntries.clear();
}

function parseFile(file: string): ts.SourceFile {
  const cached = sourceFileCache.get(file);
  if (cached !== undefined) return cached;
  const parsed = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceFileCache.set(file, parsed);
  return parsed;
}

/** Every import/export/dynamic-import specifier in a file. */
export function importSpecifiersOf(file: string): string[] {
  const source = parseFile(file);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** Peel the wrappers that never change a value: casts, parens, non-null. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Every path string an expression could evaluate to, with `${...}` preserved as
 * a sentinel rather than flattened away.
 *
 * A branch (`a ? b : c`, `a ?? b`, `a || b`) contributes BOTH sides: each is a
 * target the code can navigate to.
 */
function pathStringsOf(node: ts.Expression): string[] {
  const expression = unwrap(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    let text = expression.head.text;
    for (const span of expression.templateSpans) {
      text += EXPR_SENTINEL + span.literal.text;
    }
    return [text];
  }
  if (ts.isConditionalExpression(expression)) {
    return [...pathStringsOf(expression.whenTrue), ...pathStringsOf(expression.whenFalse)];
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...pathStringsOf(expression.left), ...pathStringsOf(expression.right)];
  }
  // Anything else — an identifier, a call, a property access — is composed
  // elsewhere. It contributes no edge HERE; if it was built from a literal in a
  // navigation position anywhere in the closure, that literal is its own edge.
  return [];
}

/**
 * A path string as segments, or `null` when it is not an in-app absolute route.
 *
 * Relative and external targets are dropped deliberately: an `https://` href
 * leaves the app, and a relative `./x` is a shape this repository does not use
 * (asserted by the extractor's own control in the gate).
 */
export function parseTargetSegments(raw: string): TargetSegment[] | null {
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  const withoutQuery = raw.split('?')[0].split('#')[0];
  const parts = withoutQuery
    .split('/')
    .filter((part) => part !== '' && !isGroupSegment(part));
  return parts.map((part) =>
    part.includes(EXPR_SENTINEL) ? { kind: 'expr' as const } : { kind: 'static' as const, value: part },
  );
}

/**
 * True when the expression sits in a position whose value is navigated to.
 *
 * The receiver is checked as well as the method because `push` and `replace`
 * are also Array and String methods: `parts.push('/cart')` and
 * `s.replace('/a', '/b')` would otherwise each invent an inbound edge, and an
 * invented edge is a route reported reachable that is not. The gate carries a
 * positive control asserting this finds every `*router.<verb>(` occurrence the
 * scanned source contains, so a receiver spelled some other way fails the build
 * rather than being silently skipped.
 */
function isNavCallee(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (!NAV_METHODS.has(expression.name.text)) return false;
  const receiver = unwrap(expression.expression);
  if (ts.isCallExpression(receiver)) {
    // `useRouter().push(...)` / `useNavigation().navigate(...)`.
    return /^use(Router|Navigation)$/.test(receiver.expression.getText());
  }
  const text = receiver.getText();
  return /(^|\.)router$/i.test(text) || /(^|\.)navigation$/i.test(text);
}

/** True for `RoutePath`, `Href`, `Href<T>`, and any union containing one. */
function isRouteTypeNode(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isUnionTypeNode(type)) return type.types.some(isRouteTypeNode);
  if (ts.isParenthesizedTypeNode(type)) return isRouteTypeNode(type.type);
  if (ts.isTypeReferenceNode(type)) return ROUTE_TYPE_NAMES.has(type.typeName.getText());
  return false;
}

/**
 * Same-file functions that take a route, and at which parameter positions.
 *
 * SAME FILE rather than across the module graph, deliberately: resolving a
 * callee through imports would need the type checker and a whole program, and
 * the failure of not doing it is a route reported UNREACHABLE that is not —
 * loud, and fixed by wiring or by an allow-list entry somebody has to justify.
 * Resolving it wrongly would fail the other way, silently.
 */
function routeTypedParameters(source: ts.SourceFile): Map<string, Set<number>> {
  const byName = new Map<string, Set<number>>();
  const note = (name: string, parameters: readonly ts.ParameterDeclaration[]): void => {
    const positions = new Set<number>();
    parameters.forEach((parameter, index) => {
      if (isRouteTypeNode(parameter.type)) positions.add(index);
    });
    if (positions.size > 0) byName.set(name, positions);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      note(node.name.text, node.parameters);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      note(node.name.text, node.initializer.parameters);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return byName;
}

/** Every navigation target named in one file. */
export function navTargetsOf(file: string): NavTarget[] {
  const source = parseFile(file);
  const targets: NavTarget[] = [];
  const routeParameters = routeTypedParameters(source);

  const record = (expression: ts.Expression): void => {
    for (const raw of pathStringsOf(expression)) {
      const segments = parseTargetSegments(raw);
      if (segments === null) continue;
      targets.push({ raw: raw.split(EXPR_SENTINEL).join('${}'), segments, file });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isNavCallee(node.expression) && node.arguments.length > 0) {
      record(node.arguments[0]);
    }
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      NAV_PROPERTY_NAMES.has(node.name.text) &&
      node.initializer !== undefined
    ) {
      if (ts.isStringLiteral(node.initializer)) record(node.initializer);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
        record(node.initializer.expression);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      NAV_PROPERTY_NAMES.has(node.name.text)
    ) {
      record(node.initializer);
    }
    // A literal handed to a same-file helper that declares its parameter a
    // route: `go("/(app)/watchlists")` where `go = (route: RoutePath) => ...`.
    // Five of the storefront's account shortcuts travel this way and are
    // invisible to every position above.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const positions = routeParameters.get(node.expression.text);
      if (positions !== undefined) {
        node.arguments.forEach((argument, index) => {
          if (positions.has(index)) record(argument);
        });
      }
    }
    // `const target: RoutePath = '/x'`, then navigated to elsewhere.
    if (ts.isVariableDeclaration(node) && isRouteTypeNode(node.type) && node.initializer !== undefined) {
      record(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
}

/**
 * The routes a target could reach.
 *
 * A STATIC target that names a route exactly wins outright: `/products/new` is
 * the `products/new.tsx` screen and must not also count as an inbound edge to
 * `/products/[id]`, which is how a dynamic route comes to look reachable
 * because a sibling static one is linked.
 *
 * Otherwise a segment matches when the route can accept it — and an `expr`
 * segment accepts ONLY a parameter. That asymmetry is the WALL 6 fix: without
 * it, `${x}` matches any segment and every same-length route reads as
 * reachable.
 */
export function matchTarget(
  target: readonly TargetSegment[],
  routes: readonly RouteRecord[],
): RouteRecord[] {
  const sameLength = routes.filter((route) => route.segments.length === target.length);

  const exact = sameLength.filter((route) =>
    route.segments.every((segment, index) => {
      const part = target[index];
      return part.kind === 'static' && part.value === segment.value;
    }),
  );
  if (exact.length > 0) return exact;

  return sameLength.filter((route) =>
    route.segments.every((segment, index) => {
      const part = target[index];
      if (part.kind === 'expr') return segment.kind === 'param';
      return segment.kind === 'param' || segment.value === part.value;
    }),
  );
}

export interface AnalyzeOptions {
  /** Absolute path of the app package, e.g. `<repo>/packages/frontend`. */
  readonly appRoot: string;
  /** Absolute path of `<repo>/packages`. */
  readonly packagesRoot: string;
  readonly app: string;
  /**
   * Navigation edges to ignore, as `"<route>"` — used ONLY by the mutation
   * self-test, to prove that removing the sole inbound edge to a screen also
   * strands everything reachable only through it.
   */
  readonly suppressEdgesTo?: ReadonlySet<string>;
}

/**
 * Compute reachability for one app.
 *
 * The fixpoint: seed with the index route, take the module closure of every
 * reachable route (its screen, the layouts above it, and their transitive
 * workspace imports), read every navigation target in that closure, add the
 * routes they match, repeat until nothing new appears.
 */
export function analyzeApp(options: AnalyzeOptions): AppReachability {
  const appDirectory = join(options.appRoot, 'app');
  const { routes, layouts } = enumerateRoutes(appDirectory);
  const byRoute = new Map(routes.map((route) => [route.route, route]));

  const indexRoute = byRoute.get('/');
  if (indexRoute === undefined) {
    throw new Error(
      `${options.app}: no index route. The seed of the reachability fixpoint is the screen the ` +
        'app opens on; without one every route below would report unreachable for the wrong reason.',
    );
  }

  const reachable = new Set<string>(['/']);
  const modulesScanned = new Set<string>();
  const targets: NavTarget[] = [];
  const inboundEdges = new Map<string, string[]>();

  for (;;) {
    // The closure of everything reachable so far.
    const frontier: string[] = [];
    for (const route of reachable) {
      const record = byRoute.get(route);
      if (record === undefined) continue;
      frontier.push(record.file, ...layoutsAbove(appDirectory, record.file, layouts));
    }
    const queue = frontier.filter((file) => !modulesScanned.has(file));
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (modulesScanned.has(file)) continue;
      modulesScanned.add(file);
      for (const specifier of importSpecifiersOf(file)) {
        for (const resolved of resolveSpecifier(
          specifier,
          file,
          options.appRoot,
          options.packagesRoot,
        )) {
          if (!modulesScanned.has(resolved)) queue.push(resolved);
        }
      }
    }

    // Every target named anywhere in it.
    targets.length = 0;
    for (const file of modulesScanned) targets.push(...navTargetsOf(file));

    const before = reachable.size;
    for (const target of targets) {
      for (const matched of matchTarget(target.segments, routes)) {
        if (options.suppressEdgesTo?.has(matched.route) === true) continue;
        reachable.add(matched.route);
        const existing = inboundEdges.get(matched.route);
        if (existing === undefined) inboundEdges.set(matched.route, [target.file]);
        else if (!existing.includes(target.file)) existing.push(target.file);
      }
    }
    if (reachable.size === before) break;
  }

  const unreachable = routes
    .map((route) => route.route)
    .filter((route) => !reachable.has(route))
    .sort();

  return {
    app: options.app,
    routes,
    reachable,
    unreachable,
    modulesScanned: [...modulesScanned].sort(),
    targets: [...targets],
    inboundEdges,
  };
}
