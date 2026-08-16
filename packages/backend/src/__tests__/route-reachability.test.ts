/**
 * ROUTE REACHABILITY, as a gate rather than a census.
 *
 * An unreachable screen is the one defect that shows no symptom: it compiles,
 * it typechecks, its tests pass, the build ships, and nobody can get to it.
 * #363 measured this once and found 13 of 65 routes unreachable, including two
 * complete, tested, shipped features (`/shopping-agents` #97,
 * `/referral-partner` #147). Measured once, that decays immediately — the next
 * screen to land unlinked is invisible again — so the measurement lives here,
 * runs on every push, and fails.
 *
 * The method, its limits and why it is transitive rather than a grep are in
 * `route-reachability/analyze.ts`. Read the "What it CANNOT see" section there
 * before trusting a green run: reachable is an UPPER bound, so a route this
 * calls reachable may still be unreachable in practice, while the unreachable
 * set it reports is a LOWER bound and every member of it is real.
 *
 * ## Where this lives, and what that costs
 *
 * A backend test that reads three other packages. The storefront, dashboard and
 * POS have no test runner of their own, and the backend suite is the only thing
 * CI runs — `seller-identity-isolation.test.ts` and
 * `commercial-presentation-isolation.test.ts` already scan `packages/frontend`
 * from here for exactly that reason, so this follows the precedent rather than
 * introducing a fourth runner.
 *
 * The cost is real and worth stating twice, because both halves are the kind of
 * thing that gets a gate deleted:
 *
 *  - **It fails for changes made in packages it does not belong to.** Delete a
 *    nav entry in the storefront and the BACKEND suite goes red, naming a route
 *    rather than a file somebody just edited. That is the intended trade; the
 *    alternative is a gate nothing runs.
 *  - **It costs about 9 seconds of the suite's test time**, of which roughly
 *    2.2s is one cold analysis of all three apps (measured below) and the rest
 *    is the two extra analyses the mutation self-test needs and the receiver
 *    census. It opens no database and starts no app — it reads the filesystem
 *    and parses ~800 modules — so it adds no flake surface to a suite whose
 *    known intermittency is Postgres contention.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  analyzeApp,
  clearSourceFileCache,
  matchTarget,
  navTargetsOf,
  parseSourceFile,
  parseTargetSegments,
  type AppReachability,
  type RouteRecord,
} from './route-reachability/analyze.js';
import { ROUTE_DISPOSITIONS, type RouteDisposition } from './route-reachability/dispositions.js';

/** `<repo>/packages`, from `packages/backend/src/__tests__`. */
const PACKAGES_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * The three Expo apps, with a FLOOR on what the walk must find in each.
 *
 * An EXACT list rather than a directory scan, and floors rather than nothing:
 * "I found no unreachable screens" and "I read nothing" produce the same empty
 * list, and an app that stopped being walked at all is precisely the failure
 * this gate would otherwise report as success.
 *
 * The floors sit just below the measured values so ordinary growth does not
 * churn them, while deleting a package, moving `app/`, or breaking module
 * resolution — each of which collapses a count to near zero — fails here.
 */
const APPS = [
  { app: 'frontend', minRoutes: 30, minModules: 200, minTargets: 50 },
  { app: 'dashboard', minRoutes: 22, minModules: 150, minTargets: 25 },
  { app: 'pos', minRoutes: 6, minModules: 150, minTargets: 10 },
] as const;

const analyzed = new Map<string, AppReachability>();
function reachabilityOf(app: string): AppReachability {
  const cached = analyzed.get(app);
  if (cached !== undefined) return cached;
  const result = analyzeApp({
    app,
    appRoot: join(PACKAGES_ROOT, app),
    packagesRoot: PACKAGES_ROOT,
  });
  analyzed.set(app, result);
  return result;
}

function dispositionsFor(app: string): Readonly<Record<string, RouteDisposition>> {
  return ROUTE_DISPOSITIONS[app] ?? {};
}

