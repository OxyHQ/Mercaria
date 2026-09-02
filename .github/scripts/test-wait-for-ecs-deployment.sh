#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* && -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

mkdir -p "$test_directory/bin"
cat >"$test_directory/bin/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" != "ecs describe-services --cluster oxy-cluster --services mercaria --output json" ]]; then
  echo "Unexpected fake aws invocation: $*" >&2
  exit 2
fi

count_file="$FAKE_AWS_STATE/calls"
count=0
if [[ -f "$count_file" ]]; then
  count="$(<"$count_file")"
fi
count=$((count + 1))
printf '%s' "$count" >"$count_file"

status=PRIMARY
rollout_state=IN_PROGRESS
reason='Deployment in progress.'
desired=2
running=2
pending=0

case "$FAKE_AWS_MODE" in
  eventual)
    if ((count >= 3)); then
      rollout_state=COMPLETED
      reason='Deployment completed.'
    fi
    ;;
  failed)
    rollout_state=FAILED
    reason='Deployment circuit breaker was triggered.'
    ;;
  superseded)
    status=ACTIVE
    ;;
  timeout) ;;
  zero)
    rollout_state=COMPLETED
    desired=0
    running=0
    ;;
  running-mismatch)
    rollout_state=COMPLETED
    running=1
    pending=1
    ;;
  *)
    echo "Unexpected fake aws mode: $FAKE_AWS_MODE" >&2
    exit 2
    ;;
esac

jq -nc \
  --arg status "$status" \
  --arg rollout_state "$rollout_state" \
  --arg reason "$reason" \
  --argjson desired "$desired" \
  --argjson running "$running" \
  --argjson pending "$pending" \
  '{services: [{deployments: [{
    id: "ecs-svc/candidate",
    status: $status,
    rolloutState: $rollout_state,
    rolloutStateReason: $reason,
    desiredCount: $desired,
    runningCount: $running,
    pendingCount: $pending
  }]}]}'
FAKE_AWS
chmod +x "$test_directory/bin/aws"

run_waiter() {
  local mode="$1"
  local state_directory="$test_directory/$mode-state"
  mkdir -p "$state_directory"
  env \
    PATH="$test_directory/bin:$PATH" \
    FAKE_AWS_MODE="$mode" \
    FAKE_AWS_STATE="$state_directory" \
    ECS_ROLLOUT_MAX_ATTEMPTS=3 \
    ECS_ROLLOUT_POLL_INTERVAL_SECONDS=0 \
    bash "$repository_root/.github/scripts/wait-for-ecs-deployment.sh" \
      oxy-cluster mercaria ecs-svc/candidate
}

run_waiter eventual >"$test_directory/eventual.log"
grep -F 'completed with 2/2 tasks running' "$test_directory/eventual.log" >/dev/null
if [[ "$(<"$test_directory/eventual-state/calls")" != "3" ]]; then
  echo "The waiter did not observe the complete eventual-state sequence." >&2
  exit 1
fi

for failure_mode in failed superseded timeout zero running-mismatch; do
  if run_waiter "$failure_mode" >"$test_directory/$failure_mode.log" 2>&1; then
    echo "The waiter accepted invalid ECS state: $failure_mode" >&2
    exit 1
  fi
done

echo "ECS deployment waiter fixture tests passed."
