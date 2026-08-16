#!/bin/bash
set -euo pipefail
# Usage: ./duckdns-update.sh <duckdns-token> <subdomain-without-.duckdns.org> <your-public-ip>
# Oracle VM IPs are static, so one run is enough. Add to cron to be safe:
#   5 * * * * /opt/sceneai/deploy/duckdns-update.sh TOKEN NAME IP

TOKEN="${1:?usage: duckdns-update.sh <token> <name> <ip>}"
DOMAIN="${2:?}"
IP="${3:?}"

curl -s "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=${IP}" && echo ""
echo "Pointing ${DOMAIN}.duckdns.org -> ${IP}"
