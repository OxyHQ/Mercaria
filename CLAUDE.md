@AGENTS.md

## Claude Code

- Enter plan mode before changes that touch money, migrations, auth middleware or the `/public/v1` contracts;
  read the matching file in `docs/agent-rules/` first and cite it in the plan.
- Work in a git worktree under `.worktrees/`, not the primary checkout; other agents edit this repo too.
- Delegate wide read-only searches (for example "every caller of `oxyClient`") to a subagent; keep edits in the main session.
- Run `bun run validate:agents-md` after editing any `AGENTS.md` or `CLAUDE.md`.
