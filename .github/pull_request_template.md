## Summary

<!-- What changed and why? Link relevant issues with "Closes #123" ONLY when
     this PR actually finishes that issue. GitHub's parser matches the keyword
     text (close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved)
     immediately before "#N" REGARDLESS of grammar or negation — "does not
     close #123" and "fails closed: #123" both auto-close #123 on merge, and
     this scan also reads every COMMIT MESSAGE in the merge (a squash merge
     concatenates all of them), not just this body. It has happened at least
     twice in this repo — once via a PR body (#69), once via a phrase inside a
     squashed commit message (#67), silently, with nothing in that PR
     implementing the issue it closed. To reference an issue without closing
     it, write "issue #123", "(#123)" or "deferred to #123" — never a closing
     verb adjacent to its number, in the body OR in any commit message. -->

## Changes

<!-- Bullet list of notable changes. -->

-

## Testing

<!-- How was this tested? (manual steps, new tests, existing test suite, etc.) -->

## Checklist

- [ ] TypeScript compiles (`tsc --noEmit`)
- [ ] Tests pass (`bun run --filter @mercaria/backend test`)
- [ ] Lint passes
- [ ] `bun.lock` committed in the same commit as any `package.json` change
