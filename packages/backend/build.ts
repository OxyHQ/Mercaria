import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  // Keep node_modules external EXCEPT:
  //   - @oxyhq/*       — their ESM builds have missing .js extensions, so bundle them
  //   - @mercaria/* — first-party workspace packages (e.g. shared-types); inline
  //                      them so the runtime image has no dependency on their dist or
  //                      build-time devDependencies.
  plugins: [{
    name: 'externalize-third-party',
    setup(build) {
      const inline = (path: string) =>
        path.startsWith('@oxyhq/') || path.startsWith('@mercaria/');
      // Let first-party / @oxyhq packages be bundled.
      build.onResolve({ filter: /^(@oxyhq|@mercaria)\// }, () => undefined);
      // Externalize all other bare imports (third-party node_modules).
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (inline(args.path)) return undefined;
        return { path: args.path, external: true };
      });
    },
  }],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

console.log('✅ Build complete');
