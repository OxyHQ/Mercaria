# The translation revision trail (#367 step 10, box 4)

What a localized string used to say, who it was credited to, and how to put an
earlier wording back.

| Thing | Where |
|---|---|
| Vocabulary | `@mercaria/shared-types` `catalog-localization-revisions.ts` |
| Table + triggers | `db/schema/catalogLocalization.ts`, migration `0115` |
| Reads and the rollback | `db/catalogLocalization/revisionRepository.ts` |
| Gate | `db/__tests__/localization-revisions.realdb.test.ts` |

## Why this is not a governance subject

The obvious alternative was to widen `CATALOG_GOVERNANCE_SUBJECT_KINDS` and let
`catalog_governance_audit_events` carry translation history. Refused, for two
reasons that point the same way.

**It would change the audience.** A governance subject comes with the operator
gate, four eyes and the change-request flow attached to it. Translations are
written by translators and store staff on a different cadence, and moving their
history into governance would smuggle an audience change in as a side effect of
where the rows live — a policy decision nobody has made.

**Governance deliberately does not store the TEXT.**
`services/catalog-governance/review.service.ts` records that a translation's
status changed and omits the body, because *"a translation body in an audit row
is a copy of the text a correction can never reach"*. That is right for an audit
trail, and it is exactly what makes governance unable to be the home for a
history whose whole purpose is the text.

So this follows `catalog_revisions` (#59) and `review_target_migrations` (#76):
an append-only trail owned by the domain whose rows it describes. **Do not
consolidate the two** — they record different facts for different readers, and
only one of them may hold the sentence a translator wrote.

## Written by triggers, which is what makes it complete

Four `AFTER INSERT OR UPDATE` triggers, one per text table, are the **only**
writers. There is deliberately no `recordRevision` function anywhere.

A trail written by a repository records what the service did and misses a
backfill script, an operator at a `psql` prompt, and the stale triggers the
schema already installs — and every gap is invisible, because a missing revision
looks exactly like a field nobody edited.

Two of the realdb cases exist to keep that honest rather than aspirational: one
writes a localization through **raw SQL** that never touches the service, and one
lets the **sibling stale trigger** produce the revision by editing the source
category. Both assert the trail recorded it.

### One row per FIELD

A save that changes a name and a description writes two rows. That is what makes
a per-field diff a `lag()` over one partition rather than a comparison of two
blobs, and it is why there is no `jsonb` — ADR 0007 D14 keeps every localized
string a real column, and a revision of a string is a string.

A field is recorded when its **value** changed, or when the row's `status` or
`provenance` did. A translation going `stale` under an unchanged sentence is part
of that sentence's history and is the transition a reviewer most needs to see.

Only **registered** fields are recorded: the `field_key` CHECK admits exactly
`LOCALIZED_FIELD_KEYS`, so `attribute_value_localizations.description` — a real
column with no registry entry — has no history here. It gains one in the commit
that registers it, with no change to the triggers beyond a `VALUES` row.

## The field-pair CHECK, and the prefix trap it avoids

`(entity_kind, field_key)` must describe one registered field, enforced as a
**pair membership test** rendered from the registry.

A prefix rule (“the key starts with the kind”) is wrong here in a way that is
easy to miss: `product_type_field.label` begins with `product_type`, so a prefix
rule admits a `product_type` revision carrying a `product_type_field` column. The
realdb suite asserts that exact row is refused, with a positive control that the
correctly-paired row is accepted — without which the refusal could be caused by
anything else in the statement.

## Rollback is a new revision, never a restore in place

The compensating-correction shape from `catalog_revisions`. A rollback performs
an ordinary UPDATE of the localization row and the trigger records it, so the
trail stays trigger-written; the one fact a trigger cannot see — that this UPDATE
undoes a specific revision — is carried in by a transaction-local setting
(`LOCALIZATION_ROLLBACK_SETTING`).

**`set local`, never `set`.** A session-level value would leak onto the next
statement a pooled connection serves and stamp an unrelated later edit as a
rollback of this revision. Mutation-tested: flipping `set_config`'s third
argument to `false` turns the leak case red.

Nothing replays a stored `before` snapshot — that would write columns whose
meaning may since have moved. And there is no stored `before` column at all:
`previousValue` is read off the adjacent row, because storing both sides of every
change is two representations of one fact and nobody could say which was the text
if they disagreed.

A rollback whose UPDATE would change nothing writes **no** revision (the
trigger's `IS DISTINCT FROM` guard doing its job) and is reported as `undefined`
rather than as a success — “restored” and “it already said that” are different
answers.

## Append-only against UPDATE *and* DELETE

`catalog_revisions`' posture, not `analytics_events`'. Analytics permits DELETE
because erasure on a schedule IS its policy and a trigger refusing it would make
retention fail silently. **Nothing sweeps this table**: a revision carries no
personal data — the only account id on it is the reviewer the row already credits
publicly — so there is no retention deadline for a DELETE to serve, and a
revision that could be deleted would let the record of a wording disappear along
with the reason somebody changed it.

If a retention sweep is ever introduced here, permit DELETE deliberately and say
why, rather than leaving the sweep to fail against this guard.

## `credited_oxy_user_id` is not an actor column

It is the row's own `reviewed_by_oxy_user_id` at that moment — who the
translation **credits**, never who ran the statement. A trigger sees the row, not
the session. A machine translation carries `null` by CHECK, and a direct `psql`
UPDATE is credited to whoever the row already named. Reading it as "who made this
change" would be a misattribution, which is the thing an audit trail can least
afford, so the column is named for what it holds.

## No foreign key on `entity_id`, permanently

`catalog_revisions`' ruling, for its reason: the trail spans four entity kinds
and its rows must **outlive their subject**. A localization row is deleted only
by cascade when its entity is, and the history of what a category used to be
called in Spanish is precisely what has to survive the category going away.

The localization family's own header rejects a polymorphic *localization* table
because an orphaned translation would be invisible — that argument is about
**current state**, and it inverts for a history, which is worthless if it dies
with its subject.

## Deferred

- **The HTTP surface.** `/internal/catalog-localization` (#660) is the natural
  home — a `GET .../history/...` and the rollback write — and this lands after
  that PR merges, because both branches would otherwise create the same router
  file. Note the rollback is the desk's **first write route**, so #660's
  "registers no write verb" gate is a decision that changes with it rather than a
  rule to work around.
- **A `DELETE` recorded as a revision.** Nothing in the backend deletes a
  localization row today (measured, not assumed), so the action vocabulary has no
  `delete` member. A translation is withdrawn deliberately by moving it to
  `deprecated`, which is an ordinary update and is recorded as one.