describe('the census is not vacuous', () => {
  for (const { app, minRoutes, minModules, minTargets } of APPS) {
    it(`${app}: enumerates routes, walks modules and finds navigation`, () => {
      const result = reachabilityOf(app);
      expect(
        result.routes.length,
        `${app}: the route walk found ${result.routes.length} routes. An empty or tiny route ` +
          'table makes every assertion in this file pass against nothing.',
      ).toBeGreaterThanOrEqual(minRoutes);
      expect(
        result.modulesScanned.length,
        `${app}: the import walk reached ${result.modulesScanned.length} modules. A resolver ` +
          'that stopped resolving reports every screen unreachable, which is loud — but one ' +
          'that reached only the entry file reports almost nothing, which is not.',
      ).toBeGreaterThanOrEqual(minModules);
      expect(
        result.targets.length,
        `${app}: the extractor found ${result.targets.length} navigation targets. Zero targets ` +
          'and "no navigation exists" are the same reading.',
      ).toBeGreaterThanOrEqual(minTargets);
    });
  }
});

describe('THE GATE: every route is reachable, or says why it is not', () => {
  for (const { app } of APPS) {
    it(`${app}: no route is in neither list`, () => {
      const result = reachabilityOf(app);
      const dispositions = dispositionsFor(app);
      const undecided = result.unreachable.filter((route) => dispositions[route] === undefined);

      expect(
        undecided,
        `${app}: these screens exist and no user can reach them by tapping from the app root, ` +
          'and nothing says why.\n\n' +
          undecided
            .map((route) => {
              const record = result.routes.find((candidate) => candidate.route === route);
              return `  ${route}  (${record?.file.replace(PACKAGES_ROOT + '/', '') ?? '?'})`;
            })
            .join('\n') +
          '\n\nGive each one an inbound edge from a reachable screen, or add it to ' +
          'ROUTE_DISPOSITIONS in route-reachability/dispositions.ts with a REASON. Being in ' +
          'neither must fail — that is the whole gate.',
      ).toEqual([]);
    });

    it(`${app}: no disposition excuses a route that is reachable or gone`, () => {
      const result = reachabilityOf(app);
      const routes = new Set(result.routes.map((route) => route.route));
      const unreachable = new Set(result.unreachable);

      for (const [route, disposition] of Object.entries(dispositionsFor(app))) {
        expect(
          routes.has(route),
          `${app}: ${route} is excused in ROUTE_DISPOSITIONS and no such route exists. A ` +
            'deleted screen must not keep its excuse, or the list becomes a place to hide a ' +
            'route nobody re-examined.',
        ).toBe(true);
        expect(
          unreachable.has(route),
          `${app}: ${route} is excused in ROUTE_DISPOSITIONS and is now REACHABLE. Delete the ` +
            'entry. This is what stops the list ossifying: wiring a screen forces its excuse ' +
            'out instead of leaving a stale one behind.',
        ).toBe(true);
        expect(
          disposition.kind === 'deliberate' ? disposition.reason : disposition.question,
          `${app}: ${route} has no reason recorded`,
        ).toBeTruthy();
      }
    });
  }

  /**
   * The exemption list's own exact-count assertion.
   *
   * `~/Oxy/AGENTS.md`: a list of exemptions needs an EXACT count rather than a
   * floor, because an ever-growing one is the gate switching itself off one
   * defensible line at a time. Changing these numbers is the visible decision.
   */
  it('the exemption list is exactly the size it was last agreed to be', () => {
    const all = APPS.flatMap(({ app }) =>
      Object.entries(dispositionsFor(app)).map(([route, disposition]) => ({
        app,
        route,
        kind: disposition.kind,
      })),
    );
    const deliberate = all.filter((entry) => entry.kind === 'deliberate');
    const awaiting = all.filter((entry) => entry.kind === 'awaiting_product_decision');

    expect(
      deliberate.map((entry) => `${entry.app}${entry.route}`).sort(),
      'the DELIBERATE list changed. A route unreachable BY DESIGN is rare — the only one is a ' +
        'provider return URL. Adding one means in-app navigation must never reach that screen; ' +
        'if the truth is "nobody has wired it yet", it is awaiting_product_decision instead.',
    ).toEqual(['frontend/checkout/return']);

    expect(
      awaiting.length,
      `${awaiting.length} routes are unreachable and awaiting a product decision, not 4. If a ` +
        'screen was wired, delete its entry and lower this number — that is the direction this ' +
        'list is meant to move. If a new one landed unreachable, wiring it is usually cheaper ' +
        'than justifying it.',
    ).toBe(4);
  });

  it('dashboard and POS are fully reachable, and stay that way', () => {
    // Both were 24/24 and 7/7 at #363's census and still are. Asserted
    // separately from the gate above because "zero unreachable" is a property
    // worth losing loudly rather than absorbing into a disposition list.
    expect(reachabilityOf('dashboard').unreachable).toEqual([]);
    expect(reachabilityOf('pos').unreachable).toEqual([]);
    expect(dispositionsFor('dashboard')).toEqual({});
    expect(dispositionsFor('pos')).toEqual({});
  });
});

