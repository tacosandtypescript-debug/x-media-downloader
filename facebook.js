/**
 * Descargador de medios para X — Módulo de FACEBOOK
 * ---------------------------------------------------------------------------
 * Reutiliza el núcleo compartido (window.__XVD_CORE__) igual que el de X y el de
 * Instagram: ajustes, avisos, botones, descargas y registro de diagnóstico.
 *
 * Particularidades de Facebook:
 *   - Los vídeos se sirven en MP4 progresivo con audio (playable_url_quality_hd)
 *     o en DASH (audio y vídeo SEPARADOS). El MP4 "hd" suele ser 720p; para más
 *     resolución haría falta unir las dos pistas del DASH, que no se puede hacer
 *     sin un muxer, así que se entrega la mejor pista CON audio y se avisa.
 *   - Ventaja: el DASH sí trae una pista de audio suelta, así que el M4A aquí es
 *     real (sin recomprimir), a diferencia de Instagram.
 *   - Las URLs van firmadas (oh= / oe=) y caducan, así que se usan tal cual.
 *   - Respaldo público: las páginas de vídeo traen <meta property="og:video"> con
 *     un MP4 directo (normalmente 360p). Sirve cuando los datos no aparecen.
 */
(() => {
  'use strict';

  const core = window.__XVD_CORE__;
  if (!core || typeof core.registerScanner !== 'function') {
    console.warn('[XVD] facebook.js necesita que content.js se cargue antes.');
    return;
  }
  if (window.__XVD_FACEBOOK_LOADED__) return;
  window.__XVD_FACEBOOK_LOADED__ = true;

  const log = typeof core.log === 'function' ? core.log : () => {};
  const IMG_ATTR = core.IMAGE_ATTR;
  const BADGE_CLASS = core.BADGE_CLASS;

  const ultimoResumen = { texto: '' };

  /* =======================================================================
   * 1. Utilidades
   * ===================================================================== */

  function esUrlDeFacebook(url) {
    if (!url || typeof url !== 'string') return false;
    if (!/^https:\/\//i.test(url)) return false;
    try {
      return /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(new URL(url).hostname);
    } catch (_) {
      return false;
    }
  }

  /** Descarta avatares y miniaturas por sus marcas de tamaño del CDN. */
  function esImagenPublicable(url, elemento) {
    if (!esUrlDeFacebook(url)) return false;
    if (/(s60x60|s100x100|s150x150|p40x40|p50x50|p60x60|p75x75|p100x100|cp0|_s\d{2,3}x\d{2,3}_)/i.test(url)) return false;
    const rect = elemento.getBoundingClientRect ? elemento.getBoundingClientRect() : null;
    if (!rect) return true;
    return rect.width >= 150 && rect.height >= 150;
  }

  /** Identificador del vídeo, buscando en el meta og:url y en los enlaces. */
  function idDeVideo(elemento) {
    const mirar = (texto) => {
      if (!texto) return '';
      let m = texto.match(/\/reel\/(\d{6,})/);
      if (m) return m[1];
      m = texto.match(/[?&]v=(\d{6,})/);
      if (m) return m[1];
      m = texto.match(/\/videos\/(?:[^/]+\/)?(\d{6,})/);
      if (m) return m[1];
      m = texto.match(/\/videos\/(\d{6,})/);
      return m ? m[1] : '';
    };

    try {
      const og = document.querySelector('meta[property="og:url"]');
      const desdeOg = mirar(og ? og.getAttribute('content') : '');
      if (desdeOg) return desdeOg;

      const desdeUrl = mirar(location.href);
      if (desdeUrl) return desdeUrl;

      const contenedor = elemento.closest('[role="article"], article, main') || document;
      for (const a of contenedor.querySelectorAll('a[href*="/reel/"], a[href*="/videos/"], a[href*="v="]')) {
        const encontrado = mirar(a.getAttribute('href'));
        if (encontrado) return encontrado;
      }
    } catch (_) {
      /* sin contexto */
    }
    return '';
  }

  function usuarioDePublicacion(elemento) {
    const contenedor = elemento.closest('[role="article"], article, main') || document;
    try {
      for (const a of contenedor.querySelectorAll('a[href^="/"]')) {
        const m = a.getAttribute('href').match(/^\/([A-Za-z0-9.]{3,40})\/?$/);
        if (m && !['reel', 'watch', 'videos', 'photo', 'share', 'groups', 'marketplace'].includes(m[1])) return m[1];
      }
    } catch (_) {
      /* sin contexto */
    }
    return '';
  }

  function contexto(elemento) {
    return {
      id: idDeVideo(elemento),
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

  function nombreDeArchivo(media, ctx, indice, ext) {
    const cfg = core.getSettings();
    const partes = {
      usuario: ctx.usuario || 'facebook',
      id: ctx.id || media.id || 'video',
      fecha: ctx.fecha,
      indice: String(indice || 1),
      calidad: media.alto ? media.alto + 'p' : '',
      ext: ext
    };

    let plantilla = String(cfg.facebookFilenameTemplate || 'facebook_{usuario}_{id}_{indice}').trim();
    if (!plantilla) plantilla = 'facebook_{usuario}_{id}_{indice}';
    if (!/\{ext\}/.test(plantilla)) plantilla += '.{ext}';

    let nombre = plantilla.replace(/\{(\w+)\}/g, (m, clave) =>
      Object.prototype.hasOwnProperty.call(partes, clave) ? String(partes[clave]) : m
    );
    nombre = sanear(nombre);
    if (!nombre) nombre = 'facebook_' + Date.now() + '.' + ext;
    if (nombre.length > 150) {
      const punto = nombre.lastIndexOf('.');
      const sufijo = punto > 0 ? nombre.slice(punto) : '';
      nombre = nombre.slice(0, 150 - sufijo.length) + sufijo;
    }

    const carpeta = core.sanitizeFolder(cfg.folder);
    return carpeta ? carpeta + '/' + nombre : nombre;
  }

  /* =======================================================================
   * 2. Análisis del manifiesto DASH (para el audio suelto)
   * ===================================================================== */

  /**
   * ¿Es una representación de audio o de vídeo?
   * OJO: en DASH el `mimeType` suele estar en el <AdaptationSet>, no en la
   * <Representation>, así que hay que heredarlo; y si no, deducirlo del códec.
   */
  function tipoDeRepresentacion(mime, codecs) {
    const m = String(mime || '').toLowerCase();
    const c = String(codecs || '').toLowerCase();
    if (m.indexOf('audio') !== -1) return 'audio';
    if (m.indexOf('video') !== -1) return 'video';
    if (/mp4a|opus|ac-3|ec-3|vorbis/.test(c)) return 'audio';
    if (/avc1|avc3|hvc1|hev1|vp0?9|av01|mp4v/.test(c)) return 'video';
    return '';
  }

  function desescaparXml(texto) {
    return String(texto || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  function ordenarRepresentaciones(salida) {
    salida.audio.sort((a, b) => b.bandwidth - a.bandwidth);
    salida.video.sort((a, b) => b.ancho * b.alto - a.ancho * a.alto || b.bandwidth - a.bandwidth);
    return salida;
  }

  /**
   * Respaldo por expresión regular: algunos manifiestos reales traen un `&` sin
   * escapar (XML inválido) y entonces DOMParser devuelve las BaseURL vacías.
   */
  function representacionesPorRegex(mpd) {
    const salida = { audio: [], video: [] };
    const bloques = mpd.match(/<Representation[\s\S]*?<\/Representation>/g) || [];

    for (const bloque of bloques) {
      const inicio = mpd.indexOf(bloque);
      const antes = mpd.slice(0, inicio);

      let mime = (bloque.match(/mimeType="([^"]+)"/) || [])[1] || '';
      if (!mime) {
        // Heredado del <AdaptationSet> que lo contiene.
        const conjuntos = antes.match(/<AdaptationSet[^>]*>/g) || [];
        if (conjuntos.length) mime = (conjuntos[conjuntos.length - 1].match(/mimeType="([^"]+)"/) || [])[1] || '';
      }
      const codecs = (bloque.match(/codecs="([^"]+)"/) || [])[1] || '';
      const tipo = tipoDeRepresentacion(mime, codecs);
      if (!tipo) continue;

      const ancho = Number((bloque.match(/width="(\d+)"/) || [])[1]) || 0;
      const alto = Number((bloque.match(/height="(\d+)"/) || [])[1]) || 0;
      const bandwidth = Number((bloque.match(/bandwidth="(\d+)"/) || [])[1]) || 0;

      let base = (bloque.match(/<BaseURL>([\s\S]*?)<\/BaseURL>/) || [])[1] || '';
      if (!base) {
        const previas = antes.match(/<BaseURL>[\s\S]*?<\/BaseURL>/g) || [];
        if (previas.length) base = previas[previas.length - 1].replace(/<\/?BaseURL>/g, '');
      }
      base = desescaparXml(base);
      if (!base) continue;

      const entrada = { url: base, bandwidth, mime: mime || tipo };
      if (tipo === 'audio') salida.audio.push(entrada);
      else salida.video.push({ ...entrada, ancho, alto });
    }

    return ordenarRepresentaciones(salida);
  }

  function representacionesDelMpd(mpd) {
    const salida = { audio: [], video: [] };
    if (!mpd || mpd.indexOf('<MPD') === -1) return salida;

    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(mpd, 'application/xml');
        const hayError = doc.getElementsByTagName('parsererror').length > 0;
        const reps = hayError ? [] : Array.from(doc.getElementsByTagName('Representation'));

        for (const rep of reps) {
          const conjunto = rep.parentElement;
          const mimePropio = rep.getAttribute('mimeType') || '';
          const mimeHeredado = conjunto ? conjunto.getAttribute('mimeType') || '' : '';
          const codecs = rep.getAttribute('codecs') || (conjunto ? conjunto.getAttribute('codecs') || '' : '');
          const tipo = tipoDeRepresentacion(mimePropio || mimeHeredado, codecs);
          if (!tipo) continue;

          const ancho = Number(rep.getAttribute('width')) || 0;
          const alto = Number(rep.getAttribute('height')) || 0;
          const bandwidth = Number(rep.getAttribute('bandwidth')) || 0;

          // La dirección del archivo: BaseURL propia o la del AdaptationSet.
          let base = '';
          const propiaBase = rep.getElementsByTagName('BaseURL')[0];
          if (propiaBase && propiaBase.textContent) {
            base = propiaBase.textContent;
          } else if (conjunto) {
            const baseConjunto = conjunto.getElementsByTagName('BaseURL')[0];
            if (baseConjunto && baseConjunto.textContent) base = baseConjunto.textContent;
          }
          base = desescaparXml(base);
          if (!base) continue;

          const entrada = { url: base, bandwidth, mime: mimePropio || mimeHeredado || tipo };
          if (tipo === 'audio') salida.audio.push(entrada);
          else salida.video.push({ ...entrada, ancho, alto });
        }
      } catch (_) {
        /* se intenta por expresión regular */
      }
    }

    if (!salida.audio.length && !salida.video.length) {
      return representacionesPorRegex(mpd);
    }

    return ordenarRepresentaciones(salida);
  }

  /** Respaldo público: el MP4 que Facebook publica en og:video. */
  function candidatoDeOgVideo() {
    try {
      const og = document.querySelector('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]');
      const url = og ? og.getAttribute('content') : '';
      if (!esUrlDeFacebook(url)) return null;
      const ancho = Number((document.querySelector('meta[property="og:video:width"]') || {}).content) || 0;
      const alto = Number((document.querySelector('meta[property="og:video:height"]') || {}).content) || 0;
      const poster = (document.querySelector('meta[property="og:image"]') || {}).content || '';
      return {
        tipo: 'video',
        id: idDeVideo(document.body),
        usuario: '',
        ancho,
        alto,
        duracion: 0,
        poster: esUrlDeFacebook(poster) ? poster : '',
        candidatos: [{ url, etiqueta: 'og:video (público)', ancho, alto, bitrate: 0 }],
        mpd: ''
      };
    } catch (_) {
      return null;
    }
  }

  /* =======================================================================
   * 3. Detección en el DOM
   * ===================================================================== */

  function elementosDeMedio() {
    const encontrados = new Map();

    document.querySelectorAll('video').forEach((video) => {
      const rect = video.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 150) return;
      if (!video.closest('[role="article"], article, main')) return;
      encontrados.set(video, { elemento: video, clase: 'video' });
    });

    document.querySelectorAll('img[src*="fbcdn.net"], img[src*="cdninstagram"]').forEach((img) => {
      const url = img.currentSrc || img.getAttribute('src') || '';
      if (!esImagenPublicable(url, img)) return;
      if (!img.closest('[role="article"], article, main')) return;
      encontrados.set(img, { elemento: img, clase: 'imagen', url });
    });

    return Array.from(encontrados.values());
  }

  function totalEnPublicacion(elemento) {
    const contenedor = elemento.closest('[role="article"], article, main');
    if (!contenedor) return { total: 1, indice: 0, contenedor };
    const medios = Array.from(contenedor.querySelectorAll('video, img')).filter((el) => {
      if (el.tagName === 'VIDEO') {
        const r = el.getBoundingClientRect();
        return r.width >= 150 && r.height >= 150;
      }
      return esImagenPublicable(el.currentSrc || el.getAttribute('src') || '', el);
    });
    const indice = medios.indexOf(elemento);
    return { total: medios.length, indice: indice >= 0 ? indice : 0, contenedor };
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
   * 4. Botones y escaneo
   * ===================================================================== */

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
    host.appendChild(badge);
    elemento.__xvdBadge = badge;
  }

  function crearBoton(dato, info) {
    const { elemento, clase } = dato;
    const host = anfitrion(elemento);
    const boton = core.createButton({
      label: 'Descargar',
      title: clase === 'video' ? 'Descargar el vídeo en la mejor calidad con audio' : 'Descargar la foto a tamaño completo',
      ariaLabel: 'Descargar de Facebook',
      icon: core.ICONS.download,
      className: 'xvd-button--image' + (dentroDelVisor(elemento) ? ' xvd-button--br' : ''),
      onClick: () => descargarMedio(dato, boton)
    });
    boton.dataset.xvdKind = 'facebook';
    boton.dataset.xvdSite = 'facebook';
    boton.__xvdElemento = elemento;
    boton.__xvdHost = host;

    host.appendChild(boton);
    elemento.__xvdFacebookButton = boton;
    if (clase === 'imagen') elemento.setAttribute(IMG_ATTR, '1');
    pintarContador(elemento, host, info);
  }

  function limpiarOverlaysFacebook() {
    document.querySelectorAll('.' + core.BUTTON_CLASS + '[data-xvd-site="facebook"]').forEach((n) => n.remove());
    document.querySelectorAll('.' + BADGE_CLASS).forEach((n) => n.remove());
    document.querySelectorAll('[' + IMG_ATTR + ']').forEach((n) => n.removeAttribute(IMG_ATTR));
  }

  function scanFacebook() {
    const cfg = core.getSettings();
    if (!cfg.enabled || !cfg.facebookEnabled) {
      limpiarOverlaysFacebook();
      return;
    }

    document.querySelectorAll('.' + core.BUTTON_CLASS + '[data-xvd-site="facebook"]').forEach((boton) => {
      const objetivo = boton.__xvdElemento;
      if (!objetivo || !objetivo.isConnected || !boton.isConnected) boton.remove();
    });

    const medios = elementosDeMedio();
    let conBoton = 0;

    for (const dato of medios) {
      try {
        const info = totalEnPublicacion(dato.elemento);
        const existente = dato.elemento.__xvdFacebookButton;
        if (existente && existente.isConnected) {
          pintarContador(dato.elemento, existente.__xvdHost || dato.elemento.parentElement, info);
          conBoton++;
          continue;
        }
        crearBoton(dato, info);
        conBoton++;
      } catch (_) {
        /* un medio problemático no debe romper el resto */
      }
    }

    const resumen = medios.length + '/' + conBoton;
    if (resumen !== ultimoResumen.texto) {
      ultimoResumen.texto = resumen;
      log('info', 'facebook', 'Barrido del DOM', {
        medios: medios.length,
        conBoton,
        videos: medios.filter((m) => m.clase === 'video').length,
        url: location.pathname
      });
    }
  }

  /* =======================================================================
   * 5. Resolución y descarga
   * ===================================================================== */

  async function resolverMedio(dato) {
    const { elemento, clase, url } = dato;
    const ctx = contexto(elemento);

    log('info', 'facebook', 'Resolviendo medio', {
      tipo: clase,
      idVideo: ctx.id || '(sin id)',
      usuario: ctx.usuario || '(sin usuario)'
    });

    const medios = await core.requestFacebookMedia(ctx.id, 4000);
    // Se filtra por tipo: si se pulsa una foto no puede acabarse bajando el vídeo
    // (el og:url de la página puede apuntar al vídeo aunque el medio sea una foto).
    const delTipo = medios.filter((m) => (clase === 'imagen' ? m.tipo === 'imagen' : m.tipo === 'video'));
    const publicacion = delTipo.find((m) => m.id && m.id === ctx.id) || delTipo[0] || null;

    if (publicacion && publicacion.tipo === 'imagen') {
      log('info', 'facebook', 'Foto encontrada', {
        id: publicacion.id,
        resolucion: publicacion.ancho + 'x' + publicacion.alto,
        candidatos: publicacion.candidatos.length
      });
      return { media: publicacion, ctx };
    }

    if (publicacion && publicacion.candidatos.length) {
      log('info', 'facebook', 'Datos del vídeo encontrados', {
        id: publicacion.id,
        resolucion: publicacion.ancho + 'x' + publicacion.alto,
        candidatos: publicacion.candidatos.map((c) => c.etiqueta + ' ' + (c.ancho ? c.ancho + 'x' + c.alto : '¿?')),
        dash: publicacion.mpd ? 'sí' : 'no'
      });
      return { media: publicacion, ctx };
    }

    // Respaldo 1: una URL directa en el propio <video> (algunas vistas la usan).
    if (clase === 'video') {
      const directa = elemento.currentSrc || elemento.getAttribute('src') || '';
      if (esUrlDeFacebook(directa) && /\.mp4/i.test(directa)) {
        log('warn', 'facebook', 'Sin datos de la página: se usa el src directo del reproductor');
        return {
          media: {
            tipo: 'video',
            id: ctx.id,
            ancho: 0,
            alto: 0,
            poster: elemento.getAttribute('poster') || '',
            candidatos: [{ url: directa, etiqueta: 'src del reproductor', ancho: 0, alto: 0, bitrate: 0 }],
            mpd: ''
          },
          ctx
        };
      }
    }

    // Respaldo 2: el MP4 público de og:video.
    if (clase === 'video') {
      const og = candidatoDeOgVideo();
      if (og) {
        log('warn', 'facebook', 'Sin datos internos: se usa el MP4 público de og:video', {
          resolucion: og.ancho + 'x' + og.alto
        });
        core.toast('Se usará la versión pública de Facebook (calidad menor).', 'warn', 6000);
        return { media: og, ctx };
      }
    }

    // Respaldo 3: la imagen tal cual se ve.
    if (clase === 'imagen' && esUrlDeFacebook(url)) {
      log('warn', 'facebook', 'Sin datos de la foto: se usa la imagen tal como se ve');
      return {
        media: {
          tipo: 'imagen',
          id: '',
          ancho: 0,
          alto: 0,
          poster: '',
          candidatos: [{ url, etiqueta: 'visible', ancho: 0, alto: 0, bitrate: 0 }],
          mpd: ''
        },
        ctx
      };
    }

    throw new Error(
      'No se pudieron leer los datos de este vídeo de Facebook. Dale a reproducir, espera un segundo y reinténtalo.'
    );
  }

  async function descargarMedio(dato, boton) {
    core.setButtonState(boton, 'loading', 'Preparando…');
    try {
      const cfg = core.getSettings();
      const { media, ctx } = await resolverMedio(dato);
      const esVideo = media.tipo === 'video';
      const indice = totalEnPublicacion(dato.elemento).indice + 1;

      if (esVideo && (cfg.format === 'm4a' || cfg.format === 'mp3')) {
        await descargarAudioDeFacebook(media, ctx, boton, cfg.format);
        return;
      }

      const elegido = media.candidatos[0];
      const ext = esVideo ? 'mp4' : extensionDeImagen(elegido.url);
      const nombre = nombreDeArchivo({ ...media, alto: elegido.alto || media.alto }, ctx, indice, ext);

      const respuesta = await core.requestDownload({
        url: elegido.url,
        filename: nombre,
        label: nombre,
        // Si el CDN exige cookies o referer, se rescata desde la página.
        onInterrupted: async (motivo) => {
          log('warn', 'facebook', 'La descarga directa falló: se reintenta desde la página', { motivo });
          try {
            const bytes = await core.fetchBytes(elegido.url);
            const guardado = await core.guardarBytes(
              bytes,
              esVideo ? 'video/mp4' : 'image/jpeg',
              nombre,
              !!cfg.askWhereToSave
            );
            if (guardado && guardado.ok) {
              log('info', 'facebook', 'Descarga rescatada desde la página', {
                archivo: nombre,
                kb: Math.round(bytes.length / 1024)
              });
              core.toast('Descarga iniciada (por la página): ' + nombre, 'success', 4500);
              return guardado.downloadId;
            }
            throw new Error(guardado && guardado.error ? guardado.error : 'sin respuesta del guardado');
          } catch (err) {
            log('error', 'facebook', 'Tampoco se pudo bajar desde la página', { mensaje: core.errorMessage(err) });
            return null;
          }
        }
      });

      log('info', 'facebook', 'Descarga solicitada', {
        tipo: media.tipo,
        via: elegido.etiqueta,
        archivo: nombre,
        resolucion: elegido.ancho ? elegido.ancho + 'x' + elegido.alto : '(según el CDN)',
        id: respuesta.downloadId
      });
      core.setButtonState(boton, 'done', 'Descargada');
      core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
    } catch (err) {
      log('error', 'facebook', 'Fallo al descargar el medio', { mensaje: core.errorMessage(err) });
      core.setButtonState(boton, 'error', 'Error');
      core.toast(core.errorMessage(err), 'error', 8000);
    }
  }

  function extensionDeImagen(url) {
    const m = String(url).match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }

  /**
   * Solo audio en Facebook.
   *   - M4A: el manifiesto DASH trae una pista de audio suelta -> se descarga
   *     tal cual, sin recomprimir.
   *   - MP3: se decodifica (da igual la fuente) y se recodifica con lamejs.
   */
  async function descargarAudioDeFacebook(media, ctx, boton, formato) {
    const cfg = core.getSettings();
    const progress = core.toast('Preparando el audio…', 'info', 120000);
    const update = (mensaje) => {
      if (!progress) return;
      const nodo = progress.querySelector('.xvd-toast__msg');
      if (nodo) nodo.textContent = mensaje;
    };

    try {
      const mpd = representacionesDelMpd(media.mpd);
      if (mpd.video.length) {
        log('info', 'facebook', 'El manifiesto DASH trae vídeo aparte (resoluciones disponibles)', {
          video: mpd.video.slice(0, 4).map((v) => v.ancho + 'x' + v.alto),
          audio: mpd.audio.slice(0, 3).map((a) => Math.round(a.bandwidth / 1000) + ' kbps')
        });
      }

      // --- M4A: pista de audio suelta del DASH -----------------------------
      if (formato === 'm4a') {
        const audio = mpd.audio[0];
        if (audio && esUrlDeFacebook(audio.url)) {
          const nombre = nombreDeArchivo({ ...media, alto: 0 }, ctx, 1, 'm4a');
          update('Descargando la pista de audio…');
          const respuesta = await core.requestDownload({
            url: audio.url,
            filename: nombre,
            label: nombre,
            onInterrupted: null
          });
          if (progress) progress.remove();
          core.setButtonState(boton, 'done', 'M4A');
          core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
          log('info', 'facebook', 'Pista de audio del DASH descargada (sin recomprimir)', {
            archivo: nombre,
            kbps: Math.round(audio.bandwidth / 1000),
            id: respuesta.downloadId
          });
          return;
        }

        if (cfg.audioFallback !== 'mp4') {
          throw new Error(
            'Este vídeo de Facebook no publica la pista de audio por separado. Elige MP3 (se convierte aquí) o MP4.'
          );
        }
        if (progress) progress.remove();
        core.toast('Facebook no separa el audio en este vídeo: se descarga el MP4 (contiene el audio).', 'warn', 7000);
        const nombre = nombreDeArchivo(media, ctx, 1, 'mp4');
        const respuesta = await core.requestDownload({
          url: media.candidatos[0].url,
          filename: nombre,
          label: nombre
        });
        core.setButtonState(boton, 'done', 'MP4');
        core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
        log('info', 'facebook', 'Audio M4A no disponible: se descarga el MP4', { id: respuesta.downloadId });
        return;
      }

      // --- MP3: se baja el mejor audio (DASH si lo hay) y se recodifica -----
      const fuente = (mpd.audio[0] && esUrlDeFacebook(mpd.audio[0].url) ? mpd.audio[0].url : '') || media.candidatos[0].url;
      update('Descargando el audio para convertirlo…');
      const bytes = await core.fetchBytes(fuente);
      const convertido = await core.convertirMp3(bytes, 128, update);
      const nombre = nombreDeArchivo({ ...media, alto: 0 }, ctx, 1, 'mp3');

      update('Guardando el archivo…');
      const respuesta = await core.guardarBytes(convertido.bytes, 'audio/mpeg', nombre, !!cfg.askWhereToSave);
      if (!respuesta || !respuesta.ok) {
        throw new Error(respuesta && respuesta.error ? respuesta.error : 'No se pudo guardar el MP3.');
      }

      if (progress) progress.remove();
      core.setButtonState(boton, 'done', 'MP3');
      core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
      log('info', 'facebook', 'Audio convertido a MP3', {
        archivo: nombre,
        kb: Math.round(convertido.bytes.length / 1024),
        segundos: Math.round(convertido.duracion * 10) / 10,
        fuente: mpd.audio[0] ? 'pista DASH' : 'MP4 con audio',
        id: respuesta.downloadId
      });
    } catch (err) {
      if (progress) progress.remove();
      log('error', 'facebook', 'Fallo al extraer el audio', { mensaje: core.errorMessage(err) });
      core.setButtonState(boton, 'error', 'Sin audio');
      core.toast(core.errorMessage(err), 'error', 8000);
    }
  }

  /* =======================================================================
   * 6. Registro en el núcleo
   * ===================================================================== */

  if (/(^|\.)facebook\.com$/i.test(location.hostname) || /(^|\.)fb\.watch$/i.test(location.hostname)) {
    core.registerScanner(scanFacebook);
    core.registerDisableHook((cfg) => {
      if (!cfg.facebookEnabled) limpiarOverlaysFacebook();
    });
    log('info', 'facebook', 'Módulo de Facebook activo', { url: location.pathname });
  }
})();
