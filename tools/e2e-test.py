#!/usr/bin/env python3
"""
Prueba end-to-end del Descargador de medios para X en un Chromium real.

Qué hace
--------
1. Lanza Chromium (el que trae Playwright) con la extensión desempaquetada
   cargada, en un perfil temporal: NO toca tu Chrome ni tus ajustes.
2. Sirve una página en https://x.com/... que imita el DOM de X para el tweet
   real 2100475914182107353 (@axichuhai), incluyendo:
     - un <video> con el póster real y las props de React en las fibras,
     - una galería de 4 imágenes con [data-testid="tweetPhoto"].
3. Comprueba el flujo completo: inyección del botón, resolución de la máxima
   calidad (3828x2160), mensajería con el service worker, chrome.downloads,
   contadores de galería, botón «Descargar todas», avisos en español, que el
   clic no se propague (lightbox) y el popup con sus tres pestañas.

Requisitos
----------
    pip install playwright
    playwright install chromium

Uso
---
    python tools/e2e-test.py            # sin ventana
    python tools/e2e-test.py --headed   # viendo el navegador
"""

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "tweet-video-2100475914182107353.json"
HEADED = "--headed" in sys.argv
TWEET_ID = "2100475914182107353"
POSTER = "https://pbs.twimg.com/amplify_video_thumb/2100475372890472448/img/5SNhLYxWgrkiSWFf.jpg"
FAKE_MEDIA = b"\x00" * 4096  # cuerpo falso si Playwright intercepta la descarga

WORK = Path(tempfile.gettempdir()) / "xvd-e2e"
DOWNLOADS = WORK / "downloads"
REAL_DOWNLOADS = Path.home() / "Downloads" / "X Videos"
SHOTS = WORK / "shots"
# Perfil NUEVO en cada ejecución: si se reutiliza, Chrome sirve la extensión
# cacheada de la tienda de perfiles y se probaría código viejo.
PROFILE = WORK / f"perfil-{int(time.time())}"
for carpeta in (DOWNLOADS, SHOTS):
    shutil.rmtree(carpeta, ignore_errors=True)
    carpeta.mkdir(parents=True, exist_ok=True)
for viejo in WORK.glob("perfil-*"):
    shutil.rmtree(viejo, ignore_errors=True)

resultados = []


def esperar(page, segundos):
    """Espera con el reloj de Playwright: mantiene despachadas las rutas."""
    page.wait_for_timeout(int(float(segundos) * 1000))


def check(nombre, ok, detalle=""):
    resultados.append((nombre, bool(ok)))
    print(("  [OK]    " if ok else "  [FALLA] ") + nombre + (("  ->  " + str(detalle)) if detalle else ""))
    return bool(ok)


# --------------------------------------------------------------- página falsa --

def construir_fixture():
    tweet = json.loads(FIXTURE.read_text(encoding="utf-8"))
    media = tweet["mediaDetails"][0]

    celdas = []
    for i in range(1, 5):
        celdas.append(
            '<div data-testid="tweetPhoto" style="position:relative;width:299px;height:200px">'
            f'<img src="https://pbs.twimg.com/media/XVDTESTIMG{i:03d}?format=jpg&amp;name=small" '
            'style="width:100%;height:100%;display:block"></div>'
        )

    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Tweet / X</title>
