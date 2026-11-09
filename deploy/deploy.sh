#!/usr/bin/env bash
# Build and (re)start the production stack on this machine, check it from the outside the way a
# player reaches it, and roll back to the previous images if the check fails. The deploy workflow
# runs it on the self-hosted runner (user gha, in the docker group); it also works by hand.
#
#   SITE_ADDRESS  address the site is opened by (default: the server's first IP)
#   CERT_DIR      where the self-signed certificate lives (default /opt/traffic/certs)
#   SKIP_TESTS    1: do not run the test suite in the image build (the workflow tested the commit)
set -euo pipefail
cd "$(dirname "$0")/.."

export SITE_ADDRESS="${SITE_ADDRESS:-$(hostname -I | awk '{print $1}')}"
export CERT_DIR="${CERT_DIR:-/opt/traffic/certs}"
export GIT_SHA="${GIT_SHA:-$(git rev-parse --short=7 HEAD)}"
export SKIP_TESTS="${SKIP_TESTS:-0}"
BASE="https://$SITE_ADDRESS"
IMAGES=(traffic-game traffic-web)
echo "deploying $GIT_SHA to $BASE"

# Self-signed certificate for the address, valid 10 years. Made once and kept across deploys, so a
# browser that accepted it keeps accepting it. A new address (or a domain later) gets a new one.
if [[ $SITE_ADDRESS =~ ^[0-9.]+$ || $SITE_ADDRESS == *:* ]]; then san="IP:$SITE_ADDRESS"; else san="DNS:$SITE_ADDRESS"; fi
if ! openssl x509 -in "$CERT_DIR/cert.pem" -noout -ext subjectAltName 2>/dev/null | grep -qF "$SITE_ADDRESS"; then
  echo "making a self-signed certificate for $SITE_ADDRESS"
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$SITE_ADDRESS/O=Traffic Cutting Up" \
    -addext "subjectAltName=$san" -addext "extendedKeyUsage=serverAuth" \
    -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" 2>/dev/null
  chmod 600 "$CERT_DIR/key.pem"
fi

# Keep the actual running images when possible, not a stale/newly built :latest tag.
running_image() {
  local container
  container=$(docker compose ps -q "$1") || return 1
  [ -n "$container" ] || return 1
  docker inspect --format '{{.Image}}' "$container"
}
have_previous=0
if docker image inspect traffic-game:latest traffic-web:latest >/dev/null 2>&1; then
  for service in game web; do
    previous=$(running_image "$service") || previous="traffic-$service:latest"
    docker tag "$previous" "traffic-$service:previous"
  done
  have_previous=1
fi
have_previous_miami=0
previous_miami_container=$(docker compose ps -q game-miami)
if [ -n "$previous_miami_container" ] && docker exec "$previous_miami_container" node -e \
  "fetch('http://127.0.0.1:8787/health').then(async r => { const h = await r.json(); if (!r.ok || h.ok !== true || h.map !== 'miami' || h.version !== process.env.GIT_SHA) process.exit(1); }).catch(() => process.exit(1))"; then
  docker tag "$(docker inspect --format '{{.Image}}' "$previous_miami_container")" traffic-game-miami:previous
  have_previous_miami=1
fi

step() { printf '\n== %s\n' "$*"; }
fail() { echo "CHECK FAILED: $*" >&2; }

# Use Compose's existing per-world volumes and the built Node 22 image, but override its entrypoint:
# the helper must run BEFORE the application can migrate settings. No host Node/SQLite is needed.
settings_ready=0
settings_backup="/data/.rollback-settings-$(date +%s)-$$-$RANDOM.json"
settings_operation() {
  docker compose run --rm -T --no-deps --pull never --entrypoint node "$1" \
    --input-type=module - "$2" "$settings_backup" "$1" < deploy/rollback-settings.mjs
}

