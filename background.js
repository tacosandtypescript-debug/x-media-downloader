/**
 * Descargador de medios para X — Service Worker (MV3)
 * ---------------------------------------------------------------------------
 * - Valida y ejecuta las descargas con chrome.downloads.download.
 * - Traduce los errores de la API de descargas al español.
 * - Vigila el estado de cada descarga y avisa al content script del resultado
 *   (para poder reintentar automáticamente con una calidad inferior).
 * - Guarda el REGISTRO DE DIAGNÓSTICO que envían los content scripts en
 *   chrome.storage.session, para que el popup pueda mostrarlo.
 * - Inicializa los ajustes por defecto en la primera instalación.
 */

'use strict';

/** Clave del registro de diagnóstico en chrome.storage.session. */
const LOG_KEY = 'xvd_log';
const LOG_MAX = 400;

/** Escrituras del registro en serie (evita perder entradas por concurrencia). */
let logQueue = Promise.resolve();

function normalizarEntrada(entry) {
  const nivel = entry && entry.level;
  return {
    t: Number(entry && entry.t) || Date.now(),
    level: nivel === 'error' ? 'error' : nivel === 'warn' ? 'warn' : 'info',
    area: String((entry && entry.area) || 'general').slice(0, 24),
    msg: String((entry && entry.msg) || '').slice(0, 400),
    detail: String((entry && entry.detail) || '').slice(0, 900)
  };
}

function appendLog(entry) {
  const limpia = normalizarEntrada(entry);
  logQueue = logQueue
    .then(async () => {
      const stored = await chrome.storage.session.get(LOG_KEY);
      const lista = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      lista.push(limpia);
      if (lista.length > LOG_MAX) lista.splice(0, lista.length - LOG_MAX);
      await chrome.storage.session.set({ [LOG_KEY]: lista });
    })
    .catch(() => {
      /* si la sesión no está disponible, el registro se pierde sin más */
    });
  return logQueue;
}

/** Anota en el registro y en la consola del service worker. */
function bgLog(level, area, msg, detail) {
  try {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn('[XVD:sw]', area + ':', msg, detail === undefined ? '' : detail);
  } catch (_) {
    /* consola no disponible */
  }
  let texto = '';
  if (detail !== undefined && detail !== null) {
    texto = typeof detail === 'string' ? detail : (() => {
      try {
        return JSON.stringify(detail);
      } catch (_) {
        return String(detail);
      }
    })();
  }
  return appendLog({ t: Date.now(), level, area, msg, detail: texto });
}

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
  imageFilenameTemplate: 'tweet_{id}_img{indice}',
  /* --- Otros sitios --- */
  instagramEnabled: true,
  instagramFilenameTemplate: 'instagram_{usuario}_{id}_{indice}',
  facebookEnabled: true,
  facebookFilenameTemplate: 'facebook_{usuario}_{id}_{indice}',
  folderHistory: []
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
 * Actualizaciones: ¿hay una versión nueva en disco?
 *
 * Una extensión no puede reescribir sus propios archivos (Chrome lo impide por
 * seguridad), pero SÍ puede leer su carpeta: basta con volver a leer
 * manifest.json para saber si el código del disco es más nuevo que el que está
 * en marcha. Cuando lo es, se pone una insignia en el icono y el popup ofrece
 * el botón «Actualizar extensión» (chrome.runtime.reload).
 * ===================================================================== */

async function versionEnDisco() {
  try {
    const respuesta = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const manifiesto = await respuesta.json();
    return String(manifiesto.version || '');
  } catch (_) {
    return '';
  }
}

async function comprobarActualizacion(motivo) {
  const enMarcha = chrome.runtime.getManifest().version;
  const disco = await versionEnDisco();
  const hay = !!disco && disco !== enMarcha;

  try {
    await chrome.storage.session.set({
      xvd_update: { enMarcha, disco, hay, motivo: motivo || '', comprobado: Date.now() }
    });
  } catch (_) {
    /* sin sesión disponible */
  }

  try {
    await chrome.action.setBadgeText({ text: hay ? 'NEW' : '' });
    if (hay) await chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
    await chrome.action.setTitle({
      title: hay
        ? 'Descargador de medios para X — actualización disponible (v' + disco + ')'
        : 'Descargador de medios para X'
    });
  } catch (_) {
    /* la barra de herramientas no está disponible */
  }

  if (hay) {
    bgLog('warn', 'actualizacion', 'Hay una versión nueva en disco', { enMarcha, disco, motivo: motivo || '' });
  }
  return { enMarcha, disco, hay };
}