describe('POSITIVE CONTROLS: the walk really is transitive', () => {
  it('reaches a screen that is three hops from the root', () => {
    // `/families/[handle]` is reachable ONLY through `/brands/[handle]`, which
    // is reachable only through `/merchants/[idOrSlug]`. A one-hop walk from
    // the root reports all three unreachable; a file-level grep reports them
    // reachable whether or not anything renders the linking component.
    const result = reachabilityOf('frontend');
    for (const route of ['/merchants/[idOrSlug]', '/brands/[handle]', '/families/[handle]']) {
      expect(result.reachable.has(route), `${route} should be reachable`).toBe(true);
    }
    const edges = result.inboundEdges.get('/families/[handle]') ?? [];
    expect(edges.some((file) => file.includes('brands'))).toBe(true);
  });

  /**
   * THE positive control, and it is chosen rather than invented.
   *
   * These six routes were measured UNREACHABLE by #363's own independent
   * census (a regex-based instrument, not this one) and were given an inbound
   * edge by `8477cf2`. So they are the only six screens in the repository whose
   * reachability is known to have CHANGED, and a gate that cannot tell the
   * difference on them is measuring nothing — it would have reported the
   * pre-8477cf2 tree clean.
   *
   * Its shelf life is the shelf life of those edges: if one is removed, this
   * fails alongside the gate itself, which is the correct outcome and not a
   * reason to soften it.
   */
  it("#363's six: every screen that commit wired is reachable", () => {
    const result = reachabilityOf('frontend');
    const wiredBy363 = [
      '/brands/[handle]',
      '/families/[handle]',
      '/referral-partner',
      '/shopping-agents',
      '/watchlists',
      '/watchlists/[watchlistId]',
    ];
    const missing = wiredBy363.filter((route) => !result.reachable.has(route));
    expect(
      missing,
      'these were unreachable before 8477cf2 and were wired by it. If this walk cannot see ' +
        'them, it would have called the tree clean when two shipped features (#97, #147) were ' +
        'unreachable — which is the exact failure this gate exists to prevent.',
    ).toEqual([]);
    // The vacuity floor on the control itself: all six must still EXIST, or
    // "none missing" is what a deleted-screen list also reports.
    const routes = new Set(result.routes.map((route) => route.route));
    expect(wiredBy363.filter((route) => routes.has(route))).toHaveLength(6);
  });

  it('reads a route that travels through a `RoutePath`-typed helper', () => {
    // `account-section.tsx` navigates with `go = (route: RoutePath) => ...` and
    // passes `"/(app)/watchlists"` as a CALL ARGUMENT — a position no
    // `router.push`/`href` rule sees. Five of the storefront's account
    // shortcuts travel this way; before this rule existed they all reported
    // unreachable, contradicting #363, which is how the gap was found.
    const result = reachabilityOf('frontend');
    for (const route of ['/watchlists', '/shopping-agents', '/referral-partner', '/settings/addresses']) {
      expect(result.reachable.has(route), `${route} should be reachable via go()`).toBe(true);
    }
  });

  it('follows a route reached only from another route, not from a layout', () => {
    const result = reachabilityOf('frontend');
    expect(result.reachable.has('/price-alerts')).toBe(true);
    expect((result.inboundEdges.get('/price-alerts') ?? []).every((file) => file.includes('saved'))).toBe(
      true,
    );
  });
});

