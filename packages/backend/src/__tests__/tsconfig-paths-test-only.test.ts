/**
 * A `tsconfig.json` `paths` alias is for TEST files only (#1017).
 *
 * `paths` maps `@mercaria.co/sdk` to the SDK's SOURCE so the contract suite can
 * drive the real backend through it. `tsc` accepts that import from ANY file in
 * the program, and `build.ts`'s esbuild bundles whatever a production entry
 * reaches — so a production module importing the SDK would type-check, build
 * and ship a second copy of the public contract inside the API image with every
 * gate green. Nothing else stops it, so this does.
 *
 * The population is derived, never listed: the forbidden specifiers are READ out
 * of `tsconfig.json`'s `paths` (the same read `vitest.config.ts` performs), and
 * the production files are every `.ts` under `src/` outside `__tests__/` and not
 * named `*.test.ts`. A path alias added tomorrow is guarded with no edit here.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_ROOT = join(PACKAGE_ROOT, 'src');

/** The exact specifiers `tsconfig.json` `paths` aliases. */
function aliasedSpecifiers(): string[] {
  const { config, error } = ts.readConfigFile(join(PACKAGE_ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return Object.keys((config.compilerOptions?.paths ?? {}) as Record<string, string[]>);
}

/** Every `.ts` file under a directory, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function isTestFile(path: string): boolean {
  return path.split(/[\\/]/).includes('__tests__') || path.endsWith('.test.ts');
}

/** Every module specifier a source imports, re-exports or dynamically imports. */
function specifiers(source: string): string[] {
  const file = ts.preProcessFile(source, true, true);
  return file.importedFiles.map((ref) => ref.fileName);
}

describe('tsconfig paths aliases stay out of production modules', () => {
  const aliases = aliasedSpecifiers();
  const files = walk(SRC_ROOT);
  const production = files.filter((path) => !isTestFile(path));
  const tests = files.filter(isTestFile);

  it('reads a non-empty alias set and a real population', () => {
    expect(aliases).toContain('@mercaria.co/sdk');
    // Floors, so a walker that found nothing cannot pass the census below.
    expect(production.length).toBeGreaterThan(500);
    expect(tests.length).toBeGreaterThan(300);
  });

  it('is armed: the detector finds the alias in the contract suite that uses it', () => {
    const importers = tests.filter((path) =>
      specifiers(readFileSync(path, 'utf8')).some((specifier) => aliases.includes(specifier)),
    );
    expect(importers.map((path) => relative(SRC_ROOT, path))).toContain(
      join('routes', '__tests__', 'public-api-sdk-contract.realdb.test.ts'),
    );
  });

  it('no production module imports an aliased specifier', () => {
    const offenders = production.flatMap((path) =>
      specifiers(readFileSync(path, 'utf8'))
        .filter((specifier) => aliases.includes(specifier))
        .map((specifier) => `${relative(SRC_ROOT, path)} imports ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
