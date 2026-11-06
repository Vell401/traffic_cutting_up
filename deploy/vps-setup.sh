#!/usr/bin/env bash
# What the VPS needs for the deploy workflow, as root on Ubuntu 24.04 (already done on vps_ru; kept
# here to set up another server the same way):
#   2 GB swap (the image build needs more than 2 GB of RAM), Docker Engine + Compose from Docker's
#   repository with bounded container logs, user gha in the docker group, the GitHub Actions runner
#   in /opt/actions-runner, /opt/traffic for the certificate. Then: bash deploy/runner-register.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get update -q
apt-get install -yq ca-certificates curl openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
printf '%s\n' '{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}' > /etc/docker/daemon.json
systemctl restart docker

id gha >/dev/null 2>&1 || useradd -m -s /bin/bash gha
usermod -aG docker gha
mkdir -p /opt/actions-runner /opt/traffic/certs
chown -R gha:gha /opt/actions-runner /opt/traffic

cd /opt/actions-runner
if [ ! -x run.sh ]; then
  ver=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | grep -oP '"tag_name": "v\K[^"]+')
  sudo -u gha curl -sSL -o runner.tgz "https://github.com/actions/runner/releases/download/v$ver/actions-runner-linux-x64-$ver.tar.gz"
  sudo -u gha tar xzf runner.tgz
  rm runner.tgz
  ./bin/installdependencies.sh
fi
echo "ready: now bash deploy/runner-register.sh (or /opt/actions-runner/register.sh)"
