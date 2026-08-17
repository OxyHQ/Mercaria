/**
 * Resolve a symbol imported from a PACKAGE barrel to the module that owns it (#582).
 *
 * #556 established that a path-based isolation wall requires a directory SEGMENT
 * before the module it forbids, so it matches `from '../schema/referrals.js'` and
 * matches NOTHING in `from '../schema/index.js'`. #581 closed that at the
 * chokepoint: no module may relatively import a guarded barrel.
 *
 * **A package entry point cannot be treated that way.** `@mercaria/shared-types`
 * is imported BY NAME, and importing it is how a package is consumed — there is
 * no allow-list, no conversion, and no "import from the owner" alternative that
 * is not a deep import into another package's internals. So `@mercaria/shared-types`
 * (114 re-exports, 1,464 non-test importers) and `@mercaria/ui` (95, 166) are
 * outside `barrel-import-chokepoint.test.ts` by construction and will always be.
 *
 * The predicate that works for them is the one #556 identified and set aside:
 * **symbol-level**. Resolve each named import through the barrel to its owning
 * module, then let an existing wall apply to that owner.
 *
 *     import { referralAttributionEvents } from '@mercaria/shared-types';
 *       -> owner packages/shared-types/src/referral-attribution.ts  -> a referral wall may refuse
 *     import { retailCostComponents }      from '@mercaria/shared-types';
 *       -> owner packages/shared-types/src/retail-pricing.ts        -> that same wall allows
 *
 * Nothing here is a hand list. The packages are DERIVED by walking `packages/*`
 * for a `src/index.ts` with re-export density, so `packages/backend/src/index.ts`
 * (a server entrypoint, zero re-exports) drops out on its shape and a package
 * barrel added tomorrow brings itself under every wall built on this with no edit
 * here. The symbol map is a scan of what each re-exported module actually
 * declares.
 *
 * ## What this deliberately does NOT do
 *
 * It answers "which modules does this source reach", never "is that allowed".
 * The wall keeps that decision, because the difference between a domain
 * population and a deliberately narrow subset is a claim in a docblock and not a
 * shape in the code (`docs/isolation-gates.md`).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `packages/` — this file is `packages/backend/src/__tests__/`. */
export const PACKAGES_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The repository root, so an owner path reads the way a person would write it. */
export const REPO_ROOT = dirname(PACKAGES_ROOT);

/**
 * Strip comments, leaving strings intact.
 *
 * Load-bearing in BOTH directions here. A docblock in this repository routinely
 * contains a literal `import { x } from '@mercaria/shared-types'` as an example —
 * every gate that documents what it forbids does — so a scan that kept comments
 * would resolve the example and report a module the file never reaches. And a
 * stripper that ate too much would make every wall below it pass vacuously, so
 * `//` inside a URL must survive.
 */
export function stripComments(source: string): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (char === '/' && next === '/') {
        mode = 'line';
        i += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        mode = 'block';
        i += 1;
        continue;
      }
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '`') mode = 'template';
      out += char;
      continue;
    }
    if (mode === 'line') {
      if (char === '\n') {
        mode = 'code';
        out += char;
      }
      continue;
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') {
        mode = 'code';
        i += 1;
      } else if (char === '\n') {
        // Newlines are kept so line-anchored patterns still see real boundaries.
        out += char;
      }
      continue;
    }
    // Inside a string: copy through, honouring escapes, and close on the quote.
    out += char;
    if (char === '\\') {
      out += source[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (
      (mode === 'single' && char === "'") ||
      (mode === 'double' && char === '"') ||
      (mode === 'template' && char === '`')
    ) {
      mode = 'code';
    }
  }
  return out;
}

