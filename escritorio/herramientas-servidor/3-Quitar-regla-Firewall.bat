@echo off
title Compoint Punto - Quitar regla del Firewall
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="Compoint Punto (web 3000)"
echo.
echo   Regla eliminada. Otras computadoras ya no podran entrar a esta.
echo.
pause
