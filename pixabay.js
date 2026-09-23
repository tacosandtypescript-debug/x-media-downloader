/**
 * Descargador de medios para X — Módulo de PIXABAY
 * ---------------------------------------------------------------------------
 * Reutiliza el núcleo compartido (window.__XVD_CORE__) como los módulos de X,
 * Instagram, Facebook y YouTube.
 *
 * Pixabay es el caso fácil y, además, el permitido: su licencia de contenido
 * deja descargar y reutilizar los medios (con sus condiciones). La web publica
 * las URLs del CDN en sus datos de arranque (`window.__BOOTSTRAP__.page`), así
 * que el puente del mundo MAIN los lee y aquí solo hay que poner el botón,
 * elegir el mejor tamaño DESCARGABLE y encargar la descarga al service worker
 * con la carpeta y el nombre de siempre.
 *
 * Qué se puede bajar de verdad (medido contra la web, septiembre de 2026):
 *   - AUDIO → el MP3 original del CDN (256 kbps), tal cual, sin recomprimir.
 *   - VÍDEO → MP4 del CDN: _tiny 720p, _small 1080p, _medium 1440p y _large 4K.
 *             Los cuatro responden 200; el «original» de 208 MB que anuncia la
 *             web no está en el CDN (su ruta responde HTML), así que el mayor
 *             tamaño útil es _large.
 *   - FOTO  → por CDN llega hasta _1280 px. Los tamaños mayores (_1920 y el
 *             original) los sirve la web solo tras su captcha o con sesión, así
 *             que se intentan primero y, si el CDN los rechaza, se baja el mayor
 *             que sí funcione (avisando del tamaño real).
 *   - Los medios «sponsored» de iStock (de pago) no se tocan: el puente los
 *     ignora porque no están en los resultados de Pixabay.
 */
