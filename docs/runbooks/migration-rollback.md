# Runbook — the rollback point of a migration

You are rolling an image back and you need to know whether the database has to
move with it. Reference: `packages/backend/src/db/migrate.ts` (the only thing
that applies a migration), `packages/backend/src/db/migrationRollback.ts` (the
classifier) and `@oxyhq/db`'s `migrate/phases` (the deploy-phase contract).

**This runbook is about SCHEMA migrations.** Rolling the #367 catalog rollout
back by flipping read levers is a different operation with a different runbook:
[`catalog-rollout-rollback.md`](catalog-rollout-rollback.md). Nothing here
turns a feature off.

---

## 0. The one-line answer, and why the deploy phase does not give it

Every migration already declares which side of a rollout it is safe to apply
on:

```
-- oxy:deploy-phase=pre      additive; correct against the old image and the new
-- oxy:deploy-phase=post     takes something away; correct only once the new image is live
```

That says which way is safe going FORWARD. It is not the question you have
during an incident, which is the reverse one:

> We are putting the previous image back. Does the schema have to move too, and
> with what?

The phases answer half of it and the half they answer is the good half:

- **A `pre` migration's rollback point is the image revision alone.** It was
  additive, so the previous image runs against the schema unchanged. You do not
  have to touch the database, and in an incident you should not.
- **A `post` migration has no rollback point past it.** It removed something the
  previous image reads, so putting the image back without putting the schema
  back is an outage of a different shape.

What neither phase tells you is whether putting the schema back is even
possible from the migration file, and that is where the intuition is wrong.
Run the census and read the split for yourself:

```bash
bun run --cwd packages/backend db:rollback-plan --census
```

The number to notice is how many **`pre`** migrations carry a statement whose
inverse cannot be produced from their own file. It is a large fraction of them
— the gate floors it, so read the floor in
`migration-rollback-posture.test.ts` for the number somebody last measured
rather than trusting a figure written here, which would rot. The reason is
mundane: widening a CHECK is spelled `DROP CONSTRAINT` + `ADD CONSTRAINT`, and
the definition that was dropped is not in the file that dropped it. So
"additive" and "reversible" are different properties, and the phase marker only
ever claimed the first.

---

## 1. The declaration every migration carries

Beside its phase marker, on its own line, at column 0:

```
-- oxy:rollback=derived
-- oxy:rollback=restore: <what is gone and where it comes back from>
-- oxy:rollback=replay:  <what is gone and which forward path re-derives it>
-- oxy:rollback=accepted:<what is gone, and why the loss is accepted>
```

| posture | what it means for you |
|---|---|
| `derived` | Every statement's inverse can be produced from the file. `bun run --cwd packages/backend db:rollback-plan <tag>` prints it. |
| `restore` | Something is gone and putting it back means going outside the file — a database snapshot, or the earlier migration that carries the definition this one dropped. |
| `replay` | Something is gone and a named forward path re-derives it (the next connector sync, a converger, a backfill that is a function of columns still present). |
| `accepted` | Something is gone, it is not coming back, and the note says why nothing needs it. |

`derived` takes no note. The other three require one, and the note has to NAME
an object the migration removes or rewrites — see §4.

---

## 2. Getting the plan

```bash
# every migration, one line each: declaration and how much is invertible
bun run --cwd packages/backend db:rollback-plan

# one migration, in full
bun run --cwd packages/backend db:rollback-plan 0134
```

A tag prefix is enough. For a single migration you get the declaration, its
note, the **derived inverse** in reverse order, and — separately and loudly —
every statement the tool could **not** invert.

**Read the second list before you run anything from the first.** A derived
inverse over a partially invertible migration is incomplete by construction,
and the omissions are the statements that mattered.

Nothing in this tooling connects to a database, and there is no down-migration
runner. The output is material for a decision a person makes.

---

## 3. What to actually do

### 3.1 Rolling the image back only

Look at the phase of every migration applied since the revision you are going
back to.

- All `pre` → **do nothing to the database.** The previous image is correct
  against this schema. This is the overwhelmingly common case and the whole
  reason the `pre`/`post` split exists.
- Any `post` → the previous image reads something that is gone. Either go back
  to a revision **after** that migration, or put the schema back first, which
  is §3.2.

### 3.2 Putting the schema back

For each migration, newest first:

1. `db:rollback-plan <tag>`.
2. `derived` → the printed inverse is complete. Read it, then apply it by hand.
   It drops what the migration created, so any row written into those objects
   since goes with them; that is inherent in going back and is not a surprise
   the tool is hiding.
3. `restore` / `replay` / `accepted` → the note names what is gone and what to
   do. The derived inverse still covers the invertible part of the file, but it
   is not the whole story and the tool says so.

Apply the inverses in the reverse of the order the migrations were applied.
Within one migration the printed order is already reversed.

### 3.3 The migration ledger

None of this writes to `drizzle.__drizzle_migrations`. The apply rule is a
HIGH-WATER comparison, not a set difference: `dialect.js` applies a migration
when the ledger is empty or the newest recorded `created_at` is older than the
migration's journal timestamp. Two consequences.

