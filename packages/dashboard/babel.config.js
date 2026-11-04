// The Oxy Babel config (@oxy.so/app-preset/babel): bare `babel-preset-expo` in
// development, so Expo's oxc transformer runs, and the build-id inliner that
// busts @oxy.so/services' persisted caches in production. `@/` resolves from
// tsconfig.json `paths`; babel-preset-expo adds the worklets plugin and the
// `import.meta` transform itself.
module.exports = require('@oxy.so/app-preset/babel');
