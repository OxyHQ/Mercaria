# Shopify real-store verification (#69) — the automation, and the human ask

`docs/runbooks/connector-real-store-verification.md` is the procedure. This
directory is the part of it a machine can do, plus a precise statement of the
part it cannot.

**Nothing here has been run.** No Shopify Partner account exists, no dev store
exists, no app has been created, and no scenario in runbook §6 has been
exercised. #69 acceptance criterion 7 is still NOT met, and nothing in this
directory may be read as evidence that it is.

---

## The API version — pinned at `2026-07`, and what that pin rests on

`API_VERSION` in `connectors/shopify/index.ts` is pinned at **`2026-07`**, the
newest stable version. The history: `2024-10` retired around 2025-10-16 and
Shopify fell forward to `2025-10`, so the pin was moved there to match the wire;
`2025-10` itself stops being served as itself on **2026-10-16 15:00 UTC**.

An unsupported version does **not** 404. Shopify "falls forward and responds
using the oldest accessible stable version"
([versioning](https://shopify.dev/docs/api/usage/versioning)), so every request
succeeds and the evidence names a version the wire never served. That is why
`preflight.ts` refuses a run past `accessibleUntil` (§5) and why `http.ts` reads
the served version back.

**Why `2026-07` rather than a quieter step:** the Shopify Partner app's Webhooks
API version is set to `2026-07`, and REST responses and webhook payloads go
through the same normalizers. A split between the two feeds one function two
shapes, which is worse than either version chosen consistently.

**What was checked before the move**, endpoint by endpoint and field by field,
against Shopify's CURRENT REST reference — which self-reports
`api_version: 2026-07` on every page: every endpoint in §3.1 of the runbook is
documented, and every field the connector's zod schemas REQUIRE is still there.
The rate-limit contract is unchanged (bucket 40, leak 2/second standard,
`X-Shopify-Shop-Api-Call-Limit: 32/40`, 429 with a fractional `Retry-After`),
and so is pagination (`Link` `rel="next"`, `page_info`, `limit` ≤ 250). **No zod
schema was widened to make the bump pass.**

**The reference route RESOLVES its version rather than echoing it, and that
control is what makes the sweep mean anything** — the naive version of this
check cannot fail. Measured: an ACCESSIBLE version renders itself
(`2025-10`→2025-10, `2026-04`→2026-04); an INACCESSIBLE one falls back to latest
(`2019-04`, `2025-01`, `2099-01` all render `2026-07`); an invented resource
under a valid version hard-404s. One residual degeneracy, stated rather than
smoothed: for `2026-07` itself "rendered == requested" is weak, since it is also
the fallback target — but both readings collapse to "2026-07 is the latest
accessible version", which the schedule and `/latest/` corroborate.

**So a real version DIFF was possible and one was taken**, on the highest-risk
resource: `product-variant` at `2025-10` and at `2026-07` carry IDENTICAL field
lists and both state the 100-variant ceiling. The nested shapes the zod schemas
actually parse were walked rather than inferred from field names — money set
`{shop_money:{amount,currency_code}, presentment_money:{…}}`, the order line's
ten keys, and a product image's `src` and `variant_ids`.

**Inferred rather than read version-scoped:** the rate-limit and pagination
pages carry NO version segment (`/docs/api/admin-rest/usage/*`), so "unchanged
in 2026-07" is an inference from an unversioned page.

**What is still NOT established, and none of it is a formality:**

- **No real store has answered.** #69 acceptance 7 remains unmet. The above is
  Shopify documenting its own API — a statement of intent, not a measurement of
  the wire. S2/S3/S4 still owe a re-check against a live shop.
- **Only `product-variant` was diffed across the two versions**; the other nine
  resources were read at `2026-07` alone.
- **The per-version release notes are unreachable**:
  `/docs/api/release-notes/{version}` 404s for every version after `2025-01`,
  with `2025-01` returning real content as the control (that URL family
  validates where the reference family falls back). A field that changed
  MEANING, or became nullable while keeping its name, is invisible here.

Two smaller observations worth carrying, neither load-bearing: the `order`
resource's example URLs read `/admin/api/latest/…` while its header reports
`api_version: 2026-07` (a page-authoring quirk, not a version signal), and the
deprecation notices visible at `2026-07` sit on fields the connector does not
consume — `cart_token`/`checkout_token` on the order, `county_taxes` and
`auto_configure_tax_inclusivity` on the shop.

**The measurement that WOULD settle it is already built and needs a shop.**
`preflight.ts` §5 probes the configured shop and refuses a run on a measured
mismatch; `http.ts` warns once per shop when the served version differs from the
requested one. Both are inert until the first real connect — so the honest
statement about this pin today is that it matches the Partner app's webhook
version and contradicts nothing Shopify currently publishes, **not** that it has
been verified against `2026-07`'s behaviour.

The ceiling is unchanged and is the real constraint, not the version: REST
product/variant endpoints are **deprecated but present** ("deprecated as of REST
API 2024-04"), REST is legacy as of 2024-10-01, and "Each product can have a
maximum of three options and a maximum of 100 variants." Shopify has announced
**no sunset date** for custom apps on REST that stay under it. Above it the
GraphQL product APIs are mandatory and this connector has no GraphQL call
anywhere — so a store needing >100 variants on one product is what forces a
rewrite, whatever the pin says.

**The pin is now read back rather than trusted**, in two places, because a pin
nobody verifies is a comment:

- the API itself records the AUTHENTICATED answer — `connectors/shopify/http.ts`
  compares `X-Shopify-API-Version` against the version in the request URL and
  warns once per shop when they differ. It never throws: a merchant's sync
  failing because Shopify retired a version is worse than the mismatch it would
  be reporting. Six tests pin it, including the silent-on-match control.
- `preflight.ts` and `drive.ts` probe the configured shop directly
  (`api-version.ts`). The outcome is three-valued and `not_disclosed` is a real
  answer — whether Shopify attaches the header to an unauthenticated 401 is not
  something its documentation settles, and reporting a missing header as
  agreement would state a version nobody observed. A measured mismatch makes
  `drive.ts` refuse to run any scenario.

---

## What is here

| File | What it does |
|---|---|
| `preflight.ts` | Refuses a run that would measure the wrong thing. Run it first, every time. |
| `api-version.ts` | Probes which Admin API version Shopify actually serves. Used by both entrypoints. |
| `tunnel.sh` | Opens a public HTTPS origin (cloudflared quick tunnel) and prints the two URLs the Shopify app must carry. |
| `credentials.ts` | Reads and validates the mode-600 credential file. Used by both entrypoints. |
| `drive.ts` | Executes the API half of runbook §6 and records evidence, pausing where a human must act. |
| `env.example` | Every variable the Shopify path reads, each traced to the module that reads it. |

### Dependency, stated rather than vendored

`drive.ts` imports `../evidence.js` and `../redact.js` — the shared evidence
collector and redaction scanner, which are provider-neutral (`projectConnection`
and `projectSyncRun` read `Connection` and `SyncRun`, which both connectors
produce). **They are owned by the WooCommerce runner branch and are not on
`main` yet.** Until this branch is rebased onto it, `drive.ts` fails at startup
naming the exact missing path.

That is deliberate. A second copy of a credential scanner is the thing that
drifts, and the direction it drifts is always the permissive one. `preflight.ts`
and `credentials.ts` have no such dependency and run standalone today.

---

## Order of operations

```bash
# 0. The human steps below must be done first — none of this works without them.

# 1. Start the API (needs DATABASE_URL and a Postgres).
bun run --cwd packages/backend dev

# 2. Open the public origin. LEAVE IT RUNNING — the hostname is random and
#    dies with the process.
./packages/backend/scripts/e2e/shopify/tunnel.sh 4160
#    Paste the redirect URL and the webhook URL into the Shopify app,
#    export CONNECTOR_OAUTH_REDIRECT_BASE_URL, and RESTART the API.

# 3. Refuse early or proceed.
bun run packages/backend/scripts/e2e/shopify/preflight.ts

# 4. Drive the scenarios, one phase per command. Each pauses where a human
#    must act inside the Shopify admin.
bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=connect
bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=backfill
bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=observe
bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=orders
bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=revocation
```

Phases are separate commands because the human steps between them take minutes
to hours, and a driver that slept through them would hold one process and one
evidence file across the whole session.

---

## Which scenarios are API-driveable, and which need a human in the Shopify admin

Mercaria never exposes the stored Shopify access token — by design — so the
driver cannot touch Shopify at all. Everything on the Shopify side is a human
step.

| # | Scenario | Driver can | Human must |
|---|---|---|---|
| S1 | OAuth connect and reconnect | request connect, read back the connection, `scopes[]`, `webhookIds`, `webhookFailures`; assert ONE row after a reconnect | open the authorize URL and press **Install** (twice — the reconnect is the second half) |
| S2 | Product + inventory backfill | set `products/inventory: pull`, request sync, poll the run, record the four tallies | seed the catalogue; compare `created` against the shop's own product count |
| S3 | Product create / update / delete webhook | record every `webhook` run in the window | create, edit and delete a product; confirm the listing appears, changes, and reaches `archived` (**never deleted**) |
| S4 | Variant, price, image, inventory update | same window, same runs | edit a variant price, add an image, change stock; confirm the listing followed |
| S5 | Pagination at scale | assert `created > 250`, so at least one `Link rel="next"` page was followed; record wall clock | seed **> 250** products — below that the scenario measures nothing and the driver records `NOT_RUN` |
| S6 | Local override survives resync | — | edit a listing title in Mercaria, change it in Shopify, resync, confirm the Mercaria title stands and an unpinned field still follows |
| S7 | Order import + idempotent update | set `orders: bidirectional`, request sync, record the run | place the test orders; edit one and re-sync; confirm one Mercaria order per Shopify order |
| S8 | Fulfillment pushed back | — | mark a Mercaria order shipped, then confirm in the Shopify admin that exactly one fulfillment with tracking appeared and a re-push adds no second one |
| S9 | Credential revocation and recovery | request a sync after the uninstall and assert the run **failed and archived nothing** | uninstall the app; then reinstall and confirm the catalogue is intact |
| S10 | Native currency preservation | — | inspect an imported variant and order: shop currency, never FAIR |

S8 and S10 are left to a person deliberately. S8 needs the Shopify admin. S10 is
a judgement about stored amounts, and checking it in the driver would mean
re-implementing the currency rules the connector applies — which measures the
re-implementation, not the connector.

**S9 has no webhook behind it.** The connector registers no `app/uninstalled`
topic, so Mercaria learns of an uninstall only when the next call fails. That is
what S9 measures, and it is why the scenario is a sync-after-uninstall rather
than an event.

---

## Where the secrets live

Three Shopify secrets are handed back by the human. They go in **one mode-600
JSON file**, never in the repo, never in an issue, never in a log, never in a
PR comment:

```bash
mkdir -p ~/.config/oxy/tokens
cat > ~/.config/oxy/tokens/mercaria-shopify-e2e.json <<'JSON'
{
  "clientId": "<the app's Client ID>",
  "clientSecret": "<the app's Client secret>",
  "shopDomain": "<your-store>.myshopify.com"
}
JSON
chmod 600 ~/.config/oxy/tokens/mercaria-shopify-e2e.json
```

`credentials.ts` refuses the file if it is group- or world-readable, and says so
by name. It holds the secret that signs every webhook this deployment will
accept; a readable copy on a shared box is a disclosure no later redaction
undoes.

The API process additionally needs `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`
in its environment (the connector reads them there). `preflight.ts` refuses when
those disagree with the file — otherwise the run authorizes against one app while
the evidence names another, and both halves look healthy.

---

## THE HUMAN ASK

Do these in order. Everything is free unless marked.

> **Two of these cannot be undone, and both cost a day if you get them wrong.**
>
> - **Step 3 — distribution type cannot be changed after you select it.** Pick
>   **custom**. Picking public means a new app, and public apps must be GraphQL
>   only, which this REST connector is not.
> - **Step 5 — requesting `read_all_orders` makes Shopify refuse the ENTIRE
>   grant**, not just that scope. Unless it has been approved for this specific
>   app, leaving it out is the difference between a working connect and one that
>   fails with nothing obviously wrong.

1. **Create a Shopify Partner account** — <https://www.shopify.com/partners>.
   Free, no legal entity, no phone, no payment details, no review delay. An
   ordinary email sign-up.

2. **Create a development store.** Partner dashboard → *Stores* → *Add store* →
   *Development store*. Free, unlimited, no time limit. Note two constraints
   that shape the run:
   - it **cannot process real payments** — test orders go through the **Bogus
     Gateway** or your provider's test mode;
   - its storefront **keeps a password page** that cannot be removed. This does
     not affect the Admin API, so it does not affect any scenario here.

3. **Create an app** in the Partner/Dev Dashboard, with **custom distribution**.
   Custom needs **no Shopify review and no approval delay**; public distribution
   requires review and — since 2025-04-01 — must be built **exclusively on
   GraphQL**, which this REST connector is not. Custom distribution installs on
   a development store, which is what we have.
   **The distribution type cannot be changed after you pick it.** Pick custom.

4. **Configure the app** with the two URLs `tunnel.sh` prints (they change on
   every tunnel restart):
   - Allowed redirection URL: `{base}/channels/oauth/shopify/callback`
   - Webhook endpoint: `{base}/channels/webhooks/shopify`

5. **Request these scopes** (this string is the code default — set
   `SHOPIFY_SCOPES` only to request something narrower):
   ```
   read_products,write_products,read_orders,read_inventory,read_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders
   ```
   Do **not** request `read_all_orders`. It needs Shopify's written approval
   (Partner dashboard → app → API access → *Request access*, with a
   justification, reviewed by Shopify — a real delay), and if it is requested
   without approval the **whole grant is refused** rather than narrowed. Its
   absence limits `GET /orders.json` to the **last 60 days**, which does not
   affect orders placed during the run.

6. **Copy back three values** into the mode-600 file above: **Client ID**,
   **Client secret**, and the store's `*.myshopify.com` domain. Use the
   `.myshopify.com` admin host, not a custom storefront domain — it is also the
   connector's SSRF host allow-list, and a custom domain is refused on purpose.

7. **Seed the store** (runbook §4.1 step 3). This is the slowest step and the
   one that decides whether S5 means anything:
   - one product with **3+ variants across 2 option axes**;
   - one **single-variant** product;
   - one product with **several images**, and one with **none**;
   - one product with a **compare-at price**;
   - one product in a **manual (custom)** collection and one in a **smart**
     collection — the connector builds its index from both;
   - **stock across two locations** on one variant (the connector sums them);
   - **more than 250 products in total.** Below 251 the backfill never fetches a
     second page and S5 measures nothing. A few thousand is better.
     Bulk CSV import is the practical way.

8. **Place 2 test orders** — one paid and unfulfilled, one with a discount and
   tax, in the shop's own currency. If Markets is enabled, a third in a
   different presentment currency. Use the Bogus Gateway.

9. **Tell the operator** the store is ready. Do **not** paste any of the three
   secrets into an issue, a chat message, a log or a PR — the file is the
   channel.

### Nothing in this list costs money, needs a phone number, needs a legal entity, or waits on a review

The one thing that would is `read_all_orders`, and it is deliberately not
requested. A Partner account, unlimited dev stores and a custom-distribution app
are all free and immediate.

---

## Can any of this be verified without a Partner account?

**No.** Established from Shopify's own documentation rather than from memory:

- Every scenario needs a real Shopify store. A store needs either a paid plan or
  a **development store**, and a development store requires a Partner account or
  a merchant store with developer permissions.
- The connector connects by **OAuth only** — `POST /channels/shopify/connect`
  returns an authorize URL and the callback exchanges the code. There is no
  code path that accepts a pasted Admin API token, so the one route that avoids
  a Partner account (a custom app created inside a store's own admin, which
  issues an Admin API access token directly and does **not** use OAuth) cannot
  reach this connector without changing production code to add a
  token-paste path. That would be building a door in order to walk through it,
  and the token would still require a store.
- A mock or proxy standing in for Shopify is exactly the simulation #69 exists
  to rule out, and the contract suite
  (`connectors/__tests__/connector-contract-suite.ts`) already covers everything
  a fake wire can say.

So the honest answer is that the Partner account is a hard prerequisite, and no
amount of local work substitutes for it. That is why everything in this
directory stops precisely at the credential boundary.
