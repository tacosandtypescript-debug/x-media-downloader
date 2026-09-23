/**
 * Descargador de medios para X — Popup de opciones
 * ---------------------------------------------------------------------------
 * Panel unificado con tres pestañas: Videos, Imágenes y General.
 * Toda la interfaz está en español. Los ajustes se guardan en
 * chrome.storage.sync (con respaldo en chrome.storage.local) y se aplican al
 * instante en las pestañas abiertas gracias a chrome.storage.onChanged.
 */

'use strict';

const DEFAULT_SETTINGS = {
  /* --- General --- */
  enabled: true,
  folder: 'X Videos',
  askWhereToSave: false,
  showToasts: true,
  showOnHover: false,
  copyLinkButton: true,
  /* --- Videos --- */
  format: 'auto',
  quality: 'max',
  minHeight: 1080,
  filenameTemplate: '{usuario}_{id}_{calidad}',
  autoFallback: true,
  audioFallback: 'mp4',
  hlsFallback: false,
  /* --- Imágenes --- */
  imagesEnabled: true,
  imageResolution: 'orig',
  imageFormat: 'auto',
  galleryButton: true,
  compactImageButton: false,
  imageFallback: true,
  imageVerify: true,
  imageFilenameTemplate: 'tweet_{id}_img{indice}',
  /* --- Otros sitios --- */
  instagramEnabled: true,
  instagramFilenameTemplate: 'instagram_{usuario}_{id}_{indice}',
  facebookEnabled: true,
  facebookFilenameTemplate: 'facebook_{usuario}_{id}_{indice}',
  youtubeEnabled: true,
  youtubeFilenameTemplate: 'youtube_{usuario}_{titulo}_{id}',
  youtubeCodec: 'h264',
  youtubeCookies: false,
  pixabayEnabled: true,
  pixabayFilenameTemplate: 'pixabay_{usuario}_{nombre}_{id}',
  folderHistory: []
};

const FORMAT_HINTS = {
  auto: '<strong>Auto</strong> elige la mejor variante disponible (normalmente MP4).',
  mp4: '<strong>MP4</strong> máxima compatibilidad. Si el video no tiene MP4, se avisa y se usa WebM.',
  webm: '<strong>WebM</strong> útil para códecs VP9/AV1. Si no existe, se descarga MP4 en la misma calidad.',
  m4a:
    '<strong>M4A · solo audio</strong> baja la pista AAC del stream (128 kbps) y la guarda sin recomprimir: ' +
    '370 KB en vez de 40 MB. Si el video no publica pista aparte, se avisa.',
  mp3:
    '<strong>MP3 · solo audio</strong> baja esa misma pista y la convierte a MP3 en tu equipo (tarda ~1 s ' +
    'por minuto de audio). Recomprimir baja un poco la calidad; si quieres la original, usa M4A.'
};

const IMAGE_FORMAT_HINTS = {
  auto: '<strong>Auto</strong> respeta el formato original (JPG, PNG, WEBP o GIF).',
  jpg: '<strong>JPG</strong> se convierte en el CDN de X. Buena compatibilidad; sin transparencia.',
  png: '<strong>PNG</strong> se convierte en el CDN de X. Sin pérdida, pero archivos mucho más grandes.',
  webp: '<strong>WEBP</strong> se convierte en el CDN de X. Mejor compresión; soporte moderno.'
};

const TABS = ['videos', 'imagenes', 'general'];
const LAST_TAB_KEY = 'xvd_active_tab';

/** Clave del registro de diagnóstico (chrome.storage.session). */
const LOG_KEY = 'xvd_log';
const LOG_VISIBLE = 80;

const elements = {};

/**
 * Carpetas de destino: la que está activa (ruta relativa dentro de Descargas) y
 * la lista de las usadas antes, para poder elegirlas en el desplegable.
 */
let carpetaActual = '';
let historialCarpetas = [];

/** Última respuesta del content script y URL de la pestaña, para el informe. */
let ultimoPing = null;
let ultimoTabUrl = '';

/* =======================================================================
 * Utilidades
 * ===================================================================== */

function $(id) {
  return document.getElementById(id);
}

