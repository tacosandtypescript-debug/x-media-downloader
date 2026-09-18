#!/usr/bin/env node
/**
 * Prueba del host de mensajería nativa SIN Chrome.
 *
 * Habla el mismo protocolo que Chrome (JSON con prefijo de longitud de 4 bytes
 * en little-endian) por stdin/stdout, así que sirve para comprobar el host, los
 * argumentos que construye y las descargas reales antes de tocar la extensión.
 *
 * Uso:
 *   node tools/test-host.js estado
 *   node tools/test-host.js m4a|mp3|mp4|webm [idDeVideo]
 *   node tools/test-host.js actualizar
 *   node tools/test-host.js carpeta     (comprueba el saneado de carpetas)
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = path.join(__dirname, '..', 'native', 'ytdlp-host.exe');
const CARPETA = 'XVD Pruebas del host';
const VIDEO = process.argv[3] || 'dQw4w9WgXcQ';
const CALIDAD = process.argv[4] || 'max';

if (!fs.existsSync(HOST)) {
  console.error('Falta native/ytdlp-host.exe. Compílalo con instalar-ytdlp.ps1 o con csc.');
  process.exit(1);
}

const resultados = [];
function check(nombre, ok, detalle) {
  resultados.push([nombre, !!ok]);
  console.log(`  ${ok ? '[OK]   ' : '[FALLA]'} ${nombre}${detalle ? '  ->  ' + detalle : ''}`);
}

function marco(objeto) {
  const cuerpo = Buffer.from(JSON.stringify(objeto), 'utf8');
  const cabecera = Buffer.alloc(4);
  cabecera.writeUInt32LE(cuerpo.length, 0);
  return Buffer.concat([cabecera, cuerpo]);
}

/** Lanza el host, manda una petición y devuelve todos los mensajes hasta que cierra. */
function hablar(peticion, { onMensaje, timeoutMs = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    const hijo = spawn(HOST, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const mensajes = [];
    let pendiente = Buffer.alloc(0);
    let errores = '';
    const temporizador = setTimeout(() => {
      hijo.kill();
      reject(new Error('El host no terminó a tiempo'));
    }, timeoutMs);

    hijo.stdout.on('data', (trozo) => {
      pendiente = Buffer.concat([pendiente, trozo]);
      while (pendiente.length >= 4) {
        const largo = pendiente.readUInt32LE(0);
        if (pendiente.length < 4 + largo) break;
        const texto = pendiente.subarray(4, 4 + largo).toString('utf8');
        pendiente = pendiente.subarray(4 + largo);
        let objeto;
        try {
          objeto = JSON.parse(texto);
        } catch (err) {
          objeto = { tipo: 'ilegible', texto };
        }
        mensajes.push(objeto);
        if (onMensaje) onMensaje(objeto);
      }
    });
    hijo.stderr.on('data', (trozo) => {
      errores += trozo.toString('utf8');
    });
    hijo.on('error', reject);
    hijo.on('close', (codigo) => {
      clearTimeout(temporizador);
      resolve({ mensajes, codigo, errores });
    });

    hijo.stdin.write(marco(peticion));
  });
}

const accion = process.argv[2] || 'estado';

