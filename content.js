/**
 * Descargador de medios para X — Núcleo + módulo de video
 * ---------------------------------------------------------------------------
 * Este archivo hace dos cosas:
 *
 *   A) NÚCLEO COMPARTIDO (expuesto en window.__XVD_CORE__ para images.js):
 *      ajustes, avisos, mensajería con el service worker, fábrica de botones
 *      superpuestos, MutationObserver/ResizeObserver y registro de módulos.
 *
 *   B) MÓDULO DE VIDEO:
 *      1. Detectar reproductores <video> en timeline, perfiles, tweets
 *         individuales, respuestas, citas y en el visor ampliado.
 *      2. Inyectar el botón flotante "Descargar" sobre cada reproductor.
 *      3. Extraer las variantes multimedia (bitrate / resolución / content_type)
 *         desde el estado de la página: props de React (fibra),
 *         window.__INITIAL_STATE__, el atributo poster del <video> y las
 *         peticiones de red (m3u8 / mp4).
 *      4. Elegir la mejor variante según el formato y la calidad configurados.
 *      5. Pedir al service worker (background.js) la descarga real.
 *
 * La resolución de la URL se hace SIEMPRE en el momento del clic, de modo que
 * nunca se descarga un video equivocado aunque X recicle nodos del DOM.
 */