/* =======================================================================
 * Audio generado (M4A/MP3)
 *
 * El audio no se puede descargar con una URL: hay que fabricarlo uniendo los
 * segmentos del HLS y, si se pide MP3, recodificarlo. Eso ocurre en el content
 * script (tiene Web Audio), pero un content script no puede lanzar una descarga
 * con subcarpeta, así que los bytes se pasan aquí y se guardan desde el
 * documento offscreen, con el mismo seguimiento que las demás descargas.
 * ===================================================================== */

let offscreenListo = false;

async function asegurarOffscreen() {
  if (offscreenListo) return true;
  try {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      if (await chrome.offscreen.hasDocument()) {
        offscreenListo = true;
        return true;
      }
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Crear el Blob del audio generado (M4A/MP3) y entregarlo a chrome.downloads.'
    });
    offscreenListo = true;
    return true;
  } catch (error) {
    const mensaje = String(error && error.message ? error.message : error);
    if (/single offscreen|already exists|Only a single/i.test(mensaje)) {
      offscreenListo = true;
      return true;
    }
    bgLog('error', 'audio', 'No se pudo preparar el documento offscreen', { motivo: mensaje });
    return false;
  }
}

/** Inyecta el codificador MP3 (lamejs) en la pestaña que lo pida. */
async function inyectarLamejs(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/lamejs.iife.js'] });
    return true;
  } catch (error) {
    bgLog('error', 'audio', 'No se pudo inyectar el codificador MP3', {
      motivo: String(error && error.message ? error.message : error)
    });
    return false;
  }
}

async function handleGeneratedDownload(message, sender) {
  const filename = sanitizeDownloadPath(message.filename);
  if (!message.base64) {
    return { ok: false, error: 'No hay datos de audio que guardar.' };
  }

  if (!(await asegurarOffscreen())) {
    return { ok: false, error: 'No se pudo preparar la descarga del audio generado.' };
  }

  const respuesta = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'XVD_CREAR_BLOB',
          target: 'offscreen',
          transferId: message.transferId,
          trozos: message.trozos,
          base64: message.base64,
          ultimo: !!message.ultimo,
          mime: message.mime || 'audio/mp4'
        },
        (r) => {
          void chrome.runtime.lastError;
          resolve(r || { ok: false, error: 'El documento offscreen no respondió.' });
        }
      );
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message ? error.message : error) });
    }
  });

  if (!respuesta || !respuesta.ok) {
    bgLog('error', 'audio', 'Fallo al preparar el archivo de audio', { motivo: respuesta && respuesta.error });
    return respuesta || { ok: false, error: 'Fallo al preparar el archivo de audio.' };
  }

  // Los trozos intermedios aún no forman el archivo.
  if (respuesta.parcial) return { ok: true, parcial: true };

  // El documento offscreen devuelve una URL de Blob; la descarga la lanza aquí,
  // que es donde están chrome.downloads y el seguimiento de descargas.
  let downloadId;
  try {
    downloadId = await download({
      url: respuesta.url,
      filename,
      saveAs: !!message.saveAs,
      conflictAction: 'uniquify'
    });
  } catch (error) {
    bgLog('error', 'audio', 'chrome.downloads rechazó el audio generado', {
      archivo: filename,
      motivo: String(error && error.message ? error.message : error)
    });
    return { ok: false, error: 'No se pudo guardar el audio: ' + (error && error.message ? error.message : '') };
  }

  const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1;
  await rememberDownload(downloadId, {
    tabId,
    filename,
    url: '(audio generado en la extensión)',
    transferId: respuesta.transferId,
    startedAt: Date.now()
  });
  bgLog('info', 'audio', 'Audio generado entregado a chrome.downloads', {
    id: downloadId,
    archivo: filename,
    kb: Math.round((respuesta.bytes || 0) / 1024)
  });

  return { ok: true, downloadId, filename };
}

