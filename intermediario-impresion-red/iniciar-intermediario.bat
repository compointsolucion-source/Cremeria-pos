@echo off
title Intermediario de Impresion - Cremeria POS
cd /d "%~dp0"

echo ========================================================
echo   Intermediario de Impresion por Red - Cremeria POS
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: No se encontro Node.js instalado en esta computadora.
    echo.
    echo Descargalo gratis desde: https://nodejs.org
    echo Elige la version "LTS", instalala, y vuelve a abrir este archivo.
    echo.
    pause
    exit /b
)

if not exist "node_modules" (
    echo Primera vez usando esto en esta computadora - instalando...
    echo Esto puede tardar un minuto, es normal.
    echo.
    call npm install
    echo.
)

echo Iniciando el intermediario...
echo NO CIERRES esta ventana mientras quieras poder imprimir fichas por red.
echo.
call npm start

pause
