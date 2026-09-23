#!/usr/bin/env python3
"""
Prueba end-to-end del módulo de PIXABAY.

Cómo está montada
-----------------
- Se intercepta **solo** `pixabay.com`: se sirve una página que imita su DOM y su
  `window.__BOOTSTRAP__` con medios reales (los mismos que declara la web). Así la
  prueba es determinista y no depende del captcha de Cloudflare.
- El **CDN no se intercepta**: las descargas son de verdad, y se comprueban con
  ffprobe (tamaño, códecs y resolución).

Qué se comprueba
----------------
1. Se colocan los botones: foto y vídeo en sus tarjetas, audio en la fila de música.
2. La foto cae a `_1280` cuando `_1920` responde 403 (tamaño real comprobado).
3. El vídeo respeta la calidad mínima configurada (720p → `_tiny`).
4. El audio baja el MP3 original del CDN, sin recomprimir.
5. Todo se guarda en la carpeta del popup y con la plantilla de nombre.
6. En una ficha, el botón se coloca junto al «Free download» de la web.

Requisitos: pip install playwright && playwright install chromium
Uso:        python tools/e2e-pixabay.py [--headed]
"""

import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HEADED = "--headed" in sys.argv
CARPETA = "XVD Pixabay E2E"
DESCARGAS = Path.home() / "Downloads"
DESTINO = DESCARGAS / CARPETA

WORK = Path(tempfile.gettempdir()) / "xvd-e2e-pixabay"
SHOTS = WORK / "shots"
PROFILE = WORK / f"perfil-{int(time.time())}"
for carpeta in (SHOTS,):
    shutil.rmtree(carpeta, ignore_errors=True)
    carpeta.mkdir(parents=True, exist_ok=True)
shutil.rmtree(WORK / "perfil-anterior", ignore_errors=True)
for viejo in WORK.glob("perfil-*"):
    if viejo != PROFILE:
        shutil.rmtree(viejo, ignore_errors=True)
shutil.rmtree(DESTINO, ignore_errors=True)

resultados = []
creados = []

FOTO_URL = "https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_1280.jpg"
VIDEO_URL = "https://cdn.pixabay.com/video/2026/04/24/348656_tiny.mp4"
AUDIO_URL = "https://cdn.pixabay.com/download/audio/2026/06/21/audio_f7ff5b4757.mp3?filename=sigmamusicart-football-football-music-551346.mp3"


def check(nombre, ok, detalle=""):
    resultados.append((nombre, bool(ok)))
    print(("  [OK]    " if ok else "  [FALLA] ") + nombre + (("  ->  " + str(detalle)) if detalle else ""))
    return bool(ok)


def esperar(page, segundos):
    page.wait_for_timeout(int(float(segundos) * 1000))


def ffprobe(ruta):
    try:
        salida = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(ruta)],
            capture_output=True, text=True, timeout=60, check=False)
        return json.loads(salida.stdout or "{}").get("streams", [])
    except Exception:  # noqa: BLE001
        return []


def resumen(pistas):
    partes = []
    for p in pistas:
        if p.get("codec_type") == "video":
            partes.append(f"video:{p.get('codec_name')} {p.get('width')}x{p.get('height')}")
        else:
            partes.append(f"audio:{p.get('codec_name')} {p.get('sample_rate')}Hz")
    return " + ".join(partes)


# --------------------------------------------------------------- página falsa --

