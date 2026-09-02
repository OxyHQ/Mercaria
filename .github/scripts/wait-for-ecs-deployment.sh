#!/usr/bin/env bash

set -euo pipefail

if (($# != 3)); then
  echo "usage: $0 <cluster> <service> <deployment-id>" >&2
  exit 2
fi

cluster="$1"
service="$2"
deployment_id="$3"
max_attempts="${ECS_ROLLOUT_MAX_ATTEMPTS:-90}"
poll_interval="${ECS_ROLLOUT_POLL_INTERVAL_SECONDS:-10}"

if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::ECS_ROLLOUT_MAX_ATTEMPTS must be a positive integer."
  exit 2
fi
if [[ ! "$poll_interval" =~ ^[0-9]+$ ]]; then
  echo "::error::ECS_ROLLOUT_POLL_INTERVAL_SECONDS must be a non-negative integer."
  exit 2
fi

last_deployment=""
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  service_json="$(aws ecs describe-services \
    --cluster "$cluster" \
    --services "$service" \
    --output json)"

  if [[ "$(jq -r '.services | length' <<<"$service_json")" != "1" ]]; then
    echo "::error::ECS did not return exactly one service for $service."
    exit 1
  fi

  last_deployment="$(jq -c --arg id "$deployment_id" \
    '[.services[0].deployments[] | select(.id == $id)] | first // empty' \
    <<<"$service_json")"
  if [[ -z "$last_deployment" ]]; then
    echo "Waiting for ECS deployment $deployment_id to become visible ($attempt/$max_attempts)."
  else
    status="$(jq -r '.status // "UNKNOWN"' <<<"$last_deployment")"
    rollout_state="$(jq -r '.rolloutState // "UNKNOWN"' <<<"$last_deployment")"
    running="$(jq -r '.runningCount // 0' <<<"$last_deployment")"
    desired="$(jq -r '.desiredCount // 0' <<<"$last_deployment")"
    pending="$(jq -r '.pendingCount // 0' <<<"$last_deployment")"

    if [[ "$status" != "PRIMARY" ]]; then
      echo "::error::ECS deployment $deployment_id was superseded with status $status."
      exit 1
    fi
    if [[ "$rollout_state" == "FAILED" ]]; then
      reason="$(jq -r '.rolloutStateReason // "No rollout reason reported."' <<<"$last_deployment")"
      echo "::error::ECS deployment $deployment_id failed: $reason"
      exit 1
    fi
    if [[ "$rollout_state" == "COMPLETED" && "$desired" -ge 1 &&
          "$running" -eq "$desired" && "$pending" -eq 0 ]]; then
      echo "ECS deployment $deployment_id completed with $running/$desired tasks running."
      exit 0
    fi

    echo "Waiting for ECS deployment $deployment_id: state=$rollout_state running=$running desired=$desired pending=$pending ($attempt/$max_attempts)."
  fi

  if ((attempt < max_attempts)); then
    sleep "$poll_interval"
  fi
done

echo "::error::Timed out waiting for ECS deployment $deployment_id to complete."
if [[ -n "$last_deployment" ]]; then
  jq . <<<"$last_deployment" >&2
fi
exit 1
