#!/usr/bin/env bun

/**
 * Every navigation target's STATIC prefix must name a route that exists (#456).
 *
 * ## What can actually go wrong here, and why `tsc` does not catch it
 *
 * `AGENTS.md` used to say that `typedRoutes` being armed means "a literal
 * navigation target that is not a real route fails `tsc`". That is true of the
 * OBJECT form and only PARTLY true of the template-literal form, which is the
 * form most of the three apps use. Measured on the dashboard, armed (the
 * generator emitted 28 routes on every one of these runs):
 *
 *   | mutation                                        | tsc  | diagnostic |
 *   |-------------------------------------------------|------|------------|
 *   | `router.push({ pathname: "/products/wizrd/[draftId]", … })` | 2 | TS2820 |
 *   | `` router.push(`/prodcuts/${product.id}`) ``    | 2    | TS2345     |
 *   | `` router.push(`/products/wizrd/${draft.id}`) ``| **0**| **none**   |
 *
 * The third is the hole. The generated union spells a dynamic route as
 *
 *     `/products/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ''}`
 *
 * and `SingleRoutePart` excludes a multi-segment string with
 * `` S extends `${string}/${string}` ? never ``. Against a concrete string that
 * exclusion discharges; against the unresolved `${string}` that a template
 * literal contributes it does NOT, so `` `/products/wizrd/${string}` `` is
 * absorbed by the `/products/[id]` route sitting above it and type-checks.
 *
 * So the rule is not "template literals are unchecked". It is sharper and worse:
 * **a template-literal target is checked only when no dynamic route sits above
 * the segment that was mistyped.** Every real typo is in a deeper segment of an
 * otherwise-real path, and in all three apps those paths sit under a dynamic
 * route. The object form has no such hole — its `pathname` is checked against a
 * union of plain string literals, which is why it yields TS2820 with a
 * "Did you mean" beside it.
 *
 * ## What this guard does
 *
 * It builds each app's real route tree by walking `app/` on disk, extracts every
 * navigation target it can resolve statically, and requires the target's static
 * skeleton to match a real route segment-for-segment. An interpolation stands for
 * exactly one unknown segment and matches anything; every STATIC segment must
 * line up. That is what turns `/products/wizrd/…` red while leaving
 * `/products/…` and `/products/wizard/…` green.
 *
 * ## What this cannot tell you
 *
 * Whether a target assembled at RUNTIME points anywhere real. A bare identifier,
 * a function call, a conditional or a path whose FIRST segment is interpolated
 * carry no static prefix to resolve, and this guard counts them
 * (`unresolvable`) rather than pretending to check them. `route-reachability`'s
 * analyzer makes the same call for the same reason: resolving a callee through
 * imports needs the type checker and a whole program, and guessing fails in the
 * permissive direction. The remedy for those sites is the OBJECT form, which
 * `tsc` checks completely.
 *
 * It also does not prove a route RENDERS, or that a screen is reachable by a
 * user. Reachability is `route-reachability.test.ts`; rendering is nobody's,
 * still.
 *
 * Usage:  bun scripts/validate-route-targets.mjs
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = process.env.ROUTE_TARGET_VALIDATOR_ROOT
  ? resolve(process.env.ROUTE_TARGET_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fixture trees are three files, not three apps, so the production floors would
 * fail every self-test case for a reason that has nothing to do with routing.
 * The self-test runs the real floors in the one case that exists to see them
 * fire.
 */
const fixtureFloors = process.env.ROUTE_TARGET_VALIDATOR_FIXTURE_FLOORS === "1";

/** The three Expo apps. `@mercaria/ui` is deliberately absent — see below. */
const APPS = [
  { name: "frontend", prefix: "packages/frontend" },
  { name: "dashboard", prefix: "packages/dashboard" },
  { name: "pos", prefix: "packages/pos" },
];

/**
 * `@mercaria/ui` is NOT scanned, and that is a decision rather than an omission.
 * A shared component takes an `href` as a PROP and never spells a route: it is
 * consumed by three apps with three different route trees, so a literal there
 * would have no single tree to be resolved against. `NAV_ITEMS` lives in each
 * app for exactly that reason. The assertion below is what keeps it true — if a
 * navigation target ever appears in `ui`, this guard says so rather than
 * silently not covering it.
 */
