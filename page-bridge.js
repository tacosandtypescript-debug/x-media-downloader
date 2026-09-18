/**
 * Descargador de medios para X — Puente en el MUNDO DE LA PÁGINA (MAIN)
 * ---------------------------------------------------------------------------
 * ¿POR QUÉ EXISTE ESTE ARCHIVO?
 *
 * Los content scripts viven en un "mundo aislado": comparten el DOM, pero NO
 * comparten los globales de JavaScript ni las propiedades añadidas a los nodos.
 * Comprobado empíricamente:
 *
 *                          mundo aislado   mundo MAIN
 *   atributo DOM (poster)        sí             sí
 *   nodo.__reactFiber$…          NO             sí
 *   window.__INITIAL_STATE__     NO             sí
 *   window.__REACT_DEVTOOLS…     NO             sí
 *
 * Los videos de X solo se pueden resolver leyendo el manifiesto que vive en las
 * props de React (o en el estado global de la página), así que un content script
 * normal jamás vería `video_info.variants`. Este puente se declara en el
 * manifiesto con `"world": "MAIN"` (Chrome lo inyecta él mismo, por lo que la CSP
 * de x.com no lo bloquea) y responde a las peticiones del mundo aislado
 * mediante `window.postMessage`.
 *
 * Protocolo (solo datos planos, clonables por structured clone):
 *   petición :  { __xvdBridge: true, kind: 'request',  requestId, mediaId, poster }
 *   respuesta:  { __xvdBridge: true, kind: 'response', requestId, media: [entidad…] }
 *
 * Las entidades se devuelven con la MISMA forma que usa X
 * (`{ id_str, media_url_https, duration_millis, video_info: { variants } }`)
 * para que el mundo aislado las normalice con su código ya probado.
 */
