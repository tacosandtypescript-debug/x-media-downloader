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
  imageFilenameTemplate: 'tweet_{id}_img{indice}'
};

const FORMAT_HINTS = {
  auto: '<strong>Auto</strong> elige la mejor variante disponible (normalmente MP4).',
  mp4: '<strong>MP4</strong> máxima compatibilidad. Si el video no tiene MP4, se avisa y se usa WebM.',
  webm: '<strong>WebM</strong> útil para códecs VP9/AV1. Si no existe, se descarga MP4 en la misma calidad.',
  m4a:
    '<strong>M4A / audio</strong> descarga solo la pista de audio si X la ofrece; si no, se aplica la opción elegida.'
};

const IMAGE_FORMAT_HINTS = {
  auto: '<strong>Auto</strong> respeta el formato original (JPG, PNG, WEBP o GIF).',
  jpg: '<strong>JPG</strong> se convierte en el CDN de X. Buena compatibilidad; sin transparencia.',
  png: '<strong>PNG</strong> se convierte en el CDN de X. Sin pérdida, pero archivos mucho más grandes.',
  webp: '<strong>WEBP</strong> se convierte en el CDN de X. Mejor compresión; soporte moderno.'
};

const TABS = ['videos', 'imagenes', 'general'];
const LAST_TAB_KEY = 'xvd_active_tab';

const elements = {};

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
    folder: elements.folder.value.trim(),
    askWhereToSave: elements.askWhereToSave.checked,
    showToasts: elements.showToasts.checked,
    showOnHover: elements.showOnHover.checked,

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
    imageFilenameTemplate: elements.imageFilenameTemplate.value.trim() || DEFAULT_SETTINGS.imageFilenameTemplate
  };
}

function fillForm(settings) {
  elements.enabled.checked = !!settings.enabled;
  elements.folder.value = settings.folder || '';
  elements.askWhereToSave.checked = !!settings.askWhereToSave;
  elements.showToasts.checked = !!settings.showToasts;
  elements.showOnHover.checked = !!settings.showOnHover;

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

/** Si el content script no responde (pestaña abierta antes de instalar), lo inyecta. */
async function ensureContentScript(tabId) {
  try {
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
}

/* =======================================================================
 * Arranque
 * ===================================================================== */

async function init() {
  elements.enabled = $('enabled');
  elements.formatHint = $('formatHint');
  elements.imageFormatHint = $('imageFormatHint');
  elements.minHeight = $('minHeight');
  elements.folder = $('folder');
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
  elements.saveStatus = $('saveStatus');
  elements.tabStatus = $('tabStatus');
  elements.generalStatus = $('generalStatus');

  const settings = await getStored(DEFAULT_SETTINGS);
  fillForm(settings);

  initTabs();
  activateTab(await getLocal(LAST_TAB_KEY));

  document.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('change', () => {
      syncUiState();
      save();
    });
  });
  [elements.folder, elements.filenameTemplate, elements.imageFilenameTemplate].forEach((input) => {
    input.addEventListener('input', save);
  });
  elements.folder.addEventListener('blur', () => {
    const cleaned = elements.folder.value
      .split(/[\\/]+/)
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
    if (cleaned !== elements.folder.value) {
      elements.folder.value = cleaned;
      save();
    }
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

  updateTabStatus();
}

document.addEventListener('DOMContentLoaded', init);