(() => {
  'use strict';

  const core = window.__XVD_CORE__;
  if (!core || typeof core.registerScanner !== 'function') {
    console.warn('[XVD] pixabay.js necesita que content.js se cargue antes.');
    return;
  }
  if (window.__XVD_PIXABAY_LOADED__) return;
  window.__XVD_PIXABAY_LOADED__ = true;

  const log = typeof core.log === 'function' ? core.log : () => {};
  const MARCA = 'data-xvd-pixabay';

  /** Tamaños de vídeo del CDN, de mejor a peor. */
  const VIDEO_TAMANOS = [
    { sufijo: '_large', alto: 2160, etiqueta: '4K' },
    { sufijo: '_medium', alto: 1440, etiqueta: '1440p' },
    { sufijo: '_small', alto: 1080, etiqueta: '1080p' },
    { sufijo: '_tiny', alto: 720, etiqueta: '720p' }
  ];

  /** Tamaños de foto del CDN, de mayor a menor. */
  const FOTO_TAMANOS = [
    { sufijo: '_1920', etiqueta: '1920', ancho: 1920 },
    { sufijo: '_1280', etiqueta: '1280', ancho: 1280 },
    { sufijo: '_960_720', etiqueta: '960', ancho: 960 },
    { sufijo: '_640', etiqueta: '640', ancho: 640 }
  ];

  /** Idiomas que la web mete delante de la ruta: /es/photos/... */
  const IDIOMAS = /^\/(es|en|de|fr|pt|it|ja|ru|zh|nl|pl|tr|cs|sv|id|vi|ko|ro|hu|bg|da|fi|el|he|hi|no|sk|sl|sr|th|uk)\//i;

  let cacheMedios = null;
  let rutaDeLaCache = '';
  let ultimoIntento = 0;

  /* =======================================================================
   * 1. Utilidades
   * ===================================================================== */

  function sanear(texto) {
    return String(texto || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Quita el sufijo de tamaño (y el hash de firma) de una URL de foto. */
  function baseDeFoto(url) {
    if (typeof url !== 'string') return '';
    return url.replace(/_\d+(?:_\d+)?(?:__[0-9a-f]+)?\.(jpe?g|png|webp|gif)$/i, '');
  }

  /** Cambia el sufijo de tamaño de una URL de vídeo del CDN. */
  function videoConTamano(url, sufijo) {
    if (typeof url !== 'string' || !url) return '';
    const cambiada = url.replace(/_(tiny|small|medium|large|source)\.mp4(\?|$)/i, sufijo + '.mp4$2');
    return cambiada === url && !/_tiny|_small|_medium|_large|_source/i.test(url)
      ? url.replace(/\.mp4(\?|$)/i, sufijo + '.mp4$1')
      : cambiada;
  }

  /** ¿Esta URL sirve bytes? (el CDN de Pixabay manda CORS, así que se puede probar) */
  async function urlDisponible(url) {
    try {
      const respuesta = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
        credentials: 'omit',
        cache: 'no-store'
      });
      return respuesta.ok || respuesta.status === 206;
    } catch (_) {
      return false;
    }
  }

  function nombreDeArchivo(medio, ext, calidad) {
    const cfg = core.getSettings();
    const partes = {
      usuario: sanear(medio.autor) || 'pixabay',
      nombre: sanear(medio.nombre).slice(0, 60),
      id: medio.id || 'medio',
      fecha: new Date().toISOString().slice(0, 10),
      indice: '1',
      calidad: calidad || '',
      ext
    };

    let plantilla = String(cfg.pixabayFilenameTemplate || 'pixabay_{usuario}_{nombre}_{id}').trim();
    if (!plantilla) plantilla = 'pixabay_{usuario}_{nombre}_{id}';
    if (!/\{ext\}/.test(plantilla)) plantilla += '.{ext}';

    let nombre = plantilla.replace(/\{(\w+)\}/g, (todo, clave) =>
      Object.prototype.hasOwnProperty.call(partes, clave) ? String(partes[clave]) : todo
    );
    nombre = sanear(nombre.replace(/_+/g, '_').replace(/\s*_\s*/g, '_'));
    if (!nombre) nombre = 'pixabay_' + (medio.id || Date.now()) + '.' + ext;
    if (nombre.length > 150) {
      const punto = nombre.lastIndexOf('.');
      const sufijo = punto > 0 ? nombre.slice(punto) : '';
      nombre = nombre.slice(0, 150 - sufijo.length) + sufijo;
    }

    const carpeta = core.sanitizeFolder(cfg.folder);
    return carpeta ? carpeta + '/' + nombre : nombre;
  }

  /* =======================================================================
   * 2. Qué se puede bajar y en qué orden
   * ===================================================================== */

  /** Foto: del tamaño preferido al más pequeño, y el original al final. */
  function planDeFoto(medio) {
    const cfg = core.getSettings();
    const base = baseDeFoto(medio.url);
    if (!base) return [];

    const todos = FOTO_TAMANOS.map((tamano, indice) => ({
      url: base + tamano.sufijo + '.jpg',
      etiqueta: tamano.etiqueta,
      ancho: tamano.ancho,
      indice
    }));

    let preferido = 0;
    if (cfg.imageResolution === 'large') preferido = 1;
    else if (cfg.imageResolution === 'medium') preferido = 2;

    const orden = [todos[preferido], ...todos.filter((t) => t.indice !== preferido)];

    // La web a veces ya da una URL grande (o firmada con hash): se prueba antes.
    if (/_\d{3,4}(?:_\d+)?(?:__[0-9a-f]+)?\.(jpe?g|png|webp)$/i.test(medio.url)) {
      orden.unshift({ url: medio.url, etiqueta: 'la de la web' });
    }

    // Y el original (sin sufijo) como última opción.
    orden.push({ url: base + '.jpg', etiqueta: 'original' });
    return orden.filter((intento) => intento.url);
  }

  /** Vídeo: el tamaño que pida la calidad configurada y, después, los demás. */
  function planDeVideo(medio) {
    const cfg = core.getSettings();
    const tope = cfg.quality === 'custom' ? Number(cfg.minHeight) || 0 : 0;

    const todos = VIDEO_TAMANOS.map((tamano, indice) => ({
      url: videoConTamano(medio.url, tamano.sufijo),
      etiqueta: tamano.etiqueta,
      alto: tamano.alto,
      indice
    })).filter((intento) => intento.url);

    if (!todos.length) return [];

    // Con «calidad mínima» se coge el más pequeño que la cumpla (para no bajar
    // 200 MB cuando basta con 1080p); sin ella, el mejor disponible.
    let preferido = 0;
    if (tope > 0) {
      const cumplen = todos.filter((intento) => intento.alto >= tope);
      if (cumplen.length) preferido = cumplen[cumplen.length - 1].indice;
    }

    const elegido = todos.find((intento) => intento.indice === preferido) || todos[0];
    return [elegido, ...todos.filter((intento) => intento.indice !== elegido.indice)];
  }

  /** Audio: el MP3 del CDN, tal cual. */
  function planDeAudio(medio) {
    const url = medio.mp3 || medio.url;
    return url ? [{ url, etiqueta: 'mp3' }] : [];
  }

  /** Primer intento que responda de verdad (para no pedirle a Chrome algo roto). */
  async function elegirDisponible(intentos, verificar) {
    if (!verificar) return intentos[0];
    for (const intento of intentos) {
      // eslint-disable-next-line no-await-in-loop
      if (await urlDisponible(intento.url)) return intento;
    }
    return null;
  }

  /* =======================================================================
   * 3. Descarga
   * ===================================================================== */

  function crearAviso(mensaje) {
    const aviso = core.toast(mensaje, 'info', 120000);
    return {
      actualizar(texto) {
        if (!aviso) return;
        const nodo = aviso.querySelector('.xvd-toast__msg');
        if (nodo) nodo.textContent = texto;
      },
      cerrar() {
        if (aviso) aviso.remove();
      }
    };
  }

  async function descargar(medio, boton) {
    const cfg = core.getSettings();
    core.setButtonState(boton, 'loading', 'Preparando…');
    const aviso = crearAviso('Preparando la descarga…');

    try {
      // --- Audio: MP3 original, sin recomprimir ---------------------------
      if (medio.tipo === 'audio') {
        const intentos = planDeAudio(medio);
        if (!intentos.length) throw new Error('No se encontró el archivo de audio de esta pista.');
        if (cfg.format === 'm4a') {
          core.toast('Pixabay publica el audio en MP3: se descarga el MP3 original, sin recomprimir.', 'warn', 7000);
        }
        await bajar(intentos, medio, 'mp3', aviso, boton);
        return;
      }

      // --- Vídeo ----------------------------------------------------------
      if (medio.tipo === 'video') {
        if (cfg.format === 'm4a' || cfg.format === 'mp3') {
          aviso.cerrar();
          core.setButtonState(boton, 'idle', 'Vídeo');
          core.toast(
            'Los vídeos de Pixabay son MP4 y casi siempre van sin sonido: para audio, usa la sección de música.',
            'warn',
            8000
          );
          return;
        }
        if (cfg.format === 'webm') {
          core.toast('Pixabay solo publica los vídeos en MP4: se descarga el MP4.', 'warn', 7000);
        }
        const intentos = planDeVideo(medio);
        if (!intentos.length) throw new Error('No se pudo construir la URL del vídeo.');
        await bajar(intentos, medio, 'mp4', aviso, boton);
        return;
      }

      // --- Foto -----------------------------------------------------------
      const intentos = planDeFoto(medio);
      if (!intentos.length) throw new Error('No se pudo construir la URL de la imagen.');
      await bajar(intentos, medio, 'jpg', aviso, boton);
    } catch (err) {
      aviso.cerrar();
      if (boton) core.setButtonState(boton, 'error', 'Error');
      log('error', 'pixabay', 'Fallo al descargar', {
        tipo: medio.tipo,
        id: medio.id,
        motivo: core.errorMessage(err)
      });
      core.toast(core.errorMessage(err), 'error', 9000);
    }
  }

  async function bajar(intentos, medio, ext, aviso, boton) {
    const cfg = core.getSettings();
    aviso.actualizar('Comprobando la mejor calidad disponible…');

    // Comprobación previa (evita pedirle a Chrome un archivo que no existe y
    // ver un error rojo antes de la descarga buena).
    const elegido = await elegirDisponible(intentos, cfg.imageVerify !== false);
    const orden = elegido ? [elegido, ...intentos.filter((i) => i.url !== elegido.url)] : intentos;

    let ultimoFallo = '';
    for (let i = 0; i < orden.length; i++) {
      const intento = orden[i];
      const nombre = nombreDeArchivo(medio, ext, intento.etiqueta);
      aviso.actualizar(
        'Descargando ' + (intento.etiqueta ? intento.etiqueta : '') + '… (' + (i + 1) + '/' + orden.length + ')'
      );

      try {
        const respuesta = await core.requestDownload({
          url: intento.url,
          filename: nombre,
          label: nombre,
          saveAs: !!cfg.askWhereToSave,
          onInterrupted: (motivo) => {
            ultimoFallo = motivo;
            log('warn', 'pixabay', 'Chrome interrumpió la descarga', {
              etiqueta: intento.etiqueta,
              motivo
            });
            return null;
          }
        });

        aviso.cerrar();
        if (boton) core.setButtonState(boton, 'done', 'Descargada');
        core.toast('Descarga iniciada: ' + nombre, 'success', 4500);
        log('info', 'pixabay', 'Descarga iniciada', {
          tipo: medio.tipo,
          id: medio.id,
          etiqueta: intento.etiqueta,
          archivo: nombre,
          idDescarga: respuesta.downloadId
        });
        return true;
      } catch (err) {
        ultimoFallo = core.errorMessage(err);
        log('warn', 'pixabay', 'Intento fallido, se prueba el siguiente tamaño', {
          etiqueta: intento.etiqueta,
          url: intento.url,
          motivo: ultimoFallo
        });
      }
    }

    aviso.cerrar();
    if (boton) core.setButtonState(boton, 'error', 'Error');
    log('error', 'pixabay', 'Ningún tamaño disponible', { id: medio.id, motivo: ultimoFallo });
    core.toast(
      'No se pudo descargar de Pixabay' +
        (medio.tipo === 'photo'
          ? ': los tamaños grandes necesitan iniciar sesión en la web (se probaron todos los disponibles).'
          : ': ' + (ultimoFallo || 'sin detalle')),
      'error',
      9000
    );
    return false;
  }

  /* =======================================================================
   * 4. Dónde poner el botón
   * ===================================================================== */

  /** El botón «Free download» de la propia web (fichas de foto, vídeo y música). */
  function botonDeDescargaDeLaWeb() {
    const botones = document.querySelectorAll('button, a');
    for (const nodo of botones) {
      const texto = (nodo.textContent || '').trim();
      if (/^(free download|descarga gratuita|descargar gratis)$/i.test(texto)) return nodo;
    }
    return null;
  }

  /** ¿La ruta abierta es la ficha de este medio? */
  function esLaFichaDe(medio) {
    if (!medio.href) return false;
    const actual = location.pathname.replace(IDIOMAS, '/').replace(/\/$/, '');
    return actual === medio.href.replace(/\/$/, '');
  }

  function anclaDeListado(medio) {
    return (
      document.querySelector('[data-id="' + medio.id + '"]') ||
      document.querySelector('a[href$="-' + medio.id + '/"]') ||
      document.querySelector('a[href*="-' + medio.id + '"]')
    );
  }

  /** URL de la ficha de Pixabay asociada al medio, no la del CDN. */
  function urlDePublicacion(medio) {
    const raw = medio && medio.href ? String(medio.href) : '';
    try {
      const url = new URL(raw || location.href, location.origin || 'https://pixabay.com');
      const host = url.hostname.toLowerCase();
      if (host !== 'pixabay.com' && !host.endsWith('.pixabay.com')) return '';
      url.hash = '';
      return url.toString();
    } catch (_) {
      return '';
    }
  }

  function limpiarOverlaysPixabay() {
    document.querySelectorAll('.' + core.BUTTON_CLASS + '[data-xvd-site="pixabay"]').forEach((n) => n.remove());
    document.querySelectorAll('[' + MARCA + ']').forEach((n) => n.removeAttribute(MARCA));
  }

  function asegurarBotonDeEnlace(medio, host, enLinea) {
    const existente = host.__xvdPixabayLinkButton;
    if (!core.getSettings().copyLinkButton) {
      if (existente) existente.remove();
      return;
    }
    if (existente && existente.isConnected) return;

    const boton = core.createButton({
      label: 'Copiar enlace',
      title: 'Copiar el enlace de la ficha de Pixabay',
      ariaLabel: 'Copiar enlace de la ficha',
      icon: core.ICONS.link,
      className: 'xvd-button--copy-link xvd-button--pixabay' + (enLinea ? ' xvd-button--en-linea' : ''),
      onClick: () => core.copyLinkToButton(boton, () => urlDePublicacion(medio))
    });
    boton.dataset.xvdKind = 'pixabay-link';
    boton.dataset.xvdSite = 'pixabay';
    boton.__xvdMedium = medio;
    host.appendChild(boton);
    host.__xvdPixabayLinkButton = boton;
  }

  function crearBoton(medio, host, enLinea, antesDe) {
    if (!host) return false;
    const etiqueta = medio.tipo === 'photo' ? 'Descargar la imagen' : medio.tipo === 'video' ? 'Descargar el vídeo' : 'Descargar el audio';

    let destino = host;
    if (!enLinea) {
      destino = core.findOverlayHost(host);
      if (!destino) {
        host.style.position = 'relative';
        destino = host;
      }
      destino.setAttribute(core.HOST_ATTR, '1');
    }

    const boton = core.createButton({
      label: medio.tipo === 'photo' ? 'Imagen' : medio.tipo === 'video' ? 'Vídeo' : 'Audio',
      title: etiqueta + ' de Pixabay (calidad máxima descargable)',
      ariaLabel: etiqueta,
      icon: medio.tipo === 'photo' ? core.ICONS.images : core.ICONS.download,
      className: 'xvd-button--pixabay xvd-button--pixabay-' + medio.tipo + (enLinea ? ' xvd-button--en-linea' : ''),
      onClick: () => descargar(medio, boton)
    });
    boton.dataset.xvdKind = 'pixabay';
    boton.dataset.xvdSite = 'pixabay';
    boton.dataset.xvdId = medio.id;

    if (enLinea) {
      if (antesDe && antesDe.parentElement === host) host.insertBefore(boton, antesDe);
      else host.appendChild(boton);
    } else {
      destino.appendChild(boton);
    }

    destino.__xvdPixabayEnLinea = !!enLinea;
    destino.setAttribute(MARCA, medio.id);
    asegurarBotonDeEnlace(medio, destino, enLinea);
    return true;
  }

  function colocarBoton(medio) {
    // 1. Ficha abierta: al lado del botón de descarga de la propia web.
    if (esLaFichaDe(medio)) {
      const botonWeb = botonDeDescargaDeLaWeb();
      if (botonWeb && botonWeb.parentElement) {
        const contenedor = botonWeb.parentElement;
        if (contenedor.getAttribute(MARCA)) {
          asegurarBotonDeEnlace(medio, contenedor, true);
          return false;
        }
        contenedor.setAttribute(MARCA, 'encurso');
        return crearBoton(medio, contenedor, true, botonWeb);
      }
      // Sin botón de la web: encima del medio principal.
      const principal =
        document.querySelector('[class*="overlayContainer"] img') ||
        document.querySelector('article video') ||
        document.querySelector('video');
      if (principal && principal.parentElement) {
        const caja = principal.parentElement;
        if (caja.getAttribute(MARCA)) {
          asegurarBotonDeEnlace(medio, caja, false);
          return false;
        }
        caja.setAttribute(MARCA, 'encurso');
        return crearBoton(medio, caja, false);
      }
      return false;
    }

    // 2. Tarjeta de listado.
    const ancla = anclaDeListado(medio);
    if (!ancla) return false;

    // 2a. Fila de música: el botón va con las demás acciones de la fila. Se mide
    // la fila entera, porque el enlace del título es pequeñito.
    const fila = ancla.closest('[class*="audioRow"]');
    if (fila) {
      const rectFila = fila.getBoundingClientRect();
      if (rectFila.width < 200 || rectFila.height < 32) return false;
      const acciones = fila.querySelector('[class*="rightSection"]') || fila;
      if (acciones.getAttribute(MARCA)) {
        asegurarBotonDeEnlace(medio, acciones, true);
        return false;
      }
      acciones.setAttribute(MARCA, 'encurso');
      return crearBoton(medio, acciones, true, null);
    }

    // 2b. Foto o vídeo: flotante sobre la miniatura.
    const rect = ancla.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 40) return false;

    const caja = ancla.querySelector('[class*="overlayContainer"]') || ancla;
    if (caja.getAttribute(MARCA)) {
      asegurarBotonDeEnlace(medio, caja, false);
      return false;
    }
    caja.setAttribute(MARCA, 'encurso');
    return crearBoton(medio, caja, false);
  }

  /* =======================================================================
   * 5. Escaneo
   * ===================================================================== */

  async function mediosDeLaPagina() {
    // Se cachea solo lo que se ha recibido bien: si la web todavía no ha
    // publicado sus datos (o el reto de Cloudflare aún está en curso), se vuelve
    // a preguntar en el siguiente barrido en vez de quedarse sin botones.
    if (cacheMedios && cacheMedios.length && rutaDeLaCache === location.pathname) return cacheMedios;

    const ahora = Date.now();
    if (ahora - ultimoIntento < 1500) return cacheMedios || [];
    ultimoIntento = ahora;

    const medios = await core.requestPixabayMedia(6000);
    if (medios.length) {
      cacheMedios = medios;
      rutaDeLaCache = location.pathname;
      log('info', 'pixabay', 'Datos de Pixabay recibidos', {
        medios: medios.length,
        tipos: medios.reduce((acc, m) => {
          acc[m.tipo] = (acc[m.tipo] || 0) + 1;
          return acc;
        }, {})
      });
    } else if (rutaDeLaCache !== location.pathname) {
      cacheMedios = null;
    }
    return medios;
  }

  async function scanPixabay() {
    const cfg = core.getSettings();
    if (!cfg.enabled || !cfg.pixabayEnabled) {
      limpiarOverlaysPixabay();
      cacheMedios = null;
      return;
    }

    const medios = await mediosDeLaPagina();
    if (!medios.length) return;

    let colocados = 0;
    for (const medio of medios) {
      try {
        if (colocarBoton(medio)) colocados++;
      } catch (_) {
        /* un medio raro no debe romper el resto */
      }
    }

    if (colocados) {
      log('info', 'pixabay', 'Botones colocados', { botones: colocados, medios: medios.length });
    }
  }

  /* =======================================================================
   * 6. Registro en el núcleo
   * ===================================================================== */

  if (/(^|\.)pixabay\.com$/i.test(location.hostname)) {
    core.registerScanner(scanPixabay);
    core.registerDisableHook((cfg) => {
      if (!cfg.pixabayEnabled) {
        limpiarOverlaysPixabay();
        cacheMedios = null;
      }
    });

    window.addEventListener('popstate', () => {
      cacheMedios = null;
      limpiarOverlaysPixabay();
      core.scan();
    });

    log('info', 'pixabay', 'Módulo de Pixabay activo', { url: location.pathname });
  }

  /* =======================================================================
   * 7. Exportaciones (solo para las pruebas automáticas)
   * ===================================================================== */

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      baseDeFoto,
      videoConTamano,
      planDeFoto,
      planDeVideo,
      planDeAudio,
      nombreDeArchivo,
      urlDePublicacion,
      esLaFichaDe,
      VIDEO_TAMANOS,
      FOTO_TAMANOS
    };
  }
})();
