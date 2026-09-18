/**
 * Descargador de medios para X — Módulo de YOUTUBE
 * ---------------------------------------------------------------------------
 * Reutiliza el núcleo compartido (window.__XVD_CORE__) como los módulos de X,
 * Instagram y Facebook, pero la descarga NO la hace la extensión: se la pide al
 * host de mensajería nativa (native/ytdlp-host.exe), que ejecuta yt-dlp.
 *
 * Por qué así, y no descargando aquí:
 *   Comprobado contra YouTube real (septiembre de 2026): el reproductor web ya no
 *   recibe URLs de archivo. Usa SABR (`serverAbrStreamingUrl`, con respuestas
 *   `application/vnd.yt-ump`) y los formatos adaptativos llegan SIN `url` y SIN
 *   `signatureCipher`; el único progresivo (itag 18) llega cifrado. Reutilizar
 *   las URLs que pide el reproductor no sirve (responden `sabr.malformed` o 403),
 *   y los clientes de Innertube (ANDROID/IOS/WEB) contestan 400 o UNPLAYABLE
 *   porque exigen versión de cliente y po_token actuales. Descifrar firmas e
 *   implementar UMP/SABR dentro de una extensión es reescribir yt-dlp... así que
 *   se usa yt-dlp, que ya está en el equipo y se actualiza solo.
 *
 * Este módulo, por tanto, solo: detecta el reproductor, pone el botón, recoge los
 * ajustes (formato, calidad, carpeta, plantilla) y cuenta el progreso.
 */
