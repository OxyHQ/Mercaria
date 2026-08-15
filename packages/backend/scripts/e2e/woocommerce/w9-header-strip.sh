#!/usr/bin/env bash
# Runbook scenario W9 — a site that strips `X-WP-TotalPages`.
#
#   ./w9-header-strip.sh status   # what mode is the site in right now
#   ./w9-header-strip.sh on       # start stripping   (explicit, never a default)
#   ./w9-header-strip.sh off      # stop stripping
#
# W9 asks what a backfill does when the header the enumeration proof rests on
# simply is not there. #259 made Mercaria page on until an EMPTY page instead of
# trusting a missing header; the failure it replaced archived every listing past
# page 1. So the observation that matters is not "did it import" — it is
# **NOTHING WAS ARCHIVED**.
#
# Every transition is VERIFIED over real HTTPS afterwards, and this script exits
# non-zero if the header did not actually change. A `wp option update` that
# reported success while the header kept being sent is precisely the silent
# failure that would make W9 measure an unstripped site and report a pass.
#
# It also asserts a POSITIVE CONTROL on the same request: `X-WP-Total` must
# still be present. If both headers vanish, something other than this mechanism
# is eating headers and the run tells you nothing about W9.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

fail() {
  echo "w9-header-strip.sh: $*" >&2
  exit 1
}

[[ -n "$WP_PUBLIC_URL" ]] || fail 'no public URL recorded — run up.sh first'
[[ -f "$TOKEN_FILE" ]] || fail "no credential at $TOKEN_FILE — run issue-key.sh first"
command -v jq >/dev/null || fail 'jq is not on PATH'

ACTION="${1:-status}"
case "$ACTION" in
  on | off | status) ;;
  *) fail "unknown action '${ACTION}' (expected on, off or status)" ;;
esac

CK="$(jq -r '.consumerKey' "$TOKEN_FILE")"
CS="$(jq -r '.consumerSecret' "$TOKEN_FILE")"
REST="${WP_PUBLIC_URL}/wp-json"

# Fetch one wc/v3 page and report the three headers that matter.
probe() {
  local headers
  headers="$(mktemp)"
  "${CURL_DIRECT[@]}" -sS -o /dev/null -D "$headers" --max-time 60 \
    -u "${CK}:${CS}" "${REST}/wc/v3/products?per_page=1"
  PROBE_TOTALPAGES="$(grep -i '^x-wp-totalpages:' "$headers" | tr -d '\r' | awk '{print $2}' | head -1 || true)"
  PROBE_TOTAL="$(grep -i '^x-wp-total:' "$headers" | tr -d '\r' | awk '{print $2}' | head -1 || true)"
  PROBE_MARKER="$(grep -i '^x-mercaria-e2e-header-strip:' "$headers" | tr -d '\r' | awk '{print $2}' | head -1 || true)"
  rm -f "$headers"
}

# Ensure the must-use plugin exists in the volume. Idempotent: the file is
# copied from the repo every time, so an edit here reaches the site.
install_mu_plugin() {
  local container
  container="$(compose ps -q wordpress)"
  [[ -n "$container" ]] || fail 'the wordpress container is not running — run up.sh'
  docker exec "$container" mkdir -p /var/www/html/wp-content/mu-plugins
  docker cp "$SCRIPT_DIR/php/mu-w9-header-strip.php" \
    "${container}:/var/www/html/wp-content/mu-plugins/mercaria-e2e-header-strip.php"
  docker exec "$container" chown www-data:www-data \
    /var/www/html/wp-content/mu-plugins/mercaria-e2e-header-strip.php
}

install_mu_plugin
probe

if [[ -z "$PROBE_MARKER" ]]; then
  fail "$(
    printf '%s\n' \
      "the marker header is absent, so the must-use plugin is not loading." \
      "That is a different state from 'installed and off', and it means a W9" \
      "run would prove nothing. Check wp-content/mu-plugins/."
  )"
fi

if [[ "$ACTION" == 'status' ]]; then
  echo "mode                    : ${PROBE_MARKER}"
  echo "X-WP-TotalPages         : ${PROBE_TOTALPAGES:-(absent)}"
  echo "X-WP-Total              : ${PROBE_TOTAL:-(absent)}"
  echo "site                    : ${WP_PUBLIC_URL}"
  exit 0
fi

want="$([[ "$ACTION" == 'on' ]] && echo '1' || echo '0')"
wp_cli option update mercaria_e2e_strip_totalpages "$want" >/dev/null
probe

# --- verify the transition actually happened on the wire -------------------
if [[ "$ACTION" == 'on' ]]; then
  [[ "$PROBE_MARKER" == 'on' ]] || fail "the option was written but the site still reports mode '${PROBE_MARKER}'"
  [[ -z "$PROBE_TOTALPAGES" ]] || fail "X-WP-TotalPages is STILL being sent (${PROBE_TOTALPAGES}) — W9 would measure an unstripped site"
  [[ -n "$PROBE_TOTAL" ]] || fail "$(
    printf '%s\n' \
      "X-WP-Total vanished too. This mechanism strips only X-WP-TotalPages, so" \
      "something ELSE is removing headers and a W9 run would not be attributable."
  )"
  echo "STRIPPING IS ON."
  echo "  X-WP-TotalPages : absent"
  echo "  X-WP-Total      : ${PROBE_TOTAL}  (independent oracle, deliberately kept)"
  echo
  echo "  Tell whoever drives the backfill WHICH run this is. The observation that"
  echo "  matters is that NOTHING WAS ARCHIVED — that is the #259 failure."
  echo "  Turn it off again with: ./w9-header-strip.sh off"
else
  [[ "$PROBE_MARKER" == 'off' ]] || fail "the option was written but the site still reports mode '${PROBE_MARKER}'"
  [[ -n "$PROBE_TOTALPAGES" ]] || fail "X-WP-TotalPages did NOT come back — the site is still stripping it from somewhere else"
  echo "STRIPPING IS OFF (normal mode)."
  echo "  X-WP-TotalPages : ${PROBE_TOTALPAGES}"
  echo "  X-WP-Total      : ${PROBE_TOTAL}"
fi
