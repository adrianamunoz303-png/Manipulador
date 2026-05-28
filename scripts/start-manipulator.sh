#!/usr/bin/env bash
# Solo desarrollo LOCAL (Mac/PC): Node + abrir /manipulador en el navegador.
# Para la Raspberry usa: ./scripts/pi-arrancar-panel.sh
#
# Uso: ./scripts/start-manipulator.sh
#      PORT=8080 ./scripts/start-manipulator.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3000}"
export PORT
URL="http://127.0.0.1:${PORT}/manipulador"

echo "────────────────────────────────────────"
echo "  Manipulador → ${URL}"
echo "  (API serie: mismo puerto)"
echo "────────────────────────────────────────"

# Abre el navegador un momento después de que arranque el servidor
(
  sleep 2
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  fi
) &

exec node server.js
