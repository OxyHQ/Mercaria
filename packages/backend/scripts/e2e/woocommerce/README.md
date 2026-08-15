# A real, disposable WooCommerce site for the #69 connector verification

`docs/runbooks/connector-real-store-verification.md` §4.2 asks for a disposable
WordPress running WooCommerce, reachable over public HTTPS, carrying a catalogue
big and awkward enough that the WooCommerce connector's real branches are
exercised. This directory brings one up from zero and tears it down.

## What is real, and what is not

**Real.** A real WordPress, a real WooCommerce installed from wordpress.org, a
real MariaDB, real products created by WooCommerce's own CRUD classes, real
orders through `wc_create_order`, a real coupon, a real ES VAT rate, real image
attachments on disk, and a real WooCommerce REST API key minted with
WooCommerce's own `wc_rand_hash`/`wc_api_hash` into its own
`woocommerce_api_keys` table. The site answers real HTTPS with a valid
certificate at a public hostname, and the connector's own transport
(`connectors/woocommerce/http.ts`, `safeFetch` and all) reaches it.

**Not real.** It is disposable, and it is exposed through a **cloudflared quick
tunnel** rather than a registered domain. Everything a quick tunnel implies is a
first-class fact of these scripts, not a footnote:

- **The hostname is random and changes on every tunnel restart.** Nothing here
  hardcodes one. `up.sh` records it in `$STATE_DIR/stack.env`, writes it to the
  WordPress `home`/`siteurl` options, and refreshes `siteUrl` in the credential
  file. A consumer reads it back from the credential file — never from a note.
- **Quick tunnels have no uptime guarantee**, are rate-limited by Cloudflare, and
  Cloudflare reserves the right to investigate their use. Do not treat a
  measurement taken through one as a statement about a merchant's own hosting.
- **A quick tunnel adds a hop.** Latency, and anything Cloudflare's edge does to
  headers, is between you and Apache. `X-WP-TotalPages` survives it here (see
  below), which is worth knowing because runbook scenario W9 is about a host that
  strips it.

### The DNS trap this cost an hour on, and why the script order is what it is

A quick tunnel's DNS record is visible to Cloudflare's own resolvers within a
second or two of `cloudflared` printing the hostname. **Any other resolver asked
inside that window gets `NXDOMAIN` and caches it**, and `trycloudflare.com`'s SOA
sets a 1800-second negative TTL. One premature lookup therefore makes the site
unresolvable *on that machine* for half an hour while remaining perfectly
reachable from everywhere else — which looks exactly like a broken tunnel.

`up.sh` waits for a **public** resolver (`dig @1.1.1.1`) to answer *before*
anything touches `getent`/`curl`, which go through the system resolver the
backend also uses. If you hit it anyway, mint a new hostname (re-run `up.sh`)
rather than waiting the negative TTL out.

Related: every probe of the public site runs `curl --noproxy '*'`. `safeFetch`
resolves the host itself and pins the connection to the validated IP; it reads no
`HTTPS_PROXY`. A probe that honoured a proxy would be exercising a path the
connector never takes.

## Running it

```sh
cd packages/backend/scripts/e2e/woocommerce

./up.sh          # containers + tunnel + public URL   (prints the URL)
./seed.sh        # install WP, activate WooCommerce, set EUR, seed the catalogue
./issue-key.sh   # mint a Read/Write REST key into the tokens directory
./verify.sh      # measure it over real HTTPS and FAIL if the catalogue is short

# and, from packages/backend, through the connector's own SSRF-guarded transport:
bun run scripts/e2e/woocommerce/verify-transport.ts

./down.sh        # stop the tunnel, remove the containers AND the volumes
```

`down.sh` **destroys the site** — WordPress, the catalogue and the orders all
live in the named volumes. `--purge-credentials` also removes the token file;
`--keep-state` keeps the cloudflared log.

Every script is re-runnable: an installed WordPress, an active WooCommerce, an
already-seeded catalogue and a still-serving tunnel are all left alone. Every
script is `set -euo pipefail` and fails loudly rather than continuing.

## Ports, project name, state

