/**
 * Pruebas automatizadas de la lógica pura del content script.
 * Uso:  node tools/test.js
 *
 * Carga content.js en un contexto aislado con stubs mínimos del navegador y
 * verifica la normalización de variantes, la selección de calidad/formato,
 * el nombre de archivo y el análisis de manifiestos HLS.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* --------------------------------------------------- carga en contexto vm -- */

function loadContentScript() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    Blob: function Blob() {},
    performance: { getEntriesByType: () => [] },
    fetch: () => Promise.reject(new Error('sin red en las pruebas')),
    getComputedStyle: () => ({ position: 'static' }),
    MutationObserver: function MutationObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    ResizeObserver: function ResizeObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    document: {
      readyState: 'loading',
      addEventListener: () => {},
      documentElement: { classList: { toggle: () => {} } },
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add: () => {}, contains: () => false } })
    },
    chrome: {
      storage: {
        sync: { get: (_d, cb) => cb && cb({}) },
        local: { get: (_d, cb) => cb && cb({}) },
        onChanged: { addListener: () => {} }
      },
      runtime: { onMessage: { addListener: () => {} }, lastError: null }
    },
    module: { exports: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const code = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'content.js' });
  return sandbox.module.exports;
}

const xvd = loadContentScript();
const { normalizeVariant, normalizeMediaEntity, extractMediaId, planDownload, buildFilename, sanitizeFolder, parseMasterPlaylist, parseMediaPlaylist } = xvd;

/* --------------------------------------- carga del módulo de imágenes -- */

const IMAGE_DEFAULTS = {
  enabled: true,
  folder: 'X Videos',
  askWhereToSave: false,
  showToasts: true,
  showOnHover: false,
  imagesEnabled: true,
  imageResolution: 'orig',
  imageFormat: 'auto',
  galleryButton: true,
  compactImageButton: false,
  imageFallback: true,
  imageVerify: true,
  imageFilenameTemplate: 'tweet_{id}_img{indice}'
};

