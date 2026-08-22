/**
 * Every public read on a cacheable catalog surface serves a validator (#367
 * Workstream 1, "Add ETags/cache keys and deterministic ordering").
 *
 * ## What this defends that the contract suite does not
 *
 * `routes/__tests__/catalog-api-contract.realdb.test.ts` proves the exchange
 * WORKS — a 304 for an echo, two tags for two locales, four byte-identical
 * bodies staying distinguishable. It proves it for the reads it names. What
 * neither it nor anything else noticed is a read that is never named: a tenth
 * taxonomy handler added next month, wired into `routes/taxonomy.ts`, answering
 * 200 with no `ETag` on every request forever. Nothing goes red, because a test
 * that was never written cannot fail.
 *
 * So this gate does not test the exchange. It derives the population of GET
 * routes on these surfaces and asserts that each one's handler reaches the
 * responder. It is the entrypoint half of `~/Oxy/AGENTS.md`'s rule that a
 * mechanism can be GREEN AND INERT — `sendCacheable` being correct says nothing
 * about whether a given route calls it.
 *
 * ## Why these two surfaces and not "every catalog route"
 *
 * Because a validator is not free and not always wanted, and a gate that
 * demanded one everywhere would be answered by turning it off. The measured
 * position across the backend today: exactly three controllers set an `ETag` —
 * `taxonomy`, `navigation` and `catalog-authoring` — and the first two are the
 * ANONYMOUS ones, whose answer is identical for every reader and therefore
 * `Cache-Control: public`. Those are the surfaces where a missing validator is a
 * straightforward defect, so those are the ones held to it.
 *
 * `catalog-authoring` is deliberately outside: its reads are per-caller
 * (`permissionFingerprint` is a dimension of its key), they are mounted behind
 * authentication, and it serves ONE cacheable composition rather than a family
 * of reads, so there is no population to enumerate.
 *
 * The routes NOT held to this, and why, are recorded as data in
 * `CACHEABLE_SURFACES` rather than as an absence somebody has to notice.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A catalog surface whose public reads must all serve a validator.
 *
 * `responder` is the function that sets the header. Naming it here rather than
 * scanning for `setHeader` in the handler is deliberate: the taxonomy controller
 * funnels all nine of its reads through ONE `sendCacheable`, which is the shape
 * that makes "no route can acquire a tag and forget the exchange" true, and a
 * gate that accepted a hand-rolled `setHeader` in a handler would accept the
 * shape that breaks it.
 */
interface CacheableSurface {
  readonly routeFile: string;
  readonly controllerFile: string;
  readonly responder: string;
  /** Today's GET count, as a floor. */
  readonly floor: number;
}

const CACHEABLE_SURFACES: readonly CacheableSurface[] = [
  {
    routeFile: 'routes/taxonomy.ts',
    controllerFile: 'controllers/taxonomy.controller.ts',
    responder: 'sendCacheable',
    floor: 9,
  },
  {
    routeFile: 'routes/navigation.ts',
    controllerFile: 'controllers/navigation.controller.ts',
    // The navigation read composes its own tag in the service and sets the
    // header inline; there is one public read, so there is no family to funnel.
    responder: 'setHeader',
    floor: 1,
  },
];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * The handler identifier every `router.get(...)` on this file names.
 *
 * The LAST argument, which is where express puts the handler. Parsed from the
 * AST because these calls routinely span four lines — a line-oriented pattern
 * finds `router.get('/categories/roots', …)` and misses the seven multi-line
 * ones, which is a clean plausible count of two.
 */
function getRouteHandlers(routeFile: string): string[] {
  const parsed = parse(routeFile);
  const handlers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'router' &&
      node.arguments.length >= 2
    ) {
      const last = node.arguments[node.arguments.length - 1];
      if (last && ts.isIdentifier(last)) handlers.push(last.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return handlers;
}

/** Every identifier called anywhere inside the named function's body. */
function calleesOf(controllerFile: string, functionName: string): Set<string> {
  const parsed = parse(controllerFile);
  const called = new Set<string>();
  let found = false;

  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) called.add(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression)) {
        called.add(node.expression.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body) {
      found = true;
      collect(node.body);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);

  // A handler the controller does not declare is a FAILURE, not an empty set —
  // otherwise a renamed or re-exported handler reads as "calls nothing", which
  // this gate would then report as "serves no validator" for the wrong reason,
  // or (worse, if the polarity were inverted) skip.
  expect(found, `${controllerFile} declares ${functionName}`).toBe(true);
  return called;
}

describe('the route census reaches every public read', () => {
  assertEachOf(CACHEABLE_SURFACES, 2, (surface) => {
    it(`finds the GET routes of ${surface.routeFile}`, () => {
      const handlers = getRouteHandlers(join(SRC_ROOT, surface.routeFile));
      // The floor is what stops a broken parse reading as a surface with no
      // reads on it — which is the shape that would make every assertion below
      // vacuously true.
      expect(
        handlers.length,
        `${surface.routeFile} should register at least ${surface.floor} GET routes; finding ` +
          'fewer means the AST walk stopped matching, not that routes were deleted',
      ).toBeGreaterThanOrEqual(surface.floor);
      expect(new Set(handlers).size, 'each GET route names a distinct handler').toBe(
        handlers.length,
      );
    });
  });

  it('the surfaces held to this are exactly the anonymous cacheable ones', () => {
    // Asserted EXACTLY. A ceiling would let a surface quietly leave the list,
    // which is the gate switching itself off for the route that needed it.
    expect(CACHEABLE_SURFACES.map((surface) => surface.routeFile)).toEqual([
      'routes/taxonomy.ts',
      'routes/navigation.ts',
    ]);
  });
});

describe('every public read on a cacheable surface serves a validator', () => {
  assertEachOf(CACHEABLE_SURFACES, 2, (surface) => {
    it(`every GET handler in ${surface.routeFile} reaches ${surface.responder}`, () => {
      const routeFile = join(SRC_ROOT, surface.routeFile);
      const controllerFile = join(SRC_ROOT, surface.controllerFile);
      const handlers = getRouteHandlers(routeFile);
      const missing = handlers.filter(
        (handler) => !calleesOf(controllerFile, handler).has(surface.responder),
      );
      expect(
        missing,
        `these GET handlers answer without a cache validator. Every read on this surface is ` +
          `anonymous and identical for every caller, so it should answer through ` +
          `\`${surface.responder}\` — which sets the ETag AND honours If-None-Match together, ` +
          'so a route cannot acquire one and forget the other.',
      ).toEqual([]);
    });
  });
});

describe('the responder does what the routes are being held to', () => {
  it('the taxonomy responder sets an ETag and answers 304 in ONE place', () => {
    // The gate above asserts the handlers CALL it. That is worth nothing if the
    // thing they call stopped setting the header — a mechanism can be green and
    // inert from either end.
    const source = readFileSync(join(SRC_ROOT, 'controllers/taxonomy.controller.ts'), 'utf8');
    expect(source).toContain("res.setHeader('ETag'");
    expect(source).toContain('ifNoneMatchMatches(');
    expect(source).toContain('res.status(304)');
  });

  it('the navigation read sets an ETag and answers 304', () => {
    const source = readFileSync(join(SRC_ROOT, 'controllers/navigation.controller.ts'), 'utf8');
    expect(source).toContain("res.setHeader('ETag'");
    expect(source).toContain('ifNoneMatchMatches(');
    expect(source).toContain('res.status(304)');
  });
});