function status(message, kind = '') {
  const node = elements.saveStatus;
  if (!node) return;
  node.textContent = message;
  node.className = 'xvd-save' + (kind ? ' xvd-save--' + kind : '');
  if (message) {
    setTimeout(() => {
      if (node.textContent === message) {
        node.textContent = '';
        node.className = 'xvd-save';
      }
    }, 2400);
  }
}

function getStored(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (stored) => {
      if (chrome.runtime.lastError || !stored) {
        chrome.storage.local.get(keys, (local) => resolve({ ...DEFAULT_SETTINGS, ...(local || {}) }));
        return;
      }
      resolve({ ...DEFAULT_SETTINGS, ...stored });
    });
  });
}

function setStored(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) {
        chrome.storage.local.set(values, () => resolve());
        return;
      }
      resolve();
    });
  });
}

function getLocal(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (stored) => {
        void chrome.runtime.lastError;
        resolve(stored ? stored[key] : undefined);
      });
    } catch (_) {
      resolve(undefined);
    }
  });
}

function setLocal(values) {
  try {
    chrome.storage.local.set(values);
  } catch (_) {
    /* preferencia de interfaz: no es crítico */
  }
}

/* =======================================================================
 * Pestañas
 * ===================================================================== */

function activateTab(name) {
  const target = TABS.includes(name) ? name : 'videos';
  TABS.forEach((tab) => {
    const button = $('tab-' + tab);
    const panel = $('panel-' + tab);
    if (!button || !panel) return;
    const active = tab === target;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  });
  setLocal({ [LAST_TAB_KEY]: target });
  if (target === 'general') renderDiagnostico();
}

function initTabs() {
  TABS.forEach((tab) => {
    const button = $('tab-' + tab);
    if (!button) return;
    button.addEventListener('click', () => activateTab(tab));
    button.addEventListener('keydown', (event) => {
      const index = TABS.indexOf(tab);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length;
        activateTab(TABS[next]);
        const target = $('tab-' + TABS[next]);
        if (target) target.focus();
      }
    });
  });
}

/* =======================================================================
 * Lectura / escritura del formulario
 * ===================================================================== */

function radioValue(name) {
  const checked = document.querySelector('input[name="' + name + '"]:checked');
  return checked ? checked.value : '';
}

function setRadio(name, value) {
  const input = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
  if (input) input.checked = true;
}

function readForm() {
  return {
    enabled: elements.enabled.checked,
    folder: carpetaActual,
    folderHistory: historialCarpetas,
    askWhereToSave: elements.askWhereToSave.checked,
    showToasts: elements.showToasts.checked,
    showOnHover: elements.showOnHover.checked,
    copyLinkButton: elements.copyLinkButton.checked,

    format: radioValue('format') || DEFAULT_SETTINGS.format,
    quality: radioValue('quality') || DEFAULT_SETTINGS.quality,
    minHeight: Number(elements.minHeight.value) || DEFAULT_SETTINGS.minHeight,
    filenameTemplate: elements.filenameTemplate.value.trim() || DEFAULT_SETTINGS.filenameTemplate,
    autoFallback: elements.autoFallback.checked,
    audioFallback: elements.audioFallback.value,
    hlsFallback: elements.hlsFallback.checked,

    imagesEnabled: elements.imagesEnabled.checked,
    imageResolution: elements.imageResolution.value,
    imageFormat: radioValue('imageFormat') || DEFAULT_SETTINGS.imageFormat,
    galleryButton: elements.galleryButton.checked,
    compactImageButton: elements.compactImageButton.checked,
    imageFallback: elements.imageFallback.checked,
    imageVerify: elements.imageVerify.checked,
    imageFilenameTemplate: elements.imageFilenameTemplate.value.trim() || DEFAULT_SETTINGS.imageFilenameTemplate,

    facebookEnabled: elements.facebookEnabled.checked,
    facebookFilenameTemplate:
      elements.facebookFilenameTemplate.value.trim() || DEFAULT_SETTINGS.facebookFilenameTemplate,

    instagramEnabled: elements.instagramEnabled.checked,
    instagramFilenameTemplate:
      elements.instagramFilenameTemplate.value.trim() || DEFAULT_SETTINGS.instagramFilenameTemplate,

    youtubeEnabled: elements.youtubeEnabled.checked,
    youtubeFilenameTemplate:
      elements.youtubeFilenameTemplate.value.trim() || DEFAULT_SETTINGS.youtubeFilenameTemplate,
    youtubeCodec: elements.youtubeCodec.value === 'max' ? 'max' : 'h264',
    youtubeCookies: elements.youtubeCookies.checked,

    pixabayEnabled: elements.pixabayEnabled.checked,
    pixabayFilenameTemplate:
      elements.pixabayFilenameTemplate.value.trim() || DEFAULT_SETTINGS.pixabayFilenameTemplate
  };
}

