#!/bin/bash
# One-time server setup for a fresh Ubuntu 22.04 droplet.
# Usage: ssh root@droplet-ip 'bash -s' < setup-server.sh
set -euo pipefail

echo "=== Installing system packages ==="
apt-get update
apt-get install -y python3.10 python3.10-venv python3-pip nginx certbot python3-certbot-nginx sqlite3 rsync

echo "=== Creating 1GB swap file ==="
if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "Swap created"
else
    echo "Swap already exists"
fi

echo "=== Creating app user ==="
id -u bdtree &>/dev/null || useradd -r -m -d /opt/bdtree -s /bin/bash bdtree

echo "=== Creating directories ==="
mkdir -p /opt/bdtree/{instance,uploads,backups}
mkdir -p /var/log/bdtree
mkdir -p /var/www/certbot
chown -R bdtree:bdtree /opt/bdtree /var/log/bdtree

echo "=== Server setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Run deploy.sh to push the app code"
echo "  2. Create /opt/bdtree/.env from .env.example"
echo "  3. systemctl start bdtree"
echo "  4. (Optional) certbot --nginx -d yourdomain.com"
