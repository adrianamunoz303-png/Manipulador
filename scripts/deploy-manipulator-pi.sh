#!/usr/bin/env bash
# Copia manipulator.html y manipulator-serial.js a la Raspberry (moule3d).
# Uso (desde la carpeta del repo o con ruta absoluta):
#   chmod +x scripts/deploy-manipulator-pi.sh
#   ./scripts/deploy-manipulator-pi.sh
#
# Variables opcionales:
#   PI_HOST=192.168.68.130 PI_USER=moule3d PI_REMOTE='~/moule3d/public/manipulator.html' ./scripts/deploy-manipulator-pi.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_HTML="${ROOT}/manipulator.html"
LOCAL_SERIAL="${ROOT}/manipulator-serial.js"
HOST="${PI_HOST:-192.168.68.130}"
USER="${PI_USER:-moule3d}"
REMOTE_HTML="${PI_REMOTE_HTML:-~/moule3d/public/manipulator.html}"
REMOTE_SERIAL="${PI_REMOTE_SERIAL:-~/moule3d/manipulator-serial.js}"

if [[ ! -f "$LOCAL_HTML" ]]; then
  echo "No existe: $LOCAL_HTML" >&2
  exit 1
fi

if [[ ! -f "$LOCAL_SERIAL" ]]; then
  echo "No existe: $LOCAL_SERIAL" >&2
  exit 1
fi

echo "Subiendo HTML a ${USER}@${HOST}:${REMOTE_HTML} ..."
scp "$LOCAL_HTML" "${USER}@${HOST}:${REMOTE_HTML}"
echo "Subiendo bridge serie a ${USER}@${HOST}:${REMOTE_SERIAL} ..."
scp "$LOCAL_SERIAL" "${USER}@${HOST}:${REMOTE_SERIAL}"
echo "Listo. Reinicia node server.js en la Pi y recarga el navegador."
