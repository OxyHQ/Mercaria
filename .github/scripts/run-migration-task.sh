#!/usr/bin/env bash
#
# Run ONE migration phase as a one-shot ECS task and fail if it did not succeed.
#
# Usage: run-migration-task.sh <pre|post>
#
# In a script rather than inline YAML because the interesting part is the exit
# handling, and that is the part a reviewer must be able to read: an ECS task
# that fails is not an error from the AWS CLI's point of view — `run-task`
# returns 0 as soon as the task is ACCEPTED. A workflow that only checked the
# CLI's exit code would report a green deploy for a migration that threw, which
# is precisely the failure the phase split exists to prevent.
#
# Environment (set by the workflow):
#   CLUSTER, APP, PG_DATABASE     from the workflow's `env:` block
#   TASK_DEFINITION               the service's live task definition ARN
#   CONTAINER_NAME                the container to override within it
#   NETWORK_CONFIGURATION         the service's awsvpc config, as compact JSON
set -euo pipefail

PHASE="${1:?usage: run-migration-task.sh <pre|post>}"
case "$PHASE" in
  pre | post) ;;
  *)
    echo "::error::unknown migration phase '$PHASE' (expected pre or post)"
    exit 1
    ;;
esac

: "${CLUSTER:?CLUSTER is required}"
: "${APP:?APP is required}"
: "${PG_DATABASE:?PG_DATABASE is required}"
: "${TASK_DEFINITION:?TASK_DEFINITION is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${NETWORK_CONFIGURATION:?NETWORK_CONFIGURATION is required}"

# `--target-database` is the migrator's own guard: it refuses to run unless this
# name matches the database DATABASE_URL resolves to, so a task pointed at the
# wrong database fails instead of migrating it.
OVERRIDES=$(jq -nc \
  --arg name "$CONTAINER_NAME" \
  --arg db "$PG_DATABASE" \
  --arg phase "$PHASE" \
  '{containerOverrides: [{name: $name, command: [
      "node", "packages/backend/dist/db/migrate.js",
      ("--target-database=" + $db),
      ("--phase=" + $phase)
  ]}]}')

echo "running $PHASE migration task on $CLUSTER using $TASK_DEFINITION"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION" \
  --launch-type FARGATE \
  --count 1 \
  --network-configuration "$NETWORK_CONFIGURATION" \
  --overrides "$OVERRIDES" \
  --started-by "deploy-$PHASE-migration" \
  --query 'tasks[0].taskArn' --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "::error::the $PHASE migration task was not accepted by ECS"
  exit 1
fi
echo "task: $TASK_ARN"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

# Read the exit code of the container we overrode BY NAME. Indexing [0] would
# silently read a sidecar's status if one is ever added to the task definition.
EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='$CONTAINER_NAME'].exitCode | [0]" --output text)
STOP_REASON=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)

# A container that never started has NO exit code — `None`, not 0. Treating that
# as success is the single easiest way to ship an unmigrated database, so it is
# handled before the numeric comparison rather than falling into it.
if [ "$EXIT_CODE" = "None" ] || [ -z "$EXIT_CODE" ]; then
  echo "::error::the $PHASE migration container never ran (stoppedReason: $STOP_REASON)"
  exit 1
fi

if [ "$EXIT_CODE" != "0" ]; then
  echo "::error::the $PHASE migration failed with exit code $EXIT_CODE (stoppedReason: $STOP_REASON)"
  exit 1
fi

echo "$PHASE migration completed"