| Thing | Value | Override |
|---|---|---|
| compose project | `mercaria-woo-e2e` | `MERCARIA_WOO_E2E_PROJECT` |
| WordPress host port | `8087` (bound to **127.0.0.1**) | `MERCARIA_WOO_E2E_PORT` |
| docker network subnet | `10.211.83.0/24` | `MERCARIA_WOO_E2E_SUBNET` |
| runtime state | `~/.local/state/mercaria-woo-e2e/` | `MERCARIA_WOO_E2E_STATE_DIR` |
| credentials | `~/.config/oxy/tokens/mercaria-woo-e2e.json` (mode 600) | `MERCARIA_WOO_E2E_TOKEN_FILE` |

**The subnet is pinned deliberately.** This host runs ~30 sibling compose stacks,
which is exactly Docker's default allocation (172.17–172.31/16 plus
192.168.0.0/16 in /20s), so one more auto-allocated network fails with `all
predefined address pools have been fully subnetted`. The tempting fix —
`docker network prune` — reaches into other agents' stacks. Naming a subnet in
the otherwise-unused 10/8 space bypasses the pool and touches nobody.

**No secret is in this directory or anywhere else in the repo.** The database
passwords, the WordPress admin password and the tunnel hostname are generated on
first `up` into `$STATE_DIR/stack.env` (mode 600), which is outside the
repository so a stray `git add -A` cannot sweep it in. The REST key exists in
exactly one place, `$TOKEN_FILE`, and no script echoes it.

## What the seed creates, and why each piece is there

`php/seed-catalogue.php`, run through `wp eval-file`. Every object is built by
WooCommerce's own CRUD classes — there is no fixture layer.

| Requirement (runbook §4.2) | What satisfies it |
|---|---|
| a `variable` product across 2 option axes | SHAPE-A (`pa_colour` × `pa_size`, 6 variations) and SHAPE-D |
| a `simple` product | SHAPE-B, SHAPE-C, and 120 fillers |
| stock managed at the PARENT and the VARIATION level, including `manage_stock: 'parent'` | SHAPE-A: parent manages 50, four variations manage their own, **two decline and are reported `manage_stock: "parent"`** |
| more than 100 products | 124 published |
| one variable product with more than 100 variations (W8) | SHAPE-D, 11 colourways × 10 waists = **110** |
| several images, and one with none | SHAPE-A 3, SHAPE-B 2, **SHAPE-C 0**; every third filler has 1 |
| at least 2 orders | one `processing`, one `completed` with a real 10% coupon and real 21% ES VAT |

**SHAPE-A uses GLOBAL (taxonomy) attributes and SHAPE-D uses CUSTOM ones on
purpose.** Those are two different wire shapes on the products endpoint, and a
real site is the only thing that settles which one a merchant's store emits.

The store currency is **EUR** — deliberately neither USD nor FAIR, so that "the
connector preserves the platform's native currency" (scenarios W6 and S10) is an
observable rather than a coincidence.

`seed.sh` and `verify.sh` both **assert the counts and exit non-zero if the
catalogue is short**, naming the requirement that was missed. A seed script that
ran without error and created three products is the failure mode that guards
against.

## Measured on this stack

**Stamp every measurement with the site it came from.** `down.sh` destroys the
volumes, so a rebuild is a DIFFERENT site that answers on a different hostname
with different row ids — and a number recorded before one is not a smaller
truth, it is a fact about something that no longer exists. This bit during
setup: the first stack ran WordPress **6.8.3**, WooCommerce refused to install
on it, and the stack was torn down and rebuilt on **7.0.4**. A sibling agent
correctly flagged that `wp core version` had reported both.

The current site's volumes were created **2026-08-15T05:36:53Z** — 13 s before
its tunnel opened and 49 s before WooCommerce installed. Everything below
postdates that. `docker volume inspect mercaria-woo-e2e_wp_data --format
'{{.CreatedAt}}'` is the boundary; anything older describes a destroyed site.

Taken 2026-08-15 against the site these scripts build. Versions:

