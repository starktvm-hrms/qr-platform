#!/usr/bin/env bash
# Bundles the app into a single self-contained installer script.
# Usage: deploy/build-installer.sh [domain]   -> deploy/install-qr-platform.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${1:-qr.starkpeople.in}"
OUT=deploy/install-qr-platform.sh

# every top-level .js file (server, db, geo, ...) plus the dashboard
B64=$(tar --owner=0 --group=0 -czf - package.json package-lock.json ./*.js public | base64 -w 76)
python3 - "$DOMAIN" "$OUT" <<PY
import sys
domain, out = sys.argv[1], sys.argv[2]
t = open('deploy/install.template.sh').read()
t = t.replace('__DOMAIN__', domain).replace('__APP_B64__', '''$B64''')
open(out, 'w').write(t)
PY
chmod +x "$OUT"
echo "Built $OUT ($(wc -c < "$OUT") bytes) for $DOMAIN"
