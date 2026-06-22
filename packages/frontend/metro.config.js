const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require('nativewind/metro');

// Monorepo roots: this package lives at packages/frontend, so the workspace
// root is two levels up. Metro must watch the root and resolve from the hoisted
// root node_modules so it can follow the @mercaria/shared-types workspace
// symlink to its source.
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

// Web shim for react-native-track-player (avoids bundling shaka-player)
const trackPlayerWebShim = path.resolve(
  __dirname,
  "lib/shims/react-native-track-player.web.js"
);

module.exports = (() => {
  const config = getDefaultConfig(projectRoot);

  // Watch the whole monorepo so changes in sibling workspace packages
  // (e.g. @mercaria/shared-types) trigger a rebuild.
  config.watchFolders = [monorepoRoot];

  // Resolve modules from both this package and the hoisted root node_modules.
  config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(monorepoRoot, "node_modules"),
  ];

  // Resolve workspace UI/type dependencies to their SOURCE so live edits are
  // picked up without a rebuild. `@mercaria/ui` is source-only (no dist build);
  // shared-types falls through to node_modules/dist otherwise.
  config.resolver.extraNodeModules = {
    "@mercaria/shared-types": path.resolve(monorepoRoot, "packages/shared-types/src"),
    "@mercaria/ui": path.resolve(monorepoRoot, "packages/ui/src"),
  };

  // Enable package exports for zod v4 compatibility
  config.resolver.unstable_enablePackageExports = true;

  // Add web-specific resolver settings to handle ESM modules
  config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

  // SVG support for react-native-svg-transformer (Expo transformer)
  const { transformer, resolver } = config;
  config.transformer = {
    ...transformer,
    babelTransformerPath: require.resolve("react-native-svg-transformer/expo"),
  };
  config.resolver = {
    ...resolver,
    assetExts: [...resolver.assetExts.filter((ext) => ext !== "svg"), "wasm", "woff2", "woff"],
    sourceExts: [...resolver.sourceExts, "svg"],
    // On web, replace react-native-track-player with a no-op shim so the
    // bundler never pulls in shaka-player (TTS uses expo-speech on web).
    resolveRequest: (context, moduleName, platform) => {
      if (platform === "web" && moduleName === "react-native-track-player") {
        return { filePath: trackPlayerWebShim, type: "sourceFile" };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  };

  return withNativeWind(config, {
    input: './global.css',
    inlineRem: 16,
    inlineVariables: false
  });
})();