| | |
|---|---|
| WordPress | **7.0.4** |
| WooCommerce | **11.0.1** |
| PHP | **8.3.33** |
| WC REST API | **`wc/v3`** |
| database | MariaDB 11.4.12 |

**WooCommerce's current release requires WordPress ≥ 6.9** and refuses to install
on anything older, which is why the image is pinned to WordPress 7.x rather than
6.8.

- `X-WP-TotalPages` is **PRESENT** on `/products` and on `/products/{id}/variations`,
  and survives the cloudflared edge. Scenario W9 (a host that strips it) therefore
  needs a header-stripping plugin installed on top of this stack; it is not the
  default here.
- **W8's open question is settled for this size**: WooCommerce publishes the
  **complete 110-id `variations` list** on the single-product read *and* on the
  `/products?per_page=100` LIST response. So `declared_not_fetched` does not fire
  spuriously at 110 on WC 11.0.1. `/products/24/variations?per_page=100` pages as
  100 + 10 with `X-WP-Total: 110` and `X-WP-TotalPages: 2` on both pages.
- `date_modified_gmt` is emitted **without a zone suffix** (`2026-08-15T05:38:08`),
  confirming the runbook §1 claim and the shape behind the #221 trap.
- A variation that declines to manage stock is reported `"manage_stock": "parent"`
  and carries the **parent's** `stock_quantity` — the distinct provider branch.
- All four resolved addresses are public (104.16.230.132, 104.16.231.132 and two
  `2606:4700::` v6), so `safeFetch`'s private/loopback/metadata denylist does not
  apply.

## `WORDPRESS_CONFIG_EXTRA` does NOTHING on this image, and WP-Cron is ON

Measured 2026-08-15: `wordpress:7.0.4-php8.3-apache`'s entrypoint contains **zero
occurrences** of `WORDPRESS_CONFIG_EXTRA` (`grep -c` on
`/usr/local/bin/docker-entrypoint.sh` returns `0`), so any value passed is
silently ignored. An earlier revision of the compose file passed a block defining
`WP_HOME`/`WP_SITEURL`, `DISABLE_WP_CRON` and a forwarded-proto fix. None of it
ever reached `wp-config.php` — and the site worked anyway, which is exactly how a
comment describing a mechanism that does nothing survives. Verify with
`wp config get DISABLE_WP_CRON` (it reports the constant is not defined) rather
than by reading the compose file.

What actually carries each of them:

| Intended by the dead block | What really does it |
|---|---|
| `WP_HOME` / `WP_SITEURL` | the `home`/`siteurl` **database options**, written by `wp core install --url` and re-written by `up.sh`. No such constants exist. |
| https behind the tunnel | the **image's own** `wp-config.php`, which ships an `HTTP_X_FORWARDED_PROTO` check. Without it `is_ssl()` is false and WooCommerce refuses key/secret Basic auth. |
| `DISABLE_WP_CRON` | nothing — **WP-Cron is ENABLED**, WordPress's default. |

**WP-Cron being on is the right state and is now deliberate**, not an accident
left in place: it is what a real merchant site runs, and a plugin that debounces
its push through `wp_schedule_single_event` needs it. `wp cron test` reports
"WP-Cron spawning is working as expected"; 17 events are scheduled. Anyone who
needs a deterministic trigger instead should drive `wp cron event run --due-now`
and **say so in their results**, because "the hook fired" and "I ran it by hand"
are different observables.

## The REST credential

`issue-key.sh` mints a **Read/Write** key. Read-only is not enough: webhook
registration is a `POST`, and a read-only key turns every registration into a
refusal (that is scenario W7, which you run deliberately, not by accident).

It is minted **programmatically**, and that is not a workaround: `wc_rand_hash`,
`wc_api_hash` and the `woocommerce_api_keys` table are WooCommerce's own, and the
admin screen does exactly this. The consumer key is stored hashed, so an existing
row can never be recovered — a re-mint therefore revokes the previous row rather
than leaving a live credential nobody holds.

The key and secret land in `$TOKEN_FILE` at mode 600 and are never echoed, never
written into the repo, and never put in a log. Scripts print only the last four
characters.

## Verifying the way the connector will actually reach it

