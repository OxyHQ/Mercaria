# App localization (#398)

How the three Expo apps speak a merchant's, a cashier's and a shopper's
language. This is the INTERFACE — buttons, headings, empty states, errors.
Localizing CATALOG DATA (a category's name, a controlled value's label) is a
different problem with different constraints and lives in
[catalog-localization.md](catalog-localization.md).

| Piece | Path |
| --- | --- |
| The locale registry — which locales exist, how a device tag resolves | `packages/ui/src/i18n/locales.ts` |
| The i18n instance factory | `packages/ui/src/i18n/create-app-i18n.ts` |
| The per-app store and the `useTranslation` hook | `packages/ui/src/i18n/create-i18n-store.ts` |
| Dashboard wiring + copy | `packages/dashboard/lib/i18n/` |
| POS wiring + copy | `packages/pos/lib/i18n/` |
| Storefront (still on its own copy — #435) | `packages/frontend/lib/i18n/` |
| The guard | `scripts/validate-i18n-strings.mjs` |

## One registry, three vocabularies

The registry is shared and the COPY is not.

Sharing the registry is what stops three apps disagreeing about what a locale is
called. `pt-BR` in one app and `pt_BR` in another is a bundle that loads in one
place and silently falls back to English in the other, and nothing fails. So
`SUPPORTED_LOCALES`, the alias policy and the fallback chain live in
`@mercaria/ui`, which all three apps consume from source.

Sharing the STRINGS would be wrong for the opposite reason. The dashboard's
"Add product" and the storefront's "Add to cart" are not one vocabulary; merging
them would make every copy change a cross-app change, and would put merchant
wording in a shopper's bundle where a translator cannot tell which audience a
sentence is for. Each app keeps `lib/i18n/locales/*.json`.

## The alias table is two entries, and that is deliberate

`i18n-js` runs with `enableFallback`, whose chain already resolves `es-MX` ->
`es` -> `en` and `de-CH` -> `de` -> `en`. Enumerating regional tags would
produce a list that looks authoritative while omitting whichever region nobody
thought of (`en-AU`, `fr-BE`, `es-CL`) — and an omission there is
indistinguishable from a deliberate exclusion.

What the chain cannot do is jump between two different tags, which is exactly
two cases:

- **`pt` -> `pt-BR`.** Without it a device reporting plain `pt`, or `pt-PT`
  (whose chain is `pt-PT` -> `pt` -> default), gets English. The copy is
  Brazilian; a European Portuguese reader is much closer to it than to English.
  A dedicated `pt-PT` bundle would still be an improvement.
- **`zh` -> `zh-Hans`.** Without it a device reporting plain `zh` gets English.
  The consequence, stated rather than left to be discovered: `zh-TW` and `zh-HK`
  chain through `zh` and therefore receive SIMPLIFIED Chinese. That is the wrong
  script, and still a closer answer than English. A `zh-Hant` bundle is what
  fixes it, and adding one to `SUPPORTED_LOCALES` makes `zh-TW` resolve to it
  with no edit to the alias table.

Both were verified against the real `i18n-js` resolution rather than assumed.

## Neither app ships Arabic, and that is the point

The registry carries `ar` because the storefront ships it (#396) and mirrors its
layout for it (#397). The dashboard and the POS ship the other ELEVEN locales
and deliberately not `ar`.

Arabic copy in an unmirrored layout is worse than English: the text reads
right-to-left while the row order, the padding, the table columns, the sidebar
and the numeric keypad all stay left-to-right. That is the half-mirrored state
PR #428 existed to remove from the storefront, and re-creating it in the two
surfaces where a mistake costs money is not an improvement.

So `ar.json` for these two apps is the LAST step of mirroring their layout
(#434), not a separate favour that can land first.

## Rules that are load-bearing

- **Module-scope data holds KEYS, never sentences.** A `const` array or record
  evaluated at import cannot call `t()` — the locale store has not rehydrated
  and the value would freeze whichever language loaded first. `NavItem.labelKey`
  and the status-label maps hold keys; the render site resolves them. This also
  makes the guard's part C bite (below).
- **`useTranslation` is not suspenseful and never will be.** It reads a zustand
  slice and calls a synchronous `i18n.t`. A provider that suspends at boot
  deadlocks an Expo app into a permanent white screen with no error at all.
- **`t` takes its locale from the STORE, not from `i18n.locale`.** Reading the
  instance during render is reading external mutable state, which the React
  Compiler is free to memoise around — the screen would keep rendering the
  previous language with nothing to blame. Passing the reactive value makes `t`
  a pure function of state, so a locale change invalidates every caller by
  construction. (Neither app has the compiler enabled today. The rule is what
  makes enabling it a non-event.)
- **One key, one whole sentence.** Interpolation is `%{name}`; a sentence is
  never split across two `t()` calls to interleave a value, because word order
  differs by language.
- **The persisted key differs per app.** Three Mercaria apps can sit on one
  device, and a cashier's till language is not the same merchant's admin
  language.

## Plurals, and the limitation that is not hidden

Pluralised keys are a nested object with `one` / `other` and a `%{count}`
placeholder, resolved by `i18n-js`'s DEFAULT pluralizer — which applies the
English rule to every locale.

For Russian, Arabic, Polish and Czech that is an approximation: those languages
have three or four plural categories and will render the `other` form where a
`few` or `many` form is correct. Making it right means registering a per-locale
pluralizer (`Intl.PluralRules` is the obvious source) AND relaxing the guard's
key-parity check, which today requires every bundle to carry exactly `en`'s
keys — correct while the pluralizer is English-shaped, and wrong the moment it
is not. Both halves have to move together, so they are #436 rather than a
half-change here. The storefront has the same limitation.

## The guard

`bun run validate:i18n-strings` (CI: "Guard dashboard and POS i18n"). Three
checks, and the third is the one worth understanding.

- **A. No hardcoded user-facing string** in `packages/dashboard` or
  `packages/pos` — JSX text, a string in a JSX child expression, a user-facing
  JSX attribute, a user-facing object property, an `Alert.alert` argument.
- **B. Bundle parity** — every non-`en` bundle carries exactly `en`'s key set
  (missing AND extra) with exactly `en`'s placeholders. A missing key falls back
  to the ENGLISH string, so the screen looks translated in review and is not; a
  renamed placeholder renders the literal `%{count}` to a merchant.
- **C. Referential integrity** — every `t('literal')` names a real key, and every
  key in `en.json` is named by some literal in that app's source.

C is what catches the regression A cannot see. A decides only the positions it
can decide from the syntax, and a plain map of status labels
(`{ paid: 'Paid', shipped: 'Shipped' }`) is not one of them: the property names
there are statuses, and a detector loose enough to catch it would fire on every
Tailwind class and permission string in the tree. Because the migrated code
stores keys in those maps, writing English back into one leaves
`orders.status.paid` referenced by nothing — and C fails naming it. That is the
mutation the guard was tested on.

There is deliberately **no exception list**, which is the one place this guard
differs from its siblings in `scripts/`. A string here is either COPY, in which
case the remedy is one key and costs nothing, or an IDENTIFIER, in which case no
detector looks at it. With an exception list the cheapest green for an awkward
string is an entry nobody revisits; without one it is `t('some.key')`, which is
the correct action — and for a string that must read the same in every language
(a brand name, a currency symbol) a key holding it is right anyway, because some
languages transliterate and the decision then sits in the bundle where a
translator can see it.

`scripts/test-validate-i18n-strings.mjs` mutation-tests all three parts against
real `git init` fixture trees, including the must-NOT-fire cases (Tailwind
classes, routes, permissions, query keys, the storefront) that decide whether
anyone leaves the guard switched on.

## What the guard cannot see

Stated so nobody reads a green run as more than it is:

- A string passed to a plain function (`useRailTooltip("Expand sidebar")`) is not
  in a position the analyser decides. Those were extracted by hand.
- A string composed at runtime from parts the analyser cannot follow.
- Whether a TRANSLATION is any good. Parity says a key exists in `de.json`; it
  says nothing about whether the German is right.
- `packages/frontend`, which is out of scope entirely (#435).
- **`packages/ui`'s own reader-facing copy**, which is the largest residual and
  is deliberately named here rather than left to be discovered. The shared
  package holds English sentence maps for the condition taxonomy, offer labels,
  pickup, price signals, commercial disclosures, referrals, shopping agents and
  grounded comparison — every one of them rendered by all three apps and none of
  them reachable from an app's bundle. A dashboard screen can therefore be fully
  extracted, pass this guard, and still render an English paragraph that came
  from `@mercaria/ui`. Fixing it is one decision about where shared copy lives,
  not a per-app patch, and it is #437.

## Deferred

| # | What |
| --- | --- |
| #434 | Mirror the dashboard and POS layouts for RTL, then add `ar.json` to both |
| #435 | Converge `packages/frontend/lib/i18n` onto the shared registry, and widen the guard to it |
| #436 | Per-locale CLDR plural categories, plus the parity check that has to move with them |
| #437 | `packages/ui`'s shared reader-facing copy — where it lives once it has to exist in eleven languages |
