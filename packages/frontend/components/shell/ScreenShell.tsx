/**
 * The storefront's per-page wrapper is the shared one. This module stays so the
 * pages keep importing `@/components/shell/ScreenShell`; the implementation —
 * no `ContentPanel` of its own (Bloom's `AppShell panel` draws it), the web
 * document-scroll / native `ScrollView` split — lives in `@mercaria/ui`.
 */
export { ScreenShell, type ScreenShellProps } from "@mercaria/ui";
