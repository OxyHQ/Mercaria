/**
 * READING the layout direction currently in force, reactively (#429 item 4).
 *
 * This is Bloom's `useIsRtl` (`@oxy.so/bloom/hooks`) under its old name. The
 * semantics were already identical — `document.documentElement.dir` observed
 * live on web, `I18nManager.isRTL` (constant for the process) on native, both
 * through `useSyncExternalStore` with a left-to-right server snapshot — so a
 * second implementation was only a second thing to keep in step.
 *
 * New code imports `useIsRtl` from `@oxy.so/bloom/hooks` directly. The alias
 * stays while `components/ui/sheet.tsx` still imports it; delete this file with
 * that import.
 *
 * The division of labour is unchanged: `../i18n/rtl-locales` decides which
 * locales are right-to-left, `../i18n/layout-direction` APPLIES that to the
 * platform, and this reads back what was applied — it never re-derives
 * direction from a locale, because a second derivation could disagree with the
 * platform that is doing the mirroring.
 */
export { useIsRtl as useIsRtlLayout } from "@oxy.so/bloom/hooks";