const UI_PREFIX = "packages/ui";

/**
 * Routes expo-router synthesises for every project whatever the tree contains.
 * They are the positive control on the ROUTE WALKER: if the walker breaks, a
 * tree that still contains these is reporting a fact about the walker rather
 * than about the app.
 */
const SYNTHETIC_ROUTES = ["/_sitemap", "/+not-found"];

/**
 * Exemptions, each with a reason AND an exact count (#448 / PR #451): an
 * excusing entry is a PREDICATE, not an identity, so one that does not state how
 * many findings it covers silently excuses the next one that looks like it.
 * The count is asserted for equality, so a covered site disappearing is as loud
 * as a second one appearing.
 *
 * EMPTY, and that is a measurement: the three trees resolve clean today. An
 * entry here must never be a way to make a genuinely dead route green — the
 * remedy for a dead target is to fix the target.
 */
const KNOWN_EXCEPTIONS = [];

// ------------------------------------------------------------------ floors ---

/**
 * ## How these are derived, and the boundary trap they are written around
 *
 * A floor is a MEASUREMENT and it rots in the GREEN direction: the tree grows,
 * the number it is defending against grows with it, and one day the floor is
 * satisfied by a scan that read nothing it was supposed to.
 *
 * The loss being defended against is one app's tree silently dropping out of the
 * scan — a renamed package directory, a `git ls-files` that returned nothing, a
 * prefix that matches no path. A GLOBAL floor defends that badly: it has to be
 * set below "total minus the smallest app", and every file ADDED to the other
 * two pushes that quantity up until it reaches the floor and the floor is inert.
 * That is the trap, and it is not hypothetical — it is the same shape that has
 * fired twice in one PR on this repo.
 *
 * So the load-bearing floor here is PER APP, not global. Each app must
 * contribute at least one scanned file, at least one route and at least one
 * navigation site. Losing an app takes ITS OWN counts to zero, and zero cannot
 * be reached by growth anywhere else — the assertion is structurally immune to
 * the rot rather than merely set far from it today.
 *
 * The global floors below are kept as a second, weaker net for "the whole
 * traversal read nothing", and are deliberately NOT the thing carrying the
 * guarantee. They are compared with `<`, which is satisfied AT equality, so each
 * is set strictly below — never at — the quantity it is separating from.
 *
 * MEASURED on this branch, by running the guard rather than by estimating:
 *
 *   total   382 files · 72 routes · 168 resolvable targets
 *   frontend 200f · 35r · 102t
 *   dashboard 118f · 28r ·  48t
 *   pos        64f ·  9r ·  18t   (the smallest, and the one a global floor
 *                                  would have to be set below to catch)
 *
 * The route counts include the 2 synthetic routes every app gets, so the real
 * trees are 33 / 26 / 7 — independently derived and agreed by a second walk.
 *
 * The globals are set near a third of each total: low enough that ordinary
 * churn never trips them, high enough that a wholesale traversal failure does.
 * They are explicitly NOT set to catch one app dropping out — "total minus the
 * smallest app" is 318 files, and a floor above that would be tripped by
 * deleting a handful of screens. That job belongs to the per-app floors, which
 * cannot rot because zero is not reachable by growth elsewhere.
 */
const MINIMUM_FILES_PER_APP = 1;
const MINIMUM_ROUTES_PER_APP = 1;
const MINIMUM_TARGETS_PER_APP = 1;

const MINIMUM_FILES_TOTAL = fixtureFloors ? 1 : 120;
const MINIMUM_ROUTES_TOTAL = fixtureFloors ? 1 : 40;
const MINIMUM_TARGETS_TOTAL = fixtureFloors ? 1 : 90;

/** Marks the position an `${…}` occupied once the template is flattened. */
const HOLE = "\u0000";

const failures = [];

// ------------------------------------------------------------ file listing ---

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

const SOURCE_FILE = /\.(?:tsx?|jsx?)$/;

