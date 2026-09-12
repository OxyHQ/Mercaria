#!/usr/bin/env node
/**
 * Release smoke test for `@mercaria.co/sdk`: pack it the way it is published,
 * install the TARBALL into a scratch consumer, and use it from every runtime
 * the package claims.
 *
 * Run after `build`. Nothing here reads `src/`: every check is against the
 * packed artefact, because that is the only thing a consumer ever receives.
 *
 *   node scripts/smoke.mjs              # pack into a temp dir, test, clean up
 *   node scripts/smoke.mjs --out <dir>  # also keep the tested tarball in <dir>
 *
 * `--out` is how `.github/workflows/publish-sdk.yml` publishes EXACTLY the
 * tarball this script tested, rather than re-packing afterwards.
 *
 * ## Why the tarball is packed from a staging directory
 *
 * The package's own manifest lists its build tooling and the private contract
 * package (`workspace:*`) as devDependencies. A consumer never installs those,
 * but the published manifest would still name a private workspace package and
 * a protocol no registry understands. So the tarball is packed from a staging
 * directory holding `dist/`, the docs and a manifest reduced to the fields a
 * consumer's package manager and the registry read. The result is asserted
 * below: no dependencies of any kind, no scripts, no `workspace:`, and no
 * mention of the private scope in any shipped file.
 *
 * ## What is checked
 *
 *  1. The tarball holds exactly dist + README + CHANGELOG + LICENSE + manifest.
 *  2. No shipped file mentions the private package scope or `workspace:`, and
 *     no JavaScript file imports a Node built-in.
 *  3. Node ESM `import` and CJS `require` of the INSTALLED package: create a
 *     client, parse a product through a fetch double (which exercises the
 *     bundled closed value sets), build a link, map a 410 to `MercariaGoneError`,
 *     and recognise an error from the CJS copy as `instanceof` the ESM class.
 *  4. The same ESM program under Bun.
 *  5. A browser bundle (esbuild, `platform: 'browser'`) and a React Native
 *     bundle (`conditions: ['react-native']`, RN main fields,
 *     `platform: 'neutral'`) both build, resolve the ESM entry, and pull in no
 *     Node built-in.
 *  6. The declarations type-check in a consumer compiled with `nodenext` in
 *     BOTH module kinds, `lib: ["ES2020"]` (no DOM), `types: []` and
 *     `skipLibCheck: false` — so they are self-contained and ask nothing of
 *     the consumer's environment.
 */

import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const keepDir = outIndex === -1 ? null : resolve(process.argv[outIndex + 1] ?? '');
if (outIndex !== -1 && !process.argv[outIndex + 1]) fail('--out needs a directory');

const PRIVATE_SCOPE = '@mercaria/';
const EXPECTED_FILES = [
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/README.md',
  'package/dist/index.cjs',
  'package/dist/index.d.cts',
  'package/dist/index.d.ts',
  'package/dist/index.js',
  'package/package.json',
];

/** The manifest fields a consumer's package manager and the registry read. */
const PUBLISHED_FIELDS = [
  'name', 'version', 'description', 'license', 'author', 'homepage', 'repository', 'bugs', 'keywords',
  'type', 'sideEffects', 'main', 'module', 'types', 'react-native', 'exports', 'files', 'engines',
  'publishConfig',
];

function fail(message) {
  console.error(`sdk smoke FAILED: ${message}`);
  process.exit(1);
}

