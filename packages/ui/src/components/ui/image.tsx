import { Image as ExpoImage } from "expo-image";
import { styled } from "nativewind";

// Expo Image passes className through to a native view, where it is not a
// style. NativeWind's public adapter resolves it before Expo flattens style.
export const Image = styled(ExpoImage, { className: "style" });
export type { ImageProps } from "expo-image";
