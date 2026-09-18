// Construye el M4A a partir de la rendition de audio del HLS de X y comprueba
// que el resultado es un fMP4 válido (init + segmentos concatenados).
// Uso: node tools/build-audio-test.js <m3u8-de-audio> <salida.m4a>

const fs = require('fs');
const path = require('path');

const playlistUrl = process.argv[2];
const salida = process.argv[3] || path.join(process.env.TEMP || '.', 'xvd-audio.m4a');

function absoluta(uri, base) {
  return new URL(uri, base).toString();
}

async function traerTexto(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + url);
  return r.text();
}

async function traerBytes(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + url);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  const playlist = await traerTexto(playlistUrl);
  const lineas = playlist.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let init = '';
  const segmentos = [];
  let cifrado = false;

  for (const linea of lineas) {
    if (linea.startsWith('#EXT-X-MAP:')) {
      const m = linea.match(/URI="([^"]+)"/);
      if (m) init = absoluta(m[1], playlistUrl);
    } else if (linea.startsWith('#EXT-X-KEY:')) {
      if (!/METHOD=NONE/i.test(linea)) cifrado = true;
    } else if (!linea.startsWith('#')) {
      segmentos.push(absoluta(linea, playlistUrl));
    }
  }

  console.log('segmentos   :', segmentos.length);
  console.log('init        :', init ? path.basename(init) : '(ninguno)');
  console.log('cifrado     :', cifrado);

  const partes = [];
  let total = 0;
  if (init) {
    const b = await traerBytes(init);
    partes.push(b);
    total += b.length;
  }
  for (let i = 0; i < segmentos.length; i++) {
    const b = await traerBytes(segmentos[i]);
    partes.push(b);
    total += b.length;
    process.stdout.write('\r  descargando ' + (i + 1) + '/' + segmentos.length + '  ');
  }
  process.stdout.write('\n');

  const buffer = Buffer.concat(partes);
  fs.writeFileSync(salida, buffer);

  // Comprobación estructural mínima de un fMP4: cajas ftyp / moov / moof / mdat
  const cajas = [];
  let offset = 0;
  while (offset + 8 <= buffer.length && cajas.length < 12) {
    const tam = buffer.readUInt32BE(offset);
    const tipo = buffer.toString('ascii', offset + 4, offset + 8);
    cajas.push(tipo);
    if (tam < 8) break;
    offset += tam;
  }

  console.log('archivo     :', salida);
  console.log('tamaño      :', (buffer.length / 1024).toFixed(1), 'KB');
  console.log('cajas       :', cajas.join(' '));
  console.log('¿es fMP4?   :', cajas[0] === 'ftyp' && cajas.includes('moov'));
})();
