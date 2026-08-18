# Arabic review pack (#486)

Generated from `2fa1b207 on 2026-08-18`. Every number below is derived; none is typed by hand.

```bash
bun scripts/extract-arabic-review.mjs            # the counts
bun scripts/extract-arabic-review.mjs --markdown # this document
bun scripts/extract-arabic-review.mjs --json     # the same data, for tooling
```

**This file is GENERATED, so it goes stale silently.** Its inputs are the two `ar.json`/
`en.json` bundles and every `.ts`/`.tsx` under `packages/dashboard` and `packages/pos`. When
any of those move, this document keeps asserting the old counts and **nothing in a diff or a
gate can see it** — the file is unchanged because the file is unchanged; what moved is what it
describes. One command answers it:

```bash
diff <(grep -v '^Generated from' docs/i18n/arabic-review-486.md) \
     <(bun scripts/extract-arabic-review.mjs --markdown | grep -v '^Generated from') \
  && echo 'not stale'
```

**Arabic in a markdown table bidi-scrambles against the Latin key beside it.** This file is
the archival, diffable copy; read the published pack instead if one was shared with you.

## What you are NOT being asked

Read this before anything else — three of them would otherwise waste your time or,
worse, produce copy that cannot be landed.

1. **You are not being asked to supply Arabic plural forms.** These bundles carry
   `one` and `other`; Arabic selects six categories. The missing forms are known,
   deliberate and owned by #436, which needs a runtime pluralizer and a parity-guard
   change to land together. Forms written now could not be shipped. Section 3 exists
   so those strings are not *approved*, not so they are filled in.
2. **You are not being asked whether Arabic is ready to ship.** It is not (#429
   item 2): nothing has rendered on a device or in a foregrounded tab. An approved
   section 2 does not mean Arabic is done.
3. **You are not being asked to review the storefront.** This pack is
   `packages/dashboard` and `packages/pos` only — what #434 shipped. The storefront
   and `@mercaria/ui` got Arabic under #396/#397 and are a separate review.
4. **You are not being asked to edit files.** Answers go back as comments; every
   change is a separate PR with its own reviewer.

## The numbers, and how they were derived

| package | keys | 1. native read | 2. plural (do not touch) | 3. interpolated | 4. Latin by design | excluded |
|---|---|---|---|---|---|---|
| `dashboard` | 1117 | 1005 | 22 | 56 | 27 | 7 |
| `pos` | 135 | 124 | 5 | 3 | 1 | 2 |
| **total** | **1252** | **1129** | **27** | **59** | **28** | **9** |

**Keys** are bundle leaves with a plural object counted as ONE key, because splitting
it into `key.one`/`key.other` makes the two halves look like ordinary strings — which is
exactly the reading that gets them approved. The five columns partition the bundle
exactly; the script throws if they do not.

**#486's own figures were 1,088 and 140, from #434.** The bundles have drifted since
(POS is *down* five). If you meet a different total somewhere, that is why.

**Screens** come from call sites, in two tiers, reported per string:

| package | resolved by `t()` call | by key literal only | unplaced |
|---|---|---|---|
| `dashboard` | 833 | 284 | 0 |
| `pos` | 120 | 15 | 0 |

A `t("literal")` site is the render position. A bare key literal is the file declaring a
key map whose use site the parser cannot follow — the screen shown is then where the key
is *declared*. **Unplaced is zero for both packages**, which is the check that this pack
is not silently short: the i18n guard independently refuses an unreferenced key, so a key
this script could not place would be its own blind spot rather than dead copy.

## 1. Start here — twelve terms and three choices

These are the highest-value hour in the pack. Each is a specific question with the
alternative already considered, and each affects every screen the term appears on.

### The twelve domain terms