`verify.sh` uses `curl`. `verify-transport.ts` uses
`connectors/woocommerce/http.ts` — the real thing, https-only, through
`@oxyhq/core/server`'s `safeFetch`, which re-validates every hop and pins the
connection to the validated IP. A site `curl` can reach and `safeFetch` refuses
looks exactly like a working site until the first sync fails, so both are run.

It exercises all three transport methods, because they are three different code
paths and only one is a GET: `get` (safeFetch), `post` (the IP-pinned raw
`https.request` webhook registration uses) and `del`. The POST creates a real
webhook in the `paused` state — so WooCommerce attempts no delivery — and the
DELETE removes it, leaving the site as it found it.

Running it from a git worktree needs module resolution; `node_modules` is
symlinked to the shared checkout's (this branch adds no dependency, so the trees
match). Nothing is installed into the worktree.

## What this stack does NOT do

- **These scripts do not build, zip or install the WordPress plugin**
  (runbook §4.3). `OxyHQ/mercaria-woocommerce` is a separate private repo and its
  install is itself one of the things #69 verifies, so it belongs to whoever is
  running that scenario. **Check before you measure**: another agent may already
  have installed one into the shared volume, and plugin OPTIONS survive a
  reinstall. `wp plugin list` and `wp option list --search='mercaria_wc*'` are
  the two commands that tell you.
- **No Mercaria backend is connected to it.** Bringing the API up, adding the
  channel and driving syncs is the next agent's work; this provides the site, the
  credential and the proof it is reachable.
- **No Shopify development store.** Runbook §4.1 is untouched.
- **Scenario W9 needs an extra step** — see the `X-WP-TotalPages` note above.

## Scenario W9: making a header-stripping host reproducible

This host does **not** strip `X-WP-TotalPages`, so W9 is not reproducible by
default. `w9-header-strip.sh` supplies the missing half.

```sh
./w9-header-strip.sh status   # which of three states the site is in
./w9-header-strip.sh on       # start stripping — explicit, never a default
./w9-header-strip.sh off      # stop
```

It installs a must-use plugin (`php/mu-w9-header-strip.php`) that removes
`X-WP-TotalPages` from `/wc/v3` responses when one option says so. **Leave it
OFF unless you are running W9**, and tell whoever drives the backfill which run
was the stripped one — a sibling measuring a stripped site by accident is the
failure this default protects against.

**`X-WP-Total` is deliberately NOT stripped.** W9 asks for two observations —
every product still imports, and **nothing is archived** — and the first needs an
independent oracle for how many products there are. Stripping both would leave
the measurement and the thing it measures reading the same absent source, which
is a check that cannot fail. `/wp/v2` is untouched for the same reason: if the
header is missing there too, something other than this is eating headers.

**Three states, not two.** `X-Mercaria-E2E-Header-Strip: on|off` rides every
`/wc/v3` response; its ABSENCE means the plugin is not installed, which is not
the same as installed-and-off. Every transition is verified over real HTTPS
afterwards and the script exits non-zero if the header did not actually move.

### Measured while stripped (2026-08-15)

| | |
|---|---|
| `wc/v3/products` | `X-WP-TotalPages` **absent**, `X-WP-Total` 124, marker `on` |
| `wp/v2/posts` | `X-WP-TotalPages` **1** — untouched, so headers still work |
| body, `per_page=100` | page 1 = 100 items, page 2 = 24, page 3 = **HTTP 200 with `[]`** |

That last row is the one that matters. **WooCommerce answers a page past the end
with 200 and an empty array, not a 400**, so #259's "enumerations finish on a
usable header or an EMPTY page" rule is genuinely reachable on a real site — had
it answered `rest_invalid_param`, the empty-page terminator would be unreachable
and W9 could not pass at all. `100 + 24 = 124` also matches `X-WP-Total`, so the
oracle and the pages agree.

**What this stack cannot tell you:** whether the run archived anything. That is a
fact about Mercaria's database after a backfill, and it is the whole point of W9
— a run that archived listings here is the #259 catalogue failure and is
reportable. Whoever drives the backfill owns that observation.
