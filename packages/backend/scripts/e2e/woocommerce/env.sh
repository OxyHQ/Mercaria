#!/usr/bin/env bash
# Shared configuration for the disposable WooCommerce e2e stack (#69).
#
# Sourced by up.sh / seed.sh / verify.sh / issue-key.sh / down.sh. It holds NO
# secret: every credential is generated on first `up` into $STATE_DIR, which
# lives OUTSIDE this repository so that a stray `git add -A` cannot sweep it in.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Compose project name. Must not collide with another agent's stack.
COMPOSE_PROJECT="${MERCARIA_WOO_E2E_PROJECT:-mercaria-woo-e2e}"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

# Host port the WordPress container is published on (loopback only — the public
# entrance is the cloudflared tunnel, never this port).
WP_HOST_PORT="${MERCARIA_WOO_E2E_PORT:-8087}"

# Runtime state: generated passwords, the current tunnel hostname, the tunnel
# pid and its log. Deliberately outside the repo and outside the shared /tmp
# scratchpad (which other agents write to).
STATE_DIR="${MERCARIA_WOO_E2E_STATE_DIR:-$HOME/.local/state/mercaria-woo-e2e}"
STACK_ENV="$STATE_DIR/stack.env"
TUNNEL_LOG="$STATE_DIR/cloudflared.log"
TUNNEL_PID="$STATE_DIR/cloudflared.pid"

# Where the REST credentials are handed to whoever drives the connector.
TOKEN_FILE="${MERCARIA_WOO_E2E_TOKEN_FILE:-$HOME/.config/oxy/tokens/mercaria-woo-e2e.json}"

# WordPress admin account created by seed.sh.
WP_ADMIN_USER="mercaria_e2e"
WP_ADMIN_EMAIL="e2e@mercaria.invalid"

# The store currency. Deliberately NOT USD and NOT FAIR, so that "the connector
# preserves the platform's native currency" is an observable rather than a
# coincidence (runbook W6 / S10).
WP_STORE_CURRENCY="EUR"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Generate the throwaway credentials once, on first use.
if [[ ! -f "$STACK_ENV" ]]; then
  umask 077
  {
    echo "MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)"
    echo "MYSQL_PASSWORD=$(openssl rand -hex 24)"
    echo "WP_ADMIN_PASSWORD=$(openssl rand -hex 24)"
    echo "WP_PUBLIC_URL="
  } >"$STACK_ENV"
  chmod 600 "$STACK_ENV"
fi

# Values the compose file interpolates.
export WP_HOST_PORT
export COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT"

# Read the current public URL (empty until up.sh has opened a tunnel).
WP_PUBLIC_URL="$(grep -E '^WP_PUBLIC_URL=' "$STACK_ENV" | cut -d= -f2-)"

# Every probe of the public site goes DIRECT, never through an HTTP proxy.
#
# `safeFetch` — which is what the connector dispatches through — resolves the
# host itself and pins the connection to the validated IP. It reads no
# `HTTPS_PROXY`. So a probe that honoured a proxy would be exercising a path the
# connector never takes, and could report a healthy site the backend cannot
# reach (or the reverse).
CURL_DIRECT=(curl --noproxy '*')

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$STACK_ENV" "$@"
}

# Run a WP-CLI command inside the stack, against the shared WordPress volume.
wp_cli() {
  compose run --rm -T wpcli "$@"
}

# Rewrite one key in the state env file, in place.
set_state() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^${key}=" "$STACK_ENV" >"$tmp" || true
  echo "${key}=${value}" >>"$tmp"
  install -m 600 "$tmp" "$STACK_ENV"
  rm -f "$tmp"
}
