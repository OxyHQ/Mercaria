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

**And the shape of the fix is what the rest of #218 turned out to be about: a
subscription Mercaria holds no id for.** Making registration fault tolerant per
topic was necessary and not sufficient, because the SET of ids Mercaria persists
is a claim about a shop and every branch that shortened it left an orphan
delivering to an endpoint nobody could clean up. So `registerWebhooks` now
answers a discriminated result: a `reconciled` one names EVERY subscription live
at this connection's exact delivery URL — created here, adopted, an undeleted
duplicate, or the survivor of a delete the platform refused — while an `unknown`
one, which is what a platform refusing to LIST produces, carries no subscription
list at all and leaves the stored ids untouched. "I could not find out" written
down as "there are none" is the same erasure in a different hand. `disconnect`
reads the platform for the same reason rather than trusting `webhookIds`, and
Shopify's subscription list is paged like every other Shopify collection, because
a truncated list reads as "these are all that exist" on exactly the shops the
convergence exists to rescue.

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

### What a channel does NOT carry is stated, totally, from data (#380)

A merchant on a live Shopify store reported that "discounts and other things are
not syncing". Discounts were never built, and nothing anywhere told them — the
whole merchant-facing statement of scope was one sentence, *"imports your
products, stock and orders on a schedule"*, which is accurate and silent about
everything it omits. Everything that could have said more was either not
rendered or could not express it: `descriptor.resources` had **zero** occurrences
across all three client packages, the nine `CHANNEL_LIMITATION_CODES` name no
entity at all, and Shopify's only two limitations are `informational` — which the
channels list filters out, so it displayed none.

`CHANNEL_SYNC_ENTITIES` (11) is the vocabulary that fixes it: a SUPERSET of
`CHANNEL_SYNC_RESOURCES` (3), and the difference is the point. The three
resources are what a sync SETTING can address; the eleven are what a merchant
asks about, including `gift_cards`, which Mercaria models nothing of — "we have
no such record" is an answer and its absence from a list is not.

`ChannelTypeDescriptor.entityCoverage` answers every one of them, for every
channel type, in tuple order. **Totality is the whole value.** A list of what a
channel carries is silent about everything else, and that silence is what
produced the report.

- **The carried half is DERIVED and restated nowhere.** `products`, `inventory`
  and `orders` come from the descriptor's own `resources`, which comes from
  `ConnectorProvider.capabilities`, which #69's contract suite measures on both
  branches. There is no spelling of a push the coverage could claim that the
  provider refuses.
- **The absent half is a DECISION, and silence is not one.**
  `CHANNEL_ENTITY_POLICY` is a `Record` over the whole tuple, so an entity added
  to it fails `tsc` until somebody says what happens to it — the
  `MERGE_REHOMING_PLAN` shape, where a table that must NOT move is as much a
  decision as one that must.
- **Three-valued, because two-valued was wrong in the direction that generates
  the next false report.** Both pull connectors carry collection MEMBERSHIP onto
  a listing through the connection's `collectionMapping`, and neither creates a
  Mercaria collection — #376 below is the merchant surface that makes that
  mapping settable, and it targets a MANUAL collection they already made.
  `synced` promises collections will appear; `not_synced` denies data that
  demonstrably arrives. `partial` says what actually happens. A `push_in`
  connection is excluded and reads `not_synced`, the same fact #376 reports as
  `push_in_connection`: Mercaria holds no credential to ask that site anything.
- **A model-level absence outranks the channel asking.** `gift_cards` reads
  `not_modelled_by_mercaria` on Etsy as well as Shopify; refining it to
  `channel_not_implemented` would promise it arrives once somebody writes an Etsy
  connector. Only `not_built_for_this_channel` — the one reason that IS relative
  to a channel — is refined, and then from facts already on the descriptor.

`services/channels/__tests__/channel-entity-coverage.test.ts` is what keeps it
true, and it is the honest half of the work: a coverage statement that goes stale
in silence is **worse** than the silence it replaces, because a merchant acts on
it. Completeness over the whole `channelType × entity` cross product; a census
walked off the REAL provider objects that refuses any own member in neither the
entity map nor the explicitly-non-entity one; agreement between the two, so a
policy that outlived its code cannot stay green; a MEASUREMENT running the real
normalizers for the one claim neither covers; vacuity floors on every population;
and a mutation self-test per comparison.

