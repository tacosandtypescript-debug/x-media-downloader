/**
 * Descargador de videos para X — Service Worker (MV3)
 * ---------------------------------------------------------------------------
 * - Valida y ejecuta las descargas con chrome.downloads.download.
 * - Traduce los errores de la API de descargas al español.
 * - Vigila el estado de cada descarga y avisa al content script del resultado
 *   (para poder reintentar automáticamente con una calidad inferior).
 * - Inicializa los ajustes por defecto en la primera instalación.
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

/** downloadId -> { tabId, filename, url }. Caché en memoria + respaldo en sesión. */
const tracked = new Map();

/*
 * Un service worker de MV3 se suspende a los ~30 s de inactividad. Para no
 * perder el seguimiento de descargas largas, cada entrada se persiste en
 * chrome.storage.session (memoria, sin permisos extra y sin tocar el disco).
 */
function trackKey(downloadId) {
  return 'xvd_download_' + downloadId;
}

async function rememberDownload(downloadId, record) {
  tracked.set(downloadId, record);
  try {
    await chrome.storage.session.set({ [trackKey(downloadId)]: record });
  } catch (_) {
    /* sesión no disponible: se mantiene solo la caché en memoria */
  }
}

async function recallDownload(downloadId) {
  if (tracked.has(downloadId)) return tracked.get(downloadId);
  try {
    const key = trackKey(downloadId);
    const stored = await chrome.storage.session.get(key);
    const record = stored && stored[key];
    if (record) tracked.set(downloadId, record);
    return record || null;
  } catch (_) {
    return null;
  }
}

async function forgetDownload(downloadId) {
  tracked.delete(downloadId);
  try {
    await chrome.storage.session.remove(trackKey(downloadId));
  } catch (_) {
    /* nada que limpiar */
  }
}

/** Mensajes de error de chrome.downloads en español. */
const DOWNLOAD_ERRORS = {
  NETWORK_FAILED: 'error de red al descargar el archivo.',
  NETWORK_TIMEOUT: 'se agotó el tiempo de espera de la red.',
  NETWORK_DISCONNECTED: 'no hay conexión a Internet.',
  SERVER_FAILED: 'el servidor del CDN devolvió un error (5xx).',
  SERVER_BAD_CONTENT: 'el servidor devolvió contenido no válido.',
  SERVER_UNAUTHORIZED: 'el servidor requiere autenticación (401).',
  SERVER_FORBIDDEN: 'el servidor denegó el acceso al archivo (403).',
  SERVER_CERT_PROBLEM: 'problema con el certificado del servidor.',
  SERVER_UNREACHABLE: 'no se pudo contactar con el servidor del CDN de X.',
  FILE_FAILED: 'no se pudo escribir el archivo en el disco.',
  FILE_ACCESS_DENIED: 'permiso denegado para escribir en la carpeta de destino.',
  FILE_NO_SPACE: 'no hay espacio suficiente en el disco.',
  FILE_NAME_TOO_LONG: 'el nombre del archivo es demasiado largo.',
  FILE_TOO_LARGE: 'el archivo supera el tamaño máximo permitido.',
  FILE_VIRUS_INFECTED: 'el archivo fue bloqueado por el antivirus.',
  FILE_TRANSIENT_ERROR: 'error temporal al escribir el archivo.',
  FILE_BLOCKED: 'la descarga fue bloqueada por la política del equipo.',
  FILE_SECURITY_CHECK_FAILED: 'falló la comprobación de seguridad del archivo.',
  FILE_SAME_AS_SOURCE: 'el archivo de destino es igual al de origen.',
  USER_CANCELED: 'la descarga fue cancelada por el usuario.',
  USER_SHUTDOWN: 'el navegador se cerró antes de completar la descarga.',
  CRASH: 'el navegador se bloqueó durante la descarga.'
};

function translateError(code) {
  if (!code) return 'error desconocido durante la descarga.';
  return DOWNLOAD_ERRORS[code] || 'error de descarga (' + code + ').';
}

/** Limpia el nombre/ruta para que chrome.downloads lo acepte sin salir de Descargas. */
function sanitizeDownloadPath(filename) {
  const cleaned = String(filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) =>
      part
        .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
        .replace(/^\.+$/, '')
        .replace(/^[.\s]+|[.\s]+$/g, '')
    )
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');

  if (!cleaned) return 'video_' + Date.now() + '.mp4';
  return cleaned.slice(0, 240);
}

