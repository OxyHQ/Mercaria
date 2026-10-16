import { useDialogControl, type DialogControlProps } from "@oxy.so/bloom/dialog";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

/**
 * Settings is ONE dialog per app — Bloom's `SettingsModal`, the surface every
 * Oxy app shares — never a stack of screens. This is the half every Mercaria
 * app shares: the open/close state and the hook a screen opens it with. Each app
 * supplies its own pages through `dialog`.
 *
 * It imports nothing from `@oxy.so/bloom/settings-modal` on purpose. The
 * provider wraps the whole app, and Metro does not tree-shake, so a static
 * import here would put the dialog and every page in the startup bundle of an
 * app that has not opened it. `dialog` is the app's `lazy()` module instead,
 * mounted on the first open request.
 */
export interface SettingsDialog {
  /** Opens the dialog: on `page`, or on the section list when omitted. */
  open: (page?: string) => void;
  close: () => void;
  /**
   * Closes the dialog, THEN runs `action` — for a row that leaves Settings
   * (a route, an Oxy sheet). Navigating under an open dialog leaves it over
   * the destination; runs `action` at once when the dialog is not open.
   */
  afterClose: (action: () => void) => void;
}

/** What the provider hands the app's dialog module; spread it onto `SettingsDialogShell`. */
export interface SettingsDialogState {
  control: DialogControlProps;
  /** Bumped by every `open()`; each new value opens the dialog. */
  openRequest: number;
  page: string;
  initialView: "navigation" | "page";
  onPageChange: (page: string) => void;
  onClose: () => void;
}

const SettingsDialogContext = createContext<SettingsDialog | null>(null);

export interface SettingsDialogProviderProps {
  /** The page `open()` with no argument selects for the wide layout's content pane. */
  defaultPage: string;
  /** The app's dialog, normally `lazy(() => import(...))`. */
  dialog: ComponentType<SettingsDialogState>;
  children?: ReactNode;
}

export function SettingsDialogProvider({ defaultPage, dialog: Dialog, children }: SettingsDialogProviderProps) {
  const control = useDialogControl();
  const [page, setPage] = useState(defaultPage);
  const [initialView, setInitialView] = useState<"navigation" | "page">("navigation");
  const [openRequest, setOpenRequest] = useState(0);
  const active = useRef(false);
  const pendingAction = useRef<(() => void) | null>(null);

  const open = useCallback(
    (next?: string) => {
      pendingAction.current = null;
      setPage(next ?? defaultPage);
      setInitialView(next ? "page" : "navigation");
      active.current = true;
      setOpenRequest((request) => request + 1);
    },
    [defaultPage],
  );
  const close = useCallback(() => control.close(), [control]);
  const afterClose = useCallback(
    (action: () => void) => {
      if (!active.current) {
        action();
        return;
      }
      pendingAction.current = action;
      control.close();
    },
    [control],
  );
  const onClose = useCallback(() => {
    active.current = false;
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  }, []);

  const value = useMemo(() => ({ open, close, afterClose }), [open, close, afterClose]);

  return (
    <SettingsDialogContext.Provider value={value}>
      {children}
      {openRequest > 0 ? (
        <Suspense fallback={null}>
          <Dialog
            control={control}
            openRequest={openRequest}
            page={page}
            initialView={initialView}
            onPageChange={setPage}
            onClose={onClose}
          />
        </Suspense>
      ) : null}
    </SettingsDialogContext.Provider>
  );
}

/** The app's Settings dialog. Only valid under `SettingsDialogProvider`. */
export function useSettingsDialog(): SettingsDialog {
  const dialog = useContext(SettingsDialogContext);
  if (!dialog) throw new Error("useSettingsDialog must be used under <SettingsDialogProvider>");
  return dialog;
}

/**
 * Opens the dialog once the dialog module has mounted. Lives with the provider
 * because it is the other half of `openRequest`: it runs after the module's
 * first commit too, so the request that LOADED the module also opens it.
 */
export function useOpenOnRequest(control: DialogControlProps, openRequest: number) {
  useEffect(() => {
    if (openRequest) control.open();
  }, [control, openRequest]);
}
