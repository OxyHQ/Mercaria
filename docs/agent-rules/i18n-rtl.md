# Localization and right-to-left

Moved from the root `AGENTS.md`. Applies to all four client packages.

- **ONE locale registry, `@mercaria/ui/src/i18n/`**; module-scope data holds KEYS,
  never sentences. App copy is per app; **`@mercaria/ui`'s own copy is in ITS
  bundles**, merged under the reserved `ui` namespace for the locales that app SHIPS
  — never the union, or the dashboard gains an `ar` it cannot mirror — and read
  through `SharedUiTranslationProvider` at every app root. `validate:i18n-strings`
  gates that plus hardcoded strings, parity and unreferenced keys. `docs/app-i18n.md`.
- **All four client packages mirror for Arabic from LOGICAL utilities only**
  (`ms-`, `start-`, `rounded-s-`…), gated by `validate:rtl-classes`; a physical
  `ml-2` half-mirrors a screen yet builds green. Direction follows the SHIPPED
  BUNDLES, not the tag (#434). `border-s-*`/`text-start` do NOT survive
  react-native-css/RN 0.88 and stay physical (`validate-rtl-upstream-premises`
  re-measures both). A Bloom `Dialog` side-sheet takes the LOGICAL
  `placement="start"|"end"`, never `left`/`right`; its `inset` keys stay
  physical. Arabic is NOT fully supported — #429 item 2.