function fillForm(settings) {
  elements.enabled.checked = !!settings.enabled;
  carpetaActual = settings.folder || '';
  historialCarpetas = Array.isArray(settings.folderHistory) ? settings.folderHistory : [];
  renderCarpetas();
  elements.askWhereToSave.checked = !!settings.askWhereToSave;
  elements.showToasts.checked = !!settings.showToasts;
  elements.showOnHover.checked = !!settings.showOnHover;
  elements.copyLinkButton.checked = !!settings.copyLinkButton;

  setRadio('format', settings.format);
  setRadio('quality', settings.quality);
  elements.minHeight.value = String(settings.minHeight);
  elements.filenameTemplate.value = settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;
  elements.autoFallback.checked = !!settings.autoFallback;
  elements.audioFallback.value = settings.audioFallback || 'mp4';
  elements.hlsFallback.checked = !!settings.hlsFallback;

  elements.imagesEnabled.checked = !!settings.imagesEnabled;
  elements.imageResolution.value = settings.imageResolution || 'orig';
  setRadio('imageFormat', settings.imageFormat);
  elements.galleryButton.checked = !!settings.galleryButton;
  elements.compactImageButton.checked = !!settings.compactImageButton;
  elements.imageFallback.checked = !!settings.imageFallback;
  elements.imageVerify.checked = !!settings.imageVerify;
  elements.imageFilenameTemplate.value = settings.imageFilenameTemplate || DEFAULT_SETTINGS.imageFilenameTemplate;
  elements.facebookEnabled.checked = !!settings.facebookEnabled;
  elements.facebookFilenameTemplate.value =
    settings.facebookFilenameTemplate || DEFAULT_SETTINGS.facebookFilenameTemplate;
  elements.instagramEnabled.checked = !!settings.instagramEnabled;
  elements.instagramFilenameTemplate.value =
    settings.instagramFilenameTemplate || DEFAULT_SETTINGS.instagramFilenameTemplate;
  elements.youtubeEnabled.checked = !!settings.youtubeEnabled;
  elements.youtubeFilenameTemplate.value =
    settings.youtubeFilenameTemplate || DEFAULT_SETTINGS.youtubeFilenameTemplate;
  elements.youtubeCodec.value = settings.youtubeCodec === 'max' ? 'max' : 'h264';
  elements.youtubeCookies.checked = !!settings.youtubeCookies;
  elements.pixabayEnabled.checked = !!settings.pixabayEnabled;
  elements.pixabayFilenameTemplate.value =
    settings.pixabayFilenameTemplate || DEFAULT_SETTINGS.pixabayFilenameTemplate;

  syncUiState();
}

function syncUiState() {
  const format = radioValue('format') || 'auto';
  elements.formatHint.innerHTML = FORMAT_HINTS[format] || FORMAT_HINTS.auto;

  const imageFormat = radioValue('imageFormat') || 'auto';
  elements.imageFormatHint.innerHTML = IMAGE_FORMAT_HINTS[imageFormat] || IMAGE_FORMAT_HINTS.auto;

  elements.minHeight.disabled = radioValue('quality') !== 'custom';
  document.body.classList.toggle('xvd-popup--disabled', !elements.enabled.checked);
  document.body.classList.toggle('xvd-popup--images-off', !elements.imagesEnabled.checked);
}

const save = (() => {
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await setStored(readForm());
      status('Guardado ✓', 'ok');
    }, 180);
  };
})();

/* =======================================================================
 * Registro de diagnóstico
 * ===================================================================== */

