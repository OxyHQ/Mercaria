#!/usr/bin/env bash
#
# Run ONE migration phase as a one-shot ECS task and fail if it did not succeed.
#
# Usage: run-migration-task.sh <pre|post|all>
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
#   TASK_DEFINITION               the new immutable task definition ARN
#   CONTAINER_NAME                the container to override within it
#   NETWORK_CONFIGURATION         the service's awsvpc config, as compact JSON
set -euo pipefail

# The three values `@oxyhq/db` accepts as a `run` (its MIGRATION_RUNS). `all` is
# the cutover escape hatch, not a normal release: it applies destructive
# migrations while the previous image is still serving, which is only safe when
# there is no previous image serving this schema.
PHASE="${1:?usage: run-migration-task.sh <pre|post|all>}"
case "$PHASE" in
  pre | post | all) ;;
  *)
    echo "::error::unknown migration phase '$PHASE' (expected pre, post or all)"
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
COMMAND_JSON=$(jq -nc \
  --arg db "$PG_DATABASE" \
  --arg phase "$PHASE" \
  '[
      "node", "packages/backend/dist/db/migrate.js",
      ("--target-database=" + $db),
      ("--phase=" + $phase)
  ]')

export COMMAND_JSON
export TASK_LABEL="$PHASE migration"
export STARTED_BY="deploy-$PHASE-migration"
exec "$(dirname "$0")/run-ecs-task.sh"
