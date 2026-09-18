/**
 * Descargador de medios para X — Módulo de IMÁGENES
 * ---------------------------------------------------------------------------
 * Se carga después de content.js y reutiliza su núcleo compartido
 * (window.__XVD_CORE__): ajustes, avisos, mensajería, botones y observadores.
 *
 * Responsabilidades:
 *   1. Detectar imágenes de tweets: sueltas, galerías de 2 a 4, citas,
 *      respuestas, tarjetas de enlace (card_img) y el visor ampliado.
 *   2. Inyectar un botón "Descargar" sobre cada imagen y, en galerías, un
 *      contador (1/4, 2/4…) y un botón "Descargar todas".
 *   3. Reescribir la URL de pbs.twimg.com para pedir la máxima resolución
 *      cambiando el parámetro name= (orig, 4096x4096, large, medium) y el
 *      formato de salida mediante format= (jpg | png | webp).
 *   4. Degradar la resolución automáticamente si orig no está disponible.
 *   5. Deduplicar URLs para no descargar dos veces la misma imagen.
 */
(() => {
  'use strict';

  const core = window.__XVD_CORE__;
  if (!core || typeof core.registerScanner !== 'function') {
    console.warn('[XVD] images.js necesita que content.js se cargue antes.');
    return;
  }
  if (window.__XVD_IMAGES_LOADED__) return;
  window.__XVD_IMAGES_LOADED__ = true;

  const BUTTON_CLASS = core.BUTTON_CLASS;
  const BADGE_CLASS = core.BADGE_CLASS;
  const HOST_ATTR = core.HOST_ATTR;
  const IMAGE_ATTR = core.IMAGE_ATTR;

  /** Resoluciones admitidas por el CDN de X, de mayor a menor. */
  const RESOLUTION_CHAINS = {
    orig: ['orig', '4096x4096', 'large', 'medium'],
    '4096x4096': ['4096x4096', 'large', 'medium'],
    large: ['large', 'medium'],
    medium: ['medium']
  };

  const RESOLUTION_LABELS = {
    orig: 'original',
    '4096x4096': '4096×4096',
    large: 'grande',
    medium: 'media'
  };

  /** Caché de comprobaciones de disponibilidad: url -> { ok, ts } */
  const probeCache = new Map();
  const PROBE_TTL = 5 * 60 * 1000;

  /** Ventana antiduplicados: clave -> timestamp */
  const recentDownloads = new Map();
  const DEDUPE_WINDOW = 8000;

  /** Imágenes ya observadas con ResizeObserver */
  const observedImages = new WeakSet();

  /* =======================================================================
   * 1. URLs de imágenes de X
   * ===================================================================== */

  const IMAGE_HOST_RE = /^https?:\/\/pbs\.twimg\.com\//i;
  const IMAGE_PATH_RE = /\/(media|card_img)\//i;
  const VIDEO_THUMB_RE = /\/(amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//i;
  const FORMAT_EXTENSIONS = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };

  /**
   * ¿Es una imagen publicada en un tweet? Se excluyen avatares, cabeceras,
   * emojis y las miniaturas de video (esas las cubre el módulo de video).
   */
  function isTweetImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!IMAGE_HOST_RE.test(url)) return false;
    if (VIDEO_THUMB_RE.test(url)) return false;
    return IMAGE_PATH_RE.test(url);
  }

  /** Descompone la URL: base, formato efectivo y tamaño solicitado. */
  function parseImageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
      const url = new URL(rawUrl);
      const format = (url.searchParams.get('format') || '').toLowerCase();
      const name = (url.searchParams.get('name') || '').toLowerCase();
      let effective = FORMAT_EXTENSIONS[format] || '';
      if (!effective) {
        const pathMatch = url.pathname.match(/\.(jpe?g|png|webp|gif)$/i);
        if (pathMatch) effective = FORMAT_EXTENSIONS[pathMatch[1].toLowerCase()] || '';
      }
      return {
        url: rawUrl,
        origin: url.origin,
        pathname: url.pathname,
        format: effective || 'jpg',
        formatParam: format,
        name,
        hasFormatParam: url.searchParams.has('format')
      };
    } catch (_) {
      return null;
    }
  }

  /** Clave de deduplicación: la ruta identifica la imagen, sin importar el tamaño. */
  function mediaKey(rawUrl) {
    const parsed = parseImageUrl(rawUrl);
    return parsed ? parsed.pathname : String(rawUrl || '').split('?')[0];
  }

  /** Reescribe la URL pidiendo otra resolución y/o formato al CDN. */
  function buildImageUrl(rawUrl, resolution, format) {
    const parsed = parseImageUrl(rawUrl);
    if (!parsed) return null;
    try {
      const url = new URL(rawUrl);
      if (resolution) url.searchParams.set('name', resolution);
      if (format && format !== 'auto') url.searchParams.set('format', format);
      return url.toString();
    } catch (_) {
      return null;
    }
  }

  /** Cadena de respaldo para la resolución configurada. */
  function resolutionChain(configured) {
    return RESOLUTION_CHAINS[configured] || RESOLUTION_CHAINS.orig;
  }

  /** Extensión final del archivo según la configuración de formato. */
  function extensionFor(rawUrl, formatSetting) {
    if (formatSetting && formatSetting !== 'auto') {
      return FORMAT_EXTENSIONS[formatSetting] || 'jpg';
    }
    const parsed = parseImageUrl(rawUrl);
    return (parsed && parsed.format) || 'jpg';
  }

  /** Formato original de la imagen (antes de cualquier conversión). */
  function detectFormat(rawUrl, formatSetting) {
    if (formatSetting && formatSetting !== 'auto') return FORMAT_EXTENSIONS[formatSetting] || 'jpg';
    const parsed = parseImageUrl(rawUrl);
    return (parsed && parsed.format) || 'jpg';
  }

  /* =======================================================================
   * 2. Plan de descarga (resolución + formato + respaldos)
   * ===================================================================== */

  /**
   * Construye la lista ordenada de candidatos (máxima resolución primero) y los
   * avisos que debe ver el usuario.
   */
  function planImageDownload(rawUrl, config) {
    const cfg = config || core.getSettings();
    const parsed = parseImageUrl(rawUrl);
    if (!parsed || !isTweetImageUrl(rawUrl)) {
      return { error: 'La URL de la imagen no es válida o no pertenece a X.' };
    }

    const resolution = cfg.imageResolution || 'orig';
    const format = cfg.imageFormat || 'auto';
    const chain = cfg.imageFallback === false ? [resolution] : resolutionChain(resolution);
    const notices = [];

    const originalFormat = parsed.format;
    const finalFormat = detectFormat(rawUrl, format);

    if (originalFormat === 'gif' && finalFormat !== 'gif') {
      notices.push(
        'Es un GIF animado: al convertirlo a ' +
          finalFormat.toUpperCase() +
          ' se perderá la animación. Si el tweet lo publica como video, usa el botón del reproductor.'
      );
    } else if (originalFormat === 'gif') {
      notices.push(
        'Es un GIF animado: se descargará como .gif. Si el tweet lo publica como video, usa el botón «Descargar» del reproductor.'
      );
    }

    if (format === 'png' && originalFormat !== 'png') {
      notices.push('La conversión a PNG puede aumentar mucho el tamaño del archivo.');
    }

    const ordered = chain
      .map((name) => ({
        resolution: name,
        url: buildImageUrl(rawUrl, name, format),
        ext: extensionFor(rawUrl, format)
      }))
      .filter((candidate) => !!candidate.url);

    if (!ordered.length) return { error: 'No se pudo construir la URL de descarga de la imagen.' };

    return {
      ordered,
      resolution,
      format: finalFormat,
      notice: notices.join(' ') || null,
      error: null
    };
  }

  /** Comprueba que la resolución pedida existe realmente en el CDN. */
  function probeImage(url, timeoutMs) {
    const cached = probeCache.get(url);
    if (cached && Date.now() - cached.ts < PROBE_TTL) return Promise.resolve(cached.ok);

    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        probeCache.set(url, { ok, ts: Date.now() });
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs || 7000);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    });
  }

  /** Devuelve el primer candidato disponible, degradando si hace falta. */
  async function pickAvailableCandidate(candidates) {
    for (let i = 0; i < candidates.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await probeImage(candidates[i].url);
      if (ok) return { candidate: candidates[i], index: i };
    }
    return null;
  }

  /* =======================================================================
   * 3. Nombre de archivo
   * ===================================================================== */

  function buildImageFilename(rawUrl, context, index, total, resolution, config) {
    const cfg = config || core.getSettings();
    const ext = extensionFor(rawUrl, cfg.imageFormat);
    const parts = {
      id: context.tweetId || 'tweet',
      tweet: context.tweetId || 'tweet',
      usuario: context.screenName || 'x',
      fecha: context.date,
      indice: String(index || 1),
      total: String(total || 1),
      resolucion: resolution || cfg.imageResolution || 'orig',
      formato: ext,
      ext
    };

    let template = String(cfg.imageFilenameTemplate || 'tweet_{id}_img{indice}').trim();
    if (!template) template = 'tweet_{id}_img{indice}';
    if (!/\{ext\}/.test(template) && !/\{formato\}/.test(template)) template += '.{ext}';

    let name = template.replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(parts, key) ? String(parts[key]) : match
    );

    name = name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '');

    if (!name) name = 'imagen_' + Date.now() + '.' + ext;
    if (name.length > 150) {
      const dot = name.lastIndexOf('.');
      const suffix = dot > 0 ? name.slice(dot) : '';
      name = name.slice(0, 150 - suffix.length) + suffix;
    }

    const folder = core.sanitizeFolder(cfg.folder);
    return folder ? folder + '/' + name : name;
  }

  /* =======================================================================
   * 4. Detección en el DOM
   * ===================================================================== */

  function extractBackgroundUrl(style) {
    if (!style) return '';
    const match = String(style).match(/url\((["']?)(https?:\/\/[^"')]+)\1\)/i);
    return match ? match[2] : '';
  }

  /** Obtiene la imagen real dentro de un nodo (etiqueta <img> o background). */
  function extractImageCandidate(node) {
    if (!node || node.nodeType !== 1) return null;

    if (node.tagName === 'IMG') {
      const url = node.currentSrc || node.getAttribute('src') || '';
      return isTweetImageUrl(url) ? { element: node, url, kind: 'img' } : null;
    }

    // El propio nodo puede llevar la imagen como fondo (tarjetas de enlace).
    const ownUrl = extractBackgroundUrl(node.getAttribute && node.getAttribute('style'));
    if (isTweetImageUrl(ownUrl)) return { element: node, url: ownUrl, kind: 'background' };

    const img = node.querySelector(
      'img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/card_img"]'
    );
    if (img) {
      const url = img.currentSrc || img.getAttribute('src') || '';
      if (isTweetImageUrl(url)) return { element: img, url, kind: 'img' };
    }

    const styled = node.querySelector('[style*="pbs.twimg.com/card_img"]');
    if (styled) {
      const url = extractBackgroundUrl(styled.getAttribute('style'));
      if (isTweetImageUrl(url)) return { element: styled, url, kind: 'background' };
    }

    return null;
  }

  function readElementUrl(element) {
    if (!element) return '';
    if (element.tagName === 'IMG') return element.currentSrc || element.getAttribute('src') || '';
    const img = element.querySelector && element.querySelector('img');
    if (img) return img.currentSrc || img.getAttribute('src') || '';
    return extractBackgroundUrl(element.getAttribute && element.getAttribute('style'));
  }

  /**
   * Calcula la galería a la que pertenece una imagen: contenedor común, celdas
   * y posición. Se detiene en el <article> del tweet y nunca agrupa más de 4
   * celdas (el máximo que publica X).
   */
  function galleryInfo(element) {
    const cell = element.closest('[data-testid="tweetPhoto"]') || element;
    let node = cell.parentElement;
    let best = { container: cell.parentElement || cell, cells: [cell] };

    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      if (node.matches('article')) break;
      const cells = Array.from(node.querySelectorAll('[data-testid="tweetPhoto"]'));
      if (cells.length > 4) break;
      if (cells.length > best.cells.length) best = { container: node, cells };
      node = node.parentElement;
    }

    const usable = best.cells.filter((c) => !!extractImageCandidate(c));
    const index = usable.indexOf(cell);
    return {
      container: best.container,
      cells: usable.length ? usable : [cell],
      index: index >= 0 ? index : 0,
      total: usable.length || 1
    };
  }

  function isTooSmall(element) {
    const rect = element.getBoundingClientRect();
    return rect.width < 80 || rect.height < 60;
  }

  function observeSize(element, retry) {
    if (observedImages.has(element) || typeof ResizeObserver === 'undefined') return;
    observedImages.add(element);
    const observer = new ResizeObserver(() => {
      if (!element.isConnected) {
        observer.disconnect();
        return;
      }
      if (!isTooSmall(element)) {
        observer.disconnect();
        retry();
      }
    });
    observer.observe(element);
  }

  function ensureHost(node) {
    let host = core.findOverlayHost(node);
    if (!host) {
      host = node;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    }
    host.setAttribute(HOST_ATTR, '1');
    return host;
  }

  function isInLightbox(element) {
    return !!element.closest('[role="dialog"], [aria-modal="true"], [data-testid="swipeToDismiss"]');
  }

  /* =======================================================================
   * 5. Inyección de botones y contadores
   * ===================================================================== */

  function ensureImageButton(element, gallery) {
    const existing = element.__xvdImageButton;

    if (existing && existing.isConnected) {
      // El contador y las variantes de estilo pueden cambiar mientras X termina
      // de cargar la galería o el usuario toca los ajustes.
      existing.classList.toggle('xvd-button--compact', !!core.getSettings().compactImageButton);
      existing.classList.toggle('xvd-button--br', isInLightbox(element));
      updateBadge(element, existing.__xvdHost || element.parentElement, gallery);
      return existing;
    }

    const host = ensureHost(element);
    const button = core.createButton({
      label: 'Descargar',
      title: 'Descargar imagen en la máxima resolución disponible',
      ariaLabel: 'Descargar imagen',
      icon: core.ICONS.download,
      className:
        'xvd-button--image' +
        (isInLightbox(element) ? ' xvd-button--br' : '') +
        (core.getSettings().compactImageButton ? ' xvd-button--compact' : ''),
      onClick: () => handleImageClick(element, button)
    });
    button.dataset.xvdKind = 'image';
    button.__xvdImageElement = element;
    button.__xvdHost = host;

    host.appendChild(button);
    element.__xvdImageButton = button;
    element.setAttribute(IMAGE_ATTR, '1');
    updateBadge(element, host, gallery);
    return button;
  }

  function updateBadge(element, host, gallery) {
    const existing = element.__xvdBadge;
    if (!gallery || gallery.total < 2) {
      if (existing) existing.remove();
      return;
    }
    const label = gallery.index + 1 + '/' + gallery.total;
    if (existing && existing.isConnected) {
      existing.textContent = label;
      return;
    }
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = label;
    badge.title = 'Imagen ' + (gallery.index + 1) + ' de ' + gallery.total;
    host.appendChild(badge);
    element.__xvdBadge = badge;
  }

  function ensureGalleryButton(gallery) {
    const cfg = core.getSettings();
    const container = gallery.container;
    const existing = container.__xvdGalleryButton;

    if (!cfg.galleryButton || gallery.total < 2) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.isConnected) {
      const label = 'Descargar todas (' + gallery.total + ')';
      existing.dataset.label = label;
      existing.__xvdGalleryCells = gallery.cells.slice();
      if (existing.dataset.state === 'idle') {
        const text = existing.querySelector('.xvd-button__label');
        if (text) text.textContent = label;
      }
      return;
    }

    const host = ensureHost(container);
    const button = core.createButton({
      label: 'Descargar todas (' + gallery.total + ')',
      title: 'Descargar las ' + gallery.total + ' imágenes de este tweet',
      ariaLabel: 'Descargar todas las imágenes del tweet',
      icon: core.ICONS.images,
      // En el visor ampliado el botón individual va abajo a la derecha, así que
      // el de la galería se coloca abajo a la izquierda para no solaparse.
      className: isInLightbox(container) ? 'xvd-button--gallery xvd-button--bl' : 'xvd-button--gallery',
      onClick: () => handleGalleryClick(container, button)
    });
    button.dataset.xvdKind = 'gallery';
    button.__xvdGalleryContainer = container;
    button.__xvdGalleryCells = gallery.cells.slice();

    host.appendChild(button);
    container.__xvdGalleryButton = button;
  }

  function cleanupImageOverlays() {
    document
      .querySelectorAll('.' + BUTTON_CLASS + '[data-xvd-kind="image"], .' + BUTTON_CLASS + '[data-xvd-kind="gallery"]')
      .forEach((node) => node.remove());
    document.querySelectorAll('.' + BADGE_CLASS).forEach((node) => node.remove());
    document.querySelectorAll('[' + IMAGE_ATTR + ']').forEach((node) => node.removeAttribute(IMAGE_ATTR));
  }

  /* =======================================================================
   * 6. Escaneo
   * ===================================================================== */

  const IMAGE_SELECTOR = [
    'img[src*="pbs.twimg.com/media"]',
    'img[src*="pbs.twimg.com/card_img"]',
    '[style*="pbs.twimg.com/card_img"]',
    '[data-testid="tweetPhoto"]'
  ].join(', ');

  function scanImages() {
    const cfg = core.getSettings();
    if (!cfg.enabled || !cfg.imagesEnabled) {
      cleanupImageOverlays();
      return;
    }

    // Botones cuyo elemento ya no está en el documento.
    document
      .querySelectorAll('.' + BUTTON_CLASS + '[data-xvd-kind="image"]')
      .forEach((button) => {
        const target = button.__xvdImageElement;
        if (!target || !target.isConnected || !button.isConnected) button.remove();
      });
    document
      .querySelectorAll('.' + BUTTON_CLASS + '[data-xvd-kind="gallery"]')
      .forEach((button) => {
        const target = button.__xvdGalleryContainer;
        if (!target || !target.isConnected || !button.isConnected) button.remove();
      });

    const candidates = new Map();
    document.querySelectorAll(IMAGE_SELECTOR).forEach((node) => {
      const found = extractImageCandidate(node);
      if (found && found.element.isConnected) candidates.set(found.element, found);
    });

    const galleries = new Map();

    for (const { element } of candidates.values()) {
      try {
        if (isTooSmall(element)) {
          observeSize(element, () => scanImages());
          continue;
        }
        const gallery = galleryInfo(element);
        ensureImageButton(element, gallery);
        if (gallery.total >= 2) galleries.set(gallery.container, gallery);
      } catch (_) {
        /* una imagen problemática no debe romper el resto */
      }
    }

    for (const gallery of galleries.values()) {
      try {
        ensureGalleryButton(gallery);
      } catch (_) {
        /* idem */
      }
    }
  }

  /* =======================================================================
   * 7. Descarga
   * ===================================================================== */

  function dedupeKey(url, cfg) {
    return mediaKey(url) + '|' + (cfg.imageResolution || 'orig') + '|' + (cfg.imageFormat || 'auto');
  }

  function isRecentDuplicate(key) {
    const ts = recentDownloads.get(key);
    return !!ts && Date.now() - ts < DEDUPE_WINDOW;
  }

  /**
   * Descarga una imagen: planifica los candidatos, comprueba disponibilidad,
   * pide la descarga al service worker y deja preparado el respaldo de
   * resolución para el caso de que Chrome interrumpa la descarga.
   */
  async function downloadImage(rawUrl, options) {
    const cfg = core.getSettings();
    const plan = planImageDownload(rawUrl, cfg);
    if (plan.error) throw new Error(plan.error);
    if (plan.notice && !options.silentNotice) core.toast(plan.notice, 'warn', 7000);

    const key = dedupeKey(rawUrl, cfg);
    if (isRecentDuplicate(key) && !options.allowDuplicate) {
      return { duplicate: true };
    }

    let candidates = plan.ordered;
    let degradedIndex = 0;

    if (cfg.imageVerify !== false && candidates.length > 1) {
      const picked = await pickAvailableCandidate(candidates);
      if (!picked) {
        throw new Error('No se pudo descargar la imagen: ninguna resolución está disponible.');
      }
      degradedIndex = picked.index;
      candidates = candidates.slice(picked.index);
      if (degradedIndex > 0) {
        core.toast('No se pudo descargar en resolución máxima, usando resolución alternativa.', 'warn', 6000);
      }
    }

    const state = {
      rawUrl,
      candidates,
      cursor: 0,
      context: options.context,
      index: options.index,
      total: options.total
    };

    const filename = buildImageFilename(
      rawUrl,
      options.context,
      options.index,
      options.total,
      candidates[0].resolution
    );

    const response = await core.requestDownload({
      url: candidates[0].url,
      filename,
      label: filename,
      onInterrupted: (reason) => retryWithNextResolution(state, reason)
    });

    recentDownloads.set(key, Date.now());
    return { filename, resolution: candidates[0].resolution, degraded: degradedIndex > 0, response };
  }

  /** Respaldo de resolución si Chrome interrumpe la descarga. */
  async function retryWithNextResolution(state, reason) {
    const cfg = core.getSettings();
    if (cfg.imageFallback === false) return null;

    const next = state.cursor + 1;
    if (next >= state.candidates.length) return null;

    const candidate = state.candidates[next];
    const label = RESOLUTION_LABELS[candidate.resolution] || candidate.resolution;
    core.toast(
      'No se pudo descargar en resolución máxima, usando resolución alternativa (' + label + ').',
      'warn',
      6000
    );

    const filename = buildImageFilename(
      state.rawUrl,
      state.context,
      state.index,
      state.total,
      candidate.resolution
    );

    try {
      const response = await core.requestDownload({
        url: candidate.url,
        filename,
        label: filename,
        onInterrupted: (nextReason) => retryWithNextResolution({ ...state, cursor: next }, nextReason)
      });
      recentDownloads.set(dedupeKey(state.rawUrl, cfg), Date.now());
      return response.downloadId;
    } catch (err) {
      core.toast('Tampoco se pudo descargar la resolución alternativa: ' + core.errorMessage(err), 'error', 7000);
      return null;
    }
  }

  async function handleImageClick(element, button) {
    core.setButtonState(button, 'loading', 'Preparando…');
    try {
      const url = readElementUrl(element);
      if (!isTweetImageUrl(url)) throw new Error('No se pudo obtener la imagen en la máxima resolución.');

      const gallery = galleryInfo(element);
      const context = core.getTweetContext(element);
      const result = await downloadImage(url, {
        context,
        index: gallery.index + 1,
        total: gallery.total
      });

      if (result && result.duplicate) {
        core.setButtonState(button, 'done', 'Ya descargada');
        return;
      }

      core.setButtonState(button, 'done', result.degraded ? 'Descargada (alt.)' : 'Descargada');
      core.toast('Descarga iniciada: ' + result.filename, 'success', 4000);
    } catch (err) {
      core.setButtonState(button, 'error', 'Error');
      core.toast(core.errorMessage(err), 'error', 7000);
    }
  }

  /** Descarga secuencial de todas las imágenes de la galería. */
  async function handleGalleryClick(container, button) {
    const cfg = core.getSettings();
    if (!cfg.imagesEnabled) return;

    core.setButtonState(button, 'loading', 'Preparando…');
    try {
      // Se usan las celdas detectadas al pintar el botón (ya filtradas); si la
      // galería cambió, se recalculan desde la primera celda viva.
      let cells = Array.isArray(button.__xvdGalleryCells) ? button.__xvdGalleryCells : [];
      cells = cells.filter((cell) => cell && cell.isConnected);
      if (!cells.length) {
        const fresh = galleryInfo(container);
        cells = fresh.cells;
        button.__xvdGalleryCells = cells.slice();
      }

      const items = [];
      const seen = new Set();

      for (const cell of cells) {
        const candidate = extractImageCandidate(cell);
        if (!candidate) continue;
        const key = mediaKey(candidate.url);
        if (seen.has(key)) continue; // deduplicación dentro del lote
        seen.add(key);
        items.push(candidate);
      }

      if (items.length < 1) throw new Error('No se encontraron imágenes en esta galería.');

      const context = core.getTweetContext(container);
      let started = 0;
      let failed = 0;
      let duplicates = 0;

      for (let i = 0; i < items.length; i++) {
        core.setButtonState(button, 'loading', 'Descargando ' + (i + 1) + '/' + items.length + '…');
        try {
          const result = await downloadImage(items[i].url, {
            context,
            index: i + 1,
            total: items.length,
            silentNotice: i > 0
          });
          if (result && result.duplicate) duplicates++;
          else started++;
        } catch (err) {
          failed++;
          core.toast('Imagen ' + (i + 1) + ': ' + core.errorMessage(err), 'error', 6000);
        }
        // Descarga secuencial: se deja respirar al gestor de descargas.
        await core.sleep(350);
      }

      if (failed === 0 && duplicates === 0) {
        core.setButtonState(button, 'done', started + ' descargadas');
        core.toast(
          started + (started === 1 ? ' imagen: descarga iniciada' : ' imágenes: descargas iniciadas'),
          'success',
          4500
        );
      } else if (failed === 0) {
        core.setButtonState(button, 'done', started + ' nuevas');
        core.toast(started + ' imágenes iniciadas, ' + duplicates + ' ya estaban en curso.', 'info', 5000);
      } else {
        core.setButtonState(button, 'error', failed + ' fallos');
        core.toast(
          started + ' imágenes iniciadas y ' + failed + ' con error. Revisa los avisos anteriores.',
          'warn',
          7000
        );
      }
    } catch (err) {
      core.setButtonState(button, 'error', 'Error');
      core.toast(core.errorMessage(err), 'error', 7000);
    }
  }

  /* =======================================================================
   * 8. Registro en el núcleo
   * ===================================================================== */

  core.registerScanner(scanImages);
  core.registerDisableHook((cfg) => {
    if (!cfg.imagesEnabled) cleanupImageOverlays();
  });

  /* -----------------------------------------------------------------------
   * Punto de enganche para las pruebas automatizadas (tools/test.js).
   * En el navegador `module` no existe, así que esta rama nunca se ejecuta.
   * --------------------------------------------------------------------- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      RESOLUTION_CHAINS,
      isTweetImageUrl,
      parseImageUrl,
      buildImageUrl,
      resolutionChain,
      extensionFor,
      detectFormat,
      mediaKey,
      extractBackgroundUrl,
      planImageDownload,
      buildImageFilename
    };
  }
})();
