#!/usr/bin/env bash
# Build and (re)start the production stack on this machine, check it from the outside the way a
# player reaches it, and roll back to the previous images if the check fails. The deploy workflow
# runs it on the self-hosted runner (user gha, in the docker group); it also works by hand.
#
#   SITE_ADDRESS  address the site is opened by (default: the server's first IP)
#   CERT_DIR      where the self-signed certificate lives (default /opt/traffic/certs)
set -euo pipefail
cd "$(dirname "$0")/.."

export SITE_ADDRESS="${SITE_ADDRESS:-$(hostname -I | awk '{print $1}')}"
export CERT_DIR="${CERT_DIR:-/opt/traffic/certs}"
export GIT_SHA="${GIT_SHA:-$(git rev-parse --short=7 HEAD)}"
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

# Keep what runs now as :previous, the way back if the new build fails its checks.
have_previous=0
if docker image inspect traffic-game:latest >/dev/null 2>&1; then
  for img in "${IMAGES[@]}"; do docker tag "$img:latest" "$img:previous"; done
  have_previous=1
fi

# The image build runs the typecheck and the tests: a broken commit fails here and the running
# containers stay as they are.
docker compose build --pull
docker compose up -d --remove-orphans

step() { printf '\n== %s\n' "$*"; }
fail() { echo "CHECK FAILED: $*" >&2; }

# Runs inside `if !`, where bash ignores `set -e`: every check returns on its own.
verify() {
  step "game server answers through HTTPS and runs $GIT_SHA"
  local health=""
  for _ in $(seq 1 45); do
    health=$(curl -fsSk --max-time 3 "$BASE/health" 2>/dev/null) && break
    sleep 2
  done
  [ -n "$health" ] || { fail "no answer from $BASE/health"; return 1; }
  [[ $health == *"\"version\":\"$GIT_SHA\""* ]] || { fail "/health reports another build: ${health:0:120}"; return 1; }
  echo "ok"

  step "site: version, page and every asset it loads"
  local version page assets
  version=$(curl -fsSk "$BASE/version.json") || { fail "/version.json does not load"; return 1; }
  [[ $version == *"\"$GIT_SHA\""* ]] || { fail "/version.json is $version, not $GIT_SHA"; return 1; }
  page=$(curl -fsSk "$BASE/") || { fail "the page does not load"; return 1; }
  assets=$(grep -oE '/assets/[^"]+' <<<"$page" | sort -u)
  [ -n "$assets" ] || { fail "the page references no /assets/ files"; return 1; }
  for a in $assets; do
    curl -fsSk -o /dev/null "$BASE$a" || { fail "$a does not load"; return 1; }
  done
  echo "ok: $(wc -l <<<"$assets") assets"

  step "admin page loads; its API wants a login (401) or is off without ADMIN_PASSWORD (404)"
  curl -fsSk -o /dev/null "$BASE/admin.html" || { fail "/admin.html does not load"; return 1; }
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/admin/state")
  [[ $code == 401 || $code == 404 ]] || { fail "/api/admin/state answered $code without a login"; return 1; }
  echo "ok ($code: admin $([[ $code == 401 ]] && echo on || echo off))"

  step "plain http redirects to https, the certificate covers $SITE_ADDRESS"
  local code cert
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://$SITE_ADDRESS/")
  [ "$code" = 308 ] || { fail "http answers $code instead of redirecting to https"; return 1; }
  cert=$(openssl s_client -connect "$SITE_ADDRESS:443" -servername "$SITE_ADDRESS" </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null) || true
  [[ $cert == *"$SITE_ADDRESS"* ]] || { fail "the served certificate is not for $SITE_ADDRESS"; return 1; }
  echo "ok"

  step "real clients play through wss (join, snapshots, driving, each other, prediction)"
  docker run --rm --network host traffic-game node dist-server/smoke.js \
    --url "wss://$SITE_ADDRESS/ws" --origin "$BASE" --insecure --version "$GIT_SHA" --clients 2 --seconds 8 ||
    { fail "smoke test"; return 1; }
}

rollback() {
  if [ "$have_previous" = 1 ]; then
    echo "rolling back to the previous images" >&2
    for img in "${IMAGES[@]}"; do docker tag "$img:previous" "$img:latest"; done
    docker compose up -d --no-build --remove-orphans
  fi
  docker compose ps
  docker compose logs --tail 60
}

if ! verify; then
  rollback
  exit 1
fi

echo
echo "deployed $GIT_SHA: $BASE"
# Old images and week-old build cache go; the disk does not fill up deploy after deploy.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null || true
