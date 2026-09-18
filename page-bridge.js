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
  const ALLOWED_HOSTS = ['video.twimg.com', 'pbs.twimg.com', 'cdninstagram.com', 'fbcdn.net'];

  /** Host permitido, incluyendo subdominios (scontent-*.cdninstagram.com). */
  function hostPermitido(host) {
    const h = String(host || '').toLowerCase();
    return ALLOWED_HOSTS.some((permitido) => h === permitido || h.endsWith('.' + permitido));
  }

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
   * 2b. Instagram
   *
   * IG es también una SPA de React con Relay, así que sus datos (video_versions,
   * image_versions2, carousel_media) viven en las props de las fibras y son
   * invisibles desde el mundo aislado. Se buscan por FORMA, no por ruta, para
   * aguantar los cambios de envoltorio de la API.
   *
   * Ojo: las URLs de IG van firmadas (oh= / oe=) y CADUCAN, así que se devuelven
   * tal cual, sin reescribirlas (a diferencia de pbs.twimg.com en X).
   * ===================================================================== */

  function pareceMediaDeInstagram(valor) {
    return (
      !!valor &&
      typeof valor === 'object' &&
      (Array.isArray(valor.video_versions) ||
        (valor.image_versions2 && Array.isArray(valor.image_versions2.candidates)) ||
        Array.isArray(valor.carousel_media))
    );
  }

  function mejorPorTamano(lista) {
    return lista
      .filter((c) => c && typeof c.url === 'string' && c.url)
      .slice()
      .sort((a, b) => (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0))[0];
  }

  /** Convierte una entidad de IG en una lista de elementos descargables. */
  function normalizarMediaInstagram(entidad) {
    if (!entidad || typeof entidad !== 'object') return null;

    const partes =
      Array.isArray(entidad.carousel_media) && entidad.carousel_media.length
        ? entidad.carousel_media
        : [entidad];

    const items = [];
    for (const parte of partes) {
      if (!parte || typeof parte !== 'object') continue;

      const videos = Array.isArray(parte.video_versions) ? parte.video_versions : [];
      const imagenes =
        parte.image_versions2 && Array.isArray(parte.image_versions2.candidates)
          ? parte.image_versions2.candidates
          : [];

      const mejorVideo = mejorPorTamano(videos);
      const mejorImagen = mejorPorTamano(imagenes);

      if (mejorVideo) {
        items.push({
          tipo: 'video',
          url: mejorVideo.url,
          ancho: Number(mejorVideo.width) || 0,
          alto: Number(mejorVideo.height) || 0,
          duracion: Number(parte.video_duration) || 0,
          poster: mejorImagen ? mejorImagen.url : ''
        });
      } else if (mejorImagen) {
        items.push({
          tipo: 'imagen',
          url: mejorImagen.url,
          ancho: Number(mejorImagen.width) || 0,
          alto: Number(mejorImagen.height) || 0
        });
      }
    }

    if (!items.length) return null;

    const usuario = String(
      (entidad.user && entidad.user.username) ||
        (entidad.owner && entidad.owner.username) ||
        (partes[0] && partes[0].user && partes[0].user.username) ||
        ''
    );

    return {
      code: String(entidad.code || entidad.shortcode || ''),
      id: String(entidad.pk || entidad.id || entidad.media_id || ''),
      usuario,
      tipo: items.length > 1 ? 'carrusel' : items[0].tipo,
      items
    };
  }

  /** Búsqueda acotada por forma, igual que en X pero con el predicado de IG. */
  function deepCollectInstagram(root, out, limits) {
    const maxDepth = (limits && limits.maxDepth) || 8;
    const maxSteps = (limits && limits.maxSteps) || 6000;
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

      if (pareceMediaDeInstagram(value)) {
        const media = normalizarMediaInstagram(value);
        if (media) out.push(media);
        continue;
      }

      for (const key of Object.keys(value)) {
        if (key === 'return' || key === 'child' || key === 'sibling' || key === '_owner') continue;
        const hijo = value[key];
        if (hijo && typeof hijo === 'object') queue.push({ value: hijo, depth: depth + 1 });
      }
    }
    return out;
  }

  function dedupeInstagram(lista) {
    const mapa = new Map();
    for (const media of lista) {
      if (!media || !media.items.length) continue;
      const clave = media.code || media.id || media.items.map((i) => i.url).join('|');
      const previo = mapa.get(clave);
      if (!previo || previo.items.length < media.items.length) mapa.set(clave, media);
    }
    return Array.from(mapa.values());
  }

  /** Recoge todo lo que se encuentre en la página (fibras, props y estados). */
  function collectInstagram() {
    const encontrados = [];

    // 1) Props de React y cadena de fibras de cada <article> y cada <video>/<img>.
    const anclas = [];
    try {
      document.querySelectorAll('article, main, video, img').forEach((el) => {
        if (anclas.length < 40) anclas.push(el);
      });
    } catch (_) {
      /* sin DOM */
    }

    for (const el of anclas) {
      const props = getReactProps(el);
      if (props) deepCollectInstagram(props, encontrados, { maxDepth: 8, maxSteps: 5000 });

      let fiber = getFiber(el);
      let saltos = 0;
      while (fiber && saltos < 30) {
        if (fiber.memoizedProps) deepCollectInstagram(fiber.memoizedProps, encontrados, { maxDepth: 6, maxSteps: 2000 });
        fiber = fiber.return;
        saltos++;
      }
    }

    // 2) Estados globales (IG usó _sharedData; el embed, __additionalData).
    for (const estado of [window._sharedData, window.__additionalData, window.__INITIAL_STATE__]) {
      if (estado) {
        try {
          deepCollectInstagram(estado, encontrados, { maxDepth: 9, maxSteps: 6000 });
        } catch (_) {
          /* estado no serializable */
        }
      }
    }

    return dedupeInstagram(encontrados);
  }

  /* =======================================================================
   * 2c. Facebook
   *
   * FB también es una SPA con React: los datos del reproductor viven en las
   * props y son invisibles desde el mundo aislado. Formas reconocidas:
   *   - Vídeo: playable_url_quality_hd / browser_native_hd_url (MP4 con audio),
   *     playable_url / browser_native_sd_url (versión ligera) y
   *     dash_manifest / video_dash_manifest (MPD con audio y vídeo SEPARADOS).
   *   - Foto: image1 / image / photo_image / currMedia.image con un `uri`.
   *
   * Las URLs van firmadas (oh= / oe=) y CADUCAN: se devuelven tal cual.
   * Se descartan las URLs con bytestart/byteend, que son trozos de un DASH.
   * ===================================================================== */

  function esUrlDeVideoFacebook(url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    if (/[?&](bytestart|byteend)=/i.test(url)) return false; // trozo, no archivo
    return /\.mp4(\?|$)/i.test(url) || /video[^/]*\.fbcdn\.net/i.test(url);
  }

  function esUrlDeFotoFacebook(url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    return /(scontent|instagram)[^/]*\.(fbcdn\.net|cdninstagram\.com)/i.test(url);
  }

  function imagenDeFacebook(obj) {
    for (const clave of ['preferred_thumbnail', 'thumbnailImage', 'image', 'image1', 'photo_image', 'viewer_image']) {
      const valor = obj[clave];
      if (!valor) continue;
      if (typeof valor === 'string' && esUrlDeFotoFacebook(valor)) return { url: valor, width: 0, height: 0 };
      if (typeof valor === 'object') {
        if (valor.image && typeof valor.image.uri === 'string') {
          return { url: valor.image.uri, width: valor.image.width, height: valor.image.height };
        }
        if (typeof valor.uri === 'string') return { url: valor.uri, width: valor.width, height: valor.height };
        if (typeof valor.url === 'string') return { url: valor.url, width: valor.width, height: valor.height };
      }
    }
    if (obj.currMedia && obj.currMedia.image && typeof obj.currMedia.image.uri === 'string') {
      const img = obj.currMedia.image;
      return { url: img.uri, width: img.width, height: img.height };
    }
    return null;
  }

  function pareceVideoDeFacebook(valor) {
    if (!valor || typeof valor !== 'object') return false;
    // Devuelve SIEMPRE booleano (una cadena no vacía es truthy pero no es true).
    const tiene = (c) => typeof valor[c] === 'string' && valor[c] !== '';
    return (
      tiene('playable_url_quality_hd') ||
      tiene('browser_native_hd_url') ||
      tiene('playable_url') ||
      tiene('browser_native_sd_url') ||
      tiene('video_dash_manifest') ||
      tiene('dash_manifest')
    );
  }

  function pareceFotoDeFacebook(valor) {
    if (!valor || typeof valor !== 'object') return false;
    if (pareceVideoDeFacebook(valor)) return false;
    const img = imagenDeFacebook(valor);
    return !!img && esUrlDeFotoFacebook(img.url);
  }

  function normalizarVideoFacebook(obj) {
    const candidatos = [];
    const añadir = (url, etiqueta, ancho, alto, bitrate) => {
      if (!esUrlDeVideoFacebook(url)) return;
      if (candidatos.some((c) => c.url === url)) return;
      candidatos.push({ url, etiqueta, ancho: Number(ancho) || 0, alto: Number(alto) || 0, bitrate: Number(bitrate) || 0 });
    };

    // Los nombres "hd" son MP4 con audio; los "sd" son la versión ligera.
    añadir(obj.playable_url_quality_hd, 'hd', obj.width, obj.height, obj.playable_url_quality_hd_bitrate);
    añadir(obj.browser_native_hd_url, 'hd', obj.width, obj.height);
    añadir(obj.playable_url, 'sd', obj.width, obj.height);
    añadir(obj.browser_native_sd_url, 'sd', obj.width, obj.height);

    // El DASH trae audio y vídeo por separado.
    const mpd = obj.video_dash_manifest || obj.dash_manifest || '';
    const poster = imagenDeFacebook(obj);

    if (!candidatos.length && !mpd) return null;

    // Las variantes con más píxeles primero; a igualdad, las "hd".
    candidatos.sort((a, b) => {
      const area = (c) => (c.ancho || 0) * (c.alto || 0);
      if (area(b) !== area(a)) return area(b) - area(a);
      if (a.etiqueta !== b.etiqueta) return a.etiqueta === 'hd' ? -1 : 1;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    return {
      tipo: 'video',
      id: String(obj.videoId || obj.video_id || obj.id || ''),
      usuario: String((obj.owner && (obj.owner.name || obj.owner.username)) || ''),
      ancho: Number(obj.width) || (candidatos[0] && candidatos[0].ancho) || 0,
      alto: Number(obj.height) || (candidatos[0] && candidatos[0].alto) || 0,
      duracion: Number(obj.playable_duration_in_ms || obj.duration_in_ms || 0),
      poster: poster ? poster.url : '',
      candidatos,
      // El MPD se analiza en el mundo aislado (facebook.js).
      mpd: typeof mpd === 'string' && mpd.indexOf('<MPD') !== -1 ? mpd.slice(0, 200000) : ''
    };
  }

  function normalizarFotoFacebook(obj) {
    const img = imagenDeFacebook(obj);
    if (!img || !esUrlDeFotoFacebook(img.url)) return null;
    return {
      tipo: 'imagen',
      id: String(obj.id || obj.photo_id || obj.pk || ''),
      usuario: String((obj.owner && (obj.owner.name || obj.owner.username)) || ''),
      ancho: Number(img.width) || 0,
      alto: Number(img.height) || 0,
      poster: '',
      candidatos: [{ url: img.url, etiqueta: 'original', ancho: Number(img.width) || 0, alto: Number(img.height) || 0 }],
      mpd: ''
    };
  }

  /** Búsqueda acotada por forma, con el predicado de Facebook. */
  function deepCollectFacebook(root, out, limits) {
    const maxDepth = (limits && limits.maxDepth) || 9;
    const maxSteps = (limits && limits.maxSteps) || 8000;
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

      if (pareceVideoDeFacebook(value)) {
        const media = normalizarVideoFacebook(value);
        if (media) {
          out.push(media);
          continue;
        }
      }

      if (pareceFotoDeFacebook(value)) {
        const media = normalizarFotoFacebook(value);
        if (media) {
          out.push(media);
          continue;
        }
      }

      for (const key of Object.keys(value)) {
        if (key === 'return' || key === 'child' || key === 'sibling' || key === '_owner') continue;
        const hijo = value[key];
        if (hijo && typeof hijo === 'object') queue.push({ value: hijo, depth: depth + 1 });
      }
    }
    return out;
  }

  function dedupeFacebook(lista) {
    const mapa = new Map();
    for (const media of lista) {
      if (!media || !media.candidatos.length) continue;
      const clave = media.id || media.candidatos[0].url;
      const previo = mapa.get(clave);
      if (!previo || previo.candidatos.length < media.candidatos.length) mapa.set(clave, media);
    }
    return Array.from(mapa.values());
  }

  /** Devuelve los medios de Facebook de la página (o los del id pedido). */
  function collectFacebook(objetivo) {
    const encontrados = [];

    const anclas = [];
    try {
      document.querySelectorAll('article, [role="article"], main, video, img').forEach((el) => {
        if (anclas.length < 40) anclas.push(el);
      });
    } catch (_) {
      /* sin DOM */
    }

    for (const el of anclas) {
      const props = getReactProps(el);
      if (props) deepCollectFacebook(props, encontrados, { maxDepth: 9, maxSteps: 6000 });

      let fiber = getFiber(el);
      let saltos = 0;
      while (fiber && saltos < 30) {
        if (fiber.memoizedProps) deepCollectFacebook(fiber.memoizedProps, encontrados, { maxDepth: 7, maxSteps: 3000 });
        fiber = fiber.return;
        saltos++;
      }
    }

    for (const estado of [window.__INITIAL_STATE__, window.__RELAY_STORE__, window.require]) {
      if (estado && typeof estado !== 'function') {
        try {
          deepCollectFacebook(estado, encontrados, { maxDepth: 10, maxSteps: 8000 });
        } catch (_) {
          /* estado no serializable */
        }
      }
    }

    const medios = dedupeFacebook(encontrados);
    if (!objetivo) return medios;
    const filtrados = medios.filter((m) => m.id === objetivo);
    return filtrados.length ? filtrados : medios;
  }

  /** Saneado de los medios de Facebook. */
  function sanitizeFacebook(media) {
    if (!media || !Array.isArray(media.candidatos)) return null;
    const candidatos = media.candidatos
      .filter((c) => c && allowedUrl(c.url))
      .slice(0, 12)
      .map((c) => ({
        url: c.url,
        etiqueta: String(c.etiqueta || ''),
        ancho: Number(c.ancho) || 0,
        alto: Number(c.alto) || 0,
        bitrate: Number(c.bitrate) || 0
      }));
    if (!candidatos.length) return null;
    return {
      tipo: media.tipo === 'imagen' ? 'imagen' : 'video',
      id: String(media.id || ''),
      usuario: String(media.usuario || ''),
      ancho: Number(media.ancho) || 0,
      alto: Number(media.alto) || 0,
      duracion: Number(media.duracion) || 0,
      poster: esUrlDeFotoFacebook(media.poster) ? media.poster : '',
      candidatos,
      mpd: typeof media.mpd === 'string' ? media.mpd : ''
    };
  }

  /* =======================================================================
   * 3. Saneado de la respuesta (defensa frente a mensajes falsificados)
   * ===================================================================== */

  function allowedUrl(url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    try {
      return hostPermitido(new URL(url).hostname);
    } catch (_) {
      return false;
    }
  }

  /** Saneado de los elementos de Instagram (URLs firmadas: se devuelven enteras). */
  function sanitizeInstagram(media) {
    if (!media || !Array.isArray(media.items)) return null;
    const items = media.items
      .filter((i) => i && (i.tipo === 'video' || i.tipo === 'imagen') && allowedUrl(i.url))
      .slice(0, 20)
      .map((i) => ({
        tipo: i.tipo,
        url: i.url,
        ancho: Number(i.ancho) || 0,
        alto: Number(i.alto) || 0,
        duracion: Number(i.duracion) || 0,
        poster: allowedUrl(i.poster) ? i.poster : ''
      }));
    if (!items.length) return null;
    return {
      code: String(media.code || ''),
      id: String(media.id || ''),
      usuario: String(media.usuario || ''),
      tipo: items.length > 1 ? 'carrusel' : items[0].tipo,
      items
    };
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

    // --- Instagram -------------------------------------------------------
    if (data.sitio === 'instagram') {
      let medios = [];
      try {
        const todos = collectInstagram();
        const code = String(data.code || '');
        const elegidos = code ? todos.filter((m) => m.code === code) : todos;
        medios = (elegidos.length ? elegidos : todos).map(sanitizeInstagram).filter(Boolean).slice(0, MAX_MEDIA);
      } catch (_) {
        medios = [];
      }
      try {
        window.postMessage({ [MARK]: true, kind: 'response', sitio: 'instagram', requestId, medios }, '*');
      } catch (_) {
        /* respuesta no clonable */
      }
      return;
    }

    // --- Facebook --------------------------------------------------------
    if (data.sitio === 'facebook') {
      let medios = [];
      try {
        medios = collectFacebook(String(data.objetivo || ''))
          .map(sanitizeFacebook)
          .filter(Boolean)
          .slice(0, MAX_MEDIA);
      } catch (_) {
        medios = [];
      }
      try {
        window.postMessage({ [MARK]: true, kind: 'response', sitio: 'facebook', requestId, medios }, '*');
      } catch (_) {
        /* respuesta no clonable */
      }
      return;
    }

    // --- X (Twitter) ------------------------------------------------------
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
      onMessage,
      // Instagram
      pareceMediaDeInstagram,
      normalizarMediaInstagram,
      sanitizeInstagram,
      hostPermitido,
      // Facebook
      pareceVideoDeFacebook,
      pareceFotoDeFacebook,
      normalizarVideoFacebook,
      normalizarFotoFacebook,
      deepCollectFacebook,
      dedupeFacebook,
      sanitizeFacebook,
      imagenDeFacebook
    };
  }
})();