- A ledger row left behind for a migration you have just undone keeps the
  high-water where it is, so that migration is never pending again and
  `db:migrate` reports a clean run over it. Delete the row in the same
  transaction as the inverse.
- **Undo newest-first and delete newest-first**, or you create the state
  `@oxyhq/db`'s `unreachableEntries` exists to name: a journal entry with no
  ledger row sitting BELOW the high-water mark, which nothing will ever apply
  and nothing reports as pending. `migrate.ts` refuses to run at all in that
  state, which is the loud failure rather than the silent one — but it is still
  a hole somebody has to dig out of by hand.

The ledger stores drizzle's content hash and never compares it, which is what
makes editing an applied migration's COMMENTS — including adding the marker
this runbook is about — safe.

---

## 4. What the gate can and cannot catch

`packages/backend/src/db/__tests__/migration-rollback-posture.test.ts` binds the
declaration to the migration's own SQL in **both** directions:

- `derived` is refused on a file carrying any statement the classifier cannot
  invert, and the failure names the statements.
- `restore` / `replay` / `accepted` are refused on a file whose every statement
  IS invertible.

That second one is the point. "Every migration declares a rollback posture" is
a requirement satisfied completely by declaring every migration irreversible —
green, thorough-looking, and useless at 3am. It is refused here.

The note rule closes the residual: a lossy note must name an object the
migration removes or rewrites, matched as a whole identifier, from a set derived
from the **irreversible statements alone**. A note about an index the migration
ADDED does not satisfy it. Neither does a placeholder, nor a grammatical
sentence about restoring from a snapshot that names nothing.

**A migration index in a note is a CITATION and is checked.** Most lossy notes
say where the previous definition lives — "its previous form is in `0033`" —
and a plausible wrong number sends an operator to a file that does not contain
what they need, at the worst moment. So a four-digit index must resolve to a
migration that exists, be strictly EARLIER than the citing one, and **mention at
least one of the objects the citing migration removes or rewrites**. Eight false
citations were caught by this rule on the first pass of retrofitting the corpus,
including one that pointed forwards.

Two consequences when writing a note:

- To explain what a *later* migration does, name it **by issue** (`#106`) — an
  index reads as "where the previous definition lives" and is refused pointing
  forwards.
- **Do not write `ADR 0004` in a note.** Four digits is the citation shape, so
  an ADR number reads as a migration index and would be checked as one. Name the
  ADR by its issue or its title instead. No note in this corpus names one.

**What it still cannot catch:** a note that names the right object, cites the
right migration, and says something false about *what to do*. The declaration is
checked for consistency with the schema and the corpus, not for truthfulness of
its procedure. Treat a note as a starting point proved to be about the right
objects and the right files, not as a verified runbook.

**A statement form the classifier has no opinion on is a hard failure**, naming
the file and line. That is deliberate: assuming "additive" would silently widen
what `derived` covers, and assuming "lossy" would force a note nobody can write.
Teach `invert()` in `migrationRollback.ts` what the inverse of the new form is,
or that there is none.

---

## 5. Two things deliberately not built

**No down migrations.** drizzle-kit generates none and nothing here writes one.
A `.down.sql` beside every migration is a file that is written once, never
executed, and rots silently — and the first time anybody runs one is during an
incident. The derived inverse is generated from the forward file at the moment
you ask for it, so it cannot drift from what was applied.

**No differ over the snapshot pair.** `meta/<idx>_snapshot.json` records
drizzle-kit's model of the schema, and diffing two of them would produce the
missing `ADD CONSTRAINT` for every `DROP CONSTRAINT` this tool reports as
underivable. It is not used because a snapshot models tables, columns, CHECKs
and indexes and models **no trigger, no function and no backfill**. A differ
over that pair would emit confident SQL for the modelled half and silently omit
the rest — rollback SQL that is wrong in the way you cannot see, run at the
worst possible moment. The same reasoning is why
`migration-handwritten-markers.test.ts` exists.

---

## 6. Adding a migration

1. `bun run build:shared-types`, then `bun run --cwd packages/backend db:generate`.
2. Add exactly one `-- oxy:deploy-phase=pre|post` at column 0.
3. Add exactly one `-- oxy:rollback=...` beneath it, in the header, above the
   first statement. Not inside a `$$ … $$` body: a `--` line there is body text
   and would land in the function's own SQL.
4. `bun run --cwd packages/backend db:rollback-plan <tag>` and read what the
   classifier says the file does. If it disagrees with what you believe you
   wrote, one of you is wrong and it is worth finding out which before the gate
   tells you.
5. Anchor any hand-written trigger, function or backfill in
   `-- oxy:handwritten-begin=<name>` / `-- oxy:handwritten-end=<name>`, which is
   a separate gate with a separate reason: a regeneration drops them.

A rebase behind another branch's migration follows `~/Oxy/AGENTS.md`'s protocol
unchanged. The rollback marker is a comment, so a regeneration drops it exactly
as it drops the hand-written statements — re-add it, and check the census.
