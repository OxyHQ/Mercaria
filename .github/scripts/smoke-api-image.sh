#!/usr/bin/env bash
# Boot the built API image the way ECS runs it, against a throwaway PostGIS, and
# fail unless its runtime (Bun under dumb-init, the image's own user, entrypoint
# and commands) can:
#   1. apply the migrator with the command run-migration-task.sh sends (`all` on
#      the empty database, then `pre` and `post` as clean no-ops), and REFUSE a
#      wrong --target-database with a non-zero exit;
#   2. run the taxonomy one-shot, twice (it is idempotent), load the
#      capability-catalog one-shot far enough to reach its identity check, and
#      run every Oxy-media backfill (and every application-media target) in
#      preview to a clean exit and a preview report, refusing an unknown flag;
#   3. exit non-zero when the server cannot reach its database at boot;
#   4. serve /health/ready with 200 from the image's default CMD, and turn the
#      image's own HEALTHCHECK healthy;
#   5. run Bun as the direct child of dumb-init (PID 1), so SIGTERM reaches it;
#   6. turn SIGTERM (`docker stop`, as ECS does on a rollout) into the graceful
#      shutdown and exit 0.
# A unit suite cannot see any of these: they are properties of the image.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway database)}"
: "${PG_DATABASE:?PG_DATABASE required (the database DATABASE_URL names)}"
PORT="${PORT:-3001}"
NAME="mercaria-api-smoke-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

one_shot() {
  docker run --rm --network host -e DATABASE_URL -e NODE_ENV=production "$IMAGE" "$@"
}

# 1. The migrator, by the exact command shape the deploy sends.
for phase in all pre post; do
  one_shot bun packages/backend/dist/db/migrate.js "--target-database=$PG_DATABASE" "--phase=$phase"
done
if one_shot bun packages/backend/dist/db/migrate.js --target-database=not-this-one --phase=pre >/dev/null 2>&1; then
  echo "::error::the migrator exited 0 against the wrong --target-database"
  exit 1
fi

# 2. The other one-shots the image carries.
for _ in 1 2; do
  one_shot bun packages/backend/dist/scripts/provision-taxonomy.js
done
# No Oxy identity exists in CI, so registration must refuse — after loading.
set +e
catalog_out=$(one_shot bun packages/backend/dist/register-capability-catalog.js 2>&1)
catalog_code=$?
set -e
if [ "$catalog_code" = 0 ] || ! grep -q 'no Oxy identity' <<<"$catalog_out"; then
  printf '%s\n' "$catalog_out"
  echo "::error::register-capability-catalog did not reach its identity check (exit $catalog_code)"
  exit 1
fi

# The Oxy-media backfills, by the command shape run-media-backfill.yml sends.
# Preview reads and writes nothing, so on this database each must exit 0 and
# print its (empty) report; no Oxy identity is needed to get there.
backfill_preview() {
  local out code
  set +e
  out=$(one_shot bun "packages/backend/dist/scripts/backfill-$1.js" --preview --limit=100 "${@:2}" 2>&1)
  code=$?
  set -e
  if [ "$code" != 0 ] || ! grep -q '"mode": "preview"' <<<"$out"; then
    printf '%s\n' "$out"
    echo "::error::backfill-$1 ${*:2} did not preview cleanly (exit $code)"
    exit 1
  fi
}
backfill_preview listing-media
backfill_preview store-artwork
backfill_preview digital-asset-storage
for target in canonical_image category_image brand_logo canonical_description_image \
  canonical_image_duplicates source_media; do
  backfill_preview application-media "--target=$target"
done
if one_shot bun packages/backend/dist/scripts/backfill-listing-media.js --not-a-flag >/dev/null 2>&1; then
  echo "::error::backfill-listing-media exited 0 on an unknown argument"
  exit 1
fi

# 3. A boot that cannot reach its database must END THE PROCESS non-zero, or
# ECS reads a crashed task as a clean stop.
set +e
timeout 120 docker run --rm --network host \
  -e DATABASE_URL=postgres://nobody@127.0.0.1:1/nothing -e PORT="$PORT" "$IMAGE" >/dev/null 2>&1
failed_boot=$?
set -e
if [ "$failed_boot" = 0 ] || [ "$failed_boot" = 124 ]; then
  echo "::error::a boot with no reachable database exited $failed_boot (expected a non-zero exit, promptly)"
  exit 1
fi

# 4. The image's default CMD. The health-check cadence is shortened so the
# image's own HEALTHCHECK command is exercised within the job, unchanged.
docker run -d --name "$NAME" --network host -e DATABASE_URL -e PORT="$PORT" \
  --health-interval 2s --health-start-period 5s "$IMAGE" >/dev/null

ready=
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  docker logs "$NAME" || true
  echo "::error::the API image never answered /health/ready"
  exit 1
fi

health=
for _ in $(seq 1 30); do
  health=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [ "$health" = healthy ] && break
  sleep 1
done
if [ "$health" != healthy ]; then
  docker inspect -f '{{json .State.Health}}' "$NAME" || true
  echo "::error::the image's HEALTHCHECK never reported healthy (last: $health)"
  exit 1
fi

# 5. dumb-init is PID 1 and forwards signals; Bun must be its direct child,
# running the bundle. A shell between them would swallow the SIGTERM below.
pid1=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
case "$pid1" in
  "dumb-init -- bun packages/backend/dist/index.js "*) ;;
  *)
    echo "::error::PID 1 is '$pid1', expected 'dumb-init -- bun packages/backend/dist/index.js'"
    exit 1
    ;;
esac
server=$(docker exec "$NAME" sh -c '
  for d in /proc/[0-9]*; do
    [ "$(cut -d" " -f4 "$d/stat")" = 1 ] || continue
    tr "\0" " " < "$d/cmdline"; echo
  done')
if ! grep -qx 'bun packages/backend/dist/index.js ' <<<"$server"; then
  echo "::error::PID 1's children are '$server', expected 'bun packages/backend/dist/index.js'"
  exit 1
fi

# 6. ECS stops a task with SIGTERM and a 30 s grace before SIGKILL.
docker stop -t 35 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
logs=$(docker logs "$NAME" 2>&1)
if [ "$exit_code" != 0 ] || ! grep -q 'Graceful shutdown complete' <<<"$logs"; then
  printf '%s\n' "$logs"
  echo "::error::SIGTERM did not end in a graceful exit 0 (exit code $exit_code)"
  exit 1
fi

echo "API image smoke passed: migrator (all/pre/post, wrong target refused), taxonomy and catalog one-shots, media backfill previews, failed boot non-zero, /health/ready, HEALTHCHECK, Bun under dumb-init, graceful SIGTERM"
