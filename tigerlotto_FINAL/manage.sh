#!/bin/bash
# ============================================================
#  TigerLotto — Manage Script
#  Usage: bash manage.sh [start|stop|restart|status|logs|update|backup]
# ============================================================

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"
APP_DIR="/var/www/tigerlotto"
DB_NAME="tigerlotto_db"

log()  { echo -e "${GREEN}[✓]${RESET} $1"; }
warn() { echo -e "${YELLOW}[!]${RESET} $1"; }
err()  { echo -e "${RED}[✗]${RESET} $1"; }

show_help() {
  echo -e "${BOLD}TigerLotto Manager${RESET}"
  echo "  start     — เริ่ม App"
  echo "  stop      — หยุด App"
  echo "  restart   — Restart App"
  echo "  status    — ดูสถานะ"
  echo "  logs      — ดู Logs"
  echo "  update    — อัปเดต App (git pull + restart)"
  echo "  backup    — Backup Database"
  echo "  ssl       — ต่ออายุ SSL"
  echo "  monitor   — เปิด PM2 Monitor"
}

case "$1" in
  start)
    pm2 start "$APP_DIR/ecosystem.config.js"
    log "App started" ;;
  stop)
    pm2 stop tigerlotto
    log "App stopped" ;;
  restart)
    pm2 restart tigerlotto
    systemctl reload nginx
    log "App restarted" ;;
  status)
    pm2 status
    echo ""
    systemctl status nginx --no-pager -l ;;
  logs)
    pm2 logs tigerlotto --lines 100 ;;
  update)
    warn "Updating..."
    cd "$APP_DIR/api" && npm install --omit=dev -q
    pm2 restart tigerlotto
    log "Updated & restarted" ;;
  backup)
    BFILE="$APP_DIR/backups/db_$(date +%Y%m%d_%H%M%S).sql"
    mkdir -p "$APP_DIR/backups"
    source "$APP_DIR/api/.env" 2>/dev/null
    mysqldump -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$BFILE"
    gzip "$BFILE"
    log "Backup: ${BFILE}.gz" ;;
  ssl)
    certbot renew && systemctl reload nginx
    log "SSL renewed" ;;
  monitor)
    pm2 monit ;;
  *)
    show_help ;;
esac
