#!/usr/bin/env bash
# Bring the disposable WooCommerce stack up and expose it on public HTTPS.
#
#   1. start MariaDB + WordPress (loopback only)
#   2. open a cloudflared QUICK TUNNEL and wait for its hostname
#   3. push that hostname into the container as WP_PUBLIC_URL (→ WP_HOME /
#      WP_SITEURL) and, if WordPress is already installed, into the database
#      options too, so the two can never disagree
#   4. print the public URL
#
# A quick tunnel's hostname is RANDOM and changes on every restart. Nothing here
# — or in any sibling script — may hardcode one: every consumer reads it back
# from $STATE_DIR/stack.env or from the token file that issue-key.sh writes.
#
# Re-runnable: an already-running stack and a still-live tunnel are reused.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

fail() {
  echo "up.sh: $*" >&2
  exit 1
}

# --- preflight -------------------------------------------------------------
command -v docker >/dev/null || fail 'docker is not on PATH'
docker compose version >/dev/null 2>&1 || fail 'docker compose (v2) is not available'
command -v cloudflared >/dev/null || fail 'cloudflared is not on PATH'
command -v curl >/dev/null || fail 'curl is not on PATH'
command -v openssl >/dev/null || fail 'openssl is not on PATH'

# --- 1. the containers -----------------------------------------------------
echo "==> starting the stack (project ${COMPOSE_PROJECT}, port ${WP_HOST_PORT})"
compose up -d db wordpress

echo "==> waiting for WordPress on http://127.0.0.1:${WP_HOST_PORT}"
deadline=$((SECONDS + 180))
until curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WP_HOST_PORT}/" 2>/dev/null | grep -qE '^(200|30[128]|40[0-4])$'; do
  ((SECONDS < deadline)) || fail "WordPress did not answer on port ${WP_HOST_PORT} within 180s"
  sleep 2
done
echo "    WordPress is answering locally"

# --- 2. the tunnel ---------------------------------------------------------
tunnel_alive() {
  [[ -f "$TUNNEL_PID" ]] && kill -0 "$(cat "$TUNNEL_PID")" 2>/dev/null
}

if tunnel_alive && [[ -n "$WP_PUBLIC_URL" ]] &&
  "${CURL_DIRECT[@]}" -fsS -o /dev/null --max-time 20 "${WP_PUBLIC_URL}/" 2>/dev/null; then
  echo "==> reusing the live tunnel at ${WP_PUBLIC_URL}"
else
  if tunnel_alive; then
    echo "==> the recorded tunnel is no longer serving; replacing it"
    kill "$(cat "$TUNNEL_PID")" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$TUNNEL_LOG"
  echo "==> opening a cloudflared quick tunnel"
  nohup cloudflared tunnel --no-autoupdate --url "http://localhost:${WP_HOST_PORT}" \
    >"$TUNNEL_LOG" 2>&1 &
  echo $! >"$TUNNEL_PID"

  discovered=''
  deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    discovered="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
    [[ -n "$discovered" ]] && break
    tunnel_alive || fail "cloudflared exited; see $TUNNEL_LOG"
    sleep 2
  done
  [[ -n "$discovered" ]] || fail "no trycloudflare hostname appeared within 120s; see $TUNNEL_LOG"

  WP_PUBLIC_URL="$discovered"
  echo "    tunnel hostname: ${WP_PUBLIC_URL}"

  # WAIT FOR PUBLIC DNS BEFORE TOUCHING THE SYSTEM RESOLVER.
  #
  # A quick tunnel's record is created when cloudflared prints the hostname and
  # is visible to Cloudflare's own resolvers within a second or two — but any
  # OTHER resolver that is asked in that window gets NXDOMAIN and CACHES it.
  # trycloudflare.com's SOA sets a 1800s negative TTL, so one premature lookup
  # makes the site unresolvable on this machine for half an hour while remaining
  # perfectly reachable from everywhere else. Measured, the first time this
  # script ran.
  #
  # So: ask a public resolver first, and only once it answers let anything reach
  # for `getent`/`curl`, which go through the system resolver the backend also
  # uses. The order is the whole point.
  host_only="${WP_PUBLIC_URL#https://}"
  if command -v dig >/dev/null; then
    echo "==> waiting for ${host_only} to appear in PUBLIC DNS (before asking this host's resolver)"
    deadline=$((SECONDS + 180))
    until [[ -n "$(dig +short @1.1.1.1 "$host_only" A 2>/dev/null | head -1)" ]]; do
      ((SECONDS < deadline)) || fail "the tunnel hostname never appeared in public DNS"
      sleep 3
    done
    echo "    public DNS answers"
  else
    echo "!!  dig is unavailable, so public DNS cannot be checked before the local"
    echo "!!  resolver is asked. If the next step fails to resolve, wait out the"
    echo "!!  negative cache (up to 30 minutes) or re-run to get a new hostname."
  fi

  echo "==> waiting for this host's own resolver (the one safeFetch will use)"
  deadline=$((SECONDS + 120))
  until getent hosts "$host_only" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      fail "$(
        printf '%s\n' \
          "${host_only} resolves publicly but NOT through this host's resolver." \
          "That is almost always a cached NXDOMAIN from a lookup made too early," \
          "and it pins the name for up to 30 minutes. Re-run up.sh to mint a new" \
          "hostname, or wait the negative TTL out."
      )"
    fi
    sleep 3
  done
  echo "    local resolver answers: $(getent hosts "$host_only" | awk '{print $1}' | paste -sd' ')"

  set_state WP_PUBLIC_URL "$WP_PUBLIC_URL"
fi

# --- 3. teach WordPress its public origin ----------------------------------
# The `home`/`siteurl` DATABASE OPTIONS are the ONLY authority for the site's
# origin: this image ignores `WORDPRESS_CONFIG_EXTRA` entirely (see the compose
# file), so there are no WP_HOME/WP_SITEURL constants and nothing to recreate
# the container for.
echo "==> pointing the site origin at ${WP_PUBLIC_URL}"

deadline=$((SECONDS + 120))
until "${CURL_DIRECT[@]}" -fsS -o /dev/null --max-time 20 "${WP_PUBLIC_URL}/" 2>/dev/null; do
  ((SECONDS < deadline)) || fail "the public URL ${WP_PUBLIC_URL} did not serve within 120s"
  sleep 3
done

# Keep the database options in step, so a lost container env cannot silently
# fall back to a stale origin. Skipped before seed.sh has installed WordPress.
if wp_cli core is-installed >/dev/null 2>&1; then
  wp_cli option update home "$WP_PUBLIC_URL" >/dev/null
  wp_cli option update siteurl "$WP_PUBLIC_URL" >/dev/null
  echo "    database options updated too"
else
  echo "    WordPress is not installed yet — run seed.sh next"
fi

# The token file records the site URL beside the credentials; a new tunnel makes
# the recorded one stale, so refresh it whenever it already exists.
if [[ -f "$TOKEN_FILE" ]] && command -v jq >/dev/null; then
  tmp="$(mktemp)"
  jq --arg url "$WP_PUBLIC_URL" '.siteUrl = $url' "$TOKEN_FILE" >"$tmp"
  install -m 600 "$tmp" "$TOKEN_FILE"
  rm -f "$tmp"
  echo "    refreshed siteUrl in ${TOKEN_FILE}"
fi

echo
echo "public site URL: ${WP_PUBLIC_URL}"
echo "REST base:       ${WP_PUBLIC_URL}/wp-json/wc/v3"
echo "tunnel log:      ${TUNNEL_LOG}"
