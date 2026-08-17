# App localization (#398)

How the three Expo apps speak a merchant's, a cashier's and a shopper's
language. This is the INTERFACE — buttons, headings, empty states, errors.
Localizing CATALOG DATA (a category's name, a controlled value's label) is a
different problem with different constraints and lives in
[catalog-localization.md](catalog-localization.md).

| Piece | Path |
| --- | --- |
| The locale registry — which locales exist, how a device tag resolves | `packages/ui/src/i18n/locales.ts` |
| The i18n instance factory, and the shared-copy merge | `packages/ui/src/i18n/create-app-i18n.ts` |
| The per-app store and the `useTranslation` hook | `packages/ui/src/i18n/create-i18n-store.ts` |
| `@mercaria/ui`'s OWN copy (#437) | `packages/ui/src/i18n/locales/*.json` + `shared-copy.ts` |
| How a shared component reaches an app's `t` (#437) | `packages/ui/src/i18n/ui-translation.tsx` |
| Dashboard wiring + copy | `packages/dashboard/lib/i18n/` |
| POS wiring + copy | `packages/pos/lib/i18n/` |
| Storefront wiring + copy | `packages/frontend/lib/i18n/` |
| Which locales are RTL (pure — a guard runs it) | `packages/ui/src/i18n/rtl-locales.ts` |
| Applying a direction to the platform | `packages/ui/src/i18n/layout-direction.ts` |
| The guard | `scripts/validate-i18n-strings.mjs` |

## One registry, three APP vocabularies, one SHARED one

The registry is shared, each app's own copy is not, and `@mercaria/ui`'s own
copy is shared again. Those are three different answers to three different
questions, and the middle one is the one people collapse.

Sharing the registry is what stops three apps disagreeing about what a locale is
called. `pt-BR` in one app and `pt_BR` in another is a bundle that loads in one
place and silently falls back to English in the other, and nothing fails. So
`SUPPORTED_LOCALES`, the alias policy and the fallback chain live in
`@mercaria/ui`, which all three apps consume from source.

Sharing an APP's strings would be wrong for the opposite reason. The dashboard's
"Add product" and the storefront's "Add to cart" are not one vocabulary; merging
them would make every copy change a cross-app change, and would put merchant
wording in a shopper's bundle where a translator cannot tell which audience a
sentence is for. Each app keeps `lib/i18n/locales/*.json`.

## `@mercaria/ui`'s own copy (#437)

The shared package owns reader-facing COPY for every domain whose KEYS live in
`@mercaria/shared-types` — the condition taxonomy, the comparison labels,
pickup, price signals, referrals. That split is right and is not being undone: a
stored key is what a column, a CHECK and a wire contract carry, a sentence is
what a person reads, and only one of the two may change without a contract
change.

Until #437 those sentences were hardcoded English, so a dashboard screen could
be fully extracted, pass this guard, and still render an English paragraph that
came from `@mercaria/ui`. Three shapes were available:

1. **The maps hold keys and each APP carries the copy.** The `NavItem.labelKey`
   pattern one layer up. Rejected: the same twelve translations of
   "Used — like new" would be copied into three bundles that nothing keeps in
   step, and the drift is INVISIBLE, because each app's parity check passes
   independently against its own `en.json`.
2. **`@mercaria/ui` gets its own bundles, merged into each app's instance under
   a reserved namespace.** Chosen.
3. **The components take their strings as props.** Rejected: it moves the
   exhaustive-`Record` property out of `packages/ui`'s typecheck and into every
   caller, and that property is the entire reason the maps exist.

### How (2) copes with the apps having DIFFERENT locale sets

