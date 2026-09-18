/**
 * Descargador de medios para X — Módulo de INSTAGRAM
 * ---------------------------------------------------------------------------
 * Se carga después de content.js y reutiliza su núcleo compartido
 * (window.__XVD_CORE__): ajustes, avisos, botones, descargas y diagnóstico.
 *
 * Qué añade respecto a X:
 *   - Publicaciones sueltas, carruseles (varias imágenes/vídeos) y Reels.
 *   - Las imágenes NO se reescriben: las URLs de IG van firmadas (oh=/oe=) y
 *     caducan, así que se usan tal cual vienen del CDN.
 *   - Para saber la resolución real y la URL buena se pregunta al puente del
 *     mundo MAIN (IG guarda los datos en props de React/Relay, invisibles desde
 *     el mundo aislado).
 *   - Solo audio: en IG el MP4 lleva el audio dentro, así que el MP3 se obtiene
 *     decodificando y recodificando (mismo camino que en X).
 *
 * Aviso de diseño: en IG no se puede distinguir una foto de perfil o una
 * miniatura de un medio publicable por la URL sola (todo va por el mismo CDN),
 * así que se filtra por tamaño renderizado y por el contenedor del artículo.
 */
(() => {
  'use strict';

  const core = window.__XVD_CORE__;
  if (!core || typeof core.registerScanner !== 'function') {
    console.warn('[XVD] instagram.js necesita que content.js se cargue antes.');
    return;
  }
  if (window.__XVD_INSTAGRAM_LOADED__) return;
  window.__XVD_INSTAGRAM_LOADED__ = true;

  const log = typeof core.log === 'function' ? core.log : () => {};
  const IMG_ATTR = core.IMAGE_ATTR;
  const BADGE_CLASS = core.BADGE_CLASS;

  /** Publicaciones ya vistas: se evita repetir trabajo. */
  const ultimoResumen = { texto: '' };

  /* =======================================================================
   * 1. Utilidades
   * ===================================================================== */

  function esUrlDeInstagram(url) {
    if (!url || typeof url !== 'string') return false;
    if (!/^https:\/\//i.test(url)) return false;
    return /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test((() => {
      try {
        return new URL(url).hostname;
      } catch (_) {
        return '';
      }
    })());
  }

  /** ¿Es una URL de imagen "grande" y no un avatar o miniatura? */
  function esImagenPublicable(url, elemento) {
    if (!esUrlDeInstagram(url)) return false;
    // Las miniaturas y avatares llevan estas marcas de tamaño en el CDN.
    if (/(s100x100|s150x150|s240x240|p240x240|s320x320|_s\d{2,3}x\d{2,3}_)/i.test(url)) return false;

    const rect = elemento.getBoundingClientRect ? elemento.getBoundingClientRect() : null;
    if (!rect) return true;
    return rect.width >= 150 && rect.height >= 150;
  }

  /** Código corto (shortcode) de la publicación a la que pertenece un elemento. */
  function codigoDePublicacion(elemento) {
    const contenedor = elemento.closest('article') || elemento.closest('main') || document;
    try {
      const enlace = contenedor.querySelector('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
      if (enlace) {
        const m = enlace.getAttribute('href').match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/);
        if (m) return m[1];
      }
      const propia = location.pathname.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/);
      if (propia) return propia[1];
    } catch (_) {
      /* sin contexto */
    }
    return '';
  }

  /** Usuario del autor, leído del enlace de perfil del artículo. */
  function usuarioDePublicacion(elemento) {
    const contenedor = elemento.closest('article') || elemento.closest('main') || document;
    try {
      const enlaces = contenedor.querySelectorAll('a[href^="/"]');
      for (const a of enlaces) {
        const m = a.getAttribute('href').match(/^\/([A-Za-z0-9._]{2,30})\/?$/);
        if (m && !['p', 'reel', 'tv', 'explore', 'accounts'].includes(m[1])) return m[1];
      }
    } catch (_) {
      /* sin contexto */
    }
    return '';
  }

  function contexto(elemento) {
    return {
      code: codigoDePublicacion(elemento),
      usuario: usuarioDePublicacion(elemento),
      fecha: new Date().toISOString().slice(0, 10)
    };
  }

  function sanear(texto) {
    return String(texto || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function nombreDeArchivo(media, contextoActual, indice, ext) {
    const cfg = core.getSettings();
    const partes = {
      usuario: contextoActual.usuario || 'instagram',
      id: contextoActual.code || media.id || 'post',
      fecha: contextoActual.fecha,
      indice: String(indice || 1),
      calidad: media.alto ? media.alto + 'p' : '',
      ext: ext
    };

    let plantilla = String(cfg.instagramFilenameTemplate || 'instagram_{usuario}_{id}_{indice}').trim();
    if (!plantilla) plantilla = 'instagram_{usuario}_{id}_{indice}';
    if (!/\{ext\}/.test(plantilla)) plantilla += '.{ext}';

    let nombre = plantilla.replace(/\{(\w+)\}/g, (m, clave) =>
      Object.prototype.hasOwnProperty.call(partes, clave) ? String(partes[clave]) : m
    );
    nombre = sanear(nombre);

    if (!nombre) nombre = 'instagram_' + Date.now() + '.' + ext;
    if (nombre.length > 150) {
      const punto = nombre.lastIndexOf('.');
      const sufijo = punto > 0 ? nombre.slice(punto) : '';
      nombre = nombre.slice(0, 150 - sufijo.length) + sufijo;
    }

    const carpeta = core.sanitizeFolder(cfg.folder);
    return carpeta ? carpeta + '/' + nombre : nombre;
  }

  /* =======================================================================
   * 2. Detección de medios en el DOM
   * ===================================================================== */

  function elementosDeMedio() {
    const encontrados = new Map();

    // Imágenes publicadas (se descartan avatares y miniaturas).
    document.querySelectorAll('img[src*="cdninstagram"], img[src*="fbcdn.net"]').forEach((img) => {
      const url = img.currentSrc || img.getAttribute('src') || '';
      if (!esImagenPublicable(url, img)) return;
      if (!img.closest('article') && !document.querySelector('main')) return;
      encontrados.set(img, { elemento: img, clase: 'imagen', url });
    });

    // Vídeos (Reels y vídeos del feed).
    document.querySelectorAll('video').forEach((video) => {
      const rect = video.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 150) return;
      const contenedor = video.closest('article') || video.closest('main');
      if (!contenedor) return;
      encontrados.set(video, { elemento: video, clase: 'video', url: '' });
    });

    return Array.from(encontrados.values());
  }

  /** ¿Cuántos medios tiene la publicación de este elemento? (para el contador) */
  function totalEnPublicacion(elemento) {
    const contenedor = elemento.closest('article') || elemento.closest('main');
    if (!contenedor) return { total: 1, indice: 0, contenedor };
    const medios = Array.from(contenedor.querySelectorAll('img, video')).filter((el) => {
      if (el.tagName === 'VIDEO') {
        const r = el.getBoundingClientRect();
        return r.width >= 150 && r.height >= 150;
      }
      return esImagenPublicable(el.currentSrc || el.getAttribute('src') || '', el);
    });
    const indice = medios.indexOf(elemento);
    return { total: medios.length, indice: indice >= 0 ? indice : 0, contenedor, medios };
  }

  function anfitrion(elemento) {
    let host = core.findOverlayHost(elemento);
    if (!host) {
      host = elemento.parentElement || elemento;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    }
    host.setAttribute(core.HOST_ATTR, '1');
    return host;
  }

  function dentroDelVisor(elemento) {
    return !!elemento.closest('[role="dialog"], [aria-modal="true"]');
  }

  /* =======================================================================
   * 3. Botones
   * ===================================================================== */

  function crearBotonDeMedio(dato, info) {
    const { elemento, clase } = dato;
    const host = anfitrion(elemento);

    const boton = core.createButton({
      label: 'Descargar',
      title: clase === 'video' ? 'Descargar el vídeo en la mejor calidad' : 'Descargar la imagen en su tamaño original',
      ariaLabel: 'Descargar de Instagram',
      icon: core.ICONS.download,
      className: 'xvd-button--image' + (dentroDelVisor(elemento) ? ' xvd-button--br' : ''),
      onClick: () => descargarMedio(dato, boton)
    });
    boton.dataset.xvdKind = 'instagram';
    boton.dataset.xvdSite = 'instagram';
    boton.__xvdElemento = elemento;
    boton.__xvdHost = host;

    host.appendChild(boton);
    elemento.__xvdInstagramButton = boton;

    if (clase === 'imagen') elemento.setAttribute(IMG_ATTR, '1');
    pintarContador(elemento, host, info);
    return boton;
  }

  function pintarContador(elemento, host, info) {
    const existente = elemento.__xvdBadge;
    if (!info || info.total < 2) {
      if (existente) existente.remove();
      return;
    }
    const etiqueta = info.indice + 1 + '/' + info.total;
    if (existente && existente.isConnected) {
      existente.textContent = etiqueta;
      return;
    }
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = etiqueta;
    badge.title = 'Elemento ' + (info.indice + 1) + ' de ' + info.total;
    host.appendChild(badge);
    elemento.__xvdBadge = badge;
  }

  function limpiarOverlaysInstagram() {
    document
      .querySelectorAll('.' + core.BUTTON_CLASS + '[data-xvd-site="instagram"]')
      .forEach((n) => n.remove());
    document.querySelectorAll('.' + BADGE_CLASS).forEach((n) => n.remove());
    document.querySelectorAll('[' + IMG_ATTR + ']').forEach((n) => n.removeAttribute(IMG_ATTR));
  }

  /* =======================================================================
   * 4. Escaneo
   * ===================================================================== */

  function scanInstagram() {
    const cfg = core.getSettings();
    if (!cfg.enabled || !cfg.instagramEnabled) {
      limpiarOverlaysInstagram();
      return;
    }

    // Botones cuyo elemento ya no está en el documento.
    document.querySelectorAll('.' + core.BUTTON_CLASS + '[data-xvd-site="instagram"]').forEach((boton) => {
      const objetivo = boton.__xvdElemento;
      if (!objetivo || !objetivo.isConnected || !boton.isConnected) boton.remove();
    });

    const medios = elementosDeMedio();
    let conBoton = 0;

    for (const dato of medios) {
      try {
        const info = totalEnPublicacion(dato.elemento);
        const existente = dato.elemento.__xvdInstagramButton;
        if (existente && existente.isConnected) {
          pintarContador(dato.elemento, existente.__xvdHost || dato.elemento.parentElement, info);
          conBoton++;
          continue;
        }
        crearBotonDeMedio(dato, info);
        conBoton++;
      } catch (_) {
        /* un medio problemático no debe romper el resto */
      }
    }

    const resumen = medios.length + '/' + conBoton;
    if (resumen !== ultimoResumen.texto) {
      ultimoResumen.texto = resumen;
      log('info', 'instagram', 'Barrido del DOM', {
        medios: medios.length,
        conBoton,
        videos: medios.filter((m) => m.clase === 'video').length,
        url: location.pathname
      });
    }
  }

  /* =======================================================================
   * 5. Descarga
   * ===================================================================== */

  /** Pide al puente los datos de la publicación y elige el medio que toca. */
  async function resolverMedio(dato) {
    const { elemento, clase, url } = dato;
    const ctx = contexto(elemento);
    const info = totalEnPublicacion(elemento);

    log('info', 'instagram', 'Resolviendo medio', {
      tipo: clase,
      code: ctx.code || '(sin código)',
      usuario: ctx.usuario || '(sin usuario)',
      posicion: info.indice + 1 + '/' + info.total
    });

    let medios = [];
    if (ctx.code) {
      medios = await core.requestInstagramMedia(ctx.code, 4000);
    }
    if (!medios.length) {
      // Sin datos del puente: se usa lo que se ve (útil en imágenes).
      medios = await core.requestInstagramMedia('', 2500);
    }

    const publicacion = medios.find((m) => m.code === ctx.code) || medios[0] || null;

    if (publicacion && publicacion.items.length) {
      log('info', 'instagram', 'Datos del puente para la publicación', {
        code: publicacion.code,
        tipo: publicacion.tipo,
        elementos: publicacion.items.length,
        calidades: publicacion.items.map((i) => i.tipo + ' ' + i.ancho + 'x' + i.alto)
      });

      // Para carruseles se usa la posición del elemento en el DOM.
      if (publicacion.items.length > 1) {
        return { media: publicacion.items[Math.min(info.indice, publicacion.items.length - 1)], publicacion, ctx };
      }
      // Para un vídeo, se prefiere el elemento de vídeo aunque el DOM apunte a la imagen.
      const video = publicacion.items.find((i) => i.tipo === 'video');
      if (clase === 'video' && video) return { media: video, publicacion, ctx };
      return { media: publicacion.items[0], publicacion, ctx };
    }

    // Sin datos del puente: solo se puede usar la URL tal cual (nunca un blob).
    if (clase === 'imagen' && esUrlDeInstagram(url)) {
      log('warn', 'instagram', 'Sin datos de la publicación: se usa la imagen tal como se ve');
      return {
        media: { tipo: 'imagen', url, ancho: 0, alto: 0 },
        publicacion: null,
        ctx
      };
    }

    throw new Error(
      'No se pudieron leer los datos de esta publicación de Instagram. Dale a reproducir, espera un segundo y reinténtalo.'
    );
  }

  async function descargarMedio(dato, boton) {
    core.setButtonState(boton, 'loading', 'Preparando…');
    try {
      const cfg = core.getSettings();
      const { media, publicacion, ctx } = await resolverMedio(dato);
      const esVideo = media.tipo === 'video';
      const quiereAudio = esVideo && (cfg.format === 'm4a' || cfg.format === 'mp3');

      if (esVideo && quiereAudio) {
        await descargarAudioDeInstagram(media, ctx, boton, cfg.format);
        return;
      }

      const ext = esVideo ? 'mp4' : extensionDeImagen(media.url);
      const nombre = nombreDeArchivo(media, ctx, totalEnPublicacion(dato.elemento).indice + 1, ext);

      const respuesta = await core.requestDownload({
        url: media.url,
        filename: nombre,
        label: nombre,
        // El CDN de Instagram a veces exige cookies o referer y rechaza la
        // descarga directa: en ese caso se bajan los bytes desde la propia
        // página (que sí las tiene) y se guardan por el camino del offscreen.
        onInterrupted: async (motivo) => {
          log('warn', 'instagram', 'La descarga directa falló: se reintenta desde la página', { motivo });
          try {
            const bytes = await core.fetchBytes(media.url);
            const guardado = await core.guardarBytes(
              bytes,
              esVideo ? 'video/mp4' : 'image/jpeg',
              nombre,
              !!cfg.askWhereToSave
            );
            if (guardado && guardado.ok) {
              log('info', 'instagram', 'Descarga rescatada desde la página', {
                archivo: nombre,
                kb: Math.round(bytes.length / 1024)
              });
              core.toast('Descarga iniciada (por la página): ' + nombre, 'success', 4500);
              return guardado.downloadId;
            }
            throw new Error(guardado && guardado.error ? guardado.error : 'sin respuesta del guardado');
          } catch (err) {
            log('error', 'instagram', 'Tampoco se pudo bajar desde la página', { mensaje: core.errorMessage(err) });
            return null;
          }
        }
      });

      log('info', 'instagram', 'Descarga solicitada', {
        tipo: media.tipo,
        archivo: nombre,
        resolucion: media.ancho ? media.ancho + 'x' + media.alto : '(según el CDN)',
        id: respuesta.downloadId
      });
      core.setButtonState(boton, 'done', 'Descargada');
      core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
    } catch (err) {
      log('error', 'instagram', 'Fallo al descargar el medio', { mensaje: core.errorMessage(err) });
      core.setButtonState(boton, 'error', 'Error');
      core.toast(core.errorMessage(err), 'error', 8000);
    }
  }

  function extensionDeImagen(url) {
    const m = String(url).match(/\.(jpe?g|png|webp|heic)(?:\?|$)/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }

  /**
   * Solo audio en Instagram: el MP4 de IG lleva el audio dentro, así que se
   * descarga, se decodifica y se recodifica a MP3 (o se avisa si se pidió M4A).
   */
  async function descargarAudioDeInstagram(media, ctx, boton, formato) {
    const cfg = core.getSettings();
    const progress = core.toast('Preparando el audio del vídeo…', 'info', 120000);
    const update = (mensaje) => {
      if (!progress) return;
      const nodo = progress.querySelector('.xvd-toast__msg');
      if (nodo) nodo.textContent = mensaje;
    };

    try {
      if (formato === 'm4a') {
        // Sin pista de audio suelta en IG: avisar y ofrecer el MP4 completo.
        if (cfg.audioFallback !== 'mp4') {
          throw new Error(
            'Instagram no publica la pista de audio por separado en este vídeo. Elige MP3 (se convierte aquí) o MP4.'
          );
        }
        if (progress) progress.remove();
        core.toast('Instagram no separa el audio: se descargará el vídeo MP4 (contiene el audio).', 'warn', 7000);
        const nombre = nombreDeArchivo(media, ctx, 1, 'mp4');
        const respuesta = await core.requestDownload({ url: media.url, filename: nombre, label: nombre });
        core.setButtonState(boton, 'done', 'MP4');
        core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
        log('info', 'instagram', 'Audio M4A no disponible: se descarga el MP4', { id: respuesta.downloadId });
        return;
      }

      update('Descargando el vídeo para extraer el audio…');
      const bytes = await core.fetchBytes(media.url);

      const convertido = await core.convertirMp3(bytes, 128, update);
      const nombre = nombreDeArchivo(media, ctx, 1, 'mp3');

      update('Guardando el archivo…');
      const respuesta = await core.guardarBytes(convertido.bytes, 'audio/mpeg', nombre, !!cfg.askWhereToSave);
      if (!respuesta || !respuesta.ok) {
        throw new Error(respuesta && respuesta.error ? respuesta.error : 'No se pudo guardar el MP3.');
      }

      if (progress) progress.remove();
      core.setButtonState(boton, 'done', 'MP3');
      core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
      log('info', 'instagram', 'Audio extraído a MP3', {
        archivo: nombre,
        kb: Math.round(convertido.bytes.length / 1024),
        segundos: Math.round(convertido.duracion * 10) / 10,
        id: respuesta.downloadId
      });
    } catch (err) {
      if (progress) progress.remove();
      log('error', 'instagram', 'Fallo al extraer el audio', { mensaje: core.errorMessage(err) });
      core.setButtonState(boton, 'error', 'Sin audio');
      core.toast(core.errorMessage(err), 'error', 8000);
    }
  }

  /* =======================================================================
   * 6. Registro en el núcleo
   * ===================================================================== */

  // Solo se activa en instagram.com (el content script también corre en X).
  if (/(^|\.)instagram\.com$/i.test(location.hostname)) {
    core.registerScanner(scanInstagram);
    core.registerDisableHook((cfg) => {
      if (!cfg.instagramEnabled) limpiarOverlaysInstagram();
    });
    log('info', 'instagram', 'Módulo de Instagram activo', { url: location.pathname });
  }
})();
