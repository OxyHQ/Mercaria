import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  // Keep every node_modules dependency external EXCEPT @mercaria/* — first-party
  // workspace packages (e.g. shared-types) are inlined so the runtime image needs
  // neither their dist nor their build-time devDependencies.
  //
  // @oxyhq/* MUST stay external. The @oxyhq/crowdsource* packages are published as
  // CommonJS ("type": "commonjs"), and inlining CJS into this ESM bundle rewrites
  // each of their internal require() calls into an esbuild shim that throws the
  // moment it runs:
  //   Error: Dynamic require of "zod" is not supported
  // Reproduced here 2026-07-31 by running the bundle: it threw from
  // @oxyhq/crowdsource-contracts/dist/primitives.js, reached through
  // @oxyhq/crowdsource-express — the throwing frame is not the package you imported.
  // The same crash took Moovo's API down at container start. Node's own ESM loader
  // imports those CJS packages correctly, so leave the resolution to Node; the
  // runtime image ships production node_modules (see the Dockerfile), so they
  // resolve there.
  //
  // This replaces an older comment claiming @oxyhq ESM builds have missing .js
  // extensions and must therefore be bundled. That was measured, not assumed, and
  // it is false for what this backend actually resolves (2026-07-31):
  //   @oxyhq/core 13.0.0, dist/esm — 223 relative imports, 212 ending in .js and
  //     the other 11 being ./locales/*.json carrying `with { type: "json" }`.
  //     ZERO extensionless, so Node resolves every one.
  //   @oxyhq/bloom 0.67.0, lib/module — 82 relative imports, ALL 82 extensionless.
  //     So the old reason was true for bloom. This backend does NOT depend on
  //     bloom; @mercaria/backend's only @oxyhq deps are core + the three
  //     crowdsource packages (see package.json).
  // What would invalidate this: adding an @oxyhq dependency whose ESM build emits
  // extensionless relative imports (bloom being the known example). That fails at
  // container start with ERR_MODULE_NOT_FOUND naming the unresolved path — so
  // re-measure the NEW package before changing anything here. The fix is still not
  // to bundle @oxyhq/* wholesale: inlining CJS is what throws the shim above.
  plugins: [{
    name: 'externalize-third-party',
    setup(build) {
      // Externalize every bare import (third-party node_modules) except first-party.
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith('@mercaria/')) return undefined;
        return { path: args.path, external: true };
      });
    },
  }],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

console.log('✅ Build complete');
