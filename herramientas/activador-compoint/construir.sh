#!/usr/bin/env bash
# Compila Activador-Compoint.exe (Windows 64 bits) y lo deja en herramientas/activador-compoint/salida
# (esa carpeta NO se sube a GitHub: el Activador es solo para Compoint, no para los clientes).
# Requiere Go 1.21 o más nuevo. Se puede correr en Windows (Git Bash), Mac o Linux.
set -euo pipefail
cd "$(dirname "$0")"
python3 recursos/generar_syso.py          # icono + manifiesto + versión
mkdir -p salida
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags "-H=windowsgui -s -w" \
  -o salida/Activador-Compoint.exe .
echo "Listo: herramientas/activador-compoint/salida/Activador-Compoint.exe"
