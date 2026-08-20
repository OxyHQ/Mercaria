/**
 * Which forbidden symbols a module can reach THROUGH its imports (#568).
 *
 * A scanned wall that reads one module's own text answers "does this file
 * contain the word", and the thing it is meant to answer is "can this module
 * cause the write". Those come apart the moment somebody calls a function that
 * calls it — not as an evasion, usually, but as an ordinary refactor. It happened
 * here: `catalog-proposal-isolation.test.ts` forbids `insertAttributeDefinition`
 * in `review.service.ts`, an implementation called `draftAttributeDefinition`
 * instead, and the gate stayed green over a real violation. A gate that is green
 * on a violation is worse than none, because the next reader sees a passing
 * isolation suite and concludes the wall held.
 *
 * ## Why the walk is over SYMBOLS and not modules
 *
 * Measured before this was written: the module closure from
 * `services/catalog-proposals/review.service.ts` is 105 modules over 793 import
 * edges, and `db/attributes/definitionRepository.ts` holds BOTH
 * `insertAttributeEnumValue` — which that gate asserts must be PRESENT — and
 * `insertAttributeDefinition`, which it forbids. A walk that scanned the text of
 * imported modules would therefore go red on day one, on an import that was
 * always permitted, and the only way to make it green would be to weaken it.
 *
 * So the unit is `module#symbol`: for each named import a module actually uses,
 * the DECLARATION's body is scanned, and the symbols that body itself imports and
 * uses are walked in turn. Over the same entry that costs 60 bodies.
 *
 * ## What it deliberately does not do
 *
 * No type resolution, no call-graph analysis, no method dispatch. It follows
 * named value imports along RELATIVE specifiers, which is how this codebase
 * imports its own modules (the house rule is to import from the owner, and there
 * are no barrels to hop through). A dynamic `import()`, a symbol reached through
 * an object property, and anything behind a package boundary are all invisible —
 * so this raises the cost of an accidental wrapper, and is not a sandbox.
 *
 * `unresolvedBodies` is the vacuity floor and it matters more than the finding
 * count: a walker that resolves nothing reports no findings and reads exactly like
 * a clean wall. Callers assert it is zero.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** One way a forbidden symbol is reachable, and the hop that leads there. */
export interface ClosureFinding {
  /**
   * The FIRST hop out of the entry module — `relative/path.ts#exportedSymbol`.
   *
   * Findings are dispositioned on this rather than on the whole path, because the
   * decision a reviewer makes is which seam the guarded module is allowed to call.
   * A new wrapper is a new first hop and therefore a new, undispositioned finding;
   * refactoring the internals of a seam that is already dispositioned is not.
   */
  readonly firstHop: string;
  /** The forbidden pattern's `source`, so a message names what was found. */
  readonly forbidden: string;
  /** Entry → … → the body the symbol was found in. For the failure message. */
  readonly path: readonly string[];
}

export interface ImportClosureResult {
  readonly findings: readonly ClosureFinding[];
  /** Declaration bodies actually read. The positive control. */
  readonly bodiesScanned: number;
  /** Imports whose declaration could not be found. Must be 0, or the walk lied. */
  readonly unresolvedBodies: number;
}

export interface ImportClosureOptions {
  /** Absolute path of the source root that `entry` and reported paths are relative to. */
  readonly srcRoot: string;
  /** The guarded module, relative to `srcRoot`. */
  readonly entry: string;
  readonly forbidden: readonly RegExp[];
  /**
   * Source reader and existence test, injected ONLY so the mutation self-test can
   * run a crafted module graph through this exact function. Production callers
   * pass neither and get the real filesystem — a control that does not take the
   * code path under test is how an inert detector reads as coverage.
   */
  readonly readFile?: (absolutePath: string) => string;
  readonly fileExists?: (absolutePath: string) => boolean;
}

/**
 * Source with comments removed.
 *
 * These modules DOCUMENT what they refuse to do in the same words a violation
 * would use, so a walk over raw source goes red on the documentation. The
 * line-comment rule requires the `//` to start a line or follow whitespace, so a
 * `://` inside a URL does not swallow the rest of the line and hide a call after
 * it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** One named value import, after `as` renaming. */
interface ImportedSymbol {
  readonly file: string;
  readonly exported: string;
}

