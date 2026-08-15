#!/usr/bin/env bash
#
# Open a public HTTPS origin onto the local API and print the two URLs the
# Shopify app must be configured with (#69, runbook §3.3).
#
# Shopify will not send an OAuth callback or a webhook to `localhost`, so a
# public origin is a hard requirement of the verification rather than a
# convenience. A `cloudflared` quick tunnel needs no Cloudflare account.
#
# ## Why this prints a URL instead of writing one
#
# A quick tunnel's hostname is RANDOM and changes on every run, and it is the
# same value in three places that must agree: the app's redirect URL in the
# Shopify dashboard, the app's webhook address, and this deployment's
# `CONNECTOR_OAUTH_REDIRECT_BASE_URL`. Two of those three live in somebody
# else's web UI, so the script that could keep them in step does not exist.
# Printing one block to copy is the honest interface; a script that exported
# the variable and left the dashboard stale would produce a callback Shopify
# refuses and a run that fails for a reason that is not the connector's.
#
# Usage:  ./tunnel.sh [port]        (default 4160, matching src/index.ts)
#
# Leave it RUNNING for the whole session. Ctrl-C ends the tunnel, and the
# hostname is not recoverable — a re-run means re-pasting all three places.

set -euo pipefail

PORT="${1:-4160}"
CLOUDFLARED="${CLOUDFLARED:-/usr/local/bin/cloudflared}"

if [ ! -x "$CLOUDFLARED" ]; then
  echo "FATAL: cloudflared not found or not executable at ${CLOUDFLARED}." >&2
  echo "       Set CLOUDFLARED=/path/to/cloudflared, or install it." >&2
  exit 1
fi

# A tunnel to a port nothing is listening on resolves and then 502s on every
# request — which reads, from the Shopify dashboard, exactly like a redirect URL
# that was typed wrong. Refuse up front instead.
if ! (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  echo "FATAL: nothing is listening on 127.0.0.1:${PORT}." >&2
  echo "       Start the API first (bun run --cwd packages/backend dev), then re-run." >&2
  echo "       A tunnel to a dead port 502s every callback and looks like a" >&2
  echo "       misconfigured redirect URL in the Shopify dashboard." >&2
  exit 1
fi
exec 3<&- 2>/dev/null || true

LOG="$(mktemp -t cloudflared-shopify-XXXXXX.log)"
echo "Starting cloudflared quick tunnel to http://localhost:${PORT} ..."
echo "  (log: ${LOG})"

"$CLOUDFLARED" tunnel --url "http://localhost:${PORT}" --no-autoupdate >"$LOG" 2>&1 &
TUNNEL_PID=$!
# shellcheck disable=SC2064
trap "kill ${TUNNEL_PID} 2>/dev/null || true" EXIT INT TERM

BASE=""
for _ in $(seq 1 60); do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "FATAL: cloudflared exited. Last lines of ${LOG}:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  BASE="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$BASE" ] && break
  sleep 1
done

if [ -z "$BASE" ]; then
  echo "FATAL: no trycloudflare.com hostname appeared within 60s. Log:" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

cat <<EOF

================================================================================
  Public origin:  ${BASE}
================================================================================

1) Paste into the Shopify app configuration
   (Dev Dashboard -> your app -> Configuration):

   Allowed redirection URL(s):
     ${BASE}/channels/oauth/shopify/callback

   Webhook / event subscription endpoint:
     ${BASE}/channels/webhooks/shopify

   Both are DERIVED (connectors/config.ts getOAuthRedirectUri / getWebhookAddress).
   A trailing slash or a different host makes Shopify refuse the callback.

2) Export for the API process, then RESTART it — the connector reads this at
   use, but a process started without it has nothing to re-read:

   export CONNECTOR_OAUTH_REDIRECT_BASE_URL="${BASE}"

3) Sanity-check the origin actually reaches this API before touching Shopify.
   A 404 here is fine and expected (GET on a POST-only route); a 502 or a
   timeout means the tunnel is not reaching the API and every scenario below
   would fail for that reason:

   curl -sS -o /dev/null -w '%{http_code}\n' "${BASE}/channels/webhooks/shopify"

Leave this process RUNNING. Ctrl-C ends the tunnel and the hostname is gone.
================================================================================

EOF

wait "$TUNNEL_PID"
