#!/usr/bin/env bash
# Arranca el servidor Node.js en la Raspberry (panel + /manipulador + API serie).
# Ejecutar desde tu Mac (o PC) con la Pi encendida y accesible por SSH.
#
# Uso:
#   ./scripts/pi-arrancar-panel.sh
#   PI_HOST=192.168.68.130 PI_USER=moule3d ./scripts/pi-arrancar-panel.sh
#   PI_WORKDIR=moule3d BACKGROUND=1 ./scripts/pi-arrancar-panel.sh
#
# Variables:
#   PI_HOST      IP o hostname (default: 192.168.68.130)
#   PI_USER      usuario SSH (default: moule3d)
#   PI_WORKDIR   carpeta bajo $HOME en la Pi donde está server.js (default: moule3d)
#   PORT         puerto HTTP (default: 3001)
#   BACKGROUND=1 arranca en segundo plano en la Pi (logs en /tmp/moule3d.log)

set -euo pipefail

PI_HOST="${PI_HOST:-192.168.68.130}"
PI_USER="${PI_USER:-moule3d}"
PI_WORKDIR="${PI_WORKDIR:-moule3d}"
PORT="${PORT:-3001}"
URL="http://${PI_HOST}:${PORT}/manipulador"

echo "────────────────────────────────────────"
echo "  Raspberry: ${PI_USER}@${PI_HOST}"
echo "  Carpeta:   ~/${PI_WORKDIR}"
echo "  Panel:     ${URL}"
echo "────────────────────────────────────────"

if [[ "${BACKGROUND:-0}" == "1" ]]; then
  ssh "${PI_USER}@${PI_HOST}" bash -s <<EOF
set -euo pipefail
cd "\$HOME/${PI_WORKDIR}"
export PORT=${PORT}
if pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "Ya hay un node server.js en ejecución. PID: \$(pgrep -f 'node server.js' | tr '\\n' ' ')"
  exit 0
fi
nohup node server.js >> /tmp/moule3d.log 2>&1 &
sleep 1
echo "Log reciente:"
tail -5 /tmp/moule3d.log || true
echo ""
echo "Abre en el navegador (en la Pi o en la red): ${URL}"
EOF
else
  echo "Modo primer plano (Ctrl+C para parar el servidor en la Pi)."
  echo ""
  ssh -t "${PI_USER}@${PI_HOST}" "bash -lc 'cd \"\$HOME/${PI_WORKDIR}\" && export PORT=${PORT} && exec node server.js'"
fi
