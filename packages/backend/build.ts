import * as esbuild from 'esbuild';

await esbuild.build({
  /**
   * FOUR entry points, and none of the last three is optional.
   *
   * `src/db/migrate.ts` is the one-shot the deploy runs before and after the
   * rollout (`.github/workflows/deploy-aws.yml`). It cannot be invoked the way a
   * developer does — `bun run src/…` — because the runtime image ships neither
   * bun nor `src/`, only node and `dist/`. Without this entry there is simply no
   * way to migrate the production database from the image that contains the
   * migrations.
   *
   * `src/scripts/provision-taxonomy.ts` is here for exactly that reason. The
   * marketplace taxonomy has to be installed into a database that only exists
   * inside the VPC, so it is run as a one-shot ECS task against the production
   * image — and an entry point is the only way a script reaches `dist/`. It is
   * NOT a deploy step: it is idempotent and appends nothing on a re-run, so it
   * is safe to run again, but nothing runs it automatically.
   *
   * `src/register-capability-catalog.ts` publishes the exact catalog compiled
   * into this image after the migrations and before the rollout. Registering a
   * source-tree file from a runner would let Oxy advertise code that the task
   * does not actually contain.
   *
   * `src/scripts/seed.ts` is deliberately NOT an entry point and must not
   * become one. It opens by DELETING every listing, store, order, review and
   * category in the database it is pointed at, so putting it in the production
   * image would place a marketplace-destroying one-shot one `command` override
   * away from a running service.
   *
   * `outdir` rather than `outfile` because there are four: esbuild takes the
   * entry points' common ancestor (`src/`) as the base, so these land exactly at
   * `dist/index.js`, `dist/db/migrate.js`, `dist/register-capability-catalog.js`
   * and `dist/scripts/provision-taxonomy.js`. The one-shots call their main function at module
   * load, so the emitted files run on plain `node <path>`.
   *
   * Note they sit at different depths below the package root, which is why
   * `db/migrationsFolder.ts` resolves by finding that root rather than by
   * counting `..` segments — no fixed count is correct for all four.
   *
   * Code splitting is deliberately left OFF (esbuild's default): each entry is
   * self-contained, so the migrator cannot fail at container start on a missing
   * shared chunk — the one failure that would strike exactly when a deploy is
   * mid-flight.
   */
  entryPoints: [
    'src/index.ts',
    'src/db/migrate.ts',
    'src/register-capability-catalog.ts',
    'src/scripts/provision-taxonomy.ts',
  ],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir: 'dist',
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
  //     bloom. Re-measure each newly added backend package independently;
  //     blanket bundling is still unsafe for the CommonJS packages above.
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