The gate found two invented member names on its first run — `verifyWebhook` and
`parseWebhook`, which `ConnectorProvider` does not have — which is the reverse
direction earning its place before the forward one was ever needed. It then fired
on its first rebase, refusing #376's `fetchCollections` and `externalTaxonomyNoun`
until each was classified, which is the point.

That rebase also corrected the agreement gate. It compared the entities a
provider's members reach against the ones the coverage calls `synced`, and passed
for the wrong reason: nothing reached a `partial` entry, so the stricter
comparison was never exercised. It now compares against every entry that is not
`not_synced`, which is what a member census can honestly testify to — a member
says WHICH entity is touched and cannot say to what DEGREE. The degree is kept
true by measurement instead: the real normalizers are run, and the import path is
probed for a `createCollection` it must not grow.

#### The caveat is a promise about money, so it is held by the schema

`breakdown_only_on_imported_orders` tells a merchant that each imported order
shows the lines it was charged **and** that *"the rule behind them is not created
in Mercaria, so you cannot edit or reuse it here."* Both halves were true only
because of how `buildExternalOrderDoc` and its two mappers happen to be written.
A claim of that kind — on a screen, about what somebody may and may not do with
money — is exactly what this gate exists to stop going stale in silence, and it
had already gone stale once within a day. So each half is now a fact about the
system rather than about today's code:

- **The RULE has nowhere to land.** The real drizzle columns of
  `order_applied_discounts` and `order_tax_lines` are audited: nothing scope-,
  usage-limit-, combinability-, validity-window- or jurisdiction-shaped, and no
  pointer at a Mercaria `discounts` or `tax_rates` row. The tables hold one
  discount's APPLICATION to one order and cannot be widened into the record
  itself without this failing. Mutation-tested — adding `usageLimit`, or a
  `taxRateId`, turns it red.
- **The LINES really arrive.** Both real normalizers are run on a payload
  carrying a discount and a tax line. The source-shape binding above is
  satisfied by `toAppliedDiscounts` mapping an array that is always empty; only
  running the providers rules that out. Mutation-tested on each provider
  independently.
- **A probe token that can never fire is the same defect as a stale claim.** The
  forbidden-writer map is keyed on a type-only union of the real exports of the
  eight modules that create these records, so a renamed writer fails `tsc` in the
  map. It had to be: the previous list looked for `createRefund`, which names no
  writer in this repository — the only `createRefund*` is `createRefundSchema`, a
  zod schema — so one of its three tokens could never have fired.

**A consequence worth knowing before reading the channel list.** `partial_arrival`
renders under **"Syncs"**, and the compact form on the channel list shows entity
NAMES only, so a merchant browsing sees "Syncs: … Discounts, Tax rates" with the
caveat one view away on the detail screen. That was weighed and accepted: the
alternative reading, `not_synced`, denies data that demonstrably arrives, which
is the failure the three-valued state exists to prevent. If a merchant is ever
misled by the list alone, the qualifier — not the arrival — is what to move.

### How far back an order import reaches is derived, never stored (#380, #287)

`read_all_orders` is deliberately not requested (`shopify/config.ts`, and adding
it to `DEFAULT_SCOPES` breaks every connect on every deployment), so
`GET /orders.json` reaches **60 days and no further**. A truncated import reaches
`completed` with consistent tallies and is otherwise indistinguishable from an
empty shop — the shape #287 fixed on the ingestion side. This is the
merchant-facing half of the same fact.

`ConnectorProvider.orderHistoryHorizon(scopes)` is a METHOD rather than a
capability flag because the answer is not a property of the shipped code alone:
the same provider gives two answers for two connections. It takes what the
platform GRANTED — a deployment's configured `SHOPIFY_SCOPES` says what was asked
for, and a shop authorized before somebody changed it holds neither.
`toConnectionDTO` applies it and nothing is stored, because the connector that
owns the bound says outright that a stored copy could only disagree with
`Connection.scopes`.

