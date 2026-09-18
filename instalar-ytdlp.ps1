<#
 * Descargador de medios para X — Instalador del servicio de yt-dlp
 * ===========================================================================
 * Qué hace (y por qué):
 *   YouTube dejó de entregar archivos descargables al reproductor web (usa SABR
 *   y firma las URLs), así que la extensión no puede bajarlos por sí misma. La
 *   descarga la hace yt-dlp, que ya sabe hacerlo y se actualiza a menudo.
 *
 *   Para que la extensión pueda lanzarlo sin abrir puertos ni dejar procesos
 *   en segundo plano, se instala un HOST DE MENSAJERÍA NATIVA de Chrome:
 *     1. Compila native\ytdlp-host.exe con el compilador de .NET Framework.
 *     2. Copia el ejecutable y su manifiesto a %LOCALAPPDATA%\XVD-YTDLP.
 *     3. Registra el manifiesto en el registro de Windows (solo para el usuario)
 *        en Chrome, Chromium y Edge.
 *     4. Comprueba yt-dlp y ffmpeg, y actualiza yt-dlp si hace falta.
 *
 * Uso:
 *   powershell -ExecutionPolicy Bypass -File instalar-ytdlp.ps1
 *   powershell -ExecutionPolicy Bypass -File instalar-ytdlp.ps1 -IdExtension <id> -Quitar
 *
 * Nada de esto necesita permisos de administrador: todo va al perfil del usuario.
#>

[CmdletBinding()]
param(
  # Id de la extensión. Por defecto se autorizan los dos conocidos (repositorio y
  # copia del Escritorio); si instalas la extensión en otra carpeta, pásale el id.
  [string]$IdExtension = '',
  # Desinstala: borra el registro y la carpeta del host.
  [switch]$Quitar,
  [switch]$NoActualizar
)

$ErrorActionPreference = 'Stop'
$NombreHost = 'com.tacosandtypescript.xvd'
$Destino = Join-Path $env:LOCALAPPDATA 'XVD-YTDLP'
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path

function Linea { param([string]$Texto = '') Write-Host $Texto }
function Bien { param([string]$Texto) Write-Host "  [OK]    $Texto" -ForegroundColor Green }
function Aviso { param([string]$Texto) Write-Host "  [AVISO] $Texto" -ForegroundColor Yellow }
function Fallo { param([string]$Texto) Write-Host "  [FALLO] $Texto" -ForegroundColor Red }

Linea ('=' * 74)
Linea ' Descargador de medios para X  ·  servicio de yt-dlp para YouTube'
Linea ('=' * 74)
Linea " Extensión : $Raiz"
Linea " Destino   : $Destino"
Linea ''

# ---------------------------------------------------------------- desinstalar --
if ($Quitar) {
  $Claves = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NombreHost",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$NombreHost",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NombreHost"
  )
  foreach ($Clave in $Claves) {
    if (Test-Path $Clave) { Remove-Item -Path $Clave -Recurse -Force; Bien "quitado $Clave" }
  }
  if (Test-Path $Destino) { Remove-Item -Path $Destino -Recurse -Force; Bien "borrada la carpeta $Destino" }
  Linea ''
  Linea 'Listo. Cierra y vuelve a abrir Chrome para que se aplique.'
  exit 0
}

# ---------------------------------------------------------------- 1. compilar --
Linea '1. COMPILAR EL HOST'

$Fuente = Join-Path $Raiz 'native\ytdlp-host.cs'
if (-not (Test-Path $Fuente)) { Fallo "no encuentro $Fuente"; exit 1 }

$Csc = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not (Test-Path $Destino)) { New-Item -ItemType Directory -Path $Destino -Force | Out-Null }
$Exe = Join-Path $Destino 'ytdlp-host.exe'
$ExeIncluido = Join-Path $Raiz 'native\ytdlp-host.exe'

