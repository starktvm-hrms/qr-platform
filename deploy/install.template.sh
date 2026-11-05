#!/usr/bin/env bash
# QR Platform installer for an Ubuntu/Debian VPS.
# Safe to re-run: keeps the database, admin password and visitor salt; updates the app code.
set -euo pipefail

DOMAIN="${DOMAIN:-__DOMAIN__}"
APP_DIR=/opt/qr-platform
DATA_DIR=/var/lib/qr-platform
ENV_FILE=/etc/qr-platform.env
SERVICE=qr-platform
APP_USER=qrplatform

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo bash $0)"
export DEBIAN_FRONTEND=noninteractive

# A broken third-party apt source (common on new Ubuntu releases) must not stop the install.
APT_UPDATED=0
apt_update() {
  [ "$APT_UPDATED" -eq 1 ] && return 0
  apt-get update -qq || warn "apt-get update reported errors (usually a third-party repository without packages for this Ubuntu release). Continuing."
  APT_UPDATED=1
}

# ---------------------------------------------------------------- Node.js 22
log "Checking Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node')
  maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 13 ]; }; then need_node=0; fi
  echo "Found Node $v"
fi
if [ "$need_node" -eq 1 ]; then
  # Official binary from nodejs.org: works on any glibc distro release and doesn't depend on apt.
  log "Installing Node.js 22 from nodejs.org"
  case "$(uname -m)" in
    x86_64) NARCH=x64 ;;
    aarch64|arm64) NARCH=arm64 ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac
  NODE_DIST=https://nodejs.org/dist/latest-v22.x
  SUMS=$(curl -fsSL "$NODE_DIST/SHASUMS256.txt") || die "Could not reach nodejs.org"
  NODE_TGZ=$(printf '%s\n' "$SUMS" | awk -v a="linux-$NARCH.tar.gz" '$2 ~ a"$" {print $2}')
  [ -n "$NODE_TGZ" ] || die "Could not find a Node.js 22 build for linux-$NARCH"
  NTMP=$(mktemp -d)
  curl -fsSL -o "$NTMP/$NODE_TGZ" "$NODE_DIST/$NODE_TGZ"
  ( cd "$NTMP" && printf '%s\n' "$SUMS" | grep " $NODE_TGZ\$" | sha256sum -c --quiet - ) || die "Node.js download failed checksum verification"
  rm -rf /opt/nodejs && mkdir -p /opt/nodejs
  tar -xzf "$NTMP/$NODE_TGZ" -C /opt/nodejs --strip-components=1
  rm -rf "$NTMP"
  ln -sf /opt/nodejs/bin/node /usr/local/bin/node
  ln -sf /opt/nodejs/bin/npm /usr/local/bin/npm
  ln -sf /opt/nodejs/bin/npx /usr/local/bin/npx
  hash -r
  NODE_BIN=/opt/nodejs/bin/node
  NPM_BIN=/opt/nodejs/bin/npm
  echo "Installed Node $("$NODE_BIN" -v) to /opt/nodejs"
else
  NODE_BIN=$(command -v node)
  NPM_BIN=$(command -v npm)
fi

# ---------------------------------------------------------------- app files
log "Installing app to $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
TMP=$(mktemp -d)
base64 -d > "$TMP/app.tar.gz" <<'__APP_ARCHIVE__'
__APP_B64__
__APP_ARCHIVE__
rm -rf "$APP_DIR/public"
tar -xzf "$TMP/app.tar.gz" -C "$APP_DIR"
rm -rf "$TMP"
( cd "$APP_DIR" && "$NPM_BIN" ci --omit=dev --no-audit --no-fund --loglevel=error )
chown -R root:root "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------------------------------------------------------------- config
port_free() { ! ss -ltnH "sport = :$1" | grep -q .; }
if [ -f "$ENV_FILE" ]; then
  log "Keeping existing config $ENV_FILE"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  NEW_PASSWORD=""
else
  PORT=3100
  while ! port_free "$PORT"; do PORT=$((PORT + 1)); done
  NEW_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)
  umask 077
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
HOST=127.0.0.1
BASE_URL=https://$DOMAIN
DATA_DIR=$DATA_DIR
ADMIN_PASSWORD=$NEW_PASSWORD
IP_SALT=$(tr -dc 'a-f0-9' </dev/urandom | head -c 32)
NODE_ENV=production
EOF
  umask 022
  chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
echo "App will listen on 127.0.0.1:$PORT"

# ---------------------------------------------------------------- systemd
log "Configuring systemd service"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=QR Platform (static & dynamic QR codes)
After=network.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet $SERVICE
systemctl restart $SERVICE
for i in $(seq 1 20); do
  curl -fsS -o /dev/null -u "admin:$ADMIN_PASSWORD" "http://127.0.0.1:$PORT/" && break
  sleep 0.5
  [ "$i" -eq 20 ] && { journalctl -u $SERVICE -n 30 --no-pager; die "App did not start"; }
done
echo "App is running."