(() => {
  'use strict';

  const core = window.__XVD_CORE__;
  if (!core || typeof core.registerScanner !== 'function') {
    console.warn('[XVD] youtube.js necesita que content.js se cargue antes.');
    return;
  }
  if (window.__XVD_YOUTUBE_LOADED__) return;
  window.__XVD_YOUTUBE_LOADED__ = true;

  const log = typeof core.log === 'function' ? core.log : () => {};
  const ultimoResumen = { texto: '' };
  let descargasEnCurso = 0;

  /* =======================================================================
   * 1. Utilidades de la página
   * ===================================================================== */

  function jugador() {
    return (
      document.querySelector('#movie_player') ||
      document.querySelector('#shorts-player') ||
      document.querySelector('.html5-video-player') ||
      null
    );
  }

  function videoDelJugador(contenedor) {
    if (!contenedor) return null;
    return contenedor.querySelector('video.html5-main-video') || contenedor.querySelector('video');
  }

  function esShorts() {
    return /^\/shorts\//.test(location.pathname);
  }

  /** Id del vídeo según la URL (página normal, Shorts o incrustado). */
  function idEnLaUrl() {
    try {
      const porParametro = new URLSearchParams(location.search).get('v');
      if (porParametro) return porParametro;
      const corto = location.pathname.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
      if (corto) return corto[1];
      const incrustado = location.pathname.match(/\/embed\/([A-Za-z0-9_-]{6,})/);
      return incrustado ? incrustado[1] : '';
    } catch (_) {
      return '';
    }
  }

  /** URL canónica del vídeo, sin listas ni parámetros de seguimiento. */
  function urlDelVideo() {
    const id = idEnLaUrl();
    if (id) return 'https://www.youtube.com/watch?v=' + id;
    return location.origin + location.pathname;
  }

  /**
   * Convierte la plantilla de nombre de la extensión en una de yt-dlp.
   * Nuestras variables: {usuario} {titulo} {id} {fecha} {indice} {calidad} {ext}
   *
   * Ojo con el saneado: los campos de yt-dlp tienen sintaxis propia
   * (`%(upload_date>%Y-%m-%d)s`), así que solo se limpia el texto LITERAL; los
   * campos se dejan intactos. Si se limpiara todo, el `>` de la fecha se
   * convertiría en `_` y yt-dlp no entendería el nombre.
   */
  function plantillaParaYtDlp(plantilla) {
    const equivalencias = {
      usuario: '%(uploader)s',
      titulo: '%(title)s',
      id: '%(id)s',
      fecha: '%(upload_date>%Y-%m-%d)s',
      indice: '%(playlist_index)s',
      calidad: '%(resolution)s',
      ext: '%(ext)s'
    };

    const sanearLiteral = (texto) =>
      String(texto)
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/[{}]/g, '');

    // El límite se aplica antes de sustituir, para no cortar un campo a medias.
    let entrada = String(plantilla || '').trim().slice(0, 150) || 'youtube_{usuario}_{titulo}_{id}';
    const conCampos = entrada.replace(/\{(\w+)\}/g, (todo, clave) =>
      Object.prototype.hasOwnProperty.call(equivalencias, clave) ? equivalencias[clave] : ''
    );

    // Se trocea por los campos de yt-dlp: los pares son campos, los impares texto.
    const salida = conCampos
      .split(/(%\([^)]*\)[a-zA-Z])/)
      .map((trozo, indice) => (indice % 2 === 1 ? trozo : sanearLiteral(trozo)))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (!salida) return 'youtube_%(uploader)s_%(title)s_%(id)s.%(ext)s';
    return /\.\%\(ext\)s$/.test(salida) ? salida : salida.replace(/\.+$/, '') + '.%(ext)s';
  }

  /* =======================================================================
   * 2. Botón y escaneo
   * ===================================================================== */

  function crearBoton(contenedor) {
    let host = core.findOverlayHost(contenedor);
    if (!host) {
      contenedor.style.position = 'relative';
      host = contenedor;
    }
    host.setAttribute(core.HOST_ATTR, '1');

    const boton = core.createButton({
      label: 'Descargar',
      title: 'Descargar con yt-dlp (máxima calidad, o solo el audio)',
      ariaLabel: 'Descargar de YouTube con yt-dlp',
      icon: core.ICONS.download,
      className: 'xvd-button--yt' + (esShorts() ? ' xvd-button--yt-shorts' : ''),
      onClick: () => descargar(boton)
    });
    boton.dataset.xvdKind = 'youtube';
    boton.dataset.xvdSite = 'youtube';
    host.appendChild(boton);
    contenedor.__xvdYtButton = boton;
    return boton;
  }

  function limpiarOverlaysYouTube() {
    document.querySelectorAll('.' + core.BUTTON_CLASS + '[data-xvd-site="youtube"]').forEach((n) => n.remove());
  }

  function scanYouTube() {
    const cfg = core.getSettings();
    if (!cfg.enabled || !cfg.youtubeEnabled) {
      limpiarOverlaysYouTube();
      return;
    }

    const botonExistente = document.querySelector('.' + core.BUTTON_CLASS + '[data-xvd-site="youtube"]');
    const contenedor = jugador();
    const video = videoDelJugador(contenedor);

    if (!contenedor || !video) {
      if (botonExistente) botonExistente.remove();
      ultimoResumen.texto = 'sin reproductor';
      return;
    }

    // El minirreproductor no cuenta (ni las miniaturas de la portada).
    if (video.closest('.ytp-miniplayer')) return;

    const rect = video.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 120) {
      ultimoResumen.texto = 'reproductor pequeño';
      return;
    }

    if (contenedor.__xvdYtButton && contenedor.__xvdYtButton.isConnected) {
      ultimoResumen.texto = 'ok';
      return;
    }

    crearBoton(contenedor);
    if (ultimoResumen.texto !== 'ok') {
      ultimoResumen.texto = 'ok';
      log('info', 'youtube', 'Reproductor detectado', {
        id: idEnLaUrl() || '(sin id en la URL)',
        shorts: esShorts(),
        tamano: Math.round(rect.width) + 'x' + Math.round(rect.height)
      });
    }
  }

  /* =======================================================================
   * 3. Descarga con yt-dlp
   * ===================================================================== */

  function formatearTiempo(segundos) {
    const total = Math.max(0, Math.round(Number(segundos) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  async function descargar(boton) {
    const cfg = core.getSettings();

    if (!idEnLaUrl()) {
      core.toast('No se ha podido leer el identificador de este vídeo.', 'error', 7000);
      return;
    }
    if (descargasEnCurso >= 2) {
      core.toast('Ya hay dos descargas en marcha; espera a que terminen.', 'warn', 6000);
      return;
    }

    core.setButtonState(boton, 'loading', 'Comprobando…');
    const progreso = core.toast('Comprobando yt-dlp…', 'info', 120000);
    const update = (mensaje) => {
      if (!progreso) return;
      const nodo = progreso.querySelector('.xvd-toast__msg');
      if (nodo) nodo.textContent = mensaje;
    };

    const peticion = {
      url: urlDelVideo(),
      id: idEnLaUrl(),
      formato: cfg.format || 'mp4',
      calidad: cfg.quality === 'custom' ? String(cfg.minHeight || '') : 'max',
      carpeta: core.sanitizeFolder(cfg.folder),
      plantilla: plantillaParaYtDlp(cfg.youtubeFilenameTemplate),
      cookies: !!cfg.youtubeCookies,
      codec: cfg.youtubeCodec === 'max' ? 'max' : 'h264'
    };

    log('info', 'youtube', 'Descarga delegada en yt-dlp', peticion);

    try {
      const estado = await core.estadoDeYtDlp();
      if (!estado || !estado.ok) {
        throw Object.assign(
          new Error(
            'yt-dlp no está disponible todavía. Ejecuta una vez «Instalar yt-dlp para X media.cmd» ' +
              '(está en el Escritorio) y vuelve a intentarlo: no hace falta reiniciar Chrome.'
          ),
          { codigo: 'sin_ytdlp' }
        );
      }

      if (!estado.ffmpeg && (peticion.formato === 'mp4' || peticion.formato === 'webm' || peticion.formato === 'mp3')) {
        core.toast(
          'Aviso: no se ha encontrado ffmpeg. Sin él no se pueden unir imagen y sonido ni generar MP3.',
          'warn',
          9000
        );
      }

      descargasEnCurso++;
      boton.dataset.xvdDescarga = '1';
      update('yt-dlp está descargando…');

      const resultado = await core.descargarConYtDlp(peticion, (aviso) => {
        if (aviso.tipo === 'inicio') return;
        if (aviso.tipo === 'progreso') {
          const partes = [];
          if (typeof aviso.porcentaje === 'number') partes.push(aviso.porcentaje + '%');
          if (aviso.total) partes.push('de ' + aviso.total);
          if (aviso.velocidad) partes.push('a ' + aviso.velocidad);
          if (aviso.eta && aviso.eta !== 'Unknown') partes.push('faltan ' + formatearTiempo(aviso.eta));
          update('Descargando con yt-dlp: ' + partes.join(' '));
          return;
        }
        // Avisos de yt-dlp: se muestran los que explican qué está haciendo.
        if (/Merging|ExtractAudio|Fixup|Destination/i.test(aviso.mensaje || '')) {
          update(String(aviso.mensaje).slice(0, 120));
        }
      });

      if (progreso) progreso.remove();

      if (!resultado || !resultado.ok) {
        throw new Error((resultado && resultado.mensaje) || 'yt-dlp no pudo completar la descarga.');
      }

      const nombre = resultado.archivo ? resultado.archivo.split('\\').pop() : 'el archivo';
      const mb = resultado.kb ? (resultado.kb / 1024).toFixed(1) + ' MB' : '';
      core.setButtonState(boton, 'done', 'Descargada');
      core.toast('Descarga terminada: ' + nombre + (mb ? ' (' + mb + ')' : ''), 'success', 6000);
      log('info', 'youtube', 'Descarga de yt-dlp terminada', {
        archivo: resultado.archivo,
        kb: resultado.kb,
        carpeta: resultado.carpeta,
        formato: peticion.formato,
        calidad: peticion.calidad
      });
    } catch (err) {
      if (progreso) progreso.remove();
      const mensaje = core.errorMessage(err);
      log('error', 'youtube', 'Fallo al descargar de YouTube', {
        mensaje,
        codigo: (err && err.codigo) || '',
        formato: cfg.format
      });
      core.setButtonState(boton, 'error', 'Error');
      core.toast(mensaje, 'error', 11000);
    } finally {
      descargasEnCurso = Math.max(0, descargasEnCurso - 1);
      if (boton) delete boton.dataset.xvdDescarga;
    }
  }

  /* =======================================================================
   * 4. Registro en el núcleo
   * ===================================================================== */

  if (/(^|\.)youtube\.com$/i.test(location.hostname)) {
    core.registerScanner(scanYouTube);
    core.registerDisableHook((cfg) => {
      if (!cfg.youtubeEnabled) limpiarOverlaysYouTube();
    });
    log('info', 'youtube', 'Módulo de YouTube activo (descargas con yt-dlp)', { url: location.pathname });
  }

  /* =======================================================================
   * 5. Exportaciones (solo para las pruebas automáticas)
   * ===================================================================== */

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { idEnLaUrl, urlDelVideo, esShorts, plantillaParaYtDlp, formatearTiempo };
  }
})();
