# Client packages: rules that break silently

Moved from the root `AGENTS.md`. Applies to `packages/{frontend,dashboard,pos,ui}`.

- **`@mercaria/ui` is NOT built to dist.** Apps consume it through Metro
  `watchFolders`, the `@mercaria/ui/theme/tailwind.preset` preset and a
  `tsconfig.paths` alias. Do NOT add a build step, and never keep a local copy of
  anything it owns (`PriceDisplay`, `FxContext`, every marketplace
  primitive). `formatMoney` is shared headless code, re-exported by both UI and SDK.
- **CI typechecks all three Expo apps.** A build is not a substitute: Babel
  strips types, so `expo export` bundles code `tsc` rejects.
- **`typedRoutes` is armed** (`generate-router-types.mjs` in each app's `typecheck`;
  `typed-routes-armed.test.ts` fails if it stops). It checks the OBJECT form
  COMPLETELY — a wrong `{ pathname }` is TS2820 — but a TEMPLATE LITERAL only when
  no dynamic route sits above the mistyped segment, so `` `/products/wizrd/${id}` ``
  exits 0, absorbed by `/products/[id]` (#456). Spell dynamic targets as objects;
  `validate:route-targets` resolves each against the real tree (`docs/product-page.md`).
