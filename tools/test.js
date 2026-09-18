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
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
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
const { normalizeVariant, normalizeMediaEntity, extractMediaId, planDownload, bitrateDeAudio, buildFilename, sanitizeFolder, parseMasterPlaylist, parseMediaPlaylist } = xvd;

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

/* ------------------------------- carga del puente del mundo MAIN -- */

/**
 * Carga page-bridge.js con un DOM mínimo simulado. Se pueden inyectar globales
 * de "página" (window.__INITIAL_STATE__…) y props de React en los nodos.
 */
function loadBridge(options) {
  const opts = options || {};
  const video = {
    tagName: 'VIDEO',
    parentElement: null,
    getAttribute: (name) => (name === 'poster' ? opts.poster || null : null),
    closest: () => opts.article || null
  };
  if (opts.fiberProps) video['__reactFiber$test'] = { memoizedProps: opts.fiberProps, return: null };
  if (opts.reactProps) video['__reactProps$test'] = opts.reactProps;
  if (opts.article && opts.articleProps) opts.article['__reactProps$test'] = opts.articleProps;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    document: {
      querySelectorAll: (selector) => (selector === 'video' ? [video] : [])
    },
    module: { exports: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.postMessage = () => {};
  if (opts.pageState) sandbox.__INITIAL_STATE__ = opts.pageState;

  const code = fs.readFileSync(path.join(ROOT, 'page-bridge.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'page-bridge.js' });
  return { api: sandbox.module.exports, video, sandbox };
}

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

test('M4A con pista de audio progresiva la usa directamente', () => {
  const withAudio = normalizeMediaEntity({
    id_str: '1',
    video_info: { variants: MEDIA.variants.concat([{ url: 'https://video.twimg.com/a.m4a', content_type: 'audio/mp4' }]) }
  });
  const plan = planDownload(withAudio, config({ format: 'm4a' }));
  assert.ok(plan.audio, 'debe activar el modo solo audio');
  assert.strictEqual(plan.audio.formato, 'm4a');
  assert.strictEqual(plan.audio.directo, true);
  assert.ok(plan.audio.variant.url.endsWith('.m4a'));
});

test('M4A sin pista de audio avisa y entrega el MP4', () => {
  const plan = planDownload(media, config({ format: 'm4a', audioFallback: 'mp4' }));
  assert.ok(/pista de audio independiente/i.test(plan.notice));
  assert.strictEqual(plan.ordered[0].ext, 'mp4');
  assert.ok(!plan.audio);
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
  assert.ok(plan.audio, 'debe activar el modo solo audio');
  assert.strictEqual(plan.audio.formato, 'm4a');
  assert.strictEqual(plan.audio.directo, true);
  assert.ok(plan.audio.variant.url.endsWith('.m4a'));
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

/* ------------------------------------- puente del mundo MAIN (fibras) -- */

console.log('\nPuente del mundo de la página (page-bridge.js)');

// Datos REALES del tweet 2100475914182107353 (@axichuhai), tal y como los
// publica X: 1 manifiesto HLS y 5 variantes MP4, la mayor en 3828x2160.
const MEDIA_ID = '2100475372890472448';
const QUOTED_ID = '2100395179458924545';
const MP4 = (id, res, bitrate, hash) => ({
  content_type: 'video/mp4',
  bitrate,
  url: 'https://video.twimg.com/amplify_video/' + id + '/vid/avc1/' + res + '/' + hash + '.mp4'
});

const REAL_VIDEO_MEDIA = {
  media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/' + MEDIA_ID + '/img/5SNhLYxWgrkiSWFf.jpg',
  video_info: {
    duration_millis: 23433,
    variants: [
      {
        content_type: 'application/x-mpegURL',
        url: 'https://video.twimg.com/amplify_video/' + MEDIA_ID + '/pl/grZ8GF8UaJNPNPVu.m3u8'
      },
      MP4(MEDIA_ID, '478x270', 256000, 'cxTf03KP2JFp25vd'),
      MP4(MEDIA_ID, '638x360', 832000, 'NW26MKSvT_xJQoCS'),
      MP4(MEDIA_ID, '1276x720', 2176000, 'xddoME-f6jxBRtFG'),
      MP4(MEDIA_ID, '1914x1080', 10368000, 'l_on5WoZPWauRpZj'),
      MP4(MEDIA_ID, '3828x2160', 25128000, 'LQJXFMsY2K_Fa_F5')
    ]
  }
};

const QUOTED_VIDEO_MEDIA = {
  media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/' + QUOTED_ID + '/img/yo7llJIZrQ7qbKTZ.jpg',
  video_info: {
    duration_millis: 182666,
    variants: [
      {
        content_type: 'application/x-mpegURL',
        url: 'https://video.twimg.com/amplify_video/' + QUOTED_ID + '/pl/oc_6VLKpLtwcorAH.m3u8?v=1ae'
      },
      MP4(QUOTED_ID, '1298x720', 2176000, 'QtSdIIKgaqLM5FZd'),
      MP4(QUOTED_ID, '3840x2128', 25128000, 'ztzycpnzv-9UUg8L')
    ]
  }
};

const POSTER = REAL_VIDEO_MEDIA.media_url_https;

test('lee el manifiesto desde las props de React del reproductor (fibras)', () => {
  const bridge = loadBridge({ poster: POSTER, fiberProps: { mediaDetails: [REAL_VIDEO_MEDIA] } });
  const media = bridge.api.collectFor(MEDIA_ID, POSTER);
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0].id, MEDIA_ID);
  assert.strictEqual(media[0].variants.length, 6);
});

test('lee el manifiesto desde window.__INITIAL_STATE__ si no hay fibras', () => {
  const bridge = loadBridge({
    poster: POSTER,
    pageState: { globalObjects: { tweets: { '2100475914182107353': { mediaDetails: [REAL_VIDEO_MEDIA, QUOTED_VIDEO_MEDIA] } } } }
  });
  const media = bridge.api.collectFor(MEDIA_ID, POSTER);
  const ids = media.map((m) => m.id);
  assert.ok(ids.includes(MEDIA_ID), 'debe encontrar el video del tweet principal: ' + ids.join(','));
  assert.ok(ids.includes(QUOTED_ID), 'y tambien el de la cita, para desambiguar por id');
});

test('sin pistas devuelve todas las entidades de la pagina', () => {
  const bridge = loadBridge({
    pageState: { a: { mediaDetails: [REAL_VIDEO_MEDIA, QUOTED_VIDEO_MEDIA] } }
  });
  const media = bridge.api.collectFor('', '');
  assert.strictEqual(media.length, 2);
});

test('el saneado descarta variantes de hosts no permitidos', () => {
  const bridge = loadBridge({});
  const sucio = {
    id: 'x',
    poster: 'https://evil.example.com/p.jpg',
    variants: [
      { url: 'https://video.twimg.com/ok.mp4', contentType: 'video/mp4', bitrate: 1, height: 720 },
      { url: 'https://evil.example.com/malo.mp4', contentType: 'video/mp4', bitrate: 9, height: 2160 },
      { url: 'http://video.twimg.com/inseguro.mp4', contentType: 'video/mp4' }
    ]
  };
  const limpio = bridge.api.sanitizeEntity(sucio);
  assert.strictEqual(limpio.video_info.variants.length, 1);
  assert.strictEqual(limpio.video_info.variants[0].url, 'https://video.twimg.com/ok.mp4');
  assert.strictEqual(limpio.media_url_https, '', 'el poster de otro host se descarta');
});

test('el saneado devuelve null si no queda ninguna variante valida', () => {
  const bridge = loadBridge({});
  assert.strictEqual(bridge.api.sanitizeEntity({ variants: [{ url: 'https://evil.example.com/x.mp4' }] }), null);
  assert.strictEqual(bridge.api.sanitizeEntity(null), null);
});

test('allowedUrl solo acepta https de video.twimg.com y pbs.twimg.com', () => {
  const bridge = loadBridge({});
  assert.strictEqual(bridge.api.allowedUrl('https://video.twimg.com/a.mp4'), true);
  assert.strictEqual(bridge.api.allowedUrl('https://pbs.twimg.com/media/a.jpg'), true);
  assert.strictEqual(bridge.api.allowedUrl('http://video.twimg.com/a.mp4'), false);
  assert.strictEqual(bridge.api.allowedUrl('https://video.twimg.com.evil.com/a.mp4'), false);
  assert.strictEqual(bridge.api.allowedUrl('javascript:alert(1)'), false);
});

test('extremo a extremo: puente -> mundo aislado -> 3828x2160 y nombre _2160p', () => {
  const bridge = loadBridge({ poster: POSTER, fiberProps: { mediaDetails: [REAL_VIDEO_MEDIA] } });
  const crudo = bridge.api.collectFor(MEDIA_ID, POSTER);
  const limpio = crudo.map(bridge.api.sanitizeEntity).filter(Boolean);

  // El mundo aislado normaliza lo que le manda el puente…
  const entidad = normalizeMediaEntity(limpio[0]);
  assert.strictEqual(entidad.id, MEDIA_ID, 'el id debe coincidir con el del poster para poder desambiguar');

  // …y planifica la descarga con la máxima calidad.
  const plan = planDownload(entidad, config({ format: 'auto', quality: 'max' }));
  assert.ok(!plan.error, plan.error);
  assert.strictEqual(plan.ordered[0].height, 2160);
  assert.strictEqual(plan.ordered[0].bitrate, 25128000);
  assert.ok(plan.ordered[0].url.endsWith('/3828x2160/LQJXFMsY2K_Fa_F5.mp4'));

  const nombre = buildFilename(
    entidad,
    plan.ordered[0],
    { screenName: 'axichuhai', tweetId: '2100475914182107353', date: '2026-09-17' },
    null,
    config({ folder: 'X Videos' })
  );
  assert.strictEqual(nombre, 'X Videos/axichuhai_2100475372890472448_2160p.mp4');
});

/* ------------------------------------------- solo audio (M4A y MP3) -- */

console.log('\nSolo audio: pista AAC del HLS y conversión a MP3');

// Manifiesto REAL del tweet 2100475914182107353: tres renditions de audio solas
// (32/64/128 kbps) y cuatro de video que las referencian con AUDIO="audio-N".
const MAESTRO_REAL = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-32000",AUTOSELECT=YES,URI="/amplify_video/2100475372890472448/pl/mp4a/32000/8C8IB-E1-NEsCGYG.m3u8"',
  '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-64000",AUTOSELECT=YES,URI="/amplify_video/2100475372890472448/pl/mp4a/64000/0Y3Vk00JUsHI0b8E.m3u8"',
  '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-128000",AUTOSELECT=YES,URI="/amplify_video/2100475372890472448/pl/mp4a/128000/YWpWv8JpM4Uvknoj.m3u8"',
  '',
  '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=182065,BANDWIDTH=255989,RESOLUTION=478x270,CODECS="mp4a.40.2,avc1.4D4015",AUDIO="audio-32000"',
  '/amplify_video/2100475372890472448/pl/avc1/478x270/bpa192zkjVe3-62l.m3u8',
  '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=544456,BANDWIDTH=797324,RESOLUTION=638x360,CODECS="mp4a.40.2,avc1.4D401E",AUDIO="audio-64000"',
  '/amplify_video/2100475372890472448/pl/avc1/638x360/a-dLVZ7f0Q49ZygN.m3u8',
  '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1469151,BANDWIDTH=2101350,RESOLUTION=1276x720,CODECS="mp4a.40.2,avc1.64001F",AUDIO="audio-128000"',
  '/amplify_video/2100475372890472448/pl/avc1/1276x720/cRT-3WqCKLK2JI9A.m3u8',
  '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=4491422,BANDWIDTH=6169555,RESOLUTION=1914x1080,CODECS="mp4a.40.2,avc1.640032",AUDIO="audio-128000"',
  '/amplify_video/2100475372890472448/pl/avc1/1914x1080/ffKaF97ZjCCISsZa.m3u8'
].join('\n');

// Playlist de la rendition de 128 kbps (fMP4 con init + 8 segmentos .m4s).
const AUDIO_128 = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-TARGETDURATION:3',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MAP:URI="/amplify_video/2100475372890472448/aud/mp4a/0/0/128000/FxWAOA-dJ2i7I6Sy.mp4"',
  '#EXTINF:3.000,',
  '/amplify_video/2100475372890472448/aud/mp4a/0/3000/128000/vMsIrQl0-q7fN5uM.m4s',
  '#EXTINF:3.000,',
  '/amplify_video/2100475372890472448/aud/mp4a/3000/6000/128000/FfnhN30Y8YnXRQa_.m4s'
].join('\n');

function mediaConAudioReal() {
  const entidad = normalizeMediaEntity({
    id_str: MEDIA_ID,
    media_url_https: MEDIA.poster,
    video_info: {
      variants: MEDIA.variants.concat([
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/2100475372890472448/pl/grZ8GF8UaJNPNPVu.m3u8' }
      ])
    }
  });
  const audio = parseMasterPlaylist(
    MAESTRO_REAL,
    'https://video.twimg.com/amplify_video/2100475372890472448/pl/grZ8GF8UaJNPNPVu.m3u8'
  ).variants.filter((v) => v.audioOnly);
  return { ...entidad, variants: entidad.variants.concat(audio) };
}

test('el manifiesto real de X trae 3 pistas de audio y 4 de video', () => {
  const analizado = parseMasterPlaylist(MAESTRO_REAL, 'https://video.twimg.com/pl/x.m3u8');
  const audio = analizado.variants.filter((v) => v.audioOnly);
  assert.strictEqual(analizado.streams.length, 4);
  assert.strictEqual(audio.length, 3);
  assert.deepStrictEqual(
    Array.from(audio, (v) => Number(v.bitrate)).sort((a, b) => a - b),
    [32000, 64000, 128000]
  );
  assert.ok(audio.every((v) => /\/mp4a\/\d+\//.test(v.url)), 'las URLs llevan el bitrate');
});

test('bitrateDeAudio deduce el bitrate de la URL', () => {
  assert.strictEqual(bitrateDeAudio('https://video.twimg.com/amplify_video/1/pl/mp4a/128000/x.m3u8'), 128000);
  assert.strictEqual(bitrateDeAudio('https://video.twimg.com/amplify_video/1/aud/mp4a/0/0/64000/x.m4s'), 64000);
  assert.strictEqual(bitrateDeAudio('https://video.twimg.com/otra/cosa.m3u8'), 0);
});

test('la playlist de audio del HLS es fMP4 y tiene init + segmentos', () => {
  const playlist = parseMediaPlaylist(AUDIO_128, 'https://video.twimg.com/amplify_video/1/pl/mp4a/128000/x.m3u8');
  assert.strictEqual(playlist.isFmp4, true);
  assert.strictEqual(playlist.encrypted, false);
  assert.strictEqual(playlist.segments.length, 2);
  assert.ok(playlist.initSegment.endsWith('.mp4'));
});

test('M4A con manifiesto real elige la pista de 128 kbps', () => {
  const plan = planDownload(mediaConAudioReal(), config({ format: 'm4a' }));
  assert.ok(plan.audio, plan.error || 'debe activar el modo solo audio');
  assert.strictEqual(plan.audio.formato, 'm4a');
  assert.strictEqual(plan.audio.kbps, 128);
  assert.ok(plan.audio.variant.url.includes('/mp4a/128000/'), plan.audio.variant.url);
  assert.ok(!plan.audio.directo, 'en X va por el HLS, no por una pista progresiva');
});

test('MP3 usa la misma pista y pide conversión', () => {
  const plan = planDownload(mediaConAudioReal(), config({ format: 'mp3' }));
  assert.ok(plan.audio);
  assert.strictEqual(plan.audio.formato, 'mp3');
  assert.strictEqual(plan.audio.kbps, 128);
});

test('el archivo de audio se llama con su bitrate y su extensión', () => {
  const entidad = mediaConAudioReal();
  const plan = planDownload(entidad, config({ format: 'm4a' }));
  const contexto = { screenName: 'axichuhai', tweetId: '2100475914182871232', date: '2026-09-18' };

  const nombreM4a = buildFilename(
    entidad,
    { ...plan.audio.variant, ext: 'm4a', height: 0, bitrate: plan.audio.kbps * 1000 },
    contexto,
    null,
    config({ folder: 'X Videos' })
  );
  assert.strictEqual(nombreM4a, 'X Videos/axichuhai_' + MEDIA_ID + '_128kbps.m4a');

  const nombreMp3 = buildFilename(
    entidad,
    { ...plan.audio.variant, ext: 'mp3', height: 0, bitrate: plan.audio.kbps * 1000 },
    contexto,
    null,
    config({ folder: 'X Videos' })
  );
  assert.ok(nombreMp3.endsWith('_128kbps.mp3'), nombreMp3);
});

/* ------------------------------------------------------------------ cierre -- */

console.log('\n' + passed + ' pruebas correctas, ' + failures.length + ' fallos\n');
if (failures.length) {
  process.exitCode = 1;
}
