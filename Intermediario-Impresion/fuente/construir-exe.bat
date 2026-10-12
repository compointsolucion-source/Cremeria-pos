@echo off
rem Reconstruye IntermediarioImpresion.exe (necesita Node.js 20 o 22 instalado).
cd /d "%~dp0"
call npm install || goto :error
call npx esbuild server.js --bundle --platform=node --format=cjs --outfile=bundle.js || goto :error
node --experimental-sea-config sea-config.json || goto :error
if not exist dist mkdir dist
for /f "delims=" %%i in ('where node') do copy /y "%%i" dist\IntermediarioImpresion.exe >nul & goto :copiado
:copiado
call npx postject dist\IntermediarioImpresion.exe NODE_SEA_BLOB sea.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 || goto :error
echo.
echo Listo: dist\IntermediarioImpresion.exe
pause
exit /b
:error
echo Algo salio mal.
pause
