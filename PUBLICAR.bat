@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Publicar Dimensional Studio Launcher
echo.
echo  === Publicar Dimensional Studio Launcher en GitHub ===
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo  Git no esta instalado. Descargalo de https://git-scm.com/download/win , instalalo y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js no esta instalado. Descargalo de https://nodejs.org , instalalo y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)

for /f "usebackq" %%v in (`node -p "require('./package.json').version"`) do set VER=%%v
echo  Version a publicar: v%VER%
echo.

if not exist ".git" git init
git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/uwhuadaudjsnndaj/launcher-dimensional.git

rem Si GitHub ya tiene versiones anteriores, se continua sobre ese historial (sin borrar nada)
git fetch origin >nul 2>nul
git rev-parse --verify origin/main >nul 2>nul
if not errorlevel 1 (
  git merge-base --is-ancestor origin/main HEAD >nul 2>nul
  if errorlevel 1 git reset --soft origin/main
)

git add .
git commit -m "Version %VER%"
git push -u origin main
if errorlevel 1 (
  echo.
  echo  No se pudo subir el codigo. Revisa el mensaje de arriba.
  pause
  exit /b 1
)

git rev-parse "v%VER%" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo  La version v%VER% ya fue publicada antes. Para sacar una actualizacion,
  echo  sube el numero de "version" en package.json ^(ej. de 1.1.0 a 1.1.1^) y ejecuta este archivo otra vez.
  pause
  exit /b 1
)

git tag v%VER%
git push origin v%VER%
if errorlevel 1 (
  echo.
  echo  No se pudo publicar la version. Revisa el mensaje de arriba.
  pause
  exit /b 1
)

echo.
echo  Listo. GitHub esta construyendo el instalador (unos 5 minutos).
echo  Cuando termine lo veras en:
echo  https://github.com/uwhuadaudjsnndaj/launcher-dimensional/releases
echo.
pause
