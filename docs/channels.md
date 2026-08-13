# Sales channels (#87)

How a merchant tells Mercaria where their products come from, in one place —
Shopify, WooCommerce, the WooCommerce plugin, a product feed, and the Mercaria
catalogue they were already using.

This document is the reference for `services/channels/`, `db/channels/`,
`db/schema/channels.ts`, the channel half of
`/admin/stores/:storeId/channels/*`, and the dashboard's `Sales channels` area.
Schema decisions live in `db/schema/CONVENTIONS.md` §"Channel onboarding and the
channel audit trail (#87)". It is deliberately not a feature list: what follows
is what the rules ARE and why.

---

## The failure modes that shape it

**A merchant walked into a known defect and did not know.** #69's connector
contract suite filed four defects (#218–#221, all since fixed) while proving what the
connectors do and do not do. The most consequential — #218, since FIXED — meant
that connecting WooCommerce registered webhooks part-way, lost the signing secret
with them, and left every delivery rejected forever. The channel worked; live
updates simply never arrived. A merchant who is not told reports that as Mercaria
being broken, weeks later, after wondering why prices lag. What replaced the
limitation is not silence: a refused topic is now RECORDED on the connection and
served as `Connection.webhookFailures`, so the merchant is told which events will
not arrive rather than told that a whole channel is degraded.

**A client answered "can I sell yet" from provider flags.** The dashboard held a
hard-coded `PROVIDERS` table with an `available` boolean per connector. It could
not describe the product feed, could not describe the native catalogue, and had
no way to say that a perfect Shopify sync still cannot take an order because
Stripe onboarding is incomplete. Acceptance 7 names exactly this.

**Connecting a shop Mercaria already crawled duplicated the catalogue.** A
merchant's products are often already in the graph as external offers, observed
long before they heard of Mercaria. Connecting adds native offers beside them,
and the naive resolutions — delete one, convert one in place — each destroy an
observation chain that price history and comparison are built on.

**A wizard lost its state at the step that takes longest.** Two of the three
credential paths leave Mercaria: Shopify sends the merchant to a consent screen,
the plugin sends them to their own WordPress admin. Client-held wizard state
evaporates exactly there.

---

## The shape

| Piece | Where | What it answers |
|---|---|---|
| The channel catalog | `services/channels/channel-catalog.ts` | What may be connected, what it supports, what is wrong with it |
| Readiness | `services/channels/channel-readiness.ts` | Can this merchant sell yet, and which of three things is missing |
| The channel list | `services/channels/channel-summary.service.ts` | Connectors, feeds and the native catalogue in one shape |
| The binding | `services/channels/channel-binding.ts` | Which verified merchant and exact storefront a channel is |
| Reconciliation | `services/channels/channel-reconciliation.service.ts` | What Mercaria already indexed, and where it overlaps |
| Onboarding | `services/channels/channel-onboarding.service.ts` | The resumable wizard |
| Disconnect | `services/channels/channel-disconnect.service.ts` | What happens to what a channel produced |
| Audit | `db/channels/channelAuditRepository.ts` | Who changed what |

Two new tables (`channel_onboarding_sessions`, `channel_audit_events`) and four
nullable columns on `connections`. Nothing else in the connector, feed or offer
domains moved.

---

## The rules that are load-bearing

### A channel TYPE is not a connector provider id

`ConnectorProviderId` answers "which platform's API is this", and two channels
share one answer: the WooCommerce pull connector and the WooCommerce push plugin
are both `provider: 'woocommerce'`, distinguished only by `connections.mode`.
They authenticate differently, support different resources and carry different
limitations, so a merchant choosing between them is choosing between two
channels. Two more channel types — `product_feed` and `native` — have no provider
at all.

`channelTypeForConnection` is the one function that reads a stored row as a
channel type, and `providerForChannelType` is the one that goes back.

### The catalog reads the provider and restates nothing

`ConnectorProvider.capabilities` is the SINGLE declaration of what a connector
implements, and it has three readers: the provider itself, the #69 contract
suite, and the catalog. It moved onto the provider in this issue — it previously
lived in the contract-suite HARNESSES, which was fine while only a test read it
and became a problem the moment a merchant-facing screen needed the same fact.

That is what makes the catalog's claims checkable rather than merely stated: a
descriptor saying WooCommerce publishes products back would require flipping the
provider's declaration, and the contract suite asserts the SUCCESS when a
capability is `true` and the REFUSAL when it is `false`. Mutation-tested in both
directions — flipping `pushesProducts` turns `channel-catalog.test.ts` AND the
WooCommerce contract suite red.

Building the mutation test found a real gap: the suite declared
`pushesProducts` and never read it, so the flip survived. #87 added the
product-push scenario that closes it, and the `inventoryWebhook` half is pinned
by an assertion that the harness's topic map and the provider's declaration
agree.

### Limitations are DATA, with severities and issue numbers

`CHANNEL_LIMITATION_CODES` is a closed set, because the dashboard renders
different copy per code and because "does this block activation" has to be
checkable — a sentence is not. Each carries a severity and, where one exists,
the OPEN Mercaria issue that would remove it.

The #69 defects that are still open appear on WooCommerce as `degrades` with
their issue numbers, and their summaries say what the MERCHANT will observe
rather than what the code does wrong: "a sync fails outright if the WordPress
host rate-limits it" is actionable; "`registerWebhooks` discards its ids" is not.

**A fixed defect leaves the list, and `channel-catalog.test.ts` asserts the EXACT
issue set rather than containment.** A list that only ever grows is a wizard
warning about problems somebody solved, which is the cry-wolf failure one step
on — and it is the direction this list drifts, because adding an entry is
somebody's diligence and removing one is somebody remembering.

`blocks_activation` is the only severity the onboarding gate reads, so it means
"no merchant can get past this" rather than "this is bad". Today only an
unimplemented connector carries it.

### Readiness is DERIVED, never stored, and has three axes

This is the deliberate divergence from the one-stored-verdict rule, and it is
#57's `deriveNativeCheckoutEligibility` precedent rather than a new one.
`provider_accounts.onboarding_state` is stored because its inputs sit on the row
being verdicted; readiness has no such row. Its inputs are `connections`,
`sync_runs`, `feed_configurations`, `listings` and `provider_accounts` — five
tables in four domains, none of which this one owns — and a stored verdict would
go stale at exactly the moment that matters, which is the instant Stripe
restricts a seller.

The three axes are separate because #87 UX 5 and 6 ask for exactly that: a
connected catalogue is not payment readiness, and a healthy sync is not
native-checkout activation. Collapsing them is what leaves a merchant with a
perfect Shopify sync wondering why nothing can be bought.

Payment readiness is READ from #46's stored verdict through
`isSellerPaymentReady` and never re-derived. A second reading of
`charges_enabled` here would be the two-representations failure that rule exists
to prevent, in the one place it must not happen.

### A feed cannot support native checkout, and that is structural

A connector writes NATIVE listings the store owns. A feed produces EXTERNAL
offers, and `offers_kind_shape_check` forces `product_variant_id` NULL on every
kind but `native` — so there is no id a cart line could hold.
`supportsNativeCheckout` surfaces that fact; it is not a policy this domain
chose, and #87 UX 3 ("explain when a sync imports products but cannot support
orders or inventory") is that field plus `resources`.

### An onboarding session cannot hold a credential

There is no credential column on `channel_onboarding_sessions` and no credential
field on `ChannelOnboardingSession`. Wizard step 4 — "collect credentials only
through the secure provider-specific flow" — is that absence rather than a rule
somebody follows, and it matters more here than almost anywhere: an abandoned
session outlives its flow by design, so a consumer secret parked on one would
sit unencrypted for as long as the merchant never came back.

The credential flows write to `connections` (AES-GCM, both envelopes,
`num_nonnulls(...) in (0,3)`) or mint a channel key. The session records only
WHICH connection resulted.

Two gates hold it: `channel-isolation.test.ts` scans the whole domain for the
credential vocabulary, and the same file WALKS the real drizzle tables for a
credential-shaped column — the scan catches a service reading a secret into a
patch, the walk catches a column somebody adds with a name the scan never
anticipated.

### Activation blockers are re-derived on every read, never trusted

The stored `activation_blockers` exist so a resumed wizard shows what it showed.
Nothing decides from them: `deriveActivationBlockers` runs against the LIVE
connection and the LIVE preview record on every read and every activation
attempt. A session previewed last week whose connection has since errored must
not be activatable because a column still says it was fine.

`preview_scanned_nothing` is a blocker in its own right — the #60 vacuity floor,
applied to a wizard. A mapping that matches no rows and a feed with nothing in it
produce identical output, a clean run with zero problems, and that is exactly
what a merchant reads before pressing activate.

### A preview's counters must PARTITION what was scanned

`channel_onboarding_sessions_preview_total_check` is equality, never `<=`, so a
record the preview read and dropped on the floor cannot be stored. Its sibling
`..._preview_complete_check` makes the seven columns all-or-none: five counters
with a missing `scanned` reads as a preview that examined nothing, which is also
what a broken mapping produces.

### Reconciliation REPORTS and never acts

The `payment_discrepancies` posture, and #84's already. Both representations
survive, both keep their own `source_record_id` chain, and the comparison surface
goes on showing what each seller published. Four things it deliberately does not
do:

1. **Delete nothing** — reconcile 3 preserves source records, clicks and price
   history; #84 acceptance 3 keeps both rows distinct and sharing one canonical
   product.
2. **Convert nothing in place** — reconcile 4. An external affiliate offer is
   somebody's observation, and rewriting it into a native offer destroys the
   observation while claiming to upgrade it.
3. **Decide no matches** — #58 owns identity. This domain reads
   `native_listing_links` and `offers.canonical_variant_id` and forms no opinion;
   `awaitingReview` is a COUNT of what #58 already routed to #59's queue.
4. **Infer no relationship** — reconcile 8. A connected catalogue is not evidence
   of an official-brand status, and the isolation gate fails the build if this
   domain reaches the relationship layer at all.

Which representation wins is #84's `reconcileMerchantOfferOverlaps`, a pure
function with a total, deterministic four-rule order. A second one here — even an
equivalent one — would be two answers to "which is primary", and the loser is
whichever surface a merchant happens to be looking at.

### The binding is a conjunction of facts other domains own

`resolveChannelBinding` reads #84's active `native_store_links` row, checks #83's
`merchants.claim_state` LIVE, and matches the channel's own shop domain against
the merchant's storefronts. Getting it wrong attaches one shop's catalogue to
another shop's identity.

Merchant and storefront bind INDEPENDENTLY, and the type says so: a claimed
merchant whose Shopify subdomain Mercaria has never crawled is bound at merchant
grain with `storefront_not_matched` reported beside it. Collapsing them would
make the commonest partial state read as "we could not identify you", when the
true statement is "we identified you and have nothing indexed for that shop yet"
— and those route differently.

Domain containment goes through #83's `domainIsCoveredBy`, label-wise, so
`notacme.com` is never covered by `acme.com`. A hand-written `endsWith` here
would admit exactly that.

### Pause is TWO facts, and disconnect is a DECISION

`fetch_paused_at` and `publication_paused_at` are separate columns because they
have opposite remedies: a merchant investigating wrong prices stops publication
while the connector keeps observing; one whose WordPress host is rate-limiting
stops fetch and leaves what is imported on sale. A single tri-state could not
express both at once without a fourth value meaning what two flags mean.

They are INSTANTS rather than booleans, because "since when" is the first thing
anybody asks about a paused channel. `setConnectionPause` is a conditional
UPDATE whose empty `RETURNING` set IS the "already in that state" answer, so two
merchants pressing pause converge on one instant.

`status` is deliberately untouched by a pause: `disconnected` and `error` are
facts about whether a connection works at all, and collapsing them would make
resuming a paused channel indistinguishable from reconnecting a broken one.

Disconnect takes a REQUIRED policy with no default, because the three answers are
all defensible and only the merchant knows which they mean. Every policy applies
through `listings.source_connection_id`, so acceptance 4's "source-scoped" holds
because there is no query that could reach another channel's listings — not
because a filter remembered to exclude them.

`POLICY_MOVABLE_STATUSES` is `draft` and `active`. `restricted` is absent and
that is the load-bearing omission: it is what a CrowdSource jury writes, and
`catalog-write.service` already refuses to move a listing out of it. A disconnect
must not become the way around that — a merchant whose counterfeit listing was
restricted could otherwise disconnect, get it archived, reconnect, and have it
re-imported as `active`. `sold` is absent because a sold listing is what a
buyer's order points at.

### The audit trail records field NAMES and never values

`channel_audit_events.changed_fields` is a list of column names, and
`recordChannelAuditEvent` has no parameter a value could go in. That is #63's
error-report rule applied to an audit trail, for a sharper reason: the values a
channel change carries include a consumer secret and an API key pair, so a trail
recording before-and-after would be a plaintext credential store nobody
classified as one.

Append-only by trigger, with a PRECISE delete exception: UPDATE always raises,
DELETE raises only while the STORE still exists. A blanket refusal reads as the
stricter choice and is the wrong one — `store_id` is `ON DELETE CASCADE`, so
refusing every delete makes a store with any channel history undeletable forever.
`channels.realdb.test.ts` found that on its first run, which is why a trigger
belongs behind a real server.

### One live session per store per channel type

`channel_onboarding_sessions_live_key` is a PARTIAL unique on
`state = 'in_progress'`, and `openChannelOnboardingSession` is
`ON CONFLICT DO NOTHING` plus a read. #87 acceptance 2 — "previewing or retrying
a connection creates no duplicate channel" — is held at the FIRST step rather
than defended at the last: a merchant who opens the wizard in two tabs, or whose
client retries a request whose response was lost, gets the session they already
have.

Partial rather than plain, so finished sessions accumulate as history. A plain
unique would make a merchant who disconnected unable to ever reconnect through
the wizard.

---

## Surfaces

### Merchant — `/admin/stores/:storeId/channels/*`, behind `channels:write`

`channels:write` on every route, which is #63's reasoning: a feed is a sales
channel's inventory arriving by file, and the permission that gates connecting a
Shopify shop should gate every other way of supplying a catalogue. It is denied
to `staff` by the role matrix, which is correct — deciding where a store's
products come from is not a shop-floor act.

| Route | What it does |
|---|---|
| `GET /catalog` | what may be connected, and what is wrong with each |
| `GET /summary` | connectors, feeds and the native catalogue in one shape |
| `GET /readiness` | the ONE authoritative readiness result |
| `GET /audit` | who changed what |
| `GET /:connectionId/runs` | the sync history |
| `GET /:connectionId/reconciliation` | what is already indexed, and the overlaps |
| `POST /:connectionId/pause` | pause or resume ONE scope |
| `POST /:connectionId/disconnect` | disconnect with an explicit policy |
| `DELETE /:connectionId` | the v1 disconnect — `keep_listings`, see below |
| `POST /onboarding` · `GET /onboarding` | start (idempotently) / list |
| `GET`·`PATCH`·`DELETE /onboarding/:sessionId` | read / advance / abandon |
| `POST /onboarding/:sessionId/activate` | activate, or be refused with reasons |

Route ORDER is load-bearing: every literal segment is declared before
`/:connectionId` and `/:provider`, or `validateId` would reject `catalog` as a
malformed id.

`assertConnectionBelongsToStore` answers **404** for another store's connection,
never 403 — and it is structural rather than a gate, because `findConnection`
carries `store_id` in the query, so a cross-store id and an unknown id are the
same code path.

**`DELETE /:connectionId` is a VERSIONED CONTRACT, not a shim.** A shipped
dashboard build calls it and #87 cannot recall one. It maps to `keep_listings`,
which is exactly what that route has always done — it stopped syncing and touched
nothing — so every existing caller gets what it got before. It retires when
supported dashboard versions have migrated to the POST.

### Dashboard

`app/(app)/channels/` — the list (readiness, the unified channel list, the
catalog), `onboarding/[sessionId]` (the wizard),
`[connectionId]` (settings, keys, pause, runs, reconciliation, disconnect), and
`feeds/new` + `feeds/[configurationId]`, which are #63's deferred merchant
screens picked up here.

Shared presentation lives in `components/channels/channel-presentation.tsx`
(#87 UX 1). Provider-specific language survives in exactly one place — the
wizard's `ConnectStep` — because a Shopify consent redirect and a WooCommerce
key pair genuinely are different things (#87 UX 2).

---

## What is deliberately NOT here

- **No operator surface, and no seventh allow-list.** Every route is a store's
  own; there is no cross-store channel view. When one is needed it belongs on
  `/internal/ingestion` or `/internal/commerce-graph`, behind
  `CATALOG_OPERATOR_OXY_USER_IDS`, which already reads sources and merchants.
- **No environment flag of its own.** Nothing here gates a durable record, and
  the levers that matter already exist: `FEED_IMPORT_ENABLED` decides whether the
  feed channel is available, the connector OAuth configuration decides whether
  Shopify is, and both are REPORTED through `availability` rather than hidden.
- **No second cadence.** `nextScheduledSyncAt` is read from
  `CONNECTOR_RECONCILE_INTERVAL_MS`, the same constant the scheduler gives
  BullMQ, and is absent entirely when Redis is not configured — because then
  nothing is coming and a time on the screen would be an invented promise.
- **No client-side activation gate.** The button reflects the server's blockers
  and pressing it anyway is refused with the same reasons.

---

## Known defects a merchant is told about

These are #69's. The catalog carries each OPEN one with its issue number so
onboarding does not walk a merchant into it silently — and **all four are now
fixed, so `WOOCOMMERCE_OPEN_DEFECTS` is empty.** The empty array and its call
site stay: this is the shape a fifth defect is filed into, and a merchant-facing
warning that has to be re-invented is one that gets left out.
`channel-catalog.test.ts` asserts the EXACT open-issue set with a floor on the
total limitation count beside it, so neither an entry that outlived its fix nor a
descriptor that stopped reporting limitations at all can pass.

**#221 is FIXED**, in four independent parts.

1. **The create is atomic.** An imported listing's four `source_*` columns, its
   initial `draft`/`active` status and its VARIANTS' four `source_*` columns are
   arguments to `createStoreProduct`, written by `insertStoreProductWithin` —
   one transaction covering the listing, its images, options, condition
   evidence, variants and stock. A failure leaves NO listing rather than one no
   later sync can match and whose handle blocks every re-import. The variants
   had to join it: they used to be inserted after the transaction committed, so
   a SKU another product already held left a listing with nothing to sell, and
   `convergeVariants` returns early on a listing with zero variants, so nothing
   would ever have grown one. `stampVariantSources` is deleted;
   `stampVariantSource` remains for #220's convergence.
2. **One listing per provenance key, enforced by the storage.** Migration `0070`
   (`post`) promotes `listings_store_id_source_key_idx` to UNIQUE on the same
   partial predicate. The service already assumed it —
   `findListingBySourceExternalId` returns one row — while two concurrent
   deliveries for one external id could both read null and both create. The
   loser now RE-READS and converges through the update branch. It is matched by
   CONSTRAINT NAME, so a `listings_store_id_handle_key` collision still fails
   the product: two genuinely different external products claiming one handle is
   a real merchant conflict, and no handle dedup was added.
3. **The timestamp trigger.** `connectors/timestamps.ts` appends `Z` only to a
   value carrying NO zone of its own, then omits what is still unreadable.
   Omitting a legitimately-zoned value would be a data LOSS rather than caution:
   `buildSource` writes `sourceExternalUpdatedAt: … ?? null`, so a field the
   normalizer declines to read erases the stored freshness on every later sync.
4. **`fx_rate_as_of` is validated, not rewritten** — a readable value keeps the
   platform's own spelling, and only an unreadable one falls back to now.

`listing_stamp_not_atomic` left `CHANNEL_LIMITATION_CODES` with the defect.

**#220 is FIXED too** — a webhook payload is completed before it is normalized,
one that cannot be completed is refused rather than collapsed, and a variant the
platform added is created on the next sync. Its code left
`CHANNEL_LIMITATION_CODES` with it: a code no descriptor produces is a
vocabulary the dashboard still renders copy for.

**#219 is FIXED and is no longer in the list either** — the WooCommerce
transport retries a 429 — and its code did not simply disappear:
`no_rate_limit_retry` is now DERIVED from `capabilities.retriesRateLimit` beside
the other three capability limitations, so a third platform that arrives without
a retry gets it automatically instead of by somebody remembering to add a row.

**#218 is FIXED and is no longer in the list.** Registration is per-topic fault
tolerant, reconciles against the platform's own subscription list before creating
anything, and persists the ids, the secret and the refused topics in one
transaction. What a merchant sees instead of a blanket limitation is the actual
refusals: `Connection.webhookFailures` names each topic with its HTTP status and
a classified reason, and `ChannelReadiness` reports the catalogue axis as
`degraded` while any exist.

Runbook §8.5 is also surfaced, as copy rather than a limitation: a no-change
resync tallies as `updated`, because the patch is built from every unpinned
connector-managed field whether or not it changed.

---

## What is deferred, and to whom

Each is a named contract rather than a stub that lies.

- **#85 (activation)** consumes `GET .../channels/readiness` — one result rather
  than provider-specific client flags, which is acceptance 7's whole point. The
  contract is `ChannelReadiness` and it is complete; nothing is waiting on this
  domain.
- **#59 (curation)** owns the review of an uncertain match. Reconciliation COUNTS
  what is queued and links to nothing, because a merchant-facing review surface
  is a decision about the canonical graph and belongs where the graph's other
  decisions are.
- **A connector's bounded preview** is not wired: the wizard records what a
  merchant saw and the session's CHECK keeps the numbers honest, but running a
  first page of a real backfill as a sample without committing it is work in
  `connector-sync.service` rather than here. A feed's preview IS wired, through
  #63's own `POST .../versions/:v/preview`.
- **Feed UPLOADS** have no screen. The endpoint exists and takes raw bytes with
  no body parser; a file picker that streams to it is a client concern with its
  own platform differences, and an upload lives on one task's disk
  (`feed_uploads.status='missing'` is a real state), so a URL feed is the path
  this issue gives screens to.
- **A record-level error export for CONNECTORS** (#87 management 9). Feeds have
  one — #63's CSV, values excluded — and `sync_runs` carries counts plus a single
  error string with no per-record table behind it. Adding one is a connector
  schema change and still owed. #221 was the defect that produced the errors
  worth exporting and it is fixed, so the export is now about the ordinary
  per-product failures a real catalogue produces (a malformed price, a SKU
  colliding with an existing variant) rather than about a stranded listing.
- **#84's linkage UI.** This domain READS the link and never writes one.

---

## Production-readiness checklist

- [x] #218 fixed — the limitation is gone from the catalog and the refused topics are served per connection instead.
- [ ] `CONNECTOR_OAUTH_REDIRECT_BASE_URL` set, or the catalog correctly reports
      every connector as `not_configured` (it does — verify on the real
      deployment rather than trusting this line).
- [ ] `FEED_IMPORT_ENABLED` decided for this deployment; with it off the feed
      channel reports `not_configured` and its routes are not mounted.
- [ ] A real Shopify store and a real WooCommerce site exercised end to end
      through the wizard. #69 acceptance 7 is still NOT met — no real store has
      been connected — and nothing in this issue changes that.
