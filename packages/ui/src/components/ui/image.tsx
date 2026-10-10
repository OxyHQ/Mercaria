import { Image as ExpoImage } from "expo-image";
import { styled } from "nativewind";

// Expo Image passes className through to a native view, where it is not a
// style. NativeWind's public adapter resolves it before Expo flattens style.
export const Image = styled(ExpoImage, { className: "style" });
/** The adapter forwards Expo's instance; it does not create a second ref API. */
export type ImageRef = ExpoImage;
export type { ImageProps } from "expo-image";
