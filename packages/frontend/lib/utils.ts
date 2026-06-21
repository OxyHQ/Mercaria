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

export function isIOS() {
  return Platform.OS === "ios";
}

/** RFC4122-ish v4 UUID, used for optimistic client-side ids. */
export function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