/**
 * An `import`/`export` clause with its specifier, in ONE match.
 *
 * The negated classes must admit NEWLINES, and that is why this is spelled out
 * rather than reused: the instrument built for #556 used `[^;\n]*?`, which cannot
 * cross a line, so every multi-line `import {\n  a,\n  b,\n} from '...'` was
 * invisible to it and it reported four barrel importers where there were seven.
 * **A smaller number is indistinguishable from a cleaner tree**, which is why
 * `package-barrel-symbols.test.ts` carries a positive control on exactly this
 * shape. Quotes and semicolons bound it instead, which keeps it linear.
 *
 * `export` is matched as well as `import`, because a RE-EXPORT reaches the
 * module exactly as an import does — `packages/ui/src/lib/format.ts` writes
 * `export type { ProductSummary } from '@mercaria/shared-types'` today. Matching
 * only `import` would report that file as reaching nothing, which is the quiet
 * direction and precisely this issue's failure one level down. On this side of a
 * re-export the requested name is the one to the LEFT of `as`, the same as an
 * import, so both go through {@link importedNames}.
 *
 * Group 1 is the clause (`{ a, b }`, `* as NS`, `Default`), group 2 the specifier.
 */
const IMPORT_CLAUSE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;

/** A re-export: `export * from`, `export * as NS from`, `export { … } from`. */
const RE_EXPORT =
  /(?:^|\n)\s*export\s+(?:type\s+)?(\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;

/**
 * A top-level declaration, ANCHORED at column zero.
 *
 * Anchoring is the honest spelling of "top level": an `export` nested in a
 * `declare module` or a namespace is indented, and counting it would attribute a
 * symbol to a module that does not export it by that name.
 */
const TOP_LEVEL_DECLARATION =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|type|interface|enum|function|class)\s+([A-Za-z_$][\w$]*)/gm;

/** A top-level `export { A, type B, C as D }` with no `from` — a local re-export list. */
const LOCAL_EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}\s*(?![^;]*\bfrom\b)/gm;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function matchAll(pattern: RegExp, source: string): RegExpMatchArray[] {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags))];
}

/**
 * The entries of a `{ … }` clause, `type` prefixes removed.
 *
 * A type-only entry is kept: `import type { X }` reaches X's owning module
 * exactly as a value import does, and a wall that ignored types would be
 * defeated by the commonest import in this repository.
 */
function clauseEntries(clause: string): string[] {
  return clause
    .split(',')
    .map((entry) => entry.trim().replace(/^type\s+/, ''))
    .filter(Boolean);
}

/**
 * The names an EXPORT clause publishes — `export { A as B }` publishes `B`.
 */
