#!/bin/bash
# Deploy family-tree to a DigitalOcean droplet.
# Usage: ./deploy.sh root@droplet-ip
set -euo pipefail

REMOTE="${1:?Usage: deploy.sh user@host}"
APP_DIR="/opt/family-tree"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Syncing app files to ${REMOTE} ==="
rsync -avz --delete \
    --exclude='venv/' \
    --exclude='instance/' \
    --exclude='uploads/' \
    --exclude='.git/' \
    --exclude='__pycache__/' \
    --exclude='.env' \
    --exclude='deploy/terraform/.terraform/' \
    --exclude='deploy/terraform/terraform.tfstate*' \
    --exclude='deploy/terraform/terraform.tfvars' \
    "${LOCAL_DIR}/" "${REMOTE}:${APP_DIR}/"

echo "=== Running remote setup ==="
ssh "${REMOTE}" << 'REMOTE_SCRIPT'
set -euo pipefail
APP_DIR="/opt/family-tree"
cd "$APP_DIR"

# Virtualenv
if [ ! -d venv ]; then
    python3.10 -m venv venv
fi
venv/bin/pip install --upgrade pip -q
venv/bin/pip install -r requirements.txt -q

# Pre-download insightface models
echo "Downloading face detection models..."
venv/bin/python -c "
from insightface.app import FaceAnalysis
app = FaceAnalysis(name='buffalo_sc', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=-1, det_size=(640, 640))
print('Models ready')
" 2>/dev/null || echo "Model download deferred to first use"

# Fix permissions
chown -R family-tree:family-tree "$APP_DIR"
chmod +x "$APP_DIR/deploy/configs/backup.sh"

# Install systemd service
cp "$APP_DIR/deploy/configs/family-tree.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable family-tree

# Install nginx config
cp "$APP_DIR/deploy/configs/nginx.conf" /etc/nginx/sites-available/family-tree
ln -sf /etc/nginx/sites-available/family-tree /etc/nginx/sites-enabled/family-tree
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Install backup cron
cp "$APP_DIR/deploy/configs/backup.sh" "$APP_DIR/backup.sh"
chmod +x "$APP_DIR/backup.sh"
(crontab -l 2>/dev/null | grep -v backup.sh; echo "0 3 * * * /opt/family-tree/backup.sh >> /var/log/family-tree/backup.log 2>&1") | crontab -

# Restart app
if [ -f "$APP_DIR/.env" ]; then
    systemctl restart family-tree
    echo "=== App restarted ==="
else
    echo "=== WARNING: Create /opt/family-tree/.env before starting the app ==="
    echo "    cp /opt/family-tree/deploy/.env.example /opt/family-tree/.env"
    echo "    nano /opt/family-tree/.env"
    echo "    systemctl start family-tree"
fi
REMOTE_SCRIPT

echo "=== Deploy complete ==="
