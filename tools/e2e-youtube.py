#!/usr/bin/env python3
"""
Prueba end-to-end del módulo de YOUTUBE con red REAL y con el host nativo.

Qué comprueba (de verdad, sin simular nada)
-------------------------------------------
1. Que la extensión se inyecta en una página real de youtube.com y pone el botón
   encima del reproductor.
2. Que el popup ve el servicio de yt-dlp (mensajería nativa de Chrome al
   ejecutable instalado por «Instalar yt-dlp para X media.cmd»).
3. Que al pulsar «Descargar» se lanza yt-dlp y el archivo aparece donde debe:
   MP4 (imagen + sonido), M4A (solo audio) y MP3, comprobados con ffprobe.
4. Que la carpeta elegida en el popup se respeta.
5. Que el progreso y el final llegan a la página (avisos en español).

Requisitos
----------
    pip install playwright
    playwright install chromium
    powershell -ExecutionPolicy Bypass -File instalar-ytdlp.ps1   (una vez)

Uso
---
    python tools/e2e-youtube.py            # sin ventana
    python tools/e2e-youtube.py --headed
    python tools/e2e-youtube.py VIDEO_ID
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HEADED = "--headed" in sys.argv
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
VIDEO_ID = ARGS[0] if ARGS else "dQw4w9WgXcQ"
CARPETA = "XVD Pruebas E2E"

WORK = Path(tempfile.gettempdir()) / "xvd-e2e-youtube"
SHOTS = WORK / "shots"
PROFILE = WORK / f"perfil-{int(time.time())}"
DESCARGAS = Path.home() / "Downloads"
DESTINO = DESCARGAS / CARPETA

for carpeta in (WORK, SHOTS):
    shutil.rmtree(carpeta, ignore_errors=True)
    carpeta.mkdir(parents=True, exist_ok=True)
shutil.rmtree(DESTINO, ignore_errors=True)
for viejo in WORK.glob("perfil-*"):
    shutil.rmtree(viejo, ignore_errors=True)

resultados = []
creados = []


def esperar(page, segundos):
    page.wait_for_timeout(int(float(segundos) * 1000))


def check(nombre, ok, detalle=""):
    resultados.append((nombre, bool(ok)))
    print(("  [OK]    " if ok else "  [FALLA] ") + nombre + (("  ->  " + str(detalle)) if detalle else ""))
    return bool(ok)


def registro(popup):
    """Registro de diagnóstico de la extensión (chrome.storage.session)."""
    try:
        return popup.evaluate(
            "() => new Promise(r => chrome.storage.session.get('xvd_log', s => r(s.xvd_log || [])))"
        )
    except Exception:  # noqa: BLE001
        return []


def con_registro(popup, texto):
    return [e for e in registro(popup) if texto in str(e.get("msg", ""))]


def ffprobe(ruta):
    """Pistas reales del archivo (imprescindible para creerse una descarga)."""
    try:
        salida = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(ruta)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        return json.loads(salida.stdout or "{}").get("streams", [])
    except Exception:  # noqa: BLE001
        return []


def resumen_pistas(pistas):
    partes = []
    for p in pistas:
        if p.get("codec_type") == "video":
            partes.append(f"video:{p.get('codec_name')} {p.get('width')}x{p.get('height')}")
        else:
            partes.append(f"audio:{p.get('codec_name')}")
    return " + ".join(partes) or "sin pistas"


def esperar_descarga(popup, desde, timeout=240):
    """Espera a que el registro diga que yt-dlp terminó y devuelve el archivo.

    El campo `detail` del registro es JSON, así que se lee como tal.
    """
    limite = time.time() + timeout
    while time.time() < limite:
        for e in registro(popup):
            if e.get("t", 0) < desde:
                continue
            try:
                detalle = json.loads(e.get("detail") or "{}")
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(detalle, dict):
                continue
            mensaje = str(e.get("msg", ""))
            if "yt-dlp terminó la descarga" in mensaje and detalle.get("archivo"):
                return detalle["archivo"]
            if "no pudo descargar" in mensaje or "yt-dlp no pudo" in mensaje:
                print(f"     yt-dlp falló: {detalle.get('motivo') or detalle.get('codigo')}")
                return None
        popup.wait_for_timeout(1000)
    return None


def ir_al_video(page, video_id):
    """Vuelve al vídeo de la prueba (YouTube navega solo al siguiente al acabar)."""
    page.goto(f"https://www.youtube.com/watch?v={video_id}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("button.xvd-button[data-xvd-site='youtube']", timeout=30000)
    esperar(page, 1.5)


def pulsar_descargar(page):
    page.locator("button.xvd-button[data-xvd-site='youtube']").first.click()


print("=" * 74)
print(" PRUEBA END-TO-END  ·  módulo de YOUTUBE  ·  red real + host nativo")
print("=" * 74)
print(f" Extensión : {ROOT}")
print(f" Vídeo     : https://www.youtube.com/watch?v={VIDEO_ID}")
print(f" Destino   : {DESTINO}")
print(f" Ventana   : {'sí' if HEADED else 'no'}")
print()

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE),
        headless=not HEADED,
        channel="chromium",
        accept_downloads=True,
        viewport={"width": 1100, "height": 860},
        args=[
            f"--disable-extensions-except={ROOT}",
            f"--load-extension={ROOT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--autoplay-policy=no-user-gesture-required",
            "--mute-audio",
        ],
    )

    page = ctx.new_page()
    page.goto(f"https://www.youtube.com/watch?v={VIDEO_ID}", wait_until="domcontentloaded", timeout=60000)
    for texto in ("Aceptar todo", "Accept all", "Rechazar todo", "I agree"):
        try:
            boton = page.get_by_role("button", name=texto)
            if boton.count() and boton.first.is_visible():
                boton.first.click(timeout=3000)
                esperar(page, 1.0)
                break
        except Exception:  # noqa: BLE001
            pass

    print(f"1. PÁGINA\n   {page.title()!r}")
    try:
        page.wait_for_selector("button.xvd-button[data-xvd-site='youtube']", timeout=45000)
        hay_boton = True
    except Exception:  # noqa: BLE001
        hay_boton = False
    check("el botón de YouTube aparece sobre el reproductor", hay_boton)
    page.screenshot(path=str(SHOTS / "youtube-boton.png"))
    if not hay_boton:
        ctx.close()
        sys.exit(1)

    popup = ctx.new_page()
    ext_id = next((sw.url.split("/")[2] for sw in ctx.service_workers if sw.url.startswith("chrome-extension://")), None)
    popup.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
    esperar(popup, 2.5)

    # ================================================== 2. SERVICIO DE YT-DLP
    print("\n2. SERVICIO DE YT-DLP (mensajería nativa)")
    texto_estado = popup.locator("#ytdlpTexto").inner_text()
    check("el popup ve el servicio de yt-dlp y su versión",
          "yt-dlp" in texto_estado and "no instalado" not in texto_estado.lower(), texto_estado)
    check("detecta ffmpeg (hace falta para unir y para MP3)", "ffmpeg sí" in texto_estado, texto_estado)

    # La carpeta de destino, como la elige el usuario en el popup.
    popup.evaluate(
        "() => new Promise(r => chrome.storage.sync.set({folder: '%s'}, r))" % CARPETA
    )

    # ================================================== 3. MP4 CON IMAGEN Y SONIDO
    print("\n3. VÍDEO MP4 (imagen + sonido, H.264)")
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'mp4', quality: 'custom', minHeight: 720}, r))")
    ir_al_video(page, VIDEO_ID)
    desde = int(time.time() * 1000)
    pulsar_descargar(page)
    archivo = esperar_descarga(popup, desde)
    check("yt-dlp termina el MP4", bool(archivo), archivo or "sin archivo")
    if archivo:
        ruta = Path(archivo)
        creados.append(ruta)
        pistas = ffprobe(ruta)
        video = next((s for s in pistas if s.get("codec_type") == "video"), None)
        audio = next((s for s in pistas if s.get("codec_type") == "audio"), None)
        check("el MP4 lleva imagen Y sonido", bool(video and audio), resumen_pistas(pistas))
        check("el códec es H.264 (compatible)", bool(video) and video.get("codec_name") == "h264", resumen_pistas(pistas))
        check("la resolución no pasa de 720p", bool(video) and video.get("height", 9999) <= 728, resumen_pistas(pistas))
        check("el archivo está en la carpeta elegida en el popup", CARPETA in str(ruta), ruta)
        check("el nombre usa la plantilla (canal, título e id)",
              ruta.name.startswith("youtube_") and VIDEO_ID in ruta.name, ruta.name)
        check("pesa lo que debe", ruta.stat().st_size > 500_000, f"{ruta.stat().st_size / 1048576:.1f} MB")

    # ================================================== 4. M4A (pista original)
    print("\n4. SOLO AUDIO M4A (pista original de YouTube)")
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'm4a'}, r))")
    ir_al_video(page, VIDEO_ID)
    desde = int(time.time() * 1000)
    pulsar_descargar(page)
    archivo_m4a = esperar_descarga(popup, desde)
    check("yt-dlp termina el M4A", bool(archivo_m4a), archivo_m4a or "sin archivo")
    if archivo_m4a:
        ruta = Path(archivo_m4a)
        creados.append(ruta)
        pistas = ffprobe(ruta)
        check("el M4A es solo audio", resumen_pistas(pistas).startswith("audio:"), resumen_pistas(pistas))
        check("el audio es AAC (sin recomprimir)", any(s.get("codec_name") == "aac" for s in pistas), resumen_pistas(pistas))
        check("el M4A se llama .m4a", ruta.suffix == ".m4a", ruta.name)

    # ================================================== 5. MP3
    print("\n5. SOLO AUDIO MP3 (recodificado por ffmpeg)")
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'mp3'}, r))")
    ir_al_video(page, VIDEO_ID)
    desde = int(time.time() * 1000)
    pulsar_descargar(page)
    archivo_mp3 = esperar_descarga(popup, desde)
    check("yt-dlp termina el MP3", bool(archivo_mp3), archivo_mp3 or "sin archivo")
    if archivo_mp3:
        ruta = Path(archivo_mp3)
        creados.append(ruta)
        pistas = ffprobe(ruta)
        check("el MP3 es audio MPEG válido", any(s.get("codec_name") == "mp3" for s in pistas), resumen_pistas(pistas))
        check("el MP3 se llama .mp3", ruta.suffix == ".mp3", ruta.name)

    # ================================================== 6. LO QUE VIERON LA PÁGINA Y EL REGISTRO
    print("\n6. PROGRESO Y AVISOS")
    lanzadas = con_registro(popup, "Descarga de YouTube enviada a yt-dlp")
    check("el service worker registra cada orden a yt-dlp", len(lanzadas) >= 3, f"{len(lanzadas)} órdenes")
    detalles = [e.get("detail", "") for e in lanzadas]
    check("la orden incluye carpeta y formato",
          any(CARPETA in d and '"formato"' in d for d in detalles),
          (detalles[-1] if detalles else "")[:140])

    errores = [e for e in registro(popup) if e.get("level") == "error" and e.get("area") in ("youtube", "ytdlp")]
    check("no hay errores en el registro", not errores, [e.get("msg") for e in errores][:3])

    page.screenshot(path=str(SHOTS / "youtube-final.png"))

    # ================================================== 7. SHORTS
    print("\n7. SHORTS")
    try:
        # Un vídeo normal abierto como /shorts/ redirige a /watch: hay que buscar
        # un Short de verdad para probar la colocación del botón.
        page.goto(f"https://www.youtube.com/shorts/{VIDEO_ID}", wait_until="domcontentloaded", timeout=60000)
        esperar(page, 2.0)
        if "/shorts/" not in page.url:
            page.goto(
                "https://www.youtube.com/results?search_query=%23shorts",
                wait_until="domcontentloaded",
                timeout=60000,
            )
            ids = []
            try:
                page.wait_for_selector('a[href*="/shorts/"]', timeout=20000)
                ids = page.evaluate(
                    """() => [...document.querySelectorAll('a[href*="/shorts/"]')]
                              .map(a => (a.getAttribute('href') || '').match(/\\/shorts\\/([A-Za-z0-9_-]{11})/))
                              .filter(Boolean).map(m => m[1])"""
                )
            except Exception:  # noqa: BLE001
                pass
            if not ids:
                ids = re.findall(r"/shorts/([A-Za-z0-9_-]{11})", page.content())
            print(f"   Shorts encontrados: {ids[:3]}")
            if ids:
                page.goto(f"https://www.youtube.com/shorts/{ids[0]}", wait_until="domcontentloaded", timeout=60000)
                esperar(page, 2.5)

        page.wait_for_selector("button.xvd-button[data-xvd-site='youtube']", timeout=30000)
        esperar(page, 1.5)
        clases = page.locator("button.xvd-button[data-xvd-site='youtube']").first.get_attribute("class") or ""
        posicion = page.evaluate(
            """() => {
                 const b = document.querySelector("button.xvd-button[data-xvd-site='youtube']");
                 const j = document.querySelector("#shorts-player, #movie_player, .html5-video-player");
                 if (!b || !j) return null;
                 const rb = b.getBoundingClientRect(), rj = j.getBoundingClientRect();
                 return {
                   margenIzquierdo: Math.round(rb.left - rj.left),
                   margenDerecho: Math.round(rj.right - rb.right),
                   anchoJugador: Math.round(rj.width)
                 };
               }"""
        )
        check("la página es un Short de verdad", "/shorts/" in page.url, page.url)
        check("en Shorts el botón usa la variante de la izquierda", "xvd-button--yt-shorts" in clases, clases)
        check(
            "y queda pegado al borde izquierdo del reproductor",
            bool(posicion) and posicion["margenIzquierdo"] < 40 and posicion["margenDerecho"] > posicion["margenIzquierdo"],
            posicion,
        )
        page.screenshot(path=str(SHOTS / "youtube-shorts.png"))
    except Exception as exc:  # noqa: BLE001
        check("los Shorts cargan y muestran el botón", False, str(exc)[:120])

    print("\n--- REGISTRO DE LA EXTENSIÓN (últimas 20 entradas) ---")
    for e in registro(popup)[-20:]:
        print(f"  {str(e.get('level','info')).upper().ljust(5)} {str(e.get('area','')).ljust(9)} "
              f"{str(e.get('msg',''))[:60]}  {str(e.get('detail',''))[:90]}")

    ctx.close()

print("\n--- ARCHIVOS DESCARGADOS EN LA PRUEBA ---")
for ruta in creados:
    try:
        print(f"  {ruta.name}  ({ruta.stat().st_size / 1024:.0f} KB)")
    except Exception:  # noqa: BLE001
        print(f"  {ruta}  (ya no existe)")
shutil.rmtree(DESTINO, ignore_errors=True)
print(f"  (borrada la carpeta de prueba {DESTINO})")

fallos = [n for n, ok in resultados if not ok]
print("\n" + "=" * 74)
print(f" {len(resultados) - len(fallos)}/{len(resultados)} comprobaciones correctas")
for n in fallos:
    print(f"   FALLA: {n}")
print("=" * 74)

sys.exit(1 if fallos else 0)