function download(options) {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.download(options, (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        if (typeof downloadId !== 'number') {
          reject(new Error('Chrome no devolvió un identificador de descarga.'));
          return;
        }
        resolve(downloadId);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function notifyTab(tabId, payload) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    chrome.tabs.sendMessage(tabId, payload, () => {
      // El content script puede no estar inyectado: se ignora el error.
      void chrome.runtime.lastError;
    });
  } catch (_) {
    /* pestaña cerrada */
  }
}

/* =======================================================================
 * Mensajería interna: content script y popup
 * ===================================================================== */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'XVD_DOWNLOAD') {
    handleDownloadRequest(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) })
      );
    return true; // respuesta asíncrona
  }

  if (message.type === 'XVD_GET_SETTINGS') {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      if (chrome.runtime.lastError) {
        chrome.storage.local.get(DEFAULT_SETTINGS, (local) => sendResponse({ ok: true, settings: local }));
        return;
      }
      sendResponse({ ok: true, settings: stored });
    });
    return true;
  }

  if (message.type === 'XVD_OPEN_DOWNLOADS') {
    try {
      chrome.tabs.create({ url: 'chrome://downloads/' }).then(
        () => sendResponse({ ok: true }),
        () =>
          sendResponse({
            ok: false,
            error: 'No se pudo abrir la lista de descargas. Abre chrome://downloads/ manualmente.'
          })
      );
    } catch (_) {
      sendResponse({ ok: false, error: 'No se pudo abrir la lista de descargas.' });
    }
    return true;
  }

  return undefined;
});

async function handleDownloadRequest(message, sender) {
  const rawUrl = String(message.url || '');
  if (!/^https?:\/\//i.test(rawUrl)) {
    return { ok: false, error: 'La URL del video no es válida o no se pudo resolver.' };
  }

  const filename = sanitizeDownloadPath(message.filename);
  const saveAs = !!message.saveAs;

  try {
    const downloadId = await download({
      url: rawUrl,
      filename,
      saveAs,
      conflictAction: 'uniquify'
    });

    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1;
    await rememberDownload(downloadId, { tabId, filename, url: rawUrl, startedAt: Date.now() });

    return { ok: true, downloadId, filename };
  } catch (error) {
    const raw = error && error.message ? error.message : String(error);
    if (/Invalid URL|url/i.test(raw) && /invalid/i.test(raw)) {
      return { ok: false, error: 'La URL del video no es válida.' };
    }
    if (/permission|denied/i.test(raw)) {
      return { ok: false, error: 'Chrome bloqueó la descarga: revisa los permisos o la carpeta de destino.' };
    }
    return { ok: false, error: 'No se pudo iniciar la descarga: ' + raw };
  }
}

/* =======================================================================
 * Seguimiento del estado de las descargas
 * ===================================================================== */

chrome.downloads.onChanged.addListener((delta) => {
  handleDownloadDelta(delta).catch(() => {
    /* nunca dejar una promesa sin capturar dentro del service worker */
  });
});

async function handleDownloadDelta(delta) {
  if (!delta || !delta.state) return;

  const record = await recallDownload(delta.id);
  if (!record) return;

  if (delta.state.current === 'complete') {
    await forgetDownload(delta.id);
    notifyTab(record.tabId, {
      type: 'XVD_DOWNLOAD_EVENT',
      state: 'complete',
      downloadId: delta.id,
      filename: record.filename
    });
    return;
  }

  if (delta.state.current === 'interrupted') {
    await forgetDownload(delta.id);
    const code = delta.error && delta.error.current ? delta.error.current : '';
    notifyTab(record.tabId, {
      type: 'XVD_DOWNLOAD_EVENT',
      state: 'interrupted',
      downloadId: delta.id,
      filename: record.filename,
      errorCode: code,
      message: translateError(code)
    });
  }
}

chrome.downloads.onErased.addListener((downloadId) => {
  forgetDownload(downloadId).catch(() => {});
});

/* =======================================================================
 * Instalación / actualización
 * ===================================================================== */

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    if (chrome.runtime.lastError || !stored) {
      chrome.storage.local.get(DEFAULT_SETTINGS, (local) => {
        chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...(local || {}) });
      });
      return;
    }
    const missing = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof stored[key] === 'undefined') missing[key] = DEFAULT_SETTINGS[key];
    }
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });

  if (details && details.reason === 'install') {
    console.info('[XVD] Extensión instalada. Abre x.com y busca el botón «Descargar» sobre los videos.');
  }
});
