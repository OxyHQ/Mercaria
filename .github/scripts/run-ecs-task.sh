#!/usr/bin/env bash
# Run one command as an ECS task and fail unless the named container exits 0.
#
# Optional environment:
#   TASK_TIMEOUT_SECONDS  how long to wait for the task to stop (default 600,
#                         the 100 x 6 s that `aws ecs wait tasks-stopped` gave
#                         the deploy's one-shots). A task still running at the
#                         deadline is a red step that names the task — it is
#                         NOT stopped, and the message says so.
#   APP (or SERVICE)      the ECS service whose capacity the task runs on: its
#                         capacity provider strategy when it has one (oxy-cluster's
#                         EC2 capacity, whose revisions are EC2-only), otherwise
#                         its launch type. Without it the task runs on FARGATE.
#   PRINT_TASK_LOG        `true` prints the container's CloudWatch stream after
#                         the task stops. Opt-in: this repository is public, so
#                         only a caller whose command prints nothing sensitive
#                         may turn it on. Retrieval is best-effort and never
#                         changes the verdict, which is the exit code alone.
set -euo pipefail

: "${CLUSTER:?CLUSTER is required}"
: "${TASK_DEFINITION:?TASK_DEFINITION is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${NETWORK_CONFIGURATION:?NETWORK_CONFIGURATION is required}"
: "${COMMAND_JSON:?COMMAND_JSON is required}"
: "${TASK_LABEL:?TASK_LABEL is required}"
: "${STARTED_BY:?STARTED_BY is required}"
TASK_TIMEOUT_SECONDS="${TASK_TIMEOUT_SECONDS:-600}"
POLL_SECONDS="${POLL_SECONDS:-6}"

if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "string")' \
  <<<"$COMMAND_JSON" >/dev/null; then
  echo "::error::$TASK_LABEL command must be a non-empty JSON array of strings"
  exit 1
fi
if [[ ! "$TASK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::TASK_TIMEOUT_SECONDS must be a positive integer"
  exit 1
fi

OVERRIDES=$(jq -nc \
  --arg name "$CONTAINER_NAME" \
  --argjson command "$COMMAND_JSON" \
  '{containerOverrides: [{name: $name, command: $command}]}')

# Where the service runs. A hard-coded FARGATE refuses the EC2-only revision of
# a service on the EC2 capacity and fails the deploy before the rollout.
SERVICE_NAME="${SERVICE:-${APP:-}}"
PLACEMENT=(--launch-type FARGATE)
PLACEMENT_LABEL="launch type FARGATE"
if [[ -n "$SERVICE_NAME" ]]; then
  SERVICE_JSON=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE_NAME" \
    --query 'services[0]' --output json)
  STRATEGY=$(jq -c '.capacityProviderStrategy // []' <<<"$SERVICE_JSON")
  if [[ "$STRATEGY" != "[]" ]]; then
    PLACEMENT=(--capacity-provider-strategy "$STRATEGY")
    PLACEMENT_LABEL="capacity provider strategy $STRATEGY"
  else
    LAUNCH_TYPE=$(jq -r '.launchType // "FARGATE"' <<<"$SERVICE_JSON")
    PLACEMENT=(--launch-type "$LAUNCH_TYPE")
    PLACEMENT_LABEL="launch type $LAUNCH_TYPE"
  fi
fi

echo "running $TASK_LABEL on $CLUSTER using $TASK_DEFINITION ($PLACEMENT_LABEL)"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION" \
  "${PLACEMENT[@]}" \
  --count 1 \
  --network-configuration "$NETWORK_CONFIGURATION" \
  --overrides "$OVERRIDES" \
  --started-by "$STARTED_BY" \
  --query 'tasks[0].taskArn' --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "::error::$TASK_LABEL was not accepted by ECS"
  exit 1
fi
echo "task: $TASK_ARN"

# Polled rather than `aws ecs wait tasks-stopped`, whose fixed ten minutes is
# shorter than a backfill batch may need. A failed query still fails the step
# under `set -e`, as the waiter did.
deadline=$((SECONDS + TASK_TIMEOUT_SECONDS))
while :; do
  TASK=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --output json)
  [ "$(jq -r '.tasks[0].lastStatus // "UNKNOWN"' <<<"$TASK")" = STOPPED ] && break
  if ((SECONDS >= deadline)); then
    echo "::error::$TASK_LABEL did not stop within ${TASK_TIMEOUT_SECONDS}s; task $TASK_ARN is STILL RUNNING and was not stopped"
    exit 1
  fi
  sleep "$POLL_SECONDS"
done

if [ "${PRINT_TASK_LOG:-}" = true ]; then
  # The stream an awslogs driver writes: <prefix>/<container>/<task id>.
  LOG_OPTIONS=$(aws ecs describe-task-definition --task-definition "$TASK_DEFINITION" \
    --query "taskDefinition.containerDefinitions[?name=='$CONTAINER_NAME'] | [0].logConfiguration" \
    --output json 2>/dev/null || echo null)
  LOG_GROUP=$(jq -r 'select(.logDriver == "awslogs") | .options["awslogs-group"] // empty' \
    <<<"$LOG_OPTIONS" 2>/dev/null || true)
  LOG_PREFIX=$(jq -r 'select(.logDriver == "awslogs") | .options["awslogs-stream-prefix"] // empty' \
    <<<"$LOG_OPTIONS" 2>/dev/null || true)
  echo "──────── $TASK_LABEL output ────────"
  if [ -n "$LOG_GROUP" ] && [ -n "$LOG_PREFIX" ]; then
    LOG_STREAM="$LOG_PREFIX/$CONTAINER_NAME/${TASK_ARN##*/}"
    token=
    while :; do
      if ! page=$(aws logs get-log-events --log-group-name "$LOG_GROUP" \
        --log-stream-name "$LOG_STREAM" --start-from-head \
        ${token:+--next-token "$token"} --output json 2>/dev/null); then
        echo "(could not read $LOG_GROUP/$LOG_STREAM)"
        break
      fi
      jq -r '.events[].message' <<<"$page"
      next=$(jq -r '.nextForwardToken // empty' <<<"$page")
      # CloudWatch signals the end by returning the token it was given.
      [ -z "$next" ] || [ "$next" = "$token" ] && break
      token=$next
    done
  else
    echo "(the container does not log through awslogs; nothing to print)"
  fi
  echo "──────── end of $TASK_LABEL output ────────"
fi

EXIT_CODE=$(jq -r --arg name "$CONTAINER_NAME" \
  '.tasks[0].containers[] | select(.name == $name) | .exitCode // "None"' <<<"$TASK")
STOP_REASON=$(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$TASK")

if [ "$EXIT_CODE" = "None" ] || [ -z "$EXIT_CODE" ]; then
  echo "::error::$TASK_LABEL container never ran (stoppedReason: $STOP_REASON)"
  exit 1
fi
if [ "$EXIT_CODE" != "0" ]; then
  echo "::error::$TASK_LABEL failed with exit code $EXIT_CODE (stoppedReason: $STOP_REASON)"
  exit 1
fi

echo "$TASK_LABEL completed"
