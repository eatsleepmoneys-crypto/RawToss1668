#!/bin/bash
# ============================================================
#  TigerLotto — Complete One-Click Deploy
#  Ubuntu 22.04 LTS
#  รัน: bash deploy.sh
# ============================================================
set -e

G="\033[0;32m" Y="\033[1;33m" R="\033[0;31m" C="\033[0;36m" B="\033[1m" N="\033[0m"
log()  { echo -e "${G}[✓]${N} $1"; }
warn() { echo -e "${Y}[!]${N} $1"; }
err()  { echo -e "${R}[✗]${N} $1"; exit 1; }
step() { echo -e "\n${C}${B}━━━ $1 ━━━${N}"; }

[[ $EUID -ne 0 ]] && err "รันด้วย root: sudo bash deploy.sh"

APP_DIR="/var/www/tigerlotto"
DB_NAME="tigerlotto_db"
DB_USER="tigerlotto_user"
DB_PASS=$(openssl rand -base64 20 | tr -dc 'a-zA-Z0-9' | head -c20)
JWT_SECRET=$(openssl rand -base64 64 | tr -dc 'a-zA-Z0-9' | head -c64)

echo -e "${Y}"
echo "  ████████╗██╗ ██████╗ ███████╗██████╗ "
echo "  ╚══██╔══╝██║██╔════╝ ██╔════╝██╔══██╗"
echo "     ██║   ██║██║  ███╗█████╗  ██████╔╝"
echo "     ██║   ██║██║   ██║██╔══╝  ██╔══██╗"
echo "     ██║   ██║╚██████╔╝███████╗██║  ██║"
echo "     ╚═╝   ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝"
echo -e "        🐯  One-Click Deploy v2.0${N}\n"

echo -e "${B}โดเมน (เช่น tigerlotto.com) หรือ Enter ใช้ IP:${N}"
read -r DOMAIN
[[ -z "$DOMAIN" ]] && DOMAIN=$(curl -s ifconfig.me 2>/dev/null || echo "localhost")

echo -e "${B}Email สำหรับ SSL (ถ้าใช้โดเมน):${N}"
read -r SSL_EMAIL

# ── 1. System ─────────────────────────────────────────────────
step "1/8 อัปเดตระบบ"
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq curl wget git unzip build-essential ufw fail2ban
log "ระบบพร้อม"

# ── 2. Node.js 20 ─────────────────────────────────────────────
step "2/8 Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - -qq
apt-get install -y -qq nodejs
log "Node $(node -v)"

# ── 3. MySQL 8 ────────────────────────────────────────────────
step "3/8 MySQL 8"
apt-get install -y -qq mysql-server
systemctl enable --now mysql
mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
log "MySQL เสร็จ"

# ── 4. Import Schema ──────────────────────────────────────────
step "4/8 Import Database Schema"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/tigerlotto_schema.sql" ]]; then
  mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$SCRIPT_DIR/tigerlotto_schema.sql"
  log "Schema import เสร็จ — 21 ตาราง"
else
  warn "ไม่พบ tigerlotto_schema.sql ข้ามไป"
fi

# ── 5. App files ──────────────────────────────────────────────
step "5/8 ติดตั้ง App"
mkdir -p "$APP_DIR"/{api,frontend/js,logs,uploads/{kyc,slips}}

# Copy API files
if [[ -d "$SCRIPT_DIR/api" ]]; then
  cp -r "$SCRIPT_DIR/api/." "$APP_DIR/api/"
  log "Copy API files"
else
  warn "ไม่พบโฟลเดอร์ api/"
fi

# Copy Frontend files
if [[ -d "$SCRIPT_DIR/frontend" ]]; then
  cp -r "$SCRIPT_DIR/frontend/." "$APP_DIR/frontend/"
  log "Copy Frontend files"
else
  warn "ไม่พบโฟลเดอร์ frontend/"
fi

# Write .env
cat > "$APP_DIR/api/.env" <<ENV
NODE_ENV=production
PORT=3000
APP_URL=http${DOMAIN:+s}://${DOMAIN}
DOMAIN=${DOMAIN}

DB_HOST=localhost
DB_PORT=3306
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d

UPLOAD_DIR=${APP_DIR}/uploads
LOG_DIR=${APP_DIR}/logs
ENV