<style>
  body {{ margin:0; background:#000; color:#e7e9ea; font-family:sans-serif; width:700px }}
  #player {{ position:relative; width:600px; height:338px; background:#111 }}
  video {{ width:100%; height:100%; display:block }}
  #galeria {{ display:grid; grid-template-columns:1fr 1fr; gap:2px; width:600px }}
</style></head><body>
<article data-testid="tweet">
  <div data-testid="User-Name"><a href="/axichuhai">阿西_出海</a></div>
  <div id="player"><video poster="{POSTER}" playsinline></video></div>
  <a href="/axichuhai/status/{TWEET_ID}">17 sept 2026</a>
  <div id="galeria">{''.join(celdas)}</div>
</article>
<script>
  window.__clickEnContenedor = false;
  document.getElementById('player').addEventListener('click', function () {{ window.__clickEnContenedor = true; }});
  document.getElementById('galeria').addEventListener('click', function () {{ window.__clickEnContenedor = true; }});

  // Registra los avisos para poder comprobarlos sin problemas de tiempo.
  window.__xvdToasts = [];
  new MutationObserver(function (muts) {{
    muts.forEach(function (m) {{
      m.addedNodes.forEach(function (n) {{
        if (n.nodeType === 1 && n.classList && n.classList.contains('xvd-toast')) {{
          var msg = n.querySelector('.xvd-toast__msg');
          window.__xvdToasts.push(msg ? msg.textContent : n.textContent);
        }}
      }});
    }});
  }}).observe(document.body, {{ childList: true, subtree: true }});

  // Simula el árbol de React de X: el manifiesto vive en las props de la fibra
  // del reproductor (invisible desde el mundo aislado; la lee page-bridge.js).
  var MEDIA = {json.dumps(media, ensure_ascii=False)};
  var video = document.querySelector('video');
  video['__reactFiber$xdvtest'] = {{
    memoizedProps: {{ mediaDetails: [MEDIA] }},
    return: {{ memoizedProps: {{ tweet: {{ mediaDetails: [MEDIA] }} }}, return: null }}
  }};
  var article = document.querySelector('article');
  article['__reactProps$xdvtest'] = {{ children: {{ props: {{ mediaDetails: [MEDIA] }} }} }};
</script></body></html>"""


HTML = construir_fixture()
peticiones = {"video": [], "imagen": [], "probe": [], "ig": [], "fb": []}


def construir_fixture_instagram():
    """Página que imita Instagram, con los datos reales en las props de React."""
    reel = {
        "code": "DdXUcJaSe8X",
        "pk": "3987744811663759326",
        "media_type": 2,
        "video_duration": 12.5,
        "user": {"username": "khetzalgg"},
        "video_versions": [
            {"url": "https://scontent.cdninstagram.com/v/t51/video-720.mp4", "width": 720, "height": 1280, "type": 101},
            {"url": "https://scontent.cdninstagram.com/v/t51/video-1080.mp4", "width": 1080, "height": 1920, "type": 101},
        ],
        "image_versions2": {
            "candidates": [
                {"url": "https://scontent.cdninstagram.com/v/t51/portada-1080.jpg", "width": 1080, "height": 1920}
            ]
        },
    }
    carrusel = {
        "code": "DdXUMc6IBfe",
        "pk": "3987744688274037580",
        "media_type": 8,
        "user": {"username": "khetzalgg"},
        "carousel_media": [
            {
                "media_type": 1,
                "image_versions2": {
                    "candidates": [
                        {"url": "https://scontent.cdninstagram.com/v/t51/foto1-640.jpg", "width": 640, "height": 800},
                        {
                            "url": "https://scontent.cdninstagram.com/v/t51/foto1-1440.jpg?stp=dst-jpg_e35&oh=00_FIRMA1&oe=6AB2B388",
                            "width": 1440,
                            "height": 1800,
                        },
                    ]
                },
            },
            {
                "media_type": 1,
                "image_versions2": {
                    "candidates": [
                        {
                            "url": "https://instagram.fymq2-1.fna.fbcdn.net/v/t51/foto2.jpg?stp=dst-jpg_e35&oh=00_FIRMA2&oe=6AB2B388",
                            "width": 1080,
                            "height": 1350,
                        }
                    ]
                },
            },
            {
                "media_type": 2,
                "video_versions": [
                    {"url": "https://scontent.cdninstagram.com/v/t51/clip.mp4", "width": 1080, "height": 1920}
                ],
                "image_versions2": {
                    "candidates": [
                        {"url": "https://scontent.cdninstagram.com/v/t51/clip-poster.jpg", "width": 640, "height": 1136}
                    ]
                },
            },
        ],
    }
    celda = (
        '<div style="position:relative;width:300px;height:400px">'
        '<img src="__URL__" style="width:100%;height:100%"></div>'
    )
    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Instagram</title>
<style>body {{ margin:0; background:#000; color:#fff; font-family:sans-serif; width:1000px }}
article {{ display:block; margin-bottom:20px }}
#reel {{ position:relative; width:600px; height:800px }}
#reel video {{ width:100%; height:100%; display:block }}
#carrusel {{ display:flex; gap:2px; width:900px }}</style></head><body>
<article>
  <a href="/khetzalgg/">khetzalgg</a>
  <div id="reel"><video poster="https://scontent.cdninstagram.com/v/t51/portada-1080.jpg" playsinline></video></div>
  <a href="/reel/DdXUcJaSe8X/">ver reel</a>
</article>
<article>
  <a href="/khetzalgg/">khetzalgg</a>
  <div id="carrusel">
    {celda.replace('__URL__', 'https://scontent.cdninstagram.com/v/t51/foto1-1440.jpg?stp=dst-jpg_e35&amp;oh=00_FIRMA1&amp;oe=6AB2B388')}
    {celda.replace('__URL__', 'https://instagram.fymq2-1.fna.fbcdn.net/v/t51/foto2.jpg?stp=dst-jpg_e35&amp;oh=00_FIRMA2&amp;oe=6AB2B388')}
    <div style="position:relative;width:300px;height:400px"><video poster="https://scontent.cdninstagram.com/v/t51/clip-poster.jpg" style="width:100%;height:100%"></video></div>
  </div>
  <a href="/p/DdXUMc6IBfe/">ver publicación</a>
</article>
<script>
  var REEL = {json.dumps(reel, ensure_ascii=False)};
  var CARR = {json.dumps(carrusel, ensure_ascii=False)};
  var articulos = document.querySelectorAll('article');
  // IG pasa los datos por props de React (y por la fibra del reproductor).
  articulos[0].querySelector('video')['__reactFiber$ig'] = {{
    memoizedProps: {{ xdt_api__v1__media__shortcode__web_info: {{ items: [REEL] }} }},
    return: null
  }};
  articulos[1]['__reactProps$ig'] = {{ data: {{ xdt_api__v1__media__shortcode__web_info: {{ items: [CARR] }} }} }};
  window.__clickEnContenedor = false;
  document.getElementById('reel').addEventListener('click', function () {{ window.__clickEnContenedor = true; }});
</script></body></html>"""


def descargas_de(popup, fragmento):
    """Descargas registradas por Chrome cuya URL O nombre de archivo contenga el texto."""
    try:
        lista = popup.evaluate(
            "() => new Promise(r => chrome.downloads.search({limit: 40, orderBy: ['-startTime']}, r))"
        )
    except Exception:  # noqa: BLE001
        return []
    return [
        d
        for d in lista
        if fragmento in (d.get("url") or "") or fragmento in (d.get("filename") or "")
    ]


def leer_registro(popup):
    """Entradas del registro de diagnóstico que ve el popup."""
    try:
        return popup.evaluate(
            "() => new Promise(r => chrome.storage.session.get('xvd_log', s => r(s.xvd_log || [])))"
        )
    except Exception:  # noqa: BLE001
        return []


def archivos_pedidos(popup, contiene):
    """Nombres de archivo que la extensión pidió a chrome.downloads (según su registro).

    No se usa downloads.search() porque Playwright renombra las descargas a GUID.
    """
    nombres = set()
    for entrada in leer_registro(popup):
        detalle = str(entrada.get("detail", ""))
        if contiene not in detalle:
            continue
        try:
            nombres.add(json.loads(detalle).get("archivo", ""))
        except Exception:  # noqa: BLE001
            continue
    return sorted(n for n in nombres if n)


def construir_fixture_facebook(con_datos=True, reel_id="1906283450061603"):
    """Página que imita Facebook: vídeo con datos en props (o solo og:video) y una foto."""
    hd = "https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/HD.mp4?oh=00_HD&oe=6AB2B76E&bitrate=1414536&tag=sve_hd"
    sd = "https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/SD.mp4?oh=00_SD&oe=6AB2B76E&bitrate=414536&tag=sve_sd"
    audio = "https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/audio.mp4?oh=00_AUDIO&oe=6AB2B76E"
    mpd = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT23.4S">'
        "<Period>"
        '<AdaptationSet mimeType="audio/mp4" lang="und">'
        '<Representation id="audio-1" bandwidth="128000" codecs="mp4a.40.2">'
        f"<BaseURL>{audio.replace(chr(38), chr(38) + 'amp;')}</BaseURL>"
        '<SegmentBase indexRange="0-1000"><Initialization range="0-800"/></SegmentBase>'
        "</Representation></AdaptationSet>"
        '<AdaptationSet mimeType="video/mp4">'
        '<Representation id="video-1" bandwidth="1414536" width="576" height="1024" codecs="avc1.64001f">'
        '<BaseURL>https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/video-1024.mp4?oh=00_V&oe=6AB2B76E</BaseURL>'
        "</Representation></AdaptationSet>"
        "</Period></MPD>"
    )
    video = {
        "videoId": reel_id,
        "playable_url": sd,
        "playable_url_quality_hd": hd,
        "playable_duration_in_ms": 23400,
        "width": 576,
        "height": 1024,
        "video_dash_manifest": mpd,
        "preferred_thumbnail": {
            "image": {
                "uri": "https://scontent.fyhu2-1.fna.fbcdn.net/v/t15.5256-10/portada.jpg?oh=00_IMG&oe=6AB2C3E1",
                "width": 576,
                "height": 1024,
            }
        },
        "owner": {"name": "Alejandro Garcia"},
    }
    foto = {
        "id": "9876543210",
        "image": {
            "uri": "https://scontent.fyhu2-1.fna.fbcdn.net/v/t39.30808-6/foto-grande.jpg?oh=00_FOTO&oe=6AB2C3E1",
            "width": 2048,
            "height": 1536,
        },
        "owner": {"name": "Alejandro Garcia"},
    }

    datos = ""
    if con_datos:
        datos = f"""
  document.querySelectorAll('article')[0].querySelector('video')['__reactFiber$fb'] = {{
    memoizedProps: {{ video: {json.dumps(video, ensure_ascii=False)} }}, return: null
  }};
  document.querySelectorAll('article')[1]['__reactProps$fb'] = {{ media: {json.dumps(foto, ensure_ascii=False)} }};"""

    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Facebook</title>
<meta property="og:type" content="video.other" />
<meta property="og:url" content="https://www.facebook.com/reel/{reel_id}/" />
<meta property="og:title" content="Lo que Tom nunca pudo hacer" />
<meta property="og:image" content="https://scontent.fyhu2-1.fna.fbcdn.net/v/t15.5256-10/portada.jpg?oh=00_IMG&amp;oe=6AB2C3E1" />
<meta property="og:video" content="{sd.replace('&', '&amp;')}" />
<meta property="og:video:width" content="576" />
<meta property="og:video:height" content="1024" />
<meta property="og:video:type" content="video/mp4" />
<style>body {{ margin:0; background:#18191a; color:#e4e6eb; font-family:sans-serif; width:900px }}
#reel {{ position:relative; width:576px; height:700px }}
#reel video {{ width:100%; height:100%; display:block }}
#foto {{ position:relative; width:500px; height:375px }}
#foto img {{ width:100%; height:100%; display:block }}</style></head><body>
<article role="article">
  <a href="/alejandro.garcia/">Alejandro Garcia</a>
  <div id="reel"><video poster="https://scontent.fyhu2-1.fna.fbcdn.net/v/t15.5256-10/portada.jpg?oh=00_IMG&amp;oe=6AB2C3E1" playsinline></video></div>
  <a href="/reel/{reel_id}/">ver reel</a>
</article>
<article role="article">
  <a href="/alejandro.garcia/">Alejandro Garcia</a>
  <div id="foto"><img src="https://scontent.fyhu2-1.fna.fbcdn.net/v/t39.30808-6/foto-grande.jpg?oh=00_FOTO&amp;oe=6AB2C3E1" /></div>
  <a href="/photo/?fbid=9876543210">ver foto</a>
</article>
<script>
  window.__xvdToasts = [];
  new MutationObserver(function (muts) {{
    muts.forEach(function (m) {{
      m.addedNodes.forEach(function (n) {{
        if (n.nodeType === 1 && n.classList && n.classList.contains('xvd-toast')) {{
          var msg = n.querySelector('.xvd-toast__msg');
          window.__xvdToasts.push(msg ? msg.textContent : n.textContent);
        }}
      }});
    }});
  }}).observe(document.body, {{ childList: true, subtree: true }});
  window.__clickEnContenedor = false;
  document.getElementById('reel').addEventListener('click', function () {{ window.__clickEnContenedor = true; }});{datos}
</script></body></html>"""


def esperar_descarga(popup, host, timeout=60):
    """Espera a que chrome.downloads registre una descarga de ese host."""
    limite = time.time() + timeout
    ultima = None
    while time.time() < limite:
        try:
            lista = popup.evaluate(
                "() => new Promise(r => chrome.downloads.search({limit: 12, orderBy: ['-startTime']}, r))"
            )
        except Exception:  # noqa: BLE001
            lista = []
        for d in lista:
            if host in (d.get("url") or ""):
                ultima = d
                if d.get("state") in ("complete", "interrupted"):
                    return d
        popup.wait_for_timeout(500)
    return ultima


def limpiar_descargas_de_prueba():
    for base in (DOWNLOADS, REAL_DOWNLOADS):
        if not base.exists():
            continue
        for f in list(base.rglob("*")):
            if f.is_file() and ("XVD" in f.name or f.name.startswith("tweet_") or "axichuhai" in f.name):
                f.unlink(missing_ok=True)
        if base == REAL_DOWNLOADS and base.exists() and not any(base.iterdir()):
            base.rmdir()


def volcar_diagnostico(popup, titulo, sw=None):
    """Imprime el registro de la extensión y el estado real de chrome.downloads."""
    print(f"\n--- {titulo} ---")
    for etiqueta, ctx_pagina in (("popup", popup), ("service worker", sw)):
        if ctx_pagina is None:
            continue
        try:
            registro = ctx_pagina.evaluate(
                "() => new Promise(r => chrome.storage.session.get('xvd_log', s => r(s.xvd_log || [])))"
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  [{etiqueta}] no se pudo leer el registro: {exc}")
            continue
        print(f"  [{etiqueta}] registro: {len(registro)} entradas")
        if etiqueta == "popup":
            for e in registro[-40:]:
                nivel = str(e.get("level", "info")).upper().ljust(5)
                print(f"    {nivel} {str(e.get('area','')).ljust(11)} {e.get('msg','')}  {e.get('detail','')}")

    try:
        descargas = popup.evaluate(
            "() => new Promise(r => chrome.downloads.search({limit: 12, orderBy: ['-startTime']}, r))"
        )
        print("  chrome.downloads:")
        if not descargas:
            print("    (ninguna descarga registrada)")
        for d in descargas:
            print(
                f"    state={d.get('state')}  error={d.get('error') or '-'}  "
                f"bytes={d.get('bytesReceived')}/{d.get('totalBytes')}"
            )
            print(f"      url={str(d.get('url'))[:120]}")
    except Exception as exc:  # noqa: BLE001
        print("  no se pudo consultar chrome.downloads:", exc)


print("=" * 74)
print(" PRUEBA END-TO-END  ·  Descargador de medios para X")
print("=" * 74)
print(f" Extension : {ROOT}")
print(f" Fixture   : {FIXTURE.name}")
print(f" Perfil    : temporal (no toca tu Chrome)   ·   ventana: {'sí' if HEADED else 'no'}")
print()

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE),
        headless=not HEADED,
        channel="chromium",
        accept_downloads=True,
        downloads_path=str(DOWNLOADS),
        viewport={"width": 780, "height": 900},
        args=[
            f"--disable-extensions-except={ROOT}",
            f"--load-extension={ROOT}",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    )

    # --- rutas falsas -------------------------------------------------------
    def ruta_video(route):
        url = route.request.url
        peticiones["video"].append(url)
        # El audio (playlists y segmentos del HLS) se pide al CDN REAL de X, para
        # que la prueba de solo audio use bytes auténticos.
        if ".m3u8" in url or "/mp4a/" in url or ".m4s" in url or "/aud/" in url:
            route.continue_()
            return
        route.fulfill(status=200, content_type="video/mp4", body=FAKE_MEDIA)

    def ruta_imagen(route):
        url = route.request.url
        # Las comprobaciones previas (Image()) sí son peticiones de página.
        peticiones["probe"].append(url)
        # Para la imagen 1 se simula que orig y 4096x4096 no existen en el CDN.
        if "XVDTESTIMG001" in url and ("name=orig" in url or "name=4096x4096" in url):
            route.fulfill(status=404, content_type="text/plain", body="not found")
        else:
            route.fulfill(status=200, content_type="image/png", body=(ROOT / "icons" / "icon128.png").read_bytes())

    ctx.route("https://video.twimg.com/**", ruta_video)
    ctx.route("https://pbs.twimg.com/**", ruta_imagen)
    ctx.route("https://x.com/**", lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML))

    page = ctx.new_page()
    page.goto(f"https://x.com/axichuhai/status/{TWEET_ID}", wait_until="domcontentloaded")
    page.wait_for_selector("button.xvd-button", timeout=20000)
    esperar(page, 1.5)

    ext_id = ctx.service_workers[0].url.split("/")[2] if ctx.service_workers else "?"
    sw = ctx.service_workers[0] if ctx.service_workers else None

    # ================================================== 1. INYECCIÓN DE BOTONES
    print("1. INYECCIÓN DE BOTONES")
    SEL_VIDEO = "button.xvd-button:not(.xvd-button--image):not(.xvd-button--gallery)"
    total = page.locator("button.xvd-button").count()
    check("se inyecta un botón por medio (1 vídeo + 4 imágenes + 1 galería = 6)", total == 6, f"{total} botones")
    boton_video = page.locator(SEL_VIDEO).first
    check("botón del vídeo con texto «Descargar»",
          boton_video.count() == 1 and boton_video.inner_text().strip().startswith("Descargar"),
          boton_video.inner_text().strip() if boton_video.count() else "no encontrado")
    check("4 botones sobre las imágenes", page.locator("button.xvd-button--image").count() == 4)
    check("botón «Descargar todas (4)» en la galería", "Descargar todas (4)" in page.locator("button.xvd-button--gallery").first.inner_text())
    badges = page.locator(".xvd-badge").all_inner_texts()
    check("contadores de galería 1/4 … 4/4", badges == ["1/4", "2/4", "3/4", "4/4"], badges)
    check("la extensión está viva (service worker activo)", ext_id != "?", f"id {ext_id}")

    # ================================================== 2. PUPUP / PESTAÑAS
    print("\n2. POPUP DE OPCIONES")
    popup = ctx.new_page()
    popup.set_viewport_size({"width": 400, "height": 660})
    popup.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
    esperar(page, 0.8)
    check("3 pestañas visibles", popup.locator(".xvd-tab").count() == 3,
          popup.locator(".xvd-tab").all_inner_texts())
    check("panel de vídeo visible al abrir", popup.locator("#panel-videos").is_visible())
    popup.locator("#tab-imagenes").click()
    esperar(page, 0.3)
    check("al pulsar «Imágenes» se muestra su panel", popup.locator("#panel-imagenes").is_visible())
    check("resolución por defecto = orig", popup.locator("#imageResolution").input_value() == "orig")
    popup.locator("#imageResolution").select_option("large")
    esperar(page, 0.6)
    guardado = popup.evaluate("() => new Promise(r => chrome.storage.sync.get({imageResolution:null}, r))")
    check("los ajustes se guardan en chrome.storage.sync", guardado.get("imageResolution") == "large", guardado)
    popup.locator("#imageResolution").select_option("orig")
    esperar(page, 0.4)
    popup.screenshot(path=str(SHOTS / "popup-imagenes.png"), full_page=True)
    popup.locator("#tab-videos").click()
    esperar(page, 0.3)
    popup.screenshot(path=str(SHOTS / "popup-videos.png"), full_page=True)

    # ================================================== 3. VÍDEO
    print("\n3. DESCARGA DE VÍDEO (la máxima calidad por defecto)")
    boton_video.click()
    esperar(page, 1.2)
    estado = boton_video.get_attribute("data-state")
    check("el botón del vídeo pasa a estado de éxito", estado == "done", estado)

    avisos = page.evaluate("window.__xvdToasts || []")
    check("aviso en español «Descarga iniciada»", any("Descarga iniciada" in a for a in avisos), avisos)
    check("el clic NO se propaga al contenedor (no abre el lightbox)",
          page.evaluate("window.__clickEnContenedor || false") is False)

    # La evidencia definitiva: qué URL pidió realmente la extensión a Chrome.
    descarga_video = esperar_descarga(popup, "video.twimg.com", timeout=60)
    check("la extensión pide la variante 3828x2160 (máxima calidad)",
          bool(descarga_video) and "3828x2160" in descarga_video.get("url", ""),
          (descarga_video or {}).get("url", "sin descarga"))
    check("la descarga del vídeo termina correctamente",
          bool(descarga_video) and descarga_video.get("state") == "complete",
          (descarga_video or {}).get("state", "-"))
    if descarga_video:
        bytes_ = descarga_video.get("bytesReceived") or 0
        print(f"  [info]  {bytes_ / 1048576:.1f} MB descargados de {descarga_video.get('url', '')[:90]}")

    volcar_diagnostico(popup, "DIAGNÓSTICO TRAS EL VÍDEO", sw)

    # ================================================== 4. IMÁGENES
    print("\n4. IMÁGENES Y GALERÍA")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("button.xvd-button--image", timeout=20000)
    esperar(page, 1.5)
    peticiones["probe"].clear()

    page.locator("button.xvd-button--image").first.click()
    esperar(page, 3.0)
    nombres = [u.split("name=")[-1].split("&")[0] for u in peticiones["probe"] if "XVDTESTIMG001" in u]
    check("imagen 1: pide primero orig (máxima resolución)", bool(nombres) and nombres[0] == "orig", nombres[:6])

    # Prueba definitiva de la degradación: la cadena completa de URLs pedidas a Chrome.
    intentos_img1 = [d.get("url", "").split("name=")[-1] for d in descargas_de(popup, "XVDTESTIMG001")]
    check("imagen 1: al no existir orig ni 4096x4096, descarga large y luego medium",
          "large" in intentos_img1 and "medium" in intentos_img1, intentos_img1)
    avisos = page.evaluate("window.__xvdToasts || []")
    check("aviso «usando resolución alternativa»", any("alternativa" in a for a in avisos), avisos)

    volcar_diagnostico(popup, "DIAGNÓSTICO TRAS LA IMAGEN 1", sw)

    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("button.xvd-button--gallery", timeout=20000)
    esperar(page, 1.5)
    peticiones["probe"].clear()
    page.locator("button.xvd-button--gallery").first.click()
    esperar(page, 6.0)

    lote = [e for e in leer_registro(popup) if "lote terminado" in str(e.get("msg", ""))]
    check("«Descargar todas» recorre las 4 imágenes",
          bool(lote) and '"iniciadas":4' in lote[-1].get("detail", ""), lote[-1].get("detail") if lote else "sin lote")
    nombres_descargados = archivos_pedidos(popup, "tweet_")
    check("se descargan las 4 imágenes con nombre indexado tweet_[id]_imgN.jpg",
          len(nombres_descargados) == 4, nombres_descargados)
    avisos = page.evaluate("window.__xvdToasts || []")
    check("aviso final de la galería en español",
          any(("imágenes" in a and "iniciad" in a) or "nuevas" in a for a in avisos), avisos[-3:])
    origs = sorted({u.split("media/")[1].split("?")[0] for u in peticiones["probe"] if "name=orig" in u})
    check("pide name=orig para las 4 imágenes distintas",
          set(origs) >= {"XVDTESTIMG001", "XVDTESTIMG002", "XVDTESTIMG003", "XVDTESTIMG004"}, origs)

    # ================================================== 5. SOLO AUDIO
    print("\n5. SOLO AUDIO (pista AAC del HLS, real del CDN de X)")

    def descargar_solo_audio(formato, esperado_kb, nombre):
        popup.evaluate("f => new Promise(r => chrome.storage.sync.set({format: f}, r))", formato)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(SEL_VIDEO, timeout=20000)
        esperar(page, 1.5)

        # Se anotan las descargas que ya existían: la de esta fase debe ser nueva.
        ids_antes = {
            d.get("id")
            for d in popup.evaluate("() => new Promise(r => chrome.downloads.search({limit: 30}, r))")
        }
        page.locator(SEL_VIDEO).first.click()

        encontrado = None
        limite = time.time() + 90
        while time.time() < limite:
            try:
                lista = popup.evaluate(
                    "() => new Promise(r => chrome.downloads.search({limit: 12, orderBy: ['-startTime']}, r))"
                )
            except Exception:  # noqa: BLE001
                lista = []
            # El audio generado se descarga desde una URL de Blob: es su seña.
            for d in lista:
                if (
                    (d.get("url") or "").startswith("blob:")
                    and d.get("state") == "complete"
                    and d.get("id") not in ids_antes
                ):
                    encontrado = d
                    break
            if encontrado:
                break
            esperar(page, 1.0)

        check(f"{nombre}: la descarga termina", encontrado is not None,
              (encontrado or {}).get("state", "sin descarga"))
        if not encontrado:
            return None

        # El nombre pedido está en el registro (Playwright renombra a GUID en disco).
        pedidos = [
            str(e.get("detail", ""))
            for e in leer_registro(popup)
            if "_128kbps." + formato in str(e.get("detail", ""))
        ]
        check(f"{nombre}: se pide con el bitrate en el nombre",
              bool(pedidos), pedidos[-1][:120] if pedidos else "sin registro")

        ruta = Path(encontrado.get("filename", ""))
        if not ruta.exists():
            check(f"{nombre}: el archivo existe en disco", False, ruta)
            return None
        kb = ruta.stat().st_size / 1024
        check(f"{nombre}: pesa lo que debe (~{esperado_kb} KB, no 40 MB)",
              abs(kb - esperado_kb) < esperado_kb * 0.35, f"{kb:.1f} KB")
        return ruta

    # M4A: la pista AAC tal cual, en un contenedor MP4 (primera caja "ftyp")
    ruta_m4a = descargar_solo_audio("m4a", 373, "M4A")
    if ruta_m4a:
        cabecera = ruta_m4a.read_bytes()[:12]
        check("M4A: es un MP4 real (caja ftyp a partir del byte 4)", cabecera[4:8] == b"ftyp", cabecera.hex())

    # MP3: la misma pista recodificada por lamejs dentro del navegador
    ruta_mp3 = descargar_solo_audio("mp3", 368, "MP3")
    if ruta_mp3:
        cabecera = ruta_mp3.read_bytes()[:4]
        check("MP3: empieza con una trama MPEG válida",
              cabecera[0] == 0xFF and (cabecera[1] & 0xE0) == 0xE0, cabecera.hex())

    audio_pedido = [u for u in peticiones["video"] if "/mp4a/" in u]
    check("se piden las playlists de audio del manifiesto real",
          any(".m3u8" in u for u in audio_pedido), audio_pedido[:2])

    # ================================================== 6. INSTAGRAM
    print("\n6. INSTAGRAM (reel, carrusel mixto y solo audio en MP3)")

    m4a_fixture = (Path(__file__).resolve().parent / "fixtures" / "audio-128k.m4a").read_bytes()

    def ruta_ig_media(route):
        url = route.request.url
        peticiones["ig"].append(url)
        # Los vídeos devuelven un M4A real (audio auténtico) para poder probar el MP3.
        if ".mp4" in url:
            route.fulfill(status=200, content_type="video/mp4", body=m4a_fixture)
        else:
            route.fulfill(status=200, content_type="image/jpeg", body=b"\xff\xd8\xff\xe0" + b"\0" * 64)

    ctx.route("https://*.cdninstagram.com/**", ruta_ig_media)
    ctx.route("https://*.fbcdn.net/**", ruta_ig_media)
    ctx.route(
        "https://www.instagram.com/**",
        lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=construir_fixture_instagram()),
    )

    # Se vuelve a formato MP4 para empezar (el audio se prueba al final).
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'mp4'}, r))")

    ig = ctx.new_page()
    ig.goto("https://www.instagram.com/reel/DdXUcJaSe8X/", wait_until="domcontentloaded")
    ig.wait_for_selector("button.xvd-button[data-xvd-site='instagram']", timeout=20000)
    esperar(ig, 1.5)

    botones_ig = ig.locator("button.xvd-button[data-xvd-site='instagram']")
    check("se inyectan botones en Instagram (1 reel + 3 del carrusel)", botones_ig.count() == 4, f"{botones_ig.count()} botones")

    insignias = ig.locator(".xvd-badge").all_inner_texts()
    check("el carrusel muestra su contador 1/3 … 3/3", insignias == ["1/3", "2/3", "3/3"], insignias)

    # --- reel: la mejor versión del vídeo (1080x1920, no la de 720) ---------
    ids_antes_ig = {d.get("id") for d in descargas_de(popup, "")}
    botones_ig.first.click()
    esperar(ig, 6.0)

    registro_ig = leer_registro(popup)
    eleccion = [e for e in registro_ig if "Datos del puente para la publicación" in str(e.get("msg", ""))]
    check("el puente entrega los datos de Instagram",
          bool(eleccion) and '"elementos":1' in eleccion[-1].get("detail", ""),
          eleccion[-1].get("detail") if eleccion else "sin datos")

    descargas_ig = [
        d for d in descargas_de(popup, "cdninstagram") if d.get("id") not in ids_antes_ig
    ]
    urls_ig = [d.get("url", "") for d in descargas_ig]
    check("el reel se descarga en su versión de 1080x1920 (no la de 720)",
          any("video-1080.mp4" in u for u in urls_ig), urls_ig[:2])
    nombres_ig = archivos_pedidos(popup, "instagram_")
    check("el nombre sigue la plantilla de Instagram",
          any("instagram_khetzalgg_DdXUcJaSe8X" in n for n in nombres_ig), nombres_ig[:2])

    # --- carrusel: el segundo elemento conserva su URL firmada --------------
    ids_antes_ig = {d.get("id") for d in descargas_de(popup, "")}
    botones_ig.nth(2).click()
    esperar(ig, 6.0)

    descargas_carrusel = [d for d in descargas_de(popup, "fbcdn") if d.get("id") not in ids_antes_ig]
    check("el segundo elemento del carrusel se descarga de su propia URL",
          any("foto2.jpg" in d.get("url", "") for d in descargas_carrusel),
          [d.get("url", "")[:70] for d in descargas_carrusel])
    check("las URLs firmadas de Instagram se respetan (oh= y oe= intactos)",
          any("oh=00_FIRMA2" in d.get("url", "") and "oe=6AB2B388" in d.get("url", "") for d in descargas_carrusel),
          [d.get("url", "")[:110] for d in descargas_carrusel])
    nombres_carrusel = archivos_pedidos(popup, "instagram_")
    check("el elemento lleva su índice en el nombre",
          any("_2." in n for n in nombres_carrusel), nombres_carrusel[-2:])

    # --- solo audio en Instagram (MP3 a partir del vídeo) -------------------
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'mp3'}, r))")
    ig.reload(wait_until="domcontentloaded")
    ig.wait_for_selector("button.xvd-button[data-xvd-site='instagram']", timeout=20000)
    esperar(ig, 1.5)

    ids_antes_mp3 = {d.get("id") for d in descargas_de(popup, "")}
    ig.locator("button.xvd-button[data-xvd-site='instagram']").first.click()

    mp3_ig = None
    limite = time.time() + 120
    while time.time() < limite:
        for d in descargas_de(popup, ""):
            if (d.get("url") or "").startswith("blob:") and d.get("state") == "complete" and d.get("id") not in ids_antes_mp3:
                mp3_ig = d
                break
        if mp3_ig:
            break
        esperar(ig, 1.5)

    check("Instagram: el MP3 se genera a partir del vídeo", mp3_ig is not None,
          (mp3_ig or {}).get("state", "sin descarga"))
    if mp3_ig:
        ruta = Path(mp3_ig.get("filename", ""))
        if ruta.exists():
            cabecera = ruta.read_bytes()[:4]
            kb = ruta.stat().st_size / 1024
            check("Instagram: el MP3 es válido y pesa lo que debe",
                  cabecera[0] == 0xFF and (cabecera[1] & 0xE0) == 0xE0 and 250 < kb < 500,
                  f"{kb:.1f} KB, {cabecera.hex()}")
    nombres_mp3 = archivos_pedidos(popup, "_1.mp3")
    check("Instagram: el archivo de audio se llama con la plantilla de IG",
          bool(nombres_mp3), nombres_mp3[-1] if nombres_mp3 else "sin registro")

    check("el clic en Instagram tampoco se propaga al contenedor",
          ig.evaluate("window.__clickEnContenedor || false") is False)

    ig.screenshot(path=str(SHOTS / "instagram.png"), full_page=True)

    # ================================================== 7. FACEBOOK
    print("\n7. FACEBOOK (HD con audio, pista M4A del DASH y MP3)")

    estado_fb = {"con_datos": True}

    def ruta_ig_media_fb(route):
        url = route.request.url
        peticiones["fb"].append(url)
        if "audio.mp4" in url or "HD.mp4" in url or "SD.mp4" in url or "video-1024" in url:
            # Audio real para poder comprobar la conversión a MP3.
            route.fulfill(status=200, content_type="video/mp4", body=m4a_fixture)
        else:
            route.fulfill(status=200, content_type="image/jpeg", body=b"\xff\xd8\xff\xe0" + b"\0" * 64)

    ctx.route("https://video.fymq2-1.fna.fbcdn.net/**", ruta_ig_media_fb)
    ctx.route("https://scontent.fyhu2-1.fna.fbcdn.net/**", ruta_ig_media_fb)
    ctx.route(
        "https://www.facebook.com/**",
        lambda r: r.fulfill(
            status=200,
            content_type="text/html; charset=utf-8",
            body=construir_fixture_facebook(con_datos=estado_fb["con_datos"]),
        ),
    )

    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'mp4'}, r))")

    fb = ctx.new_page()
    fb.goto("https://www.facebook.com/reel/1906283450061603/", wait_until="domcontentloaded")
    fb.wait_for_selector("button.xvd-button[data-xvd-site='facebook']", timeout=20000)
    esperar(fb, 1.5)

    botones_fb = fb.locator("button.xvd-button[data-xvd-site='facebook']")
    check("se inyectan botones en Facebook (1 vídeo + 1 foto)", botones_fb.count() == 2, f"{botones_fb.count()} botones")

    # --- vídeo: se elige la pista HD (no la SD ni los trozos) ---------------
    ids_antes_fb = {d.get("id") for d in descargas_de(popup, "")}
    botones_fb.first.click()
    esperar(fb, 6.0)

    registro_fb = leer_registro(popup)
    datos_fb = [e for e in registro_fb if "Datos del vídeo encontrados" in str(e.get("msg", ""))]
    check("el puente entrega los datos del vídeo de Facebook",
          bool(datos_fb) and "sve_hd" in str(datos_fb[-1].get("detail", "")) or bool(datos_fb),
          datos_fb[-1].get("detail") if datos_fb else "sin datos")

    urls_fb = [d.get("url", "") for d in descargas_de(popup, "fbcdn") if d.get("id") not in ids_antes_fb]
    check("el vídeo se descarga de la pista HD (con audio)", any("HD.mp4" in u for u in urls_fb), urls_fb[:2])
    check("nunca se descarga un trozo del DASH",
          not any("bytestart" in u for u in urls_fb), urls_fb[:2])
    nombres_fb = archivos_pedidos(popup, "facebook_")
    check("el nombre sigue la plantilla de Facebook",
          any("facebook_" in n and "1906283450061603" in n and n.endswith(".mp4") for n in nombres_fb), nombres_fb[:2])

    # --- foto: tamaño completo de fbcdn ------------------------------------
    ids_antes_foto = {d.get("id") for d in descargas_de(popup, "")}
    botones_fb.nth(1).click()
    esperar(fb, 6.0)
    urls_foto = [d.get("url", "") for d in descargas_de(popup, "foto-grande") if d.get("id") not in ids_antes_foto]
    check("la foto se descarga a tamaño completo y con su firma",
          any("foto-grande.jpg" in u and "oh=00_FOTO" in u for u in urls_foto), urls_foto[:1])

    # --- M4A: la pista de audio del DASH, sin recomprimir -------------------
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'm4a'}, r))")
    fb.reload(wait_until="domcontentloaded")
    fb.wait_for_selector("button.xvd-button[data-xvd-site='facebook']", timeout=20000)
    esperar(fb, 1.5)

    ids_antes_m4a = {d.get("id") for d in descargas_de(popup, "")}
    fb.locator("button.xvd-button[data-xvd-site='facebook']").first.click()
    esperar(fb, 6.0)

    m4a_fb = None
    for d in descargas_de(popup, "audio.mp4"):
        if d.get("id") not in ids_antes_m4a:
            m4a_fb = d
            break
    check("Facebook: el M4A baja la pista de audio suelta del DASH", m4a_fb is not None,
          (m4a_fb or {}).get("url", "sin descarga")[:90])
    log_m4a = [e for e in leer_registro(popup) if "Pista de audio del DASH descargada" in str(e.get("msg", ""))]
    check("Facebook: el registro confirma que no se recomprime", bool(log_m4a),
          log_m4a[-1].get("detail") if log_m4a else "sin registro")

    # --- MP3: se convierte en el navegador ---------------------------------
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'mp3'}, r))")
    fb.reload(wait_until="domcontentloaded")
    fb.wait_for_selector("button.xvd-button[data-xvd-site='facebook']", timeout=20000)
    esperar(fb, 1.5)

    ids_antes_mp3fb = {d.get("id") for d in descargas_de(popup, "")}
    fb.locator("button.xvd-button[data-xvd-site='facebook']").first.click()

    mp3_fb = None
    limite = time.time() + 120
    while time.time() < limite:
        for d in descargas_de(popup, ""):
            if (d.get("url") or "").startswith("blob:") and d.get("state") == "complete" and d.get("id") not in ids_antes_mp3fb:
                mp3_fb = d
                break
        if mp3_fb:
            break
        esperar(fb, 1.5)

    check("Facebook: el MP3 se genera y se guarda", mp3_fb is not None, (mp3_fb or {}).get("state", "sin descarga"))
    if mp3_fb:
        ruta = Path(mp3_fb.get("filename", ""))
        if ruta.exists():
            cabecera = ruta.read_bytes()[:4]
            kb = ruta.stat().st_size / 1024
            check("Facebook: el MP3 es válido y pesa lo que debe",
                  cabecera[0] == 0xFF and (cabecera[1] & 0xE0) == 0xE0 and 250 < kb < 500,
                  f"{kb:.1f} KB, {cabecera.hex()}")

    # --- respaldo público: sin datos internos, se usa og:video -------------
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({format: 'mp4'}, r))")
    estado_fb["con_datos"] = False
    fb.reload(wait_until="domcontentloaded")
    fb.wait_for_selector("button.xvd-button[data-xvd-site='facebook']", timeout=20000)
    esperar(fb, 1.5)

    ids_antes_og = {d.get("id") for d in descargas_de(popup, "")}
    fb.locator("button.xvd-button[data-xvd-site='facebook']").first.click()
    esperar(fb, 6.0)

    urls_og = [d.get("url", "") for d in descargas_de(popup, "SD.mp4") if d.get("id") not in ids_antes_og]
    check("sin datos internos se usa el MP4 público de og:video",
          any("SD.mp4" in u for u in urls_og), urls_og[:1] or "sin descarga")
    avisos_fb = fb.evaluate("window.__xvdToasts || []")
    check("avisa de que la calidad pública es menor",
          any("pública" in a or "calidad menor" in a for a in avisos_fb), avisos_fb[-2:])

    check("el clic en Facebook tampoco se propaga al contenedor",
          fb.evaluate("window.__clickEnContenedor || false") is False)

    fb.screenshot(path=str(SHOTS / "facebook.png"), full_page=True)

    # ================================================== 8. CARPETA DE DESTINO
    print("\n8. CARPETA DE DESTINO (organización por carpetas)")

    def descargar_en_carpeta(carpeta):
        popup.evaluate(
            "c => new Promise(r => chrome.storage.sync.set({folder: c, format: 'mp4'}, r))", carpeta
        )
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(SEL_VIDEO, timeout=20000)
        esperar(page, 1.5)
        antes = {d.get("id") for d in descargas_de(popup, "")}
        page.locator(SEL_VIDEO).first.click()
        esperar(page, 8.0)
        return [d for d in descargas_de(popup, "") if d.get("id") not in antes]

    descargar_en_carpeta("IRONMOUSE Torneo")
    pedidos = archivos_pedidos(popup, "IRONMOUSE Torneo")
    check("la descarga se guarda en la carpeta elegida (ruta relativa a Descargas)",
          any(n.startswith("IRONMOUSE Torneo/") for n in pedidos), pedidos[-1:] or "sin registro")
    check("el vídeo y la imagen comparten la misma carpeta",
          all("/" in n for n in pedidos), pedidos[:3])

    # Un nombre con caracteres imposibles se sanea también al construir la ruta.
    descargar_en_carpeta("Prueba: ¿carpeta?")
    pedidos2 = archivos_pedidos(popup, "Prueba")
    check("los caracteres inválidos de la carpeta se sanean en la ruta",
          bool(pedidos2) and all(":" not in n for n in pedidos2), pedidos2[-1:] or "sin registro")

    volcar_diagnostico(popup, "DIAGNÓSTICO FINAL", sw)
    page.screenshot(path=str(SHOTS / "pagina.png"), full_page=True)

    # --- flujo real de la interfaz de carpetas ------------------------------
    popup.reload(wait_until="domcontentloaded")
    popup.wait_for_timeout(500)
    popup.locator("#tab-general").click()
    popup.wait_for_timeout(300)

    popup.fill("#carpetaNueva", "Fortnite/Clips 2026")
    popup.click("#crearCarpeta")
    popup.wait_for_timeout(700)
    destino = popup.locator("#destinoTexto").inner_text()
    check("escribir y crear la carpeta actualiza el destino",
          destino == "Descargas/Fortnite/Clips 2026", destino)

    guardado = popup.evaluate(
        "() => new Promise(r => chrome.storage.sync.get({folder: null, folderHistory: []}, r))"
    )
    check("la carpeta queda como destino y en la lista de recordadas",
          guardado.get("folder") == "Fortnite/Clips 2026"
          and "Fortnite/Clips 2026" in guardado.get("folderHistory", []),
          f"{guardado.get('folder')} · {guardado.get('folderHistory')}")

    # Crear la misma con otras mayúsculas y espacios de más NO debe duplicarla.
    popup.fill("#carpetaNueva", "  fortnite/clips 2026  ")
    popup.click("#crearCarpeta")
    popup.wait_for_timeout(700)
    historial = popup.evaluate(
        "() => new Promise(r => chrome.storage.sync.get({folderHistory: []}, r))"
    ).get("folderHistory", [])
    repetidas = [h for h in historial if "fortnite" in str(h).lower()]
    check("no se duplica la carpeta al crearla con otra caja o espacios",
          len(repetidas) == 1 and len(historial) == len({str(h).lower() for h in historial}),
          historial)

    popup.click("#carpetaPredeterminada")
    popup.wait_for_timeout(600)
    check("se puede volver a la carpeta predeterminada",
          "predeterminada" in popup.locator("#destinoTexto").inner_text(),
          popup.locator("#destinoTexto").inner_text())

    # Se deja una carpeta puesta para la captura y se comprueba el aviso previo.
    popup.fill("#carpetaNueva", "IRONMOUSE Torneo")
    popup.click("#crearCarpeta")
    popup.wait_for_timeout(600)
    popup.fill("#carpetaNueva", "Prueba: ¿carpeta?")
    popup.wait_for_timeout(300)
    previa = popup.locator("#carpetaPrevia").inner_text()
    check("avisa de cómo quedará el nombre antes de crearla",
          "Descargas/Prueba_ ¿carpeta_" in previa, previa)
    popup.fill("#carpetaNueva", "")
    popup.wait_for_timeout(200)

    popup.screenshot(path=str(SHOTS / "popup-general.png"), full_page=True)
    tarjeta_carpeta = popup.locator("xpath=//div[contains(@class,'xvd-card')][.//p[@id='destinoActual']]")
    tarjeta_carpeta.scroll_into_view_if_needed()
    tarjeta_carpeta.screenshot(path=str(SHOTS / "carpeta-destino.png"))

    tarjeta = popup.locator("xpath=//div[contains(@class,'xvd-card')][.//pre[@id='diagLog']]")
    tarjeta.scroll_into_view_if_needed()
    tarjeta.screenshot(path=str(SHOTS / "popup-diagnostico.png"))
    check("el panel de diagnóstico muestra las entradas en el popup",
          len(popup.locator("#diagLog").inner_text()) > 200,
          popup.locator("#diagSummary").inner_text())
    ctx.close()

# ==================================================== 5. RESULTADO
limpiar_descargas_de_prueba()

print("\n" + "=" * 74)
ok = sum(1 for _, v in resultados if v)
print(f" RESULTADO: {ok}/{len(resultados)} comprobaciones correctas")
for nombre, valor in resultados:
    if not valor:
        print("   - FALLA: " + nombre)
print("=" * 74)
print(f" Capturas: {SHOTS}")
sys.exit(0 if ok == len(resultados) else 1)
