#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${TEMPEST_INSTALL_DIR:-/opt/tempest-x}"
SERVICE_NAME="tempest-x.service"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this installer as root: sudo ./install-ubuntu.sh" >&2
    exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "This installer supports Ubuntu/Linux only." >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip rsync

mkdir -p "${INSTALL_DIR}"
rsync -a --delete \
    --exclude '.venv/' \
    --exclude '.git/' \
    --exclude '__pycache__/' \
    "${SOURCE_DIR}/" "${INSTALL_DIR}/"

python3 -m venv "${INSTALL_DIR}/.venv"
"${INSTALL_DIR}/.venv/bin/python" -m pip install --upgrade pip
"${INSTALL_DIR}/.venv/bin/pip" install -r "${INSTALL_DIR}/backend/requirements.txt"

chown -R root:root "${INSTALL_DIR}"
chmod 700 "${INSTALL_DIR}"
chmod 600 "${INSTALL_DIR}"/*.json 2>/dev/null || true

cat > "/etc/systemd/system/${SERVICE_NAME}" <<EOF
[Unit]
Description=TEMPEST X AI Motion Portal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}
Environment=TEMPEST_HOST=127.0.0.1
Environment=TEMPEST_PORT=5000
Environment=TEMPEST_OPEN_BROWSER=0
ExecStart=${INSTALL_DIR}/.venv/bin/python ${INSTALL_DIR}/backend/app.py
Restart=on-failure
RestartSec=5
NoNewPrivileges=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo
echo "TEMPEST X installed at ${INSTALL_DIR}"
echo "Service: systemctl status ${SERVICE_NAME}"
echo "Open:    http://127.0.0.1:5000/"
echo "Logs:    journalctl -u ${SERVICE_NAME} -f"