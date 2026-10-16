# Catalog photos and videos

The catalog gallery has one ordered collection. `Listing.media` and
`CanonicalProduct.media` are discriminated `image | video` entries carrying
public, durable Oxy `fileId`, position and optional alt text. Media delivery URLs
are resolved by the Oxy SDK in clients; supplier URLs are import inputs only.
`Listing.media` is optional so previously persisted DTOs remain readable: clients
may fall back to `images` with `kind: 'image'` when the field is absent.

The physical `listing_images` and `canonical_images` names are retained to
preserve deployed row IDs, references and provenance. Migration 0168
(`0168_land_review_and_catalog_media`) adds a `kind` discriminator, defaulting
existing rows to `image`. The legacy `images`
DTO and all feed/cart/search/SEO/thumbnail projections remain image-only. A
video-only product has no fabricated image thumbnail in those projections.
Canonical variant media and listing variant assignments remain image-only; a
composite FK plus a constant CHECK enforces the latter even for direct SQL.
Condition evidence remains photographic. Cross-table triggers serialize claims
for the same Oxy file ID and reject contradictory kinds or video condition
photos in either insertion order. Existing borrowed/canonical media prohibitions
continue to apply to the same retained tables.

## Writes, ownership and imports

Merchant create/PATCH accepts **either** legacy `imageFileIds` **or** ordered
`mediaFileIds`. The latter is verified against Oxy metadata using the caller's
bearer before a catalog transaction. New files must belong to the store's
persisted Oxy account, be public and active, and have an accepted MIME and size.
Already-authorized references in the current listing may be retained even when
another owner holds them; this does not authorize attaching another account's new
files. The response discriminator is derived from verified MIME, never from an
extension or caller-declared kind.

`POST /admin/stores/:storeId/products/media` retains `products:write` authority
before reading bytes. The upload goes through `services/catalog-media/oxy-files.ts`
(`uploadUserMedia`) with the central Oxy service client and the persisted store
owner, not the staff member or a request header. Images have a 20 MiB cap; initial
video support is MP4 with a 40 MiB cap. Both byte signatures and returned Oxy video
MIME/size are checked. The response adds `kind` beside the existing `fileId`.
Removing an editor selection detaches it on Save; it never deletes the shared
remote file. Failed uploads and saves retain the draft.

Connector push DTOs and normalized pull products may provide ordered
`mediaSources: {kind, reference}[]`. Push `images` and `mediaSources` are mutually
exclusive; old `images`/`imageUrls` remain image-only. Providers must actually
supply video sources: the Shopify REST adapter is not claimed to expose video.
Canonical observations accept `media` with explicit kinds instead of `images`,
retain source provenance/rights and import before opening their transaction.
The source rights are checked again inside that transaction.

### Import by URL happens in Oxy (Oxy ADR 0041 D7)

Mercaria no longer downloads supplier bytes. `services/catalog-media/sync.ts`
validates every reference (an Oxy file id, or HTTPS without credentials) before
importing any member of a gallery, then asks Oxy to import each new source:
`importUserMedia(owner, url)` for an account, `importAppFile(url)` for the
application. Oxy fetches with its own SSRF-safe fetcher and remembers
`(owner, URL) → file`, so **an unchanged source imported again answers the same
file id without a download** — which is what ended the connector's re-download of
every gallery on every product update (`connector-import-atomicity.realdb.test.ts`
re-syncs an unchanged product and asserts nothing was fetched and no gallery row
changed). The returned kind is what Oxy MEASURED (`catalogMediaKind(mime, size)`)
and must equal the declared kind; a video is still refused unless
`CATALOG_VIDEO_WRITES_ENABLED`, and an existing Oxy id is not accepted as a video
by this route. No error carries a source URL. No reference is registered at import:
the row that will hold the file is not written yet (see "Usage registration").

**Every call to Oxy Files is in ONE module, `services/catalog-media/oxy-files.ts`**
(import, upload, references, reconciliation, event-signature verification), so a
name that changes upstream is a one-file change. The stage-3 helpers
(`importAppFile`, `importUserMedia`, `verifyFileEventSignature`) are those of the
unpublished `@oxy.so/core` 4.13.0 and are marked `TODO(stage3-sdk)` there.

### Who owns the bytes