def bootstrap():
    return {
        "request": {"path": "/images/search/nature/"},
        "page": {
            "pageType": "search",
            "mediaType": "photo",
            "results": [
                {
                    "id": 7572681,
                    "mediaType": "photo",
                    "width": 4228,
                    "height": 2642,
                    "sources": {
                        "1x": "https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_640.jpg",
                        "2x": FOTO_URL,
                    },
                    "href": "/photos/bachalpsee-lake-mountains-7572681/",
                    "name": "Bachalpsee, Lake, Mountains",
                    "fileFormat": "JPG",
                    "user": {"username": "Himmelstraeume"},
                },
                {
                    "id": 348656,
                    "mediaType": "video",
                    "width": 3840,
                    "height": 2160,
                    "duration": 20,
                    "sources": {
                        "thumbnail": "https://cdn.pixabay.com/video/2026/04/24/348656_tiny.jpg",
                        "mp4": VIDEO_URL,
                        "embed": VIDEO_URL,
                    },
                    "href": "/videos/dandelion-flower-blossom-bloom-348656/",
                    "name": "Dandelion, Flower, Blossom",
                    "fileFormat": "MP4",
                    "user": {"username": "adege"},
                },
                {
                    "id": 551346,
                    "mediaType": "audio",
                    "sources": {
                        "src": "https://cdn.pixabay.com/audio/2026/06/21/audio_f7ff5b4757.mp3",
                        "thumbnailUrl": "https://cdn.pixabay.com/audio/2026/06/25/09-55-56-222_200x200.png",
                        "downloadUrl": AUDIO_URL,
                    },
                    "duration": 59.112,
                    "href": "/music/percussion-football-football-music-551346/",
                    "name": "Football - Football Music",
                    "fileFormat": "MP3",
                    "user": {"username": "SigmaMusicArt"},
                },
            ],
            # Un patrocinado de iStock: no debe generar botón
            "sponsoredImages": [{"id": "gm1", "url": "https://media.istockphoto.com/x.jpg"}],
        },
    }


def pagina_listado():
    return """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Pixabay (prueba)</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; background: #191919; color: #eee; }
  .grid { display: flex; gap: 16px; flex-wrap: wrap; }
  .container--mVjnq { width: 320px; }
  .link--LGc0H { display: block; }
  .overlayContainer--mRC66 { position: relative; width: 320px; height: 200px; overflow: hidden; border-radius: 8px; }
  .overlayContainer--mRC66 img { width: 100%; height: 100%; object-fit: cover; }
  .audioRow--et3ac { display: flex; align-items: center; gap: 12px; padding: 12px; margin-top: 24px;
                     background: #232323; border-radius: 8px; width: 900px; }
  .leftSection--N8hxV { display: flex; align-items: center; gap: 10px; width: 320px; }
  .thumbnail--adEfQ { width: 56px; height: 56px; }
  .thumbnail--adEfQ .overlayContainer--mRC66 { width: 56px; height: 56px; }
  .centerSection--TqmFS { flex: 1; height: 40px; background: #2c2c2c; border-radius: 6px; }
  .rightSection--BBoLK { display: flex; align-items: center; gap: 6px; }
  .button--af32y { background: #333; color: #eee; border: 0; border-radius: 6px; padding: 8px 12px; }
  .detalle { margin-top: 24px; display: flex; gap: 12px; align-items: center; }
</style></head>
<body>
  <h1>Pixabay · página de prueba</h1>

  <div class="grid">
    <div class="container--mVjnq">
      <a class="link--LGc0H" data-id="7572681" href="/photos/bachalpsee-lake-mountains-7572681/">
        <div class="overlayContainer--mRC66 image--V1_OV">
          <img src="__FOTO__" alt="Bachalpsee">
        </div>
      </a>
    </div>
    <div class="container--mVjnq">
      <a class="link--LGc0H" data-id="348656" href="/videos/dandelion-flower-blossom-bloom-348656/">
        <div class="overlayContainer--mRC66 image--V1_OV">
          <img src="https://cdn.pixabay.com/video/2026/04/24/348656_tiny.jpg" alt="Dandelion">
        </div>
      </a>
    </div>
  </div>

  <div class="audioRow--et3ac">
    <div class="leftSection--N8hxV">
      <div class="thumbnail--adEfQ lg--raa4V" role="button">
        <div class="overlayContainer--mRC66 image--V1_OV">
          <img src="https://cdn.pixabay.com/audio/2026/06/25/09-55-56-222_200x200.png" alt="">
        </div>
      </div>
      <div class="nameAndTitle--gkjiG">
        <a class="title--nya0C" href="/music/percussion-football-football-music-551346/">Football - Football Music</a>
        <a class="name--GoJoZ" href="/users/sigmamusicart-36860929/">SigmaMusicArt</a>
      </div>
    </div>
    <div class="centerSection--TqmFS"></div>
    <div class="rightSection--BBoLK">
      <button class="button--af32y square--vasA3">570</button>
      <button class="button--af32y ghost--zbjYe"></button>
    </div>
  </div>

  <div class="detalle">
    <a data-id="1850120" href="/photos/hand-turntable-dj-neon-lights-1850120/">
      <div class="overlayContainer--mRC66"><img src="https://cdn.pixabay.com/photo/2016/11/22/19/15/hand-1850120_640.jpg" alt=""></div>
    </a>
  </div>

  <script>window.__BOOTSTRAP__ = __DATOS__;</script>
</body></html>""".replace("__FOTO__", FOTO_URL).replace("__DATOS__", json.dumps(bootstrap(), ensure_ascii=False))