if (-not $Csc) {
  # Sin compilador disponible: se usa el ejecutable que ya viene compilado.
  if (-not (Test-Path $ExeIncluido)) {
    Fallo 'no encuentro el compilador de .NET Framework (csc.exe) ni un host ya compilado.'
    Linea '  Instala .NET Framework 4.x (viene de serie en Windows 10/11) y reinténtalo.'
    exit 1
  }
  Copy-Item -Path $ExeIncluido -Destination $Exe -Force
  Aviso 'no hay compilador de .NET; se usa el ejecutable ya compilado que viene incluido.'
} else {
  & $Csc /nologo /target:exe /optimize+ /out:$Exe /r:System.Web.Extensions.dll $Fuente | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Exe)) {
    if (Test-Path $ExeIncluido) {
      Copy-Item -Path $ExeIncluido -Destination $Exe -Force
      Aviso 'la compilación falló; se usa el ejecutable ya compilado que viene incluido.'
    } else {
      Fallo 'la compilación del host ha fallado.'
      exit 1
    }
  } else {
    Bien ("host compilado: {0:N0} bytes en {1}" -f (Get-Item $Exe).Length, $Exe)
  }
}

# ------------------------------------------------------------- 2. manifiesto ---
Linea ''
Linea '2. MANIFIESTO Y REGISTRO'

# Ids conocidos: el repositorio y la copia del Escritorio. El id de una extensión
# desempaquetada sale de la ruta de su carpeta, así que es estable.
$Ids = New-Object System.Collections.Generic.List[string]
if ($IdExtension) { $Ids.Add($IdExtension) }
foreach ($Conocido in @('kefbpcihpoafmakmomibcfadndccljba', 'fnefhbljpbjognpoplmlffbolchihjli')) {
  if (-not $Ids.Contains($Conocido)) { $Ids.Add($Conocido) }
}

# Se autorizan también los ids que aparezcan en cualquier carpeta del usuario con
# el mismo nombre, para que reinstalar en otro sitio no rompa nada.
$Origenes = @()
foreach ($Id in $Ids) { $Origenes += "chrome-extension://$Id/" }

$Manifiesto = [ordered]@{
  name           = $NombreHost
  description    = 'Descarga vídeos de YouTube para la extensión Descargador de medios para X usando yt-dlp'
  path           = $Exe
  type           = 'stdio'
  allowed_origins = $Origenes
}
$RutaManifiesto = Join-Path $Destino "$NombreHost.json"
$Json = $Manifiesto | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($RutaManifiesto, $Json, (New-Object System.Text.UTF8Encoding($false)))
Bien "manifiesto escrito: $RutaManifiesto"
foreach ($Origen in $Origenes) { Linea "          autoriza $Origen" }

$Claves = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NombreHost",
  "HKCU:\Software\Chromium\NativeMessagingHosts\$NombreHost",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NombreHost"
)
foreach ($Clave in $Claves) {
  if (-not (Test-Path $Clave)) { New-Item -Path $Clave -Force | Out-Null }
  Set-ItemProperty -Path $Clave -Name '(default)' -Value $RutaManifiesto
}
Bien 'registrado en Chrome, Chromium y Edge (solo para tu usuario)'

# --------------------------------------------------------------- 3. yt-dlp -----
Linea ''
Linea '3. YT-DLP Y FFMPEG'

function Buscar-Programa {
  param([string]$Nombre, [string[]]$Rutas)
  foreach ($Ruta in $Rutas) { if ($Ruta -and (Test-Path $Ruta)) { return $Ruta } }
  $Orden = Get-Command $Nombre -ErrorAction SilentlyContinue
  if ($Orden) { return $Orden.Source }
  return ''
}

$RutasYtDlp = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts\yt-dlp.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\Scripts\yt-dlp.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\Scripts\yt-dlp.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\yt-dlp.exe')
)
$YtDlp = Buscar-Programa -Nombre 'yt-dlp' -Rutas $RutasYtDlp

