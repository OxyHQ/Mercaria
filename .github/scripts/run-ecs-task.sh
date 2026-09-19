#!/usr/bin/env bash
# Run one command as an ECS task and fail unless the named container exits 0.
set -euo pipefail

: "${CLUSTER:?CLUSTER is required}"
: "${TASK_DEFINITION:?TASK_DEFINITION is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${NETWORK_CONFIGURATION:?NETWORK_CONFIGURATION is required}"
: "${COMMAND_JSON:?COMMAND_JSON is required}"
: "${TASK_LABEL:?TASK_LABEL is required}"
: "${STARTED_BY:?STARTED_BY is required}"

if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "string")' \
  <<<"$COMMAND_JSON" >/dev/null; then
  echo "::error::$TASK_LABEL command must be a non-empty JSON array of strings"
  exit 1
fi

OVERRIDES=$(jq -nc \
  --arg name "$CONTAINER_NAME" \
  --argjson command "$COMMAND_JSON" \
  '{containerOverrides: [{name: $name, command: $command}]}')

echo "running $TASK_LABEL on $CLUSTER using $TASK_DEFINITION"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION" \
  --launch-type FARGATE \
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

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

TASK=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --output json)
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