That asymmetry was the crux when #437 landed, and the mechanism it produced is
what let `ar` arrive in the dashboard and the POS later without touching this
package. At the time the storefront shipped `ar` and those two deliberately did
not (#434, above); all four ship it now. So:

- **`SHARED_UI_COPY` is TOTAL over `SUPPORTED_LOCALES`** — a `Record`, never a
  `Partial<Record>`, so a registry locale with no shared copy is a COMPILE
  error rather than an English paragraph inside an otherwise Spanish page. An
  app can never ask for a locale this package lacks, because there is no such
  locale.
- **The merge is the INTERSECTION, never the union.** `createAppI18n` registers
  the locales the APP ships and merges shared copy into exactly those. While the
  dashboard shipped no `ar`, `@mercaria/ui` shipping one did NOT give it an
  Arabic locale: an Arabic device there resolved `ar` → unregistered → `en` and
  got a whole English screen in a left-to-right layout, which is the state #434
  chose. It never got Arabic condition labels inside an unmirrored English
  screen, which is the half-mirrored state PR #428 existed to remove. Adding
  `ar.json` to that app is therefore the ONLY edit #434 needed for the shared
  condition and offer copy to start resolving in Arabic too — no change here.

So "an app has no key for a shared sentence" is unrepresentable for a locale it
ships. The remaining hole is an app that never mounts the provider, and that
resolves against `@mercaria/ui`'s own `en` — the exact text that shipped before
#437, never a raw key and never `missingBehavior: 'guess'`. Check E below fails
the build on it.

### The reserved namespace, and why the collision is refused

`mergeSharedUiCopy` is the ONE merge, and since #435 converged the storefront
`createAppI18n` is its ONE caller — all three apps attach shared copy by the
same path. Shared copy goes under the
top-level key `ui`; an app bundle carrying one is REFUSED at boot rather than
resolved by spread order, because an app naming a key `ui` is not doing anything
wrong and silently letting one side win is unreadable in either tree. Check D
fails the build before it can reach a boot.

### How a shared component gets a `t`

`SharedUiTranslationProvider` at each app root, `useSharedUiTranslation()`
inside the package. A context rather than a module-level slot that
`createI18nStore` writes: a slot is external mutable state read from a render
position, which the React Compiler is free to memoise around, and it makes the
number of hooks a component calls depend on whether boot has filled it. The hook
is `useContext` and nothing else — the "never suspenseful" rule below applies to
it identically.

The provider is handed the APP's own `t`, so there is one locale in force per
app rather than a second one in this package that could disagree with the screen
around it.

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

### The Traditional Chinese question #435 was expected to decide, and did not

The storefront's pre-#435 table carried the OPPOSITE decision in a comment:
`zh-Hant` "is deliberately NOT aliased here — it falls back to the default
locale instead", i.e. English. Converging it onto this registry was therefore
sized as a silent product change, English -> Simplified, for every Traditional
Chinese reader.

**It was not one. The comment was wrong about its own table.** That table
registered `zh`, and `zh-TW` -> `zh` is precisely the hop `enableFallback`
makes, so those readers were already being served Simplified — the same answer
this registry gives, by the same mechanism. Measured on both instances with the
real `i18n-js` before the convergence landed: all thirty-one probed tags
resolved identically, and the probe was mutation-tested (dropping the `zh` alias
turned `zh-TW` from Simplified to English and the run red), so "no change" is a
measurement rather than an absence of evidence.

The lesson generalises past this locale: **a comment asserting a fallback
outcome is not evidence of one.** The chain is short enough to state and long
enough to get wrong, and nothing fails when it is. Resolution claims in this
area get probed against the real library.

## All four apps ship Arabic, and the ORDER they got it in was the point

The registry carries `ar` because the storefront shipped it first (#396) and
mirrored its layout for it (#397). The dashboard and the POS shipped the other
ELEVEN locales and deliberately not `ar` until their own layouts mirrored.

Arabic copy in an unmirrored layout is worse than English: the text reads
right-to-left while the row order, the padding, the table columns, the sidebar
and the numeric keypad all stay left-to-right. That is the half-mirrored state
PR #428 existed to remove from the storefront, and re-creating it in the two
surfaces where a mistake costs money is not an improvement.

So `ar.json` for those two apps was the LAST step of mirroring their layout
(#434), not a separate favour that could land first.

### Both halves have landed

#434 split in two. The LAYOUT half went first: both apps migrated to logical
utilities, `validate:rtl-classes` widened to all four client packages, and the
direction bootstrap wired through `createI18nStore`'s `onLocaleApplied` hook.
#429 item 4 then gave `Panel`/`SheetContent` a logical side, so the POS variant
picker mirrors with everything else. The COPY half followed: 1,228 translated
strings (dashboard 1,088, POS 140) under the parity gate.

**Direction follows the SHIPPED BUNDLES, never the language tag**, which is why
adding `ar.json` is the whole of what turns mirroring on — `isRtlLocale` reads
the locales an app ships, so the two apps were genuinely LTR beforehand rather
than incidentally so. `scripts/validate-rtl-direction.mjs` states it as a
biconditional (mirror exactly when the language is RTL *and* a bundle exists),
which is why it kept holding across the change instead of failing it.

**No device has run either app in Arabic.** Whether the mirrored layout RENDERS
correctly is a property of a real device or a foregrounded tab, and neither
`validate:rtl-classes`, `validate:rtl-direction` nor `validate:logical-side`
runs one — they check classes, a pure decision and four pure functions.

The residual the bundles could not have fixed on their own is now closed. #429
item 4 replaced `Panel`'s and `SheetContent`'s physical `side: 'left' | 'right'`
with a logical `LogicalSide` (`start` / `end`), a clean cut with no alias
accepting both, and
`packages/pos/components/register/VariantPickerSheet.tsx` — the one call site in
the repository — now passes `side="end"`. So the POS variant picker mirrors with
everything else the moment `ar.json` lands.

Most of that surface needed no direction at all. The anchor is
`insetInlineStart` / `insetInlineEnd` (RN 0.85.3 registers both, and
react-native-web 0.21.2 passes them through as real CSS logical properties) and
the inner corner is `rounded-s-` / `rounded-e-`, so all three re-resolve on their
own. **Two facts cannot**, and they are the whole of
`packages/ui/src/lib/logical-side.ts`:

* **`translateX` is physical on both platforms.** A CSS transform is never
  mirrored by `dir`, and React Native consults `I18nManager` nowhere under
  `Libraries/StyleSheet` or `Libraries/Animated` — Yoga's RTL mirroring is a
  layout pass and does not reach a transform. So the sign of the parked position
  is computed.
* **The divider on the panel's inner face has no logical spelling that
  survives** — `border-s-*` emits `borderInlineStartWidth`, which RN 0.85.3 does
  not register (the same measurement as everything else above). Resolving it in
  ONE function is what let the `panel.tsx` and `sheet.tsx` exception entries be
  deleted and replaced by a single one.

The direction itself is READ, never re-derived from a locale:
`packages/ui/src/lib/use-layout-direction.ts` returns what
`syncLayoutDirection` already applied — `document.documentElement.dir` on web
(observed, because a language switch changes it mid-session) and
`I18nManager.isRTL` on native (constant for the process, because `forceRTL`
takes effect on the next launch). It goes through `useSyncExternalStore`: both
are external mutable state, the React Compiler is on, and a memoised read would
leave a panel animating in the previous direction with nothing to blame.

`scripts/validate-logical-side.mjs` runs the four pure functions — the module
imports nothing, for the reason `rtl-locales.ts` imports nothing — and asserts
the 2×2 table, the mirror property (a resolver that ignored the direction would
pass every other check), the transform sign and border edge cross-checked
against the resolution, and that both components still call it. **It verifies no
rendering.** Whether a mirrored sheet visibly enters from the correct edge is
#429 item 2, and no device or foregrounded tab has run it.

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

**Arabic is the worst case and its shipped shape is deliberate.** CLDR gives
Arabic SIX categories (`zero`, `one`, `two`, `few`, `many`, `other`) against
English's two, so one `other` form has to cover 0, 2, 3–10, 11–99 and 100+,
which take three different noun forms. Every Arabic plural in this repository
therefore writes the SINGULAR in both `one` and `other`, matching the
`ui.offer.days` precedent `@mercaria/ui` set (`%{count} يوم` for both) and the
same trick `ru` uses there (the abbreviated `дн.`). It is correct for 11–99,
where Arabic genuinely takes the singular, and visibly wrong for 3–10, where
`3 طلب` should read `3 طلبات`. That is a **#436 case**, not something to work
around per-key: a bundle that spelled the 3–10 form instead would be wrong for
11–99, and there is no single form that is right for both. The 28 plural keys
this affects are `customers.orderCount`, `collections.productCount` and the
other 21 in the dashboard, plus the 5 in the POS.

## The guard

`bun run validate:i18n-strings` (CI: "Guard dashboard and POS i18n"). Six
checks; the third is the one worth understanding and the sixth is the one that
catches a defect no other gate in CI can see.

- **A. No hardcoded user-facing string** in `packages/dashboard`,
  `packages/pos` or `packages/frontend` — JSX text, a string in a JSX child expression, a user-facing
  JSX attribute, a user-facing object property, and an argument to one of a
  short named list of calls that carry copy through a plain function
  (`Alert.alert`, `toast.*`, `useRailTooltip`). Named rather than "any call
  taking a string", which would flag every `fetch`, query key and
  `router.push`.
- **B. Bundle parity** — every non-`en` bundle carries exactly `en`'s key set
  (missing AND extra) with exactly `en`'s placeholders. A missing key falls back
  to the ENGLISH string, so the screen looks translated in review and is not; a
  renamed placeholder renders the literal `%{count}` to a merchant.
- **C. Referential integrity** — every `t('literal')` names a real key, and every
  key in `en.json` is named by some literal in that app's source.
- **D. The reserved `ui` namespace (#437)** — every shared bundle's only
  top-level key is `ui`, and no app bundle has one. Both populations are DERIVED
  from the tracked file listing, so a fourth app is covered the day it appears;
  a floor on each is what tells "the derivation found fewer" from "there are
  fewer".
- **E. The provider is mounted (#437)** — every app root layout renders
  `<SharedUiTranslationProvider>`, detected as a JSX ELEMENT rather than as a
  substring. The regression it exists for is the element going while the import
  stays, which a substring check waves straight past, so that is one of its four
  negative controls.
- **F. An action label is not a sentence fragment (#442)** — a key rendered as
  an action CONTROL's own label must not also be interpolated into a translated
  sentence. See below.

**A does not run over `packages/ui`.** That package is only part way through
extraction — #437 converted the condition and offer-label copy and the rest of
its component prose is still English — and a gate over an unmigrated tree is one
whoever hits it first disables — the same reasoning that kept
`packages/frontend` out until #435b extracted it. B and C DO run there, and neither needs the package
finished: C is what catches a shared map put back on English, by name. Widening
A to `packages/ui` is the residual on #437. D and E cover every app including
the storefront, because they are about the plumbing rather than about copy.

C is what catches the regression A cannot see. A decides only the positions it
can decide from the syntax, and a plain map of status labels
(`{ paid: 'Paid', shipped: 'Shipped' }`) is not one of them: the property names
there are statuses, and a detector loose enough to catch it would fire on every
Tailwind class and permission string in the tree. Because the migrated code
stores keys in those maps, writing English back into one leaves
`orders.status.paid` referenced by nothing — and C fails naming it. That is the
mutation the guard was tested on.

Part C reads EVERY string literal in the app, not only `t()` arguments, and that
is what makes the rule-3 map pattern checkable: the keys in
`ORDER_STATUS_LABEL_KEYS` are literals even though the call site is the dynamic
`t(ORDER_STATUS_LABEL_KEYS[status])`. Rename one side of that pair and the other
side's key is referenced by nothing.

The consequence is that a key BUILT at runtime — `` t(`orders.status.${s}`) ``
— is effectively **refused**: no literal names those leaves, so part C reports
every one of them as dead copy and the build goes red. That is the right
outcome (it pushes you to a literal map, which is greppable and which the
exhaustive `Record` type-checks) but it is a refusal rather than a diagnosis,
so it is worth knowing before you hit it. Neither app has one today.

### F, and the failure that survived a full translation pass

#442: `channels.disconnect.intro` read *"Choose what happens to the %{policy}
this channel imported"*, and `%{policy}` was filled with the lowercased text of
the toggle the merchant had just pressed. The three toggles say `Keep products`,
`Unpublish` and `Archive`, so the three renderings were *"…happens to the keep
products this channel imported"*, *"…to the unpublish…"*, *"…to the archive…"*.

Nothing else in CI can see that. The string was extracted, the key resolved,
parity passed, C found both keys referenced, `tsc` and lint were happy. It is
also not an English-only accident: every locale's label is an imperative
(`Produkte behalten`, `商品を残す`, `Оставить товары`) and every locale's frame
wanted a term, so the sentence was ungrammatical in all eleven.

What makes it worth a gate rather than a fix is how it survived. It predates the
extraction (#398 preserved it faithfully, per its own rule against changing copy
during a mechanical move), and then **five of the eleven translators worked
around it** — `ca` and `pt-BR` with a parenthetical, `es`, `fr` and `ru` with a
colon appositive — rather than reporting it. So the ten translated bundles read
better than the English, and the one review that looked hardest at this copy is
the review it walked past.

F states the rule structurally: a key whose text is an action control's own
label may not also be interpolated into a translated sentence. The remedy when
it fires is to give the sentence its OWN key, which is the same remedy the
no-exception-list note below describes — and the reason F needs no exception
list either.

Two things F deliberately does not do, both measured rather than assumed:

- **A badge is not an action control.** `orders.status.paid` -> "Paid" is a
  term, and it reads correctly in the appositive frames this surface actually
  uses (`'%{when} · %{status}'`). Flagging it would push somebody to split a key
  for no gain, and a guard whose cheapest green is busywork gets switched off.
  `Pressable` is excluded for the same reason from the other end: 86 of them
  wrap whole tappable rows, so treating one as a label would make every sentence
  inside it a "label".
- **A `t()` in a control's PROP is not its label.** `onPress={() =>
  toast.success(t(k))}` is a toast. Without that distinction F reported two
  false positives inside #442's own screen; with the stop written as "any
  attribute" it stopped seeing `<Button title={t(k)} />` at all. Both spellings
  have a control.

Its blind spots are COUNTED, not assumed away: a key reached through a local
alias (`s.labelKey`) or returned by a function cannot be read by a syntactic
guard, and a passing run prints how many it could not read (5 in the dashboard
today) rather than letting them look like zero. Two files in one app declaring
the same map name make that name unreadable too — resolving it to whichever was
read last would be a WRONG answer rather than a missing one.

F's answer on a healthy tree is an EMPTY intersection, which is also what a
completely broken detector returns. So both INPUT populations carry floors
(dashboard 98 labels / 28 interpolations today, POS 8 / 11), and
`test-validate-i18n-strings.mjs` puts #442's exact defect back into
`[connectionId].tsx` and requires the real guard to go red naming
`channels.disconnect.policy.keepListings` — asserting the mutation applied, and
that the file is restored byte-for-byte and the guard green afterwards.

There is deliberately **no exception list**, which is the one place this guard
differs from its siblings in `scripts/`. A string here is either COPY, in which
case the remedy is one key and costs nothing, or an IDENTIFIER, in which case no
detector looks at it. With an exception list the cheapest green for an awkward
string is an entry nobody revisits; without one it is `t('some.key')`, which is
the correct action — and for a string that must read the same in every language
(a brand name, a currency symbol) a key holding it is right anyway, because some
languages transliterate and the decision then sits in the bundle where a
translator can see it.

`scripts/test-validate-i18n-strings.mjs` mutation-tests every part against real
`git init` fixture trees, including the must-NOT-fire cases (Tailwind classes,
routes, permissions, query keys, the storefront) that decide whether anyone
leaves the guard switched on — plus, for F, one mutation of the REAL tree,
because a fixture only proves a detector works on source shaped the way the
fixture author imagined it.

## What the guard cannot see

Stated so nobody reads a green run as more than it is:

- A string passed to a plain function that is NOT in `USER_FACING_CALLEES`. The
  list covers what this surface actually uses; a new helper that renders its
  string argument joins it, and until it does its copy is invisible here.
- An English SENTENCE assembled at runtime out of variables the analyser cannot
  follow back to a literal. (A runtime-built KEY is a different case and is
  refused — see above.)
- Whether a TRANSLATION is any good. Parity says a key exists in `de.json`; it
  says nothing about whether the German is right.
- **Whether an interpolated value is grammatical in the frame it lands in.** F
  catches the one shape that is wrong by CONSTRUCTION — an action label, which
  is an imperative, dropped into a slot that needs a term. It says nothing about
  a value that is a noun and still wrong in some language's frame, because
  gender, definiteness and word order are facts about the sentence rather than
  about the call site. The only defence there is a whole sentence per case, and
  #442's own remedy was to stop interpolating rather than to interpolate better.
- **Four SHAPES check A cannot decide, in any app.** It reads JSX positions, a
  named list of user-facing attributes and properties, and a named list of
  callees. #435b found four things that reach a reader as English and sit in
  none of those positions, and every one was live in the storefront:

  1. a **module-scope initializer** holding sentences — an ARRAY or a RECORD;
  2. a function or `switch` that **RETURNS** copy (`timeAgo` returned
     `'just now'`, `` `${minutes}m ago` ``);
  3. a **parameter default** (`submitLabel = "Save address"`), which is the same
     thing one syntax over;
  4. text **derived at runtime from an identifier** — `{result.kind}` rendering
     `product_family`, `sourceKind.replace(/_/gu, ' ')` rendering
     `affiliate network` into a translated sentence. **There is no string
     literal at all**, so no scanner and no census can find it; only reading the
     screen can.

  The first three are caught by **check C once extracted**, and that is the
  whole reason the migrated form stores KEYS in the map: writing English back
  over `reviews.scopeHeading.merchant` leaves that key referenced by nothing and
  C fails naming it. The fourth is caught by nothing here, and adding a detector
  for it is not possible — the English IS the wire value.

  This is stated in the guard's own PASSING output, not only here, because a
  green line reading "guard passed" over a population it cannot see is the
  failure this guard exists to prevent, one level up.
- **An English sentence thrown as an `Error`.** `packages/frontend/lib/api/*`
  throws ~112 of them (`throw new Error('Failed to load your watchlists')`) and
  **17 screens render `error.message` directly**, so they are user-facing in all
  twelve languages. Extracting them is not a string move: the render site would
  still interleave them with SERVER messages, which are English too, so the fix
  is an error-CODE vocabulary the client maps to keys. Left undone deliberately
  rather than half-done, because keying only the client half would make the
  surface look covered while every server refusal stayed English.
- **Which subtree the provider covers.** Check E proves each app root MOUNTS
  `<SharedUiTranslationProvider>`, not that every rendered tree sits under it. A
  screen rendered outside the root tree falls back to `@mercaria/ui`'s English —
  which is correct English, and is what shipped before #437, so the failure is a
  missing translation rather than a broken screen.
- **`packages/ui`'s REMAINING reader-facing copy.** #437 converted
  `lib/condition.ts` and `lib/offer-labels.ts` completely. Still hardcoded
  English, each rendered by all three apps: `pickup-labels.ts`,
  `price-signal-labels.ts`, `commercial-copy.ts`, `shopping-agent-labels.ts`,
  `comparison-labels.ts`, `referral-labels.ts`, `connector-labels.ts`, and the
  prose inside the components themselves. The MECHANISM for all of them now
  exists and is the one above; what each needs is its keys, its twelve
  translations, and its call sites moved onto `useSharedUiTranslation`. Check A
  can be widened to `packages/ui` in the change that finishes the last of them.

## Deferred

| # | What |
| --- | --- |
| #486 | Native review of the 1,228 Arabic strings #434 shipped. The parity gate proves a key exists with the right placeholders; it cannot tell a good translation from a plausible one. The domain terms, the flipped arrows and the plural approximation are listed there |
| ~~#435b~~ | **DONE.** 806 strings across 70 files extracted, 55 dead `en.json` keys removed, `packages/frontend` joined `OWNERS` in the last commit. Residual: the `Error`-message surface above, and the four shapes A cannot decide. Its 9,000+ new translated values want the same native review #486 asks for |
| #436 | Per-locale CLDR plural categories, plus the parity check that has to move with them |
| #437 | The remaining `@mercaria/ui` copy maps listed above, on the mechanism #437 landed |