/** Avisa al documento offscreen de que ya puede liberar la URL del Blob. */
function liberarBlob(transferId) {
  if (!transferId) return;
  try {
    chrome.runtime.sendMessage({ type: 'XVD_REVOCAR', target: 'offscreen', transferId }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    /* el documento ya no está */
  }
}

/* =======================================================================
 * Mensajería interna: content script y popup
 * ===================================================================== */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  // Los mensajes dirigidos al documento offscreen no se procesan aquí.
  if (message.target === 'offscreen') return undefined;

  if (message.type === 'XVD_INJECT_LAMEJS') {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1;
    inyectarLamejs(tabId).then((ok) =>
      sendResponse({
        ok,
        error: ok ? '' : 'No se pudo preparar el codificador MP3. Prueba con el formato M4A.'
      })
    );
    return true;
  }

  if (message.type === 'XVD_DOWNLOAD_BYTES') {
    handleGeneratedDownload(message, sender)
      .then((resultado) => sendResponse(resultado))
      .catch((error) =>
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) })
      );
    return true;
  }

  if (message.type === 'XVD_LOG') {
    appendLog(message.entry || {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'XVD_GET_LOG') {
    chrome.storage.session
      .get(LOG_KEY)
      .then((stored) =>
        sendResponse({
          ok: true,
          log: stored[LOG_KEY] || [],
          version: chrome.runtime.getManifest().version
        })
      )
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'XVD_CLEAR_LOG') {
    chrome.storage.session
      .remove(LOG_KEY)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'XVD_COMPROBAR_ACTUALIZACION') {
    comprobarActualizacion('popup')
      .then((resultado) => sendResponse({ ok: true, ...resultado }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'XVD_APLICAR_ACTUALIZACION') {
    // No se recarga la extensión desde aquí: chrome.runtime.reload() deja la
    // extensión sin volver (comprobado). La vía fiable es el botón ↻ de
    // chrome://extensions; esto solo deja constancia en el registro.
    bgLog('warn', 'actualizacion', 'Actualización solicitada desde el popup', {
      enMarcha: chrome.runtime.getManifest().version
    });
    sendResponse({ ok: true, recargaDesdeAqui: false });
    return true;
  }

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
    bgLog('error', 'descarga', 'URL rechazada por el service worker', { url: rawUrl });
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
    bgLog('info', 'descarga', 'chrome.downloads.download despachado', {
      id: downloadId,
      archivo: filename,
      host: (() => {
        try {
          return new URL(rawUrl).host;
        } catch (_) {
          return '';
        }
      })(),
      guardarComo: saveAs
    });

    return { ok: true, downloadId, filename };
  } catch (error) {
    const raw = error && error.message ? error.message : String(error);
    bgLog('error', 'descarga', 'chrome.downloads.download falló', { archivo: filename, motivo: raw });
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
    if (record.transferId) liberarBlob(record.transferId);
    await forgetDownload(delta.id);

    // Datos definitivos de la descarga: tamaño real y ruta en disco.
    let bytes = 0;
    let ruta = record.filename;
    try {
      const encontradas = await chrome.downloads.search({ id: delta.id });
      const info = encontradas && encontradas[0];
      if (info) {
        bytes = info.fileSize || info.bytesReceived || 0;
        ruta = info.filename || ruta;
      }
    } catch (_) {
      /* sin datos de tamaño: no es crítico */
    }
    const segundos = record.startedAt ? Math.round((Date.now() - record.startedAt) / 100) / 10 : 0;

    bgLog('info', 'descarga', 'Descarga completada (service worker)', {
      id: delta.id,
      archivo: record.filename,
      tamañoMB: bytes ? Math.round((bytes / 1048576) * 10) / 10 : 0,
      segundos,
      ruta
    });
    notifyTab(record.tabId, {
      type: 'XVD_DOWNLOAD_EVENT',
      state: 'complete',
      downloadId: delta.id,
      filename: record.filename,
      bytes,
      seconds: segundos
    });
    comprobarActualizacion('descarga completada').catch(() => {});
    return;
  }

  if (delta.state.current === 'interrupted') {
    await forgetDownload(delta.id);
    const code = delta.error && delta.error.current ? delta.error.current : '';
    const segundos = record.startedAt ? Math.round((Date.now() - record.startedAt) / 100) / 10 : 0;
    bgLog('error', 'descarga', 'Descarga interrumpida (service worker)', {
      id: delta.id,
      archivo: record.filename,
      codigo: code,
      detalle: translateError(code),
      segundos,
      host: (() => {
        try {
          return new URL(record.url).host;
        } catch (_) {
          return '';
        }
      })()
    });
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
  // Al cargar/cargar de nuevo la extensión se comprueba si el disco trae una
  // versión distinta de la que acaba de arrancar (y se limpia la insignia).
  comprobarActualizacion(details && details.reason ? details.reason : 'instalacion').catch(() => {});

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
