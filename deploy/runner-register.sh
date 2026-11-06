#!/usr/bin/env bash
# One time on the VPS, as root: register the self-hosted GitHub Actions runner for this repository
# and run it as a systemd service (user gha). deploy/vps-setup.sh must have run before.
#
#   bash /opt/actions-runner/register.sh
#
# The token: GitHub → repository Settings → Actions → Runners → New self-hosted runner → the value
# after --token in the "Configure" step (valid for an hour). It is read without echo and kept only
# in the runner's own configuration.
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/Vell401/traffic_cutting_up}"
cd /opt/actions-runner

if [ -f .runner ]; then
  echo "already registered; to register again first run: sudo -u gha ./config.sh remove --token <removal token>" >&2
  exit 1
fi
read -rsp "Runner registration token: " TOKEN
echo
sudo -u gha ./config.sh --unattended --replace --url "$REPO_URL" --token "$TOKEN" \
  --name vps_ru --labels vps_ru --work _work
unset TOKEN
./svc.sh install gha
./svc.sh start
systemctl --no-pager status "$(cat .service)" | head -n 5