describe('NEGATIVE CONTROLS: the extractor is context-sensitive, not a literal scan', () => {
  it('the sitemap table names every route and creates no edge', () => {
    /**
     * The measurement that decided the whole design.
     *
     * `shared-types/src/seo.ts` carries the public route registry and names
     * `/compare`, `/notifications`, `/sell`, `/watchlists` and most of the rest
     * as plain string literals — and it IS inside the scanned module set,
     * because the storefront imports it. A scan that counted route-shaped
     * literals wherever they appear would therefore report EVERY screen
     * reachable, forever, and this gate would be silently vacuous from the day
     * it landed. `packages/frontend/lib/api/*.ts` collides the same way:
     * `/notifications` is an API path AND a route.
     *
     * So the assertion is not decoration. It is the proof that the extractor
     * reads navigation POSITIONS.
     */
    const result = reachabilityOf('frontend');
    const seo = result.modulesScanned.find((file) => file.endsWith('shared-types/src/seo.ts'));
    expect(seo, 'seo.ts is not in the scanned set, so this control proves nothing').toBeDefined();

    const seoSource = ts.sys.readFile(seo ?? '') ?? '';
    expect(seoSource, 'seo.ts does not name /compare, so this control proves nothing').toContain(
      '/compare',
    );
    expect(
      result.unreachable,
      'a route named in the sitemap table became reachable, which means the extractor started ' +
        'counting literals rather than navigation positions. Every screen now reads reachable.',
    ).toContain('/compare');

    expect(navTargetsOf(seo ?? '')).toEqual([]);
  });

  it('an API path that shares a route name creates no edge', () => {
    // `apiClient.get('/cart')` is the same string as the route `/cart`, in a
    // module the storefront really imports and which really is in the closure.
    // A literal scan would read a screen's own data layer as an inbound edge to
    // it — and `/notifications` shows how far that goes: it is BOTH an API path
    // and a screen, so such a scan would report it reachable from the hook that
    // fetches its contents.
    const result = reachabilityOf('frontend');
    const api = join(PACKAGES_ROOT, 'frontend', 'lib', 'api', 'cart.ts');
    expect(existsSync(api), 'the cart API client moved; repoint this control').toBe(true);
    expect(ts.sys.readFile(api) ?? '', 'this control needs the literal it is about').toContain(
      "'/cart'",
    );
    expect(
      result.modulesScanned,
      'the cart API client is not in the closure, so this control proves nothing',
    ).toContain(api);
    expect(
      navTargetsOf(api),
      'an API client produced a navigation target. The extractor is reading literals rather ' +
        'than navigation positions, and every screen whose data layer names its own path now ' +
        'reads as reachable from itself.',
    ).toEqual([]);
  });

  it('an unimported module contributes nothing, however many routes it names', () => {
    // #363's finding, and the reason reachability is a fixpoint rather than a
    // set of edges: `components/sidebar.tsx` (with `settings-sidebar.tsx`) is a
    // whole second sidebar carrying a five-entry route table that NOTHING
    // imports. Its edges are dead. If it ever enters the closure this control
    // fails, and whoever wired it can retire the control knowingly.
    const orphan = join(PACKAGES_ROOT, 'frontend', 'components', 'sidebar.tsx');
    expect(existsSync(orphan), 'the orphan sidebar was deleted; retire this control').toBe(true);
    expect(navTargetsOf(orphan).length, 'the orphan sidebar names no routes any more').toBeGreaterThan(0);
    expect(
      reachabilityOf('frontend').modulesScanned,
      'components/sidebar.tsx is now imported by something reachable. Its five route entries ' +
        'are live edges — re-derive the unreachable set before retiring this control.',
    ).not.toContain(orphan);
  });
});

