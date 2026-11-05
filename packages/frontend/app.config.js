// App variant — lets a development build sit next to the production app on the
// SAME device by giving it a distinct applicationId/bundleId + name. Build the
// dev variant with `APP_VARIANT=development` (e.g.
// `APP_VARIANT=development npx expo run:android`); production is the default.
const IS_DEV_VARIANT = process.env.APP_VARIANT === 'development';
const APP_ID = IS_DEV_VARIANT ? 'co.mercaria.app.dev' : 'co.mercaria.app';
const APP_NAME = IS_DEV_VARIANT ? 'Mercaria (Dev)' : 'Mercaria';

module.exports = {
  expo: {
    owner: 'oxyhq',
    name: APP_NAME,
    slug: 'mercaria',
    // The OTA compatibility boundary (withOxyUpdates, runtime policy
    // `appVersion`) and the source of the derived store build number
    // (@oxy.so/app-preset: 1.2.3 → 1002003). Bump it for any native change: the
    // next push to main releases a new Android binary (`android-release.yml`).
    version: '1.1.0',
    orientation: 'portrait',
    icon: './assets/icon-512.png',
    scheme: 'mercaria',
    userInterfaceStyle: 'automatic',
    ios: {
      supportsTablet: true,
      bundleIdentifier: APP_ID,
      infoPlist: {
        UIBackgroundModes: ['remote-notification'],
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/icon-512-maskable.png',
        backgroundImage: './assets/adaptive-icon-background.png',
        monochromeImage: './assets/adaptive-icon-monochrome.png',
        backgroundColor: '#FFFFFF',
      },
      package: APP_ID,
      predictiveBackGestureEnabled: false,
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/icon-192.png',
    },
    plugins: [
      ['expo-router', { asyncRoutes: { web: false } }],
      'expo-localization',
      'expo-font',
      'expo-image',
      'expo-secure-store',
      'expo-web-browser',
      'expo-asset',
      'expo-notifications',
      [
        'expo-audio',
        {
          microphonePermission:
            'Allow $(PRODUCT_NAME) to access your microphone, to dictate messages and to talk with Alia while you shop',
          recordAudioAndroid: true,
          enableBackgroundPlayback: false,
        },
      ],
      [
        'react-native-audio-api',
        {
          iosMicrophonePermission:
            'Allow $(PRODUCT_NAME) to access your microphone, to dictate messages and to talk with Alia while you shop',
          iosBackgroundMode: false,
          androidForegroundService: false,
          androidPermissions: ['android.permission.RECORD_AUDIO'],
        },
      ],
      ['@oxy.so/app-preset', { android: { gifEnabled: false, webpEnabled: false } }],
      [
        '@oxy.so/app-preset/plugin/withOxyUpdates',
        { clientId: 'oxy_dk_8993efc30f18b2cfd361374634df4099a63a247df675132c' },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
    },
  },
};
