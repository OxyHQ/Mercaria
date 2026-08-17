# Runbook — catalog publication failures (#367 W17)

A merchant published a product and something in the chain behind it did not
happen. Reference for everything below:
[../catalog-observability.md](../catalog-observability.md).

**Read this first, because it changes what you look at.** There is **no metric
that counts failed publications.** The publish endpoint
(`POST /stores/:storeId/product-drafts/:draftId/publish`) is not an observed
route, and nothing persists a validation refusal — that is the
`draft_validation_failure_rate` seam. `authoring_schema_error_rate` DOES observe
real traffic (it is keyed on `GET /catalog-authoring/schemas/:productTypeKey`,
and answers `surface_not_mounted` while `CATALOG_AUTHORING_ENABLED` is off), but
it counts only responses with `status >= 500` on the SCHEMA READ, which is neither
the publish call nor a refusal. So a publication failure is diagnosed from
**draft OUTCOMES in aggregate** and from **the trace of one publication**. The
draft metrics read stored ROWS, so they keep working whatever the route flags
say.

**Owner:** the on-call engineer for the Mercaria API. Escalate to whoever owns
`services/catalog-authoring/` if the cause is a product-type version.

---

## The alert

| Signal | Where | Condition to alert on |
|---|---|---|
| `draft_abandonment_rate` | `GET /internal/catalog-metrics` → `.data.readings[] \| select(.key=="draft_abandonment_rate")` | `ratio` above its usual band with `denominator` above a floor you have chosen — never on `ratio` alone |
| `draft_completion_rate` | same report | a fall, read TOGETHER with `draft_open_count` |
| `schema_version_unavailable` | `GET /internal/catalog-metrics/integrity` | `findings > 0` |
| `mustStayZero.metricCollectionFailures` | `GET /internal/catalog-metrics` | any non-zero value |
| `authoring_schema_error_rate` | same report | a rise. 5xx on the SCHEMA composition read, which blocks a merchant before they can publish at all. Read the STATE first: `unmeasured` / `surface_not_mounted` means `CATALOG_AUTHORING_ENABLED` is off and there is no authoring at all; `measured` with `denominator: 0` means the surface is live and nobody has opened a form |

Both draft rates are `rolling_7d` and are keyed on the drafts CREATED in the
window, so they move slowly and a spike takes days to appear. They are the
aggregate signal; a specific merchant's complaint is answered by the trace.

## What it means

Something between "a merchant pressed publish" and "the listing is on sale, its
offers converged and its variants are queued for matching" did not complete. The
chain is: draft → listing → canonical links → offer convergence → variant
matching (→ attribute reindex, which does not exist; see the
[indexing-lag runbook](catalog-indexing-lag.md)).

## What it does NOT mean

- **Not that the API is returning 5xx.** A validation refusal and a composition
  refusal are both 4xx and both correct answers — a merchant typing a category
  outside a product-type version's scope is not a server fault, which is why
  `authoring_schema_error_rate` counts only `status >= 500`.
- **Not that publications are failing, when the denominator is small.** A
  `draft_abandonment_rate` of 1.0 over a denominator of 2 is two merchants
  changing their minds.
- **Not that the whole fleet is affected.** The route counters are per ECS task
  and reset on deploy.
- **Not a failure at all, with the levers off.** `CATALOG_AUTHORING_ENABLED`
  gates the authoring MOUNT; with it off nothing is published, every draft rate
  has a denominator of zero, and that reads as a measured `0 / 0` with no ratio.

## The first three things to check

**1. Read the draft metrics, denominator FIRST.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics \
| jq '.data.readings[]
      | select(.key|startswith("draft_"))
      | {key, state, numerator, denominator, ratio}'
```

A `denominator` of 0 means nobody created a draft in the last seven days — stop
here and check the flags, not the code. A `state: "unmeasured"` with
`reason: "source_unavailable"` means the read itself failed; go to
`mustStayZero.metricCollectionFailures` and the error log.

**2. Trace ONE publication, hop by hop.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics/trace/draft/<draftId> \
| jq '.data | {draft: .draft.state, listing: .listing, links: .canonicalLinks,
               offers: .offerConvergence, matching: .variantMatching}'
```

Read it as a chain and stop at the first hop that is not what you expect:

| Reading | Means |
|---|---|
| `draft.state: "absent"`, `reason: "draft_not_found"` | the id is wrong (a 404 from the route means neither a draft nor a listing exists) |
| `listing: {state:"absent", reason:"draft_not_published"}` | the draft is still `open` or was `discarded`. Nothing failed downstream because nothing was published |
| `listing: {state:"absent", reason:"published_listing_missing"}` | the draft says it published and the row is gone. A published draft pins its listing `on delete restrict`, so this is unreachable through ordinary code — treat as data corruption, not as a queue problem |
| `canonicalLinks: {state:"empty", reason:"no_canonical_attachment"}` | ordinary. The author selected no canonical product; the publication SUCCEEDED |
| `offerConvergence: {state:"absent", reason:"no_outbox_row"}` | **a real finding.** `publishDraft` enqueues in its own transaction, so the enqueue did not happen — the listing may claim it is on sale when its offers do not |
| `offerConvergence.convergence: "dead_letter"` | the convergence gave up, visibly. `hasLastError` says an error is recorded |
| `offerConvergence.convergence: "superseded"` | a newer request arrived mid-run; this row owes another pass. Normal once, a finding if it persists |
| `variantMatching: {state:"empty", reason:"no_queue_row_for_any_variant"}` | `syncListingFacets` enqueues one per variant, so this is a real finding |
| `variantMatching.variantsWithoutQueueRow > 0` | a PARTIAL enqueue. Compare `variantCount` (counted from `product_variants`) against `listing.variantCount` (the maintained projection) — if those two disagree, the projection has drifted and that is a second finding |
| `attributeReindex.state: "unreachable"` | **always**, on every trace. Not this incident |

**3. Check the integrity sweep for a broken audit record.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics/integrity \
| jq '.data | {complete, results: [.results[] | {kind, population, findings, sample}]}'
```

`complete: false` first — a partial sweep reporting zero findings is not a clean
catalogue. Then `schema_version_unavailable`: its sample names
`catalog_authoring_drafts:<id>` rows whose pinned product-type version went back
to an EDITABLE lifecycle, which means the schema a merchant's answers were
recorded under can no longer be re-derived.

## Likely causes, most likely first

1. **A product-type version moved under open drafts.** `publishDraft` composes
   the schema again at publish time and a composition refusal is thrown as a
   VALIDATION result, so every affected merchant sees a refusal at the same
   moment. Check whether the version's lifecycle left `published`, or whether the
   category left the version's scope.
2. **Validation refusing on a requirement merchants cannot satisfy.** This is the
   commonest cause and the one with no metric (seam 2). Reproduce with
   `POST /stores/:storeId/product-drafts/:draftId/validate` on a real draft and
   read the field codes.
3. **The offer convergence dispatcher is off or behind.**
   `OFFER_MATERIALIZATION_ENABLED` gates the LOOP; rows keep accumulating. Read
   `GET /internal/offers/convergence` for how much is outstanding.
4. **The match dispatcher is off or behind.** `MATCH_PIPELINE_ENABLED` gates the
   loop. `unresolved_subject_count` grows and, more usefully,
   `unresolved_subject_oldest_age` grows — depth without age cannot tell a deep
   queue draining fast from a shallow one that is stuck.
5. **A partial enqueue from a write path that is not `publishDraft`.** A listing
   whose variants changed through another path may have an outbox row and missing
   queue rows.
6. **The metrics collection itself is degraded.** Non-zero
   `metricCollectionFailures` plus several readings at
   `unmeasured` / `source_unavailable` means you are looking at a partial report.

## Remedy

| Cause | Action |
|---|---|
| A missing offer-outbox row, or a dead-lettered / stuck convergence | `POST /internal/offers/listings/<listingId>/converge` with body `{}`. It drives the same idempotent path the loop drives. |
| Variants with no match-queue row | `POST /internal/matching/evaluate` with `{"productVariantId":"<id>"}` for one, or `POST /internal/matching/drain` to page the queue now. |
| A version back in `review` or `draft` | Re-publish that version through the governance path — `POST /internal/catalog-governance/changes` with `product_type_publish`, then `POST /internal/catalog-governance/changes/:changeId/apply`. Do not edit the draft to point at a different version. |
| A category outside the version's scope | The same governance path with the taxonomy or product-type action that restores the scope. |
| A validation requirement nobody can satisfy | A NEW product-type version. A published version is immutable by trigger, and that is the point. |
| A dispatcher lever off | Turn it on. Both gate loops only; the durable rows are already there and the backlog drains. |

## What NOT to do

- **Do not insert an `offer_outboxes` or `match_queue` row by hand.** Both carry
  a `requested_revision` / `claimed_revision` pair whose whole purpose is to
  survive a write landing mid-run; a hand-written row with the wrong revision
  either re-runs forever or is swallowed by the completion that follows it. Drive
  the idempotent endpoint.
- **Do not write `catalog_authoring_drafts` directly** to "unstick" a
  publication. The table carries three biconditional CHECKs tying `status`,
  `published_listing_id`, `published_at` and `expires_at` together; a partial
  update either fails at the database or produces a row the trace will report as
  `published_listing_missing` forever.
- **Do not read `authoring_schema_error_rate` as a publication-failure rate.** It
  counts 5xx on the schema READ, per task, since that task started. A validation
  refusal and a composition refusal are 4xx and appear in it nowhere.
- **Do not treat `canonicalLinks: empty` as a fault.** An unmatched listing is a
  successful publication.
- **Do not chase `attributeReindex`.** It is `unreachable` on every trace by
  construction.
- **Do not clear a `mustStayZero` counter.** There is no endpoint that can, and
  that is deliberate.