describe('MUTATION SELF-TEST: the gate can go red, transitively', () => {
  /**
   * The proof that matters, and the one #363 named: removing the ONLY inbound
   * edge to `/saved` must strand `/price-alerts` too, because `/price-alerts`
   * is reachable only from `/saved`.
   *
   * A gate that catches only DIRECT edges passes this mutation at +1 and looks
   * correct. +2 is what says the walk is a fixpoint.
   *
   * The mutation is applied through `suppressEdgesTo` rather than by editing a
   * storefront file: an in-place edit of a shared checkout is how a sibling
   * agent's work gets reverted, and a mutation that never applied is
   * indistinguishable from one that survived.
   */
  it('suppressing the only /saved edge strands /price-alerts as well', () => {
    const before = reachabilityOf('frontend');
    const after = analyzeApp({
      app: 'frontend',
      appRoot: join(PACKAGES_ROOT, 'frontend'),
      packagesRoot: PACKAGES_ROOT,
      suppressEdgesTo: new Set(['/saved']),
    });

    expect(before.unreachable).not.toContain('/saved');
    expect(before.unreachable).not.toContain('/price-alerts');

    expect(after.unreachable).toContain('/saved');
    expect(
      after.unreachable,
      'removing the /saved nav entry stranded /saved but NOT /price-alerts, which is reachable ' +
        'only from /saved. The walk is counting direct edges rather than computing a fixpoint.',
    ).toContain('/price-alerts');

    expect(after.unreachable.length).toBe(before.unreachable.length + 2);
  });

  it('a suppressed edge to a leaf strands exactly one route', () => {
    // The control on the control: the +2 above must come from transitivity, not
    // from the suppression mechanism removing two routes by itself.
    const before = reachabilityOf('frontend');
    const after = analyzeApp({
      app: 'frontend',
      appRoot: join(PACKAGES_ROOT, 'frontend'),
      packagesRoot: PACKAGES_ROOT,
      suppressEdgesTo: new Set(['/search']),
    });
    expect(after.unreachable.length).toBe(before.unreachable.length + 1);
  });
});

describe('the matcher refuses the two ways its predecessor failed PERMISSIVE', () => {
  const routes: RouteRecord[] = [
    { route: '/settings/general', file: 'a', segments: [{ kind: 'static', value: 'settings' }, { kind: 'static', value: 'general' }] },
    { route: '/p/[handle]', file: 'b', segments: [{ kind: 'static', value: 'p' }, { kind: 'param', value: '[handle]' }] },
    { route: '/products/new', file: 'c', segments: [{ kind: 'static', value: 'products' }, { kind: 'static', value: 'new' }] },
    { route: '/products/[id]', file: 'd', segments: [{ kind: 'static', value: 'products' }, { kind: 'param', value: '[id]' }] },
  ];
  const match = (raw: string): string[] => {
    const segments = parseTargetSegments(raw);
    expect(segments, `${raw} did not parse as an in-app path`).not.toBeNull();
    return matchTarget(segments ?? [], routes).map((route) => route.route).sort();
  };

  it('an interpolated segment matches a parameter and NEVER a literal', () => {
    // WALL 6 read `${x}` as a token and its resolver treated it as a wildcard
    // matching any route of the same length, so `/settings/${page}` reported
    // `/settings/general` reachable. That is a screen called reachable that is
    // not, which is the only direction that fails silently.
    expect(match('/p/${}')).toEqual(['/p/[handle]']);
    expect(match('/settings/${}')).toEqual([]);
  });

  it('a static route wins outright over its dynamic sibling', () => {
    // Otherwise a link to `/products/new` also counts as an inbound edge to
    // `/products/[id]`, and a dynamic route reads as reachable because a
    // sibling static one is linked.
    expect(match('/products/new')).toEqual(['/products/new']);
    expect(match('/products/${}')).toEqual(['/products/[id]']);
  });

  it('query strings and group segments do not become path segments', () => {
    expect(match('/p/shoes?variant=2')).toEqual(['/p/[handle]']);
    expect(match('/(app)/products/new')).toEqual(['/products/new']);
  });

  it('an external or relative target is not an in-app route', () => {
    expect(parseTargetSegments('https://fonts.googleapis.com')).toBeNull();
    expect(parseTargetSegments('./sibling')).toBeNull();
    expect(parseTargetSegments('//cdn.example.com/x')).toBeNull();
  });
});

