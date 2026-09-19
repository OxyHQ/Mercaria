#!/usr/bin/env node
/**
 * Build `@mercaria.co/sdk` into `dist/`.
 *
 * Output — four files, one per module format:
 *
 *   dist/index.js     ESM   (`import`, `react-native`, `default`)
 *   dist/index.cjs    CJS   (`require`) — Mention's backend is CommonJS
 *   dist/index.d.ts   declarations for the ESM entry
 *   dist/index.d.cts  the same declarations for the CJS entry, so TypeScript
 *                     under `node16`/`nodenext` does not see ESM types
 *                     masquerading as CJS
 *
 * ## Why esbuild + rollup-plugin-dts
 *
 * The contract lives in `@mercaria/shared-types`, which is PRIVATE. The
 * published package therefore cannot depend on it or reference it from its
 * declarations, so both halves are BUNDLED:
 *
 *  - esbuild inlines the few runtime values the SDK uses (the closed value
 *    sets). shared-types' barrel re-exports ~140 modules, so each of its
 *    modules is marked side-effect-free below; without that, esbuild keeps
 *    every top-level call in every module and the bundle measured 163 KB
 *    instead of a couple.
 *  - rollup-plugin-dts with `respectExternal` inlines the declarations the
 *    public types reach, so the `.d.ts` is self-contained.
 *
 * tsup does the same two things by wrapping the same two tools, with more
 * dependencies and less control over the side-effects flag; tsc alone cannot
 * bundle declarations at all.
 */

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const entry = join(root, 'src', 'index.ts');

/**
 * Every module of the private contract package is pure data and pure
 * functions, so a module the SDK does not reach contributes nothing. If one
 * ever grows a real side effect the SDK depends on, the smoke test — which
 * exercises the BUILT bundle, closed value sets included — is what fails.
 */
const contractIsSideEffectFree = {
  name: 'contract-is-side-effect-free',
  setup(build) {
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData === 'resolving') return undefined;
      const fromContract = args.path === '@mercaria/shared-types' || args.importer.includes('/shared-types/');
      if (!fromContract) return undefined;
      const resolved = await build.resolve(args.path, {
        importer: args.importer,
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: 'resolving',
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, sideEffects: false };
    });
  },
};

const shared = {
  entryPoints: [entry],
  bundle: true,
  platform: 'neutral',
  target: 'es2020',
  // Not minified: consumers' bundlers minify, and readable output is what a
  // consumer debugging a failed parse steps into.
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [contractIsSideEffectFree],
  tsconfig: join(root, 'tsconfig.json'),
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await esbuild.build({ ...shared, format: 'esm', outfile: join(dist, 'index.js') });
await esbuild.build({ ...shared, format: 'cjs', outfile: join(dist, 'index.cjs') });

const bundle = await rollup({
  input: entry,
  plugins: [dts({ respectExternal: true, tsconfig: join(root, 'tsconfig.json') })],
  onwarn(warning, warn) {
    // A circular re-export inside the contract package is harmless for
    // declarations and would otherwise print on every build.
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    warn(warning);
  },
});
const { output } = await bundle.generate({ format: 'es' });
await bundle.close();
const declarations = output.find((chunk) => chunk.type === 'chunk');
if (!declarations) throw new Error('rollup-plugin-dts produced no declaration chunk');
await writeFile(join(dist, 'index.d.ts'), dropOrphanedDocblocks(declarations.code));
await copyFile(join(dist, 'index.d.ts'), join(dist, 'index.d.cts'));

/**
 * Keep only the comment that DOCUMENTS each top-level declaration.
 *
 * Bundling a module's declarations carries its file-level docblock along,
 * stranded above the first declaration it happened to precede — design notes
 * about Mercaria's internals (database CHECKs, isolation tests, private
 * packages) that describe nothing a consumer can use. Every leading comment of
 * a top-level statement except the last one is exactly that, so it is removed;
 * the last one is the declaration's own JSDoc and stays.
 */
function dropOrphanedDocblocks(code) {
  const source = ts.createSourceFile('index.d.ts', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const removals = [];
  for (const statement of source.statements) {
    const ranges = ts.getLeadingCommentRanges(code, statement.pos) ?? [];
    for (const range of ranges.slice(0, -1)) removals.push(range);
  }
  let result = code;
  for (const { pos, end } of removals.sort((a, b) => b.pos - a.pos)) {
    result = result.slice(0, pos) + result.slice(end).replace(/^\r?\n/, '');
  }
  return result;
}

console.log('built dist/index.js, dist/index.cjs, dist/index.d.ts, dist/index.d.cts');