# JSON parsing runs in the built image: the host needs Docker/curl, not a Node installation.
# Arguments are exact comparisons, never substring matches (Miami must not pass as highway).
HEALTH_CHECK_JS='let body = ""; process.stdin.on("data", c => body += c).on("end", () => {
  try { const h = JSON.parse(body); process.exit(h.ok === true && h.map === process.argv[1] && h.version === process.argv[2] ? 0 : 1); }
  catch { process.exit(1); }
});'
JSON_CHECK_JS='let body = ""; process.stdin.on("data", c => body += c).on("end", () => {
  try { const value = JSON.parse(body); process.exit(value && typeof value === "object" ? 0 : 1); }
  catch { process.exit(1); }
});'
MAP_CHECK_JS='let body = ""; process.stdin.on("data", c => body += c).on("end", () => {
  try { process.exit(JSON.parse(body).map === process.argv[1] ? 0 : 1); }
  catch { process.exit(1); }
});'
check_json() {
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    traffic-game node -e "$@"
}

# Runs inside `if !`, where bash ignores `set -e`: every check returns on its own.
verify() {
  local map prefix health code endpoint
  for map in highway miami; do
    prefix=""; [ "$map" != miami ] || prefix=/miami
    step "$map answers through HTTPS with the right map and build $GIT_SHA"
    health=""
    for _ in $(seq 1 45); do
      health=$(curl -fsSk --max-time 3 "$BASE$prefix/health" 2>/dev/null) && break
      sleep 2
    done
    [ -n "$health" ] || { fail "no answer from $BASE$prefix/health"; return 1; }
    printf '%s' "$health" | check_json "$HEALTH_CHECK_JS" "$map" "$GIT_SHA" ||
      { fail "$prefix/health reports another map/build: ${health:0:160}"; return 1; }
    curl -fsSk --max-time 10 "$BASE$prefix/api/map" | check_json "$MAP_CHECK_JS" "$map" ||
      { fail "$prefix/api/map reports another world"; return 1; }
    # Public JSON, admin authentication, and radio all have to reach the same world's API.
    for endpoint in /api/tuning /api/radio; do
      curl -fsSk --max-time 10 "$BASE$prefix$endpoint" | check_json "$JSON_CHECK_JS" ||
        { fail "$prefix$endpoint is not a successful JSON API response"; return 1; }
    done
    code=$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' "$BASE$prefix/api/admin/state") ||
      { fail "$prefix/api/admin/state is unreachable"; return 1; }
    [[ $code == 401 || $code == 404 ]] || { fail "$prefix/api/admin/state answered $code without a login"; return 1; }
    echo "ok: $map, $GIT_SHA, public API and admin ($code)"
  done

  step "site: version, page and every asset it loads"
  local version page assets
  version=$(curl -fsSk --max-time 10 "$BASE/version.json") || { fail "/version.json does not load"; return 1; }
  printf '%s' "$version" | check_json 'let b=""; process.stdin.on("data", c => b += c).on("end", () => { try { process.exit(JSON.parse(b).version === process.argv[1] ? 0 : 1); } catch { process.exit(1); } });' "$GIT_SHA" ||
    { fail "/version.json is $version, not $GIT_SHA"; return 1; }
  page=$(curl -fsSk --max-time 10 "$BASE/") || { fail "the page does not load"; return 1; }
  assets=$(grep -oE '/assets/[^"]+' <<<"$page" | sort -u)
  [ -n "$assets" ] || { fail "the page references no /assets/ files"; return 1; }
  for a in $assets; do
    curl -fsSk --max-time 10 -o /dev/null "$BASE$a" || { fail "$a does not load"; return 1; }
  done
  echo "ok: $(wc -l <<<"$assets") assets"

  curl -fsSk --max-time 10 -o /dev/null "$BASE/admin.html" || { fail "/admin.html does not load"; return 1; }
  curl -fsSk --max-time 10 -o /dev/null "$BASE/?map=miami" || { fail "Miami selector page does not load"; return 1; }

  step "plain http redirects to https, the certificate covers $SITE_ADDRESS"
  local cert
  code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://$SITE_ADDRESS/") || { fail "HTTP is unreachable"; return 1; }
  [ "$code" = 308 ] || { fail "http answers $code instead of redirecting to https"; return 1; }
  cert=$(openssl s_client -connect "$SITE_ADDRESS:443" -servername "$SITE_ADDRESS" </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null) || true
  [[ $cert == *"$SITE_ADDRESS"* ]] || { fail "the served certificate is not for $SITE_ADDRESS"; return 1; }
  echo "ok"

  step "real clients play through wss (join, snapshots, driving, each other, prediction)"
  for map in highway miami; do
    prefix=""; [ "$map" != miami ] || prefix=/miami
    docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
      traffic-game node dist-server/smoke.js --map "$map" \
      --url "wss://$SITE_ADDRESS$prefix/ws" --origin "$BASE" --insecure --version "$GIT_SHA" --clients 2 --seconds 8 ||
      { fail "$map smoke test"; return 1; }
  done
  docker compose ps || return 1
}

