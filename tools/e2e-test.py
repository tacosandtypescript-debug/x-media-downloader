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
peticiones = {"video": [], "imagen": [], "probe": []}


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
        if "despachado" not in str(entrada.get("msg", "")) or contiene not in detalle:
            continue
        try:
            nombres.add(json.loads(detalle).get("archivo", ""))
        except Exception:  # noqa: BLE001
            continue
    return sorted(n for n in nombres if n)


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

    avisos = page.evaluate("window.__xvdToasts")
    check("aviso en español «Descarga iniciada»", any("Descarga iniciada" in a for a in avisos), avisos)
    check("el clic NO se propaga al contenedor (no abre el lightbox)",
          page.evaluate("window.__clickEnContenedor") is False)

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
    avisos = page.evaluate("window.__xvdToasts")
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
    avisos = page.evaluate("window.__xvdToasts")
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

    volcar_diagnostico(popup, "DIAGNÓSTICO FINAL", sw)
    page.screenshot(path=str(SHOTS / "pagina.png"), full_page=True)
    # Captura del popup con el registro de diagnóstico ya relleno.
    popup.locator("#tab-general").click()
    esperar(page, 1.0)
    popup.screenshot(path=str(SHOTS / "popup-general.png"), full_page=True)
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