function leerLog() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(LOG_KEY, (stored) => {
        void chrome.runtime.lastError;
        const lista = stored && Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
        resolve(lista);
      });
    } catch (_) {
      resolve([]);
    }
  });
}

function horaDe(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n, l) => String(n).padStart(l || 2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}

function formatearEntrada(entrada) {
  const nivel = String(entrada.level || 'info').toUpperCase().padEnd(5, ' ');
  const area = String(entrada.area || '').padEnd(11, ' ');
  return horaDe(entrada.t) + '  ' + nivel + ' ' + area + ' ' + (entrada.msg || '') + (entrada.detail ? '  ' + entrada.detail : '');
}

function construirInforme(lista) {
  const lineas = [
    '# Informe de diagnóstico · Descargador de medios para X',
    'versión extensión : ' + chrome.runtime.getManifest().version,
    'fecha             : ' + new Date().toISOString(),
    'navegador         : ' + navigator.userAgent,
    'pestaña           : ' + (ultimoTabUrl || '(ninguna)'),
    'videos / imágenes : ' + (ultimoPing ? (ultimoPing.videos || 0) + ' / ' + (ultimoPing.images || 0) : 'sin respuesta'),
    'puente MAIN       : ' +
      (ultimoPing ? (ultimoPing.bridge ? 'activo' : 'SIN RESPUESTA') : 'desconocido') +
      (ultimoPing && ultimoPing.bridgeTimeouts ? ' (tiempos agotados: ' + ultimoPing.bridgeTimeouts + ')' : ''),
    'entradas          : ' + lista.length,
    ''
  ];
  for (const entrada of lista) lineas.push(formatearEntrada(entrada));
  return lineas.join('\n');
}

let informeActual = '';

async function renderDiagnostico() {
  if (!elements.diagLog) return;
  const lista = await leerLog();
  const resumen = [chrome.runtime.getManifest().version];

  if (ultimoPing) {
    resumen.push((ultimoPing.videos || 0) + ' vídeos · ' + (ultimoPing.images || 0) + ' imágenes');
    resumen.push('puente ' + (ultimoPing.bridge ? 'activo ✓' : 'SIN RESPUESTA'));
  } else {
    resumen.push('content script sin respuesta en esta pestaña');
  }
  resumen.push(lista.length + ' entradas');
  elements.diagSummary.textContent = resumen.join(' · ');

  const visibles = lista.slice(-LOG_VISIBLE);
  elements.diagLog.textContent = visibles.length
    ? visibles.map(formatearEntrada).join('\n')
    : 'Sin registros todavía. Abre un vídeo o una imagen en X y pulsa «Descargar».';
  elements.diagLog.scrollTop = elements.diagLog.scrollHeight;

  informeActual = construirInforme(lista);
  return lista;
}

/* =======================================================================
 * Carpetas de destino
 *
 * La carpeta se guarda como ruta RELATIVA dentro de Descargas, que es lo que
 * acepta chrome.downloads: al pedir «IRONMOUSE Torneo/imagen_01.jpg» Chrome crea
 * la subcarpeta sola. Aquí solo se normaliza, se recuerda y se evitan duplicados.
 * ===================================================================== */

function carpetas() {
  return window.XVD_FOLDERS;
}

/** Pinta el destino actual y rellena la lista de carpetas recordadas. */
function renderCarpetas() {
  if (!elements.destinoTexto) return;
  const api = carpetas();
  if (!api) return;

  elements.destinoTexto.textContent = api.etiquetaDestino(carpetaActual);
  elements.destinoActual.classList.toggle(
    'xvd-destino--personalizada',
    !!api.normalizarCarpeta(carpetaActual)
  );

  if (elements.carpetasGuardadas) {
    elements.carpetasGuardadas.innerHTML = '';
    for (const carpeta of historialCarpetas) {
      const opcion = document.createElement('option');
      opcion.value = api.normalizarCarpeta(carpeta);
      elements.carpetasGuardadas.appendChild(opcion);
    }
  }
  pintarPreviaCarpeta();
}