(() => {
  'use strict';

  if (window.__XVD_LOADED__) return;
  window.__XVD_LOADED__ = true;

  /* =======================================================================
   * 1. Constantes y configuración por defecto
   * ===================================================================== */

  const BUTTON_CLASS = 'xvd-button';
  const BADGE_CLASS = 'xvd-badge';
  const HOST_ATTR = 'data-xvd-host';
  const VIDEO_ATTR = 'data-xvd-video';
  const IMAGE_ATTR = 'data-xvd-image';
  const TOASTS_ID = 'xvd-toasts';

  /** Versión del núcleo (se muestra en el diagnóstico del popup). */
  const coreVersion = '2.4.0';

  const DEFAULT_SETTINGS = {
    /* --- General --- */
    enabled: true,                 // interruptor general on/off
    folder: 'X Videos',            // subcarpeta dentro de Descargas ('' = raíz)
    askWhereToSave: false,         // mostrar diálogo "Guardar como"
    showToasts: true,              // avisos flotantes en la página
    showOnHover: false,            // mostrar los botones solo al pasar el ratón
    /* --- Videos --- */
    format: 'auto',                // auto | mp4 | webm | m4a
    quality: 'max',                // max | custom
    minHeight: 1080,               // altura mínima cuando quality === 'custom'
    filenameTemplate: '{usuario}_{id}_{calidad}', // plantilla del nombre de archivo
    autoFallback: true,            // reintentar con calidad inferior si falla
    audioFallback: 'mp4',          // mp4 | error  (qué hacer si no hay pista de audio)
    hlsFallback: false,            // reconstruir streams HLS (avanzado)
    /* --- Imágenes --- */
    imagesEnabled: true,           // botones sobre imágenes
    imageResolution: 'orig',       // orig | 4096x4096 | large | medium
    imageFormat: 'auto',           // auto | jpg | png | webp
    galleryButton: true,           // botón "Descargar todas" en galerías
    compactImageButton: false,     // botón de imagen solo con icono
    imageFallback: true,           // degradar la resolución si orig falla
    imageVerify: true,             // comprobar disponibilidad antes de descargar
    imageFilenameTemplate: 'tweet_{id}_img{indice}', // plantilla del nombre de imagen
    /* --- Otros sitios --- */
    instagramEnabled: true,        // botones también en Instagram
    instagramFilenameTemplate: 'instagram_{usuario}_{id}_{indice}'
  };

  const QUALITY_ORDER = [2160, 1440, 1080, 720, 480, 360];

  const ICON_SVG =
    '<svg class="xvd-button__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1Z"/>' +
    '<path d="M4 15a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2a1 1 0 0 1 1-1Z"/>' +
    '</svg>';

  const SPINNER_SVG =
    '<svg class="xvd-button__icon xvd-spin" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M12 3a9 9 0 1 0 9 9 1 1 0 1 0-2 0 7 7 0 1 1-7-7 1 1 0 0 0 0-2Z"/>' +
    '</svg>';

  const CHECK_SVG =
    '<svg class="xvd-button__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M9.55 17.6 4.4 12.45a1 1 0 0 1 1.42-1.4l3.73 3.72 8.63-8.63a1 1 0 1 1 1.42 1.42l-9.34 9.34a1 1 0 0 1-1.42 0Z"/>' +
    '</svg>';

  const WARN_SVG =
    '<svg class="xvd-button__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M12 3a1 1 0 0 1 .87.5l8 14A1 1 0 0 1 20 19H4a1 1 0 0 1-.87-1.5l8-14A1 1 0 0 1 12 3Zm0 4.6L6.6 17h10.8L12 7.6ZM11 10.5h2v4h-2v-4Zm0 5h2v2h-2v-2Z"/>' +
    '</svg>';

  const IMAGES_SVG =
    '<svg class="xvd-button__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h5A2.5 2.5 0 0 1 14 5.5v5A2.5 2.5 0 0 1 11.5 13h-5A2.5 2.5 0 0 1 4 10.5v-5Zm2.5-.5a.5.5 0 0 0-.5.5v5c0 .28.22.5.5.5h5a.5.5 0 0 0 .5-.5v-5a.5.5 0 0 0-.5-.5h-5Z"/>' +
    '<path d="M17.5 8A2.5 2.5 0 0 1 20 10.5v5a4.5 4.5 0 0 1-4.5 4.5h-5A2.5 2.5 0 0 1 8 17.5h1.5a1 1 0 0 0 1 1h5A2.5 2.5 0 0 0 18 16v-5a1 1 0 0 0-1-1H15.5V8h2Z"/>' +
    '<path d="M17 11.2a1 1 0 0 1 1 1v.6c0 2.32-1.88 4.2-4.2 4.2h-.6a1 1 0 1 1 0-2h.6c1.22 0 2.2-.98 2.2-2.2v-.6a1 1 0 0 1 1-1Z"/>' +
    '</svg>';

  /** @type {typeof DEFAULT_SETTINGS} */
  let settings = { ...DEFAULT_SETTINGS };

  /** Caché de listas de reproducción m3u8: url -> { ts, variants } */
  const playlistCache = new Map();
  const PLAYLIST_TTL = 5 * 60 * 1000;

  /** Descargas en curso: downloadId -> registro para reintentos */
  const pendingDownloads = new Map();

  /** Videos ya observados con ResizeObserver */
  const observedVideos = new WeakSet();

  /** Módulos registrados (video, imágenes…): cada uno aporta su propio escaneo. */
  const scanners = [];

  /** Limpiezas a ejecutar cuando se desactiva la extensión. */
  const disableHooks = [];

  /* =======================================================================
   * 2. Utilidades genéricas
   * ===================================================================== */

  function debounce(fn, wait) {
    let t = 0;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'Sin respuesta del servicio de descargas.' });
        });
      } catch (err) {
        resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Texto seguro para el usuario a partir de cualquier error. */
  function errorMessage(err) {
    const raw = err && err.message ? err.message : String(err || '');
    if (/Failed to fetch|NetworkError/i.test(raw)) {
      return 'No se pudo conectar con el servidor de X para leer el video.';
    }
    return raw || 'No se pudo obtener el video en la calidad solicitada.';
  }

  /* =======================================================================
   * 2a. Registro de diagnóstico
   *
   * Cada paso relevante se anota aquí, se imprime en la consola de la página
   * con el prefijo [XVD] y se envía al service worker, que lo conserva en
   * chrome.storage.session. El popup lo muestra en la pestaña «General», de
   * modo que se puede saber POR QUÉ no se descarga algo sin abrir DevTools.
   * ===================================================================== */

  /** Convierte cualquier detalle en una cadena corta y segura. */
  function safeDetail(detail) {
    if (detail === undefined || detail === null) return '';
    if (typeof detail === 'string') return detail.slice(0, 600);
    if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail);
    try {
      const json = JSON.stringify(detail);
      if (!json) return '';
      return json.length > 900 ? json.slice(0, 900) + '…' : json;
    } catch (_) {
      return String(detail).slice(0, 300);
    }
  }

  /**
   * Anota una entrada de diagnóstico.
   * @param {'info'|'warn'|'error'} level
   * @param {string} area  video | imagen | resolucion | descarga | ajustes | inicio
   * @param {string} message
   * @param {*} [detail]
   */
  function log(level, area, message, detail) {
    const entry = {
      t: Date.now(),
      level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
      area: String(area || 'general').slice(0, 24),
      msg: String(message || '').slice(0, 400),
      detail: safeDetail(detail)
    };
    try {
      if (entry.level === 'error') console.error('[XVD]', entry.area + ':', entry.msg, entry.detail || '');
      else if (entry.level === 'warn') console.warn('[XVD]', entry.area + ':', entry.msg, entry.detail || '');
      else console.log('[XVD]', entry.area + ':', entry.msg, entry.detail || '');
    } catch (_) {
      /* consola no disponible */
    }
    try {
      chrome.runtime.sendMessage({ type: 'XVD_LOG', entry }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* el service worker no está disponible ahora mismo */
    }
    return entry;
  }

  /* =======================================================================
   * 2b. Puente con el MUNDO DE LA PÁGINA (page-bridge.js)
   *
   * Un content script vive en un "mundo aislado": comparte el DOM, pero NO los
   * globales de JavaScript ni las propiedades añadidas a los nodos. Por eso no
   * puede leer ni `window.__INITIAL_STATE__` ni `nodo.__reactFiber$…`, que es
   * justo donde X guarda el manifiesto del video. page-bridge.js se inyecta en
   * el mundo MAIN y responde por window.postMessage.
   * ===================================================================== */

  const BRIDGE_MARK = '__xvdBridge';
  const BRIDGE_TIMEOUT = 3500;

  /** requestId -> función que resuelve la petición en curso */
  const bridgeRequests = new Map();

  /** Diagnóstico: ¿ha respondido el puente alguna vez en esta pestaña? */
  let bridgeResponded = false;
  let bridgeTimeouts = 0;

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data[BRIDGE_MARK] !== true) return;
      if (data.kind !== 'response') return;

      bridgeResponded = true;
      const resolver = bridgeRequests.get(data.requestId);
      if (!resolver) return;
      bridgeRequests.delete(data.requestId);
      resolver(data);
    },
    false
  );

  /**
   * Envía una petición al puente del mundo de la página y devuelve su respuesta
   * completa (o null si no llega a tiempo). Sirve para X y para Instagram.
   */
  function pedirAlPuente(peticion, timeoutMs) {
    return new Promise((resolve) => {
      const requestId = 'xvd-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      const limite = timeoutMs || BRIDGE_TIMEOUT;
      let settled = false;

      const finish = (valor) => {
        if (settled) return;
        settled = true;
        bridgeRequests.delete(requestId);
        resolve(valor);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        bridgeTimeouts++;
        log('warn', 'resolucion', 'El puente del mundo de la página no respondió a tiempo', {
          sitio: peticion.sitio || 'x',
          ms: limite,
          veces: bridgeTimeouts
        });
        finish(null);
      }, limite);

      bridgeRequests.set(requestId, (respuesta) => {
        clearTimeout(timer);
        finish(respuesta);
      });

      try {
        window.postMessage({ [BRIDGE_MARK]: true, kind: 'request', requestId, ...peticion }, '*');
      } catch (_) {
        clearTimeout(timer);
        finish(null);
      }
    });
  }

  /** Pide al puente las entidades multimedia del reproductor de X. */
  async function requestMediaFromBridge(mediaId, poster, timeoutMs) {
    const respuesta = await pedirAlPuente({ mediaId, poster }, timeoutMs);
    return respuesta && Array.isArray(respuesta.media) ? respuesta.media : [];
  }

  /** Pide al puente los medios de una publicación de Instagram (por su código). */
  async function requestInstagramMedia(code, timeoutMs) {
    const respuesta = await pedirAlPuente({ sitio: 'instagram', code }, timeoutMs);
    return respuesta && Array.isArray(respuesta.medios) ? respuesta.medios : [];
  }

  /** Descarga una URL y devuelve sus bytes (con las cookies de la página). */
  async function fetchBytes(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('El servidor respondió HTTP ' + res.status + '.');
    return new Uint8Array(await res.arrayBuffer());
  }

  /* =======================================================================
   * 3. Ajustes (chrome.storage.sync con respaldo local)
   * ===================================================================== */

  function loadSettings() {
    return new Promise((resolve) => {
      const merge = (stored) => {
        settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
        resolve(settings);
      };
      try {
        chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
          if (chrome.runtime.lastError) {
            chrome.storage.local.get(DEFAULT_SETTINGS, (local) => merge(local));
            return;
          }
          merge(stored);
        });
      } catch (_) {
        resolve(settings);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (key in DEFAULT_SETTINGS) {
        settings[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched) applySettings();
  });

  function applySettings() {
    log('info', 'ajustes', 'Ajustes actualizados', {
      activo: !!settings.enabled,
      imagenes: !!settings.imagesEnabled,
      video: settings.format + '/' + settings.quality,
      imagen: settings.imageResolution + '/' + settings.imageFormat
    });

    for (const hook of disableHooks) {
      try {
        hook(settings);
      } catch (_) {
        /* un módulo no debe romper a los demás */
      }
    }

    if (!settings.enabled) {
      cleanupOverlays();
      return;
    }
    document.documentElement.classList.toggle('xvd-hover-only', !!settings.showOnHover);
    scheduleScan();
  }

  /** Retira todas las superposiciones inyectadas (botones, contadores y marcas). */
  function cleanupOverlays() {
    document
      .querySelectorAll('.' + BUTTON_CLASS + ', .' + BADGE_CLASS)
      .forEach((node) => node.remove());
    document
      .querySelectorAll('[' + VIDEO_ATTR + '], [' + IMAGE_ATTR + ']')
      .forEach((node) => {
        node.removeAttribute(VIDEO_ATTR);
        node.removeAttribute(IMAGE_ATTR);
      });
  }

  /**
   * Registra un módulo de escaneo (video, imágenes…). El núcleo los ejecuta en
   * cada barrido del MutationObserver, con antirrebote y ya cargados los ajustes.
   */
  function registerScanner(fn) {
    if (typeof fn === 'function' && !scanners.includes(fn)) scanners.push(fn);
  }

  /** Registra una limpieza que se ejecuta al cambiar los ajustes o desactivar. */
  function registerDisableHook(fn) {
    if (typeof fn === 'function' && !disableHooks.includes(fn)) disableHooks.push(fn);
  }

  /* =======================================================================
   * 4. Avisos flotantes (toasts en español)
   * ===================================================================== */

  function toast(message, kind = 'info', timeout = 4500) {
    if (!settings.showToasts && kind !== 'error') return;
    let container = document.getElementById(TOASTS_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = TOASTS_ID;
      container.className = 'xvd-toasts';
      (document.body || document.documentElement).appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'xvd-toast xvd-toast--' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'xvd-toast__icon';
    icon.textContent = kind === 'error' ? '⚠' : kind === 'success' ? '✔' : kind === 'warn' ? '!' : 'i';

    const text = document.createElement('span');
    text.className = 'xvd-toast__msg';
    text.textContent = message; // textContent = sin riesgo de inyección

    el.append(icon, text);
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('xvd-toast--out');
      setTimeout(() => el.remove(), 320);
    }, timeout);
    return el;
  }

  /* =======================================================================
   * 5. Extracción de variantes multimedia
   * ===================================================================== */

  /** Normaliza una variante del manifiesto de X. */
  function normalizeVariant(raw) {
    if (!raw || typeof raw.url !== 'string' || !raw.url) return null;
    const url = raw.url;
    const ct = String(raw.content_type || '').toLowerCase();
    let kind = 'video';
    let ext = 'mp4';

    if (ct.includes('mpegurl') || /\.m3u8(\?|#|$)/i.test(url)) {
      kind = 'hls';
      ext = 'mp4';
    } else if (ct.startsWith('audio/') || /\.(m4a|mp3|aac)(\?|#|$)/i.test(url)) {
      kind = 'audio';
      ext = /\.mp3(\?|#|$)/i.test(url) || ct.includes('mpeg') && !ct.includes('mp4') ? 'mp3' : 'm4a';
    } else if (ct.includes('webm') || /\.webm(\?|#|$)/i.test(url)) {
      kind = 'video';
      ext = 'webm';
    }

    // El manifiesto de X no incluye la resolución de las variantes MP4: va en la
    // propia URL, p. ej. https://video.twimg.com/amplify_video/<id>/vid/1280x720/x.mp4
    let width = Number(raw.width) || 0;
    let height = Number(raw.height) || 0;
    if (!height || !width) {
      const match = url.match(/\/(\d{2,4})x(\d{2,4})(?:[/?#.]|$)/);
      if (match) {
        width = width || Number(match[1]);
        height = height || Number(match[2]);
      }
    }

    return {
      url,
      contentType: ct || (kind === 'video' ? 'video/mp4' : ''),
      bitrate: Number(raw.bitrate) || 0,
      width,
      height,
      kind,
      ext,
      origin: raw.origin || 'estado'
    };
  }

  /** Convierte un objeto multimedia de X (media entity) en un resultado normalizado. */
  function normalizeMediaEntity(entity) {
    if (!entity || typeof entity !== 'object') return null;
    const info = entity.video_info || entity.videoInfo || {};
    const list = Array.isArray(info.variants)
      ? info.variants
      : Array.isArray(entity.variants)
        ? entity.variants
        : [];
    const variants = list.map(normalizeVariant).filter(Boolean);
    if (!variants.length) return null;

    const id =
      String(entity.id_str || entity.id || info.media_id_string || info.media_id || '') ||
      extractMediaId(variants[0].url) ||
      '';

    return {
      id,
      poster: String(entity.media_url_https || entity.media_url || entity.poster || ''),
      duration: Number(info.duration_millis || entity.duration_millis || 0),
      variants
    };
  }

  /** Extrae el identificador numérico del video a partir de una URL de twimg. */
  function extractMediaId(url) {
    if (!url) return '';
    const m = String(url).match(
      /(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb|amplify_video|ext_tw_video|tweet_video)\/(\d+)/
    );
    return m ? m[1] : '';
  }

  /** Id del video según el póster del reproductor (fuente de identidad más fiable). */
  function mediaIdFromVideo(video) {
    return (
      extractMediaId(video.getAttribute('poster')) ||
      extractMediaId(video.poster) ||
      video.getAttribute(VIDEO_ATTR) ||
      ''
    );
  }

  /* ---------------------- 5.1 Búsqueda en props de React ---------------------- */

  function getFiber(node) {
    if (!node || typeof node !== 'object') return null;
    const key = Object.keys(node).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    return key ? node[key] : null;
  }

  function getReactProps(node) {
    if (!node || typeof node !== 'object') return null;
    const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
    return key ? node[key] : null;
  }

  /**
   * Recorrido en anchura, acotado, buscando objetos con estructura de media de X.
   * Devuelve entidades normalizadas y sin duplicados.
   */
  function deepCollectMedia(root, out, limits) {
    const maxDepth = (limits && limits.maxDepth) || 7;
    const maxSteps = (limits && limits.maxSteps) || 4000;
    const queue = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    let steps = 0;

    while (queue.length && steps < maxSteps) {
      const { value, depth } = queue.shift();
      steps++;
      if (!value || typeof value !== 'object' || depth > maxDepth) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') queue.push({ value: item, depth: depth + 1 });
        }
        continue;
      }

      const looksLikeMedia =
        (value.video_info && Array.isArray(value.video_info.variants)) ||
        (value.videoInfo && Array.isArray(value.videoInfo.variants)) ||
        (Array.isArray(value.variants) &&
          value.variants.length &&
          value.variants[0] &&
          typeof value.variants[0].url === 'string');

      if (looksLikeMedia) {
        const media = normalizeMediaEntity(value);
        if (media) out.push(media);
        continue;
      }

      const keys = Object.keys(value);
      for (const key of keys) {
        if (key === 'return' || key === 'child' || key === 'sibling' || key === '_owner') continue;
        const child = value[key];
        if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      }
    }
    return out;
  }

  function dedupeMedia(list) {
    const map = new Map();
    for (const media of list) {
      if (!media || !media.variants.length) continue;
      const key = media.id || media.variants.map((v) => v.url).join('|');
      const prev = map.get(key);
      if (!prev || prev.variants.length < media.variants.length) map.set(key, media);
    }
    return Array.from(map.values());
  }

  /** Estrategia A/B: fibra de React desde el <video>, su contenedor y el <article>. */
  function mediaFromReact(video) {
    const found = [];
    const seeds = [video, video.parentElement, video.closest('article'), video.closest('[data-testid="cellInnerDiv"]')];

    for (const seed of seeds) {
      if (!seed) continue;
      const props = getReactProps(seed);
      if (props) deepCollectMedia(props, found, { maxDepth: 8, maxSteps: 6000 });

      let fiber = getFiber(seed);
      let hops = 0;
      while (fiber && hops < 35) {
        if (fiber.memoizedProps) deepCollectMedia(fiber.memoizedProps, found, { maxDepth: 6, maxSteps: 2500 });
        fiber = fiber.return;
        hops++;
      }
      if (found.length) break;
    }
    return dedupeMedia(found);
  }

  /** Estrategia C: recorrido global del árbol de React mediante el hook de DevTools. */
  function mediaFromReactRoots(mediaId) {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.getFiberRoots || !hook.renderers) return [];

    const roots = [];
    try {
      hook.renderers.forEach((_renderer, id) => {
        const set = hook.getFiberRoots(id);
        if (set) set.forEach((root) => roots.push(root));
      });
    } catch (_) {
      return [];
    }
    if (!roots.length) return [];

    const found = [];
    const seen = new WeakSet();
    const stack = roots.slice();
    let steps = 0;

    while (stack.length && steps < 25000) {
      const node = stack.pop();
      steps++;
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      const props = node.memoizedProps;
      if (props && typeof props === 'object') {
        const quick = props.mediaDetails || props.media_entity || props.entities || props.video_info;
        if (quick) deepCollectMedia(quick, found, { maxDepth: 5, maxSteps: 800 });
      }
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);

      if (found.length && mediaId) {
        const hit = dedupeMedia(found).some((m) => m.id === mediaId);
        if (hit) break;
      }
    }
    return dedupeMedia(found);
  }

  /** Estrategia D: window.__INITIAL_STATE__ y otros estados globales conocidos. */
  function mediaFromPageState() {
    const globals = [
      window.__INITIAL_STATE__,
      window.__NEXT_DATA__,
      window.__APOLLO_STATE__,
      window.__PRELOADED_STATE__,
      window.__TWITTER_STATE__
    ].filter(Boolean);

    const found = [];
    for (const state of globals) {
      try {
        deepCollectMedia(state, found, { maxDepth: 9, maxSteps: 8000 });
      } catch (_) {
        /* estado no serializable: se ignora */
      }
    }
    return dedupeMedia(found);
  }

  /* ---------------------- 5.2 Red: póster + m3u8 ---------------------- */

  function networkEntries() {
    try {
      return performance.getEntriesByType('resource');
    } catch (_) {
      return [];
    }
  }

  /** URLs m3u8 vistas por la página, filtradas por el id del video cuando se conoce. */
  function m3u8UrlsForMedia(mediaId) {
    const urls = new Set();
    for (const entry of networkEntries()) {
      const name = entry && entry.name;
      if (!name || !/\.m3u8(\?|#|$)/i.test(name)) continue;
      if (mediaId && name.indexOf(mediaId) === -1) continue;
      urls.add(name);
    }
    // Solo el manifiesto maestro: descartar sublistas (contienen "/pl/" o "/vid/" + .m3u8)
    return Array.from(urls);
  }

  function parseAttributes(text) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(text))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  function absoluteUrl(uri, base) {
    try {
      return new URL(uri, base).toString();
    } catch (_) {
      return uri;
    }
  }

  function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const streams = [];
    const audios = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
        if ((attrs.TYPE || '').toUpperCase() === 'AUDIO' && attrs.URI) {
          audios.push({
            url: absoluteUrl(attrs.URI, baseUrl),
            language: attrs.LANGUAGE || '',
            name: attrs.NAME || ''
          });
        }
        continue;
      }

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            uri = lines[j];
            i = j;
            break;
          }
        }
        if (!uri) continue;
        const res = String(attrs.RESOLUTION || '').split('x');
        streams.push({
          url: absoluteUrl(uri, baseUrl),
          bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
          width: Number(res[0]) || 0,
          height: Number(res[1]) || 0,
          codecs: attrs.CODECS || ''
        });
      }
    }

    const variants = streams.map((s) => {
      const codecs = s.codecs.toLowerCase();
      const ext = /vp0?9|opus|av01/.test(codecs) ? 'webm' : 'mp4';
      return {
        url: s.url,
        contentType: 'application/x-mpegURL',
        bitrate: s.bandwidth,
        width: s.width,
        height: s.height,
        kind: 'hls',
        ext,
        origin: 'hls'
      };
    });

    // Las renditions de audio de un manifiesto HLS siguen siendo listas .m3u8,
    // no archivos de audio: se marcan como HLS para no descargarlas por error.
    const audioVariants = audios.map((a) => ({
      url: a.url,
      contentType: 'application/x-mpegURL',
      bitrate: bitrateDeAudio(a.url),
      width: 0,
      height: 0,
      kind: 'hls',
      audioOnly: true,
      ext: 'm4a',
      origin: 'hls'
    }));

    return { variants: variants.concat(audioVariants), streams };
  }

  async function fetchText(url, timeoutMs = 9000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        credentials: 'omit',
        cache: 'force-cache',
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Descarga y analiza el manifiesto HLS (con caché) para conocer las calidades reales. */
  async function mediaFromPlaylists(mediaId) {
    // Sin id de video, los manifiestos de la página no son atribuibles a este
    // reproductor… salvo que solo haya un video en pantalla.
    if (!mediaId && document.querySelectorAll('video').length !== 1) return [];

    const urls = m3u8UrlsForMedia(mediaId);
    if (!urls.length) return [];

    const variants = [];
    let bestStreams = [];

    for (const url of urls.slice(0, 4)) {
      const cached = playlistCache.get(url);
      let parsed;
      if (cached && Date.now() - cached.ts < PLAYLIST_TTL) {
        parsed = cached.value;
      } else {
        try {
          const text = await fetchText(url);
          parsed = parseMasterPlaylist(text, url);
          playlistCache.set(url, { ts: Date.now(), value: parsed });
        } catch (_) {
          continue;
        }
      }
      variants.push(...parsed.variants);
      if (parsed.streams.length > bestStreams.length) bestStreams = parsed.streams;
    }

    if (!variants.length) return [];
    return [
      {
        id: mediaId || '',
        poster: '',
        duration: 0,
        variants: variants.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate),
        streams: bestStreams
      }
    ];
  }

  /** Fallback final: src directo http(s) del <video> o de sus <source>. */
  function mediaFromDomSources(video) {
    const urls = [];
    const push = (u) => {
      if (u && /^https?:/i.test(u)) urls.push(u);
    };
    push(video.currentSrc);
    push(video.src);
    video.querySelectorAll('source').forEach((s) => push(s.src));

    const variants = urls
      .filter((u) => !/\.m3u8(\?|#|$)/i.test(u))
      .map((u) => normalizeVariant({ url: u, content_type: /\.webm/i.test(u) ? 'video/webm' : 'video/mp4' }))
      .filter(Boolean);

    if (!variants.length) return [];
    return [
      {
        id: mediaIdFromVideo(video),
        poster: video.getAttribute('poster') || '',
        duration: Number(video.duration) || 0,
        variants
      }
    ];
  }

  /**
   * Reúne todas las variantes posibles para un <video> concreto y se queda con
   * la entidad que corresponde a ese reproductor (cruce por id del póster).
   *
   * Las estrategias se agrupan en "niveles" ordenados de más a menos fiable: si
   * un nivel ya identifica el video, no se sigue buscando (rendimiento) y solo
   * se fusionan variantes que pertenecen con certeza a ese mismo video.
   */
  async function resolveMedia(video) {
    const mediaId = mediaIdFromVideo(video);
    const poster = video.getAttribute('poster') || '';
    const tInicio = Date.now();
    /** @type {Array<Array<any>>} */
    const tiers = [];

    log('info', 'resolucion', 'Buscando el manifiesto del video', {
      idPoster: mediaId || '(el póster aún no está)',
      puente: bridgeResponded ? 'activo' : 'primer uso en esta pestaña (se comprueba ahora)',
      url: location.pathname
    });

    // Nivel 0 (el fiable): el puente del mundo de la página. Se lanza ya y se
    // recoge al final, de modo que mientras recorre las fibras de React se
    // ejecutan en paralelo las estrategias locales.
    const bridgePromise = requestMediaFromBridge(mediaId, poster, BRIDGE_TIMEOUT);

    // Nivel 1: props de React desde este mismo contexto. En un content script
    // normal no ve nada (mundos aislados); se mantiene como red de seguridad.
    const fromReact = dedupeMedia(mediaFromReact(video));
    if (fromReact.length) tiers.push(fromReact);

    const matched = () => {
      const flat = tiers.reduce((acc, tier) => acc.concat(tier), []);
      if (mediaId) return !!matchCandidate(flat, mediaId);
      return tiers.some((tier) => tier.length === 1);
    };

    if (!matched()) {
      // Nivel 2: estado global de la página (window.__INITIAL_STATE__ y similares).
      const fromState = dedupeMedia(mediaFromPageState());
      if (fromState.length) tiers.push(fromState);
    }

    if (!matched()) {
      // Nivel 3: árbol completo de React mediante el hook de DevTools.
      const fromRoots = dedupeMedia(mediaFromReactRoots(mediaId));
      if (fromRoots.length) tiers.push(fromRoots);
    }

    if (!matched()) {
      // Nivel 4: manifiestos HLS vistos en la red (funciona en el mundo aislado).
      const tHls = Date.now();
      const fromPlaylists = await mediaFromPlaylists(mediaId);
      if (fromPlaylists.length) tiers.push(fromPlaylists);
      log('info', 'resolucion', 'Estrategia de red (manifiestos HLS)', {
        medios: fromPlaylists.length,
        ms: Date.now() - tHls
      });
    }

    // Nivel 5: src directo del propio reproductor.
    const fromDom = dedupeMedia(mediaFromDomSources(video));
    if (fromDom.length) tiers.push(fromDom);

    // El puente pasa a ser el nivel preferente en cuanto responde.
    const bridgeEntities = await bridgePromise;
    const fromBridge = dedupeMedia(bridgeEntities.map(normalizeMediaEntity).filter(Boolean));
    if (fromBridge.length) tiers.unshift(fromBridge);
    log(fromBridge.length ? 'info' : 'warn', 'resolucion', 'Respuesta del puente del mundo de la página', {
      medios: fromBridge.length,
      ids: fromBridge.map((m) => m.id).filter(Boolean).slice(0, 4),
      variantes: fromBridge.reduce((n, m) => n + m.variants.length, 0),
      ms: Date.now() - tInicio
    });

    const all = dedupeMedia(tiers.reduce((acc, tier) => acc.concat(tier), []));

    if (!all.length) {
      log('error', 'resolucion', 'Ninguna estrategia encontró el manifiesto del video', {
        idBuscado: mediaId || '(sin póster)',
        niveles: tiers.map((t) => t.length),
        url: location.pathname
      });
      throw new Error(
        'No se pudo obtener el video en la calidad solicitada. Desplázate un poco, dale a reproducir y vuelve a intentarlo.'
      );
    }

    let chosen = mediaId ? matchCandidate(all, mediaId) : null;

    if (!chosen) {
      // Sin id fiable: se acepta el primer nivel que devuelva un único video.
      for (const tier of tiers) {
        if (tier.length === 1) {
          chosen = tier[0];
          break;
        }
      }
    }

    if (!chosen && all.length === 1) chosen = all[0];

    if (!chosen) {
      log('error', 'resolucion', 'No se pudo identificar el video entre los candidatos', {
        idBuscado: mediaId || '(sin póster)',
        idsEncontrados: all.map((m) => m.id).filter(Boolean).slice(0, 6)
      });
      throw new Error(
        'No se pudo identificar este video entre los encontrados en la página. Reproduce el video un instante y reinténtalo.'
      );
    }

    // Solo se fusionan variantes del mismo video (mismo id) o de un nivel que
    // identifica unívocamente a un único reproductor.
    const mergeSet = [chosen];
    for (const media of all) {
      if (media === chosen) continue;
      if (mediaId && media.id === mediaId) {
        mergeSet.push(media);
      } else if (!mediaId && tiers[0] && tiers[0].length === 1 && tiers[0][0] === media) {
        mergeSet.push(media);
      }
    }

    const merged = mergeVariants(mergeSet);
    return { ...chosen, ...merged };
  }

  function matchCandidate(list, mediaId) {
    if (!list.length) return null;
    if (!mediaId) return null;
    return list.find((m) => m && m.id && m.id === mediaId) || null;
  }

  function mergeVariants(list) {
    const seen = new Set();
    const variants = [];
    let poster = '';
    let id = '';
    let duration = 0;
    let streams = [];
    for (const media of list) {
      if (!media) continue;
      poster = poster || media.poster || '';
      id = id || media.id || '';
      duration = duration || media.duration || 0;
      if (media.streams && media.streams.length) streams = media.streams;
      for (const v of media.variants || []) {
        const key = v.url;
        if (seen.has(key)) continue;
        seen.add(key);
        variants.push(v);
      }
    }
    return { id, poster, duration, variants, streams };
  }

  /* =======================================================================
   * 6. Selección de la mejor variante según formato y calidad
   * ===================================================================== */

  function variantScore(v) {
    return (Number(v.height) || 0) * 1e7 + (Number(v.bitrate) || 0);
  }

  function hlsOnlyMessage(hasHls) {
    if (hasHls) {
      return (
        'Este video solo está disponible como stream HLS (sin archivo MP4 directo). ' +
        'Activa «Modo avanzado: reconstruir streams HLS» en el popup para intentar unirlo en un archivo.'
      );
    }
    return 'No se pudo obtener el video en la calidad solicitada. Inténtalo de nuevo en unos segundos.';
  }

  /** Bitrate de una rendition de audio deducido de su URL (…/mp4a/128000/…). */
  function bitrateDeAudio(url) {
    const texto = String(url || '');
    // Ojo: el bitrate tiene 5-6 dígitos (128000), no hay que truncarlo a 4.
    // Las playlists son …/pl/mp4a/128000/x.m3u8 y los segmentos
    // …/aud/mp4a/0/0/128000/x.m4s, así que se prueban los dos patrones.
    let m = texto.match(/\/mp4a\/(\d{3,7})/);
    if (m) return Number(m[1]);
    m = texto.match(/\/mp4a\/(?:\d+\/)*(\d{3,7})\//);
    if (m) return Number(m[1]);
    m = texto.match(/audio-(\d{3,7})/);
    return m ? Number(m[1]) : 0;
  }

  /**
   * Si se ha pedido solo audio, hay que conocer las pistas de audio que ofrece
   * el manifiesto maestro. La entidad multimedia solo trae la URL del maestro
   * (m3u8), así que se descarga y se añaden sus renditions de audio.
   */
  async function completarRenditionsDeAudio(media) {
    if (settings.format !== 'm4a' && settings.format !== 'mp3') return media;
    const variantes = media.variants || [];
    if (variantes.some((v) => v.kind === 'hls' && v.audioOnly)) return media;

    const maestros = variantes.filter((v) => v.kind === 'hls' && !v.audioOnly);
    const extra = [];

    for (const maestro of maestros.slice(0, 2)) {
      const cacheado = playlistCache.get(maestro.url);
      let analizado = null;
      if (cacheado && Date.now() - cacheado.ts < PLAYLIST_TTL) {
        analizado = cacheado.value;
      } else {
        try {
          const texto = await fetchText(maestro.url);
          analizado = parseMasterPlaylist(texto, maestro.url);
          playlistCache.set(maestro.url, { ts: Date.now(), value: analizado });
        } catch (err) {
          log('warn', 'audio', 'No se pudo leer el manifiesto para buscar la pista de audio', {
            url: maestro.url,
            motivo: errorMessage(err)
          });
          continue;
        }
      }
      for (const v of analizado.variants) {
        if (v.audioOnly) extra.push(v);
      }
    }

    if (!extra.length) return media;
    log('info', 'audio', 'Pistas de audio encontradas en el manifiesto', {
      cuantas: extra.length,
      kbps: extra.map((v) => Math.round((v.bitrate || bitrateDeAudio(v.url)) / 1000)).sort((a, b) => b - a)
    });
    return { ...media, variants: variantes.concat(extra) };
  }

  /**
   * Decide qué variantes usar y en qué orden (la primera es la elegida; el resto
   * sirven como respaldo de menor calidad).
   *
   * @param {{variants: Array<any>}} media entidad multimedia resuelta
   * @param {typeof DEFAULT_SETTINGS} [config] ajustes a usar (por defecto, los activos)
   */
  function planDownload(media, config) {
    const cfg = config || settings;
    const all = media.variants || [];
    const progressive = all.filter((v) => v.kind === 'video');
    const audioOnly = all.filter((v) => v.kind === 'audio');
    const hls = all.filter((v) => v.kind === 'hls');
    const hlsAudio = hls
      .filter((v) => v.audioOnly)
      .map((v) => ({ ...v, bitrate: v.bitrate || bitrateDeAudio(v.url) }))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const notices = [];
    const fmt = cfg.format;

    let pool = null;

    // --- Solo audio (M4A o MP3) -------------------------------------------
    if (fmt === 'm4a' || fmt === 'mp3') {
      // 1) La vía buena en X: la pista AAC suelta del HLS (128 kbps, sin recomprimir).
      if (hlsAudio.length) {
        return {
          ordered: [],
          hls: null,
          audio: { variant: hlsAudio[0], formato: fmt, kbps: hlsAudio[0].bitrate ? Math.round(hlsAudio[0].bitrate / 1000) : 128 },
          notice: notices.join(' ') || null,
          error: null
        };
      }

      // 2) Una pista de audio progresiva (otros sitios): se descarga tal cual, y
      //    si se pide MP3 se convierte a partir de esos bytes.
      if (audioOnly.length) {
        const mejor = audioOnly.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        return {
          ordered: [],
          hls: null,
          audio: {
            variant: mejor,
            formato: fmt,
            kbps: mejor.bitrate ? Math.round(mejor.bitrate / 1000) : 128,
            directo: true
          },
          notice: notices.join(' ') || null,
          error: null
        };
      }

      // 3) Respaldo: el MP4 completo (solo tiene sentido para M4A).
      if (fmt === 'm4a' && cfg.audioFallback === 'mp4') {
        const mp4s = progressive.filter((v) => v.ext === 'mp4');
        if (mp4s.length) {
          pool = mp4s;
          notices.push(
            'Este video no ofrece una pista de audio independiente: se descargará el MP4 completo (contiene el audio).'
          );
        }
      }

      if (!pool) {
        return {
          error:
            'No se pudo obtener solo el audio: este video no publica una pista de audio independiente. ' +
            'Prueba con el formato MP4 (el archivo incluye el audio).'
        };
      }
    } else if (fmt === 'webm') {
      const webm = progressive.filter((v) => v.ext === 'webm');
      if (webm.length) {
        pool = webm;
      } else if (progressive.some((v) => v.ext === 'mp4')) {
        pool = progressive.filter((v) => v.ext === 'mp4');
        notices.push('Este video no tiene versión WebM: se descargará en MP4 con la misma calidad de imagen.');
      }
    } else if (fmt === 'mp4') {
      const mp4s = progressive.filter((v) => v.ext === 'mp4');
      if (mp4s.length) {
        pool = mp4s;
      } else if (progressive.some((v) => v.ext === 'webm')) {
        pool = progressive.filter((v) => v.ext === 'webm');
        notices.push('Este video no tiene versión MP4: se descargará en WebM.');
      }
    } else {
      // Auto: mejor disponible (MP4 primero por compatibilidad, luego WebM, luego audio)
      if (progressive.length) {
        const mp4s = progressive.filter((v) => v.ext === 'mp4');
        pool = mp4s.length ? mp4s.concat(progressive.filter((v) => v.ext !== 'mp4')) : progressive;
      } else if (audioOnly.length) {
        pool = audioOnly;
      }
    }

    const wantsCustom = cfg.quality === 'custom';
    const desired = wantsCustom ? Number(cfg.minHeight) || 0 : 0;

    if (!pool || !pool.length) {
      if (cfg.hlsFallback && hls.length) {
        const best = hls.slice().sort((a, b) => variantScore(b) - variantScore(a))[0];
        return {
          ordered: [],
          hls: best,
          notice: notices.join(' ') || null,
          error: null
        };
      }
      return { error: hlsOnlyMessage(hls.length > 0) };
    }

    const sorted = pool.slice().sort((a, b) => variantScore(b) - variantScore(a));

    let ordered = sorted;
    if (desired > 0) {
      const filtered = sorted.filter((v) => (Number(v.height) || 0) >= desired);
      if (filtered.length) {
        ordered = filtered;
      } else {
        const bestHeight = sorted[0].height ? sorted[0].height + 'p' : 'la máxima disponible';
        notices.push(`No hay variantes de ${desired}p o superior; se usará ${bestHeight}.`);
      }
    }

    return {
      ordered,
      hls: null,
      notice: notices.join(' ') || null,
      error: null
    };
  }

  /* =======================================================================
   * 7. Nombre de archivo y carpeta
   * ===================================================================== */

  function getTweetContext(video) {
    const context = { screenName: '', tweetId: '', date: new Date().toISOString().slice(0, 10) };
    let scope = video.closest('article');
    if (!scope) scope = video.closest('[role="dialog"]') || document;

    try {
      const userLink = scope.querySelector('[data-testid="User-Name"] a[href^="/"]');
      if (userLink) {
        const m = userLink.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,20})$/);
        if (m) context.screenName = m[1];
      }
      if (!context.screenName) {
        const statusLink = scope.querySelector('a[href*="/status/"]');
        if (statusLink) {
          const m = statusLink.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,20})\/status\/(\d+)/);
          if (m) {
            context.screenName = m[1];
            context.tweetId = m[2];
          }
        }
      }
      if (!context.tweetId) {
        const anyStatus = document.querySelector('a[href*="/status/"]');
        if (anyStatus) {
          const m = anyStatus.getAttribute('href').match(/\/status\/(\d+)/);
          if (m) context.tweetId = m[1];
        }
      }
    } catch (_) {
      /* contexto opcional */
    }
    return context;
  }

  function sanitizeFolder(folder) {
    return String(folder || '')
      .split(/[\\/]+/)
      .map((part) => part.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+$/, '').trim())
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
  }

  function buildFilename(media, variant, context, suffix, config) {
    const cfg = config || settings;
    const parts = {
      usuario: context.screenName || 'x',
      id: media.id || context.tweetId || 'video',
      tweet: context.tweetId || media.id || 'video',
      fecha: context.date,
      calidad: variant.height ? variant.height + 'p' : variant.bitrate ? Math.round(variant.bitrate / 1000) + 'kbps' : 'max',
      bitrate: variant.bitrate ? String(variant.bitrate) : '',
      ext: variant.ext || 'mp4'
    };

    let template = String(cfg.filenameTemplate || '{usuario}_{id}_{calidad}').trim() || '{usuario}_{id}';
    if (!/\{ext\}/.test(template)) template += '.{ext}';
    if (suffix) template = template.replace(/\{ext\}/, suffix + '.{ext}');

    let name = template.replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(parts, key) ? String(parts[key]) : match
    );

    name = name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '');

    if (!name) name = 'video_' + Date.now() + '.' + (variant.ext || 'mp4');
    if (name.length > 150) {
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot) : '';
      name = name.slice(0, 150 - ext.length) + ext;
    }

    const folder = sanitizeFolder(cfg.folder);
    return folder ? folder + '/' + name : name;
  }

  /* =======================================================================
   * 8. Inyección del botón flotante
   * ===================================================================== */

  /**
   * Busca el contenedor sobre el que anclar el botón: el ancestro más cercano
   * que ocupa la misma caja que el elemento y ya está posicionado.
   * Sirve tanto para <video> como para imágenes y galerías.
   */
  function findOverlayHost(element) {
    const vRect = element.getBoundingClientRect();
    let node = element.parentElement;
    let fallback = null;

    for (let i = 0; i < 8 && node && node !== document.body && node !== document.documentElement; i++) {
      const rect = node.getBoundingClientRect();
      const sameBox =
        Math.abs(rect.width - vRect.width) < 12 && Math.abs(rect.height - vRect.height) < 12;
      if (sameBox) {
        const position = getComputedStyle(node).position;
        if (position !== 'static') return node;
        if (!fallback) fallback = node;
      }
      node = node.parentElement;
    }

    if (fallback) {
      fallback.style.position = 'relative';
      fallback.setAttribute(HOST_ATTR, '1');
      return fallback;
    }
    return null;
  }

  /**
   * Fábrica genérica de botones superpuestos, compartida por los módulos de
   * video e imágenes.
   *
   * @param {{
   *   label?: string,
   *   title?: string,
   *   ariaLabel?: string,
   *   icon?: string,
   *   className?: string,
   *   onClick: (event: MouseEvent, button: HTMLButtonElement) => void
   * }} options
   * @returns {HTMLButtonElement}
   */
  function createButton(options) {
    const opts = options || {};
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS + (opts.className ? ' ' + opts.className : '');
    button.dataset.state = 'idle';
    button.dataset.label = opts.label || 'Descargar';
    button.setAttribute('aria-label', opts.ariaLabel || opts.label || 'Descargar');
    button.title = opts.title || opts.label || 'Descargar';

    const icon = document.createElement('span');
    icon.className = 'xvd-button__iconwrap';
    icon.innerHTML = opts.icon || ICON_SVG;

    const label = document.createElement('span');
    label.className = 'xvd-button__label';
    label.textContent = opts.label || 'Descargar';

    button.append(icon, label);

    const stop = (event) => {
      event.stopPropagation();
    };
    button.addEventListener('pointerdown', stop);
    button.addEventListener('mousedown', stop);
    button.addEventListener('touchstart', stop, { passive: true });
    button.addEventListener('dblclick', stop);
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.state === 'loading') return;
      opts.onClick(event, button);
    });

    return button;
  }

  /**
   * Cambia el estado visual del botón: reposo, cargando (spinner), correcto
   * (check) o error. El módulo de imágenes lo usa también para el progreso.
   */
  function setButtonState(button, state, customLabel) {
    if (!button) return;
    const iconWrap = button.querySelector('.xvd-button__iconwrap');
    const label = button.querySelector('.xvd-button__label');
    if (!iconWrap || !label) return;

    const idleLabel = button.dataset.label || 'Descargar';

    if (state === 'loading') {
      button.dataset.state = 'loading';
      button.disabled = true;
      iconWrap.innerHTML = SPINNER_SVG;
      label.textContent = customLabel || 'Preparando…';
      return;
    }

    if (state === 'done') {
      button.dataset.state = 'done';
      button.disabled = false;
      iconWrap.innerHTML = CHECK_SVG;
      label.textContent = customLabel || 'Descargado';
      setTimeout(() => {
        if (button.dataset.state === 'done') setButtonState(button, 'idle');
      }, 2600);
      return;
    }

    if (state === 'error') {
      button.dataset.state = 'error';
      button.disabled = false;
      iconWrap.innerHTML = WARN_SVG;
      label.textContent = customLabel || 'Error';
      setTimeout(() => {
        if (button.dataset.state === 'error') setButtonState(button, 'idle');
      }, 2600);
      return;
    }

    button.dataset.state = 'idle';
    button.disabled = false;
    iconWrap.innerHTML = ICON_SVG;
    label.textContent = customLabel || idleLabel;
  }

  function isTooSmall(video) {
    const rect = video.getBoundingClientRect();
    return rect.width < 120 || rect.height < 80;
  }

  function ensureButton(video) {
    if (!settings.enabled) return;
    if (!video.isConnected) return;

    const existing = video.__xvdButton;
    if (existing && existing.isConnected && existing.parentElement) {
      if (video.getAttribute(VIDEO_ATTR) !== mediaIdFromVideo(video)) {
        video.setAttribute(VIDEO_ATTR, mediaIdFromVideo(video));
      }
      return;
    }

    if (isTooSmall(video)) {
      // El reproductor aún no tiene tamaño: reintentar cuando se redimensione.
      if (!observedVideos.has(video) && typeof ResizeObserver !== 'undefined') {
        observedVideos.add(video);
        const ro = new ResizeObserver(() => {
          if (!isTooSmall(video)) {
            ro.disconnect();
            ensureButton(video);
          }
        });
        ro.observe(video);
      }
      return;
    }

    let host = findOverlayHost(video);
    if (!host) {
      // Último recurso: un contenedor directo, forzando el contexto de posición
      // (position: relative sin desplazamientos no altera el diseño de X).
      host = video.parentElement;
      if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    }
    if (!host) return;
    host.setAttribute(HOST_ATTR, '1');

    const button = createButton({
      label: 'Descargar',
      title: 'Descargar video en la máxima calidad disponible',
      ariaLabel: 'Descargar video',
      icon: ICON_SVG,
      onClick: (event) => handleDownloadClick(event, video, button)
    });
    video.__xvdButton = button;
    host.appendChild(button);
    const id = mediaIdFromVideo(video);
    if (id) video.setAttribute(VIDEO_ATTR, id);
  }

  /** Escaneo del módulo de video: se registra en el núcleo compartido. */
  let lastLoggedVideoCount = -1;

  function scanVideos() {
    const videos = Array.from(document.querySelectorAll('video'));
    document.querySelectorAll('video').forEach((video) => {
      try {
        ensureButton(video);
      } catch (_) {
        /* nunca romper la página por un video problemático */
      }
    });

    const conBoton = videos.filter((v) => v.__xvdButton && v.__xvdButton.isConnected).length;
    if (conBoton !== lastLoggedVideoCount) {
      lastLoggedVideoCount = conBoton;
      const descartados = videos.filter((v) => !(v.__xvdButton && v.__xvdButton.isConnected)).length;
      log(descartados ? 'warn' : 'info', 'video', 'Barrido del DOM', {
        reproductores: videos.length,
        conBoton,
        sinBoton: descartados,
        motivo: descartados ? 'sin tamaño aún (se reintenta al redimensionar)' : ''
      });
    }
  }
  /* Este módulo es solo para X: en otros sitios hay un módulo propio
     (instagram.js, facebook.js…). Si no, pondría botones de X en Instagram. */
  if (/(^|\.)(x|twitter)\.com$/i.test(location.hostname)) registerScanner(scanVideos);

  const scheduleScan = debounce(() => {
    if (!settings.enabled) return;
    for (const scanner of scanners) {
      try {
        scanner();
      } catch (_) {
        /* el fallo de un módulo no debe afectar a los demás */
      }
    }
  }, 220);

  function isOurNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const el = /** @type {Element} */ (node);
    return (
      el.classList.contains(BUTTON_CLASS) ||
      el.classList.contains(BADGE_CLASS) ||
      el.id === TOASTS_ID ||
      el.classList.contains('xvd-toast') ||
      !!el.closest('.' + BUTTON_CLASS) ||
      !!el.closest('.' + BADGE_CLASS)
    );
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        if (isOurNode(mutation.target)) continue;

        // Si X elimina nuestro botón al repintar un tuit, hay que recolocarlo.
        for (const node of mutation.removedNodes) {
          if (node && node.nodeType === 1 && node.classList && node.classList.contains(BUTTON_CLASS)) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;

        for (const node of mutation.addedNodes) {
          if (isOurNode(node)) continue;
          relevant = true;
          break;
        }
        if (relevant) break;
        if (mutation.type === 'attributes') {
          relevant = true;
          break;
        }
      }
      if (relevant) scheduleScan();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['poster', 'src']
    });

    window.addEventListener('scroll', scheduleScan, { passive: true, capture: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
    window.addEventListener('popstate', scheduleScan);
    return observer;
  }

  /* =======================================================================
   * 9. Flujo de descarga
   * ===================================================================== */

  async function resolveMediaWithRetry(video, attempts = 3) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const media = await resolveMedia(video);
        if (media && media.variants && media.variants.length) return media;
        lastError = new Error('No se pudo obtener el video en la calidad solicitada.');
      } catch (err) {
        lastError = err;
      }
      if (i < attempts - 1) {
        log('info', 'resolucion', 'Reintento ' + (i + 2) + ' de ' + attempts + '…', { esperaMs: 400 * (i + 1) });
        await sleep(400 * (i + 1));
      }
    }
    throw lastError || new Error('No se pudo obtener el video en la calidad solicitada.');
  }

  async function handleDownloadClick(event, video, button) {
    const tInicio = Date.now();
    setButtonState(button, 'loading', 'Preparando…');
    log('info', 'video', 'Clic en «Descargar»', {
      idPoster: mediaIdFromVideo(video) || '(sin póster)',
      puente: bridgeResponded ? 'activo' : 'primer uso en esta pestaña (se comprueba ahora)',
      ajustes: settings.format + '/' + settings.quality
    });

    try {
      const mediaBase = await resolveMediaWithRetry(video);
      const media = await completarRenditionsDeAudio(mediaBase);
      const plan = planDownload(media);

      if (plan.error) {
        log('error', 'resolucion', 'No hay ninguna variante descargable', { motivo: plan.error });
        throw new Error(plan.error);
      }

      const context = getTweetContext(video);

      if (plan.audio) {
        log('info', 'audio', 'Modo solo audio', {
          formato: plan.audio.formato,
          kbps: plan.audio.kbps,
          via: plan.audio.directo ? 'pista progresiva' : 'pista del HLS'
        });
        await descargarSoloAudio(plan, media, context, button);
        return;
      }

      if (plan.hls) {
        log('warn', 'video', 'Solo hay stream HLS: se intenta reconstruir', {
          resolucion: plan.hls.height + 'p',
          url: plan.hls.url
        });
        await downloadHlsStream(plan.hls, media, context);
        return;
      }

      const elegida = plan.ordered[0];
      log('info', 'video', 'Variante elegida', {
        resolucion: (elegida.height || '?') + 'p',
        bitrate: elegida.bitrate,
        tipo: elegida.ext,
        variantes: plan.ordered.length,
        ms: Date.now() - tInicio
      });

      if (plan.notice) toast(plan.notice, 'warn', 6000);
      await startDownload(plan.ordered, media, context, button);
    } catch (err) {
      log('error', 'video', 'Fallo al preparar la descarga', {
        mensaje: errorMessage(err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : ''
      });
      setButtonState(button, 'error', 'No disponible');
      toast(errorMessage(err), 'error', 7000);
    } finally {
      if (button.dataset.state === 'loading') setButtonState(button, 'idle');
    }
  }

  /**
   * Pide una descarga al service worker y registra el reintento con la
   * variante inferior que se usará si Chrome interrumpe la descarga.
   */
  async function requestDownload(options) {
    const response = await sendMessage({
      type: 'XVD_DOWNLOAD',
      url: options.url,
      filename: options.filename,
      saveAs: options.saveAs === undefined ? !!settings.askWhereToSave : !!options.saveAs
    });
    if (!response || !response.ok) {
      log('error', 'descarga', 'El service worker rechazó la descarga', {
        archivo: options.filename,
        url: options.url,
        motivo: response && response.error ? response.error : 'sin respuesta'
      });
      throw new Error(response && response.error ? response.error : 'No se pudo iniciar la descarga.');
    }
    log('info', 'descarga', 'Descarga aceptada por chrome.downloads', {
      id: response.downloadId,
      archivo: response.filename || options.filename
    });
    pendingDownloads.set(response.downloadId, {
      filename: options.filename,
      label: options.label || 'archivo',
      onInterrupted: options.onInterrupted || null
    });
    return response;
  }

  async function startDownload(ordered, media, context, button) {
    const attempt = async (index, showToast) => {
      const variant = ordered[index];
      const filename = buildFilename(media, variant, context);
      const response = await requestDownload({
        url: variant.url,
        filename,
        label: filename,
        onInterrupted: (reason) => retryWithLowerQuality(ordered, index, media, context, reason)
      });
      if (showToast) toast('Descarga iniciada: ' + filename, 'success', 4000);
      return response;
    };

    try {
      await attempt(0, true);
    } catch (err) {
      if (settings.autoFallback && ordered.length > 1) {
        toast('La máxima calidad falló, reintentando con una variante inferior…', 'warn', 4500);
        await attempt(1, false);
        return;
      }
      throw err;
    }

    if (button) setButtonState(button, 'done', 'Descargando');
  }

  /** Respaldo encadenado: si la variante elegida falla, prueba la siguiente. */
  async function retryWithLowerQuality(ordered, index, media, context, reason) {
    const next = index + 1;
    if (!settings.autoFallback || next >= ordered.length) return null;

    toast('La descarga falló (' + reason + '). Reintentando con menor calidad…', 'warn', 5000);
    log('warn', 'descarga', 'Reintentando con una variante inferior', {
      resolucion: (ordered[next].height || '?') + 'p',
      motivo: reason
    });
    const variant = ordered[next];
    const filename = buildFilename(media, variant, context);
    try {
      const response = await requestDownload({
        url: variant.url,
        filename,
        label: filename,
        onInterrupted: (nextReason) => retryWithLowerQuality(ordered, next, media, context, nextReason)
      });
      return response.downloadId;
    } catch (err) {
      toast('Tampoco se pudo descargar la variante inferior: ' + errorMessage(err), 'error', 7000);
      return null;
    }
  }

  /* ---------------------- 9.1 Reconstrucción de streams HLS ---------------------- */

  function parseMediaPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let initSegment = '';
    let encrypted = false;
    let isFmp4 = false;
    const segments = [];

    for (const line of lines) {
      if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
        if ((attrs.METHOD || '').toUpperCase() !== 'NONE') encrypted = true;
        continue;
      }
      if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) {
          initSegment = absoluteUrl(attrs.URI, baseUrl);
          isFmp4 = true;
        }
        continue;
      }
      if (line.startsWith('#')) continue;
      segments.push(absoluteUrl(line, baseUrl));
    }
    return { initSegment, encrypted, isFmp4, segments };
  }

  /**
   * Descarga un stream HLS y devuelve sus bytes ya unidos, sin guardarlos.
   * Lo usan la reconstrucción de vídeo y la descarga de solo audio.
   */
  async function construirDesdeHls(hlsVariant, onProgress, limites) {
    const maxSegmentos = (limites && limites.maxSegmentos) || 4000;
    const maxBytes = (limites && limites.maxBytes) || 700 * 1024 * 1024;

    let playlistUrl = hlsVariant.url;
    let playlistText = await fetchText(playlistUrl);

    if (playlistText.includes('#EXT-X-STREAM-INF')) {
      const master = parseMasterPlaylist(playlistText, playlistUrl);
      const mejores = master.streams
        .slice()
        .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
      if (!mejores.length) throw new Error('El stream HLS no contiene ninguna variante reproducible.');
      playlistUrl = mejores[0].url;
      playlistText = await fetchText(playlistUrl);
    }

    const playlist = parseMediaPlaylist(playlistText, playlistUrl);
    if (playlist.encrypted) {
      throw new Error('El stream HLS está cifrado y no se puede reconstruir desde la extensión.');
    }
    if (!playlist.segments.length) {
      throw new Error('No se encontraron segmentos en el stream HLS.');
    }
    if (playlist.segments.length > maxSegmentos) {
      throw new Error('El stream es demasiado largo para reconstruirlo en memoria.');
    }

    const partes = [];
    let totalBytes = 0;

    if (playlist.initSegment) {
      const res = await fetch(playlist.initSegment, { credentials: 'omit' });
      if (!res.ok) throw new Error('No se pudo descargar el segmento inicial del stream.');
      const buffer = await res.arrayBuffer();
      partes.push(buffer);
      totalBytes += buffer.byteLength;
    }

    const total = playlist.segments.length;
    for (let i = 0; i < total; i++) {
      const res = await fetch(playlist.segments[i], { credentials: 'omit' });
      if (!res.ok) throw new Error('Falló la descarga del segmento ' + (i + 1) + ' de ' + total + '.');
      const buffer = await res.arrayBuffer();
      partes.push(buffer);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error('El archivo es demasiado grande para reconstruirlo en memoria.');
      }
      if (onProgress) onProgress(i + 1, total);
    }

    return {
      bytes: new Uint8Array(await new Blob(partes).arrayBuffer()),
      esFmp4: playlist.isFmp4,
      totalBytes,
      segmentos: total
    };
  }

  async function downloadHlsStream(hlsVariant, media, context) {
    const progress = toast('Analizando el stream HLS…', 'info', 60000);

    const update = (message) => {
      if (progress) {
        const node = progress.querySelector('.xvd-toast__msg');
        if (node) node.textContent = message;
      }
    };

    try {
      const construido = await construirDesdeHls(hlsVariant, (hecho, total) => {
        if (hecho % 10 === 0 || hecho === total) {
          update('Descargando stream: ' + hecho + '/' + total + ' segmentos…');
        }
      });

      const type = construido.esFmp4 ? 'video/mp4' : 'video/mp2t';
      const ext = construido.esFmp4 ? 'mp4' : 'ts';
      const variant = { ...hlsVariant, ext, height: hlsVariant.height || 0 };
      const filename = buildFilename(media, variant, context, construido.esFmp4 ? '' : 'hls');

      descargarBlobEnLaPagina(new Blob([construido.bytes], { type }), filename.split('/').pop());

      log('info', 'video', 'Stream HLS reconstruido', {
        archivo: filename,
        segmentos: construido.segmentos,
        kb: Math.round(construido.totalBytes / 1024)
      });

      if (progress) {
        update('Stream reconstruido: ' + filename + (construido.esFmp4 ? '' : ' (contenedor MPEG-TS)'));
        setTimeout(() => progress.remove(), 6000);
      }
    } catch (err) {
      if (progress) progress.remove();
      log('error', 'video', 'Fallo al reconstruir el stream HLS', { motivo: errorMessage(err) });
      toast(errorMessage(err), 'error', 7000);
    }
  }

  /** Descarga un Blob desde la propia página (para HLS y para respaldos). */
  function descargarBlobEnLaPagina(blob, nombreArchivo) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = nombreArchivo;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }, 60000);
  }

  /* ---------------------- 9.1b Solo audio (M4A / MP3) ---------------------- */

  /** Pide al service worker que inyecte el codificador MP3 (lamejs) en esta pestaña. */
  async function prepararCodificadorMp3() {
    if (typeof window.lamejs !== 'undefined' && window.lamejs && window.lamejs.Mp3Encoder) return true;
    const respuesta = await sendMessage({ type: 'XVD_INJECT_LAMEJS' });
    return !!(respuesta && respuesta.ok) && !!window.lamejs;
  }

  /** Convierte un M4A (AAC en MP4) a MP3 decodificando y recodificando. */
  async function convertirMp3(bytes, kbps, onProgress) {
    const listo = await prepararCodificadorMp3();
    if (!listo) throw new Error('No se pudo preparar el codificador MP3. Prueba con el formato M4A.');

    if (onProgress) onProgress('Decodificando el audio…');
    const contexto = new OfflineAudioContext(2, 44100, 44100);
    const copia = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audio = await contexto.decodeAudioData(copia);

    if (onProgress) onProgress('Convirtiendo a MP3…');
    const a16 = (flotante) => {
      const salida = new Int16Array(flotante.length);
      for (let i = 0; i < flotante.length; i++) {
        const s = Math.max(-1, Math.min(1, flotante[i]));
        salida[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return salida;
    };

    const canales = Math.min(2, audio.numberOfChannels);
    const codificador = new window.lamejs.Mp3Encoder(canales, audio.sampleRate, kbps || 128);
    const izquierda = a16(audio.getChannelData(0));
    const derecha = canales > 1 ? a16(audio.getChannelData(1)) : null;

    const trozos = [];
    const bloque = 1152;
    for (let i = 0; i < izquierda.length; i += bloque) {
      const l = izquierda.subarray(i, i + bloque);
      const trozo =
        canales > 1
          ? codificador.encodeBuffer(l, derecha.subarray(i, i + bloque))
          : codificador.encodeBuffer(l);
      if (trozo.length) trozos.push(new Uint8Array(trozo));
    }
    const fin = codificador.flush();
    if (fin.length) trozos.push(new Uint8Array(fin));

    return { bytes: new Uint8Array(await new Blob(trozos).arrayBuffer()), canales, sampleRate: audio.sampleRate, duracion: audio.duration };
  }

  /**
   * Manda los bytes a guardar al service worker.
   *
   * OJO: chrome.runtime.sendMessage serializa a JSON (no usa structured clone),
   * así que un ArrayBuffer llegaría como {} y se perdería. Por eso se envía en
   * trozos codificados en base64.
   */
  async function enviarBytesAGuardar(bytes, mime, filename, saveAs) {
    const TROZO = 3 * 1024 * 1024;
    const transferId = 'tr-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const total = Math.max(1, Math.ceil(bytes.length / TROZO));
    let respuesta = null;

    for (let i = 0; i < total; i++) {
      const parte = bytes.subarray(i * TROZO, Math.min(bytes.length, (i + 1) * TROZO));

      // A binario y luego a base64, por bloques pequeños para no reventar la pila.
      let binario = '';
      for (let j = 0; j < parte.length; j += 32768) {
        binario += String.fromCharCode.apply(null, parte.subarray(j, Math.min(parte.length, j + 32768)));
      }

      respuesta = await sendMessage({
        type: 'XVD_DOWNLOAD_BYTES',
        transferId,
        trozo: i,
        trozos: total,
        base64: btoa(binario),
        mime,
        filename,
        saveAs,
        ultimo: i === total - 1
      });

      if (!respuesta || !respuesta.ok) {
        return respuesta || { ok: false, error: 'No se pudo guardar el audio.' };
      }
    }
    return respuesta;
  }

  /**
   * Descarga SOLO el audio: reconstruye la pista AAC del HLS, la convierte a MP3
   * si se ha pedido, y la guarda con la misma carpeta y el mismo seguimiento que
   * el resto de descargas (vía documento offscreen).
   */
  async function descargarSoloAudio(plan, media, context, button) {
    const progress = toast('Preparando el audio…', 'info', 120000);
    const update = (mensaje) => {
      if (!progress) return;
      const nodo = progress.querySelector('.xvd-toast__msg');
      if (nodo) nodo.textContent = mensaje;
    };

    try {
      const variante = plan.audio.variant;
      let construido;

      if (plan.audio.directo) {
        // Pista de audio progresiva (otros sitios): se descarga entera.
        update('Descargando la pista de audio…');
        const res = await fetch(variante.url, { credentials: 'omit' });
        if (!res.ok) throw new Error('No se pudo descargar la pista de audio (HTTP ' + res.status + ').');
        const bytes = new Uint8Array(await res.arrayBuffer());
        construido = { bytes, esFmp4: true, totalBytes: bytes.length, segmentos: 1 };
      } else {
        update('Descargando la pista de audio del stream…');
        construido = await construirDesdeHls(
          variante,
          (hecho, total) => update('Descargando audio: ' + hecho + '/' + total + ' segmentos…'),
          { maxSegmentos: 20000, maxBytes: 400 * 1024 * 1024 }
        );
      }

      const quiereMp3 = plan.audio.formato === 'mp3';
      let bytes = construido.bytes;
      let mime = construido.esFmp4 ? 'audio/mp4' : 'audio/aac';
      let ext = construido.esFmp4 ? 'm4a' : 'aac';

      if (quiereMp3) {
        const convertido = await convertirMp3(construido.bytes, plan.audio.kbps, update);
        bytes = convertido.bytes;
        mime = 'audio/mpeg';
        ext = 'mp3';
        log('info', 'audio', 'Audio convertido a MP3', {
          kb: Math.round(bytes.length / 1024),
          kbps: plan.audio.kbps,
          hz: convertido.sampleRate,
          canales: convertido.canales,
          segundos: Math.round(convertido.duracion * 10) / 10
        });
      }

      const varianteArchivo = { ...variante, ext, height: 0, bitrate: plan.audio.kbps ? plan.audio.kbps * 1000 : variante.bitrate };
      const filename = buildFilename(media, varianteArchivo, context);

      update('Guardando el archivo…');
      const respuesta = await enviarBytesAGuardar(bytes, mime, filename, !!settings.askWhereToSave);

      if (!respuesta || !respuesta.ok) {
        throw new Error(respuesta && respuesta.error ? respuesta.error : 'No se pudo guardar el audio.');
      }

      pendingDownloads.set(respuesta.downloadId, { filename, label: filename, onInterrupted: null });
      log('info', 'audio', 'Solo audio solicitado a chrome.downloads', {
        archivo: filename,
        formato: ext,
        kb: Math.round(bytes.length / 1024),
        segmentos: construido.segmentos
      });

      if (progress) progress.remove();
      toast('Descarga iniciada: ' + filename, 'success', 4500);
      setButtonState(button, 'done', ext === 'mp3' ? 'MP3' : 'M4A');
    } catch (err) {
      if (progress) progress.remove();
      log('error', 'audio', 'Fallo al descargar solo el audio', { mensaje: errorMessage(err) });
      toast(errorMessage(err), 'error', 8000);
      setButtonState(button, 'error', 'Sin audio');
    }
  }


  /* ---------------------- 9.2 Avisos del background ---------------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;

    if (message.type === 'XVD_DOWNLOAD_EVENT') {
      handleDownloadEvent(message).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'XVD_PING') {
      sendResponse({
        ok: true,
        videos: document.querySelectorAll('video').length,
        images: document.querySelectorAll('[' + IMAGE_ATTR + ']').length,
        enabled: !!settings.enabled,
        imagesEnabled: !!settings.imagesEnabled,
        bridge: bridgeResponded,
        bridgeTimeouts,
        version: coreVersion
      });
      return true;
    }

    return undefined;
  });

  async function handleDownloadEvent(event) {
    const record = pendingDownloads.get(event.downloadId);

    if (event.state === 'complete') {
      pendingDownloads.delete(event.downloadId);
      const nombre = record ? record.filename : 'archivo guardado';
      const megas = event.bytes ? Math.round((event.bytes / 1048576) * 10) / 10 : 0;
      const detalle = megas ? ' (' + String(megas).replace('.', ',') + ' MB' + (event.seconds ? ' en ' + String(event.seconds).replace('.', ',') + ' s' : '') + ')' : '';
      log('info', 'descarga', 'Descarga completada', {
        id: event.downloadId,
        archivo: nombre,
        tamañoMB: megas,
        segundos: event.seconds || 0
      });
      toast('Descarga completada: ' + nombre + detalle, 'success', 4500);
      return;
    }

    if (event.state !== 'interrupted') return;

    pendingDownloads.delete(event.downloadId);
    const reason = event.message || 'Error desconocido durante la descarga.';
    log('error', 'descarga', 'Chrome interrumpió la descarga', {
      id: event.downloadId,
      codigo: event.errorCode || '',
      motivo: reason,
      archivo: record ? record.filename : '(desconocido)'
    });

    // Cada módulo decide cómo reaccionar: el de video baja de calidad y el de
    // imágenes prueba la siguiente resolución disponible.
    if (record && typeof record.onInterrupted === 'function') {
      const retriedId = await record.onInterrupted(reason);
      if (retriedId) return;
    }

    toast('No se pudo descargar ' + (record && record.label ? record.label : 'el archivo') + ': ' + reason, 'error', 7000);
  }

  /* =======================================================================
   * 10. Núcleo compartido y arranque
   * ===================================================================== */

  /**
   * API interna que consumen los módulos que se cargan después (images.js).
   * Vive en el mundo aislado de la extensión, no en el contexto de la página.
   */
  window.__XVD_CORE__ = {
    version: '2.0.0',
    DEFAULT_SETTINGS,
    BUTTON_CLASS,
    BADGE_CLASS,
    HOST_ATTR,
    VIDEO_ATTR,
    IMAGE_ATTR,
    ICONS: {
      download: ICON_SVG,
      spinner: SPINNER_SVG,
      check: CHECK_SVG,
      warn: WARN_SVG,
      images: IMAGES_SVG
    },
    getSettings: () => settings,
    sendMessage,
    toast,
    sleep,
    errorMessage,
    log,
    registerScanner,
    registerDisableHook,
    requestDownload,
    createButton,
    setButtonState,
    findOverlayHost,
    getTweetContext,
    sanitizeFolder,
    cleanupOverlays,
    isOurNode,
    scan: scheduleScan,
    // Compartido con los módulos de otros sitios (instagram.js, facebook.js…)
    pedirAlPuente,
    requestInstagramMedia,
    fetchBytes,
    convertirMp3,
    guardarBytes: enviarBytesAGuardar,
    descargarBlobEnLaPagina
  };

  /* =======================================================================
   * 11. Vigilante de contexto (actualizaciones de la extensión)
   *
   * Al recargar la extensión (botón «Actualizar extensión» del popup o el ↻ de
   * chrome://extensions), los content scripts ya inyectados quedan HUÉRFANOS:
   * siguen vivos en la página con el código viejo y sus llamadas a chrome.*
   * dejan de funcionar. Aquí se detecta y se recarga la página sola, para que
   * entre el código nuevo sin que el usuario tenga que pulsar F5.
   * ===================================================================== */

  let fallosDeContexto = 0;
  let contextoYaRecargado = false;

  function contextoInvalidado() {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return true;
      const manifiesto = chrome.runtime.getManifest();
      return !manifiesto || !manifiesto.version;
    } catch (_) {
      return true;
    }
  }

  function vigilarContexto() {
    setInterval(() => {
      if (contextoYaRecargado) return;
      if (!contextoInvalidado()) {
        fallosDeContexto = 0;
        return;
      }
      // Se exigen dos fallos seguidos para no recargar por un falso positivo.
      fallosDeContexto++;
      if (fallosDeContexto < 2) return;

      contextoYaRecargado = true;
      try {
        console.warn('[XVD] La extensión se actualizó: recargando la página para aplicar el código nuevo…');
      } catch (_) {
        /* consola no disponible */
      }
      setTimeout(() => {
        try {
          location.reload();
        } catch (_) {
          /* nada más que hacer */
        }
      }, 400);
    }, 3000);
  }

  async function boot() {
    await loadSettings();
    document.documentElement.classList.toggle('xvd-hover-only', !!settings.showOnHover);
    startObserver();
    scheduleScan();
    vigilarContexto();

    log('info', 'inicio', 'Content script listo', {
      version: coreVersion,
      activo: !!settings.enabled,
      imagenes: !!settings.imagesEnabled,
      video: settings.format + '/' + settings.quality,
      imagen: settings.imageResolution + '/' + settings.imageFormat,
      carpeta: sanitizeFolder(settings.folder) || '(raíz de Descargas)',
      url: location.pathname
    });

    // Segundo barrido tras la hidratación inicial de la SPA.
    setTimeout(scheduleScan, 1200);
    setTimeout(scheduleScan, 3000);
  }

  /* -----------------------------------------------------------------------
   * Punto de enganche para las pruebas automatizadas (tools/test.js).
   * En el navegador `module` no existe, así que esta rama nunca se ejecuta.
   * --------------------------------------------------------------------- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULT_SETTINGS,
      normalizeVariant,
      normalizeMediaEntity,
      extractMediaId,
      dedupeMedia,
      mergeVariants,
      planDownload,
      variantScore,
      bitrateDeAudio,
      buildFilename,
      sanitizeFolder,
      parseMasterPlaylist,
      parseMediaPlaylist,
      parseAttributes
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