def pagina_ficha():
    datos = bootstrap()
    pista = datos["page"]["results"][2]
    datos["page"] = {
        "pageType": "musicDetail",
        "mediaType": "audio",
        "mediaItem": pista,
        "relatedMedia": [],
    }
    return """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Pixabay ficha (prueba)</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; background: #191919; color: #eee; }
  .overlayContainer--mRC66 { width: 200px; height: 200px; }
  .acciones { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
  .mainButton--_3TDY { background: #00ab6b; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; }
</style></head>
<body>
  <h1>Football - Football Music</h1>
  <div class="blur-medium--ipeH3">
    <div class="overlayContainer--mRC66 image--V1_OV">
      <img src="https://cdn.pixabay.com/audio/2026/06/25/09-55-56-222_200x200.png" alt="">
    </div>
  </div>
  <div class="acciones" id="acciones">
    <button class="button--af32y ghost--zbjYe">Compartir</button>
    <button class="mainButton--_3TDY button--af32y primary--nPV2V"><span class="label--MoICp">Free download</span></button>
  </div>
  <script>window.__BOOTSTRAP__ = __DATOS__;</script>
</body></html>""".replace("__DATOS__", json.dumps(datos, ensure_ascii=False))


print("=" * 74)
print(" PRUEBA END-TO-END  ·  PIXABAY  ·  CDN real")
print("=" * 74)
print(f" Extensión : {ROOT}")
print(f" Destino   : {DESTINO}")
print(f" Ventana   : {'sí' if HEADED else 'no'}")
print()

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE),
        headless=not HEADED,
        channel="chromium",
        accept_downloads=True,
        locale="es-ES",
        viewport={"width": 1280, "height": 900},
        args=[
            f"--disable-extensions-except={ROOT}",
            f"--load-extension={ROOT}",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    )
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="https://pixabay.com")

    ctx.route(
        "https://pixabay.com/**",
        lambda r: r.fulfill(
            status=200,
            content_type="text/html; charset=utf-8",
            body=pagina_ficha() if "/music/" in r.request.url else pagina_listado(),
        ),
    )

    page = ctx.new_page()
    # chrome.downloads.download pasa por el gestor de descargas de Chrome, y
    # Playwright lo desvía a su carpeta de artefactos con un nombre GUID. Como el
    # evento de descarga no siempre llega (lo lanza el service worker, no la
    # página), se vigilan los archivos nuevos: así se comprueban los bytes reales.
    def archivos_descargados():
        encontrados = {}
        for base in list(Path(tempfile.gettempdir()).glob("playwright-artifacts-*")):
            for f in base.rglob("*"):
                if f.is_file():
                    encontrados[str(f)] = f
        if DESTINO.exists():
            for f in DESTINO.rglob("*"):
                if f.is_file():
                    encontrados[str(f)] = f
        return encontrados

    def esperar_archivo(previos, timeout=240):
        """Espera a un archivo nuevo (y ya completo) y devuelve su ruta."""
        limite = time.time() + timeout
        candidato = None
        tamano = -1
        while time.time() < limite:
            nuevos = [f for clave, f in archivos_descargados().items() if clave not in previos]
            for f in nuevos:
                try:
                    actual = f.stat().st_size
                except OSError:
                    continue
                if not f.name.endswith(".crdownload") and actual > 0:
                    if candidato == f and actual == tamano:
                        return f
                    candidato, tamano = f, actual
            page.wait_for_timeout(700)
        return candidato

    page.goto("https://pixabay.com/images/search/nature/", wait_until="domcontentloaded")
    page.wait_for_selector("button.xvd-button[data-xvd-site='pixabay']", timeout=25000)
    esperar(page, 2.0)

    popup = ctx.new_page()
    ext_id = next((sw.url.split("/")[2] for sw in ctx.service_workers if sw.url.startswith("chrome-extension://")), None)
    popup.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
    esperar(popup, 1.5)

    # --------------------------------------------------- 1. botones colocados
    print("1. BOTONES EN LA PÁGINA")
    botones = page.locator("button.xvd-button[data-xvd-site='pixabay']")
    descargas = page.locator("button.xvd-button[data-xvd-kind='pixabay']")
    enlaces = page.locator("button.xvd-button[data-xvd-kind='pixabay-link']")
    check("se colocan las descargas y un enlace por cada medio", botones.count() == 6 and descargas.count() == 3 and enlaces.count() == 3, f"{botones.count()} botones, {enlaces.count()} enlaces")
    ids = page.evaluate(
        """() => [...document.querySelectorAll("button.xvd-button[data-xvd-kind='pixabay']")].map(b => b.dataset.xvdId)"""
    )
    check("cada botón lleva el id de su medio", sorted(ids) == ["348656", "551346", "7572681"], ids)
    en_linea = page.evaluate(
        """() => { const b = document.querySelector("button.xvd-button[data-xvd-id='551346'][data-xvd-kind='pixabay']");
                   return b ? b.className : ''; }"""
    )
    check("el botón de la fila de música va en línea (no flotante)", "xvd-button--en-linea" in en_linea, en_linea)
    enlaces.first.click()
    esperar(page, 0.4)
    check("el enlace de Pixabay apunta a la ficha del recurso",
          page.evaluate("() => navigator.clipboard.readText()") == "https://pixabay.com/photos/bachalpsee-lake-mountains-7572681/",
          page.evaluate("() => navigator.clipboard.readText()"))
    page.screenshot(path=str(SHOTS / "pixabay-listado.png"))

    # La carpeta y la calidad que se probarán.
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({folder: '%s', quality: 'custom', minHeight: 720}, r))" % CARPETA)
    esperar(popup, 0.8)

    def leer_registro():
        return popup.evaluate("() => new Promise(r => chrome.storage.session.get('xvd_log', s => r(s.xvd_log || [])))")

    def descarga_de(etiqueta, timeout=240):
        """Espera el archivo nuevo y la entrada del registro de ese medio."""
        previos = archivos_descargados()
        # La entrada del registro puede llegar antes o después del archivo.
        limite = time.time() + timeout
        entrada = None
        while time.time() < limite and not entrada:
            entradas = [
                e
                for e in leer_registro()
                if "Descarga iniciada" in str(e.get("msg", "")) and etiqueta in str(e.get("detail", ""))
            ]
            if entradas:
                entrada = entradas[-1]
                break
            popup.wait_for_timeout(500)
        archivo = esperar_archivo(previos, timeout=max(30, int(limite - time.time())))
        return archivo, entrada

    # ------------------------------------------------------------ 2. la foto
    print("\n2. FOTO (cae a 1280 porque 1920 responde 403)")
    page.locator("button.xvd-button[data-xvd-id='7572681'][data-xvd-kind='pixabay']").click()
    foto, entrada_foto = descarga_de('"tipo":"photo"')
    check("la foto se descarga", bool(foto and foto.exists()), foto)
    if foto and foto.exists():
        creados.append(foto)
        pistas = ffprobe(foto)
        check("es una imagen de 1280 de ancho (el 1920 lo rechaza el CDN)",
              any(s.get("width") == 1280 for s in pistas), resumen(pistas))
    detalle_foto = json.loads(entrada_foto.get("detail") or "{}") if entrada_foto else {}
    check("se eligió el tamaño de 1280 y no el 1920",
          "1280" in str(detalle_foto.get("etiqueta", "")) or "web" in str(detalle_foto.get("etiqueta", "")),
          detalle_foto.get("etiqueta"))
    check("el archivo pedido usa la carpeta del popup y la plantilla de Pixabay",
          str(detalle_foto.get("archivo", "")).startswith(CARPETA + "/pixabay_Himmelstraeume_")
          and "7572681" in str(detalle_foto.get("archivo", "")),
          detalle_foto.get("archivo"))

    # ----------------------------------------------------------- 3. el vídeo
    print("\n3. VÍDEO (calidad mínima 720p → _tiny)")
    page.locator("button.xvd-button[data-xvd-id='348656'][data-xvd-kind='pixabay']").click()
    video, entrada_video = descarga_de('"tipo":"video"')
    check("el vídeo se descarga", bool(video and video.exists()), video)
    if video and video.exists():
        creados.append(video)
        pistas = ffprobe(video)
        check("es un MP4 real con vídeo", any(s.get("codec_type") == "video" for s in pistas), resumen(pistas))
        check("la calidad mínima de 720p se respeta (no baja el 4K)",
              any(s.get("height") == 720 for s in pistas), resumen(pistas))
    detalle_video = json.loads(entrada_video.get("detail") or "{}") if entrada_video else {}
    check("el vídeo se pide con su id en el nombre", "348656" in str(detalle_video.get("archivo", "")), detalle_video.get("archivo"))

    # ----------------------------------------------------------- 4. el audio
    print("\n4. AUDIO (MP3 original del CDN)")
    page.locator("button.xvd-button[data-xvd-id='551346'][data-xvd-kind='pixabay']").click()
    audio, entrada_audio = descarga_de('"tipo":"audio"')
    check("el audio se descarga", bool(audio and audio.exists()), audio)
    if audio and audio.exists():
        creados.append(audio)
        pistas = ffprobe(audio)
        check("es un MP3 real (sin recomprimir)", any(s.get("codec_name") == "mp3" for s in pistas), resumen(pistas))
        check("pesa lo que el original de Pixabay", audio.stat().st_size > 1_500_000, f"{audio.stat().st_size / 1024:.0f} KB")
    detalle_audio = json.loads(entrada_audio.get("detail") or "{}") if entrada_audio else {}
    check("el audio se guarda con el nombre del artista", "SigmaMusicArt" in str(detalle_audio.get("archivo", "")), detalle_audio.get("archivo"))

    # ------------------------------------------------------------ 5. la ficha
    print("\n5. FICHA (el botón va junto al «Free download» de la web)")
    page.goto("https://pixabay.com/music/percussion-football-football-music-551346/", wait_until="domcontentloaded")
    page.wait_for_selector("button.xvd-button[data-xvd-site='pixabay']", timeout=25000)
    esperar(page, 1.5)
    junto = page.evaluate(
        """() => {
             const mio = document.querySelector("button.xvd-button[data-xvd-site='pixabay']");
             const web = [...document.querySelectorAll('button')].find(b => /free download/i.test(b.textContent || ''));
             if (!mio || !web) return { mio: !!mio, web: !!web };
             return { mio: true, web: true, mismoPadre: mio.parentElement === web.parentElement,
                      antesDeWeb: !!(mio.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING) };
           }"""
    )
    check("en la ficha hay un botón y está junto al de la web",
          junto.get("mio") and junto.get("web") and junto.get("mismoPadre"), junto)
    check("y queda antes que el de la web", junto.get("antesDeWeb") is True, junto)
    page.screenshot(path=str(SHOTS / "pixabay-ficha.png"))

    # ------------------------------------------------------------ 6. registro
    print("\n6. REGISTRO")
    registro = popup.evaluate(
        "() => new Promise(r => chrome.storage.session.get('xvd_log', s => r(s.xvd_log || [])))"
    )
    datos = [e for e in registro if "Datos de Pixabay recibidos" in str(e.get("msg", ""))]
    check("el puente entregó los medios", bool(datos), datos[-1].get("detail") if datos else "sin datos")
    errores = [e for e in registro if e.get("level") == "error" and e.get("area") == "pixabay"]
    check("sin errores en el registro", not errores, [e.get("msg") for e in errores][:3])
    print("\n--- REGISTRO (últimas 14 entradas de pixabay) ---")
    for e in [x for x in registro if x.get("area") == "pixabay"][-14:]:
        print(f"  {str(e.get('level','info')).upper().ljust(5)} {str(e.get('msg',''))[:52]:52} {str(e.get('detail',''))[:80]}")

    ctx.close()

print("\n--- ARCHIVOS DESCARGADOS ---")
for ruta in creados:
    try:
        print(f"  {ruta.name}  ({ruta.stat().st_size / 1024:.0f} KB)")
    except Exception:  # noqa: BLE001
        print(f"  {ruta}  (no encontrado)")
shutil.rmtree(DESTINO, ignore_errors=True)
print(f"  (borrada la carpeta de prueba {DESTINO})")

fallos = [n for n, ok in resultados if not ok]
print("\n" + "=" * 74)
print(f" {len(resultados) - len(fallos)}/{len(resultados)} comprobaciones correctas")
for n in fallos:
    print(f"   FALLA: {n}")
print("=" * 74)
sys.exit(1 if fallos else 0)