/** Texto de ayuda bajo el campo: qué carpeta se creará o reutilizará. */
function pintarPreviaCarpeta() {
  if (!elements.carpetaPrevia || !elements.carpetaNueva) return;
  const api = carpetas();
  if (!api) return;

  const escrita = api.normalizarCarpeta(elements.carpetaNueva.value);
  if (!escrita) {
    elements.carpetaPrevia.innerHTML =
      'Escribe un nombre y pulsa «Crear carpeta». Puedes anidar con «/», por ejemplo <code>Extension/Fortnite</code>.';
    return;
  }

  const existe = historialCarpetas.some((c) => api.claveDeCarpeta(c) === api.claveDeCarpeta(escrita));
  elements.carpetaPrevia.textContent =
    (existe ? 'Ya existe, se reutilizará: ' : 'Se creará: ') + api.etiquetaDestino(escrita);
}

/** Crea (o reutiliza) una carpeta y la deja como destino de las descargas. */
function usarCarpeta(texto, opciones) {
  const cfg = opciones || {};
  const api = carpetas();
  if (!api) return;

  const resultado = api.anadirAlHistorial(historialCarpetas, texto);
  if (!resultado.carpeta) {
    status('Escribe antes un nombre de carpeta', 'error');
    return;
  }

  historialCarpetas = resultado.historial;
  carpetaActual = resultado.carpeta;
  if (elements.carpetaNueva) elements.carpetaNueva.value = '';
  renderCarpetas();
  save();

  const etiqueta = api.etiquetaDestino(carpetaActual);
  if (elements.carpetaEstado) {
    elements.carpetaEstado.textContent =
      'Los archivos se guardarán en ' + etiqueta + '. Chrome crea la carpeta en la primera descarga.';
  }
  if (!cfg.silencioso) {
    status(resultado.existia ? 'Ya existía: ' + etiqueta : 'Carpeta lista: ' + etiqueta, 'ok');
  }
}

/* =======================================================================
 * Versión y actualización
 * ===================================================================== */

/** Versión del manifest.json que hay AHORA MISMO en la carpeta de la extensión. */
async function versionEnDisco() {
  try {
    const respuesta = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const manifiesto = await respuesta.json();
    return String(manifiesto.version || '');
  } catch (_) {
    return '';
  }
}

async function renderVersion() {
  if (!elements.updateInfo) return { enMarcha: '', disco: '', hay: false };
  const enMarcha = chrome.runtime.getManifest().version;
  const disco = await versionEnDisco();
  const hay = !!disco && disco !== enMarcha;

  elements.updateInfo.innerHTML = hay
    ? 'En marcha: <strong>' + enMarcha + '</strong> · en disco: <strong>' + disco + '</strong><br />' +
      '<strong>Hay una versión nueva preparada.</strong> Pulsa «Actualizar extensión» para aplicarla.'
    : 'En marcha: <strong>' + enMarcha + '</strong> · en disco: <strong>' + (disco || enMarcha) + '</strong><br />' +
      'Estás en la última versión.';
  elements.updateApply.textContent = hay ? 'Actualizar a la ' + disco : 'Actualizar extensión';
  elements.updateApply.classList.toggle('xvd-btn--destacado', hay);

  try {
    chrome.action.setBadgeText({ text: hay ? 'NEW' : '' });
  } catch (_) {
    /* sin barra de herramientas */
  }
  return { enMarcha, disco, hay };
}

/* =======================================================================
 * Estado de la pestaña activa
 * ===================================================================== */

function pingTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'XVD_PING' }, (reply) => {
      void chrome.runtime.lastError;
      resolve(reply);
    });
  });
}

/** Si los content scripts no responden (pestaña abierta antes de instalar), los inyecta. */
async function ensureContentScript(tabId) {
  try {
    // El puente va al mundo de la página; el resto, al mundo aislado.
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['page-bridge.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js', 'images.js'] });
    return true;
  } catch (_) {
    return false;
  }
}