| Content | Owner (ADR 0041 D1) | Import call |
|---|---|---|
| A store listing's gallery and description images, condition photos, store logo/cover/policy images, collection images, authoring and seller drafts | the STORE's Oxy account, `stores.oxy_account_id` (acting as it) | `synchronizeStore*` |
| A P2P listing's media | the seller's account | `synchronizeAccount*` |
| Canonical images and canonical description images, category art, brand logos | the **Mercaria application** — never the operator who made the request (it was, until ADR 0041) | `synchronizeApplication*` |
| Review media, evidence documents | unchanged: the uploading account | (uploaded by the person) |
| Digital deliverables | unchanged: `services/digital/storage.ts` | (its own port) |

The owner's decision is that Mercaria copies images from every source it
imports from, including eBay and Amazon; their terms restrict caching, which the
source documents under `docs/catalog-sources/` record. External offer media
(eBay, Awin) is today only a URL in the source record's stored projection: no
offer surface shows it and nothing imports it. A path that starts importing it
does so through `synchronizeApplication*`.

## Usage registration (Oxy ADR 0041 D4–D6, D9)

Oxy keeps an APPLICATION-owned file only while some application references it
(unreferenced for 24 hours → trash → purged 30 days later), and never deletes an
account's file. So every row that holds an Oxy file id is told to Oxy as a
reference `(fileId, entityType, entityId)`, and withdrawn when it stops holding
it. `services/catalog-media/file-reference-registry.ts` is the one registry;
`oxy-file-reference-registry.test.ts` fails the build on a schema column named
like a file id that no entry holds, and on a trigger that disagrees with it.

| `entityType` | `entityId` | Holding rows | Owner | On `file.blocked` / `file.deleted` |
|---|---|---|---|---|
| `listing_image` | `listings.id` (one reference per file per gallery) | `listing_images.file_id` | store / seller | gallery row removed |
| `listing_description_image` | `listings.id` | `<img>` in `listings.description` and `listing_localizations.description` | store / seller | `<img>` removed |
| `condition_photo` | `listing_condition_photos.id` | `.file_id` | store / seller | `rejected` (blocked) / `withdrawn` (deleted) — the row is evidence |
| `store_logo` / `store_cover` | `stores.id` | `logo_file_id` / `cover_file_id` | store | column cleared |
| `store_policy_image` | `stores.id` | `<img>` in the four `policies_*` texts | store | `<img>` removed |
| `collection_image` | `collections.id` | `.image_file_id` | store | column cleared |
| `seller_draft_image` | `seller_listing_drafts.id` | `seller_draft_images.file_id` | store / seller | row removed |
| `authoring_draft_image` | `catalog_authoring_drafts.id` | `.image_file_ids[]` | store | removed from OPEN drafts (`version` bumps); a published draft is the record |
| `canonical_image` | `canonical_images.id` | `.file_id` | application | `suppressed` — the row is provenance |
| `canonical_description_image` | `canonical_products.id` | `<img>` in `.description` and `canonical_product_localizations.description` | application | `<img>` removed |
| `category_image` | `categories.id` | `.image_file_id`, or an Oxy URL in legacy `.image_url` | application | cleared |
| `brand_logo` | `brands.id` | `.logo_file_id` | application | cleared |
| `organization_archive_logo` | `organization_identity_archives.id` | `.logo_file_id` | application | retained (immutable evidence) |
| `review_media` | `reviews.id` | `review_media.file_id` | the author | row removed |
| `return_request_evidence`, `retail_service_request_evidence`, `supplier_agreement_evidence`, `retail_resale_evidence`, `retail_compliance_evidence`, `merchant_claim_evidence`, `relationship_evidence` | the evidence row's `id` | its `file_id` / `oxy_file_id` | the uploader | retained (evidence) |
| `order_item_image` | `order_items.id` | an Oxy URL in `.image_url` | store / seller | retained — order history is never rewritten |
| `digital_asset_file` | the storage key itself | `asset_files.storage_key` | the creator | retained |

