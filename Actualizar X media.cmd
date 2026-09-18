@echo off
rem ---------------------------------------------------------------------------
rem  Actualiza el Descargador de medios para X desde GitHub y abre Chrome para
rem  que pulses el boton de recargar en la tarjeta de la extension.
rem  Doble clic sobre este archivo.
rem ---------------------------------------------------------------------------
setlocal
set "CARPETA=%~dp0Descargador-X-media"
if not exist "%CARPETA%\manifest.json" set "CARPETA=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%CARPETA%\actualizar.ps1" -Destino "%CARPETA%"
endlocal