| term | chosen | alternative considered | appearances | reachable from |
|---|---|---|---|---|
| product feed | خلاصة المنتجات | موجز / تغذية | 4 | /channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/onboarding/[sessionId] |
| variant | متغيّر | التكوين (the storefront's word for configuration) | 21 | (component) components/register/VariantPickerSheet.tsx, /, /channels/[connectionId], /products/[id], /products/new, /products/wizard/[draftId] |
| register (the till) | الصندوق | نقطة البيع (used for the channel name) | 8 | /, /+not-found, /_layout, /cart, /charge, /store-setup |
| tender | طريقة الدفع | — | 1 | /charge |
| payouts | التحويلات المالية | المدفوعات (collides with payments) | 8 | /channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/onboarding/[sessionId], /settings/payments |
| webhooks | Webhooks | خطافات الويب | 4 | /channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/onboarding/[sessionId] |
| charge (verb) | تحصيل | — | 6 | /, /charge, /settings/plan, /settings/tax |
| combination (wizard) | تركيبة | تكوين for a canonical configuration | 10 | /products/wizard/[draftId] |
| collection | مجموعة | — | 12 | /channels/[connectionId], /collections |
| fulfilment | التنفيذ | — | 3 | /channels/[connectionId], /channels/feeds/[configurationId], /orders/[id] |
| pickup / collection | الاستلام | — | 10 | /orders/[id] |
| override (handover) | تجاوز | — | 4 | /orders/[id], /products/wizard/[draftId] |

**Appearances is how many strings contain the chosen Arabic term**, so a term with a
high count and a wrong word is a wide change. A count of zero means the term did not
appear verbatim — it may still be there inflected, which is itself worth a look.

**"Reachable from" is not "appears on".** A string rendered by a SHARED component lists
every screen that mounts it — `channels.webhooks.register` lives in one file
(`components/channels/channel-presentation.tsx`) that four channel screens import, so it is
listed under all four. That is the useful reading: changing it changes four screens.

### The three RTL authoring choices

**Arrow direction is FLIPPED**

`channels.direction.pull` reads `منصّتك ← Mercaria`. The bidi algorithm does not mirror arrow glyphs, so in an RTL run "forward" is leftward. Same for the `WooCommerce ← الإعدادات ← …` breadcrumb.

> Does the flipped arrow read as "from Mercaria to your platform" to a native reader?

**`channels.andJoin` is `" و "` — spaced both sides, which is NOT idiomatic**

The waw normally attaches to the following word. It is spaced because the joined values are raw Latin identifiers (#485).

> Is the spaced waw the right compromise beside Latin text, or worse than attaching it?

**Example values stay Latin, following `ru`/`ja`**

Coupon codes, `Acme Supply Co.`, URLs and CSV column names stay Latin; names, phones and titles are localized. The phone example `+971 50 123 4567` is an arbitrary Gulf pick.

> Is `+971` the right market to exemplify, and should the company name be localized?

## 2. Needs a native read

The ordinary case: does this say what it means, in Arabic, on this screen. Grouped by screen, because tone and length depend on where a string sits.

### `dashboard` — 1005 strings

<details><summary><code>(component) components/catalog-authoring/CanonicalReferenceField.tsx</code> — 3</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.canonical.searchBrandPlaceholder` | Search brands | ابحث في العلامات التجارية `components/catalog-authoring/CanonicalReferenceField.tsx` |
| `products.wizard.canonical.selectedRef` | Selected | المختار `components/catalog-authoring/CanonicalReferenceField.tsx` |
| `products.wizard.canonical.clearRef` | Clear | مسح `components/catalog-authoring/CanonicalReferenceField.tsx` |

</details>

<details><summary><code>(component) components/catalog-authoring/SchemaField.tsx</code> — 8</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.fields.required` | Required | مطلوب `components/catalog-authoring/SchemaField.tsx` |
| `products.wizard.fields.recommended` | Recommended | موصى به `components/catalog-authoring/SchemaField.tsx` |
| `products.wizard.fields.addValue` | Add another value | إضافة قيمة أخرى `components/catalog-authoring/SchemaField.tsx` |
| `products.wizard.fields.removeValue` | Remove this value | إزالة هذه القيمة `components/catalog-authoring/SchemaField.tsx` |
| `products.wizard.fields.unitLabel` | Unit | الوحدة `components/catalog-authoring/SchemaField.tsx` |
| `products.wizard.fields.unsupportedEntry` | This stored value no longer fits the field. Review the product type upgrade. | لم تعد هذه القيمة المخزَّنة تناسب الحقل. راجع ترقية نوع المنتج. `components/catalog-authoring/SchemaField.tsx` |
| `products.wizard.fields.yes` | Yes | نعم `components/catalog-authoring/SchemaField.tsx` |
| `products.wizard.fields.no` | No | لا `components/catalog-authoring/SchemaField.tsx` |

</details>

<details><summary><code>(component) components/catalog-authoring/SchemaField.tsx, /products/wizard/[draftId]</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.values.choose` | Choose a value | اختر قيمة `components/catalog-authoring/SchemaField.tsx` +1 |

</details>

<details><summary><code>(component) components/catalog-authoring/ValuePicker.tsx</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.values.filterPlaceholder` | Filter values | تصفية القيم `components/catalog-authoring/ValuePicker.tsx` |
| `products.wizard.values.noMatches` | No value matched. | لم تطابق أي قيمة. `components/catalog-authoring/ValuePicker.tsx` |

</details>

<details><summary><code>(component) components/catalog-authoring/ValuePicker.tsx, /channels/[connectionId], /channels/onboarding/[sessionId], /products/new</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.cancel` | Cancel | إلغاء `app/(app)/channels/[connectionId].tsx` +3 |

</details>

<details><summary><code>(component) components/shell/nav-items.ts</code> — 4</summary>

| key | English | Arabic file |
|---|---|---|---|
| `nav.channels` | Sales channels | قنوات البيع `components/shell/nav-items.ts` |
| `nav.orders` | Orders | الطلبات `components/shell/nav-items.ts` |
| `nav.products` | Products | المنتجات `components/shell/nav-items.ts` |
| `nav.settings` | Settings | الإعدادات `components/shell/nav-items.ts` |

</details>

<details><summary><code>(component) lib/authoring/labels.ts</code> — 15</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.steps.pricing` | Price and stock | السعر والمخزون `lib/authoring/labels.ts` |
| `products.wizard.steps.review` | Review | المراجعة `lib/authoring/labels.ts` |
| `products.wizard.fields.optional` | Optional | اختياري `lib/authoring/labels.ts` |
| `products.wizard.fields.hidden` | Not asked | غير مطلوب `lib/authoring/labels.ts` |
| `products.wizard.fields.forbidden` | Not allowed here | غير مسموح هنا `lib/authoring/labels.ts` |
| `products.wizard.axes.width` | Width | العرض `lib/authoring/labels.ts` |
| `products.wizard.axes.height` | Height | الارتفاع `lib/authoring/labels.ts` |
| `products.wizard.axes.depth` | Depth | العمق `lib/authoring/labels.ts` |
| `products.wizard.axes.diagonal` | Diagonal | القطر `lib/authoring/labels.ts` |
| `products.wizard.axes.circumference` | Circumference | المحيط `lib/authoring/labels.ts` |
| `products.wizard.axes.waist` | Waist | الخصر `lib/authoring/labels.ts` |
| `products.wizard.axes.inseam` | Inseam | طول الساق الداخلي `lib/authoring/labels.ts` |
| `products.wizard.axes.chest` | Chest | الصدر `lib/authoring/labels.ts` |
| `products.wizard.axes.sleeve` | Sleeve | الكم `lib/authoring/labels.ts` |
| `products.wizard.axes.neck` | Neck | الرقبة `lib/authoring/labels.ts` |

</details>

<details><summary><code>/</code> — 23</summary>

| key | English | Arabic file |
|---|---|---|---|
| `home.documentTitle` | Dashboard \| Mercaria | لوحة التحكم \| Mercaria `app/(app)/index.tsx` |
| `home.inventory.noneLow` | No tracked variants are low on stock. | لا يوجد متغيّر متتبَّع منخفض المخزون. `app/(app)/index.tsx` |
| `home.inventory.title` | Inventory | المخزون `app/(app)/index.tsx` |
| `home.orderStatus.cancelled` | Cancelled | ملغى `app/(app)/index.tsx` |
| `home.orderStatus.delivered` | Delivered | تم التسليم `app/(app)/index.tsx` |
| `home.orderStatus.paid` | Paid | مدفوع `app/(app)/index.tsx` |
| `home.orderStatus.partiallyRefunded` | Partially refunded | مُسترد جزئيًا `app/(app)/index.tsx` |
| `home.orderStatus.pendingPayment` | Pending payment | بانتظار الدفع `app/(app)/index.tsx` |
| `home.orderStatus.processing` | Processing | قيد المعالجة `app/(app)/index.tsx` |
| `home.orderStatus.refunded` | Refunded | مُسترد `app/(app)/index.tsx` |
| `home.orderStatus.shipped` | Shipped | تم الشحن `app/(app)/index.tsx` |
| `home.reportsError` | Couldn't load reports | تعذّر تحميل التقارير `app/(app)/index.tsx` |
| `home.sales.empty` | No sales in this period yet. | لا توجد مبيعات في هذه الفترة بعد. `app/(app)/index.tsx` |
| `home.sales.title` | Sales (last period) | المبيعات (الفترة الأخيرة) `app/(app)/index.tsx` |
| `home.stats.averageOrder` | Avg order | متوسط الطلب `app/(app)/index.tsx` |
| `home.stats.paidOrders` | Paid orders | الطلبات المدفوعة `app/(app)/index.tsx` |
| `home.stats.refunds` | Refunds | المبالغ المستردة `app/(app)/index.tsx` |
| `home.stats.revenue` | Revenue | الإيرادات `app/(app)/index.tsx` |
| `home.statusBreakdown.empty` | No orders yet. | لا توجد طلبات بعد. `app/(app)/index.tsx` |
| `home.statusBreakdown.title` | Orders by status | الطلبات حسب الحالة `app/(app)/index.tsx` |
| `home.subtitle` | Your store at a glance | متجرك في لمحة `app/(app)/index.tsx` |
| `home.topProducts.empty` | No sales yet. | لا توجد مبيعات بعد. `app/(app)/index.tsx` |
| `home.topProducts.title` | Top products | أفضل المنتجات `app/(app)/index.tsx` |

</details>

<details><summary><code>/_layout</code> — 6</summary>

| key | English | Arabic file |
|---|---|---|---|
| `auth.signInAction` | Sign in | تسجيل الدخول `components/AuthGate.tsx` |
| `auth.signInBody` | Sign in with your Oxy account to manage your store — products, orders, inventory, customers, discounts and reports. | سجّل الدخول بحساب Oxy لإدارة متجرك — المنتجات والطلبات والمخزون والعملاء والخصومات والتقارير. `components/AuthGate.tsx` |
| `common.retry` | Try again | إعادة المحاولة `components/error-boundary.tsx` |
| `errors.boundaryBody` | An unexpected error occurred. You can try again, and if the problem persists, our team has been notified. | حدث خطأ غير متوقع. يمكنك إعادة المحاولة، وإذا استمرت المشكلة فقد أُبلغ فريقنا بها. `components/error-boundary.tsx` |
| `nav.collapseSidebar` | Collapse sidebar | طيّ الشريط الجانبي `components/shell/Sidebar.tsx` |
| `nav.expandSidebar` | Expand sidebar | توسيع الشريط الجانبي `components/shell/Sidebar.tsx` |

</details>

<details><summary><code>/_layout, /products/wizard</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.somethingWentWrong` | Something went wrong | حدث خطأ ما `app/(app)/products/wizard/index.tsx` +1 |

</details>

<details><summary><code>/, /_layout</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `nav.dashboard` | Dashboard | لوحة التحكم `app/(app)/index.tsx` +1 |

</details>

<details><summary><code>/, /channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/feeds/new, /channels/onboarding/[sessionId], /collections, /customers, /customers/[id], /discounts, /orders, /orders/[id], /products, /products/[id], /products/new, /products/wizard, /products/wizard/[draftId], /settings, /settings/locations, /settings/members, /settings/payments, /settings/plan, /settings/policies, /settings/store, /settings/tax</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.noAccess` | No access | لا يوجد وصول `components/shell/RequireStore.tsx` |
| `common.noAccessBody` | You don't have permission to view this area for the active store. | ليس لديك إذن لعرض هذا القسم للمتجر النشط. `components/shell/RequireStore.tsx` |

</details>

<details><summary><code>/, /channels, /channels/[connectionId], /collections, /customers, /customers/[id], /discounts, /orders, /orders/[id], /products, /products/[id], /products/wizard, /settings/locations, /settings/members, /settings/payments, /settings/plan, /settings/policies, /settings/store, /settings/tax, /stores</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.pleaseTryAgain` | Please try again. | يرجى المحاولة مرة أخرى. `app/(app)/channels/[connectionId].tsx` +19 |

</details>

<details><summary><code>/, /channels, /collections, /customers, /discounts, /orders, /products, /settings</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `stores.selectStore` | Select store | اختيار المتجر `components/shell/StoreSwitcher.tsx` |
| `stores.switch` | Switch store | تبديل المتجر `components/shell/StoreSwitcher.tsx` |

</details>

<details><summary><code>/+not-found</code> — 4</summary>

| key | English | Arabic file |
|---|---|---|---|
| `errors.notFoundAction` | Go to the dashboard | الذهاب إلى لوحة التحكم `app/+not-found.tsx` |
| `errors.notFoundBody` | This screen doesn't exist. | هذه الشاشة غير موجودة. `app/+not-found.tsx` |
| `errors.notFoundDocumentTitle` | 404 - Not Found \| Mercaria Dashboard | 404 - غير موجود \| Mercaria Dashboard `app/+not-found.tsx` |
| `errors.notFoundHeading` | Oops! | عذرًا! `app/+not-found.tsx` |

</details>

<details><summary><code>/channels</code> — 27</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.addChannel` | Add a channel | إضافة قناة `app/(app)/channels/index.tsx` |
| `channels.andJoin` |  and  |  و `app/(app)/channels/index.tsx` |
| `channels.availability.notConfigured` | Not configured here | غير مُعد هنا `app/(app)/channels/index.tsx` |
| `channels.availability.notImplemented` | Not available yet | غير متاح بعد `app/(app)/channels/index.tsx` |
| `channels.connect` | Connect | ربط `app/(app)/channels/index.tsx` |
| `channels.documentTitle` | Sales channels \| Mercaria Dashboard | قنوات البيع \| Mercaria Dashboard `app/(app)/channels/index.tsx` |
| `channels.empty.body` | Connect a store or a product feed below to bring an existing catalog in. | اربط متجرًا أو خلاصة منتجات أدناه لجلب كتالوج موجود. `app/(app)/channels/index.tsx` |
| `channels.empty.title` | Only your Mercaria catalog | كتالوج Mercaria الخاص بك فقط `app/(app)/channels/index.tsx` |
| `channels.loadFailed` | Couldn't load channels | تعذّر تحميل القنوات `app/(app)/channels/index.tsx` |
| `channels.never` | never | أبدًا `app/(app)/channels/index.tsx` |
| `channels.neverSynced` | Never synced | لم تتم المزامنة أبدًا `app/(app)/channels/index.tsx` |
| `channels.pauseScope.fetch` | importing | الاستيراد `app/(app)/channels/index.tsx` |
| `channels.pauseScope.publication` | publishing | النشر `app/(app)/channels/index.tsx` |
| `channels.readiness.cardPaymentsOff` | Card payments are off for this deployment | مدفوعات البطاقات معطّلة في هذه النسخة `app/(app)/channels/index.tsx` |
| `channels.readiness.catalog` | Catalog | الكتالوج `app/(app)/channels/index.tsx` |
| `channels.readiness.neverSynced` | never synced | لم تتم المزامنة أبدًا `app/(app)/channels/index.tsx` |
| `channels.readiness.noChannelConnected` | No channel connected | لا توجد قناة مرتبطة `app/(app)/channels/index.tsx` |
| `channels.readiness.notReady` | Not selling on Mercaria yet | لا تبيع على Mercaria بعد `app/(app)/channels/index.tsx` |
| `channels.readiness.payouts` | Payouts | التحويلات المالية `app/(app)/channels/index.tsx` |
| `channels.readiness.payoutsNotSetUp` | Not set up | غير مُعدة `app/(app)/channels/index.tsx` |
| `channels.readiness.payoutsSetUp` | Set up | مُعدة `app/(app)/channels/index.tsx` |
| `channels.readiness.ready` | Ready to sell on Mercaria | جاهز للبيع على Mercaria `app/(app)/channels/index.tsx` |
| `channels.state.connected` | Connected | مرتبطة `app/(app)/channels/index.tsx` |
| `channels.subtitle` | Every way your products reach Mercaria — connected stores, product feeds and your own catalog | كل الطرق التي تصل بها منتجاتك إلى Mercaria — المتاجر المرتبطة وخلاصات المنتجات وكتالوجك الخاص `app/(app)/channels/index.tsx` |
| `channels.title` | Sales channels | قنوات البيع `app/(app)/channels/index.tsx` |
| `channels.unscheduled` | unscheduled | غير مجدولة `app/(app)/channels/index.tsx` |
| `channels.yourChannels` | Your channels | قنواتك `app/(app)/channels/index.tsx` |

</details>

<details><summary><code>/channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/onboarding/[sessionId]</code> — 58</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.badge.comparisonOnly` | Comparison only | للمقارنة فقط `components/channels/channel-presentation.tsx` |
| `channels.badge.sellsOnMercaria` | Sells on Mercaria | يبيع على Mercaria `components/channels/channel-presentation.tsx` |
| `channels.coverage.doesNotSyncHeading` | Does not sync | لا يزامن `components/channels/channel-presentation.tsx` |
| `channels.coverage.doesNotSyncLabel` | Does not sync:  | لا يزامن:  `components/channels/channel-presentation.tsx` |
| `channels.coverage.nothing` | nothing | لا شيء `components/channels/channel-presentation.tsx` |
| `channels.coverage.syncsHeading` | Syncs | يزامن `components/channels/channel-presentation.tsx` |
| `channels.coverage.syncsLabel` | Syncs:  | يزامن:  `components/channels/channel-presentation.tsx` |
| `channels.direction.bothWays` | both ways | في الاتجاهين `components/channels/channel-presentation.tsx` |
| `channels.direction.pull` | your platform → Mercaria | منصّتك ← Mercaria `components/channels/channel-presentation.tsx` |
| `channels.direction.push` | Mercaria → your platform | Mercaria ← منصّتك `components/channels/channel-presentation.tsx` |
| `channels.entity.collections` | Collections | المجموعات `components/channels/channel-presentation.tsx` |
| `channels.entity.customers` | Customers | العملاء `components/channels/channel-presentation.tsx` |
| `channels.entity.discounts` | Discounts | الخصومات `components/channels/channel-presentation.tsx` |
| `channels.entity.giftCards` | Gift cards | بطاقات الهدايا `components/channels/channel-presentation.tsx` |
| `channels.entity.inventory` | Stock | المخزون `components/channels/channel-presentation.tsx` |
| `channels.entity.productReviews` | Reviews | التقييمات `components/channels/channel-presentation.tsx` |
| `channels.entity.refunds` | Refunds | المبالغ المستردة `components/channels/channel-presentation.tsx` |
| `channels.entity.shippingRates` | Delivery rates | أسعار التوصيل `components/channels/channel-presentation.tsx` |
| `channels.entity.taxRates` | Tax rates | معدلات الضريبة `components/channels/channel-presentation.tsx` |
| `channels.entityAbsence.channelNotImplemented` | Mercaria has no connector for this platform yet. | لا تملك Mercaria موصّلًا لهذه المنصّة بعد. `components/channels/channel-presentation.tsx` |
| `channels.entityAbsence.channelTransportsProductsOnly` | A product feed is a file of products and carries nothing else. | خلاصة المنتجات هي ملف منتجات ولا تحمل أي شيء آخر. `components/channels/channel-presentation.tsx` |
| `channels.entityAbsence.importedOnlyAsPartOfAnOrder` | No list is imported. What appears comes only from the orders that are. | لا تُستورد أي قائمة. ما يظهر يأتي فقط من الطلبات المستوردة. `components/channels/channel-presentation.tsx` |
| `channels.entityAbsence.nativeCatalogIsNotASync` | Nothing is imported — you edit this catalog in Mercaria. | لا يُستورد شيء — أنت تحرّر هذا الكتالوج في Mercaria. `components/channels/channel-presentation.tsx` |
| `channels.entityAbsence.notBuiltForThisChannel` | Mercaria does not exchange this with your platform. | لا تتبادل Mercaria هذا مع منصّتك. `components/channels/channel-presentation.tsx` |
| `channels.entityAbsence.notModelledByMercaria` | Mercaria has no record of this kind for it to arrive into. | لا تملك Mercaria سجلًا من هذا النوع ليصل إليه. `components/channels/channel-presentation.tsx` |
| `channels.entityAbsence.ownedByAnotherSystem` | Handled elsewhere in Mercaria rather than imported from your platform. | يُدار في مكان آخر داخل Mercaria بدلًا من استيراده من منصّتك. `components/channels/channel-presentation.tsx` |
| `channels.entityCaveat.breakdownOnlyOnImportedOrders` | Each imported order shows the lines it was charged, so the totals add up. The rule behind them is not created in Mercaria, so you cannot edit or reuse it here. | يعرض كل طلب مستورد البنود التي حُسبت عليه، فتتطابق الإجماليات. أما القاعدة وراءها فلا تُنشأ في Mercaria، لذا لا يمكنك تعديلها أو إعادة استخدامها هنا. `components/channels/channel-presentation.tsx` |
| `channels.entityCaveat.membershipOnlyThroughAMapping` | Your platform's collections are not created in Mercaria. Products join the Mercaria collections you map them to. | لا تُنشأ مجموعات منصّتك في Mercaria. تنضم المنتجات إلى مجموعات Mercaria التي تعيّنها إليها. `components/channels/channel-presentation.tsx` |
| `channels.orderHorizon.notSynced` | Orders are not exchanged on this channel, in either direction. | لا تُتبادل الطلبات على هذه القناة، في أي من الاتجاهين. `components/channels/channel-presentation.tsx` |
| `channels.orderHorizon.unknown` | Mercaria cannot tell how far back this connection's orders reach. | لا تستطيع Mercaria تحديد إلى أي مدى ترجع طلبات هذا الاتصال. `components/channels/channel-presentation.tsx` |
| `channels.readinessBlocker.noConnectedChannel` | Nothing is supplying a catalog yet — connect a channel or add a product. | لا شيء يزوّدك بكتالوج بعد — اربط قناة أو أضف منتجًا. `components/channels/channel-presentation.tsx` |
| `channels.readinessBlocker.noNativeCheckoutChannel` | Your connected channels list products for comparison but cannot sell through Mercaria checkout. Connect a store, or add products directly. | قنواتك المرتبطة تعرض المنتجات للمقارنة لكنها لا تستطيع البيع عبر إتمام الشراء في Mercaria. اربط متجرًا، أو أضف منتجات مباشرةً. `components/channels/channel-presentation.tsx` |
| `channels.readinessBlocker.noPublishableListing` | No active products — buyers have nothing to add to a cart. | لا توجد منتجات نشطة — ليس لدى المشترين ما يضيفونه إلى السلة. `components/channels/channel-presentation.tsx` |
| `channels.readinessBlocker.noSuccessfulSync` | A channel is connected but has not completed a sync yet. | توجد قناة مرتبطة لكنها لم تكمل أي مزامنة بعد. `components/channels/channel-presentation.tsx` |
| `channels.readinessBlocker.paymentsNotReady` | Payouts are not set up, so orders cannot be taken. | التحويلات المالية غير مُعدة، لذا لا يمكن استقبال الطلبات. `components/channels/channel-presentation.tsx` |
| `channels.state.needsAttention` | Needs attention | تحتاج إلى انتباه `app/(app)/channels/[connectionId].tsx` +1 |
| `channels.state.notConnected` | Not connected | غير مرتبطة `components/channels/channel-presentation.tsx` |
| `channels.state.paused` | Paused | موقوفة مؤقتًا `components/channels/channel-presentation.tsx` |
| `channels.type.native` | Mercaria catalog | كتالوج Mercaria `components/channels/channel-presentation.tsx` |
| `channels.type.productFeed` | Product feed | خلاصة منتجات `components/channels/channel-presentation.tsx` |
| `channels.type.woocommercePlugin` | WooCommerce plugin | إضافة WooCommerce `components/channels/channel-presentation.tsx` |
| `channels.webhookFailureReason.permissionDenied` | the connection's permissions do not cover it | أذونات الاتصال لا تغطيه `components/channels/channel-presentation.tsx` |
| `channels.webhookFailureReason.platformError` | the platform returned an error | أعادت المنصّة خطأً `components/channels/channel-presentation.tsx` |
| `channels.webhookFailureReason.rateLimited` | the platform was rate-limiting | كانت المنصّة تحدّ من المعدل `components/channels/channel-presentation.tsx` |
| `channels.webhookFailureReason.topicNotSupported` | the platform does not offer it | المنصّة لا توفّره `components/channels/channel-presentation.tsx` |
| `channels.webhookFailureReason.transportError` | the platform could not be reached | تعذّر الوصول إلى المنصّة `components/channels/channel-presentation.tsx` |
| `channels.webhookFailureReason.unexpectedResponse` | the platform's reply could not be read | تعذّرت قراءة رد المنصّة `components/channels/channel-presentation.tsx` |
| `channels.webhooks.bringForward` | You can bring that forward now instead. | يمكنك تقديم ذلك الآن بدلًا من الانتظار. `components/channels/channel-presentation.tsx` |
| `channels.webhooks.causeIncomplete` | Mercaria could not complete the registration. Reconnect the channel if this keeps happening. | تعذّر على Mercaria إكمال التسجيل. أعد ربط القناة إذا تكرر هذا. `components/channels/channel-presentation.tsx` |
| `channels.webhooks.dueNow` | due now | مستحق الآن `components/channels/channel-presentation.tsx` |
| `channels.webhooks.healthyHeadline` | Changes arrive as they happen | التغييرات تصل فور حدوثها `components/channels/channel-presentation.tsx` |
| `channels.webhooks.refusedHeadline` | Some updates will not arrive | بعض التحديثات لن تصل `components/channels/channel-presentation.tsx` |
| `channels.webhooks.register` | Register webhooks | تسجيل Webhooks `components/channels/channel-presentation.tsx` |
| `channels.webhooks.registerAgain` | Register webhooks again | تسجيل Webhooks من جديد `components/channels/channel-presentation.tsx` |
| `channels.webhooks.retryingHeadline` | Some updates aren't arriving yet | بعض التحديثات لا تصل بعد `components/channels/channel-presentation.tsx` |
| `channels.webhooks.stoppedHeadline` | Some updates aren't arriving, and Mercaria has stopped retrying | بعض التحديثات لا تصل، وقد توقفت Mercaria عن إعادة المحاولة `components/channels/channel-presentation.tsx` |
| `channels.webhooks.tryNow` | Try now | جرّب الآن `components/channels/channel-presentation.tsx` |
| `channels.webhooks.unregisteredHeadline` | Real-time updates aren't registered yet | التحديثات الفورية غير مسجّلة بعد `components/channels/channel-presentation.tsx` |

</details>

<details><summary><code>/channels/[connectionId]</code> — 136</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.collectionMapping.dontMap` | Don’t map this one | لا تعيّن هذه `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.fixMapping` | Fix mapping | إصلاح التعيين `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.loadFailed` | Couldn’t load this channel’s collections. | تعذّر تحميل مجموعات هذه القناة. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.map` | Map | تعيين `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.noManualCollections` | This store has no manual collections yet. Create one first — an automated collection fills itself from its own rules and cannot receive a channel mapping. | لا يملك هذا المتجر مجموعات يدوية بعد. أنشئ واحدة أولًا — فالمجموعة التلقائية تملأ نفسها من قواعدها ولا يمكنها استقبال تعيين قناة. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.noun.category.plural` | categories | فئات `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.noun.category.singular` | category | فئة `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.noun.collection.plural` | collections | مجموعات `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.noun.collection.singular` | collection | مجموعة `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.pickBody` | Only manual collections can be mapped. An automated collection decides its own membership from its rules. | المجموعات اليدوية فقط هي التي يمكن تعيينها. المجموعة التلقائية تحدد عضويتها بنفسها من قواعدها. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.pickTitle` | Map to a Mercaria collection | التعيين إلى مجموعة في Mercaria `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.removeMapping` | Remove this mapping | إزالة هذا التعيين `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.state.externalMissing` | This no longer exists on the channel, so nothing will be mapped through it. Remove the mapping, or recreate it on the channel. | لم يعد هذا موجودًا على القناة، لذا لن يُعيَّن شيء من خلاله. أزل التعيين، أو أعد إنشاءه على القناة. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.state.targetAutomated` | That Mercaria collection fills itself from its own rules, so a channel mapping would be added and removed on every sync. Pick a manual collection instead. | مجموعة Mercaria تلك تملأ نفسها من قواعدها، لذا فإن تعيين القناة سيُضاف ويُزال مع كل مزامنة. اختر مجموعة يدوية بدلًا من ذلك. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.state.targetMissing` | The Mercaria collection was deleted. Products keep importing; they just land in no collection. Pick another one. | حُذفت مجموعة Mercaria. تستمر المنتجات في الاستيراد؛ لكنها لا تصل إلى أي مجموعة. اختر مجموعة أخرى. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.title` | Collection mapping | تعيين المجموعات `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.unavailable.disconnected` | This channel is disconnected, so its collections cannot be read. Reconnect it to pick from the live list. | هذه القناة مفصولة، لذا لا يمكن قراءة مجموعاتها. أعد ربطها للاختيار من القائمة الحية. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.unavailable.platformUnavailable` | The channel could not be reached just now, so its collections are not shown. Your existing mapping is unaffected. | تعذّر الوصول إلى القناة الآن، لذا لا تظهر مجموعاتها. تعيينك الحالي غير متأثر. `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.unavailable.pushInConnection` | This channel pushes into Mercaria, so Mercaria holds no credentials to read its collections back. Your existing mapping is shown below and can still be edited. | هذه القناة تدفع البيانات إلى Mercaria، لذا لا تملك Mercaria بيانات اعتماد لقراءة مجموعاتها. تعيينك الحالي معروض أدناه ولا يزال قابلًا للتعديل. `components/channels/CollectionMapping.tsx` |
| `channels.disconnect.action` | Disconnect channel | فصل القناة `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.confirmAction` | Disconnect | فصل `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.intro` | Choose what happens to the products this channel imported. Your price history and anything another channel imported are never touched. | اختر ما يحدث للمنتجات التي استوردتها هذه القناة. لا يُمَس أبدًا سجل أسعارك ولا أي شيء استوردته قناة أخرى. `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.policy.archiveListings` | Archive | أرشفة `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.policy.keepListings` | Keep products | الإبقاء على المنتجات `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.policy.unpublishListings` | Unpublish | إلغاء النشر `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.policyHelp.archiveListings` | Stop syncing and archive this channel's products. Sold and moderated products are left alone. | إيقاف المزامنة وأرشفة منتجات هذه القناة. تُترك المنتجات المباعة والخاضعة للإشراف كما هي. `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.policyHelp.keepListings` | Stop syncing and leave every product exactly as it is — still on sale, and now yours to edit in Mercaria. | إيقاف المزامنة وترك كل منتج كما هو تمامًا — ما زال معروضًا للبيع، وأصبح الآن لك لتعدّله في Mercaria. `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.policyHelp.unpublishListings` | Stop syncing and take this channel's products off sale, keeping them as drafts you can republish. | إيقاف المزامنة وسحب منتجات هذه القناة من البيع، مع الاحتفاظ بها كمسودات يمكنك إعادة نشرها. `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.title` | Disconnect | فصل `app/(app)/channels/[connectionId].tsx` |
| `channels.entity.orders` | Orders | الطلبات `app/(app)/channels/[connectionId].tsx` |
| `channels.entity.products` | Products | المنتجات `app/(app)/channels/[connectionId].tsx` |
| `channels.history.empty` | No syncs yet | لا توجد عمليات مزامنة بعد `app/(app)/channels/[connectionId].tsx` |
| `channels.history.loadFailed` | Couldn't load the history | تعذّر تحميل السجل `app/(app)/channels/[connectionId].tsx` |
| `channels.history.title` | Sync history | سجل المزامنة `app/(app)/channels/[connectionId].tsx` |
| `channels.history.updatedNote` | “Updated” counts every product examined, not only the ones that differed. | «المُحدَّث» يحصي كل منتج جرى فحصه، وليس المنتجات المختلفة فقط. `app/(app)/channels/[connectionId].tsx` |
| `channels.import.blockedDirection` | Set Products to Pull or Both above, then save — saving starts the first import on its own. | اضبط المنتجات على سحب أو كليهما أعلاه، ثم احفظ — فالحفظ يبدأ أول استيراد من تلقاء نفسه. `app/(app)/channels/[connectionId].tsx` |
| `channels.import.blockedDisconnected` | Reconnect this channel before importing — its stored credential was cleared when it was disconnected. | أعد ربط هذه القناة قبل الاستيراد — فقد مُسحت بيانات اعتمادها المخزَّنة عند فصلها. `app/(app)/channels/[connectionId].tsx` |
| `channels.import.body` | Reads every product again and updates what has changed. Safe to run more than once. | يقرأ كل منتج مرة أخرى ويحدّث ما تغيّر. آمن للتشغيل أكثر من مرة. `app/(app)/channels/[connectionId].tsx` |
| `channels.import.bodyPaused` | Reads every product again and updates what has changed. Importing is paused for scheduled syncs, but this one runs now. | يقرأ كل منتج مرة أخرى ويحدّث ما تغيّر. الاستيراد موقوف مؤقتًا للمزامنات المجدولة، لكن هذه العملية تعمل الآن. `app/(app)/channels/[connectionId].tsx` |
| `channels.import.now` | Sync now | مزامنة الآن `app/(app)/channels/[connectionId].tsx` |
| `channels.import.title` | Import | استيراد `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.apiKeySubject` | API key | مفتاح API `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.body` | Paste a key (and this channel’s connection id) into the Mercaria plugin on your WordPress site. Keys don’t expire — revoke one anytime to cut off access. | الصق مفتاحًا (ومعرّف اتصال هذه القناة) في إضافة Mercaria على موقع WordPress الخاص بك. المفاتيح لا تنتهي صلاحيتها — يمكنك إبطال أي مفتاح في أي وقت لقطع الوصول. `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.connectionId` | Connection id | معرّف الاتصال `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.connectionIdSubject` | connection id | معرّف الاتصال `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.copyNow` | Copy this key now — you won’t be able to see it again. | انسخ هذا المفتاح الآن — لن تتمكن من رؤيته مرة أخرى. `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.empty` | No keys yet. Generate one to connect the plugin. | لا توجد مفاتيح بعد. أنشئ مفتاحًا لربط الإضافة. `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.generate` | Generate key | إنشاء مفتاح `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.generateBody` | Create a long-lived key for this channel. Give it a name so you can recognize it later (e.g. the site it’s used on). | أنشئ مفتاحًا طويل الأمد لهذه القناة. أعطه اسمًا لتتعرّف عليه لاحقًا (مثل الموقع المستخدَم فيه). `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.generateTitle` | Generate API key | إنشاء مفتاح API `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.heading` | Long-lived plugin credentials | بيانات اعتماد الإضافة طويلة الأمد `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.labelField` | Label | التسمية `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.loadFailed` | Couldn’t load API keys. | تعذّر تحميل مفاتيح API. `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.loading` | Loading keys… | جارٍ تحميل المفاتيح… `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.neverUsed` | Never used | لم يُستخدم أبدًا `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.revoke` | Revoke | إبطال `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.revokeConfirmTitle` | Revoke this key? | إبطال هذا المفتاح؟ `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.title` | API keys | مفاتيح API `app/(app)/channels/[connectionId].tsx` |
| `channels.pause.importing` | Pause importing | إيقاف الاستيراد مؤقتًا `app/(app)/channels/[connectionId].tsx` |
| `channels.pause.importingHint` | Stop reading from the platform. What is already imported stays on sale. | أوقف القراءة من المنصّة. ما استُورد بالفعل يبقى معروضًا للبيع. `app/(app)/channels/[connectionId].tsx` |
| `channels.pause.publishing` | Pause publishing | إيقاف النشر مؤقتًا `app/(app)/channels/[connectionId].tsx` |
| `channels.pause.publishingHint` | Keep importing, but stop this channel’s products reaching buyers. | استمر في الاستيراد، لكن أوقف وصول منتجات هذه القناة إلى المشترين. `app/(app)/channels/[connectionId].tsx` |
| `channels.pause.title` | Pause | إيقاف مؤقت `app/(app)/channels/[connectionId].tsx` |
| `channels.recently` | recently | مؤخرًا `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.alreadyIndexed` | Already indexed | مفهرس بالفعل `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.awaitingReview` | Awaiting review | بانتظار المراجعة `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.body` | Nothing is deleted or merged. Where the same product appears twice, Mercaria shows your own store’s listing as the main one and keeps the other’s price history intact. | لا يُحذف شيء ولا يُدمج. وحيث يظهر المنتج نفسه مرتين، تعرض Mercaria إعلان متجرك أنت باعتباره الأساسي وتحتفظ بسجل أسعار الآخر سليمًا. `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.fromThisStore` | From this store | من هذا المتجر `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.gap.channelHasNoDomain` | This channel has no web address to match against. | لا يوجد لهذه القناة عنوان ويب للمطابقة معه. `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.gap.merchantNotClaimed` | This store is not linked to a verified merchant, so there is nothing to match against yet. | هذا المتجر غير مرتبط بتاجر موثّق، لذا لا يوجد ما يُطابق معه بعد. `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.gap.storeNotLinked` | This store is not linked to a merchant profile, so there is nothing to match against yet. | هذا المتجر غير مرتبط بملف تاجر، لذا لا يوجد ما يُطابق معه بعد. `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.gap.storefrontNotMatched` | Mercaria has not indexed this exact shop before, so there is nothing to match against. | لم تفهرس Mercaria هذا المتجر تحديدًا من قبل، لذا لا يوجد ما يُطابق معه. `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.sameProductTwice` | Same product, twice | المنتج نفسه، مرتين `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.title` | Matching your existing catalog | مطابقة كتالوجك الحالي `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.hide` | Hide | إخفاء `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.loadFailed` | Couldn’t load the records this sync refused. | تعذّر تحميل السجلات التي رفضتها هذه المزامنة. `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.none` | No per-record reasons are stored for this sync. | لا تُخزَّن أسباب لكل سجل في هذه المزامنة. `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.reason.databaseRefused` | The database refused the write | رفضت قاعدة البيانات الكتابة `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.reason.duplicateRecord` | Duplicate of a record already imported | نسخة مكررة من سجل مستورد بالفعل `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.reason.refusedByRule` | Refused by a Mercaria rule | مرفوض بقاعدة من قواعد Mercaria `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.reason.unclassified` | Unrecognised failure | فشل غير معروف `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.show` | **one:** Show which record did not land<br>**other:** Show which records did not land | **one:** أظهر السجل الذي لم يصل<br>**other:** أظهر السجلات التي لم تصل `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.subject.inventoryItem` | Inventory item | عنصر مخزون `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.subject.order` | Order | طلب `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.subject.product` | Product | منتج `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.autoPublish` | Auto-publish | النشر التلقائي `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.autoPublishHint` | Publish pulled products immediately. When off, they land as drafts for review. | انشر المنتجات المسحوبة فورًا. عند الإيقاف، تصل كمسودات للمراجعة. `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.documentTitle` | Channel settings \| Mercaria Dashboard | إعدادات القناة \| Mercaria Dashboard `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.inventoryHint` | Stock levels at your synced location. | مستويات المخزون في موقعك المتزامن. `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.inventoryLabel` | Inventory | المخزون `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.keepLocalEdits` | Keep my local edits | احتفظ بتعديلاتي المحلية `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.keepLocalEditsHint` | When on, a field you edited in Mercaria is never overwritten by a later sync. When off, the channel always wins. | عند التفعيل، لا تُستبدل أي حقل عدّلته في Mercaria بمزامنة لاحقة. وعند الإيقاف، تفوز القناة دائمًا. `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.neverSyncedYet` | This channel hasn't synced yet. | لم تتم مزامنة هذه القناة بعد. `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.notFound` | Channel not found | لم يُعثر على القناة `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.notFoundBody` | This connection may have been disconnected. | قد يكون هذا الاتصال قد فُصل. `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.ordersHint` | Orders placed on the external channel. | الطلبات المقدَّمة على القناة الخارجية. `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.productsHint` | The product catalog (titles, images, prices, variants). | كتالوج المنتجات (العناوين والصور والأسعار والمتغيّرات). `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.save` | Save settings | حفظ الإعدادات `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.syncDirections` | Sync directions | اتجاهات المزامنة `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.title` | Channel settings | إعدادات القناة `app/(app)/channels/[connectionId].tsx` |
| `channels.status.disconnected` | Disconnected | مفصولة `app/(app)/channels/[connectionId].tsx` |
| `channels.syncDirection.both` | Both | كلاهما `app/(app)/channels/[connectionId].tsx` |
| `channels.syncDirection.off` | Off | إيقاف `app/(app)/channels/[connectionId].tsx` |
| `channels.syncDirection.pull` | Pull | سحب `app/(app)/channels/[connectionId].tsx` |
| `channels.syncDirection.push` | Push | دفع `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.alreadyInThatState` | Already in that state | في تلك الحالة بالفعل `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.collectionMappingSaveFailed` | Couldn't save the mapping | تعذّر حفظ التعيين `components/channels/CollectionMapping.tsx` |
| `channels.toast.collectionMappingSaved` | Collection mapping saved | تم حفظ تعيين المجموعات `components/channels/CollectionMapping.tsx` |
| `channels.toast.disconnectFailed` | Couldn't disconnect the channel | تعذّر فصل القناة `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.importStartFailed` | Couldn't start the import | تعذّر بدء الاستيراد `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.importStarted` | Import started — it will appear in the history below | بدأ الاستيراد — سيظهر في السجل أدناه `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.keyGenerateFailed` | Couldn't generate the key | تعذّر توليد المفتاح `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.keyGenerated` | API key generated | تم توليد مفتاح API `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.keyLabelRequired` | Give the key a label | أعطِ المفتاح تسمية `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.keyRevokeFailed` | Couldn't revoke the key | تعذّر إبطال المفتاح `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.keyRevoked` | API key revoked | تم إبطال مفتاح API `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.pauseFailed` | Couldn't change the pause state | تعذّر تغيير حالة الإيقاف المؤقت `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.paused` | Paused | موقوف مؤقتًا `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.resumed` | Resumed | تم الاستئناف `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.settingsSaveFailed` | Couldn't save channel settings | تعذّر حفظ إعدادات القناة `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.settingsSaved` | Channel settings saved | تم حفظ إعدادات القناة `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.webhooksRegisterFailed` | Couldn't start webhook registration | تعذّر بدء تسجيل Webhooks `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.webhooksRegistering` | Registering webhooks again | جارٍ تسجيل Webhooks من جديد `app/(app)/channels/[connectionId].tsx` |
| `channels.webhooks.title` | Real-time updates | التحديثات الفورية `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.backfill` | Backfill | إعادة استيراد كاملة `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.product_pull` | Product import | استيراد المنتجات `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.product_push` | Product export | تصدير المنتجات `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.inventory_sync` | Stock sync | مزامنة المخزون `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.order_sync` | Order import | استيراد الطلبات `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.fulfillment_push` | Fulfilment export | تصدير عمليات الشحن `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.ingest` | Products received | منتجات مستلمة `app/(app)/channels/[connectionId].tsx` |
| `channels.run.status.running` | Running | قيد التنفيذ `app/(app)/channels/[connectionId].tsx` |
| `channels.run.status.completed` | Completed | اكتملت `app/(app)/channels/[connectionId].tsx` |
| `channels.run.status.failed` | Failed | فشلت `app/(app)/channels/[connectionId].tsx` |
| `common.done` | Done | تم `app/(app)/channels/[connectionId].tsx` |
| `common.loading` | Loading… | جارٍ التحميل… `app/(app)/channels/[connectionId].tsx` +1 |

</details>

<details><summary><code>/channels/[connectionId], /channels/feeds/[configurationId]</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.unknown` | Unknown | غير معروف `app/(app)/channels/[connectionId].tsx` +1 |

</details>

<details><summary><code>/channels/[connectionId], /channels/feeds/[configurationId], /customers/[id], /orders/[id], /products/[id], /settings/locations, /settings/members, /settings/payments, /settings/plan, /settings/policies, /settings/store, /settings/tax</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.back` | Back | رجوع `app/(app)/channels/[connectionId].tsx` +11 |

</details>

<details><summary><code>/channels/[connectionId], /channels/onboarding/[sessionId]</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.keys.labelPlaceholder` | WordPress plugin | إضافة WordPress `app/(app)/channels/[connectionId].tsx` +1 |
| `channels.scope.title` | What this channel carries | ما تحمله هذه القناة `app/(app)/channels/[connectionId].tsx` +1 |

</details>

<details><summary><code>/channels/feeds/[configurationId]</code> — 76</summary>

| key | English | Arabic file |
|---|---|---|---|
| `feeds.detail.activateMappingFirst` | Activate a mapping first | فعّل تعيينًا أولًا `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.documentTitle` | Product feed \| Mercaria Dashboard | خلاصة المنتجات \| Mercaria Dashboard `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.neverRead` | This feed has not been read yet. | لم تُقرأ هذه الخلاصة بعد. `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.notFound` | Feed not found | لم يُعثر على الخلاصة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.notFoundBody` | It may have been removed. | ربما تكون قد أُزيلت. `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.recentRuns` | Recent runs | أحدث عمليات التشغيل `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.syncNow` | Sync now | مزامنة الآن `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.title` | Product feed | خلاصة المنتجات `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.columnPlaceholder` | your column name | اسم العمود لديك `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.columnsLabel` | Map your columns | عيّن أعمدتك `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.deliveryDelta` | Only what changed | ما تغيّر فقط `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.deliveryHint` | There is no default, on purpose. If the file lists everything you sell, a product missing from it is one you stopped selling and Mercaria will delist it. If it lists only changes, a missing product means nothing and Mercaria will leave it alone. Getting this wrong either delists a healthy catalog or keeps sold-out products on sale. | لا يوجد خيار افتراضي، وهذا مقصود. إذا كان الملف يسرد كل ما تبيعه، فالمنتج الغائب عنه هو منتج توقّفت عن بيعه وستزيله Mercaria من العرض. وإذا كان يسرد التغييرات فقط، فغياب المنتج لا يعني شيئًا وستتركه Mercaria كما هو. الخطأ هنا إمّا يزيل كتالوجًا سليمًا من العرض أو يُبقي منتجات نفدت معروضة للبيع. `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.deliveryLabel` | What does this file contain? | ماذا يحتوي هذا الملف؟ `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.deliverySnapshot` | Everything I sell | كل ما أبيعه `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.formatLabel` | Format | الصيغة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.requiredSuffix` |  (required) |  (مطلوب) `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.save` | Save mapping | حفظ التعيين `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.title` | New mapping | تعيين جديد `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.urlHint` | HTTPS only. Mercaria stores this privately and only ever shows you the host — a feed URL often carries an access key. | HTTPS فقط. تحفظ Mercaria هذا بشكل خاص ولا تعرض لك سوى المضيف — فغالبًا ما يحمل رابط الخلاصة مفتاح وصول. `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.draft.urlLabel` | Feed URL | رابط الخلاصة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.never` | never | أبدًا `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.reports.note` | The downloadable report gives the row number and what was wrong with it — never the values, since you already have the file. | يعطي التقرير القابل للتنزيل رقم الصف وما كان الخطأ فيه — دون القيم أبدًا، فالملف لديك بالفعل. `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.reports.title` | Reports | التقارير `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.reports.mode.preview` | Preview | معاينة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.reports.mode.validation` | Validation | تحقق `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.reports.mode.import` | Import | استيراد `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.checkFailed` | Couldn't check the feed | تعذّر فحص الخلاصة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.deliveryModeRequired` | Choose whether the file is a full snapshot or only changes | اختر ما إذا كان الملف لقطة كاملة أم التغييرات فقط `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.mappingActivateFailed` | Couldn't activate the mapping | تعذّر تفعيل التعيين `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.mappingActivated` | Mapping activated | تم تفعيل التعيين `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.mappingSaveFailed` | Couldn't save the mapping | تعذّر حفظ التعيين `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.mappingSaved` | Mapping saved — preview it before activating | تم حفظ التعيين — عاينه قبل التفعيل `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.previewFailed` | Couldn't preview the feed | تعذّرت معاينة الخلاصة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.syncStartFailed` | Couldn't start the sync | تعذّر بدء المزامنة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.syncStarted` | Sync started | بدأت المزامنة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.titleMappingRequired` | Map a column onto the product title | عيّن عمودًا على عنوان المنتج `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.urlMustBeHttps` | The feed URL must start with https:// | يجب أن يبدأ رابط الخلاصة بـ https:// `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.unscheduled` | unscheduled | غير مجدولة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.activate` | Activate | تفعيل `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.checkItFirst` | Check it first | افحصه أولًا `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.checkWholeFeed` | Check whole feed | فحص الخلاصة كاملة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.deliveryChangesOnly` | changes only | التغييرات فقط `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.deliveryFullSnapshot` | full snapshot | لقطة كاملة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.empty` | No mapping yet | لا يوجد تعيين بعد `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.emptyBody` | Describe your file below and map its columns onto Mercaria’s fields. | صِف ملفك أدناه وعيّن أعمدته على حقول Mercaria. `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.fetchedOverHttps` |  · fetched over HTTPS |  · تم الجلب عبر HTTPS `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.preview` | Preview | معاينة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.previewReadNothing` | The preview read nothing. An empty result and a mapping that matches no rows look identical — check the file and the record path before activating. | لم تقرأ المعاينة شيئًا. النتيجة الفارغة والتعيين الذي لا يطابق أي صف يبدوان متطابقين — تحقّق من الملف ومن مسار السجل قبل التفعيل. `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.title` | Mappings | التعيينات `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.uploaded` |  · uploaded |  · تم الرفع `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.status.draft` | Draft | مسودة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.status.active` | Active | نشطة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.status.superseded` | Superseded | مُستبدَلة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.status.draft` | Draft | مسودة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.status.active` | Active | نشط `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.status.paused` | Paused | متوقف مؤقتًا `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.status.revoked` | Revoked | ملغى `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.status.failed` | Failed | فشل `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.unknown` | Not read yet | لم تتم القراءة بعد `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.full_feed_success` | Read in full | تمت القراءة بالكامل `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.partial_feed` | Partly read | تمت القراءة جزئيًا `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.auth_failure` | Sign-in failed | فشل المصادقة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.rate_limit` | Rate limited | تم بلوغ حد الطلبات `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.source_outage` | Source unavailable | المصدر غير متاح `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.schema_drift` | Columns changed | تغيّرت الأعمدة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.rights_suspended` | Rights suspended | الحقوق موقوفة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.parse_failure` | Could not be read | تعذّرت القراءة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.matching_ambiguity` | Ambiguous matches | تطابقات غير محددة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.source.health.anomalous_change` | Unusual change | تغيّر غير معتاد `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.kind.backfill` | Backfill | قراءة كاملة `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.kind.incremental` | Incremental | تزايدي `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.kind.manual` | Manual | يدوي `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.status.pending` | Pending | قيد الانتظار `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.status.running` | Running | قيد التنفيذ `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.status.completed` | Completed | اكتملت `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.status.failed` | Failed | فشلت `app/(app)/channels/feeds/[configurationId].tsx` |

</details>

<details><summary><code>/channels/feeds/[configurationId], /products/[id]</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.status` | Status | الحالة `app/(app)/channels/feeds/[configurationId].tsx` +1 |

</details>

<details><summary><code>/channels/feeds/new</code> — 16</summary>

| key | English | Arabic file |
|---|---|---|---|
| `feeds.new.create` | Create feed | إنشاء الخلاصة `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.documentTitle` | New product feed \| Mercaria Dashboard | خلاصة منتجات جديدة \| Mercaria Dashboard `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.identityColumnsHint` | Comma-separated, up to four. These cannot be changed later: they are how Mercaria recognises the same product between one file and the next, so changing them would look like you replaced your entire catalogue. If you need different columns, create a new feed. | مفصولة بفواصل، حتى أربعة أعمدة. لا يمكن تغييرها لاحقًا: فهي الطريقة التي تتعرّف بها Mercaria على المنتج نفسه بين ملف وآخر، وتغييرها سيبدو كأنك استبدلت كتالوجك بالكامل. إذا احتجت أعمدة مختلفة، فأنشئ خلاصة جديدة. `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.identityColumnsLabel` | Columns that identify each product | الأعمدة التي تُعرّف كل منتج `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.nameLabel` | Feed name | اسم الخلاصة `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.namePlaceholder` | Main catalog | الكتالوج الرئيسي `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.sourceNameHint` | How this feed appears in Mercaria’s own catalog records. | كيف تظهر هذه الخلاصة في سجلات الكتالوج الخاصة بـ Mercaria. `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.sourceNameLabel` | Source name | اسم المصدر `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.sourceNamePlaceholder` | Acme Supplies catalog | كتالوج Acme Supplies `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.subtitle` | A CSV, TSV, XML, JSON or JSONL file Mercaria reads on a schedule | ملف CSV أو TSV أو XML أو JSON أو JSONL تقرأه Mercaria وفق جدول زمني `app/(app)/channels/feeds/new.tsx` |
| `feeds.new.title` | New product feed | خلاصة منتجات جديدة `app/(app)/channels/feeds/new.tsx` |
| `feeds.toast.createFailed` | Couldn't create the feed | تعذّر إنشاء الخلاصة `app/(app)/channels/feeds/new.tsx` |
| `feeds.toast.created` | Feed created | تم إنشاء الخلاصة `app/(app)/channels/feeds/new.tsx` |
| `feeds.toast.identityColumnsRequired` | Name at least one column that identifies each product | سمِّ عمودًا واحدًا على الأقل يُعرّف كل منتج `app/(app)/channels/feeds/new.tsx` |
| `feeds.toast.nameRequired` | Give the feed a name | أعطِ الخلاصة اسمًا `app/(app)/channels/feeds/new.tsx` |
| `feeds.toast.sourceNameTooShort` | The source name needs at least 3 characters | يحتاج اسم المصدر إلى 3 أحرف على الأقل `app/(app)/channels/feeds/new.tsx` |

</details>

<details><summary><code>/channels/onboarding/[sessionId]</code> — 71</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.toast.cancelFailed` | Couldn't cancel | تعذّر الإلغاء `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.channelActivated` | Channel activated | تم تفعيل القناة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.consumerKeyAndSecretRequired` | Enter both the consumer key and secret | أدخل مفتاح المستهلك وسرّه معًا `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.invalidShopifyDomain` | Enter a valid *.myshopify.com domain | أدخل نطاق *.myshopify.com صالحًا `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.keyCreateFailed` | Couldn't create the key | تعذّر إنشاء المفتاح `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.notReadyToActivate` | Not ready to activate yet — check the reasons below | غير جاهز للتفعيل بعد — راجع الأسباب أدناه `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.previewSaveFailed` | Couldn't save the preview | تعذّر حفظ المعاينة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.shopifyConnectFailed` | Couldn't start the Shopify connection | تعذّر بدء الاتصال بـ Shopify `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.siteUrlMustBeHttps` | Enter your site URL starting with https:// | أدخل رابط موقعك بادئًا بـ https:// `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.wooConnectFailed` | Couldn't connect — check the site URL and API keys | تعذّر الربط — تحقّق من رابط الموقع ومفاتيح API `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.toast.wooConnected` | WooCommerce connected | تم ربط WooCommerce `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.activateChannel` | Activate channel | تفعيل القناة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.activeConnectionBody` | This channel is active. Choose what to import next — nothing syncs until you do. | هذه القناة نشطة. اختر ما تريد استيراده تاليًا — لا تتم أي مزامنة حتى تفعل. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.activeFeedBody` | This channel is active. You can change its settings any time from Sales channels. | هذه القناة نشطة. يمكنك تغيير إعداداتها في أي وقت من قنوات البيع. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.allSet` | All set | كل شيء جاهز `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.backToChannels` | Back to channels | العودة إلى القنوات `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.beforeYouActivate` | Before you can activate | قبل أن تتمكن من التفعيل `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.beforeYouStart` | Before you start | قبل أن تبدأ `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.blocker.channelLimitation` | This channel cannot be activated yet. | لا يمكن تفعيل هذه القناة بعد. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.blocker.connectionNotConnected` | Finish connecting first. | أكمل الربط أولًا. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.blocker.noPreview` | Run a preview first, so you can see what will be imported. | شغّل معاينة أولًا، لترى ما سيُستورد. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.blocker.previewAllInvalid` | Every record the preview read was invalid. Fix the mapping and try again. | كل سجل قرأته المعاينة كان غير صالح. أصلح التعيين وحاول مرة أخرى. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.blocker.previewScannedNothing` | The preview read no records at all. Check the feed or the store has products — a mapping that matches nothing looks the same as an empty catalog. | لم تقرأ المعاينة أي سجلات إطلاقًا. تحقّق من أن الخلاصة أو المتجر يحتوي على منتجات — فالتعيين الذي لا يطابق شيئًا يبدو كالكتالوج الفارغ تمامًا. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.blocker.unsupportedDirection` | The sync settings ask for a direction this channel does not support. Adjust them and try again. | تطلب إعدادات المزامنة اتجاهًا لا تدعمه هذه القناة. عدّلها وحاول مرة أخرى. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.canAndCannot` | What this channel can and cannot do | ما تستطيعه هذه القناة وما لا تستطيعه `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.chooseWhatToImport` | Choose what to import | اختر ما تريد استيراده `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.documentTitle` | Connect a channel \| Mercaria Dashboard | ربط قناة \| Mercaria Dashboard `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.everythingChecksOut` | Everything checks out. Activating starts the first sync. | كل شيء سليم. التفعيل يبدأ أول مزامنة. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.feed.body` | A product feed is configured on its own screen, where you map the file’s columns onto Mercaria’s fields and preview the result before anything goes live. | تُعد خلاصة المنتجات في شاشتها الخاصة، حيث تعيّن أعمدة الملف على حقول Mercaria وتعاين النتيجة قبل أن يصبح أي شيء مباشرًا. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.feed.create` | Create a feed | إنشاء خلاصة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.feed.title` | Set up your feed | أعدّ خلاصتك `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.merchantLinked` | This store is linked to a verified merchant, so anything Mercaria already indexed for your shop will be reconciled rather than duplicated. | هذا المتجر مرتبط بتاجر موثّق، لذا فإن أي شيء فهرسته Mercaria بالفعل لمتجرك ستتم مطابقته بدلًا من تكراره. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.merchantNotLinked` | This store is not linked to a verified merchant yet. Connecting still works; Mercaria just will not match your products against anything it already indexed for your shop. | هذا المتجر غير مرتبط بتاجر موثّق بعد. الربط يعمل على أي حال؛ لكن Mercaria لن تطابق منتجاتك مع أي شيء فهرسته بالفعل لمتجرك. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.notFound` | Wizard not found | لم يُعثر على المعالج `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.notFoundBody` | It may have been finished already. | ربما يكون قد اكتمل بالفعل. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.notSetUpYet` |  (not set up yet) |  (لم يُعد بعد) `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.plugin.body` | Install the Mercaria plugin on your WordPress site, then paste the key below into its settings. The plugin pushes your products and stock to Mercaria as they change. | ثبّت إضافة Mercaria على موقع WordPress الخاص بك، ثم الصق المفتاح أدناه في إعداداتها. تدفع الإضافة منتجاتك ومخزونك إلى Mercaria فور تغيّرها. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.plugin.createKey` | Create a channel key | إنشاء مفتاح قناة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.plugin.keyHeading` | Your channel key — copy it now | مفتاح قناتك — انسخه الآن `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.plugin.keyNote` | This is the only time it is shown. If you lose it, revoke it and mint a new one. | هذه هي المرة الوحيدة التي يُعرض فيها. إذا فقدته، فأبطله وأنشئ مفتاحًا جديدًا. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.plugin.title` | Connect the Mercaria plugin | ربط إضافة Mercaria `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.body` | Run a bounded sample before activating, so you can see what will be imported and how much needs review. | شغّل عيّنة محدودة قبل التفعيل، لترى ما سيُستورد وكم يحتاج إلى مراجعة. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.duplicate` | Duplicate | مكرر `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.invalid` | Invalid | غير صالح `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.matched` | Matched | مطابق `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.rerun` | Re-run preview | إعادة تشغيل المعاينة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.run` | Run preview | تشغيل المعاينة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.scanned` | Scanned | مفحوص `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.title` | Preview | معاينة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.preview.toReview` | To review | للمراجعة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.shopify.authNote` | Authorization happens on Shopify. Mercaria never sees your Shopify password, and the access token it receives is stored encrypted. | يتم التفويض على Shopify. لا ترى Mercaria كلمة مرور Shopify الخاصة بك أبدًا، ويُخزَّن رمز الوصول الذي تستلمه مشفَّرًا. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.shopify.continue` | Continue to Shopify | المتابعة إلى Shopify `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.shopify.domainLabel` | Shop domain | نطاق المتجر `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.shopify.openAgain` | Open Shopify again | افتح Shopify مرة أخرى `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.shopify.title` | Authorize Mercaria on Shopify | تفويض Mercaria على Shopify `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.shopify.waitingBody` | Finish authorizing in the tab that just opened. This page updates on its own — you do not need to reload it or come back to this step. | أكمل التفويض في علامة التبويب التي فُتحت للتو. تتحدث هذه الصفحة من تلقاء نفسها — لا تحتاج إلى إعادة تحميلها أو العودة إلى هذه الخطوة. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.shopify.waitingTitle` | Waiting for Shopify | بانتظار Shopify `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.step.activate` | Activate | تفعيل `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.step.configure` | Sync settings | إعدادات المزامنة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.step.connect` | Connect | ربط `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.step.map` | Mapping | التعيين `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.step.preview` | Preview | معاينة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.step.scope` | Store | المتجر `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.step.selectChannel` | Channel | القناة `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.body` | WooCommerce → Settings → Advanced → REST API. Read access is enough to import your catalog. | WooCommerce ← الإعدادات ← خيارات متقدمة ← REST API. صلاحية القراءة تكفي لاستيراد كتالوجك. `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.connect` | Connect WooCommerce | ربط WooCommerce `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.consumerKeyLabel` | Consumer key | مفتاح المستهلك `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.consumerSecretLabel` | Consumer secret | سر المستهلك `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.siteUrlLabel` | Site URL | رابط الموقع `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.title` | Paste your WooCommerce API key | الصق مفتاح API الخاص بـ WooCommerce `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.youWillNeed` | You will need | ستحتاج إلى `app/(app)/channels/onboarding/[sessionId].tsx` |

</details>

<details><summary><code>/channels/onboarding/[sessionId], /collections, /discounts, /settings/locations</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.new` | New | جديد `app/(app)/channels/onboarding/[sessionId].tsx` +3 |

</details>

<details><summary><code>/collections</code> — 19</summary>

| key | English | Arabic file |
|---|---|---|---|
| `collections.create.dialogTitle` | New collection | مجموعة جديدة `app/(app)/collections/index.tsx` |
| `collections.create.error` | Couldn't create the collection | تعذّر إنشاء المجموعة `app/(app)/collections/index.tsx` |
| `collections.create.success` | Collection created | تم إنشاء المجموعة `app/(app)/collections/index.tsx` |
| `collections.create.titlePlaceholder` | Summer essentials | أساسيات الصيف `app/(app)/collections/index.tsx` |
| `collections.create.titleRequired` | Title is required | العنوان مطلوب `app/(app)/collections/index.tsx` |
| `collections.create.typeAutomated` | Automated | تلقائية `app/(app)/collections/index.tsx` |
| `collections.create.typeManual` | Manual | يدوية `app/(app)/collections/index.tsx` |
| `collections.deleteError` | Couldn't delete the collection | تعذّر حذف المجموعة `app/(app)/collections/index.tsx` |
| `collections.deleted` | Collection deleted | تم حذف المجموعة `app/(app)/collections/index.tsx` |
| `collections.documentTitle` | Collections \| Mercaria Dashboard | المجموعات \| Mercaria Dashboard `app/(app)/collections/index.tsx` |
| `collections.empty.body` | Create one to organize your catalog. | أنشئ واحدة لتنظيم الكتالوج الخاص بك. `app/(app)/collections/index.tsx` |
| `collections.empty.title` | No collections yet | لا توجد مجموعات بعد `app/(app)/collections/index.tsx` |
| `collections.loadError` | Couldn't load collections | تعذّر تحميل المجموعات `app/(app)/collections/index.tsx` |
| `collections.state.draft` | draft | مسودة `app/(app)/collections/index.tsx` |
| `collections.state.published` | published | منشورة `app/(app)/collections/index.tsx` |
| `collections.subtitle` | Group products for merchandising | جمّع المنتجات لعرضها معًا `app/(app)/collections/index.tsx` |
| `collections.type.automated` | automated | تلقائية `app/(app)/collections/index.tsx` |
| `collections.type.manual` | manual | يدوية `app/(app)/collections/index.tsx` |
| `nav.collections` | Collections | المجموعات `app/(app)/collections/index.tsx` |

</details>

<details><summary><code>/collections, /discounts, /products/[id], /products/new, /products/wizard/[draftId]</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.title` | Title | العنوان `app/(app)/collections/index.tsx` +5 |

</details>

<details><summary><code>/collections, /discounts, /settings/locations, /settings/tax</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.create` | Create | إنشاء `app/(app)/collections/index.tsx` +3 |

</details>

<details><summary><code>/collections, /settings/locations</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.type` | Type | النوع `app/(app)/collections/index.tsx` +1 |

</details>

<details><summary><code>/customers</code> — 7</summary>

| key | English | Arabic file |
|---|---|---|---|
| `customers.documentTitle` | Customers \| Mercaria Dashboard | العملاء \| Mercaria Dashboard `app/(app)/customers/index.tsx` |
| `customers.empty.body` | Customers appear here after their first order. | يظهر العملاء هنا بعد أول طلب لهم. `app/(app)/customers/index.tsx` |
| `customers.empty.title` | No customers | لا يوجد عملاء `app/(app)/customers/index.tsx` |
| `customers.loadError` | Couldn't load customers | تعذّر تحميل العملاء `app/(app)/customers/index.tsx` |
| `customers.searchPlaceholder` | Search customers… | ابحث عن العملاء… `app/(app)/customers/index.tsx` |
| `customers.subtitle` | People who buy from your store | الأشخاص الذين يشترون من متجرك `app/(app)/customers/index.tsx` |
| `nav.customers` | Customers | العملاء `app/(app)/customers/index.tsx` |

</details>

<details><summary><code>/customers, /customers/[id]</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `customers.fallbackName` | Customer | عميل `app/(app)/customers/[id].tsx` +1 |
| `customers.walkIn` | Walk-in customer | عميل عابر `app/(app)/customers/[id].tsx` +1 |

</details>

<details><summary><code>/customers/[id]</code> — 7</summary>

| key | English | Arabic file |
|---|---|---|---|
| `customers.detail.documentTitle` | Customer \| Mercaria Dashboard | العميل \| Mercaria Dashboard `app/(app)/customers/[id].tsx` |
| `customers.detail.lifetimeSpend` | Lifetime spend | إجمالي الإنفاق `app/(app)/customers/[id].tsx` |
| `customers.detail.loadError` | Couldn't load customer | تعذّر تحميل العميل `app/(app)/customers/[id].tsx` |
| `customers.detail.noOrders` | No orders yet. | لا توجد طلبات بعد. `app/(app)/customers/[id].tsx` |
| `customers.detail.orders` | Orders | الطلبات `app/(app)/customers/[id].tsx` |
| `customers.detail.subtitle` | Customer detail | تفاصيل العميل `app/(app)/customers/[id].tsx` |
| `customers.detail.title` | Customer | العميل `app/(app)/customers/[id].tsx` |

</details>

<details><summary><code>/customers/[id], /orders, /orders/[id]</code> — 8</summary>

| key | English | Arabic file |
|---|---|---|---|
| `orders.status.cancelled` | Cancelled | ملغى `components/orders/OrderStatusBadge.tsx` |
| `orders.status.delivered` | Delivered | تم التسليم `components/orders/OrderStatusBadge.tsx` |
| `orders.status.paid` | Paid | مدفوع `components/orders/OrderStatusBadge.tsx` |
| `orders.status.partiallyRefunded` | Part. refunded | مُسترد جزئيًا `components/orders/OrderStatusBadge.tsx` |
| `orders.status.pendingPayment` | Pending | قيد الانتظار `components/orders/OrderStatusBadge.tsx` |
| `orders.status.processing` | Processing | قيد المعالجة `components/orders/OrderStatusBadge.tsx` |
| `orders.status.refunded` | Refunded | مُسترد `components/orders/OrderStatusBadge.tsx` |
| `orders.status.shipped` | Shipped | تم الشحن `components/orders/OrderStatusBadge.tsx` |

</details>

<details><summary><code>/discounts</code> — 30</summary>

| key | English | Arabic file |
|---|---|---|---|
| `discounts.create.amountOffLabel` | Amount off (⊜) | قيمة الخصم (⊜) `app/(app)/discounts/index.tsx` |
| `discounts.create.codeLabel` | Code | الرمز `app/(app)/discounts/index.tsx` |
| `discounts.create.codeRequired` | Enter a discount code | أدخل رمز خصم `app/(app)/discounts/index.tsx` |
| `discounts.create.dialogTitle` | New discount | خصم جديد `app/(app)/discounts/index.tsx` |
| `discounts.create.error` | Couldn't create the discount | تعذّر إنشاء الخصم `app/(app)/discounts/index.tsx` |
| `discounts.create.invalidAmount` | Enter a valid amount | أدخل مبلغًا صالحًا `app/(app)/discounts/index.tsx` |
| `discounts.create.invalidPercentage` | Enter a valid percentage | أدخل نسبة مئوية صالحة `app/(app)/discounts/index.tsx` |
| `discounts.create.methodAutomatic` | Automatic | تلقائي `app/(app)/discounts/index.tsx` |
| `discounts.create.methodCode` | Code | رمز `app/(app)/discounts/index.tsx` |
| `discounts.create.methodLabel` | Method | الطريقة `app/(app)/discounts/index.tsx` |
| `discounts.create.percentOffLabel` | Percent off | نسبة الخصم `app/(app)/discounts/index.tsx` |
| `discounts.create.success` | Discount created | تم إنشاء الخصم `app/(app)/discounts/index.tsx` |
| `discounts.create.titlePlaceholder` | Spring sale | تخفيضات الربيع `app/(app)/discounts/index.tsx` |
| `discounts.create.titleRequired` | Title is required | العنوان مطلوب `app/(app)/discounts/index.tsx` |
| `discounts.create.valueTypeFixed` | Fixed (⊜) | مبلغ ثابت (⊜) `app/(app)/discounts/index.tsx` |
| `discounts.create.valueTypeLabel` | Value type | نوع القيمة `app/(app)/discounts/index.tsx` |
| `discounts.create.valueTypePercentage` | Percentage | نسبة مئوية `app/(app)/discounts/index.tsx` |
| `discounts.deleteError` | Couldn't delete the discount | تعذّر حذف الخصم `app/(app)/discounts/index.tsx` |
| `discounts.deleted` | Discount deleted | تم حذف الخصم `app/(app)/discounts/index.tsx` |
| `discounts.documentTitle` | Discounts \| Mercaria Dashboard | الخصومات \| Mercaria Dashboard `app/(app)/discounts/index.tsx` |
| `discounts.empty.body` | Create a code or automatic discount. | أنشئ خصمًا برمز أو خصمًا تلقائيًا. `app/(app)/discounts/index.tsx` |
| `discounts.empty.title` | No discounts yet | لا توجد خصومات بعد `app/(app)/discounts/index.tsx` |
| `discounts.fixedAmountOff` | Fixed amount off | خصم بمبلغ ثابت `app/(app)/discounts/index.tsx` |
| `discounts.loadError` | Couldn't load discounts | تعذّر تحميل الخصومات `app/(app)/discounts/index.tsx` |
| `discounts.methodAutomatic` | automatic | تلقائي `app/(app)/discounts/index.tsx` |
| `discounts.methodCode` | code | رمز `app/(app)/discounts/index.tsx` |
| `discounts.state.active` | active | نشط `app/(app)/discounts/index.tsx` |
| `discounts.state.inactive` | inactive | غير نشط `app/(app)/discounts/index.tsx` |
| `discounts.subtitle` | Codes and automatic promotions | الرموز والعروض التلقائية `app/(app)/discounts/index.tsx` |
| `nav.discounts` | Discounts | الخصومات `app/(app)/discounts/index.tsx` |

</details>

<details><summary><code>/orders</code> — 7</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.all` | All | الكل `app/(app)/orders/index.tsx` |
| `orders.documentTitle` | Orders \| Mercaria Dashboard | الطلبات \| Mercaria Dashboard `app/(app)/orders/index.tsx` |
| `orders.empty.body` | Orders will appear here once customers buy. | ستظهر الطلبات هنا بمجرد أن يشتري العملاء. `app/(app)/orders/index.tsx` |
| `orders.empty.title` | No orders | لا توجد طلبات `app/(app)/orders/index.tsx` |
| `orders.loadFailed` | Couldn't load orders | تعذّر تحميل الطلبات `app/(app)/orders/index.tsx` |
| `orders.subtitle` | Fulfil and track your sales | نفّذ مبيعاتك وتابعها `app/(app)/orders/index.tsx` |
| `orders.title` | Orders | الطلبات `app/(app)/orders/index.tsx` |

</details>

<details><summary><code>/orders/[id]</code> — 70</summary>

| key | English | Arabic file |
|---|---|---|---|
| `orders.detail.documentTitle` | Order \| Mercaria Dashboard | الطلب \| Mercaria Dashboard `app/(app)/orders/[id].tsx` |
| `orders.detail.fulfilment` | Fulfilment | التنفيذ `app/(app)/orders/[id].tsx` |
| `orders.detail.history` | History | السجل `app/(app)/orders/[id].tsx` |
| `orders.detail.items` | Items | العناصر `app/(app)/orders/[id].tsx` |
| `orders.detail.loadFailed` | Couldn't load order | تعذّر تحميل الطلب `app/(app)/orders/[id].tsx` |
| `orders.detail.markedCancelled` | Order marked cancelled | تم تعليم الطلب ملغى `app/(app)/orders/[id].tsx` |
| `orders.detail.markedDelivered` | Order marked delivered | تم تعليم الطلب مُسلَّمًا `app/(app)/orders/[id].tsx` |
| `orders.detail.markedProcessing` | Order marked processing | تم تعليم الطلب قيد المعالجة `app/(app)/orders/[id].tsx` |
| `orders.detail.markedShipped` | Order marked shipped | تم تعليم الطلب مشحونًا `app/(app)/orders/[id].tsx` |
| `orders.detail.refund` | Refund | استرداد `app/(app)/orders/[id].tsx` |
| `orders.detail.refundFallbackLabel` | Refund | استرداد `app/(app)/orders/[id].tsx` |
| `orders.detail.refunds` | Refunds | المبالغ المستردة `app/(app)/orders/[id].tsx` |
| `orders.detail.shipTo` | Ship to | الشحن إلى `app/(app)/orders/[id].tsx` |
| `orders.detail.subtitle` | Order detail | تفاصيل الطلب `app/(app)/orders/[id].tsx` |
| `orders.detail.title` | Order | الطلب `app/(app)/orders/[id].tsx` |
| `orders.detail.trackingLabel` | Tracking number (optional) | رقم التتبّع (اختياري) `app/(app)/orders/[id].tsx` |
| `orders.detail.updateFailed` | Couldn't update the order | تعذّر تحديث الطلب `app/(app)/orders/[id].tsx` |
| `orders.pickup.cancelAccessibilityLabel` | Reason for cancelling this collection | سبب إلغاء هذا الاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.cancelCollection` | Cancel collection | إلغاء الاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.cancelLabel` | Cancel this collection — reason | إلغاء هذا الاستلام — السبب `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.cancelNote` | This withdraws the handover and revokes the code. It does not cancel the order and it refunds nothing — do that on the order itself if the customer is owed money. | يسحب هذا التسليم ويُبطل الرمز. لا يلغي الطلب ولا يسترد أي مبلغ — نفّذ ذلك على الطلب نفسه إذا كان للعميل مبلغ مستحق. `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.cancelPlaceholder` | Stock damaged in the stockroom | تلفت البضاعة في المخزن `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.checkCodeAndHandOver` | Check code and hand over | تحقّق من الرمز وسلّم الطلب `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.codeAccessibilityLabel` | Collection code the customer presented | رمز الاستلام الذي قدّمه العميل `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.codeLabel` | Code the customer presented | الرمز الذي قدّمه العميل `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.codeRejected` | Code rejected | رُفض الرمز `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.codeRevoked` | Code revoked | أُبطل الرمز `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.codeRotated` | Code rotated | أُصدر رمز جديد `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.codeValidated` | Code accepted | قُبل الرمز `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.collected` | Handed over | تم التسليم `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.collectionRefused` | Handover refused | رُفض التسليم `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.fallbackOverride` | Handed over with an override | تم التسليم مع تجاوز `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.markedReady` | Marked ready | عُلّم جاهزًا `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.event.pickupCancelled` | Collection cancelled | أُلغي الاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.handOverWithOverride` | Hand over with override | التسليم مع تجاوز `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.markReady` | Mark ready to collect | تعليمه جاهزًا للاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.overrideAccessibilityLabel` | Reason for handing over without a working code | سبب التسليم دون رمز صالح `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.overrideLabel` | Hand over without a working code — reason | التسليم دون رمز صالح — السبب `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.overrideNote` | Recorded against your account, with the reason, in the trail below. | يُسجَّل هذا على حسابك، مع السبب، في السجل أدناه. `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.overridePlaceholder` | Code would not scan; ID checked in person | تعذّر مسح الرمز؛ جرى التحقق من الهوية شخصيًا `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.rotate` | Issue a new code | إصدار رمز جديد `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.rotateAccessibilityLabel` | Reason for issuing a new collection code | سبب إصدار رمز استلام جديد `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.rotateLabel` | Issue a new code — reason | إصدار رمز جديد — السبب `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.rotatePlaceholder` | Customer says the code leaked | يقول العميل إن الرمز قد تسرّب `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.rotatedCodeNote` | Read this to the customer. The previous code no longer works. | اقرأ هذا للعميل. لم يعد الرمز السابق صالحًا. `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.title` | Collection | الاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.toast.cancelled` | Collection cancelled | أُلغي الاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.toast.codeIssued` | New code issued | صدر رمز جديد `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.toast.collected` | Collection recorded | تم تسجيل الاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.toast.collectedWithOverride` | Collection recorded with an override | تم تسجيل الاستلام مع تجاوز `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.toast.markedReady` | Marked ready to collect | عُلّم جاهزًا للاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.trail` | Collection trail | سجل الاستلام `components/orders/PickupDeskCard.tsx` |
| `orders.pickup.trailEmpty` | Nothing has happened at the counter yet. | لم يحدث شيء عند الطاولة بعد. `components/orders/PickupDeskCard.tsx` |
| `orders.refund.dialogTitle` | Refund order | استرداد مبلغ الطلب `app/(app)/orders/[id].tsx` |
| `orders.refund.failed` | Couldn't process the refund | تعذّرت معالجة الاسترداد `app/(app)/orders/[id].tsx` |
| `orders.refund.processed` | Refund processed | تمت معالجة الاسترداد `app/(app)/orders/[id].tsx` |
| `orders.refund.quantityRequired` | Enter a quantity to refund | أدخل الكمية المراد استردادها `app/(app)/orders/[id].tsx` |
| `orders.refund.reasonLabel` | Reason (optional) | السبب (اختياري) `app/(app)/orders/[id].tsx` |
| `orders.refund.reasonPlaceholder` | Why is this being refunded? | لماذا يجري استرداد هذا المبلغ؟ `app/(app)/orders/[id].tsx` |
| `orders.refund.submit` | Process refund | معالجة الاسترداد `app/(app)/orders/[id].tsx` |
| `orders.refundState.canceled` | Canceled | ملغى `app/(app)/orders/[id].tsx` |
| `orders.refundState.failed` | Failed | فشل `app/(app)/orders/[id].tsx` |
| `orders.refundState.pending` | On its way | في الطريق `app/(app)/orders/[id].tsx` |
| `orders.refundState.succeeded` | Completed | مكتمل `app/(app)/orders/[id].tsx` |
| `orders.totals.discounts` | Discounts | الخصومات `app/(app)/orders/[id].tsx` |
| `orders.totals.heading` | Totals | الإجماليات `app/(app)/orders/[id].tsx` |
| `orders.totals.shipping` | Shipping | الشحن `app/(app)/orders/[id].tsx` |
| `orders.totals.subtotal` | Subtotal | المجموع الفرعي `app/(app)/orders/[id].tsx` |
| `orders.totals.tax` | Tax | الضريبة `app/(app)/orders/[id].tsx` |
| `orders.totals.total` | Total | الإجمالي `app/(app)/orders/[id].tsx` |

</details>

<details><summary><code>/products</code> — 9</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.addProduct` | Add product | إضافة منتج `app/(app)/products/index.tsx` |
| `products.documentTitle` | Products \| Mercaria Dashboard | المنتجات \| Mercaria Dashboard `app/(app)/products/index.tsx` |
| `products.empty.action` | Add your first product | أضف منتجك الأول `app/(app)/products/index.tsx` |
| `products.empty.title` | No products yet | لا توجد منتجات بعد `app/(app)/products/index.tsx` |
| `products.loadFailed` | Couldn't load products | تعذّر تحميل المنتجات `app/(app)/products/index.tsx` |
| `products.searchPlaceholder` | Search products on this page… | ابحث في منتجات هذه الصفحة… `app/(app)/products/index.tsx` |
| `products.status.restricted` | Restricted | مقيَّد `app/(app)/products/index.tsx` |
| `products.subtitle` | Your store catalog | كتالوج متجرك `app/(app)/products/index.tsx` |
| `products.title` | Products | المنتجات `app/(app)/products/index.tsx` |

</details>

<details><summary><code>/products, /products/[id]</code> — 4</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.status.active` | Active | نشط `app/(app)/products/[id].tsx` +1 |
| `products.status.archived` | Archived | مؤرشف `app/(app)/products/[id].tsx` +1 |
| `products.status.draft` | Draft | مسودة `app/(app)/products/[id].tsx` +1 |
| `products.status.sold` | Sold | مباع `app/(app)/products/[id].tsx` +1 |

</details>

<details><summary><code>/products/[id]</code> — 32</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.save` | Save | حفظ `app/(app)/products/[id].tsx` |
| `products.detail.archive` | Archive | أرشفة `app/(app)/products/[id].tsx` |
| `products.detail.archiveFailed` | Couldn't archive the product | تعذّرت أرشفة المنتج `app/(app)/products/[id].tsx` |
| `products.detail.archived` | Product archived | تمت أرشفة المنتج `app/(app)/products/[id].tsx` |
| `products.detail.channelSettings` | Channel settings | إعدادات القناة `app/(app)/products/[id].tsx` |
| `products.detail.documentTitle` | Product \| Mercaria Dashboard | المنتج \| Mercaria Dashboard `app/(app)/products/[id].tsx` |
| `products.detail.loadFailed` | Couldn't load product | تعذّر تحميل المنتج `app/(app)/products/[id].tsx` |
| `products.detail.pins.release` | Release | تحرير `app/(app)/products/[id].tsx` |
| `products.detail.pins.releaseFailed` | Couldn't release the field | تعذّر تحرير الحقل `app/(app)/products/[id].tsx` |
| `products.detail.pins.releaseNote` | Releasing a field lets the platform manage it again from the next sync onwards. Your current value stays until then — Mercaria does not keep the platform's earlier value, so nothing is put back. | تحرير حقل يتيح للمنصّة إدارته مجددًا اعتبارًا من المزامنة التالية. تبقى قيمتك الحالية حتى ذلك الحين — فـ Mercaria لا تحتفظ بقيمة المنصّة السابقة، ولذلك لا يُستعاد شيء. `app/(app)/products/[id].tsx` |
| `products.detail.pins.released` | Released. Nothing changes here until the next sync, when the platform's value takes over. | تم التحرير. لا يتغير شيء هنا حتى المزامنة التالية، حين تتولى قيمة المنصّة الأمر. `app/(app)/products/[id].tsx` |
| `products.detail.restrictedNotice` | This product is restricted pending a moderation decision and cannot be republished from here. | هذا المنتج مقيَّد بانتظار قرار إشراف، ولا يمكن إعادة نشره من هنا. `app/(app)/products/[id].tsx` |
| `products.detail.saveChanges` | Save changes | حفظ التغييرات `app/(app)/products/[id].tsx` |
| `products.detail.saveFailed` | Couldn't save the product | تعذّر حفظ المنتج `app/(app)/products/[id].tsx` |
| `products.detail.saved` | Product saved | تم حفظ المنتج `app/(app)/products/[id].tsx` |
| `products.detail.title` | Product | المنتج `app/(app)/products/[id].tsx` |
| `products.variants.add` | Add | إضافة `app/(app)/products/[id].tsx` |
| `products.variants.addFailed` | Couldn't add the variant | تعذّرت إضافة المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.added` | Variant added | تمت إضافة المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.available` | Available | المتاح `app/(app)/products/[id].tsx` |
| `products.variants.heading` | Variants & inventory | المتغيّرات والمخزون `app/(app)/products/[id].tsx` |
| `products.variants.inventoryUpdateFailed` | Couldn't update inventory | تعذّر تحديث المخزون `app/(app)/products/[id].tsx` |
| `products.variants.inventoryUpdated` | Inventory updated | تم تحديث المخزون `app/(app)/products/[id].tsx` |
| `products.variants.priceInvalid` | Enter a valid price | أدخل سعرًا صالحًا `app/(app)/products/[id].tsx` |
| `products.variants.removeFailed` | Couldn't remove the variant | تعذّرت إزالة المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.removeVariant` | Remove variant | إزالة المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.removed` | Variant removed | تمت إزالة المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.saveVariant` | Save variant | حفظ المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.set` | Set | تعيين `app/(app)/products/[id].tsx` |
| `products.variants.updateFailed` | Couldn't update the variant | تعذّر تحديث المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.updated` | Variant updated | تم تحديث المتغيّر `app/(app)/products/[id].tsx` |
| `products.variants.valuePlaceholder` | value | القيمة `app/(app)/products/[id].tsx` |

</details>

<details><summary><code>/products/[id], /products/new</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.priceLabel` | Price (⊜) | السعر (⊜) `app/(app)/products/[id].tsx` +1 |
| `products.stockLabel` | Stock | المخزون `app/(app)/products/[id].tsx` +1 |

</details>

<details><summary><code>/products/[id], /products/new, /products/wizard/[draftId], /settings/store, /stores</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.description` | Description | الوصف `app/(app)/products/[id].tsx` +5 |

</details>

<details><summary><code>/products/new</code> — 18</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.new.addVariant` | Add variant | إضافة متغيّر `app/(app)/products/new.tsx` |
| `products.new.categoryLabel` | Category (slug) | الفئة (المعرّف النصي) `app/(app)/products/new.tsx` |
| `products.new.categoryRequired` | Category is required | الفئة مطلوبة `app/(app)/products/new.tsx` |
| `products.new.createFailed` | Couldn't create the product | تعذّر إنشاء المنتج `app/(app)/products/new.tsx` |
| `products.new.created` | Product created | تم إنشاء المنتج `app/(app)/products/new.tsx` |
| `products.new.descriptionPlaceholder` | Describe the product | صِف المنتج `app/(app)/products/new.tsx` |
| `products.new.documentTitle` | New product \| Mercaria Dashboard | منتج جديد \| Mercaria Dashboard `app/(app)/products/new.tsx` |
| `products.new.optionNameLabel` | Option name (optional, e.g. Size) | اسم الخيار (اختياري، مثل المقاس) `app/(app)/products/new.tsx` |
| `products.new.optionNamePlaceholder` | Size | المقاس `app/(app)/products/new.tsx` |
| `products.new.optionsHeading` | Options & variants | الخيارات والمتغيّرات `app/(app)/products/new.tsx` |
| `products.new.skuLabel` | SKU (optional) | SKU (اختياري) `app/(app)/products/new.tsx` |
| `products.new.submit` | Create product | إنشاء المنتج `app/(app)/products/new.tsx` |
| `products.new.subtitle` | Add a product to your catalog | أضف منتجًا إلى كتالوجك `app/(app)/products/new.tsx` |
| `products.new.title` | New product | منتج جديد `app/(app)/products/new.tsx` |
| `products.new.titlePlaceholder` | Product name | اسم المنتج `app/(app)/products/new.tsx` |
| `products.new.titleRequired` | Title is required | العنوان مطلوب `app/(app)/products/new.tsx` |
| `products.new.variantPriceInvalid` | Each variant needs a valid price | كل متغيّر يحتاج إلى سعر صالح `app/(app)/products/new.tsx` |
| `products.new.vendorLabel` | Vendor / brand | المورّد / العلامة التجارية `app/(app)/products/new.tsx` |

</details>

<details><summary><code>/products/wizard</code> — 25</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.start.documentTitle` | What are you selling? | ما الذي تبيعه؟ `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.title` | What are you selling? | ما الذي تبيعه؟ `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.subtitle` | Find it in the catalogue, or describe something new. | اعثر عليه في الكتالوج، أو صِف شيئًا جديدًا. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.unavailableTitle` | Guided creation is not available here | الإنشاء الموجّه غير متاح هنا `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.unavailableBody` | This Mercaria deployment has not enabled the catalogue authoring service, so the guided form cannot be used yet. | لم تُفعّل نسخة Mercaria هذه خدمة تأليف الكتالوج، لذا لا يمكن استخدام النموذج الموجّه بعد. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.useLegacy` | Use the simple form | استخدم النموذج البسيط `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.createFailed` | That draft could not be created. | تعذّر إنشاء تلك المسودة. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.linkFailed` | The draft was created, but the catalogue product could not be attached. You can choose it again inside the wizard. | أُنشئت المسودة، لكن تعذّر ربط منتج الكتالوج بها. يمكنك اختياره مرة أخرى داخل المعالج. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.resumeTitle` | Pick up where you left off | تابع من حيث توقفت `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.untitledDraft` | Untitled draft | مسودة بلا عنوان `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.findTitle` | Find it in the catalogue | اعثر عليه في الكتالوج `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.findBody` | Search by name, model or barcode. Check the identifiers so you do not pick a different regional model. | ابحث بالاسم أو الطراز أو الباركود. تحقّق من المعرّفات كي لا تختار طرازًا إقليميًا مختلفًا. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.classifyAnyway` | We still need a category, because that is what decides which details the form asks for. | ما زلنا بحاجة إلى فئة، لأنها ما يحدد التفاصيل التي يطلبها النموذج. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.categoryTitle` | Choose a category | اختر فئة `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.typeTitle` | Choose a product type | اختر نوع منتج `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.noProductTypes` | No product type is published for this category yet. | لم يُنشر أي نوع منتج لهذه الفئة بعد. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.marketLabel` | Market | السوق `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.marketHelp` | The country this product is sold in. It decides which wording and which rules apply. | الدولة التي يُباع فيها هذا المنتج. هي التي تحدد الصياغة والقواعد المطبَّقة. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.marketInvalid` | A market is a two-letter country code. | السوق هو رمز دولة من حرفين. `app/(app)/products/wizard/index.tsx` |
| `products.wizard.start.begin` | Start | ابدأ `app/(app)/products/wizard/index.tsx` |
| `products.wizard.category.allCategories` | All categories | كل الفئات `components/catalog-authoring/CategoryBrowser.tsx` |
| `products.wizard.category.loadFailed` | Categories could not be loaded. | تعذّر تحميل الفئات. `components/catalog-authoring/CategoryBrowser.tsx` |
| `products.wizard.category.noChildren` | There is nothing below this category. | لا يوجد شيء تحت هذه الفئة. `components/catalog-authoring/CategoryBrowser.tsx` |
| `products.wizard.category.choose` | Choose | اختيار `components/catalog-authoring/CategoryBrowser.tsx` |
| `products.wizard.category.chosen` | Chosen | مختارة `components/catalog-authoring/CategoryBrowser.tsx` |

</details>

<details><summary><code>/products/wizard, /products/wizard/[draftId]</code> — 5</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.canonical.searchPlaceholder` | Name, model or barcode | الاسم أو الطراز أو الباركود `components/catalog-authoring/CanonicalSearchPanel.tsx` |
| `products.wizard.canonical.minQuery` | Type at least two characters. | اكتب حرفين على الأقل. `components/catalog-authoring/CanonicalSearchPanel.tsx` |
| `products.wizard.canonical.exactMatch` | This is an exact identifier match. | هذه مطابقة تامة للمعرّف. `components/catalog-authoring/CanonicalSearchPanel.tsx` |
| `products.wizard.canonical.noResults` | Nothing in the catalogue matched. | لم يطابق أي شيء في الكتالوج. `components/catalog-authoring/CanonicalSearchPanel.tsx` |
| `products.wizard.canonical.clearSelection` | Clear the selection | مسح الاختيار `components/catalog-authoring/CanonicalSearchPanel.tsx` |

</details>

<details><summary><code>/products/wizard/[draftId]</code> — 110</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.documentTitle` | Create a product | إنشاء منتج `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.title` | Create a product | إنشاء منتج `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.readOnly` | This draft can no longer be edited. | لم يعد بالإمكان تعديل هذه المسودة. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.load.draftFailedTitle` | This draft could not be opened | تعذّر فتح هذه المسودة `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.load.draftFailedBody` | It may have been discarded, or it belongs to another store. | ربما تكون قد أُلغيت، أو أنها تخص متجرًا آخر. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.load.schemaFailedTitle` | The form could not be loaded | تعذّر تحميل النموذج `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.load.schemaFailedBody` | The product type this draft was started under could not be read. | تعذّرت قراءة نوع المنتج الذي بدأت هذه المسودة تحته. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.steps.classification` | Identity | الهوية `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.steps.details` | Details | التفاصيل `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.steps.variants` | Variants | المتغيّرات `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.steps.listing` | Listing | الإعلان `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.steps.complete` | Nothing outstanding on this step. | لا شيء معلّق في هذه الخطوة. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.steps.incomplete` | This step still has something to fill in. | ما زال في هذه الخطوة ما يجب ملؤه. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.steps.next` | Continue | متابعة `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.classification.pinned` | The category and product type were fixed when this draft was started, so your answers keep their meaning. | حُدِّدت الفئة ونوع المنتج عند بدء هذه المسودة، حتى تحتفظ إجاباتك بمعناها. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.canonical.title` | Which catalogue product is this? | أي منتج في الكتالوج هو هذا؟ `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.canonical.body` | Choosing one links your listing to it directly and stops it being matched automatically. | اختيار واحد يربط إعلانك به مباشرةً ويمنع مطابقته تلقائيًا. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.canonical.notPermitted` | You do not have permission to link a catalogue product. | ليس لديك إذن لربط منتج من الكتالوج. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.canonical.unnamedVariant` | Unnamed configuration | تكوين بلا اسم `components/catalog-authoring/VariantRows.tsx` |
| `products.wizard.canonical.variantLabel` | Catalogue configuration | تكوين الكتالوج `components/catalog-authoring/VariantRows.tsx` |
| `products.wizard.canonical.variantPlaceholder` | Choose the matching configuration | اختر التكوين المطابق `components/catalog-authoring/VariantRows.tsx` |
| `products.wizard.canonical.clearVariant` | Clear the configuration | مسح التكوين `components/catalog-authoring/VariantRows.tsx` |
| `products.wizard.details.noFields` | This product type asks for no further details. | لا يطلب نوع المنتج هذا أي تفاصيل إضافية. `components/catalog-authoring/ProductFields.tsx` |
| `products.wizard.variants.noAxesAvailable` | This product type has no attributes that can define variants. | لا يملك نوع المنتج هذا سمات يمكنها تحديد المتغيّرات. `components/catalog-authoring/VariantAxes.tsx` |
| `products.wizard.variants.addAxisValue` | Add a value | إضافة قيمة `components/catalog-authoring/VariantAxes.tsx` |
| `products.wizard.variants.removeAxisValue` | Remove this value | إزالة هذه القيمة `components/catalog-authoring/VariantAxes.tsx` |
| `products.wizard.variants.generate` | Build the combinations | بناء التركيبات `components/catalog-authoring/VariantAxes.tsx` |
| `products.wizard.variants.tooManyCombinations` | That would be more than 200 combinations. Remove some values first. | سيتجاوز ذلك 200 تركيبة. أزل بعض القيم أولًا. `components/catalog-authoring/VariantAxes.tsx` |
| `products.wizard.variants.unsupportedAxisValue` | This attribute cannot be edited as a variant value here. | لا يمكن تحرير هذه السمة كقيمة متغيّر هنا. `components/catalog-authoring/VariantAxes.tsx` |
| `products.wizard.variants.duplicate` | The same combination appears earlier in the list. | التركيبة نفسها تظهر سابقًا في القائمة. `components/catalog-authoring/VariantRows.tsx` |
| `products.wizard.variants.sold` | Sold | معروض للبيع `components/catalog-authoring/VariantRows.tsx` |
| `products.wizard.variants.barcode` | Barcode | الباركود `components/catalog-authoring/VariantRows.tsx` |
| `products.wizard.variants.singleVariant` | One configuration | تكوين واحد `components/catalog-authoring/PricingRows.tsx` +2 |
| `products.wizard.variants.addSingle` | Add one configuration | إضافة تكوين واحد `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.pricing.bulkTitle` | Apply to every combination | تطبيق على كل تركيبة `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.bulkPriceLabel` | Price for every combination | السعر لكل تركيبة `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.bulkStockLabel` | Stock for every combination | المخزون لكل تركيبة `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.applyToAll` | Apply to all | تطبيق على الكل `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.price` | Price | السعر `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.compareAt` | Compare-at price | السعر قبل الخصم `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.currency` | Currency | العملة `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.stock` | Stock | المخزون `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.trackStock` | Track stock | تتبّع المخزون `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.pricing.noSoldVariants` | Switch on at least one combination to price it. | فعّل تركيبة واحدة على الأقل لتسعيرها. `components/catalog-authoring/PricingRows.tsx` |
| `products.wizard.listing.mediaTitle` | Photographs | الصور `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.listing.mediaUnavailable` | Photographs cannot be added from the dashboard yet. Any already attached to this draft are kept. | لا يمكن إضافة الصور من لوحة التحكم بعد. وتبقى أي صور مرفقة بهذه المسودة كما هي. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.review.category` | Category | الفئة `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.productType` | Product type | نوع المنتج `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.market` | Market | السوق `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.canonicalLink` | Catalogue product | منتج الكتالوج `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.canonicalNone` | None chosen | لم يُختر أي منتج `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.canonicalDeclared` | Chosen by you | اخترته بنفسك `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.fieldsAnswered` | Details answered | التفاصيل المُجاب عنها `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.soldVariants` | Combinations sold | التركيبات المعروضة للبيع `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.pricedVariants` | Combinations priced | التركيبات المسعّرة `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.empty` | Empty | فارغ `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.review.provided` | Provided | مُقدَّم `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.save.idle` | Not saved yet | لم يُحفظ بعد `components/catalog-authoring/WizardChrome.tsx` |
| `products.wizard.save.unsaved` | Unsaved changes | تغييرات غير محفوظة `components/catalog-authoring/WizardChrome.tsx` |
| `products.wizard.save.saving` | Saving… | جارٍ الحفظ… `components/catalog-authoring/WizardChrome.tsx` |
| `products.wizard.save.saved` | Saved | تم الحفظ `components/catalog-authoring/WizardChrome.tsx` |
| `products.wizard.save.failed` | Could not save — tap to retry | تعذّر الحفظ — اضغط لإعادة المحاولة `components/catalog-authoring/WizardChrome.tsx` |
| `products.wizard.save.retry` | Retry the save | إعادة محاولة الحفظ `components/catalog-authoring/WizardChrome.tsx` |
| `products.wizard.save.conflict` | Changed elsewhere — tap to reload | تغيّر في مكان آخر — اضغط لإعادة التحميل `components/catalog-authoring/WizardChrome.tsx` |
| `products.wizard.save.reload` | Reload the saved version | إعادة تحميل النسخة المحفوظة `app/(app)/products/wizard/[draftId].tsx` +1 |
| `products.wizard.save.conflictTitle` | This draft changed somewhere else | تغيّرت هذه المسودة في مكان آخر `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.save.conflictBody` | It was saved on another device, or it was published or discarded. Reload it to carry on; what is on screen is not being saved. | حُفظت على جهاز آخر، أو نُشرت أو أُلغيت. أعد تحميلها للمتابعة؛ ما هو معروض على الشاشة لا يجري حفظه. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.publish.check` | Check it | افحصه `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.publish.publish` | Publish | نشر `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.publish.published` | Product published. | تم نشر المنتج. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.publish.readyToPublish` | Everything checks out. | كل شيء سليم. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.publish.alreadyPublishedTitle` | This draft has already been published | سبق نشر هذه المسودة `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.publish.alreadyPublishedBody` | Its product now lives in your catalogue. | منتجها موجود الآن في كتالوجك. `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.publish.openListing` | Open the product | فتح المنتج `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.finding.categoryNotSelectable` | Products cannot be listed directly in this category. | لا يمكن إدراج المنتجات مباشرةً في هذه الفئة. `lib/authoring/findings.ts` |
| `products.wizard.finding.categoryNotInScope` | This product type does not cover the chosen category. | لا يغطي نوع المنتج هذا الفئة المختارة. `lib/authoring/findings.ts` |
| `products.wizard.finding.productTypeNotPublished` | This product type is not published. The draft keeps the version it was started under. | نوع المنتج هذا غير منشور. تحتفظ المسودة بالإصدار الذي بدأت تحته. `lib/authoring/findings.ts` |
| `products.wizard.finding.schemaSuperseded` | The form has changed since this draft was started. Review the upgrade before publishing. | تغيّر النموذج منذ أن بدأت هذه المسودة. راجع الترقية قبل النشر. `lib/authoring/findings.ts` |
| `products.wizard.finding.requiredFieldMissing` | This is still empty. | ما زال هذا فارغًا. `lib/authoring/findings.ts` |
| `products.wizard.finding.unknownField` | This answer belongs to a field the form no longer has. | تخص هذه الإجابة حقلًا لم يعد النموذج يحتوي عليه. `lib/authoring/findings.ts` |
| `products.wizard.finding.fieldForbidden` | This field cannot be filled in from here. | لا يمكن ملء هذا الحقل من هنا. `lib/authoring/findings.ts` |
| `products.wizard.finding.valueTypeMismatch` | That is not a value this field accepts. | هذه ليست قيمة يقبلها هذا الحقل. `lib/authoring/findings.ts` |
| `products.wizard.finding.valueNotInSet` | Choose one of the offered values. | اختر إحدى القيم المعروضة. `lib/authoring/findings.ts` |
| `products.wizard.finding.valueBelowMinimum` | That is below the smallest value allowed. | هذه أقل من أصغر قيمة مسموح بها. `lib/authoring/findings.ts` |
| `products.wizard.finding.valueAboveMaximum` | That is above the largest value allowed. | هذه أكبر من أكبر قيمة مسموح بها. `lib/authoring/findings.ts` |
| `products.wizard.finding.valueTooLong` | That is longer than this field allows. | هذه أطول مما يسمح به هذا الحقل. `lib/authoring/findings.ts` |
| `products.wizard.finding.tooManyDecimals` | That has more decimal places than this field allows. | تحتوي هذه على منازل عشرية أكثر مما يسمح به هذا الحقل. `lib/authoring/findings.ts` |
| `products.wizard.finding.valueImplausible` | That looks like a decimal-point mistake. Check it. | يبدو هذا خطأً في الفاصلة العشرية. تحقّق منه. `lib/authoring/findings.ts` |
| `products.wizard.finding.cardinalityExceeded` | This field takes fewer values than that. | يقبل هذا الحقل قيمًا أقل من ذلك. `lib/authoring/findings.ts` |
| `products.wizard.finding.rangeBoundsInverted` | The first value must not be higher than the second. | يجب ألا تكون القيمة الأولى أكبر من الثانية. `lib/authoring/findings.ts` |
| `products.wizard.finding.componentMissing` | One of the measurements is missing. | أحد القياسات مفقود. `lib/authoring/findings.ts` |
| `products.wizard.finding.unknownComponentAxis` | That measurement is not one this field declares. | هذا القياس ليس من القياسات التي يعلنها هذا الحقل. `lib/authoring/findings.ts` |
| `products.wizard.finding.unknownUnit` | Say which unit this is in. | حدّد الوحدة المستخدمة هنا. `lib/authoring/findings.ts` |
| `products.wizard.finding.unitNotInFamily` | That unit measures something else. | هذه الوحدة تقيس شيئًا آخر. `lib/authoring/findings.ts` |
| `products.wizard.finding.currencyMismatch` | This field has no currency to record the amount in. | لا توجد لهذا الحقل عملة لتسجيل المبلغ بها. `lib/authoring/findings.ts` |
| `products.wizard.finding.canonicalRefNotPermitted` | This field does not take a catalogue reference. | لا يقبل هذا الحقل مرجعًا من الكتالوج. `lib/authoring/findings.ts` |
| `products.wizard.finding.proposalNotPermitted` | You cannot propose a new value for this field. | لا يمكنك اقتراح قيمة جديدة لهذا الحقل. `lib/authoring/findings.ts` |
| `products.wizard.finding.noVariantDeclared` | Add at least one combination to sell. | أضف تركيبة واحدة على الأقل للبيع. `lib/authoring/findings.ts` |
| `products.wizard.finding.axisNotPermitted` | This attribute cannot define variants of this product type. | لا يمكن لهذه السمة تحديد متغيّرات نوع المنتج هذا. `lib/authoring/findings.ts` |
| `products.wizard.finding.axisValueMissing` | This combination is missing one of its values. | تنقص هذه التركيبة إحدى قيمها. `lib/authoring/findings.ts` |
| `products.wizard.finding.duplicateVariant` | Another combination has the same values. | توجد تركيبة أخرى بالقيم نفسها. `lib/authoring/findings.ts` |
| `products.wizard.finding.duplicateVariantSku` | Another variant already uses this SKU. | يستخدم متغيّر آخر رمز SKU هذا بالفعل. `lib/authoring/findings.ts` |
| `products.wizard.finding.priceMissing` | This combination has no price. | لا يوجد سعر لهذه التركيبة. `lib/authoring/findings.ts` |
| `products.wizard.finding.priceCurrencyMissing` | This price has no currency. | لا توجد عملة لهذا السعر. `lib/authoring/findings.ts` |
| `products.wizard.finding.inventoryNegative` | Stock cannot be negative. | لا يمكن أن يكون المخزون سالبًا. `lib/authoring/findings.ts` |
| `products.wizard.finding.titleMissing` | The listing needs a title. | يحتاج الإعلان إلى عنوان. `lib/authoring/findings.ts` |
| `products.wizard.finding.descriptionMissing` | The listing needs a description. | يحتاج الإعلان إلى وصف. `lib/authoring/findings.ts` |
| `products.wizard.finding.conditionMissing` | Say what condition this item is in. | حدّد حالة هذه السلعة. `lib/authoring/findings.ts` |
| `products.wizard.finding.proposalPending` | A proposed value is still waiting, and this product type blocks publishing until it is decided. | ما زالت هناك قيمة مقترحة قيد الانتظار، ونوع المنتج هذا يمنع النشر حتى يُبتّ فيها. `lib/authoring/findings.ts` |
| `products.wizard.finding.draftNotOpen` | This draft is no longer open. | لم تعد هذه المسودة مفتوحة. `lib/authoring/findings.ts` |

</details>

<details><summary><code>/settings</code> — 21</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.documentTitle` | Settings \| Mercaria Dashboard | الإعدادات \| Mercaria Dashboard `app/(app)/settings/index.tsx` |
| `settings.language.description` | The language this dashboard is shown in. Saved on this device; it does not change what your customers see. | اللغة التي تُعرض بها لوحة التحكم هذه. تُحفظ على هذا الجهاز، ولا تغيّر ما يراه عملاؤك. `components/settings/LanguagePicker.tsx` |
| `settings.language.title` | Language | اللغة `components/settings/LanguagePicker.tsx` |
| `settings.sections.channels.description` | Connect Shopify and other stores to sync | اربط Shopify ومتاجر أخرى للمزامنة `app/(app)/settings/index.tsx` |
| `settings.sections.channels.label` | Sales channels | قنوات البيع `app/(app)/settings/index.tsx` |
| `settings.sections.locations.description` | Where you stock inventory | أين تحتفظ بمخزونك `app/(app)/settings/index.tsx` |
| `settings.sections.locations.label` | Locations | المواقع `app/(app)/settings/index.tsx` |
| `settings.sections.members.description` | Invite, edit roles and permissions | ادعُ الأعضاء وعدّل الأدوار والأذونات `app/(app)/settings/index.tsx` |
| `settings.sections.members.label` | Members & roles | الأعضاء والأدوار `app/(app)/settings/index.tsx` |
| `settings.sections.payments.description` | Get paid for orders placed on Mercaria | احصل على أموالك مقابل الطلبات المقدَّمة على Mercaria `app/(app)/settings/index.tsx` |
| `settings.sections.payments.label` | Payments & payouts | المدفوعات والتحويلات `app/(app)/settings/index.tsx` |
| `settings.sections.plan.description` | What your store gets, and what you pay for it | ما يحصل عليه متجرك، وما تدفعه مقابله `app/(app)/settings/index.tsx` |
| `settings.sections.plan.label` | Plan & billing | الخطة والفوترة `app/(app)/settings/index.tsx` |
| `settings.sections.policies.description` | Returns, refund/privacy/terms, alerts | الإرجاع، وسياسات الاسترداد/الخصوصية/الشروط، والتنبيهات `app/(app)/settings/index.tsx` |
| `settings.sections.policies.label` | Policies & notifications | السياسات والإشعارات `app/(app)/settings/index.tsx` |
| `settings.sections.profile.description` | Name, handle, brand color, status | الاسم والمعرّف ولون العلامة والحالة `app/(app)/settings/index.tsx` |
| `settings.sections.profile.label` | Store profile | ملف المتجر `app/(app)/settings/index.tsx` |
| `settings.sections.tax.description` | Tax rates and tax behavior | معدلات الضريبة وسلوكها `app/(app)/settings/index.tsx` |
| `settings.sections.tax.label` | Taxes | الضرائب `app/(app)/settings/index.tsx` |
| `settings.subtitle` | Configure your store | اضبط إعدادات متجرك `app/(app)/settings/index.tsx` |
| `settings.title` | Settings | الإعدادات `app/(app)/settings/index.tsx` |

</details>

<details><summary><code>/settings/locations</code> — 17</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.locations.createFailed` | Couldn't create the location | تعذّر إنشاء الموقع `app/(app)/settings/locations.tsx` |
| `settings.locations.created` | Location created | تم إنشاء الموقع `app/(app)/settings/locations.tsx` |
| `settings.locations.defaultFlag` |  · default |  · افتراضي `app/(app)/settings/locations.tsx` |
| `settings.locations.deleteFailed` | Couldn't delete the location | تعذّر حذف الموقع `app/(app)/settings/locations.tsx` |
| `settings.locations.deleted` | Location deleted | تم حذف الموقع `app/(app)/settings/locations.tsx` |
| `settings.locations.documentTitle` | Locations \| Mercaria Dashboard | المواقع \| Mercaria Dashboard `app/(app)/settings/locations.tsx` |
| `settings.locations.inactiveFlag` |  · inactive |  · غير نشط `app/(app)/settings/locations.tsx` |
| `settings.locations.loadFailed` | Couldn't load locations | تعذّر تحميل المواقع `app/(app)/settings/locations.tsx` |
| `settings.locations.namePlaceholder` | Main warehouse | المستودع الرئيسي `app/(app)/settings/locations.tsx` |
| `settings.locations.nameRequired` | Name is required | الاسم مطلوب `app/(app)/settings/locations.tsx` |
| `settings.locations.newTitle` | New location | موقع جديد `app/(app)/settings/locations.tsx` |
| `settings.locations.subtitle` | Where you stock inventory | أين تحتفظ بمخزونك `app/(app)/settings/locations.tsx` |
| `settings.locations.title` | Locations | المواقع `app/(app)/settings/locations.tsx` |
| `settings.locations.types.popUp` | Pop-up | متجر مؤقت `app/(app)/settings/locations.tsx` |
| `settings.locations.types.retail` | Retail | متجر تجزئة `app/(app)/settings/locations.tsx` |
| `settings.locations.types.virtual` | Virtual | افتراضي `app/(app)/settings/locations.tsx` |
| `settings.locations.types.warehouse` | Warehouse | مستودع `app/(app)/settings/locations.tsx` |

</details>

<details><summary><code>/settings/locations, /settings/tax</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.name` | Name | الاسم `app/(app)/settings/locations.tsx` +1 |

</details>

<details><summary><code>/settings/members</code> — 20</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.members.addFailed` | Couldn't add the member | تعذّرت إضافة العضو `app/(app)/settings/members.tsx` |
| `settings.members.addMember` | Add member | إضافة عضو `app/(app)/settings/members.tsx` |
| `settings.members.added` | Member added | تمت إضافة العضو `app/(app)/settings/members.tsx` |
| `settings.members.documentTitle` | Members \| Mercaria Dashboard | الأعضاء \| Mercaria Dashboard `app/(app)/settings/members.tsx` |
| `settings.members.invite` | Invite | دعوة `app/(app)/settings/members.tsx` |
| `settings.members.inviteTitle` | Invite member | دعوة عضو `app/(app)/settings/members.tsx` |
| `settings.members.loadFailed` | Couldn't load members | تعذّر تحميل الأعضاء `app/(app)/settings/members.tsx` |
| `settings.members.oxyUserIdLabel` | Oxy user id | معرّف مستخدم Oxy `app/(app)/settings/members.tsx` |
| `settings.members.oxyUserIdPlaceholder` | oxy user id | معرّف مستخدم Oxy `app/(app)/settings/members.tsx` |
| `settings.members.oxyUserIdRequired` | Enter the member's Oxy user id | أدخل معرّف مستخدم Oxy الخاص بالعضو `app/(app)/settings/members.tsx` |
| `settings.members.removeFailed` | Couldn't remove the member | تعذّرت إزالة العضو `app/(app)/settings/members.tsx` |
| `settings.members.removed` | Member removed | تمت إزالة العضو `app/(app)/settings/members.tsx` |
| `settings.members.roleLabel` | Role | الدور `app/(app)/settings/members.tsx` |
| `settings.members.roleUpdateFailed` | Couldn't update the member | تعذّر تحديث العضو `app/(app)/settings/members.tsx` |
| `settings.members.roleUpdated` | Role updated | تم تحديث الدور `app/(app)/settings/members.tsx` |
| `settings.members.roles.admin` | Admin | مسؤول `app/(app)/settings/members.tsx` |
| `settings.members.roles.owner` | Owner | مالك `app/(app)/settings/members.tsx` |
| `settings.members.roles.staff` | Staff | موظف `app/(app)/settings/members.tsx` |
| `settings.members.subtitle` | Who can manage this store | من يمكنه إدارة هذا المتجر `app/(app)/settings/members.tsx` |
| `settings.members.title` | Members & roles | الأعضاء والأدوار `app/(app)/settings/members.tsx` |

</details>

<details><summary><code>/settings/payments</code> — 34</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.none` | None | بلا `app/(app)/settings/payments.tsx` |
| `settings.payments.beingReviewed` | Being reviewed | قيد المراجعة `app/(app)/settings/payments.tsx` |
| `settings.payments.documentTitle` | Payments & payouts \| Mercaria Dashboard | المدفوعات والتحويلات \| Mercaria Dashboard `app/(app)/settings/payments.tsx` |
| `settings.payments.dueBy` | Due by | مستحق بحلول `app/(app)/settings/payments.tsx` |
| `settings.payments.loadFailed` | Couldn't load payment settings | تعذّر تحميل إعدادات الدفع `app/(app)/settings/payments.tsx` |
| `settings.payments.neededNow` | Needed now | مطلوب الآن `app/(app)/settings/payments.tsx` |
| `settings.payments.onboardingUnavailable` | Payout setup is not available on this Mercaria deployment yet. | إعداد التحويلات المالية غير متاح بعد في نسخة Mercaria هذه. `app/(app)/settings/payments.tsx` |
| `settings.payments.openFailed` | Couldn't open the payout setup | تعذّر فتح إعداد التحويلات المالية `app/(app)/settings/payments.tsx` |
| `settings.payments.outstandingTitle` | Outstanding with Stripe | المعلّق لدى Stripe `app/(app)/settings/payments.tsx` |
| `settings.payments.paidOutIn` | Paid out in | تُحوَّل بعملة `app/(app)/settings/payments.tsx` |
| `settings.payments.payoutsTitle` | Payouts | التحويلات المالية `app/(app)/settings/payments.tsx` |
| `settings.payments.quoteToSupport` | Quote this to Mercaria support if you need help. | اذكر هذا لدعم Mercaria إذا احتجت إلى مساعدة. `app/(app)/settings/payments.tsx` |
| `settings.payments.registeredIn` | Registered in | مسجَّل في `app/(app)/settings/payments.tsx` |
| `settings.payments.reportedByStripe` | Reported by Stripe | بحسب Stripe `app/(app)/settings/payments.tsx` |
| `settings.payments.requirementsNote` | Stripe holds these details and is the only place to complete them. Mercaria never sees them. | تحتفظ Stripe بهذه البيانات وهي المكان الوحيد لاستكمالها. لا تطّلع Mercaria عليها أبدًا. `app/(app)/settings/payments.tsx` |
| `settings.payments.schedule` | Schedule | الجدول `app/(app)/settings/payments.tsx` |
| `settings.payments.states.actionRequired.action` | Continue setup | متابعة الإعداد `app/(app)/settings/payments.tsx` |
| `settings.payments.states.actionRequired.body` | Stripe needs more information before it can pay you out. Until it has everything, buyers cannot check out with your listings. | تحتاج Stripe إلى مزيد من المعلومات قبل أن تتمكن من تحويل أموالك. وإلى أن تكتمل لديها، لن يتمكن المشترون من إتمام الشراء من إعلاناتك. `app/(app)/settings/payments.tsx` |
| `settings.payments.states.actionRequired.heading` | A few details are still needed | ما زالت بعض البيانات مطلوبة `app/(app)/settings/payments.tsx` |
| `settings.payments.states.disabled.body` | Stripe has closed this connected account, or its connection to Mercaria was removed. Buyers cannot check out with your listings. Contact Mercaria support to look into it. | أغلقت Stripe هذا الحساب المرتبط، أو أُزيل ارتباطه بـ Mercaria. لا يمكن للمشترين إتمام الشراء من إعلاناتك. تواصل مع دعم Mercaria لبحث الأمر. `app/(app)/settings/payments.tsx` |
| `settings.payments.states.disabled.heading` | This account can no longer be used | لم يعد بالإمكان استخدام هذا الحساب `app/(app)/settings/payments.tsx` |
| `settings.payments.states.notConnected.action` | Set up payouts | إعداد التحويلات المالية `app/(app)/settings/payments.tsx` |
| `settings.payments.states.notConnected.body` | Your listings are visible and you can use every other part of Mercaria, but buyers cannot check out with them yet. Setting up payouts takes a few minutes. | إعلاناتك ظاهرة ويمكنك استخدام كل أجزاء Mercaria الأخرى، لكن لا يمكن للمشترين إتمام الشراء منها بعد. لا يستغرق إعداد التحويلات المالية سوى بضع دقائق. `app/(app)/settings/payments.tsx` |
| `settings.payments.states.notConnected.heading` | Not set up yet | لم يُعد بعد `app/(app)/settings/payments.tsx` |
| `settings.payments.states.ready.action` | Manage payout details | إدارة بيانات التحويل `app/(app)/settings/payments.tsx` |
| `settings.payments.states.ready.body` | Buyers can check out with your listings, and Stripe pays your balance out to your bank. | يمكن للمشترين إتمام الشراء من إعلاناتك، وتحوّل Stripe رصيدك إلى حسابك المصرفي. `app/(app)/settings/payments.tsx` |
| `settings.payments.states.ready.heading` | Ready to be paid | جاهز لاستلام المدفوعات `app/(app)/settings/payments.tsx` |
| `settings.payments.states.restricted.action` | Resolve now | عالج الأمر الآن `app/(app)/settings/payments.tsx` |
| `settings.payments.states.restricted.body` | Something Stripe asked for is now overdue, so it has paused payouts and buyers cannot check out with your listings. Finishing it restores both. | تأخّر تقديم شيء طلبته Stripe، فأوقفت التحويلات مؤقتًا ولم يعد بإمكان المشترين إتمام الشراء من إعلاناتك. استكماله يعيد الأمرين معًا. `app/(app)/settings/payments.tsx` |
| `settings.payments.states.restricted.heading` | Payouts are paused | التحويلات المالية متوقفة مؤقتًا `app/(app)/settings/payments.tsx` |
| `settings.payments.states.underReview.body` | Stripe has what it asked for and is reviewing it. There is nothing for you to do — this usually takes a day or two. Buyers cannot check out with your listings until it finishes. | استلمت Stripe ما طلبته وهي تراجعه. لا يوجد ما تفعله — يستغرق ذلك عادةً يومًا أو يومين. لا يمكن للمشترين إتمام الشراء من إعلاناتك حتى تنتهي المراجعة. `app/(app)/settings/payments.tsx` |
| `settings.payments.states.underReview.heading` | Under review | قيد المراجعة `app/(app)/settings/payments.tsx` |
| `settings.payments.subtitle` | How you get paid for orders placed on Mercaria | كيف تحصل على أموالك مقابل الطلبات المقدَّمة على Mercaria `app/(app)/settings/payments.tsx` |
| `settings.payments.title` | Payments & payouts | المدفوعات والتحويلات `app/(app)/settings/payments.tsx` |

</details>

<details><summary><code>/settings/plan</code> — 29</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.plan.alwaysIncludedBody` | Maintaining your catalogue, receiving and fulfilling orders, issuing refunds, reading your own sales and payout records, and exporting your data are free for every Mercaria store and are never part of a plan. Nothing on this page can change that, and no plan affects how your listings are found or ranked. | إدارة كتالوجك، واستلام الطلبات وتنفيذها، وإصدار المبالغ المستردة، والاطلاع على سجلات مبيعاتك وتحويلاتك، وتصدير بياناتك — كل ذلك مجاني لكل متجر على Mercaria وليس جزءًا من أي خطة أبدًا. لا شيء في هذه الصفحة يمكنه تغيير ذلك، ولا تؤثر أي خطة على كيفية العثور على إعلاناتك أو ترتيبها. `app/(app)/settings/plan.tsx` |
| `settings.plan.alwaysIncludedTitle` | Always included | مشمول دائمًا `app/(app)/settings/plan.tsx` |
| `settings.plan.cancelFailed` | Couldn't cancel. Please try again. | تعذّر الإلغاء. يرجى المحاولة مرة أخرى. `app/(app)/settings/plan.tsx` |
| `settings.plan.cancelPlan` | Cancel plan | إلغاء الخطة `app/(app)/settings/plan.tsx` |
| `settings.plan.documentTitle` | Plan & billing \| Mercaria Dashboard | الخطة والفوترة \| Mercaria Dashboard `app/(app)/settings/plan.tsx` |
| `settings.plan.free` | Free | مجانية `app/(app)/settings/plan.tsx` |
| `settings.plan.loadFailed` | Couldn't load your plan | تعذّر تحميل خطتك `app/(app)/settings/plan.tsx` |
| `settings.plan.manageBilling` | Manage billing | إدارة الفوترة `app/(app)/settings/plan.tsx` |
| `settings.plan.noExtras` | No plan extras are active on this store. | لا توجد مزايا خطة مفعّلة على هذا المتجر. `app/(app)/settings/plan.tsx` |
| `settings.plan.noPaidPlans` | There are no paid plans available yet. When there are, everything they include will be listed here with its price before you agree to anything. | لا توجد خطط مدفوعة متاحة بعد. وعندما تتوفر، سيُدرج هنا كل ما تشمله مع سعره قبل أن توافق على أي شيء. `app/(app)/settings/plan.tsx` |
| `settings.plan.notOnPaidPlan` | You are not on a paid plan. Everything listed above is included. | أنت لست على خطة مدفوعة. كل ما هو مذكور أعلاه مشمول. `app/(app)/settings/plan.tsx` |
| `settings.plan.paidPlansTitle` | Paid plans | الخطط المدفوعة `app/(app)/settings/plan.tsx` |
| `settings.plan.portalFailed` | Couldn't open billing. Please try again. | تعذّر فتح الفوترة. يرجى المحاولة مرة أخرى. `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.active.body` | Your plan renews automatically. You can cancel at any time and keep it until the end of the period you have paid for. | تتجدد خطتك تلقائيًا. يمكنك الإلغاء في أي وقت والاحتفاظ بها حتى نهاية الفترة التي دفعت مقابلها. `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.active.heading` | Active | نشطة `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.cancelled.body` | You keep this plan's extras until the date below. Nothing else changes. | تحتفظ بمزايا هذه الخطة حتى التاريخ أدناه. لا يتغير أي شيء آخر. `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.cancelled.heading` | Cancels at the end of the period | تُلغى في نهاية الفترة `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.expired.body` | This plan's extras are no longer active. Everything included for free is unchanged. | لم تعد مزايا هذه الخطة مفعّلة. وكل ما هو مشمول مجانًا لم يتغير. `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.expired.heading` | Ended | انتهت `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.pastDue.body` | Your catalogue, orders, refunds and records are unaffected and will stay that way. Only this plan's extras are affected, and only after the date below. | كتالوجك وطلباتك ومبالغك المستردة وسجلاتك غير متأثرة وستبقى كذلك. المتأثر هو مزايا هذه الخطة فقط، وبعد التاريخ أدناه فقط. `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.pastDue.heading` | We could not take the last payment | تعذّر علينا تحصيل الدفعة الأخيرة `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.paused.body` | This plan's extras are not active while it is paused. | مزايا هذه الخطة غير مفعّلة أثناء إيقافها المؤقت. `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.paused.heading` | Paused | موقوفة مؤقتًا `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.trialing.body` | You have full access to this plan's extras until the trial ends. | لديك وصول كامل إلى مزايا هذه الخطة حتى تنتهي الفترة التجريبية. `app/(app)/settings/plan.tsx` |
| `settings.plan.statuses.trialing.heading` | Trial in progress | فترة تجريبية جارية `app/(app)/settings/plan.tsx` |
| `settings.plan.subtitle` | What your store gets, and what you pay for it | ما يحصل عليه متجرك، وما تدفعه مقابله `app/(app)/settings/plan.tsx` |
| `settings.plan.title` | Plan & billing | الخطة والفوترة `app/(app)/settings/plan.tsx` |
| `settings.plan.upgradeFailed` | Couldn't start the upgrade. Please try again. | تعذّر بدء الترقية. يرجى المحاولة مرة أخرى. `app/(app)/settings/plan.tsx` |
| `settings.plan.usageIncluded` | included | مشمول `app/(app)/settings/plan.tsx` |

</details>

<details><summary><code>/settings/policies</code> — 17</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.policies.documentTitle` | Policies \| Mercaria Dashboard | السياسات \| Mercaria Dashboard `app/(app)/settings/policies.tsx` |
| `settings.policies.loadFailed` | Couldn't load settings | تعذّر تحميل الإعدادات `app/(app)/settings/policies.tsx` |
| `settings.policies.lowStockAlerts` | Low-stock alerts | تنبيهات انخفاض المخزون `app/(app)/settings/policies.tsx` |
| `settings.policies.notifications` | Notifications | الإشعارات `app/(app)/settings/policies.tsx` |
| `settings.policies.orderEmails` | Order emails | رسائل الطلبات `app/(app)/settings/policies.tsx` |
| `settings.policies.privacyPolicyLabel` | Privacy policy | سياسة الخصوصية `app/(app)/settings/policies.tsx` |
| `settings.policies.privacyPolicyPlaceholder` | Your privacy policy… | سياسة الخصوصية الخاصة بك… `app/(app)/settings/policies.tsx` |
| `settings.policies.refundPolicyLabel` | Refund policy | سياسة الاسترداد `app/(app)/settings/policies.tsx` |
| `settings.policies.refundPolicyPlaceholder` | Your refund policy… | سياسة الاسترداد الخاصة بك… `app/(app)/settings/policies.tsx` |
| `settings.policies.returnWindowLabel` | Return window (days) | مهلة الإرجاع (بالأيام) `app/(app)/settings/policies.tsx` |
| `settings.policies.saveFailed` | Couldn't save settings | تعذّر حفظ الإعدادات `app/(app)/settings/policies.tsx` |
| `settings.policies.saveSettings` | Save settings | حفظ الإعدادات `app/(app)/settings/policies.tsx` |
| `settings.policies.saved` | Settings saved | تم حفظ الإعدادات `app/(app)/settings/policies.tsx` |
| `settings.policies.subtitle` | Store-wide rules and alerts | قواعد وتنبيهات على مستوى المتجر `app/(app)/settings/policies.tsx` |
| `settings.policies.termsLabel` | Terms of service | شروط الخدمة `app/(app)/settings/policies.tsx` |
| `settings.policies.termsPlaceholder` | Your terms of service… | شروط الخدمة الخاصة بك… `app/(app)/settings/policies.tsx` |
| `settings.policies.title` | Policies & notifications | السياسات والإشعارات `app/(app)/settings/policies.tsx` |

</details>

<details><summary><code>/settings/store</code> — 9</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.store.brandColorLabel` | Brand color | لون العلامة التجارية `app/(app)/settings/store.tsx` |
| `settings.store.documentTitle` | Store profile \| Mercaria Dashboard | ملف المتجر \| Mercaria Dashboard `app/(app)/settings/store.tsx` |
| `settings.store.loadFailed` | Couldn't load store | تعذّر تحميل المتجر `app/(app)/settings/store.tsx` |
| `settings.store.nameLabel` | Store name | اسم المتجر `app/(app)/settings/store.tsx` |
| `settings.store.nameRequired` | Store name is required | اسم المتجر مطلوب `app/(app)/settings/store.tsx` |
| `settings.store.saveChanges` | Save changes | حفظ التغييرات `app/(app)/settings/store.tsx` |
| `settings.store.title` | Store profile | ملف المتجر `app/(app)/settings/store.tsx` |
| `settings.store.updateFailed` | Couldn't update the store | تعذّر تحديث المتجر `app/(app)/settings/store.tsx` |
| `settings.store.updated` | Store updated | تم تحديث المتجر `app/(app)/settings/store.tsx` |

</details>

<details><summary><code>/settings/tax</code> — 20</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.tax.active` | active | نشط `app/(app)/settings/tax.tsx` |
| `settings.tax.countryLabel` | Country (ISO-2) | الدولة (ISO-2) `app/(app)/settings/tax.tsx` |
| `settings.tax.createFailed` | Couldn't create the rate | تعذّر إنشاء المعدل `app/(app)/settings/tax.tsx` |
| `settings.tax.created` | Tax rate created | تم إنشاء معدل الضريبة `app/(app)/settings/tax.tsx` |
| `settings.tax.deleteFailed` | Couldn't delete the rate | تعذّر حذف المعدل `app/(app)/settings/tax.tsx` |
| `settings.tax.deleted` | Tax rate deleted | تم حذف معدل الضريبة `app/(app)/settings/tax.tsx` |
| `settings.tax.documentTitle` | Taxes \| Mercaria Dashboard | الضرائب \| Mercaria Dashboard `app/(app)/settings/tax.tsx` |
| `settings.tax.emptyBody` | Add a rate to charge tax at checkout. | أضف معدلًا لتحصيل الضريبة عند الدفع. `app/(app)/settings/tax.tsx` |
| `settings.tax.emptyTitle` | No tax rates | لا توجد معدلات ضريبة `app/(app)/settings/tax.tsx` |
| `settings.tax.inactive` | inactive | غير نشط `app/(app)/settings/tax.tsx` |
| `settings.tax.invalidRate` | Enter a valid rate | أدخل معدلًا صالحًا `app/(app)/settings/tax.tsx` |
| `settings.tax.loadFailed` | Couldn't load tax rates | تعذّر تحميل معدلات الضريبة `app/(app)/settings/tax.tsx` |
| `settings.tax.namePlaceholder` | US Sales Tax | ضريبة المبيعات الأمريكية `app/(app)/settings/tax.tsx` |
| `settings.tax.nameRequired` | Name is required | الاسم مطلوب `app/(app)/settings/tax.tsx` |
| `settings.tax.newRate` | New rate | معدل جديد `app/(app)/settings/tax.tsx` |
| `settings.tax.newRateTitle` | New tax rate | معدل ضريبة جديد `app/(app)/settings/tax.tsx` |
| `settings.tax.rateLabel` | Rate (%) | المعدل (%) `app/(app)/settings/tax.tsx` |
| `settings.tax.regionLabel` | Region | المنطقة `app/(app)/settings/tax.tsx` |
| `settings.tax.subtitle` | Tax rates applied at checkout | معدلات الضريبة المطبَّقة عند الدفع `app/(app)/settings/tax.tsx` |
| `settings.tax.title` | Taxes | الضرائب `app/(app)/settings/tax.tsx` |

</details>

<details><summary><code>/stores</code> — 14</summary>

| key | English | Arabic file |
|---|---|---|---|
| `stores.create.descriptionPlaceholder` | What do you sell? | ماذا تبيع؟ `app/(app)/stores.tsx` |
| `stores.create.dialogTitle` | Create a store | إنشاء متجر `app/(app)/stores.tsx` |
| `stores.create.error` | Couldn't create the store | تعذّر إنشاء المتجر `app/(app)/stores.tsx` |
| `stores.create.nameLabel` | Store name | اسم المتجر `app/(app)/stores.tsx` |
| `stores.create.nameRequired` | Store name is required | اسم المتجر مطلوب `app/(app)/stores.tsx` |
| `stores.create.success` | Store created | تم إنشاء المتجر `app/(app)/stores.tsx` |
| `stores.createStore` | Create store | إنشاء متجر `app/(app)/stores.tsx` |
| `stores.documentTitle` | Stores \| Mercaria Dashboard | المتاجر \| Mercaria Dashboard `app/(app)/stores.tsx` |
| `stores.empty.body` | Create your first store to start selling on Mercaria. | أنشئ متجرك الأول لتبدأ البيع على Mercaria. `app/(app)/stores.tsx` |
| `stores.empty.title` | No stores yet | لا توجد متاجر بعد `app/(app)/stores.tsx` |
| `stores.loadError` | Couldn't load your stores | تعذّر تحميل متاجرك `app/(app)/stores.tsx` |
| `stores.newStore` | New store | متجر جديد `app/(app)/stores.tsx` |
| `stores.subtitle` | Pick a store to manage | اختر متجرًا لإدارته `app/(app)/stores.tsx` |
| `stores.title` | Your stores | متاجرك `app/(app)/stores.tsx` |

</details>

### `pos` — 124 strings

<details><summary><code>(component) components/register/ProductTile.tsx</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `catalog.soldOut` | Sold out | نفدت الكمية `components/register/ProductTile.tsx` |

</details>

<details><summary><code>(component) components/register/ProductTile.tsx, (component) components/register/VariantPickerSheet.tsx, /</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `catalog.outOfStock` | Out of stock | نفد من المخزون `components/register/CatalogPane.tsx` +2 |

</details>

<details><summary><code>(component) components/register/VariantPickerSheet.tsx</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `catalog.chooseVariant` | Choose a variant | اختر متغيّرًا `components/register/VariantPickerSheet.tsx` |

</details>

<details><summary><code>/</code> — 11</summary>

| key | English | Arabic file |
|---|---|---|---|
| `catalog.add` | Add | إضافة `components/register/CatalogPane.tsx` |
| `catalog.codePlaceholder` | Scan or type SKU / barcode | امسح أو اكتب رمز SKU / الباركود `components/register/CatalogPane.tsx` |
| `catalog.emptyBody` | Nothing matches your search. | لا شيء يطابق بحثك. `components/register/CatalogPane.tsx` |
| `catalog.emptyTitle` | No products | لا توجد منتجات `components/register/CatalogPane.tsx` |
| `catalog.loadFailed` | Couldn't load the catalog | تعذّر تحميل الكتالوج `components/register/CatalogPane.tsx` |
| `catalog.lookupFailed` | Lookup failed | تعذّر البحث `components/register/CatalogPane.tsx` |
| `catalog.noProductForCode` | No product for that code | لا يوجد منتج بهذا الرمز `components/register/CatalogPane.tsx` |
| `catalog.searchPlaceholder` | Search the catalog | ابحث في الكتالوج `components/register/CatalogPane.tsx` |
| `common.all` | All | الكل `components/register/CatalogPane.tsx` |
| `register.documentTitle` | Register \| Mercaria POS | الصندوق \| Mercaria POS `app/(app)/index.tsx` |
| `register.reviewCart` | Review cart | مراجعة السلة `app/(app)/index.tsx` |

</details>

<details><summary><code>/_layout</code> — 7</summary>

| key | English | Arabic file |
|---|---|---|---|
| `auth.signIn` | Sign in | تسجيل الدخول `components/AuthGate.tsx` |
| `auth.signInBody` | Sign in with your Oxy account to open the register — ring up in-person sales, attach customers, and charge. | سجّل الدخول بحساب Oxy لفتح الصندوق — سجّل المبيعات الحضورية، وأرفِق العملاء، وحصّل المدفوعات. `components/AuthGate.tsx` |
| `common.retry` | Try again | إعادة المحاولة `components/error-boundary.tsx` |
| `common.somethingWentWrong` | Something went wrong | حدث خطأ ما `components/error-boundary.tsx` |
| `errors.unexpectedBody` | An unexpected error occurred. You can try again, and if the problem persists, our team has been notified. | حدث خطأ غير متوقع. يمكنك إعادة المحاولة، وإذا استمرت المشكلة فقد أُبلغ فريقنا بها. `components/error-boundary.tsx` |
| `nav.collapseSidebar` | Collapse sidebar | طيّ الشريط الجانبي `components/shell/Sidebar.tsx` |
| `nav.expandSidebar` | Expand sidebar | توسيع الشريط الجانبي `components/shell/Sidebar.tsx` |

</details>

<details><summary><code>/, /_layout</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `nav.register` | Register | الصندوق `app/(app)/index.tsx` +1 |

</details>

<details><summary><code>/, /cart</code> — 13</summary>

| key | English | Arabic file |
|---|---|---|---|
| `cart.addCustomer` | Add customer | إضافة عميل `components/register/CartPanel.tsx` |
| `cart.clear` | Clear | مسح `components/register/CartPanel.tsx` |
| `cart.clearCart` | Clear cart | إفراغ السلة `components/register/CartPanel.tsx` |
| `cart.customerAttached` | Attached to this sale | مُرفَق بهذه العملية `components/register/CartPanel.tsx` |
| `cart.decreaseQuantity` | Decrease quantity | إنقاص الكمية `components/register/CartPanel.tsx` |
| `cart.discountCodePlaceholder` | Discount code | رمز الخصم `components/register/CartPanel.tsx` |
| `cart.emptyBody` | Tap products to add them to the sale. | اضغط على المنتجات لإضافتها إلى العملية. `components/register/CartPanel.tsx` |
| `cart.emptyTitle` | Cart is empty | السلة فارغة `components/register/CartPanel.tsx` |
| `cart.increaseQuantity` | Increase quantity | زيادة الكمية `components/register/CartPanel.tsx` |
| `cart.removeItem` | Remove item | إزالة العنصر `components/register/CartPanel.tsx` |
| `cart.subtotal` | Subtotal | المجموع الفرعي `components/register/CartPanel.tsx` |
| `cart.title` | Cart | السلة `components/register/CartPanel.tsx` |
| `common.optional` | Optional | اختياري `components/register/CartPanel.tsx` |

</details>

<details><summary><code>/, /cart, /charge</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `errors.noRegisterAccessBody` | You don't have permission to use the register for the active store. | ليس لديك إذن لاستخدام الصندوق للمتجر النشط. `components/shell/RequirePos.tsx` |

</details>

<details><summary><code>/, /cart, /charge, /customer</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `customer.fallbackName` | Customer | عميل `app/(app)/charge.tsx` +2 |

</details>

<details><summary><code>/, /cart, /charge, /customer, /receipt/[id], /sales</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.noAccess` | No access | لا يوجد وصول `components/shell/RequirePos.tsx` +1 |

</details>

<details><summary><code>/, /charge</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `charge.action` | Charge | تحصيل `app/(app)/charge.tsx` +1 |

</details>

<details><summary><code>/, /customer, /sales, /store-setup</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.pleaseTryAgain` | Please try again. | يرجى المحاولة مرة أخرى. `app/(app)/customer.tsx` +3 |

</details>

<details><summary><code>/, /sales</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `nav.selectStore` | Select store | اختيار المتجر `components/shell/StoreSwitcher.tsx` |
| `nav.switchStore` | Switch store | تبديل المتجر `components/shell/StoreSwitcher.tsx` |

</details>

<details><summary><code>/+not-found</code> — 4</summary>

| key | English | Arabic file |
|---|---|---|---|
| `errors.notFoundAction` | Go to the register | الذهاب إلى الصندوق `app/+not-found.tsx` |
| `errors.notFoundBody` | This screen doesn't exist. | هذه الشاشة غير موجودة. `app/+not-found.tsx` |
| `errors.notFoundDocumentTitle` | 404 - Not Found \| Mercaria POS | 404 - غير موجود \| Mercaria POS `app/+not-found.tsx` |
| `errors.notFoundHeading` | Oops! | عذرًا! `app/+not-found.tsx` |

</details>

<details><summary><code>/cart</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `cart.documentTitle` | Cart \| Mercaria POS | السلة \| Mercaria POS `app/(app)/cart.tsx` |

</details>

<details><summary><code>/charge</code> — 10</summary>

| key | English | Arabic file |
|---|---|---|---|
| `charge.customer` | Customer | العميل `app/(app)/charge.tsx` |
| `charge.documentTitle` | Charge \| Mercaria POS | التحصيل \| Mercaria POS `app/(app)/charge.tsx` |
| `charge.expectedTotal` | Expected total | الإجمالي المتوقع `app/(app)/charge.tsx` |
| `charge.failed` | Charge failed | تعذّر التحصيل `app/(app)/charge.tsx` |
| `charge.finalTotalNote` | Final total (discounts & tax) is computed when the sale is taken. | يُحتسب الإجمالي النهائي (الخصومات والضريبة) عند إتمام العملية. `app/(app)/charge.tsx` |
| `charge.subtitle` | Review and take the sale | راجع العملية وأتمِمها `app/(app)/charge.tsx` |
| `charge.tender` | Tender | طريقة الدفع `app/(app)/charge.tsx` |
| `charge.tenderCard` | Card | بطاقة `app/(app)/charge.tsx` |
| `charge.tenderCash` | Cash | نقدًا `app/(app)/charge.tsx` |
| `charge.title` | Charge | التحصيل `app/(app)/charge.tsx` |

</details>

<details><summary><code>/charge, /customer</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `customer.walkIn` | Walk-in | عميل عابر `app/(app)/charge.tsx` +1 |

</details>

<details><summary><code>/customer</code> — 18</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.name` | Name | الاسم `app/(app)/customer.tsx` |
| `customer.addAndAttach` | Add & attach | إضافة وإرفاق `app/(app)/customer.tsx` |
| `customer.addFailed` | Couldn't add the customer | تعذّرت إضافة العميل `app/(app)/customer.tsx` |
| `customer.added` | Customer added | تمت إضافة العميل `app/(app)/customer.tsx` |
| `customer.documentTitle` | Customer \| Mercaria POS | العميل \| Mercaria POS `app/(app)/customer.tsx` |
| `customer.email` | Email | البريد الإلكتروني `app/(app)/customer.tsx` |
| `customer.emailPlaceholder` | jane@example.com | sara@example.com `app/(app)/customer.tsx` |
| `customer.loadFailed` | Couldn't load customers | تعذّر تحميل العملاء `app/(app)/customer.tsx` |
| `customer.namePlaceholder` | Jane Doe | سارة أحمد `app/(app)/customer.tsx` |
| `customer.noMatches` | No customers match. | لا يوجد عملاء مطابقون. `app/(app)/customer.tsx` |
| `customer.phone` | Phone | الهاتف `app/(app)/customer.tsx` |
| `customer.phonePlaceholder` | +1 555 0100 | +971 50 123 4567 `app/(app)/customer.tsx` |
| `customer.quickAdd` | Quick add | إضافة سريعة `app/(app)/customer.tsx` |
| `customer.quickAddEmpty` | Enter a name, email or phone | أدخل اسمًا أو بريدًا إلكترونيًا أو رقم هاتف `app/(app)/customer.tsx` |
| `customer.searchPlaceholder` | Search customers | ابحث عن العملاء `app/(app)/customer.tsx` |
| `customer.subtitle` | Attach a customer or keep it a walk-in | أرفِق عميلًا أو أبقِها عملية لعميل عابر `app/(app)/customer.tsx` |
| `customer.title` | Customer | العميل `app/(app)/customer.tsx` |
| `customer.walkInOption` | Walk-in (no customer) | عميل عابر (بدون عميل مسجَّل) `app/(app)/customer.tsx` |

</details>

<details><summary><code>/customer, /receipt/[id], /sales</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.noAccessBody` | You don't have permission to view this area for the active store. | ليس لديك إذن لعرض هذا القسم للمتجر النشط. `components/shell/RequireStore.tsx` |

</details>

<details><summary><code>/receipt/[id]</code> — 11</summary>

| key | English | Arabic file |
|---|---|---|---|
| `receipt.discount` | Discount | الخصم `app/(app)/receipt/[id].tsx` |
| `receipt.documentTitle` | Receipt \| Mercaria POS | الإيصال \| Mercaria POS `app/(app)/receipt/[id].tsx` |
| `receipt.loadFailed` | Couldn't load the receipt | تعذّر تحميل الإيصال `app/(app)/receipt/[id].tsx` |
| `receipt.loadFailedBody` | The order may not be available. | قد يكون الطلب غير متاح. `app/(app)/receipt/[id].tsx` |
| `receipt.newSale` | New sale | عملية بيع جديدة `app/(app)/receipt/[id].tsx` |
| `receipt.paymentRecorded` | Payment recorded | تم تسجيل الدفعة `app/(app)/receipt/[id].tsx` |
| `receipt.saleComplete` | Sale complete | اكتملت العملية `app/(app)/receipt/[id].tsx` |
| `receipt.subtotal` | Subtotal | المجموع الفرعي `app/(app)/receipt/[id].tsx` |
| `receipt.tax` | Tax | الضريبة `app/(app)/receipt/[id].tsx` |
| `receipt.title` | Receipt | الإيصال `app/(app)/receipt/[id].tsx` |
| `receipt.total` | Total | الإجمالي `app/(app)/receipt/[id].tsx` |

</details>

<details><summary><code>/receipt/[id], /sales, /store-setup</code> — 15</summary>

| key | English | Arabic file |
|---|---|---|---|
| `locations.type.popUp` | Pop-up | متجر مؤقت `lib/order-labels.ts` |
| `locations.type.retail` | Retail | متجر تجزئة `lib/order-labels.ts` |
| `locations.type.virtual` | Virtual | افتراضي `lib/order-labels.ts` |
| `locations.type.warehouse` | Warehouse | مستودع `lib/order-labels.ts` |
| `orders.channel.draft` | Draft | مسودة `lib/order-labels.ts` |
| `orders.channel.pos` | Point of sale | نقطة البيع `lib/order-labels.ts` |
| `orders.channel.storefront` | Storefront | المتجر الإلكتروني `lib/order-labels.ts` |
| `orders.status.cancelled` | Cancelled | ملغى `lib/order-labels.ts` |
| `orders.status.delivered` | Delivered | تم التسليم `lib/order-labels.ts` |
| `orders.status.paid` | Paid | مدفوع `lib/order-labels.ts` |
| `orders.status.partiallyRefunded` | Partially refunded | مُسترد جزئيًا `lib/order-labels.ts` |
| `orders.status.pendingPayment` | Pending payment | بانتظار الدفع `lib/order-labels.ts` |
| `orders.status.processing` | Processing | قيد المعالجة `lib/order-labels.ts` |
| `orders.status.refunded` | Refunded | مُسترد `lib/order-labels.ts` |
| `orders.status.shipped` | Shipped | تم الشحن `lib/order-labels.ts` |

</details>

<details><summary><code>/sales</code> — 8</summary>

| key | English | Arabic file |
|---|---|---|---|
| `common.next` | Next | التالي `app/(app)/sales.tsx` |
| `common.previous` | Previous | السابق `app/(app)/sales.tsx` |
| `nav.sales` | Sales | المبيعات `app/(app)/sales.tsx` |
| `sales.documentTitle` | Sales \| Mercaria POS | المبيعات \| Mercaria POS `app/(app)/sales.tsx` |
| `sales.emptyBody` | Completed sales will appear here. | ستظهر العمليات المكتملة هنا. `app/(app)/sales.tsx` |
| `sales.emptyTitle` | No sales yet | لا توجد مبيعات بعد `app/(app)/sales.tsx` |
| `sales.loadFailed` | Couldn't load sales | تعذّر تحميل المبيعات `app/(app)/sales.tsx` |
| `sales.subtitle` | Recent orders | أحدث الطلبات `app/(app)/sales.tsx` |

</details>

<details><summary><code>/store-setup</code> — 13</summary>

| key | English | Arabic file |
|---|---|---|---|
| `storeSetup.changeStore` | Change store | تغيير المتجر `app/(app)/store-setup.tsx` |
| `storeSetup.chooseRegisterSubtitle` | Pick the location this register commits stock at | اختر الموقع الذي يخصم منه هذا الصندوق المخزون `app/(app)/store-setup.tsx` |
| `storeSetup.chooseRegisterTitle` | Choose a register | اختر صندوقًا `app/(app)/store-setup.tsx` |
| `storeSetup.chooseStoreSubtitle` | Pick the store you're selling for | اختر المتجر الذي تبيع لحسابه `app/(app)/store-setup.tsx` |
| `storeSetup.chooseStoreTitle` | Choose a store | اختر متجرًا `app/(app)/store-setup.tsx` |
| `storeSetup.defaultLocation` | Default | افتراضي `app/(app)/store-setup.tsx` |
| `storeSetup.documentTitle` | Store setup \| Mercaria POS | إعداد المتجر \| Mercaria POS `app/(app)/store-setup.tsx` |
| `storeSetup.locationsLoadFailed` | Couldn't load locations | تعذّر تحميل المواقع `app/(app)/store-setup.tsx` |
| `storeSetup.noLocationsBody` | Create a location in the Dashboard first, then return here to open the register. | أنشئ موقعًا في لوحة التحكم أولًا، ثم عُد إلى هنا لفتح الصندوق. `app/(app)/store-setup.tsx` |
| `storeSetup.noLocationsTitle` | No locations | لا توجد مواقع `app/(app)/store-setup.tsx` |
| `storeSetup.noStoresBody` | Create a store in the Mercaria Dashboard first, then return here to open the register. | أنشئ متجرًا في لوحة تحكم Mercaria أولًا، ثم عُد إلى هنا لفتح الصندوق. `app/(app)/store-setup.tsx` |
| `storeSetup.noStoresTitle` | No stores yet | لا توجد متاجر بعد `app/(app)/store-setup.tsx` |
| `storeSetup.storesLoadFailed` | Couldn't load your stores | تعذّر تحميل متاجرك `app/(app)/store-setup.tsx` |

</details>

## 3. Plural — do NOT review or supply

**Knowingly wrong for 3–10 and owned by #436.** Each writes the singular in BOTH slots deliberately: correct for 11–99, wrong for 3–10, and no single form is right for both. Listed only so they are not approved as correct. `missing` names the categories Arabic selects that the bundle does not carry.

### `dashboard` — 22 strings

<details><summary><code>/</code> — 2</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `home.inventory.lowStock` | **one:** %{count} tracked variant at or below the low-stock threshold.<br>**other:** %{count} tracked variants at or below the low-stock threshold. | **one:** %{count} متغيّر متتبَّع عند حد انخفاض المخزون أو دونه.<br>**other:** %{count} متغيّر متتبَّع عند حد انخفاض المخزون أو دونه. | zero, two, few, many | `app/(app)/index.tsx` |
| `home.topProducts.unitsSold` | **one:** %{count} sold<br>**other:** %{count} sold | **one:** %{count} مباع<br>**other:** %{count} مباع | zero, two, few, many | `app/(app)/index.tsx` |

</details>

<details><summary><code>/channels</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `channels.readiness.channelCount` | **one:** %{count} channel<br>**other:** %{count} channels | **one:** %{count} قناة<br>**other:** %{count} قناة | zero, two, few, many | `app/(app)/channels/index.tsx` |

</details>

<details><summary><code>/channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/onboarding/[sessionId]</code> — 3</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `channels.orderHorizon.bounded` | **one:** Only the last %{count} day of orders is imported. Orders placed before %{before} were never imported and will not arrive later — this is a limit on what your platform lets Mercaria read, not a sync that is behind.<br>**other:** Only the last %{count} days of orders are imported. Orders placed before %{before} were never imported and will not arrive later — this is a limit on what your platform lets Mercaria read, not a sync that is behind. | **one:** تُستورد طلبات آخر %{count} يوم فقط. الطلبات المقدَّمة قبل %{before} لم تُستورد قط ولن تصل لاحقًا — هذا حد على ما تسمح منصّتك لـ Mercaria بقراءته، وليس مزامنة متأخرة.<br>**other:** تُستورد طلبات آخر %{count} يوم فقط. الطلبات المقدَّمة قبل %{before} لم تُستورد قط ولن تصل لاحقًا — هذا حد على ما تسمح منصّتك لـ Mercaria بقراءته، وليس مزامنة متأخرة. | zero, two, few, many | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.healthyDetail` | **one:** %{provider} is sending Mercaria %{count} kind of update. If you removed Mercaria's webhooks in %{provider}, register them again — nothing here can detect that.<br>**other:** %{provider} is sending Mercaria %{count} kinds of update. If you removed Mercaria's webhooks in %{provider}, register them again — nothing here can detect that. | **one:** %{provider} يرسل إلى Mercaria %{count} نوع من التحديثات. إذا أزلت Webhooks الخاصة بـ Mercaria من %{provider}، فسجّلها من جديد — لا شيء هنا يمكنه اكتشاف ذلك.<br>**other:** %{provider} يرسل إلى Mercaria %{count} نوع من التحديثات. إذا أزلت Webhooks الخاصة بـ Mercaria من %{provider}، فسجّلها من جديد — لا شيء هنا يمكنه اكتشاف ذلك. | zero, two, few, many | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.stoppedDetail` | **one:** Mercaria stopped after %{count} attempt. %{cause}<br>**other:** Mercaria stopped after %{count} attempts. %{cause} | **one:** توقفت Mercaria بعد %{count} محاولة. %{cause}<br>**other:** توقفت Mercaria بعد %{count} محاولة. %{cause} | zero, two, few, many | `components/channels/channel-presentation.tsx` |

</details>

<details><summary><code>/channels/[connectionId]</code> — 4</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `channels.collectionMapping.productsOnChannel` | **one:** %{count} product on the channel<br>**other:** %{count} products on the channel | **one:** %{count} منتج على القناة<br>**other:** %{count} منتج على القناة | zero, two, few, many | `components/channels/CollectionMapping.tsx` |
| `channels.disconnect.productsChanged` | **one:** %{count} product changed<br>**other:** %{count} products changed | **one:** %{count} منتج تغيّر<br>**other:** %{count} منتج تغيّر | zero, two, few, many | `app/(app)/channels/[connectionId].tsx` |
| `channels.disconnect.recordsKept` | **one:** %{count} price record kept<br>**other:** %{count} price records kept | **one:** %{count} سجل سعر محفوظ<br>**other:** %{count} سجل سعر محفوظ | zero, two, few, many | `app/(app)/channels/[connectionId].tsx` |
| `channels.reconciliation.awaitingReviewNote` | **one:** %{count} product could not be matched automatically and is queued for a person to confirm.<br>**other:** %{count} products could not be matched automatically and are queued for a person to confirm. | **one:** %{count} منتج تعذّرت مطابقته تلقائيًا وهو في قائمة الانتظار ليؤكده شخص.<br>**other:** %{count} منتج تعذّرت مطابقته تلقائيًا وهو في قائمة الانتظار ليؤكده شخص. | zero, two, few, many | `app/(app)/channels/[connectionId].tsx` |

</details>

<details><summary><code>/collections</code> — 2</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `collections.productCount` | **one:** %{count} product<br>**other:** %{count} products | **one:** %{count} منتج<br>**other:** %{count} منتج | zero, two, few, many | `app/(app)/collections/index.tsx` |
| `collections.ruleCount` | **one:** %{count} rule<br>**other:** %{count} rules | **one:** %{count} قاعدة<br>**other:** %{count} قاعدة | zero, two, few, many | `app/(app)/collections/index.tsx` |

</details>

<details><summary><code>/customers</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `customers.orderCount` | **one:** %{count} order<br>**other:** %{count} orders | **one:** %{count} طلب<br>**other:** %{count} طلب | zero, two, few, many | `app/(app)/customers/index.tsx` |

</details>

<details><summary><code>/orders</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `orders.row.itemsPlacedOn` | **one:** %{count} item · %{date}<br>**other:** %{count} items · %{date} | **one:** %{count} عنصر · %{date}<br>**other:** %{count} عنصر · %{date} | zero, two, few, many | `app/(app)/orders/index.tsx` |

</details>

<details><summary><code>/products</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `products.row.variantsInStock` | **one:** %{count} variant · %{stock} in stock<br>**other:** %{count} variants · %{stock} in stock | **one:** %{count} متغيّر · %{stock} في المخزون<br>**other:** %{count} متغيّر · %{stock} في المخزون | zero, two, few, many | `app/(app)/products/index.tsx` |

</details>

<details><summary><code>/products/[id]</code> — 2</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `products.detail.pins.releaseUnnamed` | **one:** Release %{count} field<br>**other:** Release %{count} fields | **one:** تحرير %{count} حقل<br>**other:** تحرير %{count} حقل | zero, two, few, many | `app/(app)/products/[id].tsx` |
| `products.detail.variantCount` | **one:** %{count} variant<br>**other:** %{count} variants | **one:** %{count} متغيّر<br>**other:** %{count} متغيّر | zero, two, few, many | `app/(app)/products/[id].tsx` |

</details>

<details><summary><code>/settings/members</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `settings.members.explicitPermissions` | **one:** %{count} explicit permission granted<br>**other:** %{count} explicit permissions granted | **one:** %{count} إذن صريح ممنوح<br>**other:** %{count} إذن صريح ممنوح | zero, two, few, many | `app/(app)/settings/members.tsx` |

</details>

<details><summary><code>/settings/payments</code> — 2</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `settings.payments.itemCount` | **one:** %{count} item<br>**other:** %{count} items | **one:** %{count} عنصر<br>**other:** %{count} عنصر | zero, two, few, many | `app/(app)/settings/payments.tsx` |
| `settings.payments.scheduleWithDelay` | **one:** %{interval}, after %{count} day<br>**other:** %{interval}, after %{count} days | **one:** %{interval}، بعد %{count} يوم<br>**other:** %{interval}، بعد %{count} يوم | zero, two, few, many | `app/(app)/settings/payments.tsx` |

</details>

<details><summary><code>/settings/plan</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `settings.plan.trialNotice` | **one:** Includes a %{count}-day trial.<br>**other:** Includes a %{count}-day trial. | **one:** تشمل فترة تجريبية مدتها %{count} يوم.<br>**other:** تشمل فترة تجريبية مدتها %{count} يوم. | zero, two, few, many | `app/(app)/settings/plan.tsx` |

</details>

<details><summary><code>/stores</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `stores.storeMeta` | **one:** @%{handle} · %{count} product<br>**other:** @%{handle} · %{count} products | **one:** @%{handle} · %{count} منتج<br>**other:** @%{handle} · %{count} منتج | zero, two, few, many | `app/(app)/stores.tsx` |

</details>

### `pos` — 5 strings

<details><summary><code>(component) components/register/ProductTile.tsx</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `catalog.inStockCount` | **one:** %{count} in stock<br>**other:** %{count} in stock | **one:** %{count} في المخزون<br>**other:** %{count} في المخزون | zero, two, few, many | `components/register/ProductTile.tsx` |

</details>

<details><summary><code>(component) components/register/VariantPickerSheet.tsx</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `catalog.availableCount` | **one:** %{count} available<br>**other:** %{count} available | **one:** %{count} متاح<br>**other:** %{count} متاح | zero, two, few, many | `components/register/VariantPickerSheet.tsx` |

</details>

<details><summary><code>/</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `register.reviewCartWithCount` | **one:** %{count} item · Review cart<br>**other:** %{count} items · Review cart | **one:** %{count} عنصر · مراجعة السلة<br>**other:** %{count} عنصر · مراجعة السلة | zero, two, few, many | `app/(app)/index.tsx` |

</details>

<details><summary><code>/, /cart</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `cart.itemCount` | **one:** %{count} item<br>**other:** %{count} items | **one:** %{count} عنصر<br>**other:** %{count} عنصر | zero, two, few, many | `components/register/CartPanel.tsx` |

</details>

<details><summary><code>/store-setup</code> — 1</summary>

| key | English | Arabic | missing | file |
|---|---|---|---|---|
| `storeSetup.storeMeta` | **one:** @%{handle} · %{count} product<br>**other:** @%{handle} · %{count} products | **one:** @%{handle} · %{count} منتج<br>**other:** @%{handle} · %{count} منتج | zero, two, few, many | `app/(app)/store-setup.tsx` |

</details>

## 4. Interpolated — check the placeholders

The failure here is a renamed or dropped `%{placeholder}`, not wording. **Every placeholder must survive verbatim**; changing one breaks the render. Word ORDER around them is free and is often what needs changing in Arabic.

### `dashboard` — 56 strings

<details><summary><code>/channels</code> — 5</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `channels.lastRunCounts` | Last run — %{created} created, %{updated} updated, %{skipped} skipped, %{failed} failed | آخر تشغيل — %{created} مُنشأ، %{updated} مُحدَّث، %{skipped} متخطى، %{failed} فاشل | %{created} %{failed} %{skipped} %{updated} | `app/(app)/channels/index.tsx` |
| `channels.nextScheduled` |  · next %{when} |  · التالية %{when} | %{when} | `app/(app)/channels/index.tsx` |
| `channels.pausedScopes` | Paused: %{scopes} | موقوف مؤقتًا: %{scopes} | %{scopes} | `app/(app)/channels/index.tsx` |
| `channels.readiness.lastSynced` | last synced %{when} | آخر مزامنة %{when} | %{when} | `app/(app)/channels/index.tsx` |
| `channels.toast.startConnectFailed` | Couldn't start connecting %{name} | تعذّر بدء ربط %{name} | %{name} | `app/(app)/channels/index.tsx` |

</details>

<details><summary><code>/channels, /channels/[connectionId]</code> — 1</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `channels.lastSynced` | Last synced %{when} | آخر مزامنة %{when} | %{when} | `app/(app)/channels/[connectionId].tsx` +1 |

</details>

<details><summary><code>/channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/onboarding/[sessionId]</code> — 7</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `channels.limitation.knownIssue` | Known issue #%{issue} — being worked on | مشكلة معروفة #%{issue} — يجري العمل عليها | %{issue} | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.causeUnreachable` | The last attempts could not reach %{provider}. Register again once it is reachable. | تعذّر على المحاولات الأخيرة الوصول إلى %{provider}. سجّل مرة أخرى عندما يصبح متاحًا. | %{provider} | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.refusedDetail` | Mercaria finished registering, but %{provider} refused the events below. It will retry them automatically; the button brings that forward. | أكملت Mercaria التسجيل، لكن %{provider} رفض الأحداث أدناه. ستُعاد المحاولة تلقائيًا؛ والزر يقدّم ذلك. | %{provider} | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.remedyPermissionDenied` | Mercaria's permissions in %{provider} do not cover every event — widen them there, then register again. | أذونات Mercaria في %{provider} لا تغطي كل الأحداث — وسّعها هناك، ثم سجّل من جديد. | %{provider} | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.remedyTopicNotSupported` | %{provider} does not offer some of these events at all, so registering again cannot make them arrive. | %{provider} لا يوفّر بعض هذه الأحداث إطلاقًا، لذا فإن التسجيل من جديد لن يجعلها تصل. | %{provider} | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.retryingDetail` | Mercaria is retrying automatically — the next attempt is %{due}. %{remedy} | تعيد Mercaria المحاولة تلقائيًا — المحاولة التالية %{due}. %{remedy} | %{due} %{remedy} | `components/channels/channel-presentation.tsx` |
| `channels.webhooks.unregisteredDetail` | Mercaria registers these automatically for a connected %{provider} channel. You can register them now instead of waiting. | تسجّل Mercaria هذه تلقائيًا لقناة %{provider} مرتبطة. يمكنك تسجيلها الآن بدلًا من الانتظار. | %{provider} | `components/channels/channel-presentation.tsx` |

</details>

<details><summary><code>/channels/[connectionId]</code> — 13</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `channels.collectionMapping.body` | Choose which Mercaria collection each of this channel’s %{many} imports into. Products in an unmapped %{one} still import — they just land in no collection. | اختر مجموعة Mercaria التي تستورد إليها كل %{many} في هذه القناة. المنتجات في %{one} غير معيَّنة تُستورد أيضًا — لكنها لا تصل إلى أي مجموعة. | %{many} %{one} | `components/channels/CollectionMapping.tsx` |
| `channels.collectionMapping.channelNoun` | Channel %{noun} | %{noun} القناة | %{noun} | `components/channels/CollectionMapping.tsx` |
| `channels.disconnect.confirmTitle` | Disconnect %{provider}? | فصل %{provider}؟ | %{provider} | `app/(app)/channels/[connectionId].tsx` |
| `channels.history.counts` | %{created} created · %{updated} updated · %{skipped} skipped · %{failed} failed | %{created} مُنشأ · %{updated} مُحدَّث · %{skipped} متخطى · %{failed} فاشل | %{created} %{failed} %{skipped} %{updated} | `app/(app)/channels/[connectionId].tsx` |
| `channels.import.heading` | Import products from %{provider} | استيراد المنتجات من %{provider} | %{provider} | `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.copied` | Copied %{label} | تم نسخ %{label} | %{label} | `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.copyAccessibility` | Copy %{label} | نسخ %{label} | %{label} | `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.lastUsed` | Last used %{when} | آخر استخدام %{when} | %{when} | `app/(app)/channels/[connectionId].tsx` |
| `channels.keys.revokeConfirmBody` | Any plugin using “%{label}” will stop syncing immediately. This cannot be undone — you’d need to generate a new key. | أي إضافة تستخدم «%{label}» ستتوقف عن المزامنة فورًا. لا يمكن التراجع عن هذا — ستحتاج إلى إنشاء مفتاح جديد. | %{label} | `app/(app)/channels/[connectionId].tsx` |
| `channels.runFailures.showing` | Showing %{shown} of %{total}. | عرض %{shown} من %{total}. | %{shown} %{total} | `app/(app)/channels/[connectionId].tsx` |
| `channels.settings.providerTitle` | %{provider} settings | إعدادات %{provider} | %{provider} | `app/(app)/channels/[connectionId].tsx` |
| `channels.toast.disconnected` | Disconnected — %{products}, %{records} | تم الفصل — %{products}، %{records} | %{products} %{records} | `app/(app)/channels/[connectionId].tsx` |
| `channels.webhooks.failureDetail` |  — %{reason}%{http} · last checked %{when} |  — %{reason}%{http} · آخر فحص %{when} | %{http} %{reason} %{when} | `app/(app)/channels/[connectionId].tsx` |

</details>

<details><summary><code>/channels/feeds/[configurationId]</code> — 8</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `feeds.detail.identityColumns` | Identity columns: %{columns} — frozen for the life of this feed. | أعمدة التعريف: %{columns} — ثابتة طوال عمر هذه الخلاصة. | %{columns} | `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.readSchedule` | Last read %{last} · next %{next} | آخر قراءة %{last} · التالية %{next} | %{last} %{next} | `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.detail.runCounts` | %{fetched} read · %{stored} stored · %{unchanged} unchanged · %{rejected} rejected · %{listed} listed · %{retired} retired | %{fetched} مقروء · %{stored} مخزَّن · %{unchanged} دون تغيير · %{rejected} مرفوض · %{listed} معروض · %{retired} مسحوب | %{fetched} %{listed} %{rejected} %{retired} %{stored} %{unchanged} | `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.reports.counts` | %{scanned} read · %{valid} valid · %{invalid} need attention | %{scanned} مقروء · %{valid} صالح · %{invalid} يحتاج مراجعة | %{invalid} %{scanned} %{valid} | `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.toast.checked` | Checked %{scanned} records — %{invalid} need attention | جرى فحص %{scanned} سجلًا — %{invalid} يحتاج مراجعة | %{invalid} %{scanned} | `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.previewCounts` | %{scanned} read · %{valid} valid · %{invalid} invalid · %{matched} matched · %{created} new · %{review} to review | %{scanned} مقروء · %{valid} صالح · %{invalid} غير صالح · %{matched} مطابق · %{created} جديد · %{review} للمراجعة | %{created} %{invalid} %{matched} %{review} %{scanned} %{valid} | `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.suggestedColumns` | Suggested columns: %{columns} | الأعمدة المقترحة: %{columns} | %{columns} | `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.versions.version` | Version %{version} | الإصدار %{version} | %{version} | `app/(app)/channels/feeds/[configurationId].tsx` |

</details>

<details><summary><code>/channels/onboarding/[sessionId]</code> — 2</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `channels.wizard.connectedTitle` | %{channel} connected | تم ربط %{channel} | %{channel} | `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.title` | Connect %{channel} | ربط %{channel} | %{channel} | `app/(app)/channels/onboarding/[sessionId].tsx` |

</details>

<details><summary><code>/customers, /orders, /products</code> — 1</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `common.pageOf` | Page %{current} of %{total} | صفحة %{current} من %{total} | %{current} %{total} | `app/(app)/customers/index.tsx` +2 |

</details>

<details><summary><code>/discounts</code> — 1</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `discounts.percentOff` | %{percent}% off | خصم %{percent}% | %{percent} | `app/(app)/discounts/index.tsx` |

</details>

<details><summary><code>/orders/[id]</code> — 1</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `orders.refund.itemMax` | %{variant} · max %{quantity} | %{variant} · بحد أقصى %{quantity} | %{quantity} %{variant} | `app/(app)/orders/[id].tsx` |

</details>

<details><summary><code>/products/new</code> — 2</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `products.new.optionValueLabel` | %{option} value | قيمة %{option} | %{option} | `app/(app)/products/new.tsx` |
| `products.new.variantIndex` | Variant %{index} | المتغيّر %{index} | %{index} | `app/(app)/products/new.tsx` |

</details>

<details><summary><code>/products/wizard/[draftId]</code> — 5</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `products.wizard.review.productTypeVersion` | %{name} (version %{version}) | %{name} (الإصدار %{version}) | %{name} %{version} | `app/(app)/products/wizard/[draftId].tsx` +1 |
| `products.wizard.review.marketAndLocale` | Market %{market} · language %{locale} | السوق %{market} · اللغة %{locale} | %{locale} %{market} | `app/(app)/products/wizard/[draftId].tsx` |
| `products.wizard.review.moreVariants` | and %{count} more | و%{count} أخرى | %{count} | `components/catalog-authoring/ReviewPanel.tsx` |
| `products.wizard.summary.errors` | %{count} thing(s) to fix before publishing | %{count} أمر يجب إصلاحه قبل النشر | %{count} | `components/catalog-authoring/ErrorSummary.tsx` |
| `products.wizard.summary.warnings` | %{count} thing(s) worth checking | %{count} أمر يستحق المراجعة | %{count} | `components/catalog-authoring/ErrorSummary.tsx` |

</details>

<details><summary><code>/settings/members</code> — 1</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `settings.members.joinedOn` | Joined %{date} | انضم في %{date} | %{date} | `app/(app)/settings/members.tsx` |

</details>

<details><summary><code>/settings/plan</code> — 9</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `settings.plan.capabilityWithLimit` | %{name} · up to %{limit} | %{name} · حتى %{limit} | %{limit} %{name} | `app/(app)/settings/plan.tsx` |
| `settings.plan.choosePlan` | Choose %{plan} | اختر %{plan} | %{plan} | `app/(app)/settings/plan.tsx` |
| `settings.plan.endsOn` | Ends on %{date}. | تنتهي في %{date}. | %{date} | `app/(app)/settings/plan.tsx` |
| `settings.plan.graceEndsOn` | This plan's extras stop on %{date} unless the payment succeeds. | تتوقف مزايا هذه الخطة في %{date} ما لم تنجح عملية الدفع. | %{date} | `app/(app)/settings/plan.tsx` |
| `settings.plan.pricePerMonth` | %{price} · per month | %{price} · شهريًا | %{price} | `app/(app)/settings/plan.tsx` |
| `settings.plan.pricePerYear` | %{price} · per year | %{price} · سنويًا | %{price} | `app/(app)/settings/plan.tsx` |
| `settings.plan.renewsOn` | Renews on %{date}. | تتجدد في %{date}. | %{date} | `app/(app)/settings/plan.tsx` |
| `settings.plan.usageNoLimit` | %{used} used · no limit | استُخدم %{used} · بلا حد | %{used} | `app/(app)/settings/plan.tsx` |
| `settings.plan.usageOfLimit` | %{used} of %{limit} used | استُخدم %{used} من %{limit} | %{limit} %{used} | `app/(app)/settings/plan.tsx` |

</details>

### `pos` — 3 strings

<details><summary><code>/receipt/[id]</code> — 1</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `receipt.orderNumber` | Order %{number} | الطلب %{number} | %{number} | `app/(app)/receipt/[id].tsx` |

</details>

<details><summary><code>/sales</code> — 2</summary>

| key | English | Arabic | placeholders | file |
|---|---|---|---|---|
| `sales.orderLabel` | Order %{number} | الطلب %{number} | %{number} | `app/(app)/sales.tsx` |
| `sales.pageNumber` | Page %{page} | صفحة %{page} | %{page} | `app/(app)/sales.tsx` |

</details>

## 5. Identical to English by design — confirm the policy

Brand names, URLs, coupon codes and example values stay Latin, following `ru`/`ja`. These are not misses. The question is whether the policy is right, and it is the same question as RTL choice 3 above.

### `dashboard` — 27 strings

<details><summary><code>/_layout</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `auth.signInTitle` | Mercaria Dashboard | Mercaria Dashboard `components/AuthGate.tsx` |

</details>

<details><summary><code>/channels, /channels/[connectionId], /channels/feeds/[configurationId], /channels/onboarding/[sessionId]</code> — 5</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.type.etsy` | Etsy | Etsy `app/(app)/channels/[connectionId].tsx` +1 |
| `channels.type.magento` | Magento | Magento `app/(app)/channels/[connectionId].tsx` +1 |
| `channels.type.prestashop` | PrestaShop | PrestaShop `app/(app)/channels/[connectionId].tsx` +1 |
| `channels.type.shopify` | Shopify | Shopify `app/(app)/channels/[connectionId].tsx` +1 |
| `channels.type.woocommerce` | WooCommerce | WooCommerce `app/(app)/channels/[connectionId].tsx` +1 |

</details>

<details><summary><code>/channels/[connectionId]</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.webhooks.httpStatus` |  (HTTP %{status}) |  (HTTP %{status}) `app/(app)/channels/[connectionId].tsx` |
| `channels.run.kind.webhook` | Webhook | Webhook `app/(app)/channels/[connectionId].tsx` |

</details>

<details><summary><code>/channels/feeds/[configurationId]</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `feeds.draft.urlPlaceholder` | https://example.com/products.csv | https://example.com/products.csv `app/(app)/channels/feeds/[configurationId].tsx` |
| `feeds.run.kind.webhook` | Webhook | Webhook `app/(app)/channels/feeds/[configurationId].tsx` |

</details>

<details><summary><code>/channels/feeds/new</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `feeds.new.identityColumnsPlaceholder` | id, sku | id, sku `app/(app)/channels/feeds/new.tsx` |

</details>

<details><summary><code>/channels/onboarding/[sessionId]</code> — 4</summary>

| key | English | Arabic file |
|---|---|---|---|
| `channels.wizard.shopify.domainPlaceholder` | your-store.myshopify.com | your-store.myshopify.com `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.consumerKeyPlaceholder` | ck_... | ck_... `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.consumerSecretPlaceholder` | cs_... | cs_... `app/(app)/channels/onboarding/[sessionId].tsx` |
| `channels.wizard.woo.siteUrlPlaceholder` | https://your-store.com | https://your-store.com `app/(app)/channels/onboarding/[sessionId].tsx` |

</details>

<details><summary><code>/discounts</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `discounts.create.codePlaceholder` | SPRING20 | SPRING20 `app/(app)/discounts/index.tsx` |

</details>

<details><summary><code>/orders/[id]</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `orders.detail.trackingPlaceholder` | 1Z… | 1Z… `app/(app)/orders/[id].tsx` |
| `orders.pickup.codePlaceholder` | ABCD234567 | ABCD234567 `components/orders/PickupDeskCard.tsx` |

</details>

<details><summary><code>/products/new</code> — 4</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.new.categoryPlaceholder` | electronics | electronics `app/(app)/products/new.tsx` |
| `products.new.optionValuePlaceholder` | M | M `app/(app)/products/new.tsx` |
| `products.new.skuPlaceholder` | SKU-123 | SKU-123 `app/(app)/products/new.tsx` |
| `products.new.vendorPlaceholder` | Acme | Acme `app/(app)/products/new.tsx` |

</details>

<details><summary><code>/products/wizard</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.start.marketPlaceholder` | ES | ES `app/(app)/products/wizard/index.tsx` |

</details>

<details><summary><code>/products/wizard/[draftId]</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `products.wizard.variants.sku` | SKU | SKU `components/catalog-authoring/VariantRows.tsx` |

</details>

<details><summary><code>/settings/tax</code> — 2</summary>

| key | English | Arabic file |
|---|---|---|---|
| `settings.tax.countryPlaceholder` | US | US `app/(app)/settings/tax.tsx` |
| `settings.tax.regionPlaceholder` | CA | CA `app/(app)/settings/tax.tsx` |

</details>

<details><summary><code>/stores</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `stores.create.namePlaceholder` | Acme Supply Co. | Acme Supply Co. `app/(app)/stores.tsx` |

</details>

### `pos` — 1 strings

<details><summary><code>/_layout</code> — 1</summary>

| key | English | Arabic file |
|---|---|---|---|
| `auth.appName` | Mercaria POS | Mercaria POS `components/AuthGate.tsx` |

</details>

## Excluded, with the reason

9 strings are not in any section above: they contain no letters outside their placeholders (`%{a} · %{b}`), so there is nothing anybody could translate.