/**
 * `app/+html.tsx` is the web HTML SHELL, not a screen. Its JSX is literal HTML —
 * `<link rel="icon" href="/icon-192.png">`, `<link rel="manifest"
 * href="/manifest.json">` — so every `href` in it addresses a static asset in
 * `public/`, which is a different namespace from the route tree. Scanning it
 * reported eleven dead routes on the first run, all of them correct files.
 *
 * It is skipped by PATH rather than by an exception entry, because the reason is
 * structural and applies to a file that has not been written yet in an app that
 * does not exist yet. `assertShellDoesNotNavigate` below is what stops the skip
 * hiding something: the shell renders before the router exists and cannot
 * navigate, so a `router.push` in one is a bug on its own terms.
 */
function isWebHtmlShell(file) {
  return /\/app\/\+html\.tsx$/.test(file);
}

// ------------------------------------------------------- comment blanking ---

/**
 * Blank every comment, preserving every newline and every column, so a finding's
 * reported line matches the file on disk.
 *
 * String-aware, because `"https://x"` and a backticked path must not open a
 * comment. Template bodies are KEPT — they are the subject.
 */
function blankComments(text) {
  let out = "";
  let index = 0;
  let state = null; // null | '"' | "'" | '`' | '//' | '/*'
  let templateDepth = 0;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (state === "//") {
      if (char === "\n") {
        state = null;
        out += char;
      } else {
        out += " ";
      }
      index += 1;
      continue;
    }

    if (state === "/*") {
      if (char === "*" && next === "/") {
        state = null;
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (state === '"' || state === "'") {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === state) state = null;
      index += 1;
      continue;
    }

    if (state === "`") {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      // `${` opens an ordinary expression context in which comments are legal
      // again; track it so a nested backtick does not close the outer template.
      if (char === "$" && next === "{") {
        out += next;
        templateDepth += 1;
        state = null;
        index += 2;
        continue;
      }
      if (char === "`") state = null;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      state = "//";
      out += "  ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "/*";
      out += "  ";
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      state = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "}" && templateDepth > 0) {
      templateDepth -= 1;
      state = "`";
      out += char;
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

// ------------------------------------------------------------- route trees ---

function isGroupSegment(segment) {
  return segment.startsWith("(") && segment.endsWith(")");
}

function isCatchAllSegment(segment) {
  return segment.startsWith("[...") && segment.endsWith("]");
}

function isParamSegment(segment) {
  return segment.startsWith("[") && segment.endsWith("]");
}

/**
 * The route a file defines, as an array of segments, or `null` when the file
 * defines none.
 *
 * The conventions applied are expo-router's: a `(group)` directory does not
 * appear in the URL, `index` collapses into its parent, `_layout` is not a
 * route, and a `+`-prefixed file is a special entry rather than a screen —
 * except `+not-found`, which is one.
 */
function routeForFile(relativeToApp) {
  const withoutExtension = relativeToApp.replace(SOURCE_FILE, "");
  const parts = withoutExtension.split("/");
  const base = parts[parts.length - 1];

  if (parts.some((part) => part.startsWith("_"))) return null;
  if (base.includes("+api")) return null;
  if (base.startsWith("+") && base !== "+not-found") return null;
  // `foo+html.tsx`, `foo+native-intent.ts` and friends are not screens.
  if (/\+(?:html|native-intent|ssr)$/.test(base)) return null;

  const segments = parts.filter((part) => !isGroupSegment(part));
  if (segments.length > 0 && segments[segments.length - 1] === "index") segments.pop();
  return segments;
}

function buildRouteTree(app, files) {
  const appDirectory = `${app.prefix}/app/`;
  const routes = [];
  for (const file of files) {
    if (!file.startsWith(appDirectory)) continue;
    if (!SOURCE_FILE.test(file)) continue;
    const segments = routeForFile(file.slice(appDirectory.length));
    if (segments === null) continue;
    routes.push(segments);
  }
  for (const synthetic of SYNTHETIC_ROUTES) routes.push(synthetic.slice(1).split("/"));
  // `+not-found` is both walked and synthesised; dedupe so the reported count is
  // a count of ROUTES rather than of the ways one was arrived at.
  const seen = new Set();
  return routes.filter((segments) => {
    const key = segments.join("/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --------------------------------------------------------- target matching ---

function segmentMatches(targetSegment, routeSegment) {
  if (targetSegment.includes(HOLE)) return true;
  if (isParamSegment(routeSegment)) return true;
  return targetSegment === routeSegment;
}

/** Does this static skeleton line up with this route, segment for segment? */
function matchesRoute(targetSegments, routeSegments) {
  let index = 0;
  while (index < targetSegments.length && index < routeSegments.length) {
    if (isCatchAllSegment(routeSegments[index])) return true;
    if (!segmentMatches(targetSegments[index], routeSegments[index])) return false;
    index += 1;
  }
  if (index < routeSegments.length) {
    return routeSegments.slice(index).every(isCatchAllSegment);
  }
  return index >= targetSegments.length;
}

function resolvesAgainst(routes, targetSegments) {
  return routes.some((route) => matchesRoute(targetSegments, route));
}

/**
 * Turn a flattened target into segments, or say why it carries nothing to check.
 *
 * The query and hash are cut FIRST: `` `/checkout?${query}` `` has a complete
 * path and an interpolated query, and treating the `?` as part of a segment
 * would fail a target that is entirely correct.
 */
function parseTarget(skeleton) {
  const cut = [skeleton.indexOf("?"), skeleton.indexOf("#")].filter((at) => at >= 0);
  const path = cut.length > 0 ? skeleton.slice(0, Math.min(...cut)) : skeleton;

  if (path.startsWith(HOLE)) return { kind: "unresolvable", why: "path begins with an interpolation" };
  if (path.startsWith(".")) return { kind: "relative" };
  if (path.startsWith("//")) return { kind: "external" };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return { kind: "external" };
  if (!path.startsWith("/")) return { kind: "unresolvable", why: "not an absolute path" };

  const segments = path
    .slice(1)
    .split("/")
    .filter((segment) => !isGroupSegment(segment));
  if (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();
  return { kind: "route", segments };
}

// -------------------------------------------------------- target extraction ---

function readStringLiteral(source, start) {
  const quote = source[start];
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    if (char === "\n") return null;
    value += char;
    index += 1;
  }
  return null;
}

/** Flatten a template literal, replacing each `${…}` with a single HOLE. */
function readTemplateLiteral(source, start) {
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === "`") return { value, end: index + 1 };
    if (char === "$" && source[index + 1] === "{") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") depth -= 1;
        index += 1;
      }
      value += HOLE;
      continue;
    }
    value += char;
    index += 1;
  }
  return null;
}

function skipSpace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

/**
 * Every TOP-LEVEL string and template literal in the expression starting at
 * `index`, stopping when the expression's own bracket depth closes.
 *
 * ## Why every literal and not just the first one
 *
 * The first version read only the value immediately after the `(`, which is
 * correct for `router.push("/cart")` and silently blind to
 *
 *     router.push(orderId ? `/orders/${orderId}` : "/orders")
 *
 * — the character after `(` is an identifier, so the whole site was written off
 * as unresolvable and BOTH branches went unchecked. A census of the three apps
 * found three such sites hiding inside conditionals, in exactly the files most
 * likely to carry a typo. Walking the expression catches every branch.
 *
 * "Top level" is what keeps it honest: a literal INSIDE a `${…}` is an argument
 * to something else (`encodeURIComponent("x")`, `t("nav.home")`) and is not a
 * path, so `readTemplateLiteral` consumes interpolations whole and they are
 * never re-scanned. A literal that survives and does not begin with `/` is
 * reported as unresolvable rather than as a finding, so a stray `"products"`
 * handed to a helper cannot become a false failure.
 */
function readLiterals(source, index) {
  const literals = [];
  let at = skipSpace(source, index);
  let depth = 0;

  while (at < source.length) {
    const char = source[at];

    if (char === '"' || char === "'") {
      const literal = readStringLiteral(source, at);
      if (!literal) return literals;
      literals.push(literal.value);
      at = literal.end;
      continue;
    }
    if (char === "`") {
      const literal = readTemplateLiteral(source, at);
      if (!literal) return literals;
      literals.push(literal.value);
      at = literal.end;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      at += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return literals;
      depth -= 1;
      at += 1;
      continue;
    }
    // A statement boundary at depth 0 means the expression ended without a
    // closer of its own (a bare `href="/x"` attribute, a property value).
    if (depth === 0 && (char === ";" || char === "\n")) {
      const next = skipSpace(source, at);
      if (next >= source.length) return literals;
      const following = source[next];
      if (following !== "?" && following !== ":" && following !== "|" && following !== "&") {
        return literals;
      }
      at = next;
      continue;
    }
    at += 1;
  }
  return literals;
}

/**
 * The JSX tag an attribute belongs to, or `null`.
 *
 * A CAPITALISED tag is a React component — `<Link>`, `<Redirect>` — whose `href`
 * is a route. A lowercase one is a DOM element, and `<link rel="canonical"
 * href="/x">` or `<link rel="icon" href="/icon-192.png">` addresses a URL or a
 * static asset in `public/`, which is a different namespace from the route tree.
 * Reading those as routes is what produced the first run's eleven false
 * findings, every one of them a real file.
 */
function enclosingTagName(source, index) {
  for (let at = index - 1; at >= 0 && index - at < 4096; at -= 1) {
    if (source[at] === ">") return null;
    if (source[at] !== "<") continue;
    const match = /^<\s*([A-Za-z_$][\w$.]*)/.exec(source.slice(at, at + 64));
    return match ? match[1] : null;
  }
  return null;
}

/**
 * `router.push(` and friends. Anchored on the receiver `router` because
 * `out.push(` and `parts.push(` are array writes — 18 and 8 of them in these
 * three apps — and a bare `\.push\(` would report those as dead routes.
 */
const NAVIGATION_CALL = /\brouter\s*\.\s*(?:push|replace|navigate|prefetch)\s*\(/g;

/** `href={…}` / `href="…"` as a JSX attribute. */
const HREF_ATTRIBUTE = /\bhref\s*=\s*/g;

/** `href:` / `pathname:` / `route:` as an object property. */
const TARGET_PROPERTY = /\b(?:href|pathname|route)\s*:\s*/g;

/**
 * Anything binding `useRouter()` to a name other than `router`.
 *
 * The call anchor above only sees a receiver spelled `router`. All 88 bindings
 * in these three apps are, so that is safe TODAY — and this is what stops it
 * being quietly untrue tomorrow. Without it, renaming one binding would remove
 * that file's call sites from the scan and the guard would go on reporting a
 * clean tree.
 */
const ROUTER_BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useRouter\s*\(\s*\)/g;

function lineOf(source, index) {
  let line = 1;
  for (let at = 0; at < index && at < source.length; at += 1) {
    if (source[at] === "\n") line += 1;
  }
  return line;
}

function extractTargets(source, file) {
  const found = [];

  const collect = (pattern, position, skip) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (skip && skip(match)) continue;
      const line = lineOf(source, match.index);
      const literals = readLiterals(source, match.index + match[0].length);
      if (literals.length === 0) {
        found.push({ file, line, position, kind: "unresolvable" });
        continue;
      }
      for (const skeleton of literals) {
        found.push({ file, line, position, kind: "static", skeleton });
      }
    }
  };

  collect(NAVIGATION_CALL, "call");
  collect(
    HREF_ATTRIBUTE,
    "attribute",
    (match) => {
      const tag = enclosingTagName(source, match.index);
      // No enclosing tag means this is an object property spelled `href =`,
      // which the property scan already covers; a lowercase tag is a DOM
      // element whose href is not a route.
      return tag === null || /^[a-z]/.test(tag);
    },
  );
  collect(TARGET_PROPERTY, "property");
  return found;
}

// ------------------------------------------------------------------- scan ---

const files = trackedFiles();

const counts = {
  files: 0,
  routes: 0,
  targets: 0,
  unresolvable: 0,
  offsite: 0,
  shells: 0,
  routerBindings: 0,
};
const exceptionHits = new Map(KNOWN_EXCEPTIONS.map((_, at) => [at, 0]));

/** Per-app counts, printed on success so the floors below stay auditable. */
const perApp = [];

for (const app of APPS) {
  const routes = buildRouteTree(app, files);
  const appFiles = files.filter(
    (file) => file.startsWith(`${app.prefix}/`) && SOURCE_FILE.test(file),
  );

  let appTargets = 0;

  for (const file of appFiles) {
    let raw;
    try {
      raw = readFileSync(resolve(repositoryRoot, file), "utf8");
    } catch (error) {
      failures.push(
        `${file} is tracked but could not be read (${error.code ?? error.message}) — an unreadable `
        + "file makes every assertion over it vacuous",
      );
      continue;
    }
    counts.files += 1;

    const source = blankComments(raw);

    if (isWebHtmlShell(file)) {
      // The skip cannot hide a navigation call, because there is one assertion
      // it still has to pass.
      NAVIGATION_CALL.lastIndex = 0;
      if (NAVIGATION_CALL.test(source)) {
        failures.push(
          `${file} is the web HTML shell, which this guard skips because its href attributes address `
          + "static assets rather than routes — but it calls router.push/replace. The shell renders "
          + "before the router exists and cannot navigate, so that call is dead on its own terms.",
        );
      }
      NAVIGATION_CALL.lastIndex = 0;
      counts.shells += 1;
      continue;
    }

    /**
     * The call anchor matches a receiver spelled `router` and nothing else.
     * Every one of the bindings in these three apps is, so that is safe TODAY —
     * and this is what stops it being quietly untrue tomorrow. Renaming one
     * binding would drop that file's call sites out of the scan, and the guard
     * would go on reporting a clean tree over a file it had stopped reading.
     */
    ROUTER_BINDING.lastIndex = 0;
    let binding;
    while ((binding = ROUTER_BINDING.exec(source)) !== null) {
      counts.routerBindings += 1;
      if (binding[1] === "router") continue;
      failures.push(
        `${file}:${lineOf(source, binding.index)} binds useRouter() to \`${binding[1]}\` rather than `
        + "`router`. This guard anchors navigation calls on the receiver `router` — a bare `.push(` "
        + "would report every `out.push(` and `parts.push(` in the tree as a dead route — so a "
        + "differently named binding removes this file's navigation from the scan silently. Name it "
        + "`router`, as all the others are.",
      );
    }
    ROUTER_BINDING.lastIndex = 0;

    for (const target of extractTargets(source, file)) {
      if (target.kind === "unresolvable") {
        counts.unresolvable += 1;
        continue;
      }

      const parsed = parseTarget(target.skeleton);
      if (parsed.kind === "relative" || parsed.kind === "external") {
        counts.offsite += 1;
        continue;
      }
      if (parsed.kind === "unresolvable") {
        counts.unresolvable += 1;
        continue;
      }

      appTargets += 1;
      counts.targets += 1;
      if (resolvesAgainst(routes, parsed.segments)) continue;

      const rendered = `/${parsed.segments.join("/")}`.replaceAll(HOLE, "${…}");
      const excused = KNOWN_EXCEPTIONS.findIndex(
        (entry) => entry.file === target.file && entry.target === rendered,
      );
      if (excused >= 0) {
        exceptionHits.set(excused, exceptionHits.get(excused) + 1);
        continue;
      }

      failures.push(
        `${target.file}:${target.line} navigates to ${rendered}, which matches no route in the `
        + `${app.name} app. tsc does NOT catch this when a dynamic route sits above the mistyped `
        + "segment — that is #456, and it is why this guard exists. Fix the target, or use the "
        + "OBJECT form ({ pathname: '/real/[param]', params }), which tsc checks completely.",
      );
    }
  }

  counts.routes += routes.length;
  perApp.push(`${app.name} ${appFiles.length}f/${routes.length}r/${appTargets}t`);

  // ------------------------------------------- per-app floors (load-bearing) ---

  if (appFiles.length < MINIMUM_FILES_PER_APP) {
    failures.push(
      `the ${app.name} app contributed ${appFiles.length} scanned file(s), below ${MINIMUM_FILES_PER_APP}. `
      + `Its prefix ${app.prefix}/ matched nothing, so this guard is not covering that app at all — `
      + "and a scan that reads nothing reports a clean tree.",
    );
  }
  if (routes.length < MINIMUM_ROUTES_PER_APP + SYNTHETIC_ROUTES.length) {
    failures.push(
      `the ${app.name} app produced ${routes.length} route(s) including the ${SYNTHETIC_ROUTES.length} `
      + "synthetic ones — its app/ directory matched nothing, so every target in it would resolve "
      + "against an empty tree and be reported as dead, or the walker is broken.",
    );
  }
  if (appTargets < MINIMUM_TARGETS_PER_APP) {
    failures.push(
      `the ${app.name} app produced ${appTargets} resolvable navigation target(s), below `
      + `${MINIMUM_TARGETS_PER_APP}. Every app navigates; zero means the extractor stopped matching `
      + "rather than that the app stopped navigating.",
    );
  }

  // ------------------------------- controls, run against the REAL route tree ---

  /**
   * POSITIVE. Every route in the tree, rendered as the target that reaches it,
   * must resolve. A matcher that had stopped matching would fail here first, and
   * the failure would be a fact about the matcher rather than about the app.
   */
  for (const route of routes) {
    const asTarget = route.map((segment) => (isParamSegment(segment) ? HOLE : segment));
    if (resolvesAgainst(routes, asTarget)) continue;
    failures.push(
      `POSITIVE CONTROL FAILED in ${app.name}: the real route /${route.join("/")} does not resolve `
      + "against its own tree. The matcher is broken, so every 'resolves fine' answer above it is "
      + "worthless.",
    );
  }

  /**
   * NEGATIVE, derived from REAL routes rather than hardcoded.
   *
   * ## The control that looked obvious and is WRONG
   *
   * The first version mistyped a route's last static segment and asserted the
   * result did not resolve. It failed immediately on `/products/new` ->
   * `/products/new-mercaria-not-a-route`, and the matcher was RIGHT: the
   * dashboard has `/products/[id]`, so a mistyped `new` is a perfectly good URL
   * that resolves to the dynamic route with that text as the id. Nothing can
   * flag it — not this guard, not `tsc`, not expo-router — because it is not an
   * error. A mistyped segment is only DEAD when no dynamic route can absorb it,
   * and that is a property of the tree, not of the typo.
   *
   * So the control below mistypes a segment only at a position where the tree
   * has no absorbing param, and additionally runs a length control (a real route
   * with one more segment than any route can have), which no param can absorb.
   * Two independent controls, because each is silent about the other's failure.
   */
  let negativesRun = 0;

  const canBeAbsorbed = (prefixSegments) =>
    routes.some(
      (route) =>
        route.length > prefixSegments.length
        && isParamSegment(route[prefixSegments.length])
        && prefixSegments.every((segment, index) => segment === route[index]),
    );

  for (const route of routes) {
    const at = route.findLastIndex((segment) => !isParamSegment(segment));
    if (at < 0) continue;
    // Only a position no dynamic sibling covers is evidence about the matcher.
    if (canBeAbsorbed(route.slice(0, at))) continue;
    const mistyped = route.map((segment, index) =>
      index === at ? `${segment}-mercaria-not-a-route` : isParamSegment(segment) ? HOLE : segment,
    );
    negativesRun += 1;
    if (!resolvesAgainst(routes, mistyped)) continue;
    failures.push(
      `NEGATIVE CONTROL FAILED in ${app.name}: /${mistyped.join("/")} resolved, but no such route `
      + "exists and no dynamic route sits at that position to absorb it. The matcher admits a "
      + "mistyped segment, which is the entire class of bug this guard was written to catch — it is "
      + "now reporting clean because it cannot fail.",
    );
  }

  /**
   * LENGTH control: a real route plus a segment nothing declares. Immune to the
   * absorption above, since a param consumes exactly one segment and a catch-all
   * is excluded explicitly.
   */
  const longest = Math.max(...routes.map((route) => route.length));
  for (const route of routes) {
    if (route.length !== longest) continue;
    if (route.some(isCatchAllSegment)) continue;
    const overlong = [
      ...route.map((segment) => (isParamSegment(segment) ? HOLE : segment)),
      "mercaria-not-a-route",
    ];
    negativesRun += 1;
    if (!resolvesAgainst(routes, overlong)) continue;
    failures.push(
      `NEGATIVE CONTROL FAILED in ${app.name}: /${overlong.join("/")} resolved, but it is one segment `
      + `longer than the longest route in the app (${longest}) and no catch-all declares it. The `
      + "matcher is accepting targets past the end of a route.",
    );
  }

  if (negativesRun < 1) {
    failures.push(
      `no negative control ran for ${app.name}: every route was either absorbable or a catch-all, so `
      + "the controls above assert nothing about the matcher.",
    );
  }
}

// --------------------------------------- the shared package must stay clear ---

const uiNavigation = files.filter(
  (file) => file.startsWith(`${UI_PREFIX}/`) && SOURCE_FILE.test(file),
).filter((file) => {
  let source;
  try {
    source = readFileSync(resolve(repositoryRoot, file), "utf8");
  } catch (error) {
    // Reading `false` here would answer "no navigation found" for a file nobody
    // could read, which is the permissive direction and the whole failure mode
    // this file is written against.
    failures.push(
      `${file} is tracked but could not be read (${error.code ?? error.message}), so whether the `
      + `shared package spells a route is UNKNOWN rather than no.`,
    );
    return false;
  }
  NAVIGATION_CALL.lastIndex = 0;
  const navigates = NAVIGATION_CALL.test(blankComments(source));
  NAVIGATION_CALL.lastIndex = 0;
  return navigates;
});

if (uiNavigation.length > 0) {
  failures.push(
    `${uiNavigation.join(", ")} calls router.push/replace inside ${UI_PREFIX}, which this guard does `
    + "NOT scan: a shared component is consumed by three apps with three different route trees, so a "
    + "literal there has no single tree to be resolved against. Take the target as an `Href` prop and "
    + "let the app that owns the route spell it.",
  );
}

// ---------------------------------------------------------- global floors ---

if (counts.files < MINIMUM_FILES_TOTAL) {
  failures.push(
    `scanned ${counts.files} source file(s) across the three apps, below the floor of `
    + `${MINIMUM_FILES_TOTAL}. A traversal that read nothing reports a clean tree.`,
  );
}
if (counts.routes < MINIMUM_ROUTES_TOTAL) {
  failures.push(
    `built ${counts.routes} route(s) across the three apps, below the floor of `
    + `${MINIMUM_ROUTES_TOTAL}. An empty route tree makes every target dead, or the walker is broken.`,
  );
}
if (counts.targets < MINIMUM_TARGETS_TOTAL) {
  failures.push(
    `found ${counts.targets} resolvable navigation target(s), below the floor of `
    + `${MINIMUM_TARGETS_TOTAL}. The subject of this guard is the targets, and finding none is `
    + "indistinguishable from finding none wrong.",
  );
}

// ------------------------------------------------- the exemptions are exact ---

for (const [at, hits] of exceptionHits) {
  const entry = KNOWN_EXCEPTIONS[at];
  if (hits === entry.count) continue;
  failures.push(
    `KNOWN_EXCEPTIONS[${at}] (${entry.file} -> ${entry.target}) covered ${hits} finding(s) but `
    + `declares ${entry.count}. An excusing entry is a predicate, not an identity: if it now covers `
    + "more than it says, it is excusing something nobody agreed to, and if it covers fewer the site "
    + "it was written for is gone and the entry should be deleted.",
  );
}

// ---------------------------------------------------------------- verdict ---

if (failures.length > 0) {
  console.error("Route-target guard failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  typedRoutes checks the OBJECT form completely and a template literal only when no dynamic\n"
    + "  route sits above the mistyped segment (#456). This guard covers the rest by resolving each\n"
    + "  target's static skeleton against the real route tree on disk.\n",
  );
  process.exit(1);
}

console.log(
  `Route-target guard passed — ${counts.targets} navigation target(s) resolved against `
  + `${counts.routes} route(s) across ${APPS.length} apps, ${counts.files} files scanned. `
  + `${counts.unresolvable} target(s) carry no static prefix and ${counts.offsite} are relative or `
  + "external; neither is checkable here and neither is claimed to be. Positive and negative "
  + `controls ran against the real trees. Per app: ${perApp.join(" · ")}; `
  + `${counts.shells} web HTML shell(s) skipped.`,
);
