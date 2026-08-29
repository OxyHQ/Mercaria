# Deterministic matching (#58, ADR 0002 D14/D19)

`services/matching/` + `db/matching/` + `db/schema/matching.ts` (9 tables).
Turning a source observation or a native listing variant into a canonical
product and variant. Schema decisions: `db/schema/CONVENTIONS.md` §"The MATCHING
layer". The failure mode that shapes everything here is the FALSE MERGE: it
looks exactly like a correct match, contaminates every product page and price
comparison downstream, and is discovered by a customer. The rules that are
load-bearing:

- **A conflicting valid identifier can never auto-merge, and that is a CHECK.**
  `match_decisions_blockers_auto_check` refuses `automatic_match` with a
  non-empty `blockers`, so brand mismatch, bundle/multipack/accessory confusion,
  a missing required axis, an operator's rejected pair and a closed category
  gate all stop a merge through ONE mechanism no service bug walks around. Two
  companion CHECKs stop the ways around it (a recorded conflict implies its
  blocker; every blocker appears in the explanation).
- **A semantic score is never the sole authority — and neither is a title.** A
  candidate with no positive value among identifier/brand/model/attribute
  agreement carries `no_deterministic_support`, which is a blocker. Semantics
  are off in THREE independent places (no scorer is registered, which is the
  shipped state; `MATCH_SEMANTIC_ENABLED`; the policy version's own flag), and a
  test runs the whole labelled dataset with all three off and asserts the
  decisions are byte-identical.
- **A category with no recorded qualifying benchmark run cannot match
  automatically.** `match_category_gates` cites its measurement by a NOT NULL
  COMPOSITE foreign key carrying the policy version, so an uncited gate and a
  gate citing another policy's run are both unrepresentable. The precision and
  sample floors are the service's, because a CHECK may not contain a subquery.
  **The identifier stages are deliberately NOT gated** — a check digit and a
  single active owner have no error rate a benchmark could measure, and gating
  them would make a fresh deployment unable to attach a single barcode listing.
- **An unknown feature is left out of the confidence DENOMINATOR**, never read
  as zero and never as the mean of the others. That arithmetic IS #58 rule 5:
  reading unknown as zero makes every unbranded P2P listing unmatchable.
- **A blocked pair is keyed on the STABLE subject identity**, not on the
  observation — `source_records` mints a new row per content change, so a
  rejection keyed on the observation would evaporate on the next crawl.
- **`create_new` is a RECOMMENDATION.** The matcher never mints a canonical
  product, never writes an `offers` row and never resolves an identifier
  dispute; a test fails the build if any of those change.
- **This closes #57's seam.** An automatic match on a native variant writes the
  `native_listing_links` row through #57's own repository and calls
  `requestNativeOfferSync`, in ONE transaction — so a native listing becomes a
  native offer end to end. The link's `method` is the STAGE that produced it
  (`barcode_gtin` with NULL confidence for a deterministic match, `matcher` with
  a number for a heuristic one, which is what #59 reviews).
- **The benchmark is a gate, not a fixture dump.**
  `services/matching/benchmark/` holds a versioned, content-addressed labelled
  dataset covering all eight case kinds the issue names; it runs against an
  in-memory catalogue so the whole set runs in CI on every push, sharing scoring
  and the policy with production byte for byte and simplifying only RETRIEVAL.
  A scale pass is opt-in behind `MATCH_BENCHMARK_SCALE`.
- Operator surface: `/internal/matching/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57 use — metrics (queue
  AGE and ambiguity rate), traces, the review inbox, policy versions, category
  gates, blocked pairs, and triggers for one evaluation / one drain / one sweep
  page. Env: `MATCH_PIPELINE_ENABLED` (gates the LOOP only — the queue always
  accepts), `MATCH_QUEUE_BATCH_SIZE`, `MATCH_QUEUE_POLL_INTERVAL_MS`,
  `MATCH_SWEEP_BATCH_SIZE`, `MATCH_SEMANTIC_ENABLED`.
- Deferred to their owners: the correction/merge workflow (#59 — it consumes
  `match_decisions.review_state`, the candidate rows and `match_blocked_pairs`),
  bulk external ingestion (#37), the canonical minting a `create_new` recommends
  (#60), ranking (#74). Source observations are matched by the same pipeline but
  their ATTACHMENT (`canonical_*_source_links`) belongs to the ingestion path
  that owns the observation, not to the matcher.