`bounded` is a ROLLING window, so the DATE is computed by the client from `days`
and its own clock: a date baked into a response is stale the moment it renders.
The copy does not tell a merchant to grant the scope — it is granted to an APP on
Shopify's written approval, so the action is Mercaria's and asking them for it
would send them somewhere they cannot go.

WooCommerce answers `complete`: it takes no date bound and throws
`unprovableEnumeration` rather than reporting a short read as a whole history. A
`push_in` connection answers `not_synced` — a horizon over something that never
arrives would be a bound on nothing. A provider this deployment no longer
implements answers `unknown` rather than throwing.

`Connection` also gained `channelType`, derived by `channelTypeForConnection` in
the same statement, so a client can find a connection's descriptor without
re-deriving "a WooCommerce connection in `push_in` mode is the plugin" — the
spelling that would drift is the client's.

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

### Webhook registration has a TRIGGER, and its population is derived (#262)

`registerWebhooks` was already the reconciling path — it reads the platform's own
subscription list, adopts on Shopify, recreates on WooCommerce, and converges a
shop carrying orphans. What #218 left missing was anything that RE-RAN it: its
two call sites were both on connect, so "self-healing on the next reconcile" meant
a person re-authorizing the channel. #262 adds the trigger and no second
implementation, because two paths establishing one connection's webhook state
could disagree and the disagreement would be invisible until a merchant noticed
their prices had stopped moving.

**The population is DERIVED**, from the same rows `ChannelReadiness` already reads
as `degraded`: refused topics a retry could take, or an EMPTY `webhookIds`, which
is the only trace a registration that THREW leaves — it writes no ids and no
refusals. A stored "needs re-registration" flag would be a second representation
of a fact the refusal rows already carry.

**What it cannot see is stated rather than papered over.** A connection whose
stored ids the platform no longer has shows neither symptom, so no derivation over
Mercaria's own rows finds it; only re-registering everything on a schedule would,
which would knock at every merchant's shop every cycle about a state nobody has
observed. That is also why #218's shared-address guard in `disconnect` is still
load-bearing rather than merely delaying the problem — a sibling robbed that way
is exactly the invisible case. The remedy is the on-demand button.

**Only the retry BOOKKEEPING is stored** — five columns on `connections`: a
`pending | dead_letter` state, the consecutive automatic attempts, when the next
one is due, and the lease pair. A disconnect clears them in the statement that
clears the credentials and a reconnect resets them in the upsert that establishes
it, so a dead-lettered connection cannot survive a re-authorization and a
disconnected one cannot carry a live claim.

**The lease is not tidiness.** WooCommerce fixes a webhook's secret at creation,
so two passes recreating one connection's topics leave whichever finished LAST
storing its secret over the other's live subscriptions — every delivery 401s from
then on, permanently and silently. The realistic racer is a merchant pressing
re-register while the sweep is mid-flight, so the on-demand path takes the same
claim and answers `not_claimed` rather than bypassing it.

**A re-registration REUSES the stored secret rather than rotating it.** Mercaria
holds no previous-secret grace for a connection the way it does for Stripe and
CrowdSource, so minting a fresh one would 401 every delivery already queued under
the old one until the swap landed. Recreating with the same secret leaves the
stored envelope verifying survivors and recreations alike. The CONNECT path still
mints, which is the window #218 already had and the one a grace column would
close.

**A scope refusal STOPS.** `permission_denied` and `topic_not_supported` are the
two the vocabulary itself says no retry can fix, so they dead-letter on the first
attempt instead of spending the budget; everything else gets a capped exponential
backoff over twelve attempts. The retryable half is derived by SUBTRACTION, so a
reason added later is retryable by omission — the bounded cost of noise, rather
than a channel dark for a reason nobody classified.

**The merchant surface is `WebhookHealth` on the channel screen, and it renders
even when nothing is refused.** Deliberately: the one state the derived population
cannot see — a merchant deleting Mercaria's webhooks in the platform's own admin —
shows no symptom at all, so a control that only appeared on a recorded failure
could never be pressed for exactly the case it is the remedy for. The healthy copy
says so rather than implying the panel is a problem report.