**How a write becomes a reference.** A trigger of migration `0169` on every
holding table (`mercaria_oxy_file_reference_touch`) enqueues the ENTITY into
`oxy_file_reference_outboxes`, in the writer's own transaction, on every insert,
delete and update of a watched column — so a cascade (deleting a listing deletes
its gallery), a merge, a backfill and an operator's SQL are all covered, and a
rolled-back write leaves no request. The row names the entity, never the file:
the worker (`file-reference-outbox.ts`) reads what the entity holds NOW from the
registry, diffs it against `oxy_file_references` (what Oxy acknowledged), and
sends the difference (`references.add` / `references.remove`, 100 per request).
It is the offer outbox's fixed point: one row per entity, a revision pair so a
write landing mid-run re-arms it, leases with an owner check
(`FOR UPDATE SKIP LOCKED`), capped exponential backoff and a visible
`dead_letter`; a converged row is DELETED rather than marked done, so the table
holds only owed work. An Oxy failure never blocks or rolls back the catalogue
write and never loses a removal: the row stays until Oxy answered. A file id Oxy
refuses (`not_found`) is recorded `refused` and asked again by the next write to
the entity or the next reconciliation. Two types have no trigger: `order_item_image`
(a checkout write is never made to depend on this — the reconciliation registers
it, and a trashed file comes back with the reference within Oxy's 30 days) and
`digital_asset_file` (registered by `services/digital/storage.ts` at upload, and
not reconciled because `asset_files.storage_key` is read in exactly one place).

**Reconciliation** (`file-reference-reconciliation.ts`, ADR 0041 D6) sends Oxy
the whole inventory of one entity type, streamed in keyset pages; Oxy adds what
it is missing and removes what it holds from before the run that the inventory
lacks. One row per type in `oxy_file_reference_reconciliations` is leased so one
task runs a type (Oxy allows one open session per type), every
`OXY_FILE_RECONCILIATION_INTERVAL_HOURS` (24), retried in 30 minutes on failure,
with the last counts on the row. After a real run the ledger is rewritten to the
inventory. It is the safety net and **how existing data enters the model**: the
first run of each type registers every file Mercaria already used.
`OXY_FILE_RECONCILIATION_DRY_RUN` (default ON) commits every run as a dry run —
read each type's first counts before switching it off.

**File events** (ADR 0041 D9). `POST /webhooks/oxy-files` is the SIXTH raw-body
mount (above `express.json()`, asserted by `oxy-files-webhook.integration.test.ts`).
It answers Oxy's `webhook.challenge` unsigned, and verifies every event with
`verifyFileEventSignature` (`oxy-signature`, HMAC over the raw body, five-minute
window). One transaction per event: the dedupe claim on Oxy's event id
(`oxy_file_events`), the presentation change of every registry entry with a
detach, and one append-only `oxy_file_event_actions` row per entity (`removed`,
`suppressed` or `retained`). The changes fire the reference triggers, so the
withdrawn uses are withdrawn from Oxy by the same outbox. Only `file.blocked` and
`file.deleted` change anything; `trashed`, `restored`, `visibility_changed` and
`unblocked` are recorded only (an owner may restore what they trashed, and a
removal is not reversed automatically). A takedown scans every holding table for
the file id — unindexed on purpose for the rare event, rather than trusting a
ledger that lags its writes.

### Levers and the release order

| Variable | Default | Gates |
|---|---|---|
| `OXY_FILE_REFERENCES_ENABLED` | off | the outbox LOOP (the triggers enqueue regardless; switching it on drains the backlog) |
| `OXY_FILE_REFERENCE_POLL_INTERVAL_MS` / `_BATCH_SIZE` / `_MAX_ATTEMPTS` | 5000 / 50 / 12 | the drain |
| `OXY_FILE_RECONCILIATION_ENABLED` | off | the reconciliation LOOP |
| `OXY_FILE_RECONCILIATION_DRY_RUN` | **on** | commits as dry runs |
| `OXY_FILE_RECONCILIATION_INTERVAL_HOURS` / `_POLL_INTERVAL_MS` | 24 / 60000 | scheduling |
| `OXY_FILE_EVENTS_ENABLED` | off | the MOUNT (404 when off) |
| `OXY_FILE_EVENTS_SECRET` | empty | events are refused 503 (Oxy retries ~3.5 days) until set |

Order: Oxy stages 1–3 deployed, Mercaria's application granted
`files:references:write`, `files:app:write` and `files:user-media:write`; deploy
this (migration `0169` is `pre`); `OXY_FILE_REFERENCES_ENABLED=true`;
`OXY_FILE_RECONCILIATION_ENABLED=true` and read every type's dry-run counts on
`oxy_file_reference_reconciliations`; `OXY_FILE_RECONCILIATION_DRY_RUN=false`;
only then may Oxy switch its sweep to `enforce`. For events:
`OXY_FILE_EVENTS_ENABLED=true` → register `https://<api>/webhooks/oxy-files` in
the Oxy console (the challenge is answered) → set `OXY_FILE_EVENTS_SECRET` →
deploy.

### Backfills

Preview by default, `--apply` explicit, reports carry SHA-256 hashes of sources
and never URLs, and every apply is a compare-and-swap that reports `changed` for
an explicit retry. They now import through Oxy (no local download), and the
reference triggers register what they write.

- `scripts/backfill-listing-media.ts` and `scripts/backfill-store-artwork.ts` —
  legacy URL-valued gallery and store artwork, imported as the store's account
  or the seller.
- `scripts/backfill-application-media.ts --target=canonical_image|category_image|brand_logo`
  — into application-owned files: a legacy supplier URL is IMPORTED, and a file
  some account owns (an operator's canonical image) is ADOPTED by importing its
  own public URL as the application's (bytes are shared by content address; the
  account keeps its file, now "not in use", for its owner to decide about).
  Canonical DESCRIPTION images under an operator's account are not re-owned by it.

The canonical observation fixed on the way: a source's identity is its URL
(`attachCanonicalMediaBySource`); `image_ref = coalesce(file_id, source_url)` used
to let a re-import that returned a different file write a second row per
observation. Rows the bug already duplicated are not collapsed by this change.

## Rollout and rollback

`CATALOG_VIDEO_WRITES_ENABLED` defaults to false. It gates new video upload,
verification and import, **not reads of stored records**. Deploy in this order:

1. Apply additive migration 0168 through the ordinary migration runner.
2. Roll out new API **and every catalog/import worker** while video writes remain
   disabled. New legacy-image writers preserve video rows and slots; old binaries
   replace every row and could delete videos.
3. Deploy the new dashboard only after the API rollout completes. Older API
   binaries do not understand `mediaFileIds` and could silently discard that
   new update field; new clients must not send it to an old writer.
4. Verify Oxy metadata and native/web playback with real uploaded files in an
   authorized environment, then enable new video writes.

Disabling the flag does not hide stored media. Do not roll back to an old writer
while video rows exist. Retain the additive columns and constraints when rolling
back an application release. No migration or upload in production is part of
this implementation's test acceptance.

## Storefront player ownership

`ProductMediaGallery` resolves Oxy IDs and owns stable Expo players, while the
shared `ProductGallery` composes Bloom Carousel, MediaSurface and
ZoomableMediaGallery. The `images` projection stays image-only; a missing `media`
field uses that legacy projection, while an explicit empty collection stays empty.
Videos never enter image components or the cart image-flight handle.

Native sessions are initialized paused; inactive web surfaces are detached.
Changing the active medium, leaving the route, backgrounding the app or closing
the viewer pauses playback. Variant changes retain common video sessions. A
failed clip has an explicit retry which creates a new session and retires its
previous player after the view commits. Session identity invalidates Bloom's
viewer snapshot without resetting the selected carousel slot. This uses Expo's
constructor rather than `replaceAsync`: Expo56's web replacement starts playback
and does not handle the HTML play promise on a failed source.

Bloom7.30 supplies the public `onOpenChange` lifecycle signal, including unmount,
and `renderVideoOverlay` for the active fullscreen video.
An isolated browser test checks that opening detaches the inline surface and
closing reattaches it. Negative media tests exercise HTTP404 and retry without
unhandled page errors. They do not prove successful native/web video playback.
Failure controls render on the active surface only. A failure after opening the
viewer remains visible and retryable there. Retrying replaces the failed player,
disposes the old viewer snapshot and returns to the same inline carousel slot;
it does not reopen the viewer or mutate its internal state. Browser regressions
at 390px and 1440px cover this transition, one visible alert and a new request.

## Acceptance limits

Real PostgreSQL tests cover mixed ordering, stable IDs and variant links,
image-only projections, legacy replacement, kind/condition constraints and
concurrent claims. Browser tests at 1440px English and 390px Arabic cover editor
reorder/remove, pending, failed save/retry, video load failure and player disposal.
Their media transports return failures; fixture metadata is not evidence of a
live Oxy upload or successful playback.

The audited Oxy `GET /assets/:id` serializer currently omits `visibility`. The SDK models
that property as optional; a verifier cannot assume a missing value is public.
[Oxy PR 1625](https://github.com/OxyHQ/oxy/pull/1625) adds the stored visibility
to that serializer, with public/private/unlisted route tests; it has not been
deployed as part of this work. Merchant and review verifiers fail closed on that
missing field. Live authenticated gallery-save acceptance therefore requires the
upstream serializer correction to be deployed and checked; success from the
separate service/user-media upload route is insufficient evidence.