async function updateTabStatus() {
  const node = elements.tabStatus;
  const general = elements.generalStatus;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.url || !/^https?:\/\/([^.]+\.)?(x|twitter)\.com\//i.test(tab.url)) {
      node.textContent = 'Abre x.com o twitter.com para usar los botones de descarga.';
      node.className = 'xvd-popup__status xvd-popup__status--muted';
      if (general) general.textContent = 'Esta pestaña no es de X. Abre x.com para ver el contador de medios.';
      return;
    }

    let response = await pingTab(tab.id);
    if (!response) {
      node.textContent = 'Activando la extensión en esta pestaña…';
      await ensureContentScript(tab.id);
      response = await pingTab(tab.id);
    }
    ultimoTabUrl = tab.url || '';
    ultimoPing = response || null;

    if (response && typeof response.videos === 'number') {
      const videos = response.videos;
      const images = typeof response.images === 'number' ? response.images : 0;
      node.textContent = videos + (videos === 1 ? ' video' : ' videos') + ' · ' + images + (images === 1 ? ' imagen' : ' imágenes');
      node.className = 'xvd-popup__status xvd-popup__status--ok';
      if (general) {
        general.textContent =
          videos + (videos === 1 ? ' reproductor detectado' : ' reproductores detectados') +
          ' y ' + images + (images === 1 ? ' imagen con botón' : ' imágenes con botón') +
          ' en esta pestaña.';
      }
    } else {
      node.textContent = 'Recarga la página de X para activar los botones.';
      node.className = 'xvd-popup__status xvd-popup__status--muted';
      if (general) general.textContent = 'Recarga la pestaña de X para inyectar los content scripts.';
    }
  } catch (_) {
    node.textContent = 'No se pudo consultar la pestaña activa.';
    node.className = 'xvd-popup__status xvd-popup__status--muted';
  }

  if (!$('panel-general') || !$('panel-general').hidden) renderDiagnostico();
}

/* =======================================================================
 * Arranque
 * ===================================================================== */

