const path = require('node:path');
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

// The Oxy Metro config (@oxy.so/app-preset/metro) owns the monorepo watch
// folder and block list (worktrees, backend, docs, caches, tests), symlink and
// package-exports resolution, the font/wasm asset extensions, the release
// minifier, NativeWind (`./global.css`, 1rem = 16px), Bloom's single instance
// and the complete `react-native` behind NativeWind's shim, without which
// `expo-asset` reads React Native 0.88's `AssetRegistry` as undefined and an
// Android release stays blank.
//
// `@mercaria/ui` and `@mercaria/shared-types` are bundled from SOURCE through
// tsconfig.json `paths`, which Metro reads; `sharedTypesPackage` is not passed
// because it would send Metro to the built `dist/` instead.
const monorepoRoot = path.resolve(__dirname, '../..');

module.exports = createOxyMetroConfig(__dirname, {
  // Playwright replaces its reports while it runs; crawling them races
  // Metro's file watcher (ENOENT).
  extraBlockList: [
    path.join(monorepoRoot, 'test-results'),
    path.join(monorepoRoot, 'playwright-report'),
  ],
});
