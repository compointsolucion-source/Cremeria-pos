#!/usr/bin/env bash
# Compila el instalador BASE de Compoint (Windows 64 bits): es el .exe con la pantalla y la lógica.
# El instalador que se le entrega al cliente es este mismo .exe con el instalador del programa pegado
# al final (lo hace  escritorio/scripts/empaquetar-instalador.js  en GitHub Actions).
#
# Uso:  ./construir.sh [archivo-de-salida]      (por defecto  ../../escritorio/dist/instalador-base.exe)
# Requiere Go 1.21 o más nuevo. Se puede correr en Windows (Git Bash), Mac o Linux.
set -euo pipefail
cd "$(dirname "$0")"
SALIDA="${1:-../../escritorio/dist/instalador-base.exe}"
# El icono, el manifiesto y los datos de versión ya están en rsrc_windows_amd64.syso.
# Si cambias algo de recursos/, vuelve a generarlo (necesita Python 3):
if [ "${REGENERAR_RECURSOS:-0}" = "1" ]; then python3 recursos/generar_syso.py; fi
mkdir -p "$(dirname "$SALIDA")"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags "-H=windowsgui -s -w" -o "$SALIDA" .
echo "Listo: $SALIDA"