function makeResolver(fileExists: (path: string) => boolean) {
  return (fromFile: string, specifier: string): string | undefined => {
    // Relative specifiers only: a package import leaves this repository, and
    // `@mercaria/shared-types` is a vocabulary rather than a writer.
    if (!specifier.startsWith('.')) return undefined;
    const base = resolve(dirname(fromFile), specifier).replace(/\.js$/, '');
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (fileExists(candidate)) return candidate;
    }
    return undefined;
  };
}

/** Local name → where it is declared, for every named VALUE import in `source`. */
function namedImports(
  source: string,
  file: string,
  resolveSpecifier: (from: string, specifier: string) => string | undefined,
): Map<string, ImportedSymbol> {
  const found = new Map<string, ImportedSymbol>();
  // Both `import {…} from` and `export {…} from`: a re-export is an edge too, and
  // following it is what stops a barrel from being a blind spot.
  const pattern = /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) continue;
    const target = resolveSpecifier(file, match[3]);
    if (target === undefined) continue;
    for (const clause of match[2].split(',')) {
      const trimmed = clause.trim();
      if (trimmed.length === 0 || trimmed.startsWith('type ')) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const exported = parts[0].trim();
      const local = (parts[1] ?? parts[0]).trim();
      found.set(local, { file: target, exported });
    }
  }
  return found;
}

/**
 * The body of an exported declaration, by brace balance.
 *
 * `undefined` when the module does not declare it — which is counted rather than
 * ignored, because "found no body" and "found a clean body" produce the same
 * empty finding list.
 */
function bodyOf(source: string, symbol: string): string | undefined {
  const declaration = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${symbol}\\b`,
  );
  const match = declaration.exec(source);
  if (match === null) return undefined;
  const open = source.indexOf('{', match.index);
  if (open === -1) {
    // An exported constant with no block — a tuple, a string, a number. Its own
    // text is the body.
    const semicolon = source.indexOf(';', match.index);
    return source.slice(match.index, semicolon === -1 ? source.length : semicolon);
  }
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    else if (source[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, cursor + 1);
    }
  }
  return source.slice(open);
}

/** Every forbidden symbol reachable from `entry` through its named imports. */
export function forbiddenSymbolsReachableFrom(
  options: ImportClosureOptions,
): ImportClosureResult {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const fileExists = options.fileExists ?? ((path: string) => existsSync(path));
  const resolveSpecifier = makeResolver(fileExists);

  const entryPath = join(options.srcRoot, options.entry);
  const relative = (absolute: string): string =>
    absolute.startsWith(options.srcRoot) ? absolute.slice(options.srcRoot.length + 1) : absolute;

  const findings: ClosureFinding[] = [];
  const visited = new Set<string>();
  let bodiesScanned = 0;
  let unresolvedBodies = 0;

  const walk = (file: string, symbol: string, firstHop: string, path: string[]): void => {
    const key = `${file}#${symbol}`;
    if (visited.has(key)) return;
    visited.add(key);

    const source = stripComments(readFile(file));
    const body = bodyOf(source, symbol);
    if (body === undefined) {
      unresolvedBodies += 1;
      return;
    }
    bodiesScanned += 1;
    const here = [...path, `${relative(file)}#${symbol}`];
    for (const pattern of options.forbidden) {
      if (pattern.test(body)) {
        findings.push({ firstHop, forbidden: pattern.source, path: here });
      }
    }
    for (const [local, imported] of namedImports(source, file, resolveSpecifier)) {
      // Only what this body actually USES. A module-wide import list would walk
      // symbols this function never calls and report them against it.
      if (!new RegExp(`\\b${local}\\b`).test(body)) continue;
      walk(imported.file, imported.exported, firstHop, here);
    }
  };

  const entrySource = stripComments(readFile(entryPath));
  for (const [local, imported] of namedImports(entrySource, entryPath, resolveSpecifier)) {
    if (!new RegExp(`\\b${local}\\b`).test(entrySource)) continue;
    const firstHop = `${relative(imported.file)}#${imported.exported}`;
    walk(imported.file, imported.exported, firstHop, [options.entry]);
  }

  return { findings, bodiesScanned, unresolvedBodies };
}

/** `firstHop -> forbiddenPattern`, the key a disposition is written against. */
export function dispositionKey(finding: ClosureFinding): string {
  return `${finding.firstHop} -> ${finding.forbidden}`;
}
