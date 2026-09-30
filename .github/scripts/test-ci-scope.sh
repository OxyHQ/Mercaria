#!/usr/bin/env bash
set -euo pipefail

# Self-test for ci-scope.sh. Every case is "these changed paths -> this set of
# builds", including the ones that must widen to everything: a filter that
# narrows too far reports green on a break and nothing else would notice.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/ci-scope.sh"
failures=0

check() {
  local expected="$1"
  shift
  local actual
  actual="$(printf '%s\n' "$@" | GITHUB_OUTPUT='' CI_SCOPE_PATHS_FROM_STDIN=1 bash "$script" |
    awk -F= '/=(true|false)$/ && $2 == "true" { printf "%s ", $1 }' | sed 's/ $//')"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: [$*] -> '$actual', expected '$expected'"
    failures=$((failures + 1))
  else
    echo "ok:   [$*] -> '${actual:-none}'"
  fi
}

check 'api' packages/backend/src/index.ts
check 'api' packages/sdk/src/client.ts
check 'app' packages/frontend/app/index.tsx
check 'dashboard' packages/dashboard/app/_layout.tsx
check 'pos' packages/pos/app/index.tsx
check 'app dashboard pos' packages/ui/src/Button.tsx
check 'api pos' packages/backend/src/a.ts packages/pos/b.tsx
check 'api app dashboard pos' packages/shared-types/src/index.ts
check '' docs/deploy.md README.md
check 'app' docs/deploy.md packages/frontend/README.md
# Shared inputs widen to every build.
check 'api app dashboard pos' bun.lock
check 'api app dashboard pos' package.json
check 'api app dashboard pos' bunfig.toml
check 'api app dashboard pos' scripts/generate-router-types.mjs
check 'api app dashboard pos' app.json
check 'api app dashboard pos' .github/workflows/ci.yml
check 'api app dashboard pos' .github/scripts/ci-scope.sh
check 'api' Dockerfile
check '' scripts/validate-i18n-strings.mjs scripts/test-validate-i18n-strings.mjs
check 'api app dashboard pos' scripts/validate-lint-coverage.mjs scripts/edge-activity.test.ts
check '' .github/workflows/deploy-aws.yml .github/scripts/run-migration-task.sh
check 'api app dashboard pos' .github/scripts/test-ci-scope.sh
check 'api app dashboard pos' packages/frontend/x.ts some-new-root-file.json
# An empty diff can rule nothing out.
check 'api app dashboard pos' ''

# Outside a pull request every build runs, whatever changed.
for event in push workflow_dispatch ''; do
  out="$(GITHUB_OUTPUT='' GITHUB_EVENT_NAME="$event" CI_SCOPE_BASE=HEAD CI_SCOPE_HEAD=HEAD bash "$script")"
  if [[ "$(grep -c '=true$' <<<"$out")" != 4 ]]; then
    echo "FAIL: event '$event' did not build everything"
    failures=$((failures + 1))
  else
    echo "ok:   event '${event:-none}' -> every build"
  fi
done

# A pull request whose base cannot be read builds everything.
out="$(GITHUB_OUTPUT='' GITHUB_EVENT_NAME=pull_request CI_SCOPE_BASE=0000000000000000000000000000000000000000 bash "$script")"
if [[ "$(grep -c '=true$' <<<"$out")" != 4 ]]; then
  echo 'FAIL: unreadable base did not build everything'
  failures=$((failures + 1))
else
  echo 'ok:   unreadable base -> every build'
fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures ci-scope case(s) failed"
  exit 1
fi
echo 'ci-scope: all cases pass'