# Write package.json if not exists
[[ ! -f "$APP_DIR/api/package.json" ]] && cat > "$APP_DIR/api/package.json" <<PKG
{
  "name":"tigerlotto-api","version":"2.0.0","main":"server.js",
  "scripts":{"start":"node server.js","dev":"nodemon server.js"},
  "dependencies":{
    "express":"^4.18.2","mysql2":"^3.6.5","bcryptjs":"^2.4.3",
    "jsonwebtoken":"^9.0.2","multer":"^1.4.5-lts.1","cors":"^2.8.5",
    "helmet":"^7.1.0","express-rate-limit":"^7.1.5","dotenv":"^16.3.1",
    "morgan":"^1.10.0","compression":"^1.7.4","socket.io":"^4.7.2","uuid":"^9.0.1"
  }
}
PKG

cd "$APP_DIR/api" && npm install --omit=dev -q
log "npm install เสร็จ"

# ── 6. Nginx ──────────────────────────────────────────────────
step "6/8 Nginx"
apt-get install -y -qq nginx
cat > /etc/nginx/sites-available/tigerlotto <<NGX
upstream tgl_api { server 127.0.0.1:3000; keepalive 32; }
server {
  listen 80;
  server_name ${DOMAIN};
  client_max_body_size 10M;
  gzip on; gzip_vary on;
  gzip_types text/plain text/css application/json application/javascript;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  location /api/ {
    proxy_pass http://tgl_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
  }
  location /socket.io/ {
    proxy_pass http://tgl_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
  location /uploads/ { alias ${APP_DIR}/uploads/; expires 7d; }
  location / { root ${APP_DIR}/frontend; index index.html; try_files \$uri \$uri/ /index.html; }
  location /health { proxy_pass http://tgl_api; access_log off; }
}
NGX
ln -sf /etc/nginx/sites-available/tigerlotto /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable --now nginx && systemctl reload nginx
log "Nginx เสร็จ"

# ── 7. PM2 ────────────────────────────────────────────────────
step "7/8 PM2"
npm install -g pm2 -q
cat > "$APP_DIR/ecosystem.config.js" <<PM2
module.exports = { apps: [{
  name: 'tigerlotto', script: '${APP_DIR}/api/server.js',
  cwd: '${APP_DIR}/api', instances: 'max', exec_mode: 'cluster',
  max_memory_restart: '512M',
  env: { NODE_ENV: 'production', PORT: 3000 },
  error_file: '${APP_DIR}/logs/err.log',
  out_file:   '${APP_DIR}/logs/out.log',
}]};
PM2
pm2 start "$APP_DIR/ecosystem.config.js"
pm2 save && pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
log "PM2 เสร็จ"

# ── 8. SSL + Firewall ─────────────────────────────────────────
step "8/8 SSL & Firewall"
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
if [[ "$DOMAIN" =~ \. ]] && [[ -n "$SSL_EMAIL" ]]; then
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --email "$SSL_EMAIL" --redirect 2>/dev/null \
    && log "SSL สำเร็จ" || warn "SSL ไม่สำเร็จ ใช้ HTTP"
  (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -
fi
log "Firewall เสร็จ"

# ── Save credentials ──────────────────────────────────────────
cat > /root/tigerlotto_credentials.txt <<CRED
========================================
  TigerLotto Credentials — $(date)
========================================
URL       : http${DOMAIN:+s}://${DOMAIN}
Health    : http${DOMAIN:+s}://${DOMAIN}/health
Dir       : ${APP_DIR}
DB Name   : ${DB_NAME}
DB User   : ${DB_USER}
DB Pass   : ${DB_PASS}
JWT Secret: ${JWT_SECRET}
PM2 Name  : tigerlotto
========================================
Commands:
  pm2 status
  pm2 logs tigerlotto
  pm2 restart tigerlotto
  bash manage.sh backup
========================================
CRED
chmod 600 /root/tigerlotto_credentials.txt

echo ""
echo -e "${G}${B}"
echo "  ╔════════════════════════════════════╗"
echo "  ║  🐯 TigerLotto Deploy สำเร็จ!      ║"
echo "  ╚════════════════════════════════════╝"
echo -e "${N}"
echo -e "  🌐 URL     : ${C}http${DOMAIN:+s}://${DOMAIN}${N}"
echo -e "  💾 DB      : ${C}${DB_NAME}${N}"
echo -e "  🔑 Creds   : ${C}/root/tigerlotto_credentials.txt${N}"
echo ""
echo -e "  ${Y}⚠️  ถัดไป: ใส่ API Keys ใน${N}"
echo -e "     ${C}nano ${APP_DIR}/api/.env${N}"
echo -e "     ${C}pm2 restart tigerlotto${N}"
echo ""
