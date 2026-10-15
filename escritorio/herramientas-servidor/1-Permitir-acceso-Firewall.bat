@echo off
title Compoint Punto - Permitir acceso en el Firewall
chcp 65001 >nul
color 0F

:: --- Pide permisos de administrador solo (si no los tiene) ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Pidiendo permisos de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================================
echo   COMPOINT PUNTO - Permitir que otras computadoras entren
echo ============================================================
echo.

:: Quita reglas anteriores para no duplicar
netsh advfirewall firewall delete rule name="Compoint Punto (web 3000)" >nul 2>&1
netsh advfirewall firewall delete rule name="Compoint Punto (descubrimiento)" >nul 2>&1

:: Regla de entrada para el puerto del sistema (red privada, de dominio y publica)
netsh advfirewall firewall add rule name="Compoint Punto (web 3000)" dir=in action=allow protocol=TCP localport=3000 profile=any
if %errorlevel% neq 0 goto :error

:: Permite tambien que responda a pings (ayuda a diagnosticar)
netsh advfirewall firewall set rule name="Archivo e impresora compartidos (solicitud de eco: ICMPv4 de entrada)" new enable=yes >nul 2>&1
netsh advfirewall firewall set rule name="File and Printer Sharing (Echo Request - ICMPv4-In)" new enable=yes >nul 2>&1

:: Si la red esta marcada como "Publica", la pasa a "Privada" (si no, Windows bloquea muchas cosas)
powershell -NoProfile -Command "Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -ne 'Disconnected' -and $_.InterfaceAlias -notmatch 'Loopback' } | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private }" >nul 2>&1

echo.
echo   LISTO. El Firewall ya permite el acceso al puerto 3000.
echo.
echo   En las otras computadoras, abre el navegador y escribe UNA de estas
echo   direcciones (la que empieza con 192.168 o 10. es la de tu red):
echo.
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { '      http://' + $_.IPAddress + ':3000' }"
echo.
echo   IMPORTANTE: esta computadora debe tener IP FIJA y estar encendida
echo   con Compoint Punto abierto.
echo.
pause
exit /b 0

:error
echo.
echo   No se pudo crear la regla. Cierra esta ventana, da clic derecho al
echo   archivo y elige "Ejecutar como administrador".
echo.
pause
exit /b 1
