const { oxySplashScreenPlugin } = require('@oxyhq/expo-splash/config');

module.exports = {
  expo: {
    owner: 'oxyhq',
    name: 'Mercaria POS',
    slug: 'mercaria-pos',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon-512.png',
    scheme: 'mercariapos',
    userInterfaceStyle: 'automatic',
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'co.mercaria.pos',
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/icon-512-maskable.png',
        monochromeImage: './assets/adaptive-icon-monochrome.png',
        backgroundColor: '#FFFFFF',
      },
      package: 'co.mercaria.pos',
      predictiveBackGestureEnabled: false,
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/icon-192.png',
    },
    plugins: [
      'expo-router',
      'expo-localization',
      'expo-font',
      'expo-image',
      'expo-secure-store',
      'expo-web-browser',
      'expo-asset',
      // Native OS splash (Oxy family "Instagram, from Meta" pattern): Mercaria's
      // own logo (white on transparent) centered on the dark brand background,
      // with the shared Oxy symbol pinned to the bottom. `oxySplashScreenPlugin`
      // builds the `expo-splash-screen` tuple; the bare `@oxyhq/expo-splash`
      // entry (bundled Oxy asset) MUST follow it to add the bottom branding.
      oxySplashScreenPlugin({
        image: './assets/images/splash-logo.png',
        imageWidth: 176,
        backgroundColor: '#0B0B0F',
      }),
      '@oxyhq/expo-splash',
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
    },
  },
};
