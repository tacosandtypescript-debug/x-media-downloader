<#
    Actualizador del Descargador de medios para X
    ---------------------------------------------------------------------------
    Descarga la última versión publicada en GitHub y la copia sobre la carpeta de
    la extensión. Después abre chrome://extensions para que pulses ↻.

    ¿Por qué un script y no solo un botón en la extensión? Porque Chrome prohíbe
    que una extensión lea o escriba sus propios archivos: el navegador solo
    permite recargarla (botón ↻), no sustituirla. Este script hace la parte que
    la extensión no puede hacer.

    Uso:
        powershell -ExecutionPolicy Bypass -File actualizar.ps1
        powershell -ExecutionPolicy Bypass -File actualizar.ps1 -Destino "C:\ruta\a\la\extension"
#>

[CmdletBinding()]
param(
    [string]$Destino = $PSScriptRoot,
    [string]$Repositorio = 'tacosandtypescript-debug/x-media-downloader',
    [string]$Rama = 'main',
    [switch]$NoAbrirChrome
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Leer-Version([string]$carpeta) {
    $manifest = Join-Path $carpeta 'manifest.json'
    if (-not (Test-Path $manifest)) { return $null }
    try { return (Get-Content $manifest -Raw | ConvertFrom-Json).version } catch { return $null }
}

Write-Host ''
Write-Host '  Descargador de medios para X :: actualizador' -ForegroundColor Cyan
Write-Host '  --------------------------------------------' -ForegroundColor DarkGray
Write-Host "  Carpeta de la extension : $Destino"

if (-not (Test-Path (Join-Path $Destino 'manifest.json'))) {
    Write-Host "  ERROR: en esa carpeta no hay manifest.json." -ForegroundColor Red
    Write-Host '  Pasa la carpeta correcta con -Destino "C:\ruta\a\la\extension".' -ForegroundColor Red
    exit 1
}

$versionAntes = Leer-Version $Destino
Write-Host "  Version instalada       : $versionAntes"

$zip = Join-Path $env:TEMP ("xvd-actualizacion-" + (Get-Random) + '.zip')
$extraido = Join-Path $env:TEMP ("xvd-actualizacion-" + (Get-Random))

$url = "https://codeload.github.com/$Repositorio/zip/refs/heads/$Rama"
Write-Host "  Descargando             : $url"

try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -Headers @{ 'User-Agent' = 'xvd-updater' }
} catch {
    Write-Host ''
    Write-Host '  ERROR: no se pudo descargar la ultima version.' -ForegroundColor Red
    Write-Host "  Detalle: $($_.Exception.Message)" -ForegroundColor DarkGray
    Write-Host '  Comprueba la conexion a Internet o descarga el ZIP a mano desde:' -ForegroundColor DarkGray
    Write-Host "  https://github.com/$Repositorio" -ForegroundColor DarkGray
    exit 1
}

Write-Host '  Descomprimiendo...'
Expand-Archive -Path $zip -DestinationPath $extraido -Force

$origen = Get-ChildItem $extraido -Directory | Select-Object -First 1
if (-not $origen) {
    Write-Host '  ERROR: el ZIP descargado no tiene el formato esperado.' -ForegroundColor Red
    exit 1
}

$versionNueva = Leer-Version $origen.FullName
Write-Host "  Version descargada      : $versionNueva"

# Se copia todo excepto el repositorio git, si lo hubiera.
Write-Host '  Copiando archivos...'
$salida = robocopy $origen.FullName $Destino /E /XD .git /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) {
    Write-Host "  ERROR: robocopy fallo (codigo $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extraido -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($versionAntes -eq $versionNueva) {
    Write-Host "  Archivos actualizados (la version sigue siendo la $versionNueva)." -ForegroundColor Green
} else {
    Write-Host "  Actualizado: $versionAntes  ->  $versionNueva" -ForegroundColor Green
}

Write-Host ''
Write-Host '  ULTIMO PASO (Chrome no lo permite hacer solo):' -ForegroundColor Yellow
Write-Host '    1. En la pagina que se va a abrir, pulsa el boton  ↻  de la tarjeta' -ForegroundColor Yellow
Write-Host '       "Descargador de medios para X".' -ForegroundColor Yellow
Write-Host '    2. Las pestanas de X se recargan solas para aplicar el codigo nuevo.' -ForegroundColor Yellow
Write-Host ''

if (-not $NoAbrirChrome) {
    try { Start-Process 'chrome.exe' 'chrome://extensions/' -ErrorAction Stop }
    catch {
        foreach ($ruta in @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
            "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
        )) {
            if (Test-Path $ruta) { Start-Process $ruta 'chrome://extensions/'; break }
        }
    }
}

if ($Host.Name -eq 'ConsoleHost' -and -not $env:XVD_SIN_PAUSA) {
    Write-Host '  Pulsa una tecla para cerrar...' -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}
