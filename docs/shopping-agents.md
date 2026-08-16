# Saved shopping agents (#97): a standing instruction that can only ever LOOK


`services/shopping-agents/` (14 modules) + `db/shoppingAgents/` (6
repositories) + `db/schema/shoppingAgents.ts` (8 tables) + `/shopping-agents`
(shopper) and `/internal/shopping-agents/metrics` (operator), plus the
storefront's `app/(app)/shopping-agents.tsx` and `@mercaria/ui`'s
`ShoppingAgentCard`. A shopper saves a structured OBJECTIVE, Mercaria
re-evaluates it when the catalogue moves, and tells them once. Schema
decisions: `db/schema/CONVENTIONS.md` §"Saved shopping agents (#97)".

- **The whole domain rests on ONE `solveBasketRequest` call, and that is what
  keeps it from becoming a second comparison engine.** All six launch jobs are
  questions about the same object — the best plan for these lines under these
  constraints, right now — and #96 already answers each as a NAMED RESULT
  (`cheapest_known_total`, `used_or_refurbished_value`,
  `official_channel_plan`). So #97's deterministic half is a TRANSLATION of an
  agent into a `BasketRequest` plus a read of the result its kind names.
  Ranking is #74's, eligibility is #57's, constraints are #94's; nothing here
  ranks, prices, converts a currency or judges an offer.
- **The evaluation key is FOUR facts and NO CLOCK** — agent, agent REVISION,
  #96's `BasketInputSnapshot.digest` and the policy version. That digest is a
  hash over the request, every candidate offer with its price and delivery
  terms and every FX rate, which makes it #79's `observed_price_version` one
  layer up: an unchanged catalogue reproduces it and the finding converges on
  `ON CONFLICT DO NOTHING … RETURNING`; a moved price mints a new one.
  Mutation-tested — adding `Date.now()` to the key turns exactly the
  idempotency case red.