(() => {
  'use strict';

  if (window.__XVD_BRIDGE_LOADED__) return;
  window.__XVD_BRIDGE_LOADED__ = true;

  const MARK = '__xvdBridge';
  const MAX_MEDIA = 12;
  const MAX_VARIANTS = 24;
  const ALLOWED_HOSTS = ['video.twimg.com', 'pbs.twimg.com'];

  /* =======================================================================
   * 1. Utilidades
   * ===================================================================== */

  function extractMediaId(url) {
    if (!url) return '';
    const m = String(url).match(
      /(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb|amplify_video|ext_tw_video|tweet_video)\/(\d+)/
    );
    return m ? m[1] : '';
  }

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
      ext = /\.mp3(\?|#|$)/i.test(url) || (ct.includes('mpeg') && !ct.includes('mp4')) ? 'mp3' : 'm4a';
    } else if (ct.includes('webm') || /\.webm(\?|#|$)/i.test(url)) {
      kind = 'video';
      ext = 'webm';
    }

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
      origin: 'puente'
    };
  }

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

  function dedupeMedia(list) {
    const map = new Map();
    for (const media of list) {
      if (!media || !media.variants || !media.variants.length) continue;
      const key = media.id || media.variants.map((v) => v.url).join('|');
      const prev = map.get(key);
      if (!prev || prev.variants.length < media.variants.length) map.set(key, media);
    }
    return Array.from(map.values());
  }

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

  /* =======================================================================
   * 2. Búsqueda de entidades multimedia
   * ===================================================================== */

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

      for (const key of Object.keys(value)) {
        if (key === 'return' || key === 'child' || key === 'sibling' || key === '_owner') continue;
        const child = value[key];
        if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      }
    }
    return out;
  }

  /** Props de React y cadena de fibras del propio reproductor y de su tuit. */
  function mediaFromElement(element) {
    const found = [];
    if (!element) return found;
    const seeds = [
      element,
      element.parentElement,
      element.closest && element.closest('article'),
      element.closest && element.closest('[data-testid="cellInnerDiv"]')
    ];

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
    return found;
  }

  /** Estado global de la página (compatibilidad con estructuras heredadas). */
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

  /** Recorrido completo del árbol de React con el hook de DevTools. */
  function mediaFromReactRoots() {
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
    }
    return dedupeMedia(found);
  }

  /**
   * Reúne las entidades candidatas para el reproductor indicado. Se prioriza el
   * <video> cuyo póster coincide (identificación exacta) y, si no, se devuelven
   * todas para que el mundo aislado desambigüe por id.
   */
  function collectFor(mediaId, poster) {
    const found = [];
    let videos = [];
    try {
      videos = Array.from(document.querySelectorAll('video'));
    } catch (_) {
      videos = [];
    }

    const targets = [];
    if (poster) {
      const exact = videos.find((v) => (v.getAttribute && v.getAttribute('poster')) === poster);
      if (exact) targets.push(exact);
    }
    if (mediaId) {
      for (const v of videos) {
        const p = (v.getAttribute && v.getAttribute('poster')) || '';
        if (p.includes(mediaId) && !targets.includes(v)) targets.push(v);
      }
    }
    if (!targets.length) targets.push(...videos.slice(0, 4));

    for (const element of targets) {
      found.push(...mediaFromElement(element));
    }

    let media = dedupeMedia(found);
    const hasMatch = () => (mediaId ? media.some((m) => m.id === mediaId) : media.length > 0);

    if (!hasMatch()) media = dedupeMedia(media.concat(mediaFromPageState()));
    if (!hasMatch()) media = dedupeMedia(media.concat(mediaFromReactRoots()));
    return media;
  }

  /* =======================================================================
   * 3. Saneado de la respuesta (defensa frente a mensajes falsificados)
   * ===================================================================== */

  function allowedUrl(url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    try {
      return ALLOWED_HOSTS.includes(new URL(url).hostname.toLowerCase());
    } catch (_) {
      return false;
    }
  }

  function sanitizeEntity(media) {
    if (!media || !Array.isArray(media.variants)) return null;
    const variants = media.variants
      .filter((v) => v && allowedUrl(v.url))
      .slice(0, MAX_VARIANTS)
      .map((v) => ({
        url: v.url,
        content_type: String(v.contentType || v.content_type || ''),
        bitrate: Number(v.bitrate) || 0,
        width: Number(v.width) || 0,
        height: Number(v.height) || 0
      }));
    if (!variants.length) return null;

    return {
      id_str: String(media.id || ''),
      media_url_https: allowedUrl(media.poster) ? media.poster : '',
      duration_millis: Number(media.duration) || 0,
      video_info: { variants }
    };
  }

  /* =======================================================================
   * 4. Protocolo con el mundo aislado
   * ===================================================================== */

  function onMessage(event) {
    // Solo se atienden mensajes de esta misma ventana (no de iframes ni de terceros).
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data[MARK] !== true || data.kind !== 'request') return;

    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    if (!requestId) return;

    let payload = [];
    try {
      const media = collectFor(String(data.mediaId || ''), String(data.poster || ''));
      payload = media.map(sanitizeEntity).filter(Boolean).slice(0, MAX_MEDIA);
    } catch (_) {
      payload = [];
    }

    try {
      window.postMessage({ [MARK]: true, kind: 'response', requestId, media: payload }, '*');
    } catch (_) {
      /* respuesta no clonable: el mundo aislado agotará su tiempo de espera */
    }
  }

  window.addEventListener('message', onMessage, false);

  /* -----------------------------------------------------------------------
   * Punto de enganche para las pruebas automatizadas (tools/test.js).
   * En el navegador `module` no existe, así que esta rama nunca se ejecuta.
   * --------------------------------------------------------------------- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      extractMediaId,
      normalizeVariant,
      normalizeMediaEntity,
      dedupeMedia,
      deepCollectMedia,
      mediaFromElement,
      mediaFromPageState,
      mediaFromReactRoots,
      collectFor,
      sanitizeEntity,
      allowedUrl,
      onMessage
    };
  }
})();
