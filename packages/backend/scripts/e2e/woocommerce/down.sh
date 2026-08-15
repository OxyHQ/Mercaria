#!/usr/bin/env bash
# Tear the disposable WooCommerce stack down: stop the tunnel, remove the
# containers AND their volumes, and forget the recorded public URL.
#
# This DESTROYS the site — WordPress, WooCommerce, the catalogue and the orders
# all live in the named volumes. That is the point: the stack is disposable, and
# a half-removed one that re-uses a stale database is worse than none.
#
# The credential file is left alone unless --purge-credentials is passed: it is
# outside the repo, it is mode 600, and the key it names is dead the moment the
# database volume is gone.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

PURGE_CREDENTIALS=''
KEEP_STATE=''
for arg in "$@"; do
  case "$arg" in
    --purge-credentials) PURGE_CREDENTIALS='yes' ;;
    --keep-state) KEEP_STATE='yes' ;;
    *)
      echo "down.sh: unknown argument '${arg}' (expected --purge-credentials or --keep-state)" >&2
      exit 2
      ;;
  esac
done

if [[ -f "$TUNNEL_PID" ]]; then
  pid="$(cat "$TUNNEL_PID")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "==> stopping cloudflared (pid ${pid})"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_PID"
fi

echo "==> removing containers and volumes for project ${COMPOSE_PROJECT}"
compose down --volumes --remove-orphans

# The tunnel hostname is dead with the tunnel; leaving it recorded would let a
# later script believe it still has a site.
set_state WP_PUBLIC_URL ''

if [[ -n "$PURGE_CREDENTIALS" ]] && [[ -f "$TOKEN_FILE" ]]; then
  rm -f "$TOKEN_FILE"
  echo "==> removed ${TOKEN_FILE}"
fi

if [[ -z "$KEEP_STATE" ]]; then
  rm -f "$TUNNEL_LOG"
fi

echo "done — the site and its data are gone."