if (-not $YtDlp) {
  Aviso 'no se encuentra yt-dlp; se intenta instalar con winget…'
  $Winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($Winget) {
    & winget install --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements --silent | Out-Null
    $YtDlp = Buscar-Programa -Nombre 'yt-dlp' -Rutas $RutasYtDlp
  }
}
if ($YtDlp) { Bien "yt-dlp: $YtDlp" } else {
  Fallo 'no hay yt-dlp. Instálalo con «winget install yt-dlp.yt-dlp» y vuelve a ejecutar esto.'
}

$Ffmpeg = Buscar-Programa -Nombre 'ffmpeg' -Rutas @((Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'))
if ($Ffmpeg) { Bien "ffmpeg: $Ffmpeg" } else {
  Aviso 'no se encuentra ffmpeg: sin él no se pueden unir imagen y sonido ni generar MP3.'
  Linea '          Se instala con:  winget install Gyan.FFmpeg'
}

if ($YtDlp -and -not $NoActualizar) {
  $Version = (& $YtDlp --version) 2>$null
  Linea "          versión instalada: $Version"
  if ($YtDlp -like '*\Scripts\yt-dlp.exe') {
    $Python = Buscar-Programa -Nombre 'python' -Rutas @(
      (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe')
    )
    if ($Python) {
      Linea '          actualizando con pip (puede tardar un poco)…'
      & $Python -m pip install -U --quiet yt-dlp 2>&1 | Out-Null
    }
  } else {
    Linea '          actualizando con yt-dlp -U…'
    & $YtDlp -U 2>&1 | Out-Null
  }
  $Nueva = (& $YtDlp --version) 2>$null
  if ($Nueva -ne $Version) { Bien "yt-dlp actualizado: $Version -> $Nueva" } else { Bien "yt-dlp ya estaba al día ($Nueva)" }
}

# ------------------------------------------------------------- 4. comprobar ----
Linea ''
Linea '4. COMPROBACIÓN'

$Peticion = [ordered]@{ accion = 'estado' } | ConvertTo-Json -Compress
$Bytes = [System.Text.Encoding]::UTF8.GetBytes($Peticion)
$Cabecera = [BitConverter]::GetBytes([int]$Bytes.Length)

try {
  $Psi = New-Object System.Diagnostics.ProcessStartInfo
  $Psi.FileName = $Exe
  $Psi.RedirectStandardInput = $true
  $Psi.RedirectStandardOutput = $true
  $Psi.UseShellExecute = $false
  $Psi.CreateNoWindow = $true
  $Proceso = [System.Diagnostics.Process]::Start($Psi)
  $Proceso.StandardInput.BaseStream.Write($Cabecera, 0, 4)
  $Proceso.StandardInput.BaseStream.Write($Bytes, 0, $Bytes.Length)
  $Proceso.StandardInput.Close()
  $LargoBytes = New-Object byte[] 4
  $Proceso.StandardOutput.BaseStream.Read($LargoBytes, 0, 4) | Out-Null
  $Largo = [BitConverter]::ToInt32($LargoBytes, 0)
  $Cuerpo = New-Object byte[] $Largo
  $Proceso.StandardOutput.BaseStream.Read($Cuerpo, 0, $Largo) | Out-Null
  $Proceso.WaitForExit(15000) | Out-Null
  $Estado = [System.Text.Encoding]::UTF8.GetString($Cuerpo) | ConvertFrom-Json
  Bien "el host responde: yt-dlp $($Estado.version) · ffmpeg=$($Estado.ffmpeg)"
  Linea "          descargas de YouTube en: $($Estado.descargas)"
} catch {
  Fallo "el host no respondió: $($_.Exception.Message)"
}

Linea ''
Linea ('=' * 74)
Linea ' Listo. Si Chrome estaba abierto, recarga la extensión (botón ↻ en'
Linea ' chrome://extensions) y prueba a descargar un vídeo de YouTube.'
Linea ('=' * 74)
