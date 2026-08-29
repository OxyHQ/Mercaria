# Verified relationships and evidence (#55, ADR 0002 D10/D11/D17)

`services/commerce-graph/relationship*.ts` + `db/commerce-graph/relationshipRepository.ts`
+ `db/schema/relationships.ts` (3 tables). Schema decisions:
`db/schema/CONVENTIONS.md` §"The relationship layer". A relationship is a typed,
scoped, temporal, evidence-gated CLAIM — never a boolean and never inferable.

- **No public badge from a name, a logo or a domain.** `verification_method` has
  no `name_match` member, so it is unrepresentable; `SUFFICIENT_EVIDENCE_KINDS`
  then decides which evidence kinds can carry which relationship kind, and
  `domain_control` is deliberately NOT sufficient for `official store`,
  `authorized reseller` or brand ownership — it proves control of that hostname.
- **Verification and confidence are different fields, and confidence is
  CHECK-restricted to ingestion rows.** A 0.99 candidate is a candidate; the
  public resolver filters on `verified` and never reads confidence.
- **Three of the issue's nine types are NOT kinds** — *merchant operates
  storefront*, *brand contains product family*, *brand markets product* are
  foreign keys (D17). `STRUCTURAL_GRAPH_FACTS` names them and a test fails the
  build if a kind duplicates one.
- **`Official store` and `Authorized reseller` are separate kinds, separate
  badges and separate LISTS** on a brand page; a merchant with neither has no
  relationship row at all, which is the normal state.
- **Duplicates are impossible, not refused**: a GENERATED `endpoint_key` +
  partial unique `WHERE valid_to IS NULL`. A plain multi-column unique would let
  them through — Postgres treats NULLs as distinct.
- **Four eyes** covers exactly the badge-producing kinds, defaults ON
  (`CATALOG_FOUR_EYES_REQUIRED`), and is held by a partial unique on
  `relationship_reviews`, not by a service comparison. `review_round` advances
  on every decision so an approval cannot be reused.
- **The public read never trusts `status` alone** — it requires the validity
  window too, so a lapsed claim produces no badge whether or not a sweep ran.
  Revocation keeps the row, its verification facts, its evidence and its reviews.
- Operator surface: `/internal/commerce-graph/relationships*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54 uses. Public reads:
  `/brand-relationships/*`. Ranking isolation is a test
  (`relationship-ranking-isolation.test.ts`), the fee-domain precedent.
- Deferred: the fee-style ranking USE of verification (#72/#74), #56's product
  families (`product_family_id` is a DEFERRED foreign key), and #83's claiming —
  claiming a merchant grants no relationship here, and there is no code path
  that could.
