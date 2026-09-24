import { useCallback } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persisted app-shell sidebar state, shared by every Mercaria app.
 *
 * `sidebarOpen` drives Bloom's in-flow `Sidebar` (inside `AppShell`) between
 * its expanded panel and the collapsed icon column: each app's sidebar hook
 * hands it to the sidebar as the CONTROLLED `collapsed` / `onCollapsedChange`
 * pair, because Bloom's own collapse state is in-memory and would reset on every
 * reload. Only this flag survives reloads. Each app is a separate origin /
 * native bundle, so persistence is naturally isolated per app.
 */
interface SidebarState {
  /** Desktop sidebar expanded (true) vs collapsed to an icon rail (false). */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    }),
    {
      name: "mercaria.ui.sidebar",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ sidebarOpen: state.sidebarOpen }),
    },
  ),
);

/**
 * Desktop sidebar collapse state, persisted per app. Returns the derived
 * `collapsed` boolean, a `setCollapsed` setter shaped for Bloom's
 * `onCollapsedChange`, and stable collapse/expand/toggle actions.
 */
export function useSidebarCollapse() {
  const sidebarOpen = useSidebarStore((s) => s.sidebarOpen);
  const setSidebarOpen = useSidebarStore((s) => s.setSidebarOpen);
  const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);

  const collapsed = !sidebarOpen;
  const collapse = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);
  const expand = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const setCollapsed = useCallback(
    (next: boolean) => setSidebarOpen(!next),
    [setSidebarOpen],
  );

  return { collapsed, setCollapsed, collapse, expand, toggle: toggleSidebar };
}
