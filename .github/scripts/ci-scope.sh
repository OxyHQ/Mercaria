#!/usr/bin/env bash
set -euo pipefail

# Which of ci.yml's four `Build *` jobs a pull request has to run.
#
# The org is on GitHub Free: 20 concurrent jobs shared by EVERY repository, so a
# build job that re-exports an app nobody touched is a queue slot another repo's
# CI waits for. `Lint & Test` is NOT scoped by this — it typechecks, lints and
# tests every package on every run. Only the four export/bundle jobs are.
#
# The bias throughout is towards building: any event that is not a pull
# request, an unreadable base, an empty diff and any path the rules below do
# not name all mean "build everything". A filter that skips a build it should
# have run reports green on a break, which costs far more than the minutes it
# saves.
#
# Input:  GITHUB_EVENT_NAME, and CI_SCOPE_BASE / CI_SCOPE_HEAD (revisions) —
#         or, for the self-test, the changed paths one per line on stdin with
#         CI_SCOPE_PATHS_FROM_STDIN=1.
# Output: `api=`, `app=`, `dashboard=`, `pos=` (true|false) on stdout and, in
#         Actions, to $GITHUB_OUTPUT.

targets=(api app dashboard pos)
declare -A want=([api]=false [app]=false [dashboard]=false [pos]=false)

emit() {
  echo "scope: $1"
  for t in "${targets[@]}"; do
    echo "$t=${want[$t]}"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      echo "$t=${want[$t]}" >>"$GITHUB_OUTPUT"
    fi
  done
  exit 0
}

all() {
  for t in "${targets[@]}"; do want[$t]=true; done
  emit "$1"
}

if [[ "${CI_SCOPE_PATHS_FROM_STDIN:-}" == 1 ]]; then
  changed="$(cat)"
else
  if [[ "${GITHUB_EVENT_NAME:-}" != pull_request ]]; then
    all "${GITHUB_EVENT_NAME:-no} event: every build runs"
  fi
  base="${CI_SCOPE_BASE:-}"
  head="${CI_SCOPE_HEAD:-HEAD}"
  if [[ -z "$base" ]] || ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    all "no readable base revision '${base}', so nothing can be ruled out"
  fi
  changed="$(git diff --name-only --no-renames "$base" "$head")"
fi

if [[ -z "$changed" ]]; then
  all 'empty diff'
fi

while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  case "$path" in
    # Every package, and every app, consumes it.
    packages/shared-types/*) all "$path is consumed by every package" ;;
    # `build:backend` bundles the API; the API depends on the SDK. The public
    # API contract is inlined by the API bundle and the SDK, and by no app.
    packages/backend/* | packages/sdk/* | packages/contracts/*) want[api]=true ;;
    # The three Expo apps share the UI kit.
    packages/ui/*) want[app]=true want[dashboard]=true want[pos]=true ;;
    packages/frontend/*) want[app]=true ;;
    packages/dashboard/*) want[dashboard]=true ;;
    packages/pos/*) want[pos]=true ;;
    # Prose outside a package. Nothing any build reads.
    docs/* | *.md) ;;
    # The repository guards and their self-tests. `Lint & Test` runs every one
    # of them on every change; no build imports them (the apps' `build` is a
    # bare `expo export`, the API's is `build.ts`).
    scripts/validate-*.mjs | scripts/test-validate-*.mjs) ;;
    # This workflow and the scope script decide what runs, so they build
    # everything. The rest of .github (deploy workflows, their scripts) is
    # read by no build here.
    .github/workflows/ci.yml | .github/scripts/ci-scope.sh | .github/scripts/test-ci-scope.sh)
      all "$path decides what CI runs"
      ;;
    .github/*) ;;
    # The API's container build; the `Build API` job bundles the same source.
    Dockerfile) want[api]=true ;;
    # The lockfile, the root manifest, bunfig, tsconfig, root scripts, app.json,
    # biome.jsonc, the Expo eslint config, .github (this script and ci.yml included), and every
    # path not named above: assume it reaches every build until someone proves
    # otherwise right here.
    *) all "$path is not scoped to one package" ;;
  esac
done <<<"$changed"

emit 'pull request touches only the packages marked true'
