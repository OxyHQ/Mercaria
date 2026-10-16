// Expo forwards className to its web container. Adapting it into style would
// merge RN Web's compiled CSS marker with plain styles when Expo flattens them.
// Only the native implementation needs NativeWind's className-to-style adapter.
export { Image } from 'expo-image';
export type { ImageProps, Image as ImageRef } from 'expo-image';
