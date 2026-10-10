import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { webLocalStorage, type AppColorName, type BloomThemeStorage } from "@oxy.so/bloom/theme";

// Wholesale has a fixed brand palette; Bloom still persists the chosen mode.
export const BLOOM_DEFAULT_COLOR_PRESET: AppColorName = "orange";

/**
 * Single source of truth for where Bloom persists the active theme
 * (`{ mode?, colorPreset? }` as JSON). `BloomProvider` writes it; the key
 * lives here so writers and readers can never drift. Distinct from the
 * storefront key so the two apps keep independent theme preferences.
 */
export const BLOOM_THEME_PERSIST_KEY = "mercaria.dashboard.bloom.theme";

/**
 * Platform-selected storage adapter for Bloom theme persistence.
 * - Web: `webLocalStorage` (synchronous `localStorage`) so Bloom hydrates before
 *   the first paint, avoiding a palette flash.
 * - Native: `AsyncStorage` (signature-compatible with `BloomThemeStorage`).
 */
export const BLOOM_THEME_STORAGE: BloomThemeStorage =
  Platform.OS === "web" && webLocalStorage ? webLocalStorage : AsyncStorage;
