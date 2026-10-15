# Supervised shopping

Oxy owns supervision, contacts, content policy and guardian consent. Mercaria owns catalog review evidence, stock reservations, immutable order/FX allocations and payment settlement. The shared Oxy Supervision screen displays the complete exact purchase and obtains guardian consent; Mercaria never acts as the child or stores a second guardian policy.

## Supported flow

A platform catalog operator opens **Catalog safety** in the existing dashboard. The server checks the existing `CATALOG_OPERATOR_OXY_USER_IDS` allowlist; store owners cannot approve their own listings. The operator reviews the complete bounded text material and allows or withholds its text-only projection. Publishing a listing is not a safety classification. No production items are automatically reviewed by this migration.

A supervised personal account sees only the reviewed catalog and basket. Unknown or failed current-session policy hides the ordinary storefront. Account or supervision changes cancel and clear product queries before mounting the next view. Guest cart merging and private currency-preference requests are disabled for supervised or unresolved personal sessions. Images, seller biographies, reviews and unreviewed descriptions never enter the shopping projection.

The buyer prepares the existing checkout with a stable request key. Every seller order is created in one existing `placeOrders` transaction; the durable buyer/key/request and selection digests recover the same group even after Redis loss or a response lost after cart consumption. Reusing a key with a different selection, destination, currency or other effect conflicts. The initial preparation creates no PSP intent and exposes no client secret.

Oxy approval binds the exact group, merchant account set (including personal sellers), immutable line titles/options/quantities/amounts, delivery effects, shipping, tax, discount, rounding, currency and durable payment identity. Native monetary subtotals must reconcile before conversion. Each converted seller adjustment is bounded by its actual independently rounded components; same-currency adjustments must be zero. Existing immutable FX and ledger records are unchanged.

Payment opens only after Oxy reserves that exact operation. A deadline limits the initial reservation; an already reserved operation retries with its original PSP idempotency key after the deadline. An uncertain PSP timeout never releases the approval. Only the existing verified PSP webhook and durable payment outbox confirm the canonical approval. Provider-confirmed cancellation produces a durable cancellation event; a local timeout or uncertain attempted charge cannot recycle consent.

## Read and authority boundaries

The dedicated `/supervised-shopping` router declares only Oxy `content` and `purchases` actions. Other human routes retain the SDK default denial for supervised sessions. Legacy public catalog routers use canonical optional authentication: ordinary anonymous/adult reads remain available, while a supplied credential must verify: invalid/expired credentials receive 401, a central authority outage receives 503, and a denied supervised session receives 403. None becomes anonymous. Provider webhooks, signed callbacks and machine ingestion keep their existing distinct authority. Public exchange rates carry no seller-authored content.

Unsupported seller/admin, digital/retail fulfillment, AI shopping and communication operations receive no new Kids capability. The supervised purchase path accepts connected-marketplace physical orders and card payment only. The legacy adult/guest checkout continues to use the same existing code and payment seam; it does not gain guardian authority.

## Review bounds and invalidation

A review reads content plus author provenance in one repeatable-read database snapshot, closes the transaction, then asks Oxy about that same author. It never joins old text to a newly fetched owner. A page contains at most 50 listing IDs; hydration and central policy calls are bounded batches of at most 100.

One listing may expose at most 20 variants, 16 option axes, 320 variant option values, 20 image references and 32 condition details, within 64 KiB of serialized review source. Over-limit records are explicitly unavailable; truncated material can never be approved. Purchase titles/options must fit the full canonical approval fields, and checkouts have at most 200 lines. Material edits, changed ownership or withheld reviews invalidate the prior digest. Stock-only changes do not alter classification. Review order uses a database identity sequence under the listing lock, not timestamps or random UUID ordering.

## Deployment

1. Publish and deploy the reviewed canonical Oxy supervision APIs and shared UI. Adopt the actual registry contracts/core/services versions and ordinary lockfile; provisional local build artifacts are test-only.
2. Apply generated additive migration `0168_fluffy_bloodaxe` through the normal migration runner. It adds append-only review/request/approval evidence and the durable payment-cancellation outbox event. It changes no money rows and classifies no catalog items.
3. Deploy Mercaria, verify unsupported legacy actions still deny supervised sessions, and only then provision the exact reviewed workload scope and content/purchase capabilities through Oxy's canonical plan/apply workflow. No static service credential, seller capability or broad Kids enable flag is appropriate.
4. A real platform operator reviews eligible items through the dashboard before they appear. An empty reviewed catalog is an honest initial state. Browser verification uses explicitly mocked external responses; database/HTTP payment verification uses a private PostgreSQL database, the real SDK/middleware and signed PSP webhook with only external Oxy/PSP servers simulated.

Do not roll back to a runtime unaware of supervised purchase operations while any operation is outstanding: it would lack the payment-open guard. Finish or cancel operations through the canonical protocol before a coordinated rollback. Preserve approval/request/review evidence and all financial history.
