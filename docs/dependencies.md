# Dependency health

Mercaria uses `@oxy.so/doctor` as a read-only consistency check for packages in
the Oxy ecosystem. Run it from the repository root after changing an Oxy
dependency:

```bash
bun run doctor:oxy
```

CI runs the same command with `--ci` immediately after `bun install
--frozen-lockfile`. A failure means the manifest or lockfile is using an old
scope, an unsupported version, or inconsistent Oxy package resolutions. Fix the
declared dependency and regenerate `bun.lock` with Bun; do not edit installed
packages or add compatibility aliases.

Dependabot checks GitHub Actions weekly. It deliberately does not update npm
dependencies: this repository uses Bun and commits `bun.lock`, so JavaScript
dependency changes are made and verified with Bun together with their manifest
changes. The doctor reports Oxy ecosystem drift without mutating the working
tree or silently upgrading an application.
