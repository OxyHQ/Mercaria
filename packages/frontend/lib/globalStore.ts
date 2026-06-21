import { create } from "zustand";

/**
 * Small app-wide ephemeral UI state that doesn't belong to a feature store.
 * Sidebar/layout state lives in `ui-store.ts`.
 */
interface StoreState {
  /** Vertical scroll position of the active list, used for header effects. */
  scrollY: number;
  setScrollY: (value: number) => void;
}

export const useStore = create<StoreState>((set) => ({
  scrollY: 0,
  setScrollY: (value: number) => set({ scrollY: value }),
}));
