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

echo "=== Generating self-signed SSL certificate ==="
if [ ! -f /etc/ssl/certs/family-tree.crt ]; then
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout /etc/ssl/private/family-tree.key \
        -out /etc/ssl/certs/family-tree.crt \
        -subj "/CN=family-tree"
    echo "Certificate created (valid for 10 years)"
else
    echo "Certificate already exists"
fi

echo "=== Creating app user ==="
id -u family-tree &>/dev/null || useradd -r -m -d /opt/family-tree -s /bin/bash family-tree

echo "=== Creating directories ==="
mkdir -p /opt/family-tree/{instance,uploads,backups}
mkdir -p /var/log/family-tree
mkdir -p /var/www/certbot
chown -R family-tree:family-tree /opt/family-tree /var/log/family-tree

echo "=== Server setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Run deploy.sh to push the app code"
echo "  2. Create /opt/family-tree/.env from .env.example"
echo "  3. systemctl start family-tree"
echo "  4. (Optional) certbot --nginx -d yourdomain.com"
