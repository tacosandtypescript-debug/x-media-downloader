#!/usr/bin/env python3
"""
Prueba de humo del módulo de Pixabay contra el SITIO REAL (con ventana).

Pixabay está detrás de Cloudflare y su reto solo pasa en un navegador de verdad,
así que esta prueba se ejecuta con ventana (no en modo oculto) y comprueba que
el puente lee los datos reales de la web y que los botones aparecen y descargan.

Uso:  python tools/e2e-pixabay-real.py
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
CARPETA = "XVD Pixabay real"
DESCARGAS = Path.home() / "Downloads"
WORK = Path(tempfile.gettempdir()) / "xvd-pixabay-real"
PROFILE = WORK / f"perfil-{int(time.time())}"
WORK.mkdir(parents=True, exist_ok=True)
for viejo in WORK.glob("perfil-*"):
    if viejo != PROFILE:
        shutil.rmtree(viejo, ignore_errors=True)

resultados = []
creados = []


def check(nombre, ok, detalle=""):
    resultados.append((nombre, bool(ok)))
    print(("  [OK]    " if ok else "  [FALLA] ") + nombre + (("  ->  " + str(detalle)) if detalle else ""))


def ffprobe(ruta):
    try:
        salida = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(ruta)],
                                capture_output=True, text=True, timeout=60, check=False)
        pistas = json.loads(salida.stdout or "{}").get("streams", [])
        return " + ".join(
            f"{p.get('codec_type')}:{p.get('codec_name')} {p.get('width') or ''}x{p.get('height') or ''}".strip()
            for p in pistas
        )
    except Exception:  # noqa: BLE001
        return "?"


def archivos_nuevos(previos):
    base = Path(tempfile.gettempdir())
    encontrados = set()
    for carpeta in base.glob("playwright-artifacts-*"):
        for f in carpeta.rglob("*"):
            if f.is_file() and not f.name.endswith(".crdownload") and str(f) not in previos:
                encontrados.add(str(f))
    if (DESCARGAS / CARPETA).exists():
        for f in (DESCARGAS / CARPETA).rglob("*"):
            if f.is_file() and not f.name.endswith(".crdownload") and str(f) not in previos:
                encontrados.add(str(f))
    return encontrados


def abrir(page, url, intentos=8):
    """Abre una página de Pixabay esperando a que pase el reto de Cloudflare."""
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    for _ in range(intentos):
        if "momento" in page.title().lower() or "just a moment" in page.title().lower():
            page.wait_for_timeout(4000)
            continue
        return True
    return False


print("=" * 74)
print(" PRUEBA DE HUMO  ·  PIXABAY REAL (con ventana)")
print("=" * 74)

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE), headless=False, channel="chromium", locale="es-ES",
        viewport={"width": 1360, "height": 900},
        user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"),
        accept_downloads=True,
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}",
              "--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
    )
    page = ctx.new_page()
    popup = ctx.new_page()
    ext_id = None
    for _ in range(20):
        ext_id = next((sw.url.split("/")[2] for sw in ctx.service_workers if sw.url.startswith("chrome-extension://")), None)
        if ext_id:
            break
        page.wait_for_timeout(500)
    popup.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
    popup.evaluate("() => new Promise(r => chrome.storage.sync.set({folder: '%s', quality: 'custom', minHeight: 720}, r))" % CARPETA)

    # ---------------------------------------------------- 1. fotos (listado)
    print("\n1. LISTADO DE IMÁGENES")
    check("la web real carga (pasa el reto de Cloudflare)", abrir(page, "https://pixabay.com/images/search/nature/"), page.title()[:60])
    for _ in range(14):
        if page.locator("button.xvd-button[data-xvd-site='pixabay']").count():
            break
        page.wait_for_timeout(3000)
    botones = page.locator("button.xvd-button[data-xvd-site='pixabay']").count()
    check("aparecen botones en las tarjetas de fotos de la web real", botones >= 3, f"{botones} botones")

    if botones:
        previos = set(str(f) for f in Path(tempfile.gettempdir()).glob("playwright-artifacts-*/**/*") if f.is_file())
        page.locator("button.xvd-button[data-xvd-site='pixabay']").first.click()
        archivo = None
        for _ in range(60):
            nuevos = archivos_nuevos(previos)
            if nuevos:
                candidato = Path(sorted(nuevos)[0])
                if candidato.exists() and candidato.stat().st_size > 0:
                    archivo = candidato
                    break
            page.wait_for_timeout(1000)
        check("la foto se descarga de verdad", bool(archivo), archivo)        if archivo:
            creados.append(archivo)
            print("     ", ffprobe(archivo), f"{archivo.stat().st_size / 1024:.0f} KB")

    registro = popup.evaluate("() => new Promise(r => chrome.storage.session.get('xvd_log', s => r(s.xvd_log || [])))")
    datos = [e for e in registro if "Datos de Pixabay recibidos" in str(e.get("msg", ""))]
    check("el puente leyó el bootstrap real de Pixabay", bool(datos), datos[-1].get("detail") if datos else "sin datos")

    # ------------------------------------------------------------ 2. música
    print("\n2. LISTADO DE MÚSICA")
    abrir(page, "https://pixabay.com/music/")
    for _ in range(14):
        if page.locator("button.xvd-button[data-xvd-site='pixabay']").count():
            break
        page.wait_for_timeout(3000)
    botones_musica = page.locator("button.xvd-button[data-xvd-site='pixabay']").count()
    check("aparecen botones en las filas de música", botones_musica >= 3, f"{botones_musica} botones")
    en_linea = page.evaluate(
        """() => [...document.querySelectorAll("button.xvd-button[data-xvd-site='pixabay']")]
                    .filter(b => /en-linea/.test(b.className)).length"""
    )
    check("los botones de música van en línea, no flotantes", en_linea >= 3, f"{en_linea} en línea")

    if botones_musica:
        previos = set(str(f) for f in Path(tempfile.gettempdir()).glob("playwright-artifacts-*/**/*") if f.is_file())
        page.locator("button.xvd-button[data-xvd-site='pixabay']").first.click()
        archivo = None
        for _ in range(60):
            nuevos = archivos_nuevos(previos)
            if nuevos:
                candidato = Path(sorted(nuevos)[0])
                if candidato.exists() and candidato.stat().st_size > 0:
                    archivo = candidato
                    break
            page.wait_for_timeout(1000)
        check("la pista de audio se descarga de verdad", bool(archivo), archivo)
        if archivo:
            creados.append(archivo)
            print("     ", ffprobe(archivo), f"{archivo.stat().st_size / 1024:.0f} KB")

    errores = [e for e in registro if e.get("level") == "error" and e.get("area") == "pixabay"]
    check("sin errores de Pixabay en el registro", not errores, [e.get("msg") for e in errores][:3])

    ctx.close()

print("\n--- ARCHIVOS DESCARGADOS ---")
for ruta in creados:
    try:
        print(f"  {ruta.name[:60]}  ({ruta.stat().st_size / 1024:.0f} KB)")
    except OSError:
        print(f"  {ruta.name[:60]}  (Playwright ya limpió su carpeta temporal)")
shutil.rmtree(DESCARGAS / CARPETA, ignore_errors=True)

fallos = [n for n, ok in resultados if not ok]
print("\n" + "=" * 74)
print(f" {len(resultados) - len(fallos)}/{len(resultados)} comprobaciones correctas")
for n in fallos:
    print(f"   FALLA: {n}")
print("=" * 74)
sys.exit(1 if fallos else 0)