describe('the nav-call extractor sees every receiver the source actually uses', () => {
  /**
   * A positive control on the EXTRACTOR rather than on its output.
   *
   * `push` and `replace` are Array and String methods too, so the receiver is
   * checked as well as the method name — which means a route handed to a
   * differently-named receiver (`nav.push('/cart')`) would be silently skipped,
   * and a skipped edge is a screen reported unreachable that is not.
   *
   * So: find every call of a navigation VERB whose first argument is an
   * absolute-path literal, whatever the receiver is called, and assert the set
   * of receivers is exactly the one this extractor recognises. A new spelling
   * fails here and is a one-line fix, rather than quietly widening the
   * unreachable set later.
   */
  /**
   * Receivers that carry a navigation VERB's name and do not navigate.
   *
   * These are why the receiver is checked at all: `push` and `replace` belong
   * to Array and String as well as to expo-router's router, and treating a
   * bare method name as navigation would invent inbound edges — the permissive
   * direction, which fails silently.
   */
  const NON_NAVIGATING_RECEIVERS: Readonly<Record<string, string>> = {
    pathname: [
      "expo-router's usePathname() returns a STRING, and components/shell/nav-items.ts calls",
      'String.replace("/(app)", "") on it to normalise the active-tab comparison. The literal',
      'is a group prefix being stripped, not a destination — reading it as one would make the',
      'home tab an inbound edge to whatever route it happened to resemble.',
    ].join(' '),
  };

  /** Receiver spellings `isNavCallee` accepts today. */
  const NAVIGATING_RECEIVERS = ['router'];

  it('every nav-verb call taking a path literal has a recognised receiver', () => {
    const verbs = new Set(['push', 'replace', 'navigate', 'prefetch', 'dismissTo']);
    const receivers = new Set<string>();
    let inspected = 0;

    for (const { app } of APPS) {
      for (const file of reachabilityOf(app).modulesScanned) {
        const source = parseSourceFile(file);
        const visit = (node: ts.Node): void => {
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            verbs.has(node.expression.name.text) &&
            node.arguments.length > 0
          ) {
            const argument = node.arguments[0];
            const literal =
              (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
              argument.text.startsWith('/');
            const template =
              ts.isTemplateExpression(argument) && argument.head.text.startsWith('/');
            if (literal || template) {
              inspected += 1;
              receivers.add(node.expression.expression.getText());
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }

    expect(
      inspected,
      'no navigation call anywhere took a path literal, so this control read nothing',
    ).toBeGreaterThanOrEqual(30);
    expect(
      [...receivers].sort(),
      'a navigation verb is being called on a receiver that is neither recognised as navigation ' +
        'nor named as not-navigation. If it navigates, add the spelling to isNavCallee in ' +
        'analyze.ts — otherwise its targets are invisible and the screens they reach will ' +
        'report unreachable. If it does not, name it in NON_NAVIGATING_RECEIVERS with the ' +
        'reason. Being in neither must fail here for the same reason it does for a route.',
    ).toEqual([...NAVIGATING_RECEIVERS, ...Object.keys(NON_NAVIGATING_RECEIVERS)].sort());

    for (const [receiver, reason] of Object.entries(NON_NAVIGATING_RECEIVERS)) {
      expect(reason.length, `${receiver} is excused with no reason recorded`).toBeGreaterThan(40);
    }
  });
});

describe('the enumerator refuses what it does not understand', () => {
  it('classifies every file under app/ as route, layout or a NAMED special', () => {
    // `enumerateRoutes` throws on an expo-router special it has no rule for,
    // rather than skipping it. A file quietly dropped from the census is a
    // screen that stops being counted, and "I found fewer routes" reads exactly
    // like "there are fewer routes".
    for (const { app } of APPS) {
      expect(() => reachabilityOf(app)).not.toThrow();
    }
  });

  it('stays cheap enough that nobody has a reason to skip it', () => {
    /**
     * A gate people disable for being slow protects nothing.
     *
     * This measures a COLD analysis of all three apps — its own parse cache
     * emptied first, so the number is what the gate costs on a fresh run rather
     * than what a warmed cache flatters it to. It reads the filesystem and
     * parses roughly 800 modules; it opens no database and starts no app.
     *
     * The bound is deliberately loose. It is here to catch an accidental
     * quadratic — a fixpoint that stopped converging, or a resolver that began
     * re-walking `node_modules` — not to police a hundred milliseconds on a
     * loaded CI runner.
     */
    clearSourceFileCache();
    const started = Date.now();
    for (const { app } of APPS) {
      analyzeApp({
        app,
        appRoot: join(PACKAGES_ROOT, app),
        packagesRoot: PACKAGES_ROOT,
        // A route no app declares, so the run is a full one and the suppression
        // path itself is exercised rather than skipped.
        suppressEdgesTo: new Set(['/__not-a-route__']),
      });
    }
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
