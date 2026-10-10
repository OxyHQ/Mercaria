# Catalog photos and videos

The catalog gallery has one ordered collection. `Listing.media` and
`CanonicalProduct.media` are discriminated `image | video` entries carrying
public, durable Oxy `fileId`, position and optional alt text. Media delivery URLs
are resolved by the Oxy SDK in clients; supplier URLs are import inputs only.
`Listing.media` is optional so previously persisted DTOs remain readable: clients
may fall back to `images` with `kind: 'image'` when the field is absent.

The physical `listing_images` and `canonical_images` names are retained to
preserve deployed row IDs, references and provenance. Migration 0167 adds a
`kind` discriminator, defaulting existing rows to `image`. The legacy `images`
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
a canonical operator owns them; this does not authorize attaching another
account's new files. The response discriminator is derived from verified MIME,
never from an extension or caller-declared kind.

`POST /admin/stores/:storeId/products/media` retains `products:write` authority
before reading bytes. The service upload uses the central Oxy service client and
the persisted store owner, not the staff member or a request header. Images have
a 20 MiB cap; initial video support is MP4 with a 40 MiB cap. Both byte signatures
and returned Oxy video MIME/size are checked. The response adds `kind` beside the
existing `fileId`. Removing an editor selection detaches it on Save; it never
deletes the shared remote file. Failed uploads and saves retain the draft.

Connector push DTOs and normalized pull products may provide ordered
`mediaSources: {kind, reference}[]`. Push `images` and `mediaSources` are mutually
exclusive; old `images`/`imageUrls` remain image-only. Providers must actually
supply video sources: the Shopify REST adapter is not claimed to expose video.
Canonical observations accept `media` with explicit kinds instead of `images`,
retain source provenance/rights and import before opening their transaction.
The source rights are checked again inside that transaction.

The existing safe importer downloads HTTPS sources with pinned DNS, bounded
bytes and redirects, then uses Oxy's durable public user-media endpoint. It never
forwards supplier credentials or publishes a failed partial gallery. Video
sources must return MP4 bytes; an arbitrary existing Oxy ID plus `kind: video`
is not accepted as verification by the source-import route. Existing uploaded
videos enter via the authenticated merchant metadata verifier instead. Image
IDs retain the legacy import path, with SQL refusing to relabel a known video.

## Rollout and rollback

`CATALOG_VIDEO_WRITES_ENABLED` defaults to false. It gates new video upload,
verification and import, **not reads of stored records**. Deploy in this order:

1. Apply additive migration 0167 through the ordinary migration runner.
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