rollback() {
  local override
  local services=(game web)
  # Quiesce every writer before touching SQLite. If this or restoration fails, never start an
  # old binary that would silently reject migrated tuning and appear healthy with defaults.
  if ! docker compose stop web game game-miami; then
    echo "cannot stop writers for rollback; operator recovery required" >&2
    return 1
  fi
  # Never start the old highway-only binary as a pretend Miami on a first Miami rollout.
  # stop retains the container and miami_data for a later fixed release; no volume is deleted.
  if [ "$have_previous_miami" != 1 ]; then
    echo "no verified previous Miami: stopping it, retaining miami_data (highway-only recovery)" >&2
    docker compose stop game-miami || true
  fi
  if [ "$have_previous" = 1 ]; then
    if [ "${settings_ready:-0}" = 1 ]; then
      if ! settings_operation game restore; then
        echo "rollback settings restore failed; servers remain stopped, snapshot retained" >&2
        return 1
      fi
      if [ "$have_previous_miami" = 1 ] && ! settings_operation game-miami restore; then
        echo "Miami rollback settings restore failed; servers remain stopped, snapshots retained" >&2
        return 1
      fi
    fi
    echo "rolling back to the previous images" >&2
    for img in "${IMAGES[@]}"; do docker tag "$img:previous" "$img:latest" || return 1; done
    override=$(mktemp "${TMPDIR:-/tmp}/traffic-rollback.XXXXXX.yaml") || return 1
    # A pre-map highway image legitimately lacks h.map. Only this recovery healthcheck permits
    # that legacy shape; normal deployment and every Miami check always require map identity.
    cat >"$override" <<'YAML'
services:
  game:
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/health').then(async r => { const h = await r.json(); if (!r.ok || h.ok !== true || (h.map !== undefined && h.map !== 'highway') || h.version !== process.env.GIT_SHA) process.exit(1); }).catch(() => process.exit(1))"]
YAML
    if [ "$have_previous_miami" = 1 ]; then
      printf '  game-miami:\n    image: traffic-game-miami:previous\n' >>"$override"
      services+=(game-miami)
    fi
    # --no-deps bypasses web's normal Miami dependency during highway-only recovery.
    if ! docker compose -f compose.yaml -f "$override" up -d --no-deps --no-build --wait --wait-timeout 120 "${services[@]}"; then
      docker compose stop web game game-miami || true
      rm -f -- "$override"
      echo "rollback failed; servers stopped, snapshots retained for operator recovery" >&2
      return 1
    fi
    rm -f -- "$override"
  else
    echo "no previous game/web images are available for recovery" >&2
  fi
  docker compose ps
  # Do not dump logs here: admin settings/diagnostics can contain private data.
}

# A failed build leaves running containers alone. A failed startup must roll back too, not just
# failures in the external checks (for example, invalid map/DB identity fails the health gate).
docker compose build --pull
# Stop the old writers only after a successful build. Both snapshots must complete before either
# new application starts, closing the backup/startup admin-write race. A failed backup fails closed.
docker compose stop web game game-miami
for service in game game-miami; do
  if ! settings_operation "$service" backup; then
    echo "settings backup failed; no new server started; servers remain stopped" >&2
    exit 1
  fi
done
settings_ready=1
if ! docker compose up -d --remove-orphans --wait --wait-timeout 120; then
  rollback
  exit 1
fi
if ! verify; then
  rollback
  exit 1
fi

for service in game game-miami; do
  settings_operation "$service" discard || echo "settings snapshot retained for $service; remove locally after inspection" >&2
done
echo
echo "deployed $GIT_SHA: $BASE"
# Old images and week-old build cache go; the disk does not fill up deploy after deploy.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null || true
