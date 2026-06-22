import { clsx, type ClassValue } from "clsx";
import { Platform } from "react-native";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind / NativeWind class names, resolving conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isWeb() {
  return Platform.OS === "web";
}

export function isNative() {
  return Platform.OS === "ios" || Platform.OS === "android";
}
