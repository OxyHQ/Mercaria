import { useCallback } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persisted app-shell sidebar state, shared by every Mercaria app.
 *
 * `sidebarOpen` drives the desktop {@link AppSidebar} between its expanded form
 * and the collapsed icon rail. The {@link AppShell} web layout reads the same
 * flag to animate the rail column width, so this store is the single source of
 * truth for the collapse state. Only this flag survives reloads. Each app is a
 * separate origin / native bundle, so persistence is naturally isolated per app.
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
 * Desktop icon-rail collapse state, shared by the {@link AppSidebar} and the
 * {@link AppShell} web layout (which sizes the rail column off the same flag).
 * Returns the derived `collapsed` boolean plus stable collapse/expand/toggle
 * actions.
 */
export function useSidebarCollapse() {
  const sidebarOpen = useSidebarStore((s) => s.sidebarOpen);
  const setSidebarOpen = useSidebarStore((s) => s.setSidebarOpen);
  const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);

  const collapsed = !sidebarOpen;
  const collapse = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);
  const expand = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);

  return { collapsed, collapse, expand, toggle: toggleSidebar };
}
