@echo off
chcp 65001 >nul
echo ============================================
echo   PUBLICAR ACTUALIZACION A TODOS LOS CLIENTES
echo   (pasa lo probado en main a la rama estable)
echo ============================================
echo.

for /f %%b in ('git branch --show-current') do set RAMA=%%b
if not "%RAMA%"=="main" (
  echo ALTO: debes estar en la rama main y estas en %RAMA%.
  echo Escribe: git checkout main
  goto fin
)

git diff --quiet
if errorlevel 1 (
  echo ALTO: tienes cambios sin guardar. Haz Commit y Sync Changes en VS Code y vuelve a intentar.
  goto fin
)
git diff --cached --quiet
if errorlevel 1 (
  echo ALTO: tienes cambios sin guardar. Haz Commit y Sync Changes en VS Code y vuelve a intentar.
  goto fin
)

echo 1/4 Subiendo main a GitHub...
git push origin main
if errorlevel 1 goto error

echo 2/4 Preparando la rama estable...
git fetch origin
git rev-parse --verify estable >nul 2>&1
if errorlevel 1 (
  git rev-parse --verify origin/estable >nul 2>&1
  if errorlevel 1 (
    git branch estable main
  ) else (
    git branch estable origin/estable
  )
)

echo 3/4 Pasando los cambios probados a estable...
git checkout estable
if errorlevel 1 goto error
git merge --ff-only origin/main
if errorlevel 1 (
  git merge --ff-only main
  if errorlevel 1 goto error
)

echo 4/4 Subiendo estable a GitHub (Render actualiza a todos los clientes)...
git push -u origin estable
if errorlevel 1 (
  git checkout main
  goto error
)

git checkout main
echo.
echo LISTO. En unos minutos Render actualiza los servidores y las paginas de todos los clientes.
goto fin

:error
echo.
echo ALGO SALIO MAL. No se publico a los clientes. Mandame una captura de este mensaje.
git checkout main >nul 2>&1

:fin
echo.
pause
