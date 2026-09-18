/**
 * Descargador de medios para X — documento offscreen
 * ---------------------------------------------------------------------------
 * Única misión: recibir bytes ya fabricados (M4A unido del HLS o MP3
 * recodificado) y devolver una URL de Blob para que el service worker la
 * descargue con chrome.downloads.
 *
 * OJO, IMPORTANTE (costó un rato descubrirlo): en un documento offscreen NO
 * están disponibles chrome.storage ni chrome.downloads. Si se llama a
 * chrome.downloads.onChanged.addListener aquí, lanza y ABORTA el archivo
 * entero: el documento existe, pero se queda sin listener y los mensajes
 * fallan con «Receiving end does not exist». Por eso aquí solo se usan
 * chrome.runtime y APIs del DOM (Blob, URL, atob).
 */
'use strict';

/** transferId -> { trozos: [], total, mime, transferId } */
const transferencias = new Map();

/** transferId -> objectURL (para poder revocarla cuando el service worker avise) */
const urlsVivas = new Map();

/** Red de seguridad: si nadie avisa, se libera pasado un rato. */
const VIDA_MAXIMA = 10 * 60 * 1000;

function base64ABytes(base64) {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

function revocar(transferId) {
  const url = urlsVivas.get(transferId);
  if (!url) return false;
  urlsVivas.delete(transferId);
  try {
    URL.revokeObjectURL(url);
  } catch (_) {
    /* ya no existe */
  }
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;
  if (message.target !== 'offscreen') return undefined;

  try {
    if (message.type === 'XVD_REVOCAR') {
      sendResponse({ ok: revocar(String(message.transferId || '')) });
      return undefined;
    }

    if (message.type !== 'XVD_CREAR_BLOB') return undefined;

    const id = String(message.transferId || 'unica');
    let datos = transferencias.get(id);
    if (!datos) {
      datos = { trozos: [], total: Number(message.trozos) || 1 };
      transferencias.set(id, datos);
    }

    if (!message.base64) {
      transferencias.delete(id);
      sendResponse({ ok: false, error: 'No hay datos que guardar.' });
      return undefined;
    }

    datos.trozos.push(base64ABytes(message.base64));

    if (!message.ultimo) {
      sendResponse({ ok: true, parcial: true, recibidos: datos.trozos.length });
      return undefined;
    }

    const blob = new Blob(datos.trozos, { type: message.mime || 'application/octet-stream' });
    const bytes = datos.trozos.reduce((n, t) => n + t.length, 0);
    transferencias.delete(id);

    const url = URL.createObjectURL(blob);
    urlsVivas.set(id, url);
    setTimeout(() => revocar(id), VIDA_MAXIMA);

    sendResponse({ ok: true, url, transferId: id, bytes });
    return undefined;
  } catch (error) {
    sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    return undefined;
  }
});