- **An agent cannot buy anything, and that is FIVE independent things.** The
  six job kinds are DISJOINT from sixteen forbidden ACTIONS; no column in the
  eight tables names an order, a cart, a checkout object, a payment method, a
  card or a merchant's terms (a gate walks the real drizzle tables);
  `.strict()` schemas refuse an undeclared key; `refuseForbiddenAgentAction`
  is mounted BEFORE the schema and answers with the exact prohibition it found
  rather than "Unrecognized key"; and `shopping-agent-isolation.test.ts` scans
  the whole domain directory — plus the storefront, #92's reason — with a
  vacuity floor and a mutation self-test per detector. **The gate found four
  real things on its first run**, two of them in its own detectors: a pattern
  anchored on `services/` never sees the RELATIVE `'../payments/x.js'` every
  module here would actually write (#125's finding, repeated), and a bare
  `checkout` column pattern forbids `native_checkout_eligible`, which is the
  information #97 notification 4 asks a shopper to be given.
- **`terms_version` is MERCARIA's own agent terms and can never be a
  merchant's** — accepting a merchant's or a supplier's terms is a forbidden
  action, so the column detector was narrowed to `merchant_terms` rather than
  `terms`. A wall that forbids the word forbids the fact.
- **A model may only summarise a finding that is ALREADY STORED, and that is
  the SIGNATURE.** `summarizeStoredFinding` takes a finding id, so a provider
  cannot be consulted before a verdict exists; the package it is shown carries
  no owner, no agent name, no description and no location; the draft it returns
  has no field for a price, a product or a verdict; and the validator refuses a
  citation the finding never minted, a numeral the finding does not contain and
  any purchase language. Nothing registers a provider — the deterministic
  TEMPLATE is the summary, not a fallback (#97 acceptance 7).
- **Three-valued outcome, and only `qualified` may notify.** `incomplete`
  carries at least one reason and NO objective value (a CHECK), and
  `mercaria_shopping_agent_notification_requires_qualified` — a TRIGGER,
  because the invariant is CROSS-ROW — refuses a notification for anything
  else. Mutation-tested: with the trigger dropped, the identical insert is
  ADMITTED.
- **`cardinality`, never `array_length`.** Measured again here: with
  `array_length(trigger_sources, 1) >= 1` the empty array is ADMITTED
  (`array_length` is NULL on `{}` and a CHECK rejects only FALSE). Any future
  array-non-emptiness CHECK in this schema must be written the same way.
- **Findings, their lines and the audit trail are APPEND-ONLY against UPDATE
  and DELETE is PERMITTED** — the `analytics_events` posture, because erasure
  is one scoped DELETE that cascades and a trigger refusing it would make that
  fail silently. The ONE update a finding admits is `lifecycle` moving off
  `current`, checked by comparing the WHOLE TUPLE with the lifecycle
  normalised, so a "correction" cannot rewrite an amount under cover of setting
  a flag.
- **A split BLOCKS and a merge REHOMES.** `agents` is a new member of BOTH
  `CATALOG_MERGE_PHASES` and `CATALOG_SPLIT_PHASES` (the #79/#80 precedent),
  and `shopping_agents_ambiguity_blocked_check` refuses an
  `ambiguous_after_split` agent that is not `blocked` — the strongest form of
  the refusal to pick a side, because a save on the wrong side shows the wrong
  page once and an AGENT on the wrong side goes on notifying on its own
  schedule. `resolve-split` is the only way out of `blocked`; a client cannot
  write `enabled` over one.
- **Triggers and evaluations are TWO durable jobs.** The trigger queue is one
  row per canonical PRODUCT (the fan-out, bounded by
  `triggerFanOutLimit` — a popular product cannot starve every other job, and
  the row converges so nobody it did not reach is dropped); the evaluation
  queue is one row per AGENT. Both are `offer_outboxes`' convergence shape with
  `FOR UPDATE SKIP LOCKED` leases, an owner check, capped backoff and a visible
  `dead_letter`. The enqueue's first statement is one indexed `exists`, so a
  catalogue nobody watches writes no rows.
- **A withheld notification leaves a ROW** with a coded reason, which is what
  makes #97 cost rule 6's duplicate suppression countable — a table of messages
  that were SENT can never answer how many were not. Quiet hours DEFER rather
  than drop (a release with `failure: null`).
- **The operator surface is ONE route and returns only AGGREGATES.** There is
  no trace and none may be added: a saved agent is a person's intent in their
  own words, so "who is watching this product" is unrepresentable rather than
  refused. It is on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list and is
  deliberately NOT gated on `SHOPPING_AGENTS_ENABLED` — the queue lag has to be
  readable during the incident that turned the shopper surface off.
- **Explicit authorization is a COMPARISON, not a checkbox.** The client echoes
  back `shoppingAgentConstraintDigest` of exactly what it RENDERED and a
  mismatch is refused, on create AND on a constraint edit — so no search, save
  or watchlist path can mint an agent by accident (#97 privacy 2). A material
  edit bumps `revision`, which is in the evaluation key, so the answer to the
  old question can never silence the new one.
- Env: `SHOPPING_AGENTS_ENABLED` (the shopper MOUNT),
  `SHOPPING_AGENT_TRIGGER_ENABLED` and `SHOPPING_AGENT_EVALUATION_ENABLED` (the
  two LOOPS), all default false, plus **`SHOPPING_AGENT_NOTIFICATIONS_ENABLED`**
  (#97 evaluation 10's independent kill switch — default TRUE, because an
  incident lever that ships off is a feature nobody notices is missing), the two
  abuse caps and the loop tunables. **NOT ONE gates a durable record**, and a
  scanned gate says so.
- Seams, each a named contract that fails closed: **an outbound mail transport**
  (`registerShoppingAgentEmailTransport` is called by nothing; an `email`
  channel is storable and fails `transport_unconfigured` visibly with the row
  intact), **a summary provider**
  (`registerShoppingAgentSummaryProvider`, likewise — closing it is one module
  plus one call, and `summary.ts`'s validator is what makes that safe), **#70**
  (catalogue-wide DISCOVERY: an agent must name at least one canonical product
  today, because `CANONICAL_SEARCH` defaults `off` and a category-only agent
  would evaluate to `incomplete` forever), **#93** (proximity — no field exists
  to accept one), **#77** (no analytics event is emitted), **#86** (merchant
  demand), and the CREATE/EDIT screen (#97 UX 1 and 6 — every endpoint it needs
  exists, including the digest the confirmation rests on).

