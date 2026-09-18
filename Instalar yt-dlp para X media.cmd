@echo off
rem ---------------------------------------------------------------------------
rem  Descargador de medios para X  ·  servicio de yt-dlp para YouTube
rem
rem  Instala (o repara) el host de mensajería nativa que permite a la extensión
rem  descargar vídeos de YouTube con yt-dlp. No necesita permisos de
rem  administrador y no abre ningún puerto: todo va al perfil del usuario.
rem
rem  Para desinstalarlo:  "Instalar yt-dlp para X media.cmd" quitar
rem ---------------------------------------------------------------------------
setlocal
set "AQUI=%~dp0"
set "PS=powershell.exe"
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if /I "%~1"=="quitar" (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%AQUI%instalar-ytdlp.ps1" -Quitar
) else (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%AQUI%instalar-ytdlp.ps1" %*
)

echo.
pause
endlocal
