#!/bin/bash
# Daily backup of SQLite DB + uploads
# Cron: 0 3 * * * /opt/bdtree/backup.sh >> /var/log/bdtree/backup.log 2>&1

set -euo pipefail

BACKUP_DIR="/opt/bdtree/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/bdtree_${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

# Safe hot-copy using sqlite3 .backup (handles WAL correctly)
sqlite3 /opt/bdtree/instance/bdtree.db ".backup '${BACKUP_DIR}/bdtree_${TIMESTAMP}.db'"

# Archive DB backup + uploads
tar czf "$BACKUP_FILE" \
    -C "$BACKUP_DIR" "bdtree_${TIMESTAMP}.db" \
    -C /opt/bdtree uploads/

rm "${BACKUP_DIR}/bdtree_${TIMESTAMP}.db"

# Keep last 14 days
find "$BACKUP_DIR" -name "bdtree_*.tar.gz" -mtime +14 -delete

echo "$(date): Backup complete: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