# ---------------------------------------------------------------- web server
SERVER_IP=$(curl -fsS -4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
dns_ok() { getent ahostsv4 "$DOMAIN" | awk '{print $1}' | grep -qx "$SERVER_IP"; }
WEB=$(ss -ltnpH 'sport = :80' | grep -oE 'users:\(\("[^"]+' | head -1 | sed 's/.*("//' || true)
echo "Web server on port 80: ${WEB:-none}"
CERT_NOTE=""

get_cert() { # $1 = certbot plugin (nginx|apache)
  if ! dns_ok; then
    CERT_NOTE="DNS for $DOMAIN does not point to $SERVER_IP yet. Re-run this script once it does to get HTTPS."
    return
  fi
  command -v certbot >/dev/null || { apt_update; apt-get install -y -qq certbot "python3-certbot-$1" >/dev/null; }
  dpkg -s "python3-certbot-$1" >/dev/null 2>&1 || apt-get install -y -qq "python3-certbot-$1" >/dev/null
  certbot --"$1" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect --keep-until-expiring \
    || CERT_NOTE="certbot failed. The site works over HTTP; check the certbot output above."
}

case "$WEB" in
  nginx*)
    log "Adding nginx site for $DOMAIN"
    if [ -d /etc/nginx/sites-available ]; then
      CONF=/etc/nginx/sites-available/$DOMAIN; LINK=/etc/nginx/sites-enabled/$DOMAIN
    else
      CONF=/etc/nginx/conf.d/$DOMAIN.conf; LINK=""
    fi
    if [ ! -f "$CONF" ]; then
      cat > "$CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
      [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
    else
      sed -i -E "s#proxy_pass http://127\.0\.0\.1:[0-9]+;#proxy_pass http://127.0.0.1:$PORT;#" "$CONF"
    fi
    if ! nginx -t 2>/dev/null; then
      nginx -t || true
      rm -f "$CONF" ${LINK:+"$LINK"}
      die "nginx config test failed; removed the new site. Your other sites were not touched."
    fi
    systemctl reload nginx
    get_cert nginx
    ;;
  caddy*)
    log "Adding Caddy site for $DOMAIN"
    CF=/etc/caddy/Caddyfile
    cp "$CF" "$CF.bak.$(date +%s)"
    if ! grep -q "^$DOMAIN {" "$CF"; then
      printf '\n%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" >> "$CF"
    else
      sed -i -E "/^$DOMAIN \{/,/^\}/ s#reverse_proxy 127\.0\.0\.1:[0-9]+#reverse_proxy 127.0.0.1:$PORT#" "$CF"
    fi
    if ! caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then
      cp "$(ls -t "$CF".bak.* | head -1)" "$CF"
      die "Caddy config validation failed; restored the previous Caddyfile."
    fi
    systemctl reload caddy
    dns_ok || CERT_NOTE="DNS for $DOMAIN does not point here yet. Caddy will get the HTTPS certificate automatically once it does."
    ;;
  apache2*|httpd*)
    log "Adding Apache site for $DOMAIN"
    a2enmod -q proxy proxy_http headers >/dev/null
    CONF=/etc/apache2/sites-available/$DOMAIN.conf
    cat > "$CONF" <<EOF
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
    RequestHeader set X-Forwarded-Proto "http"
</VirtualHost>
EOF
    a2ensite -q "$DOMAIN" >/dev/null
    if ! apachectl configtest 2>/dev/null; then
      a2dissite -q "$DOMAIN" >/dev/null; rm -f "$CONF"
      die "Apache config test failed; removed the new site. Your other sites were not touched."
    fi
    systemctl reload apache2
    get_cert apache
    ;;
  "")
    log "No web server found; installing Caddy (automatic HTTPS)"
    apt_update; apt-get install -y -qq caddy >/dev/null
    CF=/etc/caddy/Caddyfile
    if grep -q '/usr/share/caddy' "$CF" 2>/dev/null; then : > "$CF"; fi
    grep -q "^$DOMAIN {" "$CF" 2>/dev/null || printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" >> "$CF"
    caddy validate --config "$CF" --adapter caddyfile >/dev/null
    systemctl enable --quiet caddy; systemctl restart caddy
    dns_ok || CERT_NOTE="DNS for $DOMAIN does not point here yet. Caddy will get the HTTPS certificate automatically once it does."
    ;;
  *)
    warn "Port 80 is served by '$WEB' (for example Docker/Traefik), which this script can't configure automatically."
    warn "The app is running at http://127.0.0.1:$PORT. Point your proxy for $DOMAIN at it."
    ;;
esac

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

# ---------------------------------------------------------------- done
log "Done"
echo "  Dashboard:  https://$DOMAIN"
echo "  Login:      any username + the admin password"
if [ -n "$NEW_PASSWORD" ]; then
  printf '  Password:   \033[1m%s\033[0m   (save it now; it is stored in %s)\n' "$NEW_PASSWORD" "$ENV_FILE"
else
  echo "  Password:   unchanged (see ADMIN_PASSWORD in $ENV_FILE)"
fi
echo "  Service:    systemctl status $SERVICE  |  journalctl -u $SERVICE -f"
echo "  Database:   $DATA_DIR/qr.db"
[ -n "$CERT_NOTE" ] && warn "$CERT_NOTE"
exit 0
