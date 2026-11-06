#!/usr/bin/env bash
# Build and (re)start the production stack on this machine. The deploy workflow runs it on the
# self-hosted runner (user gha, member of the docker group); it also works by hand from the repo root.
#
#   SITE_ADDRESS  address the site is opened by (default: the server's first IP)
#   CERT_DIR      where the self-signed certificate lives (default /opt/traffic/certs)
set -euo pipefail
cd "$(dirname "$0")/.."

export SITE_ADDRESS="${SITE_ADDRESS:-$(hostname -I | awk '{print $1}')}"
export CERT_DIR="${CERT_DIR:-/opt/traffic/certs}"
echo "site: https://$SITE_ADDRESS"

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

# The image build runs the typecheck and the tests: a broken commit fails here and the running
# containers stay as they are.
docker compose build --pull
docker compose up -d --remove-orphans

# End to end through HTTPS: Caddy → game server.
for i in $(seq 1 40); do
  if curl -fsSk --max-time 3 "https://$SITE_ADDRESS/health" >/dev/null; then
    echo "deployed $(git rev-parse --short HEAD): https://$SITE_ADDRESS"
    break
  fi
  if [ "$i" = 40 ]; then
    echo "health check failed" >&2
    docker compose ps
    docker compose logs --tail 60
    exit 1
  fi
  sleep 2
done

# Old images and week-old build cache go; the disk does not fill up deploy after deploy.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null || true
