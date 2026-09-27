#!/usr/bin/env bash
set -euo pipefail

PREFIX=${AGENTCALL_PREFIX:-/opt/agentcall-cli}
REPO=${AGENTCALL_REPO:-https://github.com/sidinsearch/AgentCall.git}
BRANCH=${AGENTCALL_BRANCH:-cli}

if [[ $EUID -ne 0 ]]; then
  echo 'Run as root.' >&2
  exit 1
fi
command -v node >/dev/null || { echo 'Node.js 20+ is required.' >&2; exit 1; }
command -v git >/dev/null || { echo 'git is required.' >&2; exit 1; }

id agentcall >/dev/null 2>&1 || useradd --system --home-dir /var/lib/agentcall --create-home --shell /usr/sbin/nologin agentcall
rm -rf "$PREFIX"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$PREFIX"
chown -R agentcall:agentcall "$PREFIX"
cd "$PREFIX/pc/pc-gateway"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
install -d -o root -g root -m 0755 /etc/agentcall
if [[ ! -e /etc/agentcall/cloud.env ]]; then
  cat > /etc/agentcall/cloud.env <<'EOF'
# Set the phone's Tailscale address before starting the service.
AGENTCALL_PHONE_HOST=
AGENTCALL_PHONE_PORT=27183
EOF
fi
install -d -o agentcall -g agentcall -m 0700 /var/lib/agentcall/controller
install -d -o agentcall -g agentcall -m 0750 /run/agentcall
install -m 0644 "$PREFIX/packaging/cloud/agentcall-gatewayd.service" /etc/systemd/system/agentcall-gatewayd.service
install -m 0755 "$PREFIX/pc/pc-gateway/src/agentcall-cli.js" /usr/local/bin/agentcall-cli
chown agentcall:agentcall /var/lib/agentcall/controller /run/agentcall
systemctl daemon-reload
systemctl enable agentcall-gatewayd
printf 'Installed AgentCall CLI gateway at %s\n' "$PREFIX"
printf 'Set AGENTCALL_PHONE_HOST in /etc/agentcall/cloud.env, then run: systemctl restart agentcall-gatewayd\n'
