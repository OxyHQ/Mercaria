#!/usr/bin/env bash
# Drive run-ecs-task.sh against a fake `aws` and assert its verdicts: the exit
# code alone decides, the wait is bounded and polled, and the opt-in log print
# pages through CloudWatch without ever changing the verdict.
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
printf '%s\n' "$*" >>"$FAKE_AWS_STATE/calls"
task_arn=arn:aws:ecs:us-west-2:1:task/oxy-cluster/abc123

case "$1 $2" in
  'ecs run-task')
    printf '%s\n' "$task_arn"
    ;;
  'ecs describe-tasks')
    polls_file="$FAKE_AWS_STATE/polls"
    polls=$(( $(cat "$polls_file" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$polls" >"$polls_file"
    status=STOPPED
    if [ "$FAKE_AWS_MODE" = never-stops ] || ((polls < 2)); then status=RUNNING; fi
    case "$FAKE_AWS_MODE" in
      ok | never-stops | logs-fail) container='{"name":"mercaria","exitCode":0}' ;;
      exit-3) container='{"name":"mercaria","exitCode":3}' ;;
      never-ran) container='{"name":"mercaria"}' ;;
    esac
    jq -nc --arg status "$status" --argjson container "$container" \
      '{tasks: [{lastStatus: $status, stoppedReason: "Essential container in task exited", containers: [$container]}]}'
    ;;
  'ecs describe-task-definition')
    printf '%s\n' '{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/mercaria","awslogs-stream-prefix":"ecs"}}'
    ;;
  'logs get-log-events')
    [ "$FAKE_AWS_MODE" = logs-fail ] && exit 254
    if [[ "$*" != *'--log-stream-name ecs/mercaria/abc123'* ]]; then
      echo "unexpected stream: $*" >&2
      exit 2
    fi
    case "$*" in
      *'--next-token f2'*) echo '{"events":[],"nextForwardToken":"f2"}' ;;
      *'--next-token f1'*) echo '{"events":[{"message":"page two"}],"nextForwardToken":"f2"}' ;;
      *) echo '{"events":[{"message":"page one"}],"nextForwardToken":"f1"}' ;;
    esac
    ;;
  *)
    echo "Unexpected fake aws invocation: $*" >&2
    exit 2
    ;;
esac
FAKE_AWS
chmod +x "$test_directory/bin/aws"

failures=0
case_number=0

# run_case <mode> <expected exit> <print log> <timeout> <required output...>
run_case() {
  local mode=$1 expected=$2 print_log=$3 timeout=$4
  shift 4
  case_number=$((case_number + 1))
  local state="$test_directory/state-$case_number"
  mkdir -p "$state"
  local output status=0
  output=$(
    PATH="$test_directory/bin:$PATH" \
      FAKE_AWS_MODE="$mode" FAKE_AWS_STATE="$state" \
      CLUSTER=oxy-cluster TASK_DEFINITION=arn:td/mercaria:9 CONTAINER_NAME=mercaria \
      NETWORK_CONFIGURATION='{"awsvpcConfiguration":{"subnets":["s"]}}' \
      COMMAND_JSON='["bun","x.js"]' TASK_LABEL=fixture STARTED_BY=fixture \
      TASK_TIMEOUT_SECONDS="$timeout" POLL_SECONDS=1 PRINT_TASK_LOG="$print_log" \
      bash "$repository_root/.github/scripts/run-ecs-task.sh" 2>&1
  ) || status=$?
  if [ "$status" != "$expected" ]; then
    echo "FAIL [$mode]: exit $status, expected $expected"
    printf '%s\n' "$output"
    failures=$((failures + 1))
    return
  fi
  local needle
  for needle in "$@"; do
    if [[ "$needle" == '!'* ]]; then
      if grep -qF -- "${needle#!}" <<<"$output$(cat "$state/calls")"; then
        echo "FAIL [$mode]: found '${needle#!}'"
        failures=$((failures + 1))
      fi
    elif ! grep -qF -- "$needle" <<<"$output"; then
      echo "FAIL [$mode]: missing '$needle'"
      printf '%s\n' "$output"
      failures=$((failures + 1))
    fi
  done
  echo "ok [$mode, print=$print_log]"
}

# Polls past RUNNING, prints every page of the log in order, exits 0.
run_case ok 0 true 30 'page one' 'page two' 'fixture completed'
# The log is opt-in: without it, CloudWatch is never asked.
run_case ok 0 '' 30 'fixture completed' '!get-log-events' '!page one'
# A failing container is red AND its output is still shown.
run_case exit-3 1 true 30 'page one' 'failed with exit code 3'
run_case never-ran 1 true 30 'container never ran'
# An unreadable log never changes a green verdict.
run_case logs-fail 0 true 30 'could not read' 'fixture completed'
# The wait is bounded, and the message says the task was NOT stopped.
run_case never-stops 1 '' 2 'STILL RUNNING and was not stopped'

if ((failures > 0)); then
  echo "$failures run-ecs-task assertion(s) failed"
  exit 1
fi
echo "run-ecs-task.sh: all fixture cases passed"