async function init() {
  elements.enabled = $('enabled');
  elements.formatHint = $('formatHint');
  elements.imageFormatHint = $('imageFormatHint');
  elements.minHeight = $('minHeight');
  elements.carpetaNueva = $('carpetaNueva');
  elements.carpetasGuardadas = $('carpetasGuardadas');
  elements.destinoTexto = $('destinoTexto');
  elements.destinoActual = $('destinoActual');
  elements.carpetaPrevia = $('carpetaPrevia');
  elements.carpetaEstado = $('carpetaEstado');
  elements.askWhereToSave = $('askWhereToSave');
  elements.filenameTemplate = $('filenameTemplate');
  elements.autoFallback = $('autoFallback');
  elements.audioFallback = $('audioFallback');
  elements.hlsFallback = $('hlsFallback');
  elements.imagesEnabled = $('imagesEnabled');
  elements.imageResolution = $('imageResolution');
  elements.galleryButton = $('galleryButton');
  elements.compactImageButton = $('compactImageButton');
  elements.imageFallback = $('imageFallback');
  elements.imageVerify = $('imageVerify');
  elements.imageFilenameTemplate = $('imageFilenameTemplate');
  elements.showToasts = $('showToasts');
  elements.showOnHover = $('showOnHover');
  elements.copyLinkButton = $('copyLinkButton');
  elements.saveStatus = $('saveStatus');
  elements.tabStatus = $('tabStatus');
  elements.generalStatus = $('generalStatus');
  elements.diagLog = $('diagLog');
  elements.diagSummary = $('diagSummary');
  elements.updateInfo = $('updateInfo');
  elements.instagramEnabled = $('instagramEnabled');
  elements.facebookEnabled = $('facebookEnabled');
  elements.facebookFilenameTemplate = $('facebookFilenameTemplate');
  elements.instagramFilenameTemplate = $('instagramFilenameTemplate');
  elements.youtubeEnabled = $('youtubeEnabled');
  elements.youtubeFilenameTemplate = $('youtubeFilenameTemplate');
  elements.youtubeCodec = $('youtubeCodec');
  elements.youtubeCookies = $('youtubeCookies');
  elements.pixabayEnabled = $('pixabayEnabled');
  elements.pixabayFilenameTemplate = $('pixabayFilenameTemplate');
  elements.ytdlpEstado = $('ytdlpEstado');
  elements.ytdlpTexto = $('ytdlpTexto');
  elements.ytdlpAyuda = $('ytdlpAyuda');
  elements.updateApply = $('updateApply');

  const settings = await getStored(DEFAULT_SETTINGS);
  fillForm(settings);

  initTabs();
  activateTab(await getLocal(LAST_TAB_KEY));
  renderVersion();

  document.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('change', () => {
      syncUiState();
      save();
    });
  });
  elements.carpetaNueva.addEventListener('input', () => pintarPreviaCarpeta());
  elements.carpetaNueva.addEventListener('change', () => {
    // Si lo que hay escrito es una carpeta recordada, se usa directamente.
    const escrita = window.XVD_FOLDERS.claveDeCarpeta(elements.carpetaNueva.value);
    if (!escrita) return;
    const guardada = historialCarpetas.find((c) => window.XVD_FOLDERS.claveDeCarpeta(c) === escrita);
    if (guardada) usarCarpeta(guardada, { silencioso: true });
  });
  $('crearCarpeta').addEventListener('click', () => usarCarpeta(elements.carpetaNueva.value));
  $('carpetaPredeterminada').addEventListener('click', () => {
    carpetaActual = '';
    elements.carpetaNueva.value = '';
    renderCarpetas();
    save();
    status('Se guardará en Descargas (predeterminada)', 'ok');
  });

  [
    elements.filenameTemplate,
    elements.imageFilenameTemplate,
    elements.instagramFilenameTemplate,
    elements.facebookFilenameTemplate,
    elements.youtubeFilenameTemplate,
    elements.pixabayFilenameTemplate
  ].forEach((input) => {
    input.addEventListener('input', save);
  });


  $('reset').addEventListener('click', async () => {
    await setStored({ ...DEFAULT_SETTINGS });
    fillForm({ ...DEFAULT_SETTINGS });
    status('Valores restablecidos', 'ok');
  });

  $('openDownloads').addEventListener('click', () => {
    try {
      // Abre la carpeta de Descargas del sistema (requiere un gesto del usuario).
      chrome.downloads.showDefaultFolder();
      return;
    } catch (_) {
      /* se intenta la alternativa */
    }
    chrome.runtime.sendMessage({ type: 'XVD_OPEN_DOWNLOADS' }, (response) => {
      void chrome.runtime.lastError;
      if (response && !response.ok) status(response.error, 'error');
    });
  });

  // --- Versión y actualización -------------------------------------------
  $('updateCheck').addEventListener('click', async () => {
    const estado = await renderVersion();
    status(estado.hay ? 'Hay una versión nueva: ' + estado.disco : 'Estás en la última versión', estado.hay ? 'error' : 'ok');
  });

  $('updateApply').addEventListener('click', async () => {
    // NO se usa chrome.runtime.reload(): en las pruebas deja la extensión sin
    // volver. Se abre la página de extensiones para pulsar allí ↻, que es la vía
    // fiable, y las pestañas de X se recargan solas (vigilante de contexto).
    let abierto = false;
    try {
      await chrome.tabs.create({ url: 'chrome://extensions/' });
      abierto = true;
    } catch (_) {
      abierto = false;
    }

    status(
      abierto
        ? 'Pulsa ↻ (Actualizar) en la tarjeta de la extensión'
        : 'Abre chrome://extensions y pulsa ↻ en la extensión',
      abierto ? 'ok' : 'error'
    );
  });

  // --- Registro de diagnóstico -------------------------------------------
  $('diagRefresh').addEventListener('click', async () => {
    await updateTabStatus();
    await renderDiagnostico();
    status('Actualizado ✓', 'ok');
  });

  $('diagClear').addEventListener('click', () => {
    try {
      chrome.storage.session.remove(LOG_KEY, () => {
        void chrome.runtime.lastError;
        renderDiagnostico();
      });
    } catch (_) {
      /* sesión no disponible */
    }
    status('Registro borrado', 'ok');
  });

  $('diagCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(informeActual);
      status('Informe copiado ✓', 'ok');
    } catch (_) {
      // Alternativa si el portapapeles está bloqueado: seleccionar el texto.
      try {
        const rango = document.createRange();
        rango.selectNodeContents(elements.diagLog);
        const seleccion = window.getSelection();
        seleccion.removeAllRanges();
        seleccion.addRange(rango);
      } catch (_) {
        /* nada más que hacer */
      }
      status('Copia el texto con Ctrl+C', 'error');
    }
  });

  // --- Servicio de yt-dlp (YouTube) ---------------------------------------
  $('ytdlpComprobar').addEventListener('click', () => comprobarYtDlp(true));

  $('ytdlpActualizar').addEventListener('click', async () => {
    status('Actualizando yt-dlp… (puede tardar un minuto)', 'ok');
    elements.ytdlpTexto.textContent = 'Actualizando yt-dlp…';
    try {
      const respuesta = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'XVD_YTDLP_ACTUALIZAR' }, (r) => {
          void chrome.runtime.lastError;
          resolve(r || { ok: false, error: 'El servicio de yt-dlp no respondió.' });
        });
      });
      if (!respuesta.ok) {
        status(respuesta.error, 'error');
      } else {
        const version = (respuesta.resultado && respuesta.resultado.version) || '';
        status(version ? 'yt-dlp actualizado a ' + version : 'yt-dlp actualizado ✓', 'ok');
      }
    } catch (err) {
      status(String(err && err.message ? err.message : err), 'error');
    }
    await comprobarYtDlp(false);
  });

  $('ytdlpCarpeta').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'XVD_YTDLP_ABRIR_CARPETA', carpeta: '' }, (respuesta) => {
      void chrome.runtime.lastError;
      if (!respuesta || !respuesta.ok) {
        // Si no hay servicio instalado, al menos se abre la carpeta de Descargas.
        try {
          chrome.downloads.showDefaultFolder();
        } catch (_) {
          status('No se pudo abrir la carpeta', 'error');
        }
      }
    });
  });

  comprobarYtDlp(false);

  updateTabStatus();
  setInterval(() => {
    if (!document.hidden) renderDiagnostico();
  }, 2500);
}