Its state comes from `deriveWebhookDelivery` (`components/channels/channel-presentation.tsx`),
which reads `webhookRegistration` BEFORE `webhookFailures`, and that order is
load-bearing rather than stylistic. A registration that THROWS is caught before
anything is recorded, so a connection can be `dead_letter` with an EMPTY refusal
list — and a panel keyed on the refusals first renders that as healthy, which is
the worst direction available. `connector-webhook-reregistration.service.test.ts`
pins the premise (a thrown registration records nothing) so the ordering cannot
quietly become arbitrary.

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

### A collection mapping may only target a MANUAL collection (#376)

`syncSettings.collectionMapping` was configurable through the API and set by NO
Mercaria client, so every imported product landed in no collection and no
merchant could change it. `GET /:connectionId/collections` and the dashboard
panel are what close that; two rules hold the result together.

**The mapping's KEYS must be the platform's own ids, and they are the ids the
provider writes into `NormalizedProduct.collectionRefs`.** A picker offering a
handle, a slug or a name stores a key no import can ever match, and
`applyCollectionMapping` reports nothing when a ref misses — so the failure is a
merchant watching a correctly-configured mapping do nothing, forever.
`fetchCollections` is therefore its OWN provider call rather than a projection of
Shopify's per-run collection index, which carries ids and no titles.

**The TARGET must be a manual collection, and the reason is that two writers
would otherwise own one row.** `applyCollectionMapping` and
`reconcileAutomatedMembership` both write a NULL `position` into
`listing_collections`, so neither can see the other's row as foreign: the rules
engine deletes the connector's membership because the listing does not match the
rules, and the connector deletes the rule-derived one because the platform did
not name the ref. Whichever ran last wins, with no error anywhere. The refusal is
stated TWICE and the two are not redundant — `updateSyncSettings` answers a 400
naming the collection, because a merchant is present who can fix it, and
`applyCollectionMapping` filters both its managed and its desired set, because
the target may have been deleted or converted to automated AFTER a valid mapping
was stored and nobody is present then. A deleted target is the sharper of the two:
`listing_collections.collection_id` is a real foreign key, so before #376 it
raised `23503` and the run counted a per-product FAILURE naming the product while
the cause was a collection nobody had looked at.