function loadImagesModule(defaults) {
  const registered = { scanners: [], hooks: [] };
  const core = {
    BUTTON_CLASS: 'xvd-button',
    BADGE_CLASS: 'xvd-badge',
    HOST_ATTR: 'data-xvd-host',
    IMAGE_ATTR: 'data-xvd-image',
    ICONS: { download: '', spinner: '', check: '', warn: '', images: '' },
    getSettings: () => ({ ...defaults }),
    registerScanner: (fn) => registered.scanners.push(fn),
    registerDisableHook: (fn) => registered.hooks.push(fn),
    sanitizeFolder,
    createButton: () => ({}),
    setButtonState: () => {},
    findOverlayHost: () => null,
    getTweetContext: () => ({ screenName: 'usuario', tweetId: '999', date: '2024-05-01' }),
    toast: () => {},
    sleep: () => Promise.resolve(),
    requestDownload: async () => ({ ok: true, downloadId: 1 }),
    errorMessage: (error) => String(error && error.message ? error.message : error),
    cleanupOverlays: () => {}
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    Image: function Image() {},
    document: { querySelectorAll: () => [] },
    getComputedStyle: () => ({ position: 'static' }),
    ResizeObserver: function ResizeObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    module: { exports: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.__XVD_CORE__ = core;

  const code = fs.readFileSync(path.join(ROOT, 'images.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'images.js' });
  return { api: sandbox.module.exports, registered };
}

const images = loadImagesModule(IMAGE_DEFAULTS);
const img = images.api;

/* ------------------------------------------------------------- mini runner -- */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  ✗ ' + name + '\n      ' + error.message);
  }
}

function config(overrides) {
  return { ...xvd.DEFAULT_SETTINGS, ...overrides };
}

/* ------------------------------------------------------- variantes de X -- */

const MEDIA = {
  id: '1580000000000000000',
  poster: 'https://pbs.twimg.com/amplify_video_thumb/1580000000000000000/img/abc.jpg',
  variants: [
    { url: 'https://video.twimg.com/amplify_video/1580000000000000000/pl/xyz.m3u8', content_type: 'application/x-mpegURL' },
    { url: 'https://video.twimg.com/amplify_video/1580000000000000000/vid/320x180/a.mp4', bitrate: 288000, content_type: 'video/mp4' },
    { url: 'https://video.twimg.com/amplify_video/1580000000000000000/vid/640x360/b.mp4', bitrate: 832000, content_type: 'video/mp4' },
    { url: 'https://video.twimg.com/amplify_video/1580000000000000000/vid/1280x720/c.mp4', bitrate: 2176000, content_type: 'video/mp4' }
  ]
};

console.log('\nnormalizeVariant / normalizeMediaEntity');

test('clasifica MP4 progresivo con bitrate', () => {
  const v = normalizeVariant({ url: 'https://video.twimg.com/x.mp4', content_type: 'video/mp4', bitrate: 832000 });
  assert.strictEqual(v.kind, 'video');
  assert.strictEqual(v.ext, 'mp4');
  assert.strictEqual(v.bitrate, 832000);
});

test('clasifica WebM', () => {
  const v = normalizeVariant({ url: 'https://video.twimg.com/x.webm', content_type: 'video/webm' });
  assert.strictEqual(v.ext, 'webm');
  assert.strictEqual(v.kind, 'video');
});

test('clasifica HLS por content_type y por extensión', () => {
  assert.strictEqual(normalizeVariant({ url: 'https://v/pl/a.m3u8', content_type: 'application/x-mpegURL' }).kind, 'hls');
  assert.strictEqual(normalizeVariant({ url: 'https://v/pl/a.m3u8?tag=1' }).kind, 'hls');
});

test('clasifica audio M4A', () => {
  const v = normalizeVariant({ url: 'https://video.twimg.com/a.m4a', content_type: 'audio/mp4' });
  assert.strictEqual(v.kind, 'audio');
  assert.strictEqual(v.ext, 'm4a');
});

test('descarta variantes sin URL', () => {
  assert.strictEqual(normalizeVariant({ content_type: 'video/mp4' }), null);
});

test('deduce la resolución desde la URL (X no la incluye en el manifiesto)', () => {
  const v = normalizeVariant({
    url: 'https://video.twimg.com/amplify_video/1580000000000000000/vid/1280x720/c.mp4',
    content_type: 'video/mp4',
    bitrate: 2176000
  });
  assert.strictEqual(v.width, 1280);
  assert.strictEqual(v.height, 720);
});

test('extrae la entidad multimedia con id y póster', () => {
  const media = normalizeMediaEntity({
    id_str: '1580000000000000000',
    media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/1580000000000000000/img/abc.jpg',
    video_info: { duration_millis: 12000, variants: MEDIA.variants }
  });
  assert.strictEqual(media.id, '1580000000000000000');
  assert.strictEqual(media.duration, 12000);
  assert.strictEqual(media.variants.length, 4);
});

test('extrae el id del video desde la URL del póster', () => {
  assert.strictEqual(extractMediaId(MEDIA.poster), '1580000000000000000');
  assert.strictEqual(extractMediaId('https://example.com/nada.jpg'), '');
});

/* ------------------------------------------------- selección de variantes -- */

console.log('\nplanDownload (formato y calidad)');

const media = normalizeMediaEntity({ id_str: MEDIA.id, media_url_https: MEDIA.poster, video_info: { variants: MEDIA.variants } });

test('Auto + Máxima elige 1280x720 (mayor resolución)', () => {
  const plan = planDownload(media, config({ format: 'auto', quality: 'max' }));
  assert.ok(!plan.error, plan.error);
  assert.strictEqual(plan.ordered[0].url.endsWith('1280x720/c.mp4'), true);
  assert.strictEqual(plan.ordered.length, 3, 'debe conservar el respaldo de menor calidad');
  assert.strictEqual(plan.ordered[1].bitrate, 832000);
});

test('MP4 + Máxima ignora el manifiesto HLS', () => {
  const plan = planDownload(media, config({ format: 'mp4', quality: 'max' }));
  assert.ok(plan.ordered.every((v) => v.kind === 'video'));
  assert.strictEqual(plan.ordered[0].bitrate, 2176000);
});

test('WebM sin variantes WebM avisa y usa MP4', () => {
  const plan = planDownload(media, config({ format: 'webm', quality: 'max' }));
  assert.ok(/no tiene versión WebM/i.test(plan.notice), 'debe avisar al usuario');
  assert.strictEqual(plan.ordered[0].ext, 'mp4');
});

test('M4A sin pista de audio avisa y entrega el MP4', () => {
  const plan = planDownload(media, config({ format: 'm4a', audioFallback: 'mp4' }));
  assert.ok(/pista de audio independiente/i.test(plan.notice));
  assert.strictEqual(plan.ordered[0].ext, 'mp4');
});

test('M4A con audioFallback=error no descarga nada', () => {
  const plan = planDownload(media, config({ format: 'm4a', audioFallback: 'error' }));
  assert.ok(plan.error, 'debe devolver error');
  assert.ok(!plan.ordered);
});

test('M4A usa la variante de audio cuando existe', () => {
  const withAudio = normalizeMediaEntity({
    id_str: '1',
    video_info: { variants: MEDIA.variants.concat([{ url: 'https://video.twimg.com/a.m4a', content_type: 'audio/mp4' }]) }
  });
  const plan = planDownload(withAudio, config({ format: 'm4a' }));
  assert.strictEqual(plan.ordered[0].ext, 'm4a');
});

test('Calidad personalizada 1080p avisa si solo hay 720p', () => {
  const plan = planDownload(media, config({ format: 'auto', quality: 'custom', minHeight: 1080 }));
  assert.ok(/No hay variantes de 1080p/i.test(plan.notice));
  assert.strictEqual(plan.ordered[0].bitrate, 2176000);
});

test('Calidad personalizada 720p filtra y conserva el orden', () => {
  const plan = planDownload(media, config({ format: 'auto', quality: 'custom', minHeight: 720 }));
  assert.strictEqual(plan.ordered.length, 1);
  assert.strictEqual(plan.ordered[0].bitrate, 2176000);
});

test('Sin variantes progresivas ofrece el modo HLS avanzado', () => {
  const hlsOnly = normalizeMediaEntity({
    id_str: '2',
    video_info: { variants: [{ url: 'https://v/pl/a.m3u8', content_type: 'application/x-mpegURL' }] }
  });
  const off = planDownload(hlsOnly, config({ hlsFallback: false }));
  assert.ok(/solo está disponible como stream HLS/i.test(off.error));

  const on = planDownload(hlsOnly, config({ hlsFallback: true }));
  assert.ok(on.hls, 'debe seleccionar la variante HLS');
  assert.strictEqual(on.error, null);
});

test('El respaldo de menor calidad prioriza resolución sobre bitrate', () => {
  const mixed = normalizeMediaEntity({
    id_str: '3',
    video_info: {
      variants: [
        { url: 'https://v/1.mp4', content_type: 'video/mp4', bitrate: 5000000 },
        { url: 'https://v/2.mp4', content_type: 'video/mp4', bitrate: 500000 }
      ]
    }
  });
  const plan = planDownload(mixed, config({}));
  assert.strictEqual(plan.ordered[0].url, 'https://v/1.mp4');
  assert.strictEqual(plan.ordered[1].url, 'https://v/2.mp4');
});

/* ----------------------------------------------------- nombre de archivo -- */

console.log('\nbuildFilename / sanitizeFolder');

test('aplica la carpeta y la extensión', () => {
  const name = buildFilename(
    { id: '1580000000000000000' },
    { height: 720, ext: 'mp4', bitrate: 2176000 },
    { screenName: 'usuario', tweetId: '999', date: '2024-05-01' },
    null,
    config({ folder: 'X Videos' })
  );
  assert.strictEqual(name, 'X Videos/usuario_1580000000000000000_720p.mp4');
});

test('sustituye caracteres inválidos del nombre', () => {
  const name = buildFilename(
    { id: '1' },
    { height: 480, ext: 'mp4' },
    { screenName: 'a/b:c*?', tweetId: '1', date: '2024-05-01' },
    null,
    config({ folder: '' })
  );
  assert.ok(!/[\\/:*?"<>|]/.test(name), 'no debe quedar ningún carácter inválido: ' + name);
});

test('evita salir de la carpeta de Descargas', () => {
  assert.strictEqual(sanitizeFolder('../../etc/passwd'), 'etc/passwd');
  assert.strictEqual(sanitizeFolder('X Videos/../secretos'), 'X Videos/secretos');
  assert.strictEqual(sanitizeFolder(''), '');
});

test('respeta plantillas con {ext} y sufijo', () => {
  const name = buildFilename(
    { id: '7' },
    { height: 0, ext: 'ts', bitrate: 0 },
    { screenName: 'u', tweetId: '7', date: '2024-05-01' },
    'hls',
    config({ folder: '', filenameTemplate: '{usuario}-{fecha}-{ext}' })
  );
  assert.strictEqual(name, 'u-2024-05-01-hls.ts');
});

test('limita la longitud del nombre', () => {
  const name = buildFilename(
    { id: 'x'.repeat(400) },
    { height: 1080, ext: 'mp4' },
    { screenName: 'u', tweetId: '1', date: '2024-05-01' },
    null,
    config({ folder: '' })
  );
  assert.ok(name.length <= 150, 'longitud final: ' + name.length);
  assert.ok(name.endsWith('.mp4'));
});

/* --------------------------------------------------------- manifiestos HLS -- */

console.log('\nAnálisis de manifiestos HLS');

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",URI="/amplify_video/1/pl/audio.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=288000,RESOLUTION=320x180,CODECS="avc1.4d0015,mp4a.40.2"',
  '/amplify_video/1/pl/180.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2176000,RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2"',
  '/amplify_video/1/pl/720.m3u8'
].join('\n');

test('parsea resoluciones, bandwidth y audio del manifiesto maestro', () => {
  const parsed = parseMasterPlaylist(MASTER, 'https://video.twimg.com/amplify_video/1/pl/master.m3u8');
  assert.strictEqual(parsed.streams.length, 2);
  assert.strictEqual(parsed.streams[1].height, 720);
  assert.strictEqual(parsed.streams[1].bandwidth, 2176000);
  assert.strictEqual(parsed.streams[0].url, 'https://video.twimg.com/amplify_video/1/pl/180.m3u8');
  // Las renditions de audio siguen siendo .m3u8: se marcan como HLS, nunca como archivo directo.
  const audio = parsed.variants.find((v) => v.audioOnly);
  assert.strictEqual(audio.kind, 'hls');
});

test('detecta segmentos CMAF (EXT-X-MAP) y metadatos de playlist', () => {
  const media = parseMediaPlaylist(
    [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.0,',
      'seg1.m4s',
      '#EXTINF:3.5,',
      'seg2.m4s'
    ].join('\n'),
    'https://video.twimg.com/amplify_video/1/pl/720.m3u8'
  );
  assert.strictEqual(media.isFmp4, true);
  assert.strictEqual(media.initSegment, 'https://video.twimg.com/amplify_video/1/pl/init.mp4');
  assert.strictEqual(media.segments.length, 2);
  assert.strictEqual(media.encrypted, false);
});

test('detecta streams cifrados y segmentos MPEG-TS', () => {
  const media = parseMediaPlaylist(
    ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXTINF:4.0,', 'seg1.ts'].join('\n'),
    'https://v/pl/a.m3u8'
  );
  assert.strictEqual(media.encrypted, true);
  assert.strictEqual(media.isFmp4, false);
});

/* ------------------------------------------------------------- imágenes -- */

console.log('\nMódulo de imágenes (images.js)');

function imageConfig(overrides) {
  return { ...IMAGE_DEFAULTS, ...overrides };
}

const IMG_URL = 'https://pbs.twimg.com/media/GHxyzabc123?format=jpg&name=small';

test('se registra en el núcleo compartido', () => {
  assert.strictEqual(images.registered.scanners.length, 1);
  assert.strictEqual(images.registered.hooks.length, 1);
});

test('reconoce imágenes de tweets y descarta avatares, emojis y miniaturas de video', () => {
  assert.strictEqual(img.isTweetImageUrl(IMG_URL), true);
  assert.strictEqual(img.isTweetImageUrl('https://pbs.twimg.com/media/GH1?format=png'), true);
  assert.strictEqual(img.isTweetImageUrl('https://pbs.twimg.com/card_img/17/card?format=jpg&name=small'), true);
  assert.strictEqual(img.isTweetImageUrl('https://pbs.twimg.com/profile_images/1/avatar.jpg'), false);
  assert.strictEqual(img.isTweetImageUrl('https://pbs.twimg.com/profile_banners/1/banner.jpg'), false);
  assert.strictEqual(img.isTweetImageUrl('https://pbs.twimg.com/tweet_video_thumb/GH1/img.jpg'), false);
  assert.strictEqual(img.isTweetImageUrl('https://pbs.twimg.com/amplify_video_thumb/1/img/x.jpg'), false);
  assert.strictEqual(img.isTweetImageUrl('https://abs.twimg.com/emoji/v2/72x72/1f600.png'), false);
});

test('interpreta el formato y el tamaño originales de la URL', () => {
  const parsed = img.parseImageUrl(IMG_URL);
  assert.strictEqual(parsed.format, 'jpg');
  assert.strictEqual(parsed.name, 'small');
  assert.strictEqual(parsed.pathname, '/media/GHxyzabc123');
});

test('reescribe name= para pedir la máxima resolución', () => {
  const url = img.buildImageUrl(IMG_URL, 'orig', 'auto');
  assert.ok(url.includes('name=orig'), url);
  assert.ok(url.includes('format=jpg'), 'debe conservar el formato original: ' + url);
  const large = img.buildImageUrl(IMG_URL, 'large', 'auto');
  assert.ok(large.includes('name=large'));
});

test('reescribe format= para convertir el formato', () => {
  const webp = img.buildImageUrl(IMG_URL, 'orig', 'webp');
  assert.ok(webp.includes('format=webp'), webp);
  assert.ok(webp.includes('name=orig'));
});

test('cadena de respaldo de resolución: orig → 4096x4096 → large → medium', () => {
  // Se copian a arrays locales: los del vm tienen otro realm y deepStrictEqual
  // compara también el prototipo.
  assert.deepStrictEqual([...img.resolutionChain('orig')], ['orig', '4096x4096', 'large', 'medium']);
  assert.deepStrictEqual([...img.resolutionChain('large')], ['large', 'medium']);
  assert.deepStrictEqual([...img.resolutionChain('medium')], ['medium']);
  assert.deepStrictEqual([...img.resolutionChain('desconocida')], ['orig', '4096x4096', 'large', 'medium']);
});

test('plan por defecto: orig en la máxima resolución y respaldos listos', () => {
  const plan = img.planImageDownload(IMG_URL, imageConfig({}));
  assert.ok(!plan.error, plan.error);
  assert.strictEqual(plan.ordered.length, 4);
  assert.strictEqual(plan.ordered[0].resolution, 'orig');
  assert.ok(plan.ordered[0].url.includes('name=orig'));
  assert.strictEqual(plan.ordered[0].ext, 'jpg');
  assert.strictEqual(plan.ordered[3].resolution, 'medium');
});

test('plan con formato PNG fuerza la conversión y avisa del tamaño', () => {
  const plan = img.planImageDownload(IMG_URL, imageConfig({ imageFormat: 'png' }));
  assert.strictEqual(plan.ordered[0].ext, 'png');
  assert.ok(plan.ordered[0].url.includes('format=png'));
  assert.ok(/aumentar mucho el tamaño/i.test(plan.notice), plan.notice);
});

test('plan con imageFallback=false no ofrece respaldos', () => {
  const plan = img.planImageDownload(IMG_URL, imageConfig({ imageFallback: false }));
  assert.strictEqual(plan.ordered.length, 1);
  assert.strictEqual(plan.ordered[0].resolution, 'orig');
});

test('plan con resolución 4096x4096 empieza por esa variante', () => {
  const plan = img.planImageDownload(IMG_URL, imageConfig({ imageResolution: '4096x4096' }));
  assert.strictEqual(plan.ordered[0].resolution, '4096x4096');
  assert.deepStrictEqual(
    Array.from(plan.ordered, (c) => String(c.resolution)),
    ['4096x4096', 'large', 'medium']
  );
});

test('avisa cuando la imagen es un GIF animado', () => {
  const gif = 'https://pbs.twimg.com/media/GHgif?format=gif&name=small';
  const auto = img.planImageDownload(gif, imageConfig({}));
  assert.ok(/GIF/i.test(auto.notice), auto.notice);
  assert.strictEqual(auto.ordered[0].ext, 'gif');

  const asPng = img.planImageDownload(gif, imageConfig({ imageFormat: 'png' }));
  assert.ok(/perderá la animación/i.test(asPng.notice), asPng.notice);
});

test('rechaza URLs que no son imágenes de tweets', () => {
  const plan = img.planImageDownload('https://pbs.twimg.com/profile_images/1/a.jpg', imageConfig({}));
  assert.ok(plan.error, 'debe devolver error');
  const plan2 = img.planImageDownload('https://example.com/foto.jpg', imageConfig({}));
  assert.ok(plan2.error);
});

test('deduplica por ruta, ignorando tamaño y formato', () => {
  const a = img.mediaKey('https://pbs.twimg.com/media/GH1?format=jpg&name=small');
  const b = img.mediaKey('https://pbs.twimg.com/media/GH1?format=png&name=orig');
  const c = img.mediaKey('https://pbs.twimg.com/media/GH2?format=jpg&name=orig');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('nombra las galerías como tweet_[id]_imgN.jpg', () => {
  const context = { screenName: 'usuario', tweetId: '1234567890', date: '2024-05-01' };
  const first = img.buildImageFilename(IMG_URL, context, 1, 4, 'orig');
  const third = img.buildImageFilename(IMG_URL, context, 3, 4, 'orig');
  assert.strictEqual(first, 'X Videos/tweet_1234567890_img1.jpg');
  assert.strictEqual(third, 'X Videos/tweet_1234567890_img3.jpg');
});

test('la extensión del nombre sigue al formato convertido', () => {
  const context = { screenName: 'u', tweetId: '55', date: '2024-05-01' };
  assert.ok(img.buildImageFilename(IMG_URL, context, 1, 1, 'orig', imageConfig({ imageFormat: 'webp' })).endsWith('.webp'));
  assert.ok(img.buildImageFilename(IMG_URL, context, 1, 1, 'orig', imageConfig({ imageFormat: 'png' })).endsWith('.png'));
  const gif = 'https://pbs.twimg.com/media/GHgif?format=gif&name=small';
  assert.ok(img.buildImageFilename(gif, context, 2, 2, 'orig', imageConfig({})).endsWith('.gif'));
});

test('la plantilla de imagen admite resolución e índice', () => {
  const context = { screenName: 'u', tweetId: '77', date: '2024-05-01' };
  const name = img.buildImageFilename(
    IMG_URL,
    context,
    2,
    3,
    'large',
    imageConfig({ imageFilenameTemplate: '{tweet}-{indice}de{total}-{resolucion}' })
  );
  assert.strictEqual(name, 'X Videos/77-2de3-large.jpg');
});

test('extrae la URL de una imagen de tarjeta con background-image', () => {
  const style = 'background-image: url("https://pbs.twimg.com/card_img/17/abc?format=jpg&name=small");';
  assert.strictEqual(img.extractBackgroundUrl(style), 'https://pbs.twimg.com/card_img/17/abc?format=jpg&name=small');
  assert.strictEqual(img.extractBackgroundUrl('background: red'), '');
});

/* ------------------------------------------------------------------ cierre -- */

console.log('\n' + passed + ' pruebas correctas, ' + failures.length + ' fallos\n');
if (failures.length) {
  process.exitCode = 1;
}
