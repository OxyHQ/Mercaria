import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createBillingIntentRunner, type BillingIntentStorage } from "./intent";

// A browser tab owns its explicit intent and survives reload. Separate tabs do
// not race a shared localStorage key. Native uses the app's own AsyncStorage UID.
const storage: BillingIntentStorage = Platform.OS === "web" ? {
  getItem: async key => sessionStorage.getItem(key),
  setItem: async (key, value) => sessionStorage.setItem(key, value),
  removeItem: async key => sessionStorage.removeItem(key),
} : AsyncStorage;
export const withBillingIntent = createBillingIntentRunner(storage);