The two platforms differ in exactly two ways and both are DECLARED rather than
assumed: `ConnectorProvider.externalTaxonomyNoun` (Shopify says "collection",
WooCommerce says "category" — a screen using the wrong word names something the
merchant cannot find in their own admin) and whether the taxonomy nests, carried
per row as `parentExternalId`. There is deliberately no `listsCollections`
capability: both providers publish a complete named list, so the `false` branch
would be one no provider takes — a gate that cannot fail, which reads as
coverage.

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
| `GET /:connectionId/collections` | the platform's own collections/categories, the manual collections a mapping may target, and each stored row's health (#376) |
| `GET /summary` | connectors, feeds and the native catalogue in one shape |
| `GET /readiness` | the ONE authoritative readiness result |
| `GET /audit` | who changed what |
| `GET /:connectionId/runs` | the sync history |
| `GET /:connectionId/reconciliation` | what is already indexed, and the overlaps |
| `POST /:connectionId/webhooks/reregister` | register the platform webhooks again, without a reconnect (#262) |
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
- **No entity-shaped `CHANNEL_LIMITATION_CODES` member (#380).** A limitation is
  something WRONG with a channel a merchant should weigh before choosing; "this
  channel does not carry discounts" is its ordinary scope. Folding coverage into
  that tuple would have made the wizard warn about eight non-defects per channel
  and would have broken the exact-open-issue assertion that keeps the list from
  only ever growing. They are separate fields and the list screen renders both.
- **No horizon on the DESCRIPTOR.** Shopify with `read_all_orders` and Shopify
  without it are the same channel type; the bound belongs to the grant one
  connection holds, and putting it on the descriptor would report the same bound
  for two shops that have different ones.

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
   a real merchant conflict, and no handle dedup was added. Since #292 that
   failure NAMES the incumbent listing and the connection holding the handle
   (`asNamedHandleCollision`) instead of surfacing as a bare `23505`.
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

The ids it persists are the platform's whole truth about Mercaria's delivery URL,
not "what this attempt created": an undeleted duplicate, a blocked recreate's
survivors and a retired topic that would not go are all named, because each is
still delivering and its id is the only handle a later reconcile or the
disconnect can remove it by. A `created`/`retained` marker on each is what keeps
the WooCommerce secret honest — a fresh per-connection secret is stored only when
something was actually created with it, so an attempt whose deletes were all
refused leaves the envelope that still verifies every live delivery in place.
When a delete IS refused on WooCommerce the new secret is still stored, and that
is a choice between two broken states rather than a clean one: the blocked
topic's subscription then 401s, the merchant is told (it is in `failures`), its
id is retained so the next reconcile deletes it before recreating, and every
other topic works meanwhile.

**#259 is FIXED and adds no limitation code either** — and that is the decision
rather than an omission. What it changes is when a sync may CONCLUDE something:
an incomplete variation response and an unprovable catalogue enumeration are now
refused instead of imported, and a variant is matched on the platform's own
variation id rather than on a SKU a merchant is free to edit. None of that is a
capability a channel does or does not have, so a code here would render copy
about a gap no descriptor produces. What a merchant sees is the ordinary sync
record: the refused product is counted `failed` on its `sync_runs` row with a
message naming the gap kind and the ids, and a refused webhook fails its run with
the same message as `error`.

### The shop's own publish state decides what is on sale (#377, #379)

A connector must never put a product on sale that the merchant is not selling.
`NormalizedProduct.publishState` is the one fact that says so — `published` /
`unpublished`, ABSENT when the provider reports none, which is never read as
either verdict.

- **Each provider derives it as the complement of ONE constant**, so there is no
  list of unpublished spellings to keep in step with a platform: WooCommerce
  against `PRODUCT_STATUS` (the status its pull filters on), Shopify against
  `PUBLISHED_PRODUCT_STATUS` (`active`). Shopify's `draft` and `archived` are
  therefore both `unpublished`.
- **One rule, one place.** `importProduct` is the chokepoint every path reaches,
  and the unpublish branch lives there — above the incomplete-enumeration
  refusal, because knowing a product is unpublished does not require knowing its
  variants. #377 put it on the webhook path; #379 moved it in rather than adding
  a second copy, because the PULL reaches `importProduct` without passing the
  webhook handler, and two implementations of one decision differing by path is
  the defect #377 exists to close.
- **The verdict is ARCHIVE, never `draft`.** #377's argument was that an
  unpublished product is filtered out of the pull and so archived as unseen
  anyway, making `draft` a state the next reconcile overwrites. That argument
  does NOT transfer to Shopify, whose pull sends no status filter — the product
  is returned, is therefore SEEN, and the unseen sweep never touches it. The
  reason to agree anyway is that `publishState` is binary: a third member carried
  solely so Shopify could say `draft` would be a second vocabulary for one fact,
  which costs more than the distinction buys. Archiving is a soft-delete, so
  order history and provenance survive either way.
- **A product never imported is SKIPPED, not created archived.** There is no
  order history or provenance to preserve, so a row nobody can buy is a row
  nobody needs — and it is what keeps `createStoreProduct`'s status set free of
  `archived`.
- **An unpublish may not archive a RESTRICTED listing.**
  `enforcement.service.restoreSubject` restores only from
  `['restricted', 'draft']`, so a restricted listing moved to `archived` can
  never be relisted by an accepted appeal — archiving is a soft-delete
  everywhere else and a one-way door against a restriction. Scoped by an opt-in
  to the callers that act on an explicit unpublish; the `product_delete` path is
  deliberately unchanged, because a product deleted upstream is gone whatever
  Mercaria was deciding about it.
- Two things are deliberately absent. **Shopify's pull sends no `status` query
  parameter**: which values `products.json` accepts cannot be verified from this
  repository and a wrong one 400s the entire fetch, while classifying what
  arrives is correct whatever the default is. And **there is no backfill
  script** — the ordinary sync converges and is idempotent.

**OPEN:** whether `GET /products.json` returns drafts and archived products when
no `status` filter is passed. It bounds how much the first sync after deploy
changes, not whether the rule is right, and the defect is real under either
answer — a `products/update` delivery carries `status` and fires exactly when a
merchant drafts or archives a product. If drafts ARE returned, the first sync
archives every listing whose Shopify source is currently a draft or archived.

### A product republished upstream comes back — but only when this connector archived it (#390)

`toUpdatePatch` writes seven fields — title, description, images, vendor,
product type, handle, SEO — and still never `status`, because a republish is not
a field merge: writing `status` on every pass from a value the platform reports
is exactly what would reactivate a listing the merchant archived in Mercaria on
purpose. The republish is ONE conditional transition out of `archived`,
`restoreListingArchivedByThisConnector`, taken against a stored fact.

**The stored fact is `listings.archived_by` plus `listings.archived_from_status`.**
Before them nothing separated "archived by the connector, republished upstream"
from "archived by the merchant here, still absent upstream" — `listings` carried
no `archived_by`, no `status_source` and no status-history table, so #417 could
only record the indistinguishability as the finding. The shape came from
`moderation_enforcements.previous_state_listing_status`, which stores what a
restriction replaced precisely so a reversal has something true to put back.

`db/catalog/listingRepository.ts` is the only author of both, exactly as it is
the only author of `published_at` (#261): the three statements that can write
`listings.status` derive them from the status they are writing — the CAUSE from
the caller, the PREVIOUS STATUS from the row's own pre-update `status`, in the
same SQL. `ListingColumnPatch` and `NewListing` subtract the two columns, so no
caller can state either directly, and archiving with no cause THROWS.

| cause | writer | on a republish |
|---|---|---|
| `merchant_delete` | `catalog-write.archiveListing` (the seller/admin DELETE) | survives |
| `merchant_status_change` | `catalog-write.updateListing` with `status: archived` | survives |
| `channel_disconnect` | `channel-disconnect.disconnectChannel` under `archive_listings` | survives |
| `connector_product_deleted` | the `product_delete` webhook | UNDONE |
| `connector_unseen_in_backfill` | the post-backfill reconciliation | UNDONE |
| `connector_unpublished` | an upstream unpublish (#377/#379/#386) | UNDONE |
| `moderation_restore` | `enforcement.restoreSubject` putting a listing back into `archived` | survives |

The three `connector_*` causes are the ones where the archive was a MIRROR of the
product's absence, so the product being back is the same fact reversing rather
than the connector overruling anybody. `ARCHIVE_CAUSES_UNDONE_BY_REPUBLISH` names
them explicitly rather than matching a `connector_` prefix, so a cause added
later is not restorable by omission, and
`db/__tests__/listing-archive-census.test.ts` fails the build on a cause that is
in neither list. `merchant_status_change` is the entry to read: it is a SECOND
merchant archiver in the same FILE as `archiveListing`, so the file-grained
archiver census that sits above it in that test could never have separated them.

**Two things the restore deliberately refuses, both of them traps rather than
missing cases.**

- **It is not gated on `respect_overrides`, and must not be.** That policy asks
  which fields the merchant PINNED; `status` is one of three keys
  `services/catalog-field-pins.ts` excludes by an argued decision (#416 — an
  imported product lands `draft` when the connection does not auto-publish, so
  the merchant reviewing it and publishing it is the intended workflow, and
  pinning there would stop the platform ever unpublishing that product again).
  A restore gated on it would read a set that never contains `status` and
  republish every archived listing regardless of who archived it, which is the
  failure it would exist to prevent, wearing a setting's name. `autoPublish`
  cannot answer it either — it is read on the CREATE branch and by nothing on
  update, and it describes what a NEW import should be rather than what this
  listing was.
- **It never restores to a hardcoded `active`.** `enforcement.service.ts` argues
  this one domain over: a listing imported under `autoPublish: false` has never
  been on sale in its life, and un-archiving it to `active` would put it there.
  The previous status is read off the row the archiving statement wrote.

It also refuses an UNKNOWN cause (both columns NULL — every row archived before
this shipped, deliberately not backfilled, because the two cases are separated by
no surviving evidence and inventing the connector half is the wrong guess), a
recorded archive with no previous status (the write was not a transition, so
there is nothing true to put back), and a previous status in
`MODERATION_HELD_LISTING_STATUSES`. That last one is #402 from the other side:
the `product_delete` path archives from ANY status on purpose, so
`archived_from_status` can be `restricted`, and a connector may not write
`restricted` in either direction. Such a listing stays archived, where
`restoreSubject` reaches it.

Both legs are pinned in the connector contract suite and neither means anything
alone: "a republish relists it" is satisfied by a connector that relists
everything, and "a merchant archive survives" is satisfied by doing nothing.

### A per-record failure has a durable reason (#303)

A run is `failed` only when NOTHING succeeded, so the commonest shape — a mostly
successful sync with a handful of refused products — records `completed`. #294
gave that run a SUMMARY in `sync_runs.error`, and the summary is deliberately
elided at three reasons with three ids each, so a run of `0/0/0/100` names nine
products.

`sync_run_record_failures` is the per-record residual behind it —
`catalog_source_rejections` (#62) one domain over — carrying the subject KIND,
the platform's own external id, a classified reason code
(`refused_by_rule | duplicate_record | database_refused | unclassified`) and a
bounded detail. `sync_runs.error` is unchanged and is NOT widened further: it is
one column for a whole run, and a `completed` run with one failure has no honest
place to put a growing list.

Both are composed from ONE input by ONE classifier
(`classifyMerchantFacingFailure`) inside ONE transaction with the run's close, so
the at-a-glance line and the full list cannot disagree — and a raw driver
statement can no more reach a row than it can reach that column (#292). Retention
is 30 days: this is the only table in `connectors.ts` bounded by TRAFFIC rather
than by a merchant's channels, and expiring a page costs the DETAIL while the
tally and the summary stay on the run.

The merchant reads it at
`GET /admin/stores/:storeId/channels/:connectionId/runs/:runId/record-failures`,
behind the same `channels:write` the history is behind — a separate call rather
than a field on the run list, because fifty runs times two hundred reasons is a
payload nobody asked for and a per-run query is an N+1. The page reports the
run's own `failedCount` beside the list, and the two legitimately differ: a
whole-run failure counts one without naming a record, a run may refuse more than
one page stores, and rows expire while the run does not.

**All three rails report.** #294 covered the push ingest and the pull backfill;
#303 added `syncOrders` and `syncInventory`, which until then did
`counts.failed += 1` plus a `log.general.warn` and passed no failures at all — so
an order sync that refused eleven orders recorded `completed`, a tally of eleven
and a NULL `error`.

Runbook §8.5 is also surfaced, as copy rather than a limitation: a no-change
resync tallies as `updated`, because the patch is built from every unpinned
connector-managed field whether or not it changed.

### An imported order carries its discount, tax and shipping BREAKDOWN (#378)

A merchant with a live Shopify store reported that "discounts are not syncing".
The totals always reconciled — `total_discounts_set` and the tax total were read
and carried from the first version — but `appliedDiscounts` and `taxLines` were
the literals `[]` on every imported order from both providers, and the coupon
CODE was never carried at all. Underneath, neither provider's zod schema even
named the fields: Shopify's `discount_applications` / `tax_lines` /
`shipping_lines` and WooCommerce's `coupon_lines` / `tax_lines` /
`shipping_lines` were absent, so a merchant saw a discount total with nothing
saying which coupon produced it. `shippingMethod`/`shippingLabel` were the
literals `'standard'`/`'Shipping'`.

**Shopify states a discount's MONEY only in the per-line allocations.** A
`discount_applications` entry carries the RULE — `value` plus `value_type`, e.g.
"10" and "percentage" — and never an amount; the money lives in the
`discount_allocations` on each line item and shipping line, pointing back at the
application by INDEX. So the amount is the sum of those allocations, which is
arithmetic over what the platform published rather than a re-pricing. It reads
`discount_applications` rather than `discount_codes` because the first covers
automatic and manual discounts too.

#### Two decisions, and both cut against tidying the data

**A breakdown that does not reconcile with its own total is recorded as it
arrived.** Nothing scales a line to fit, invents a balancing line, drops the
lines that overflow, or refuses the import. This is not a defensive edge case:
Shopify leaves a shipping-targeted discount OUT of `total_discounts`, so any
free-shipping code makes the sum of the breakdown EXCEED the carried discount
total, routinely and correctly. Both figures are the platform's own statements
and Mercaria carries each verbatim — the rule the currency contract already
states for an imported order's amounts, applied one level down. There is
deliberately no warning logged on a mismatch either, because a log that fires on
healthy data is a log people learn to ignore.

**The breakdown is written on a FIRST import and never backfilled.** A re-sync
still refreshes only `status`, `paymentStatus` and `source`. An order's totals
are frozen at import (`insertOrder` is their only writer) and a platform order
stays editable afterwards — a Shopify order edit, a WooCommerce admin changing a
coupon — so a breakdown taken from today's payload written beside totals frozen
from then would be one financial record whose halves come from two different
moments, which is worse than an absent breakdown. Nothing reads these rows for
money (`refund.service` computes against the order's lines and totals), so an
older order keeps reconciling exactly as it always has and loses only the
display. Re-importing an order with fresh totals MOVES its money and is a
separate decision for its own issue.

#### Unknown is stored as absence, never as a plausible default

`order_applied_discounts.value_type` and `order_tax_lines.rate_bps` became
NULLABLE (migration `0087`, `pre` — both widen, and the serving image writes a
value into each on every row it creates). The value-type CHECK is untouched and
stays exactly as tight as `discounts_value_type_check`; the tuple was
deliberately NOT widened with an "unknown" member, because that member would
also become creatable on the `discounts` table.

A WooCommerce order coupon line is a CODE and an AMOUNT — the coupon's own
`discount_type` is not part of the order payload — so an imported WooCommerce
discount carries NO value type where a Shopify one carries the platform's own.
`publishesDiscountValueType` on the contract harness declares that per provider
and the suite measures BOTH branches, because asserting the ABSENCE is the only
thing that stops somebody defaulting it to `fixed_amount` later: a false snapshot
of another shop's discount, which no other check here would notice. Closing the
gap means reading a real store's `coupon_lines[].meta_data` to learn the shape
WooCommerce actually publishes there rather than guessing at one — see the
runbook.

Two more places the same rule bites. The shipping METHOD stays `standard` and
only the LABEL carries the platform's text: `SHIPPING_METHODS` is Mercaria's
closed `standard|express|pickup` set, no platform publishes a value from it, and
the guess that lands on `pickup` changes how an order is fulfilled. And every
allocation is `target: 'order'` — `targetLineIndex` is an index into Mercaria's
OWN lines and neither platform states that mapping, so a line target would risk
attributing a discount to the wrong item, and it is the only shape a shipping
discount can take at all.

**WooCommerce `fee_lines` is deliberately not read.** A fee ADDS to the order
total and Mercaria's order model has no slot for one; reading it into
`appliedDiscounts` would record an addition as a reduction, and a negative fee
(which some plugins use to express a discount) is still a fee, so telling the two
apart would be a guess. The fee is already inside the carried `total`.

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
- **A record-level error EXPORT for CONNECTORS** (#87 management 9). The
  per-record TABLE this entry said was owed now exists — #303's
  `sync_run_record_failures`, read at
  `GET .../channels/:connectionId/runs/:runId/record-failures` — so what is left
  is the DOWNLOAD, in #63's CSV shape with values excluded. Formatting the rows
  this endpoint already serves is the whole of it. #221 was the defect that
  produced the errors worth exporting and it is fixed, so the export is about the
  ordinary per-product failures a real catalogue produces (a malformed price, a
  SKU colliding with an existing variant) rather than about a stranded listing.
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