/**
 * Comprueba el servicio de yt-dlp (host de mensajería nativa) y pinta su estado.
 * @param {boolean} avisar  Si se ha pulsado el botón (para dar feedback).
 */
async function comprobarYtDlp(avisar) {
  if (!elements.ytdlpTexto) return null;
  elements.ytdlpTexto.textContent = 'Comprobando…';

  const respuesta = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'XVD_YTDLP_ESTADO' }, (r) => {
        void chrome.runtime.lastError;
        resolve(r || { ok: false, error: 'Sin respuesta del service worker.' });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  const estado = respuesta && respuesta.ok ? respuesta.estado : null;
  const instalado = !!(estado && estado.ok);

  if (instalado) {
    elements.ytdlpEstado.classList.add('xvd-destino--ok');
    elements.ytdlpTexto.textContent =
      'yt-dlp ' + (estado.version || '?') + (estado.ffmpeg ? ' · ffmpeg sí' : ' · falta ffmpeg');
    if (avisar) status('Servicio listo: yt-dlp ' + (estado.version || ''), 'ok');
  } else {
    elements.ytdlpEstado.classList.remove('xvd-destino--ok');
    elements.ytdlpTexto.textContent = 'Servicio no instalado';
    if (avisar) {
      status('Ejecuta «Instalar yt-dlp para X media.cmd» para activar YouTube', 'error');
    }
  }

  if (elements.ytdlpAyuda) {
    elements.ytdlpAyuda.innerHTML = instalado
      ? 'Descargas de YouTube en <strong>' +
        escaparHtml(estado.descargas || 'Descargas') +
        '</strong>. La carpeta elegida arriba se crea dentro de esa ruta. Si alguna descarga falla, ' +
        'prueba «Actualizar yt-dlp»: YouTube cambia a menudo y yt-dlp se actualiza casi cada semana.'
      : 'Las descargas de YouTube las hace <strong>yt-dlp</strong> a través de un pequeño servicio ' +
        'local. Se instala una sola vez ejecutando <strong>«Instalar yt-dlp para X media.cmd»</strong> ' +
        '(está junto a la extensión y en el Escritorio). No abre ningún puerto ni deja procesos ' +
        'abiertos: Chrome solo lo arranca cuando pulsas «Descargar».';
  }

  return estado;
}

function escaparHtml(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

document.addEventListener('DOMContentLoaded', init);
