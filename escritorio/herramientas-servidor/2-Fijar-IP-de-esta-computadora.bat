@echo off
title Compoint Punto - Fijar IP de esta computadora
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo ============================================================
echo   Convierte la IP actual de esta computadora en IP FIJA
echo   (la misma direccion siempre, para que las demas la encuentren)
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$c = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1;" ^
 "if (-not $c) { Write-Host 'No se encontro una conexion de red activa.'; exit 1 }" ^
 "$ip = $c.IPv4Address.IPAddress; $pre = $c.IPv4Address.PrefixLength; $gw = $c.IPv4DefaultGateway.NextHop; $dns = @($c.DnsServer.ServerAddresses | Where-Object { $_ -notmatch ':' });" ^
 "Write-Host ('Conexion: ' + $c.InterfaceAlias); Write-Host ('IP actual: ' + $ip + '   Puerta de enlace: ' + $gw);" ^
 "$r = Read-Host 'Escribe S para dejar esta IP como fija (cualquier otra tecla cancela)';" ^
 "if ($r -ne 'S' -and $r -ne 's') { Write-Host 'Cancelado.'; exit 0 }" ^
 "Remove-NetIPAddress -InterfaceIndex $c.InterfaceIndex -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue;" ^
 "Remove-NetRoute -InterfaceIndex $c.InterfaceIndex -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue;" ^
 "New-NetIPAddress -InterfaceIndex $c.InterfaceIndex -IPAddress $ip -PrefixLength $pre -DefaultGateway $gw | Out-Null;" ^
 "if ($dns.Count -eq 0) { $dns = @($gw) }; Set-DnsClientServerAddress -InterfaceIndex $c.InterfaceIndex -ServerAddresses $dns;" ^
 "Write-Host ('Listo. IP fija: ' + $ip)"
echo.
echo   Nota: si tu router reparte IPs automaticamente, lo ideal es ademas
echo   "reservar" esta IP en el router para que no la use otro equipo.
echo.
pause
