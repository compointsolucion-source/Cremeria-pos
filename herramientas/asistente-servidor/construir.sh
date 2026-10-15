#!/usr/bin/env bash
# Compila Asistente-Servidor-Compoint.exe (Windows 64 bits) y lo deja en frontend/descargas.
# Requiere Go 1.21 o más nuevo. Se puede correr en Windows (Git Bash), Mac o Linux.
set -euo pipefail
cd "$(dirname "$0")"
python3 recursos/generar_syso.py          # icono + manifiesto + versión
mkdir -p ../../frontend/descargas
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags "-H=windowsgui -s -w" \
  -o ../../frontend/descargas/Asistente-Servidor-Compoint.exe .
echo "Listo: frontend/descargas/Asistente-Servidor-Compoint.exe"
