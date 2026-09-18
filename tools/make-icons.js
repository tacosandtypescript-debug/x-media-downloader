/**
 * Generador de iconos de la extensión (16 / 48 / 128 px).
 * Uso:  node tools/make-icons.js
 *
 * No usa dependencias externas: dibuja un cuadrado redondeado azul con una
 * flecha de descarga blanca y codifica el PNG a mano (zlib + CRC32).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');
const SIZES = [16, 48, 128];

/* ---------------------------------------------------------------- dibujo -- */

const ACCENT = [29, 155, 240]; // #1d9bf0 (azul de X)
const WHITE = [255, 255, 255];

function insideRoundedRect(x, y, size, radius) {
  const r = radius;
  if (x >= r && x <= size - r) return y >= 0 && y <= size;
  if (y >= r && y <= size - r) return x >= 0 && x <= size;
  const cx = x < r ? r : size - r;
  const cy = y < r ? r : size - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Flecha de descarga hacia abajo + bandeja. */
function insideArrow(x, y, size) {
  const u = size / 24; // rejilla de 24 unidades

  // Mástil vertical
  const stemLeft = 10.9 * u;
  const stemRight = 13.1 * u;
  if (x >= stemLeft && x <= stemRight && y >= 4.2 * u && y <= 13.0 * u) return true;

  // Cabeza triangular
  const apexY = 17.0 * u;
  const topY = 11.2 * u;
  if (y >= topY && y <= apexY) {
    const halfWidth = ((apexY - y) / (apexY - topY)) * 4.6 * u;
    const cx = 12 * u;
    if (Math.abs(x - cx) <= halfWidth) return true;
  }

  // Bandeja inferior
  const trayTop = 18.0 * u;
  const trayBottom = 20.1 * u;
  const trayLeft = 6.6 * u;
  const trayRight = 17.4 * u;
  if (y >= trayTop && y <= trayBottom && x >= trayLeft && x <= trayRight) return true;

  return false;
}

function sampleColor(px, py, size) {
  const radius = size * 0.235;
  if (!insideRoundedRect(px, py, size, radius)) return null;
  return insideArrow(px, py, size) ? WHITE : ACCENT;
}

/** Renderiza con supermuestreo 3x3 para suavizar bordes. */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          const color = sampleColor(px, py, size);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }

      const total = samples * samples;
      const idx = (y * size + x) * 4;
      const coverage = a / total;
      if (coverage === 0) continue;

      const opaque = a / 255; // nº de muestras con color
      rgba[idx] = Math.round(r / opaque);
      rgba[idx + 1] = Math.round(g / opaque);
      rgba[idx + 2] = Math.round(b / opaque);
      rgba[idx + 3] = Math.round(coverage);
    }
  }
  return rgba;
}

/* -------------------------------------------------------------- PNG (zlib) -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ main -- */

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log('Generado', path.relative(path.join(__dirname, '..'), file));
}