function exportedNames(clause: string): string[] {
  return clauseEntries(clause)
    .map((entry) => {
      const renamed = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(entry);
      return renamed ? renamed[1] : entry;
    })
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/**
 * The names an IMPORT clause REQUESTS — `import { A as B }` requests `A`.
 *
 * The two directions of `as` are opposite and both are live in this tree, which
 * is a distinction worth stating rather than sharing one helper for. Validating
 * the map against every real import site is what surfaced it: 22 symbols
 * resolved to nothing, every one of them an import rename
 * (`Listing as ListingDTO`, `ORDER_SELLER_TYPES as SHARED_ORDER_SELLER_TYPES`).
 * Taking the local alias asks the barrel for a name it never exported, and an
 * unknown symbol is exactly what a wall reads as "reaches nothing".
 */
function importedNames(clause: string): string[] {
  return clauseEntries(clause)
    .map((entry) => entry.replace(/\s+as\s+[A-Za-z_$][\w$]*$/, '').trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/** Resolve a relative specifier to the source file it names. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromFile), specifier);
  const stem = base.replace(/\.js$/, '');
  const candidates = [`${stem}.ts`, `${stem}.tsx`, join(stem, 'index.ts'), join(stem, 'index.tsx')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The package barrels, derived                                                */
/* -------------------------------------------------------------------------- */

export interface PackageBarrel {
  /** The specifier a consumer writes, e.g. `@mercaria/shared-types`. */
  packageName: string;
  /** Absolute path of the barrel source. */
  path: string;
  /** Symbol -> absolute path of the module that declares it. */
  owners: Map<string, string>;
  /**
   * Names the barrel re-exports that no scanned module declares. Kept rather
   * than dropped: an unresolved name is a hole in the map, and a hole is
   * indistinguishable from a symbol nothing imports unless it is counted.
   */
  unresolved: string[];
}

/** Every re-export density ≥ 2 makes a file a barrel — #556's rule, unchanged. */
const BARREL_RE_EXPORT_FLOOR = 2;

function packageDirectories(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_ROOT, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')));
}

/**
 * Every name a module exports at its top level, following nested re-exports.
 *
 * `seen` bounds the recursion; a cycle between two modules would otherwise not
 * terminate, and a barrel is exactly the shape where one is plausible.
 */
function declaredNames(file: string, seen: Set<string>, into: Map<string, string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  const source = stripComments(read(file));

  for (const match of matchAll(TOP_LEVEL_DECLARATION, source)) {
    if (!into.has(match[1])) into.set(match[1], file);
  }
  for (const match of matchAll(LOCAL_EXPORT_LIST, source)) {
    for (const name of exportedNames(match[1])) if (!into.has(name)) into.set(name, file);
  }
  for (const match of matchAll(RE_EXPORT, source)) {
    const target = resolveRelative(file, match[2]);
    if (!target) continue;
    const clause = match[1];
    const namespaced = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (namespaced) {
      if (!into.has(namespaced[1])) into.set(namespaced[1], target);
    } else if (clause.startsWith('*')) {
      declaredNames(target, seen, into);
    } else {
      for (const name of exportedNames(clause.slice(1, -1))) if (!into.has(name)) into.set(name, target);
    }
  }
}

function buildBarrel(packageName: string, barrelPath: string): PackageBarrel {
  const source = stripComments(read(barrelPath));
  const owners = new Map<string, string>();
  const unresolved: string[] = [];

  for (const match of matchAll(RE_EXPORT, source)) {
    const target = resolveRelative(barrelPath, match[2]);
    const clause = match[1];
    if (!target) {
      unresolved.push(match[2]);
      continue;
    }
    const namespaced = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (namespaced) {
      owners.set(namespaced[1], target);
      continue;
    }
    if (clause.startsWith('*')) {
      // `export * from './x'` — the barrel names nothing, so the owner map has
      // to come from what `x` itself declares. This is the whole reason a
      // symbol-keyed search "cannot see through" a barrel.
      const names = new Map<string, string>();
      declaredNames(target, new Set(), names);
      if (names.size === 0) unresolved.push(match[2]);
      for (const [name, owner] of names) if (!owners.has(name)) owners.set(name, owner);
      continue;
    }
    // `export { A, type B, C as D } from './x'` — the barrel states the map.
    for (const name of exportedNames(clause.slice(1, -1))) if (!owners.has(name)) owners.set(name, target);
  }

  return { packageName, path: barrelPath, owners, unresolved };
}

/**
 * The package barrels of this workspace, derived from shape.
 *
 * A package qualifies when it has a `src/index.ts` carrying at least
 * {@link BARREL_RE_EXPORT_FLOOR} re-exports. `@mercaria/backend`'s `src/index.ts`
 * is a server entrypoint and carries none, so it drops out on its own shape
 * rather than on a name somebody remembered to exclude.
 */
export const PACKAGE_BARRELS: PackageBarrel[] = packageDirectories()
  .flatMap((dir) => {
    const barrelPath = join(dir, 'src', 'index.ts');
    if (!existsSync(barrelPath)) return [];
    const source = stripComments(read(barrelPath));
    if (matchAll(RE_EXPORT, source).length < BARREL_RE_EXPORT_FLOOR) return [];
    const packageName = JSON.parse(read(join(dir, 'package.json'))).name as string;
    return [buildBarrel(packageName, barrelPath)];
  })
  .sort((a, b) => a.packageName.localeCompare(b.packageName));

const BY_NAME = new Map(PACKAGE_BARRELS.map((barrel) => [barrel.packageName, barrel]));

/* -------------------------------------------------------------------------- */
/* The question a wall asks                                                    */
/* -------------------------------------------------------------------------- */

/** A repo-relative path, so an owner reads the way a person would write it. */
export function repoRelative(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath);
}

/**
 * The owning module of one symbol, or `null` when the package does not export it.
 *
 * `null` is deliberately not "allowed": it means UNKNOWN, and a wall that treats
 * an unknown as a pass is one that a renamed symbol turns green.
 * {@link packageBarrelImportsOf} reports unknowns separately for that reason.
 */
export function resolveBarrelSymbol(packageName: string, symbol: string): string | null {
  const owner = BY_NAME.get(packageName)?.owners.get(symbol);
  return owner ? repoRelative(owner) : null;
}

export interface BarrelImport {
  /** The package specifier as written. */
  packageName: string;
  /** Every symbol the clause binds. */
  symbols: string[];
  /** Repo-relative owning modules, deduplicated. */
  modules: string[];
  /** Symbols this barrel does not export — a namespace import, or a stale name. */
  unresolved: string[];
  /** True for `import * as X` / a default import, where no symbol is named. */
  wholeNamespace: boolean;
}

/**
 * Every import of a derived package barrel in one source, resolved to owners.
 *
 * Takes SOURCE rather than a path so a wall can run it over the text it has
 * already read and stripped, and so the mutation self-tests can hand it a
 * planted line without writing a file.
 */
export function packageBarrelImportsOf(source: string): BarrelImport[] {
  const stripped = stripComments(source);
  const out: BarrelImport[] = [];
  for (const match of matchAll(IMPORT_CLAUSE, stripped)) {
    const barrel = BY_NAME.get(match[2]);
    if (!barrel) continue;
    const clause = match[1];
    const braced = /\{([^}]*)\}/.exec(clause);
    // `import * as Types from '@mercaria/shared-types'` names no symbol, so it
    // reaches EVERY module the barrel carries. Reported rather than resolved:
    // a wall that silently treated it as reaching nothing would be defeated by
    // one import somebody wrote for convenience.
    const wholeNamespace = !braced || /(?:^|,)\s*\*\s+as\s/.test(clause);
    const symbols = braced ? importedNames(braced[1]) : [];
    const modules: string[] = [];
    const unresolved: string[] = [];
    for (const symbol of symbols) {
      const owner = barrel.owners.get(symbol);
      if (!owner) unresolved.push(symbol);
      else if (!modules.includes(repoRelative(owner))) modules.push(repoRelative(owner));
    }
    out.push({ packageName: barrel.packageName, symbols, modules, unresolved, wholeNamespace });
  }
  return out;
}

/**
 * The package modules one source reaches — the answer a wall wants.
 *
 * A whole-namespace import contributes EVERY module of that barrel, because that
 * is what it reaches.
 */
export function packageModulesReachedBy(source: string): string[] {
  const reached = new Set<string>();
  for (const entry of packageBarrelImportsOf(source)) {
    if (entry.wholeNamespace) {
      const barrel = BY_NAME.get(entry.packageName);
      for (const owner of barrel?.owners.values() ?? []) reached.add(repoRelative(owner));
    }
    for (const module of entry.modules) reached.add(module);
  }
  return [...reached].sort();
}

/**
 * Does this source reach a package module whose path matches `pattern`?
 *
 * The wall supplies the pattern, so this never decides what is forbidden — it
 * only makes the answer survive the import passing through a package barrel.
 */
export function reachesPackageModule(source: string, pattern: RegExp): boolean {
  return packageModulesReachedBy(source).some((module) =>
    new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(module),
  );
}