function run(command, args, cwd, what) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  if (result.error) fail(`${what}: could not run ${command} (${result.error.message})`);
  if (result.status !== 0) {
    fail(`${what}: ${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'mercaria-sdk-smoke-'));
  const checks = [];
  const pass = (name) => {
    checks.push(name);
    console.log(`  ok  ${name}`);
  };

  try {
    // ── Stage and pack ────────────────────────────────────────────────────────
    for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
      await stat(join(root, 'dist', file)).catch(() => fail(`dist/${file} is missing — run the build first`));
    }
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const stage = join(scratch, 'stage');
    await mkdir(stage, { recursive: true });
    await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
    for (const doc of ['README.md', 'CHANGELOG.md', 'LICENSE']) await cp(join(root, doc), join(stage, doc));
    const published = Object.fromEntries(PUBLISHED_FIELDS.filter((key) => key in manifest).map((key) => [key, manifest[key]]));
    await writeFile(join(stage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);

    const packDir = join(scratch, 'pack');
    await mkdir(packDir);
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDir], stage, 'pack'));
    const tarball = join(packDir, packed[0].filename);
    const tarballBytes = (await stat(tarball)).size;

    // ── 1. File list ──────────────────────────────────────────────────────────
    const listed = run('tar', ['-tzf', tarball], scratch, 'list tarball').split('\n').filter(Boolean).sort();
    if (JSON.stringify(listed) !== JSON.stringify(EXPECTED_FILES)) {
      fail(`tarball files are\n  ${listed.join('\n  ')}\nexpected\n  ${EXPECTED_FILES.join('\n  ')}`);
    }
    pass(`tarball holds exactly ${EXPECTED_FILES.length} files (dist, docs, manifest)`);

    // ── 2. Content of every shipped file ─────────────────────────────────────
    const extract = join(scratch, 'extract');
    await mkdir(extract);
    run('tar', ['-xzf', tarball, '-C', extract], scratch, 'extract tarball');
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
    for (const file of await listFiles(extract)) {
      const text = await readFile(file, 'utf8');
      const name = relative(extract, file);
      if (text.includes(PRIVATE_SCOPE)) fail(`${name} mentions the private scope ${PRIVATE_SCOPE}`);
      if (text.includes('workspace:')) fail(`${name} contains a workspace: protocol`);
      if (/\.(?:c?js|d\.c?ts)$/.test(name)) {
        for (const [, specifier] of text.matchAll(importSpecifier)) {
          if (builtins.has(specifier)) fail(`${name} imports the Node built-in ${specifier}`);
          if (!specifier.startsWith('.')) fail(`${name} imports the package ${specifier}; the SDK has no dependencies`);
        }
      }
    }
    const shippedManifest = JSON.parse(await readFile(join(extract, 'package', 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies', 'bundleDependencies', 'bundledDependencies', 'scripts']) {
      if (field in shippedManifest) fail(`the published manifest carries ${field}`);
    }
    if (shippedManifest.name !== '@mercaria.co/sdk') fail(`published name is ${shippedManifest.name}`);
    pass('no private scope, no workspace protocol, no dependencies, no scripts, no Node built-in imports');

    // ── 3. Node ESM + CJS from the installed tarball ─────────────────────────
    const consumer = join(scratch, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{ "name": "sdk-smoke-consumer", "private": true }\n');
    run('npm', ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock', '--offline'], consumer, 'install tarball');

    await writeFile(join(consumer, 'program.mjs'), CONSUMER_ESM);
    await writeFile(join(consumer, 'program.cjs'), CONSUMER_CJS);
    run(process.execPath, ['program.mjs'], consumer, 'node ESM import');
    pass('node ESM import: client, product parse, link, 410 → MercariaGoneError, cross-copy instanceof');
    run(process.execPath, ['program.cjs'], consumer, 'node CJS require');
    pass('node CJS require: client, product parse, link');

    // ── 4. Bun ────────────────────────────────────────────────────────────────
    run('bun', ['program.mjs'], consumer, 'bun import');
    pass('bun import');

    // ── 5. Browser and React Native bundles ──────────────────────────────────
    await writeFile(join(consumer, 'bundle-entry.js'), BUNDLE_ENTRY);
    const bundles = {
      browser: { platform: 'browser' },
      'react-native': {
        platform: 'neutral',
        conditions: ['react-native'],
        mainFields: ['react-native', 'module', 'main'],
      },
    };
    for (const [target, options] of Object.entries(bundles)) {
      let result;
      try {
        result = await esbuild.build({
          entryPoints: [join(consumer, 'bundle-entry.js')],
          absWorkingDir: consumer,
          bundle: true,
          write: false,
          metafile: true,
          format: 'esm',
          logLevel: 'silent',
          ...options,
        });
      } catch (error) {
        fail(`${target} bundle did not build: ${error.message}`);
      }
      const inputs = Object.keys(result.metafile.inputs);
      const offending = inputs.filter((input) => builtins.has(input) || input.startsWith('node:'));
      if (offending.length > 0) fail(`${target} bundle pulled in Node built-ins: ${offending.join(', ')}`);
      if (!inputs.some((input) => input.endsWith('@mercaria.co/sdk/dist/index.js'))) {
        fail(`${target} bundle did not resolve the ESM entry (inputs: ${inputs.join(', ')})`);
      }
      pass(`${target} bundle builds from dist/index.js with no Node built-ins`);
    }

    // ── 6. Declarations in a no-DOM nodenext consumer, both module kinds ─────
    await writeFile(join(consumer, 'types-esm.mts'), CONSUMER_TYPES);
    await writeFile(join(consumer, 'types-cjs.cts'), CONSUMER_TYPES);
    await writeFile(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'ES2020',
          lib: ['ES2020'],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['types-esm.mts', 'types-cjs.cts'],
      }),
    );
    const tsc = join(dirname(fileURLToPath(import.meta.resolve('typescript'))), '..', 'bin', 'tsc');
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], consumer, 'consumer type-check');
    pass('declarations type-check under nodenext (ESM and CJS), lib ES2020 without DOM, skipLibCheck off');

    if (keepDir) {
      await mkdir(keepDir, { recursive: true });
      await cp(tarball, join(keepDir, packed[0].filename));
    }

    const unpackedBytes = packed[0].unpackedSize;
    console.log(
      `sdk smoke passed — ${checks.length} checks; ${packed[0].filename}: ${(tarballBytes / 1024).toFixed(1)} KB packed, ` +
        `${(unpackedBytes / 1024).toFixed(1)} KB unpacked${keepDir ? `; kept in ${keepDir}` : ''}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ── Consumer programs ───────────────────────────────────────────────────────

const SHARED_PROGRAM = String.raw`
const product = {
  ref: { kind: 'product', id: 'prod 1' },
  title: 'Smoke',
  primaryImage: null,
  price: { amount: 100000000, currency: 'FAIR' },
  compareAtPrice: null,
  priceRange: null,
  availability: 'sold',
  condition: { key: 'refurbished_seller', group: 'refurbished' },
  seller: { kind: 'person', oxyUserId: 'oxy_1', displayName: 'A', username: 'a', avatarUrl: null, isVerified: false },
  url: 'https://mercaria.co/products/prod%201',
  sku: 'LEAKED',
  description: '',
  images: [],
  purchaseOptions: [{ ref: { kind: 'variant', productId: 'prod 1', variantId: 'v1' }, title: 'One', price: { amount: 1, currency: 'JPY' }, compareAtPrice: null, availability: 'out_of_stock' }],
  updatedAt: '2026-09-13T00:00:00Z',
  viewer: null,
};
const respond = (status, body) => async () => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
function check(condition, message) { if (!condition) { throw new Error('smoke assertion failed: ' + message); } }
async function exercise(sdk) {
  const client = sdk.createMercariaClient({ fetch: respond(200, { success: true, data: product }) });
  const parsed = await client.products.get(sdk.productRef('prod 1'));
  check(parsed.availability === 'sold' && parsed.condition.group === 'refurbished', 'product parsed');
  check(!('sku' in parsed), 'leaked key stripped');
  check(client.links.product(parsed) === parsed.url, 'link equals the DTO url');
  check(sdk.formatMercariaRef(parsed.ref) === 'mercaria:product:prod%201', 'ref string form');
  const gone = sdk.createMercariaClient({ fetch: respond(410, { success: false, error: 'GONE', message: 'x' }) });
  let error;
  try { await gone.products.get('prod 1'); } catch (caught) { error = caught; }
  check(error instanceof sdk.MercariaGoneError && error.code === 'GONE' && error.status === 410, '410 maps to MercariaGoneError');
  return error;
}
`;

const CONSUMER_ESM = `${SHARED_PROGRAM}
import * as esm from '@mercaria.co/sdk';
import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('@mercaria.co/sdk');
await exercise(esm);
const fromCjs = await exercise(cjs);
check(esm.MercariaGoneError !== cjs.MercariaGoneError, 'the ESM and CJS builds are two copies');
check(fromCjs instanceof esm.MercariaGoneError, 'a CJS-thrown error is instanceof the ESM class');
check(fromCjs instanceof esm.MercariaError && esm.isMercariaError(fromCjs), 'and of the ESM base class');
check(!(fromCjs instanceof esm.MercariaNotFoundError), 'but not of an unrelated class');
`;

const CONSUMER_CJS = `${SHARED_PROGRAM}
const sdk = require('@mercaria.co/sdk');
exercise(sdk).catch((error) => { console.error(error); process.exit(1); });
`;

const BUNDLE_ENTRY = `
import { createMercariaClient, productRef } from '@mercaria.co/sdk';
export const url = createMercariaClient().links.product(productRef('p'));
`;

const CONSUMER_TYPES = `
import {
  createMercariaClient,
  MercariaGoneError,
  productRef,
  type MercariaClient,
  type MercariaProduct,
  type MercariaProductRef,
  type MercariaPage,
  type MercariaProductSummary,
  type Money,
} from '@mercaria.co/sdk';

const client: MercariaClient = createMercariaClient({ getAccessToken: async () => null, locale: 'es' });
const ref: MercariaProductRef = productRef('p');
export async function hydrate(): Promise<string> {
  try {
    const product: MercariaProduct = await client.products.resolveRef(ref);
    const price: Money = product.price;
    const page: MercariaPage<MercariaProductSummary> = await client.products.search({ query: 'x', limit: 5 });
    return client.links.product(product) + price.currency + page.items.length;
  } catch (error) {
    if (error instanceof MercariaGoneError) return error.code;
    throw error;
  }
}
`;

await main();
