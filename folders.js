/**
 * Descargador de medios para X — Carpetas de destino
 * ---------------------------------------------------------------------------
 * Lógica compartida entre el popup y las pruebas automatizadas. No toca el DOM:
 * solo normaliza, compara y mantiene la lista de carpetas usadas.
 *
 * Todo se expresa como RUTA RELATIVA dentro de la carpeta de Descargas, porque
 * es lo que acepta chrome.downloads: al pasar `filename: "IRONMOUSE Torneo/x.jpg"`
 * Chrome crea la subcarpeta si no existe. La extensión nunca necesita permisos
 * de escritura: organiza las descargas con rutas relativas.
 */
(() => {
  'use strict';

  /** Caracteres que ni Windows ni Chrome aceptan en una ruta. */
  const INVALIDOS = /[\\/:*?"<>|\u0000-\u001f]/g;

  /** Longitud máxima de la ruta relativa (deja sitio al nombre del archivo). */
  const MAXIMO = 120;

  /** Máximo de carpetas recordadas. */
  const MAXIMO_HISTORIAL = 30;

  /**
   * Limpia un nombre o ruta de carpeta y devuelve la ruta relativa utilizable.
   *   "  Fortnite / Skins  "        -> "Fortnite/Skins"
   *   "../../etc/passwd"            -> "etc/passwd"   (nunca sale de Descargas)
   *   "IRONMOUSE: Torneo?"          -> "IRONMOUSE_ Torneo_"
   *   "carpeta."                    -> "carpeta"      (Windows no admite punto final)
   */
  function normalizarCarpeta(texto) {
    const partes = String(texto == null ? '' : texto)
      .replace(/\\/g, '/')
      .split('/')
      .map((parte) =>
        parte
          .replace(INVALIDOS, '_')
          .replace(/\s+/g, ' ')
          .trim()
          // Windows: ni puntos ni espacios al final de un segmento
          .replace(/[. ]+$/g, '')
      )
      .filter((parte) => parte && parte !== '.' && parte !== '..');

    let ruta = partes.join('/');
    if (ruta.length > MAXIMO) {
      ruta = ruta.slice(0, MAXIMO).replace(/[.\s/]+$/g, '');
    }
    return ruta;
  }

  /** Clave para comparar carpetas sin falsos duplicados (mayúsculas, espacios, barras). */
  function claveDeCarpeta(carpeta) {
    return normalizarCarpeta(carpeta).toLowerCase();
  }

  /** Texto para mostrar al usuario dónde se va a guardar. */
  function etiquetaDestino(carpeta) {
    const limpia = normalizarCarpeta(carpeta);
    return limpia ? 'Descargas/' + limpia : 'Descargas (predeterminada)';
  }

  /**
   * Añade una carpeta al historial evitando duplicados.
   * Devuelve el historial resultante, la carpeta normalizada que hay que usar y
   * si ya existía (para avisar en vez de "crear" otra vez).
   */
  function anadirAlHistorial(historial, carpeta) {
    const lista = Array.isArray(historial) ? historial.slice() : [];
    const limpia = normalizarCarpeta(carpeta);
    if (!limpia) return { historial: lista, carpeta: '', existia: false };

    const clave = claveDeCarpeta(limpia);
    const existente = lista.find((c) => claveDeCarpeta(c) === clave);
    if (existente) {
      return { historial: lista, carpeta: normalizarCarpeta(existente), existia: true };
    }

    lista.unshift(limpia);
    return { historial: lista.slice(0, MAXIMO_HISTORIAL), carpeta: limpia, existia: false };
  }

  /** Quita una carpeta del historial. */
  function quitarDelHistorial(historial, carpeta) {
    const clave = claveDeCarpeta(carpeta);
    return (Array.isArray(historial) ? historial : []).filter((c) => claveDeCarpeta(c) !== clave);
  }

  const api = {
    normalizarCarpeta,
    claveDeCarpeta,
    etiquetaDestino,
    anadirAlHistorial,
    quitarDelHistorial,
    MAXIMO_HISTORIAL
  };

  if (typeof window !== 'undefined') window.XVD_FOLDERS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