(async () => {
  console.log('='.repeat(74));
  console.log(' PRUEBA DEL HOST NATIVO  ·  yt-dlp');
  console.log('='.repeat(74));
  console.log(` Host   : ${HOST}`);
  console.log(` Acción : ${accion}\n`);

  if (accion === 'estado') {
    const { mensajes } = await hablar({ accion: 'estado' });
    const estado = mensajes[0] || {};
    console.log(JSON.stringify(estado, null, 1));
    check('el host responde con el estado', estado.tipo === 'estado');
    check('encuentra yt-dlp', !!estado.ytdlp, estado.ytdlp);
    check('informa de la versión de yt-dlp', /^\d{4}\.\d{2}\.\d{2}/.test(estado.version || ''), estado.version);
    check('detecta ffmpeg', !!estado.ffmpeg);
    check('informa de la carpeta de Descargas', !!estado.descargas, estado.descargas);
    process.exit(resultados.some(([, ok]) => !ok) ? 1 : 0);
  }

  if (accion === 'carpeta') {
    for (const [carpeta, esperadoDentro] of [
      ['../fuera', true],
      ['..\\..\\Windows', true],
      ['C:\\Windows', true],
      ['XVD Pruebas del host/Sub', true],
      ['XVD: Pruebas?/Sub*', true]
    ]) {
      const { mensajes } = await hablar({
        accion: 'abrirCarpeta',
        carpeta
      });
      const respuesta = mensajes[0] || {};
      const dentro = (respuesta.carpeta || '').toLowerCase().startsWith(path.join(os.homedir(), 'Downloads').toLowerCase());
      check(`«${carpeta}» queda dentro de Descargas`, dentro && respuesta.ok === true, respuesta.carpeta);
      if (esperadoDentro && respuesta.carpeta && fs.existsSync(respuesta.carpeta)) {
        fs.rmdirSync(respuesta.carpeta, { recursive: true, force: true });
        const padre = path.dirname(respuesta.carpeta);
        if (padre.toLowerCase() !== path.join(os.homedir(), 'Downloads').toLowerCase()) {
          try {
            fs.rmdirSync(padre, { recursive: true, force: true });
          } catch (_) {
            /* nada */
          }
        }
      }
    }
    process.exit(resultados.some(([, ok]) => !ok) ? 1 : 0);
  }

  if (accion === 'actualizar') {
    const { mensajes } = await hablar({ accion: 'actualizar' });
    const fin = mensajes[mensajes.length - 1] || {};
    console.log('  versión tras actualizar:', fin.version);
    check('la actualización termina bien', fin.tipo === 'fin' && fin.ok === true, fin.salida || fin.mensaje);
    process.exit(resultados.some(([, ok]) => !ok) ? 1 : 0);
  }

  // --- descarga real -------------------------------------------------------
  const formato = accion;
  const destino = path.join(os.homedir(), 'Downloads', CARPETA);
  let ultimoProgreso = 0;
  let avisos = 0;
  const inicio = Date.now();

  const { mensajes } = await hablar(
    {
      accion: 'descargar',
      url: `https://www.youtube.com/watch?v=${VIDEO}`,
      id: VIDEO,
      formato,
      calidad: CALIDAD,
      carpeta: CARPETA,
      plantilla: 'youtube_%(uploader)s_%(title)s_%(id)s.%(ext)s',
      cookies: false
    },
    {
      onMensaje: (m) => {
        if (m.tipo === 'progreso' && m.porcentaje !== undefined) {
          if (m.porcentaje - ultimoProgreso >= 25 || m.porcentaje >= 100) {
            ultimoProgreso = m.porcentaje;
            console.log(
              `     ${String(m.porcentaje).padStart(5)}%  ${m.total || ''}  ${m.velocidad || ''}  ETA ${m.eta || '-'}`
            );
          }
        } else if (m.tipo === 'aviso') {
          avisos++;
          if (avisos <= 6) console.log(`     aviso: ${String(m.mensaje).slice(0, 110)}`);
        } else if (m.tipo === 'inicio') {
          console.log(`     orden: ${String(m.orden).slice(0, 160)}…`);
        }
      }
    }
  );

  const fin = mensajes.filter((m) => m.tipo === 'fin').pop() || {};
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

  check('el host manda mensajes de progreso', mensajes.some((m) => m.tipo === 'progreso'));
  check('la descarga termina bien', fin.tipo === 'fin' && fin.ok === true, fin.mensaje || `código ${fin.codigo}`);
  if (fin.archivo) {
    const existe = fs.existsSync(fin.archivo);
    check('el archivo existe donde dice', existe, fin.archivo);
    if (existe) {
      const datos = fs.readFileSync(fin.archivo);
      const kb = datos.length / 1024;
      console.log(`     ${kb.toFixed(0)} KB en ${segundos}s  ·  ${path.basename(fin.archivo)}`);
      console.log(`     primeros bytes: ${datos.subarray(0, 16).toString('hex')}`);
      check('el archivo está dentro de la carpeta pedida', fin.archivo.includes(CARPETA), fin.archivo);
      if (formato === 'mp3') {
        // ffmpeg escribe una etiqueta ID3 delante: se busca la sincronía MPEG detrás.
        const conId3 = datos.subarray(0, 3).toString('latin1') === 'ID3';
        let sincronia = -1;
        for (let i = 0; i < Math.min(datos.length - 1, 16384); i++) {
          if (datos[i] === 0xff && (datos[i + 1] & 0xe0) === 0xe0) {
            sincronia = i;
            break;
          }
        }
        check('el MP3 es válido (etiqueta ID3 + sincronía MPEG)', sincronia >= 0,
          `${conId3 ? 'ID3' : 'sin ID3'} · sincronía en el byte ${sincronia}`);
        check('el MP3 se llama .mp3', fin.archivo.endsWith('.mp3'));
      } else {
        check(`el archivo se llama .${formato}`, fin.archivo.endsWith('.' + formato), path.basename(fin.archivo));
        check('es un MP4/M4A real (caja ftyp)', datos.subarray(0, 64).includes(Buffer.from('ftyp')));
      }
      if (formato === 'mp4' || formato === 'webm' || formato === 'm4a') {
        // ffprobe es la única forma seria de comprobar qué pistas trae el archivo.
        try {
          const info = JSON.parse(
            require('child_process').execFileSync(
              'ffprobe',
              ['-v', 'error', '-print_format', 'json', '-show_streams', fin.archivo],
              { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
            )
          );
          const pistas = info.streams || [];
          const video = pistas.find((s) => s.codec_type === 'video');
          const audio = pistas.find((s) => s.codec_type === 'audio');
          const detalle = pistas
            .map((s) => `${s.codec_type}:${s.codec_name}${s.width ? ' ' + s.width + 'x' + s.height : ''}`)
            .join(' + ');
          check('ffprobe reconoce las pistas', pistas.length > 0, detalle);
          if (formato === 'm4a') {
            check('el M4A lleva solo audio', !!audio && !video, detalle);
          } else {
            check('el vídeo lleva imagen Y sonido', !!video && !!audio, detalle);
            if (CALIDAD !== 'max') {
              check(`la resolución no pasa de ${CALIDAD}p`, !video || video.height <= Number(CALIDAD) + 8, detalle);
            }
          }
        } catch (err) {
          check('ffprobe puede leer el archivo', false, String(err.message).slice(0, 120));
        }
      }
      fs.unlinkSync(fin.archivo);
      console.log('     (archivo borrado tras la prueba)');
    }
  }

  try {
    fs.rmdirSync(destino, { recursive: true, force: true });
  } catch (_) {
    /* nada */
  }

  const fallos = resultados.filter(([, ok]) => !ok);
  console.log(`\n ${resultados.length - fallos.length}/${resultados.length} comprobaciones correctas`);
  process.exit(fallos.length ? 1 : 0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
