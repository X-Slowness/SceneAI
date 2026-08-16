#!/bin/bash
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "Run this as a normal user (e.g. ubuntu), not root. It uses sudo internally."
  exit 1
fi

DOMAIN="${1:-}"
echo "=== SceneAI VM setup ==="
echo "Domain (leave empty to skip HTTPS/domain): ${DOMAIN:-none}"

echo "--- Updating system ---"
sudo apt-get update -y
sudo apt-get upgrade -y

echo "--- Installing Node.js 20 + git ---"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git

echo "--- Installing PM2 ---"
sudo npm install -g pm2

echo "--- Cloning SceneAI ---"
if [ ! -d /opt/sceneai ]; then
  sudo git clone https://github.com/X-Slowness/SceneAI.git /opt/sceneai
  sudo chown -R "$USER:$USER" /opt/sceneai
fi
cd /opt/sceneai
npm install --omit=dev

echo "--- .env check ---"
if [ ! -f .env ]; then
  echo "WARNING: /opt/sceneai/.env does not exist yet."
  echo "Upload it now from your PC, then run this script again:"
  echo "  scp .env ubuntu@<YOUR-VM-IP>:/opt/sceneai/.env"
  echo "Also upload the backup:"
  echo "  scp sceneai_backup_production_2026-08-16.json ubuntu@<YOUR-VM-IP>:/opt/sceneai/sceneai_backup.json"
  echo "(SITE_URL line in .env will be updated to https://$DOMAIN if a domain was given)"
  exit 0
fi

echo "--- Updating SITE_URL in .env ---"
if [ -n "$DOMAIN" ]; then
  sed -i "s|^SITE_URL=.*|SITE_URL=https://$DOMAIN|" .env || true
  if ! grep -q "^SITE_URL=" .env; then
    echo "SITE_URL=https://$DOMAIN" >> .env
  fi
fi

echo "--- Starting with PM2 ---"
pm2 start server.js --name sceneai
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME" || true

echo "--- Installing Caddy (reverse proxy + auto HTTPS) ---"
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update -y
    sudo apt-get install -y caddy
  fi
  sudo sed "s|__DOMAIN__|$DOMAIN|g" deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo systemctl enable caddy
  sudo systemctl restart caddy
  echo "HTTPS is live. Allow a minute for the Let's Encrypt cert."
fi

echo "=== DONE ==="
echo "Server:  https://$DOMAIN  (or http://<VM-IP>:3000 if no domain)"
echo "Next:"
echo "  1) Google Cloud Console -> OAuth client -> add 'https://$DOMAIN' to Authorized JavaScript origins"
echo "  2) LemonSqueezy dashboard -> update webhook URL to https://$DOMAIN/api/webhook/lemonsqueezy"
