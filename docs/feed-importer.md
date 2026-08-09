# The universal product-feed importer (#63)

How a file of somebody else's rows becomes a `NormalizedSourceRecord`.

This is **not** a second ingestion pipeline. `catalog_sources` stays the
registry, `source_records` stays the observation store, #58 stays the matcher,
#57 stays the offer, and #62's `CatalogSourceAdapter` stays the write boundary.
What #63 adds is everything between *a merchant published a CSV* and *#62 has a
record to ingest*: the formats, the mapping, the validation, the staging, and
the two delivery modes whose difference decides whether an omitted row means
anything at all.

Framework reference: **`docs/ingestion.md`** (#62). Schema decisions:
`packages/backend/src/db/schema/CONVENTIONS.md` §"The universal feed importer".
Source selection: `docs/catalog-sources/2026-08-09-launch-sources.md` (#64).

---

## The failure modes that shape it

Four, and every decision below exists to make one of them unrepresentable.

1. **A truncated feed reporting a complete enumeration.** #62 retires whatever a
   completed enumeration stopped mentioning. A feed cut off at a size cap, a
   record cap or a preview's sample limit has not enumerated anything — so every
   cap here REFUSES rather than truncating, and a pass that stopped early can
   never claim completion.
2. **A delta feed read as a snapshot.** A delta publishes what CHANGED, so a row
   that does not appear is evidence of nothing. Treating its absence as a
   deletion retires a healthy catalogue on the first successful pass, silently.
3. **A mapping that is a program.** A feed is a stranger's file and a mapping is
   a stranger's instruction about it. An expression, a template or a
   regular-expression replacement in a mapping row is remote code with a form
   field in front of it.
4. **A credential in a log line.** The affiliate networks that matter carry the
   key IN the feed URL. A feed URL in this domain is a credential wearing a
   hostname, and every projection and every message treats it as one.

---

## The shape

```text
merchant configures a feed        →  feed_configurations (identity FROZEN)
merchant drafts a mapping version →  feed_configuration_versions + mappings
merchant PREVIEWS a bounded sample→  values beside what the mapping made of them
merchant VALIDATES the whole feed →  feed_import_reports (mode = validation)
merchant ACTIVATES, citing it     →  one active version per configuration
#62's dispatcher opens a run      →  the product_feed adapter fetches
  fetch → decompress → decode → parse → map → validate → STAGE
  page  → AdapterRecord[] → #62's staged pipeline → offers
```

Everything from `fetch` onwards is `services/feed-import/`; everything after
`AdapterRecord[]` is #62's.

---

## The rules that are load-bearing

### An object's IDENTITY is not a mapping decision

`feed_configurations.identity_key_fields` names the merchant's own key columns
and is **frozen by a trigger**. Change the list and every object in the feed gets
a new external id: the old ones stop being mentioned by a completed enumeration
and are RETIRED, the new ones arrive as first-time observations, and the whole
thing looks exactly like a seller who replaced their catalogue overnight — with
no error anywhere and no repair short of a data migration. Re-keying a feed is a
NEW configuration, which is honest about what it does.

There is deliberately **no `external_id` mapping ROLE**, for the same reason: a
role and a frozen key would be two answers to one question.

The join is **injective** — parts are escaped before they are joined, so
`('a', 'b|c')` and `('a|b', 'c')` cannot collide. A collision there is two of a
merchant's products sharing one `catalog_source_objects` row, which arrives as
"the price of one SKU keeps changing to another SKU's price".

### A delta feed can never claim a completed enumeration

`FeedCompletionVerdict`'s `delta` branch has **no `enumeratedFully` member**, so
there is no `if` to get wrong. #62's retirement rule
(`CATALOG_SOURCE_RETIRING_OUTCOMES` plus `catalog_source_runs_retirement_check`)
is not reimplemented, weakened or duplicated; what #63 decides is whether the
adapter may supply the input that rule reads.

Three things must all hold before a completed enumeration is reported: the
version's delivery mode is `snapshot`, the read reached the END of the feed, and
this is the last page. **A conditional `304 Not Modified` is not an
enumeration** — it is the trap conditional requests introduce, and the branch
carries no records for a caller to mistake for an empty feed.

`feed-delivery-mode.test.ts` tests the two modes separately, which the issue asks
for and which matters: the failures are opposite and both silent, so one
parameterised case would pass with either rule inverted.

**#68's `refreshModes` is a separate question and must not be collapsed into
this one.** It asks what the feed TRANSPORT can do, which is a fact about
reading a file over HTTPS; the delivery mode asks what one configured feed
MEANS, which is a fact about the publisher. The adapter therefore declares
`['full_snapshot', 'incremental']` once, statically, and a source's policy
NARROWS it (`permitted_refresh_modes`) — a capability list cannot be widened by
a Mercaria row, since no row makes a URL able to do something. Neither
`targeted` nor `query_driven` is declared: a feed is one file at one URL, with
no call that re-reads a named list of ids and none that answers a query.

The declaration is deliberately **not** what authorises retirement. `complete`
is, and it comes from the verdict above — so a delta feed handed a
`full_snapshot` run by a misconfigured policy still reports an incomplete pass
and still retires nothing. A MANUAL sync
(`POST /admin/stores/:storeId/feeds/:configurationId/sync`) names its mode from
the ACTIVE version's delivery mode and REFUSES when there is no active version,
rather than defaulting to the one mode that can retire a catalogue.

### The importer executes nothing a feed or a mapping supplies

Four independent places:

- The **vocabulary**: `FEED_FIELD_TRANSFORMS` (ten total, configuration-free
  functions of one string) and `FEED_FORBIDDEN_TRANSFORM_KINDS` (sixteen
  evaluator kinds) are DISJOINT unions, gated by a test.
  `regex_replace` is in the prohibition on purpose: a source-supplied pattern is
  both a small language and a denial-of-service primitive.
- The **schema**: `feed_field_mappings` has `source_field`, `constant_value` and
  `transform`, and no fourth column. A fallback CHAIN is excluded too — "use
  column A, else B, else the constant" is a conditional language.
- The **API**: every schema is `.strict()`, so an `expression` or a `template`
  field is REFUSED rather than stripped.
- The **code**: `applyFeedTransform` takes a transform NAME from a closed set and
  never a string to interpret, and `feed-import-isolation.test.ts` scans the
  whole domain for `eval`, `new Function`, `node:vm` and four template engines,
  with a mutation self-test on every detector.

### Bounded memory is a property of the SHAPE

Every layer is an async generator: bytes → decompression → decoding → records →
mapped candidates. The largest live object is one record. `express.raw` is
deliberately absent from the upload route for the same reason — it buffers.

`feed-memory.test.ts` measures peak heap at a scale and at eight times that
scale and asserts the difference is noise. "It fit in memory once" is a fact
about the machine; independence of feed size is the property that matters, and
only varying the size can observe it. The multi-gigabyte pass is opt-in
(`FEED_IMPORT_MEMORY_SCALE=full`), following `MATCH_BENCHMARK_SCALE`.

### One pass, staged once, paged afterwards

#62's page contract fits an API exactly: a page is one request with a page
token. A FILE is not like that, and the dispatcher drives ONE page per tick —
thirty seconds apart by default — so a million-row feed at a thousand rows a page
is eight hours. Holding an HTTP connection open across that does not work, and
re-downloading per page is a thousand downloads and a quadratic parse.

So the first page of a run reads the feed ONCE and writes the mapped candidates
to a local JSONL **stage**; every later page seeks into it by byte offset.

The stage is keyed by the feed's own **content digest**. A task that dies
mid-pass leaves a run another task reclaims with a cursor and no local file; that
task rebuilds the stage (one re-download, not one per page) and compares the
digest. Equal means the offsets are still valid. **Different** means the merchant
republished mid-run, and the pass restarts from record zero — re-yielding records
already seen is harmless, because every write in #62's pipeline converges on a
content hash, where seeking a stale offset into new content would silently skip
products.

### Path traversal is unrepresentable, not scanned for

Only a plain file and a **single-member gzip** are accepted. A gzip member has no
entry NAME, so there is no path inside an accepted artefact for a traversal to
live in. Every multi-entry container (`zip`, `tar`, `rar`, `7z`, `bzip2`, `xz`)
is refused BY NAME from its magic bytes — so renaming `feed.zip` to `feed.csv`
changes nothing, and a merchant is told to send the file, which they can always
do.

Decompression bombs are bounded in **both** dimensions: an absolute output cap
and a ratio cap. Either alone is defeatable — a cap alone lets a small member
expand to whatever the cap is (and it must be large; a real feed is gigabytes),
and a ratio alone lets a large input expand proportionally forever.

The merchant's filename is reduced to a LABEL and the stored artefact is never
named after it: `storage_key` is CSPRNG and is the only thing that reaches the
filesystem.

### A feed URL is a credential

`feed_configuration_versions.feed_url` and `.auth_ciphertext` are both in
`protectedColumns.ts`. Awin's product-feed download is
`https://productdata.awin.com/datafeed/list/apikey/<KEY>`; several networks use
a query parameter. `redactFeedUrl` keeps the HOST — which tells an operator which
provider a refusal is about — and removes everything after it, including for the
store that typed it: a store has members, and a key readable by all of them is a
key shared with all of them.

`readFeedVersionSecrets` is the ONE repository function that reads either column,
and `feed-import-isolation.test.ts` pins its caller list at three (itself, the
resolver, and the revert path). Reading a credential should not look like reading
a row.

The credential is AES-256-GCM under `FEED_IMPORT_AUTH_ENCRYPTION_KEY` — its own
key, separate from `CONNECTOR_ENCRYPTION_KEY` and `GUEST_PII_ENCRYPTION_KEY`:
three keys, three blast radii.

### SSRF is `safeFetch` and nothing hand-rolled

Every hop — including each redirect — is validated against the
private/link-local/metadata denylist with a real DNS resolution, and the TCP
connection is PINNED to the validated address, which closes the DNS-rebind window
a check-then-connect leaves open. `merchant-claims/site-verification.ts` states
the same rule for the same class of caller-influenced host.

Two things are added on top, both properties of a FEED rather than of a URL:
**HTTPS only** (a feed served in cleartext can be rewritten in transit, and a
rewritten feed is a catalogue of somebody else's choosing, including its prices)
and a **streamed, bounded read**.

`feed-security.test.ts` drives loopback, private and metadata addresses through
the real guard, and asserts structurally that this module re-implements none of
it — a second, weaker answer to "is this address safe" is the hazard, not the
safeguard.

### An error report carries no VALUES, with three bounded exceptions

`feed_import_report_entries` holds a record INDEX, an issue code, a severity, the
Mercaria role and the merchant's own column NAME. A merchant has the file; the
index is what lets them find the row, and a report that holds no values cannot
expose one.

The exception is `observed_token`, restricted by CHECK to the three issue codes
whose values come from a closed external vocabulary — `unsupported_currency`,
`unknown_availability`, `unknown_condition` — and to sixteen characters of
`[A-Za-z0-9 _./-]`. A currency code is three characters; a credential is not
sixteen characters of that alphabet.

The download is a CSV at
`GET /admin/stores/:storeId/feeds/:id/reports/:reportId/download`.

### Money is read once, in string arithmetic, and refuses rather than guesses

`Math.round(1.0050 * 100)` is 100 in IEEE-754 and 101 here, which is the whole
reason the conversion is textual.

Separator conventions are resolved mechanically: when BOTH `.` and `,` are
present the LAST is the decimal point; when only one is present it is a GROUPING
separator exactly when three digits follow it (`1,999` is one thousand nine
hundred and ninety-nine, in every catalogue anybody has published). The cost is
stated rather than hidden — `1.005` meaning one euro and half a cent reads as one
thousand and five — and a currency that really carries three decimals publishes
in minor units and says so (`money_minor_units`).

A currency Mercaria does not list cannot be converted from major units, because
`CURRENCY_PRECISION` is the only authority for its precision. The record is
refused with `unsupported_currency` and the code NAMED (issue Mapping UX 4). The
escape hatch is narrow and real: a column already in minor units needs no
precision.

### Validation happens BEFORE normalization, and produces a value

Issue processing 2 asks for that ordering, and the reason is what each layer can
see: the mapping engine knows which COLUMN a value came from and can say "column
`precio` is not a number", where #62's normalizer sees a record with a missing
price and can only drop it.

Nothing in the mapping engine throws. A row with an unparseable price yields a
record with no price and a WARNING; a row with no title yields no record and an
ERROR. That is issue processing 3 as a signature: there is no exception for a
caller to turn into a page-level abort, so a page cannot die on its worst row.

**This is a documented divergence from #62's contract case 5**: an API adapter
hands over what the provider sent and the framework rejects it; a file importer
refuses it upstream, so the framework has nothing to reject. The contract suite
carries `isolatesInvalidRecordsUpstream` for exactly this, and #63's runner sets
it and names where the refusal IS recorded.

### Suggestions are data, and there is no code path that applies one

`suggestFeedFieldMappings` takes a list of column names and returns a list. It
has no database handle, no version id and no writer, so "do not apply mappings
silently" is the absence of a function rather than a flag. Google Merchant
conventions are recognised as ALIASES — `image_link` suggests `image` — which is
issue §"Supported inputs" 7 exactly: the conventions, without claiming protocol
compatibility. Mercaria validates none of that specification's own rules and
emits none of its error codes.

### Activation cites the validation run that justified it

`feed_configuration_versions.validated_report_id` is a NOT NULL foreign key on an
active version (a CHECK), and the service refuses a report whose mode is not
`validation` — a PREVIEW reads a bounded sample, and a mapping breaks at the
fifty-thousandth row rather than the fiftieth. It also refuses a report with NO
valid records, and deliberately **not** one with some invalid records: a feed of
a hundred thousand rows with four bad ones is an ordinary feed, and a gate that
refused it would be removed by whoever hit it.

A version is frozen once it leaves `draft` (a trigger) and one is active per
configuration (a partial unique) — the `catalog_source_policies` mechanism, for
its reason: every stored observation cites the version it was read under.
Rolling back is a NEW version copying an old one, never a resurrection.

### What is deliberately NOT here

- **No cadence and no freshness TTL.** `catalog_source_configs` already has both.
  A second pair would be two answers, and the loser is whichever the dispatcher
  does not read.
- **No data-use policy.** `catalog_source_policies` is a reviewed, versioned,
  frozen-once-active rights model over the nine rights that decide what may be
  stored, displayed, cached, linked and refreshed. A feed IS a source.
- **No content-hash column.** `source_records.content_hash` plus the
  `catalog_source_objects` convergence key already perform unchanged-record
  detection; #63's job is to produce the same bytes for the same row so that
  machinery converges.
- **No `variant_group` role.** Variant grouping reaches the framework as the
  three option AXES plus the identifiers, which is what #58 resolves canonical
  identity from. A group id invented by a stranger's exporter is not evidence
  about Mercaria's catalogue, and storing it where a matcher could read it is the
  false merge #58 exists to prevent.

---

## Two framework bugs this issue surfaced and fixed

Both are in #62 and both were invisible until a REAL adapter existed. The
fixture adapter's records carry a fixed date in the past, which is what hid them.

1. **`last_seen_at` could be earlier than `first_observed_at`.** The pipeline's
   `now` is the dispatcher TICK's clock, taken before the adapter is called;
   `record.observedAt` is when the adapter actually read the record. For any
   adapter that stamps its own read time — which is every real one —
   `observedAt` is later by however long the fetch took, and
   `catalog_source_objects_seen_order_check` and `offers_confirmed_order_check`
   both fail on the FIRST observation of every object. The record is caught,
   recorded as a `parse_failure` rejection and skipped, so a feed would ingest
   NOTHING while reporting a clean run. Fixed by taking `max(now, observedAt)`
   where a record's observation time meets the framework's clock.

   **There are TWO such places, and that is the part to remember.** #68 split
   the page loop: the OBJECT is persisted per record (`persistOneRecord`) and
   the OFFER is materialised per PAGE, after the page's distribution has been
   judged (`advanceObject` → `recordExternalOffer`). The two writes therefore no
   longer share a clock, so correcting the record half leaves every external
   offer failing `offers_confirmed_order_check` — `first_seen_at` is the
   observation's own time while `last_confirmed_at` was still the tick's. That
   is exactly how the second site was found: on this branch's rebase behind #68,
   with the first fix already in place and three contract cases red. Native
   convergence is unaffected either way, since its `observedAt` IS its `now` and
   the max is an identity.
2. **`match_policy_versions_active_key` contention became fatal with a THIRD
   claimant.** One active policy in the whole database is correct for production
   and makes the slot a shared resource between the parallel realdb files that
   run against one throwaway database. Two files got away with retry-and-hope;
   three do not, and the failures are not the honest "somebody else holds it" —
   they are a file inserting a `match_decisions` row whose policy another file
   has just deleted, and a wait that outlives vitest's own per-test timeout. Both
   land on a file that did nothing wrong, which is the shape that gets a suite
   marked flaky and then ignored.

   Fixed with a real mutex: `services/ingestion/__tests__/active-policy-slot.ts`
   takes a session-level Postgres **advisory lock on a RESERVED connection** and
   holds it for the file's whole run. It has to be session-level because a file
   holds the slot across many tests, and it has to be on a reserved connection
   because a pooled one returned between statements would carry the lock away.
   Postgres frees it when the session ends, so a crashed run needs no sweeper.
   `matching-writes.realdb.test.ts` and both contract runners take it. **Reusing**
   whichever policy happened to be active was tried first and is wrong: the
   borrower's decisions then reference a row the owner deletes at its own
   teardown. The contract teardown was also rescoped — it deletes decisions by
   the file's own source records rather than by policy version, and its fixture
   GTINs are derived from the run id, because a canonical identifier has exactly
   ONE active owner and a hard-coded fixture GTIN becomes a shared resource the
   moment a second runner exists.

---

## Surfaces

### Merchant — `/admin/stores/:storeId/feeds/*`, behind `channels:write`

A feed is a sales channel's inventory arriving by file, and `channels:write` is
what already gates connecting a Shopify shop. It is denied to `staff`, which is
correct: configuring where a store's catalogue comes from is not a shop-floor
act. The reads follow the writes rather than getting a looser gate.

| Route | What it does |
|---|---|
| `GET /` | this store's feeds |
| `POST /` | create a feed (and its #62 source, in `draft` with NO rights) |
| `GET /:id` | one feed and its mapping versions |
| `GET /:id/status` | last run, next run, counts and failures |
| `POST /:id/versions` | draft a mapping version |
| `POST /:id/versions/:v/preview` | a bounded sample, mapped, with suggestions |
| `POST /:id/versions/:v/validate` | read the whole feed, write a report |
| `POST /:id/versions/:v/activate` | activate, citing a validation report |
| `POST /:id/versions/:v/revert` | draft a copy of an earlier version |
| `POST /:id/uploads` | upload a feed file (raw bytes, streamed) |
| `GET /:id/uploads` | this feed's staged artefacts |
| `GET /:id/reports` · `GET /:id/reports/:r` | the reports |
| `GET /:id/reports/:r/download` | the error report, as CSV |
| `POST /:id/sync` | open a MANUAL pass |

`assertConfigurationBelongsToStore` is the ONLY path from a `:configurationId` to
a row, and a configuration belonging to another store is answered **404** rather
than 403 — a distinguishable response would let a store member enumerate which
feed ids exist.

Two rate-limit buckets: `rl:feed-import:` for the surface, and a much smaller
`rl:feed-import-fetch:` for the four routes that cause an outbound request to a
host the merchant chose.

The upload route has **no body parser at all** — `express.raw` would buffer
gigabytes — so the handler iterates `req` and writes to disk as the bytes arrive.
A JSON or multipart content type is REFUSED, because the global `express.json()`
would have consumed the body and left an empty stream that reads as an empty
feed.

### Operator — `/internal/feed-imports/*`

On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/#62
use. Mounted while `FEED_IMPORT_ENABLED` is off, deliberately: a merchant's
mapping, their validation reports and the reason their last pass failed are
exactly the evidence somebody needs during the incident that turned the importer
off.

**Read-only, and that is a decision.** There is no "activate this version", no
"set this mapping", no "run this feed": every write belongs to the store that
owns the feed. The one operator power that is needed — pausing or revoking a
source whose terms went wrong — already exists on
`/internal/ingestion/sources/:id/status`, where the rights model lives.

---

## Environment

```
FEED_IMPORT_ENABLED=false               # registers the adapter + mounts the merchant surface
FEED_IMPORT_AUTH_ENCRYPTION_KEY=        # REQUIRED when enabled (openssl rand -hex 32)
FEED_IMPORT_STAGING_DIR=<tmpdir>/mercaria-feed-import
FEED_IMPORT_MAX_DOWNLOAD_BYTES=2147483648
FEED_IMPORT_MAX_DECOMPRESSED_BYTES=17179869184
FEED_IMPORT_MAX_COMPRESSION_RATIO=200
FEED_IMPORT_MAX_RECORDS=5000000
FEED_IMPORT_MAX_RECORD_BYTES=262144
FEED_IMPORT_FETCH_TIMEOUT_MS=30000
FEED_IMPORT_STAGE_TTL_MS=21600000
FEED_IMPORT_PREVIEW_SAMPLE_SIZE=50
FEED_IMPORT_MAX_REPORT_ENTRIES=10000
```

`FEED_IMPORT_ENABLED` gates the LOOP, never the durable record: with it off,
configurations, mapping versions, uploads and reports are all stored and
readable, every run refuses with `adapter_missing`, and turning it on drains the
backlog. Enabling it without the encryption key stays OFF and says so — a feed
whose download needs a bearer token cannot be CONFIGURED without it, so running
without it would mean accepting configurations that can never fetch.

Every other value is a REFUSAL threshold rather than a tuning knob. A feed past
one is rejected with the limit named, never truncated.

---

## Tests

| File | What it pins |
|---|---|
| `feed-parse.test.ts` | CSV quoting, embedded newlines, stray quotes, CRLF, BOM, duplicate headers, TSV, XML namespaces, CDATA, repeated children, XXE refusal, JSON record paths, JSON Lines isolation, gzip, split-multibyte decoding, latin1 |
| `feed-mapping.test.ts` | the money reader (three separator conventions, half-up string arithmetic, zero-decimal currencies, the unsupported-currency refusal), the injective external id, the transforms, the mapping engine's issues, the suggestions |
| `feed-security.test.ts` | SSRF against the real guard, the structural no-hand-rolled-check gate, download/decompression/ratio caps, container refusals from magic bytes, filename and storage-key sanitisation, URL redaction |
| `feed-memory.test.ts` | peak heap FLAT across an eightfold feed, with a vacuity floor on records processed |
| `feed-delivery-mode.test.ts` | snapshot and delta SEPARATELY, and that the rule is reachable through one function |
| `feed-import-isolation.test.ts` | no evaluation anywhere, the disjoint vocabularies, no commerce-graph write, the tenant gate, the protected columns — with an enumeration floor and a mutation self-test on every detector |
| `services/__tests__/feed-import-writes.realdb.test.ts` | the frozen identity key, the version freeze, the one-active partial unique, the activation CHECK, the mapping shape CHECK, the report counters, the observed-token CHECK, the append-only entries, the filename CHECK — against a REAL server |
| `adapters/__tests__/product-feed-contract.test.ts` | #62's thirteen contract cases against the real adapter over a real CSV, plus every refusal's classification |

---

## The reusable contract another adapter calls (#66, #65 and anything after)

An adapter that speaks a different transport reuses the parsing and mapping
stack rather than growing a second one. **There is no barrel** — the house rule
is to import directly from the owning module — so this is the whole contract,
module by module, and it is what #66's Awin adapter is written against.

Everything below is PURE: it takes an `AsyncIterable`, a plain options object
and a plain mapping, and it touches no database, no configuration table and no
`@mercaria/backend` service. That is what makes it reusable, and a change here
that took a repository handle would break it for exactly that reason.

### The pipeline, in the order an adapter composes it

```ts
import {
  boundedBytes, decompressBytes, decodeText,
  type FeedByteLimits, type FeedByteMeter,
} from '../../feed-import/bytes.js';
import { streamFeedRecords, type FeedParseOptions } from '../../feed-import/parse/index.js';
import { mapFeedRecord, type ResolvedFeedMapping } from '../../feed-import/mapping.js';

const meter: FeedByteMeter = { compressedBytes: 0, decompressedBytes: 0 };

const text = decodeText(
  decompressBytes(boundedBytes(rawBytes, maxDownloadBytes, meter), 'gzip', limits, meter),
  'utf-8',
);

for await (const raw of streamFeedRecords(text, parseOptions)) {
  const mapped = mapFeedRecord(raw, mapping);
  // mapped.normalized is a NormalizedSourceRecord, or null when an ERROR was raised
}
```

| Entry point | Module | Signature |
|---|---|---|
| `boundedBytes` | `services/feed-import/bytes.ts` | `(source: AsyncIterable<Uint8Array>, maxBytes: number, meter: FeedByteMeter) => AsyncGenerator<Uint8Array>` |
| `decompressBytes` | `services/feed-import/bytes.ts` | `(source, compression: FeedCompression, limits: FeedByteLimits, meter) => AsyncGenerator<Uint8Array>` |
| `decodeText` | `services/feed-import/bytes.ts` | `(source, encoding: FeedEncoding) => AsyncGenerator<string>` |
| `streamFeedRecords` | `services/feed-import/parse/index.ts` | `(text: AsyncIterable<string>, options: FeedParseOptions) => AsyncGenerator<FeedRawRecord>` |
| `mapFeedRecord` | `services/feed-import/mapping.ts` | `(record: FeedRawRecord, mapping: ResolvedFeedMapping) => MappedFeedRecord` |

`FeedParseOptions` (`parse/types.ts`) is `{ format, delimiter, quoteChar,
hasHeaderRow, recordPath, listSeparator, maxRecordBytes, maxRecords }`;
`FeedRawRecord` is `{ index, fields: ReadonlyMap<string, string> }`.

### `ResolvedFeedMapping` is plain data, and that is the point

```ts
interface ResolvedFeedMapping {
  readonly fieldMappings: ReadonlyMap<FeedFieldRole, FeedFieldMapping>;
  /** Keyed `${role}:${lower-cased source value}`. */
  readonly valueMappings: ReadonlyMap<string, string>;
  readonly identityKeyFields: readonly string[];
  readonly listSeparator: string;
  readonly defaultCurrency: string | null;
  readonly defaultCountry: string | null;
  readonly defaultLanguage: string | null;
}
```

#63 builds one from `feed_configuration_versions`; **#66 should build one in
memory** from an advertiser's declared columns and never touch #63's tables. It
holds no row id, so there is nothing to persist first.

`MappedFeedRecord` is `{ index, externalId, normalized, issues, sourceValues,
sourceUpdatedAt }`. `normalized` is `null` **exactly when** an issue of severity
`error` was raised — that is the isolate-this-record signal, and nothing throws.

### The transport half, when the feed arrives over HTTPS

| Entry point | Module | What it gives you |
|---|---|---|
| `openFeedStream` | `services/feed-import/fetch.ts` | `safeFetch` with HTTPS-only, conditional requests and a `not_modified` branch carrying no bytes |
| `openFeedOrigin` | `services/feed-import/open.ts` | the same over a URL **or** a staged upload, behind one `FeedOrigin` |
| `authorizeFeedRequest` | `services/feed-import/auth.ts` | applies a `basic`/`bearer`/`header`/`query_param` credential to a request |
| `redactFeedUrl`, `redactFeedMessage` | `services/feed-import/redact.ts` | the host-only form every log line and projection must use |

**Awin's feed URL carries the API key in the path**, so #66 inherits the rule
rather than deciding it: never log or project a feed URL, only
`redactFeedUrl`'s output.

### The adapter shape, if the source is a file and not an API

| Entry point | Module | Why an adapter needs it |
|---|---|---|
| `buildFeedStage`, `readFeedStagePage`, `readFeedStageManifest` | `services/feed-import/staging.ts` | one streaming read, paged afterwards — #62's page contract fits an API and a file has no page tokens |
| `feedCompletionVerdict`, `mayReportCompleteEnumeration` | `services/feed-import/completion.ts` | whether the pass may claim a completed enumeration, which is what authorises retirement |
| `FeedImportRefusal`, `feedRefusalFetchKind` | `services/feed-import/errors.ts` | a whole-feed refusal and its translation into #62's `CatalogSourceFetchFailureKind` |

`services/ingestion/adapters/product-feed.ts` is the worked example of all three
together, and `adapters/__tests__/product-feed-contract.test.ts` shows how to run
#62's thirteen contract cases against an adapter built this way.

Two fields #68 added to `CatalogSourceAdapter` and `AdapterFetchRequest` are the
adapter's own to answer and are not supplied by anything above:
`refreshModes` (required — see §"A delta feed can never claim a completed
enumeration" for why a feed declares `['full_snapshot', 'incremental']` and
nothing else) and `AdapterFetchPage.removals`, which a feed carrying an explicit
deletion marker may populate. #63's importer populates NO removals: a row simply
absent from a file is an omission, and #68's contract is precise that an
omission is evidence only when the enumeration was complete.

### What #66 must NOT reuse

`resolve.ts`, `configuration.service.ts`, `report.service.ts` and
`preview.service.ts` are #63's own configuration surface — they read
`feed_configurations` and its versions. An Awin adapter whose feeds are declared
per advertiser has no rows there, and reaching for them would make Awin's
catalogue depend on a merchant-facing table nobody registered it in.

---

## What is deferred, and to whom

Each is a NAMED contract, not a stub.

- **#66 — the Awin adapter.** The exact modules and entry points it calls are
  §"The reusable contract another adapter calls" above; the short version is
  that the parsing and mapping stack takes an `AsyncIterable`, a plain options
  object and a plain mapping, and knows nothing about configurations. Awin's
  per-advertiser feeds, its `Last Imported` polling and its Publisher API
  reconciliation are #66's.
- **#65 — the eBay Browse adapter.** An API, not a file; it shares #62's
  contract and none of this.
- **#37 — the outbound/affiliate redirect.** `affiliate_url` is mapped and
  stored on the observation; nothing here composes a tracked URL.
- **#59 — review and corrections** of what the matcher could not decide.
- **#68 — feed freshness policy** beyond `catalog_source_configs`' TTL.
- **Durable upload storage.** A staged upload lives on the disk of the task that
  received it, `feed_uploads.status = 'missing'` is a real state, and a run whose
  artefact went with its task refuses with `upload_missing` rather than importing
  zero records. Moving to object storage changes `upload.ts` and nothing else.
- **The mapping UI.** Every endpoint the flow needs exists and is documented
  above; the dashboard screens are not in this issue.

---

## Production-readiness checklist

1. `FEED_IMPORT_AUTH_ENCRYPTION_KEY` set (32 bytes hex), or `FEED_IMPORT_ENABLED`
   stays off and says so.
2. `CATALOG_OPERATOR_OXY_USER_IDS` populated, or `/internal/feed-imports` is not
   mounted and nobody can trace a merchant's feed.
3. Per feed: a MERCHANT bound on the #62 source (no merchant, no offers), a
   rights policy published and reviewed, the source status moved to `active`.
4. Per feed: the delivery mode confirmed with the merchant. `snapshot` on a
   delta feed retires their catalogue; `delta` on a snapshot feed leaves delisted
   products on sale forever. There is no default for exactly this reason.
5. A `validation` run read with the merchant before activation, and the error
   report downloaded.
6. `CATALOG_INGESTION_ENABLED=true` only after a feed has been drained by hand
   from `/internal/ingestion/drain` and its metrics read.
7. Raise `CATALOG_INGESTION_LEASE_MS` above the time a full stage build takes for
   the largest configured feed. The stage is built inside one page, and a lease
   that expires mid-build lets a second task reclaim the run and rebuild it.
8. Alerting on `feed_import_reports.invalid` climbing, on `enumerationComplete`
   reading false for a snapshot feed, and on the #62 health state.
