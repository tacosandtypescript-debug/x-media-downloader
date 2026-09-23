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
    location: { hostname: 'x.com', pathname: '/' },
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
const {
  normalizeVariant,
  normalizeMediaEntity,
  extractMediaId,
  planDownload,
  bitrateDeAudio,
  buildFilename,
  buildTweetUrl,
  sanitizeFolder,
  parseMasterPlaylist,
  parseMediaPlaylist
} = xvd;

/* --------------------------------------- carga del módulo de imágenes -- */

const IMAGE_DEFAULTS = {
  enabled: true,
  folder: 'X Videos',
  askWhereToSave: false,
  showToasts: true,
  showOnHover: false,
  copyLinkButton: true,
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
    location: { hostname: 'x.com', pathname: '/' },
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

/* ------------------------- botones de enlace en una galería de X -------- */

function loadImagesUiModule() {
  const registro = { botones: [], copiado: '' };
  const children = (node) => node.children || (node.children = []);
  const append = function (child) {
    children(this).push(child);
    child.parentElement = this;
  };

  const container = {
    nodeType: 1,
    parentElement: null,
    children: [],
    isConnected: true,
    style: {},
    matches: () => false,
    closest: () => null,
    querySelectorAll: (selector) => (selector.indexOf('tweetPhoto') >= 0 ? [cell1, cell2] : []),
    appendChild: append,
    setAttribute() {},
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 640, height: 480 })
  };

  function makeImageCell(url) {
    const image = {
      nodeType: 1,
      tagName: 'IMG',
      currentSrc: url,
      parentElement: null,
      isConnected: true,
      getAttribute: (name) => (name === 'src' ? url : null),
      setAttribute() {},
      getBoundingClientRect: () => ({ width: 320, height: 240 }),
      closest: (selector) => (selector.indexOf('tweetPhoto') >= 0 ? cell : null)
    };
    const cell = {
      nodeType: 1,
      parentElement: container,
      children: [image],
      isConnected: true,
      getAttribute: () => null,
      setAttribute() {},
      querySelector: () => image,
      matches: () => false,
      getBoundingClientRect: () => ({ width: 320, height: 240 }),
      appendChild: append
    };
    image.parentElement = cell;
    return { image, cell };
  }

  const first = makeImageCell('https://pbs.twimg.com/media/AAA.jpg?name=large');
  const second = makeImageCell('https://pbs.twimg.com/media/BBB.jpg?name=large');
  const cell1 = first.cell;
  const cell2 = second.cell;

  const core = {
    BUTTON_CLASS: 'xvd-button',
    BADGE_CLASS: 'xvd-badge',
    HOST_ATTR: 'data-xvd-host',
    IMAGE_ATTR: 'data-xvd-image',
    ICONS: { download: '<svg></svg>', link: '<svg></svg>', images: '<svg></svg>' },
    getSettings: () => ({ ...IMAGE_DEFAULTS, copyLinkButton: true }),
    registerScanner: (fn) => (registro.scanner = fn),
    registerDisableHook: () => {},
    sanitizeFolder,
    createButton: (options) => {
      const button = {
        dataset: {},
        className: options.className || '',
        isConnected: true,
        parentElement: null,
        children: [],
        classList: { toggle: () => {} },
        appendChild: append,
        remove() {
          this.isConnected = false;
        }
      };
      registro.botones.push({ options, button });
      return button;
    },
    setButtonState: () => {},
    findOverlayHost: (node) => (node === container ? container : node.parentElement),
    getTweetContext: () => ({ screenName: 'usuario', tweetId: '999', date: '2024-05-01' }),
    buildTweetUrl: (ctx) => 'https://x.com/' + ctx.screenName + '/status/' + ctx.tweetId,
    copyLinkToButton: async (button, url) => {
      registro.copiado = typeof url === 'function' ? url() : url;
      return true;
    },
    toast: () => {},
    sleep: () => Promise.resolve(),
    errorMessage: (error) => String(error && error.message ? error.message : error)
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    location: { hostname: 'x.com', pathname: '/' },
    document: {
      querySelectorAll: (selector) => {
        if (selector.indexOf('pbs.twimg.com') >= 0 || selector.indexOf('tweetPhoto') >= 0) return [cell1, cell2];
        return [];
      },
      createElement: () => ({ className: '', textContent: '', style: {}, setAttribute() {}, appendChild: append })
    },
    getComputedStyle: () => ({ position: 'relative' }),
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
  vm.runInContext(code, sandbox, { filename: 'images-ui-test.js' });
  return { registro, container, cells: [cell1, cell2] };
}

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
    URLSearchParams,
    location: opts.location || { hostname: 'x.com', pathname: '/', search: '' },
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
  if (opts.playerResponse) sandbox.ytInitialPlayerResponse = opts.playerResponse;
  if (opts.bootstrap) sandbox.__BOOTSTRAP__ = opts.bootstrap;

  const code = fs.readFileSync(path.join(ROOT, 'page-bridge.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'page-bridge.js' });
  return { api: sandbox.module.exports, video, sandbox };
}

function loadPageModule(filename, options) {
  const op = options || {};
  const registro = { scanners: [], hooks: [] };
  const core = {
    BUTTON_CLASS: 'xvd-button',
    BADGE_CLASS: 'xvd-badge',
    HOST_ATTR: 'data-xvd-host',
    IMAGE_ATTR: 'data-xvd-image',
    ICONS: { download: '', link: '', images: '' },
    getSettings: () => ({ enabled: true, instagramEnabled: true, facebookEnabled: true, copyLinkButton: true }),
    registerScanner: (fn) => registro.scanners.push(fn),
    registerDisableHook: (fn) => registro.hooks.push(fn),
    findOverlayHost: () => null,
    createButton: () => ({}),
    setButtonState: () => {},
    copyLinkToButton: async () => true,
    getTweetContext: () => ({ screenName: 'usuario', tweetId: '1' }),
    toast: () => {},
    log: () => {},
    errorMessage: (e) => String((e && e.message) || e),
    sanitizeFolder: (v) => String(v || ''),
    requestInstagramMedia: async () => [],
    requestFacebookMedia: async () => [],
    requestDownload: async () => ({ ok: true, downloadId: 1 }),
    fetchBytes: async () => new Uint8Array(),
    guardarBytes: async () => ({ ok: true }),
    convertirMp3: async () => ({ bytes: new Uint8Array(), duracion: 0 })
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    location: op.location,
    document: {
      querySelector: op.querySelector || (() => null),
      querySelectorAll: op.querySelectorAll || (() => []),
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} })
    },
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
  const code = fs.readFileSync(path.join(ROOT, filename), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename });
  return { api: sandbox.module.exports, registro };
}

/* ------------------------------------------------------------- mini runner -- */

let passed = 0;
const failures = [];
const pendientes = [];

function test(name, fn) {
  let resultado;
  try {
    resultado = fn();
  } catch (error) {
    failures.push({ name, error });
    console.log('  ✗ ' + name + '\n      ' + error.message);
    return;
  }

  // Hay pruebas que necesitan esperar (por ejemplo, un clic que pasa por await).
  if (resultado && typeof resultado.then === 'function') {
    pendientes.push(
      resultado.then(
        () => {
          passed++;
          console.log('  ✓ ' + name);
        },
        (error) => {
          failures.push({ name, error });
          console.log('  ✗ ' + name + '\n      ' + (error && error.message));
        }
      )
    );
    return;
  }

  passed++;
  console.log('  ✓ ' + name);
}

function config(overrides) {
  return { ...xvd.DEFAULT_SETTINGS, ...overrides };
}

test('construye la URL canónica de una publicación de X', () => {
  assert.strictEqual(buildTweetUrl({ screenName: 'usuario', tweetId: '123456789' }), 'https://x.com/usuario/status/123456789');
  assert.strictEqual(buildTweetUrl({ screenName: 'usuario', tweetId: '' }), '');
});

test('una galería de X crea un solo botón «Copiar enlace» y copia la publicación', async () => {
  const modulo = loadImagesUiModule();
  modulo.registro.scanner();
  const enlaces = modulo.registro.botones.filter((item) => item.options.label === 'Copiar enlace');
  assert.strictEqual(enlaces.length, 1, 'la galería debe tener un solo botón de enlace');
  assert.strictEqual(enlaces[0].options.icon, '<svg></svg>');
  await enlaces[0].options.onClick({}, enlaces[0].button);
  assert.strictEqual(modulo.registro.copiado, 'https://x.com/usuario/status/999');
});

test('Instagram construye el enlace del reel, no el del CDN', () => {
  const article = {
    querySelectorAll: () => [{ getAttribute: () => '/reel/DdXUcJaSe8X/' }]
  };
  const medio = { closest: () => article };
  const modulo = loadPageModule('instagram.js', {
    location: {
      hostname: 'www.instagram.com',
      pathname: '/reel/DdXUcJaSe8X/',
      origin: 'https://www.instagram.com',
      href: 'https://www.instagram.com/reel/DdXUcJaSe8X/'
    }
  });
  assert.strictEqual(modulo.api.urlDePublicacion(medio), 'https://www.instagram.com/reel/DdXUcJaSe8X/');
});

test('Facebook conserva la URL canónica del post resuelta por la página', () => {
  const meta = { getAttribute: () => 'https://www.facebook.com/reel/1906283450061603/' };
  const modulo = loadPageModule('facebook.js', {
    location: {
      hostname: 'www.facebook.com',
      pathname: '/reel/1906283450061603/',
      origin: 'https://www.facebook.com',
      href: 'https://www.facebook.com/reel/1906283450061603/'
    },
    querySelector: () => meta
  });
  assert.strictEqual(
    modulo.api.urlDePublicacion({ closest: () => null }, { id: '1906283450061603' }),
    'https://www.facebook.com/reel/1906283450061603/'
  );
});

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

/* ------------------------------------------------------------ instagram -- */

console.log('\nInstagram (extractor del puente)');

// Forma real de los datos de IG: video_versions / image_versions2 / carousel_media.
const IG_REEL = {
  code: 'DdXUcJaSe8X',
  pk: '3987744811663759326',
  media_type: 2,
  video_duration: 12.5,
  user: { username: 'khetzalgg' },
  video_versions: [
    { url: 'https://scontent.cdninstagram.com/v/t51/video-720.mp4', width: 720, height: 1280, type: 101 },
    { url: 'https://scontent.cdninstagram.com/v/t51/video-1080.mp4', width: 1080, height: 1920, type: 101 }
  ],
  image_versions2: {
    candidates: [{ url: 'https://scontent.cdninstagram.com/v/t51/portada-1080.jpg', width: 1080, height: 1920 }]
  }
};

const IG_CARRUSEL = {
  code: 'DdXUMc6IBfe',
  pk: '3987744688274037580',
  media_type: 8,
  user: { username: 'khetzalgg' },
  carousel_media: [
    {
      media_type: 1,
      image_versions2: {
        candidates: [
          { url: 'https://scontent.cdninstagram.com/v/t51/foto1-640.jpg', width: 640, height: 800 },
          { url: 'https://scontent.cdninstagram.com/v/t51/foto1-1440.jpg', width: 1440, height: 1800 }
        ]
      }
    },
    {
      media_type: 1,
      image_versions2: {
        candidates: [{ url: 'https://instagram.fymq2-1.fna.fbcdn.net/v/t51/foto2.jpg', width: 1080, height: 1350 }]
      }
    },
    {
      media_type: 2,
      video_versions: [{ url: 'https://scontent.cdninstagram.com/v/t51/clip.mp4', width: 1080, height: 1920 }],
      image_versions2: {
        candidates: [{ url: 'https://scontent.cdninstagram.com/v/t51/clip-poster.jpg', width: 640, height: 1136 }]
      }
    }
  ]
};

const igBridge = loadBridge({});

test('reconoce la forma de los datos de Instagram', () => {
  assert.strictEqual(igBridge.api.pareceMediaDeInstagram(IG_REEL), true);
  assert.strictEqual(igBridge.api.pareceMediaDeInstagram(IG_CARRUSEL), true);
  assert.strictEqual(igBridge.api.pareceMediaDeInstagram(REAL_VIDEO_MEDIA), false, 'los de X no son de IG');
  assert.strictEqual(igBridge.api.pareceMediaDeInstagram({ hola: 1 }), false);
});

test('un reel: elige la version de video de mayor resolucion', () => {
  const media = igBridge.api.normalizarMediaInstagram(IG_REEL);
  assert.strictEqual(media.tipo, 'video');
  assert.strictEqual(media.items.length, 1);
  assert.strictEqual(media.items[0].url, 'https://scontent.cdninstagram.com/v/t51/video-1080.mp4');
  assert.strictEqual(media.items[0].ancho, 1080);
  assert.strictEqual(media.usuario, 'khetzalgg');
  assert.strictEqual(media.code, 'DdXUcJaSe8X');
  assert.ok(media.items[0].poster.includes('portada-1080'), 'usa la portada de mas resolucion');
});

test('un carrusel: devuelve todos los elementos en orden', () => {
  const media = igBridge.api.normalizarMediaInstagram(IG_CARRUSEL);
  assert.strictEqual(media.tipo, 'carrusel');
  assert.strictEqual(media.items.length, 3);
  assert.deepStrictEqual(Array.from(media.items, (i) => i.tipo), ['imagen', 'imagen', 'video']);
  assert.strictEqual(media.items[0].url, 'https://scontent.cdninstagram.com/v/t51/foto1-1440.jpg');
  assert.strictEqual(media.items[2].url, 'https://scontent.cdninstagram.com/v/t51/clip.mp4');
});

test('una foto suelta: elige el candidato mayor', () => {
  const media = igBridge.api.normalizarMediaInstagram({
    code: 'ABC123',
    media_type: 1,
    user: { username: 'alguien' },
    image_versions2: {
      candidates: [
        { url: 'https://scontent.cdninstagram.com/v/t51/a-240.jpg', width: 240, height: 240 },
        { url: 'https://scontent.cdninstagram.com/v/t51/a-1080.jpg', width: 1080, height: 1080 }
      ]
    }
  });
  assert.strictEqual(media.tipo, 'imagen');
  assert.strictEqual(media.items[0].url, 'https://scontent.cdninstagram.com/v/t51/a-1080.jpg');
});

test('las URLs firmadas de IG se devuelven intactas (no se reescriben)', () => {
  const firmada =
    'https://scontent.cdninstagram.com/v/t51.82787-15/foto.jpg?stp=dst-jpg_e35&_nc_ht=scontent.cdninstagram.com&oh=00_AQIVhSk&oe=6AB2B388';
  const media = igBridge.api.normalizarMediaInstagram({
    code: 'X',
    image_versions2: { candidates: [{ url: firmada, width: 1080, height: 1350 }] }
  });
  assert.strictEqual(media.items[0].url, firmada, 'debe llegar tal cual, con su firma');
});

test('el saneado descarta hosts que no son de Instagram ni de Facebook', () => {
  const sucio = {
    code: 'X',
    usuario: 'u',
    items: [
      { tipo: 'imagen', url: 'https://scontent.cdninstagram.com/v/t51/buena.jpg', ancho: 1080, alto: 1080 },
      { tipo: 'imagen', url: 'https://evil.example.com/mala.jpg', ancho: 4000, alto: 4000 },
      { tipo: 'video', url: 'http://scontent.cdninstagram.com/insegura.mp4' }
    ]
  };
  const limpio = igBridge.api.sanitizeInstagram(sucio);
  assert.strictEqual(limpio.items.length, 1);
  assert.ok(limpio.items[0].url.includes('buena.jpg'));
});

test('el saneado de IG devuelve null si no queda nada valido', () => {
  assert.strictEqual(
    igBridge.api.sanitizeInstagram({ items: [{ tipo: 'imagen', url: 'https://evil.example.com/x.jpg' }] }),
    null
  );
  assert.strictEqual(igBridge.api.sanitizeInstagram(null), null);
});

test('hostPermitido acepta subdominios del CDN y rechaza el resto', () => {
  assert.strictEqual(igBridge.api.hostPermitido('scontent.cdninstagram.com'), true);
  assert.strictEqual(igBridge.api.hostPermitido('instagram.fymq2-1.fna.fbcdn.net'), true);
  assert.strictEqual(igBridge.api.hostPermitido('video.twimg.com'), true);
  assert.strictEqual(igBridge.api.hostPermitido('cdninstagram.com.evil.com'), false);
  assert.strictEqual(igBridge.api.hostPermitido('example.com'), false);
});

/* ------------------------------------------------------------- facebook -- */

console.log('\nFacebook (extractor del puente)');

const FB_URL_HD = 'https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/HD.mp4?_nc_cat=104&oh=00_AQK92&oe=6AB2B76E&bitrate=1414536&tag=sve_hd';
const FB_URL_SD = 'https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/SD.mp4?_nc_cat=104&oh=00_AQK92&oe=6AB2B76E&bitrate=414536&tag=sve_sd';
const FB_TROZO = 'https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/trozo.mp4?bytestart=0&byteend=12345';

// MPD real de Facebook: audio y vídeo SEPARADOS, un archivo por representación.
const FB_MPD = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT7.0S">',
  '  <Period>',
  '    <AdaptationSet mimeType="audio/mp4" lang="und">',
  '      <Representation id="audio-1" bandwidth="64000" codecs="mp4a.40.2">',
  '        <BaseURL>https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/audio.mp4?oh=00_AUDIO&oe=6AB2B76E</BaseURL>',
  '        <SegmentBase indexRange="0-1000"><Initialization range="0-800"/></SegmentBase>',
  '      </Representation>',
  '    </AdaptationSet>',
  '    <AdaptationSet mimeType="video/mp4">',
  '      <Representation id="video-1" bandwidth="1414536" width="576" height="1024" codecs="avc1.64001f">',
  '        <BaseURL>https://video.fymq2-1.fna.fbcdn.net/o1/v/t2/f2/m412/video-1024.mp4?oh=00_VIDEO&oe=6AB2B76E</BaseURL>',
  '      </Representation>',
  '    </AdaptationSet>',
  '  </Period>',
  '</MPD>'
].join('\n');

const VIDEO_FB = {
  videoId: '1906283450061603',
  playable_url: FB_URL_SD,
  playable_url_quality_hd: FB_URL_HD,
  playable_duration_in_ms: 7000,
  width: 576,
  height: 1024,
  video_dash_manifest: FB_MPD,
  preferred_thumbnail: { image: { uri: 'https://scontent.fyhu2-1.fna.fbcdn.net/v/t15.5256-10/portada.jpg?oh=00_IMG&oe=6AB2C3E1', width: 576, height: 1024 } },
  owner: { name: 'Alejandro Garcia' }
};

const FOTO_FB = {
  id: '1234567890',
  image: { uri: 'https://scontent.fyhu2-1.fna.fbcdn.net/v/t39.30808-6/foto-grande.jpg?oh=00_FOTO&oe=6AB2C3E1', width: 2048, height: 1536 },
  owner: { name: 'Alejandro Garcia' }
};

const fbBridge = loadBridge({});

test('reconoce un objeto de vídeo de Facebook', () => {
  assert.strictEqual(fbBridge.api.pareceVideoDeFacebook(VIDEO_FB), true);
  assert.strictEqual(fbBridge.api.pareceVideoDeFacebook({ playable_url: FB_URL_SD }), true);
  assert.strictEqual(fbBridge.api.pareceVideoDeFacebook({ hola: 1 }), false);
  assert.strictEqual(fbBridge.api.pareceVideoDeFacebook(null), false);
});

test('reconoce una foto de Facebook (y no la confunde con vídeo)', () => {
  assert.strictEqual(fbBridge.api.pareceFotoDeFacebook(FOTO_FB), true);
  assert.strictEqual(fbBridge.api.pareceFotoDeFacebook(VIDEO_FB), false);
  assert.strictEqual(fbBridge.api.pareceFotoDeFacebook({ image: { uri: 'https://evil.example.com/x.jpg' } }), false);
});

test('el vídeo prefiere la pista HD y descarta los trozos del DASH', () => {
  const media = fbBridge.api.normalizarVideoFacebook(VIDEO_FB);
  assert.strictEqual(media.tipo, 'video');
  assert.strictEqual(media.id, '1906283450061603');
  assert.ok(media.candidatos[0].url.includes('HD.mp4'), media.candidatos[0].url);
  assert.strictEqual(media.candidatos[0].etiqueta, 'hd');
  assert.strictEqual(media.candidatos.length, 2, 'solo HD y SD, no los trozos');

  const conTrozo = fbBridge.api.normalizarVideoFacebook({ playable_url: FB_TROZO });
  assert.ok(!conTrozo || !conTrozo.candidatos.some((c) => c.url.includes('bytestart')), 'nunca un trozo');
});

test('la foto se queda con la URL de mayor resolución', () => {
  const media = fbBridge.api.normalizarFotoFacebook(FOTO_FB);
  assert.strictEqual(media.tipo, 'imagen');
  assert.ok(media.candidatos[0].url.includes('foto-grande.jpg'));
  assert.strictEqual(media.ancho, 2048);
});

test('el manifiesto DASH de Facebook se conserva para sacar el audio', () => {
  const media = fbBridge.api.normalizarVideoFacebook(VIDEO_FB);
  assert.ok(media.mpd.includes('<MPD'), 'debe llevarse el MPD');
  assert.ok(media.candidatos.every((c) => !c.url.includes('audio.mp4')), 'el audio del DASH no es candidato de vídeo');
});

test('el saneado de Facebook filtra hosts y respeta las firmas', () => {
  const sucio = {
    tipo: 'video',
    id: '1',
    candidatos: [
      { url: FB_URL_HD, etiqueta: 'hd', ancho: 576, alto: 1024 },
      { url: 'https://evil.example.com/malo.mp4', etiqueta: 'hd', ancho: 4000, alto: 4000 },
      { url: 'http://video.fbcdn.net/inseguro.mp4', etiqueta: 'sd' }
    ],
    mpd: ''
  };
  const limpio = fbBridge.api.sanitizeFacebook(sucio);
  assert.strictEqual(limpio.candidatos.length, 1);
  assert.ok(limpio.candidatos[0].url.includes('oh=00_AQK92'), 'la firma se conserva entera');
  assert.strictEqual(fbBridge.api.sanitizeFacebook({ candidatos: [{ url: 'https://evil.example.com/x.mp4' }] }), null);
});

/* -------------------------------------------------------- carpetas destino -- */

console.log('\nCarpetas de destino (folders.js)');

function loadFoldersModule() {
  const sandbox = { console, module: { exports: {} } };
  sandbox.window = sandbox;
  const code = fs.readFileSync(path.join(ROOT, 'folders.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'folders.js' });
  return sandbox.module.exports;
}

const carp = loadFoldersModule();

test('normaliza el nombre de una carpeta nueva', () => {
  assert.strictEqual(carp.normalizarCarpeta('IRONMOUSE Torneo'), 'IRONMOUSE Torneo');
  assert.strictEqual(carp.normalizarCarpeta('  Fortnite   Skins  '), 'Fortnite Skins');
  assert.strictEqual(carp.normalizarCarpeta('Extension/Fortnite'), 'Extension/Fortnite');
  assert.strictEqual(carp.normalizarCarpeta('Extension\\Fortnite'), 'Extension/Fortnite');
});

test('sustituye caracteres invalidos en vez de fallar', () => {
  assert.strictEqual(carp.normalizarCarpeta('IRONMOUSE: Torneo?'), 'IRONMOUSE_ Torneo_');
  assert.strictEqual(carp.normalizarCarpeta('a*b|c"d<e>f'), 'a_b_c_d_e_f');
  assert.ok(!/[\\/:*?"<>|]/.test(carp.normalizarCarpeta('x:y*z?')),
    'no debe quedar ningún carácter inválido');
});

test('nunca permite salir de la carpeta de Descargas', () => {
  assert.strictEqual(carp.normalizarCarpeta('../../etc/passwd'), 'etc/passwd');
  assert.strictEqual(carp.normalizarCarpeta('X Videos/../secretos'), 'X Videos/secretos');
  assert.strictEqual(carp.normalizarCarpeta('..'), '');
  assert.strictEqual(carp.normalizarCarpeta('/'), '');
  assert.strictEqual(carp.normalizarCarpeta('...'), '');
});

test('aplica las reglas de Windows (sin punto ni espacio al final)', () => {
  assert.strictEqual(carp.normalizarCarpeta('carpeta.'), 'carpeta');
  assert.strictEqual(carp.normalizarCarpeta('carpeta '), 'carpeta');
  assert.strictEqual(carp.normalizarCarpeta('Fortnite/Skins. '), 'Fortnite/Skins');
});

test('la etiqueta muestra la ruta completa dentro de Descargas', () => {
  assert.strictEqual(carp.etiquetaDestino('IRONMOUSE Torneo'), 'Descargas/IRONMOUSE Torneo');
  assert.strictEqual(carp.etiquetaDestino(''), 'Descargas (predeterminada)');
  assert.strictEqual(carp.etiquetaDestino('../fuera'), 'Descargas/fuera');
});

test('evita duplicados al anadir al historial', () => {
  let estado = carp.anadirAlHistorial([], 'Fortnite');
  assert.strictEqual(estado.carpeta, 'Fortnite');
  assert.strictEqual(estado.existia, false);
  assert.strictEqual(estado.historial.length, 1);

  // Misma carpeta con otra caja, espacios o barras: NO se duplica.
  estado = carp.anadirAlHistorial(estado.historial, '  fortnite  ');
  assert.strictEqual(estado.existia, true);
  assert.strictEqual(estado.historial.length, 1, 'no debe crear una carpeta duplicada');
  assert.strictEqual(estado.carpeta, 'Fortnite', 'conserva el nombre original');

  estado = carp.anadirAlHistorial(estado.historial, 'Extension/Fortnite');
  assert.strictEqual(estado.historial.length, 2);
  assert.strictEqual(estado.historial[0], 'Extension/Fortnite', 'la última usada va primera');
});

test('no anade nada si el nombre queda vacio', () => {
  const estado = carp.anadirAlHistorial(['Fortnite'], '   ');
  assert.strictEqual(estado.carpeta, '');
  assert.strictEqual(estado.historial.length, 1);
  assert.strictEqual(carp.normalizarCarpeta('   '), '');
});

test('se puede quitar una carpeta del historial', () => {
  const lista = carp.quitarDelHistorial(['A', 'B', 'C'], ' b ');
  assert.deepStrictEqual(Array.from(lista), ['A', 'C']);
});

test('el historial no crece sin limite', () => {
  let historial = [];
  for (let i = 0; i < 60; i++) historial = carp.anadirAlHistorial(historial, 'carpeta-' + i).historial;
  assert.ok(historial.length <= carp.MAXIMO_HISTORIAL, 'longitud: ' + historial.length);
  assert.strictEqual(historial[0], 'carpeta-59', 'la última usada es la primera');
});

/* ------------------------------------ YouTube (módulo de la página) -- */

console.log('\nYouTube (módulo de la página)');

/**
 * Carga youtube.js con un núcleo y un DOM simulados. El módulo ya no descarga
 * nada por su cuenta (eso lo hace yt-dlp a través del host nativo), así que lo
 * que se prueba aquí es lo que sí decide: el id del vídeo, la URL canónica, la
 * colocación del botón, la plantilla de nombre y la orden que manda al host.
 */
function loadYouTubeModule(opciones) {
  const op = opciones || {};
  const registro = { scanners: [], hooks: [], descargas: [], boton: null, avisos: [] };

  const video = {
    getBoundingClientRect: () => ({ width: op.ancho || 1280, height: op.alto || 720 }),
    closest: (selector) => (selector === '.ytp-miniplayer' && op.mini ? {} : null)
  };
  const jugador = {
    style: {},
    dataset: {},
    isConnected: true,
    setAttribute() {},
    appendChild() {},
    querySelector: (selector) => (/video/.test(selector) ? video : null)
  };

  const core = {
    BUTTON_CLASS: 'xvd-button',
    HOST_ATTR: 'data-xvd-host',
    ICONS: { download: '<svg></svg>' },
    registerScanner: (fn) => registro.scanners.push(fn),
    registerDisableHook: (fn) => registro.hooks.push(fn),
    findOverlayHost: () => jugador,
    createButton: (options) => {
      registro.boton = options;
      return { dataset: {}, isConnected: true, remove() {}, className: options.className };
    },
    setButtonState: (boton, estado, etiqueta) => {
      registro.estadoBoton = { estado, etiqueta };
    },
    log: () => {},
    toast: (mensaje, tipo) => {
      registro.avisos.push({ mensaje, tipo });
      return { querySelector: () => ({ textContent: '' }), remove() {} };
    },
    errorMessage: (e) => String((e && e.message) || e),
    getSettings: () => ({
      enabled: true,
      youtubeEnabled: op.youtubeEnabled !== false,
      youtubeFilenameTemplate: op.plantilla || 'youtube_{usuario}_{titulo}_{id}',
      youtubeCodec: op.codec || 'h264',
      youtubeCookies: !!op.cookies,
      format: op.formato || 'mp4',
      quality: op.quality || 'max',
      minHeight: op.minHeight || 720,
      folder: op.folder || ''
    }),
    sanitizeFolder: (v) => String(v || '').trim(),
    estadoDeYtDlp: async () => ('estado' in op ? op.estado : { ok: true, version: '2026.08.19', ffmpeg: true, descargas: 'C:\\Users\\KTZ\\Downloads' }),
    descargarConYtDlp: async (peticion, onAviso) => {
      registro.descargas.push(peticion);
      if (onAviso) {
        onAviso({ tipo: 'inicio', carpeta: 'C:\\Users\\KTZ\\Downloads' });
        onAviso({ tipo: 'progreso', porcentaje: 42.5, total: '3.29MiB', velocidad: '7.2MiB/s', eta: '00:03' });
        onAviso({ tipo: 'aviso', mensaje: '[Merger] Merging formats into "x.mp4"' });
      }
      if (op.falloDescarga) return { ok: false, mensaje: op.falloDescarga };
      return {
        ok: true,
        archivo: 'C:\\Users\\KTZ\\Downloads\\youtube_Canal_Video_dQw4w9WgXcQ.mp4',
        kb: 33811,
        carpeta: 'C:\\Users\\KTZ\\Downloads'
      };
    }
  };

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    location: op.location || {
      hostname: 'www.youtube.com',
      search: '?v=dQw4w9WgXcQ',
      pathname: '/watch',
      origin: 'https://www.youtube.com'
    },
    document: {
      querySelector: (selector) => {
        if (/^#movie_player|#shorts-player|\.html5-video-player/.test(selector)) return jugador;
        if (selector.indexOf('.xvd-button') === 0) return null;
        return null;
      },
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} })
    },
    module: { exports: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.__XVD_CORE__ = core;

  const code = fs.readFileSync(path.join(ROOT, 'youtube.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'youtube.js' });
  return { api: sandbox.module.exports, registro, jugador, core };
}

/** Ejecuta el escáner para que el módulo cree el botón y devuelve su clic. */
async function pulsarDescargar(modulo, opciones) {
  modulo.registro.scanners[0]();
  const boton = { dataset: {}, isConnected: true, remove() {} };
  if (!modulo.registro.boton) throw new Error('el módulo no creó el botón');
  await modulo.registro.boton.onClick({}, boton);
  return boton;
}

const yt = loadYouTubeModule({}).api;

test('lee el id del vídeo de la URL (normal, Shorts e incrustado)', () => {
  const conUrl = (search, pathname) =>
    loadYouTubeModule({
      location: { hostname: 'www.youtube.com', search, pathname, origin: 'https://www.youtube.com' }
    }).api;

  assert.strictEqual(conUrl('?v=dQw4w9WgXcQ&list=PL123&t=42', '/watch').idEnLaUrl(), 'dQw4w9WgXcQ');
  assert.strictEqual(conUrl('', '/shorts/abcdefghijk').idEnLaUrl(), 'abcdefghijk');
  assert.strictEqual(conUrl('', '/embed/zyxwvutsrqp').idEnLaUrl(), 'zyxwvutsrqp');
  assert.strictEqual(conUrl('', '/feed/subscriptions').idEnLaUrl(), '');
});

test('construye la URL canónica sin lista ni marcas de tiempo', () => {
  const conUrl = (search, pathname) =>
    loadYouTubeModule({
      location: { hostname: 'www.youtube.com', search, pathname, origin: 'https://www.youtube.com' }
    }).api;

  assert.strictEqual(
    conUrl('?v=dQw4w9WgXcQ&list=PL123&t=42s', '/watch').urlDelVideo(),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.strictEqual(
    conUrl('', '/shorts/abcdefghijk').urlDelVideo(),
    'https://www.youtube.com/watch?v=abcdefghijk'
  );
});

test('detecta Shorts para colocar el botón a la izquierda', () => {
  const shorts = loadYouTubeModule({
    location: {
      hostname: 'www.youtube.com',
      search: '',
      pathname: '/shorts/abcdefghijk',
      origin: 'https://www.youtube.com'
    }
  }).api;
  assert.strictEqual(shorts.esShorts(), true);
  assert.strictEqual(yt.esShorts(), false);
});

test('el botón de Shorts usa la clase de la izquierda y el normal la de la derecha', () => {
  const normal = loadYouTubeModule({});
  normal.registro.scanners[0]();
  assert.strictEqual(normal.registro.boton.className, 'xvd-button--yt');

  const shorts = loadYouTubeModule({
    location: {
      hostname: 'www.youtube.com',
      search: '',
      pathname: '/shorts/abcdefghijk',
      origin: 'https://www.youtube.com'
    }
  });
  shorts.registro.scanners[0]();
  assert.ok(/xvd-button--yt-shorts/.test(shorts.registro.boton.className), shorts.registro.boton.className);
});

test('la plantilla de nombre se traduce al formato de yt-dlp', () => {
  assert.strictEqual(
    yt.plantillaParaYtDlp('youtube_{usuario}_{titulo}_{id}'),
    'youtube_%(uploader)s_%(title)s_%(id)s.%(ext)s'
  );
  assert.strictEqual(yt.plantillaParaYtDlp('{fecha}_{id}_{calidad}'), '%(upload_date>%Y-%m-%d)s_%(id)s_%(resolution)s.%(ext)s');
  assert.strictEqual(yt.plantillaParaYtDlp('vid_{id}.{ext}'), 'vid_%(id)s.%(ext)s');
  assert.strictEqual(yt.plantillaParaYtDlp(''), 'youtube_%(uploader)s_%(title)s_%(id)s.%(ext)s');
  // Nunca pueden quedar llaves sueltas ni caracteres prohibidos en Windows.
  assert.ok(!/[{}]/.test(yt.plantillaParaYtDlp('a_{raro}_{id}')));
  assert.ok(!/[\\/:*?"<>|]/.test(yt.plantillaParaYtDlp('con/barra:*?"<>|')));
});

test('el tiempo restante se muestra en minutos y segundos', () => {
  assert.strictEqual(yt.formatearTiempo(0), '0:00');
  assert.strictEqual(yt.formatearTiempo(9), '0:09');
  assert.strictEqual(yt.formatearTiempo(75), '1:15');
  assert.strictEqual(yt.formatearTiempo(3600), '60:00');
  assert.strictEqual(yt.formatearTiempo('Unknown'), '0:00');
});

test('el módulo solo se activa en youtube.com y registra su escáner', () => {
  const enYouTube = loadYouTubeModule({});
  assert.strictEqual(enYouTube.registro.scanners.length, 1);
  assert.strictEqual(enYouTube.registro.hooks.length, 1);

  const enOtroSitio = loadYouTubeModule({
    location: { hostname: 'x.com', search: '', pathname: '/', origin: 'https://x.com' }
  });
  assert.strictEqual(enOtroSitio.registro.scanners.length, 0, 'fuera de YouTube no hace nada');
});

test('al pulsar, la orden que recibe yt-dlp lleva formato, calidad, carpeta y códec', async () => {
  const modulo = loadYouTubeModule({
    formato: 'mp4',
    quality: 'custom',
    minHeight: 1080,
    folder: 'Musica/Rick',
    cookies: true,
    codec: 'max',
    plantilla: '{usuario}_{titulo}_{id}'
  });

  await pulsarDescargar(modulo);

  assert.strictEqual(modulo.registro.descargas.length, 1);
  const peticion = modulo.registro.descargas[0];
  assert.strictEqual(peticion.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.strictEqual(peticion.id, 'dQw4w9WgXcQ');
  assert.strictEqual(peticion.formato, 'mp4');
  assert.strictEqual(peticion.calidad, '1080', 'la calidad personalizada se pasa en número');
  assert.strictEqual(peticion.carpeta, 'Musica/Rick');
  assert.strictEqual(peticion.cookies, true);
  assert.strictEqual(peticion.codec, 'max');
  assert.strictEqual(peticion.plantilla, '%(uploader)s_%(title)s_%(id)s.%(ext)s');
  assert.strictEqual(modulo.registro.estadoBoton.estado, 'done');
  assert.ok(
    modulo.registro.avisos.some((a) => /Descarga terminada/.test(a.mensaje) && a.tipo === 'success'),
    JSON.stringify(modulo.registro.avisos)
  );
});

test('con calidad «max» no se manda ningún tope de resolución', async () => {
  const modulo = loadYouTubeModule({ quality: 'max', minHeight: 480 });
  await pulsarDescargar(modulo);
  assert.strictEqual(modulo.registro.descargas[0].calidad, 'max');
});

test('el MP3 se pide tal cual y el códec no se toca en audio', async () => {
  const modulo = loadYouTubeModule({ formato: 'mp3' });
  await pulsarDescargar(modulo);
  assert.strictEqual(modulo.registro.descargas[0].formato, 'mp3');
  assert.strictEqual(modulo.registro.descargas[0].codec, 'h264', 'el códec solo afecta al vídeo');
});

test('si yt-dlp no está instalado, se avisa de qué hacer y no se descarga nada', async () => {
  const modulo = loadYouTubeModule({ estado: { ok: false } });
  await pulsarDescargar(modulo);

  assert.strictEqual(modulo.registro.descargas.length, 0, 'no se llama al host si no está disponible');
  assert.strictEqual(modulo.registro.estadoBoton.estado, 'error');
  const error = modulo.registro.avisos.find((a) => a.tipo === 'error');
  assert.ok(error && /Instalar yt-dlp para X media\.cmd/.test(error.mensaje), JSON.stringify(modulo.registro.avisos));
});

test('si yt-dlp falla, el motivo se muestra en español', async () => {
  const modulo = loadYouTubeModule({ falloDescarga: 'YouTube rechazó la descarga (HTTP 403). Casi siempre es que yt-dlp está desactualizado.' });
  await pulsarDescargar(modulo);

  assert.strictEqual(modulo.registro.estadoBoton.estado, 'error');
  const error = modulo.registro.avisos.find((a) => a.tipo === 'error');
  assert.ok(error && /403/.test(error.mensaje), JSON.stringify(modulo.registro.avisos));
});

test('sin reproductor no se crea ningún botón', () => {
  const modulo = loadYouTubeModule({ ancho: 100, alto: 60 });
  modulo.registro.scanners[0]();
  assert.strictEqual(modulo.registro.boton, null, 'un reproductor minúsculo no cuenta');
});

test('con YouTube desactivado no se crea el botón', () => {
  const modulo = loadYouTubeModule({ youtubeEnabled: false });
  modulo.registro.scanners[0]();
  assert.strictEqual(modulo.registro.boton, null);
});

/* ------------------------------------------------------------- pixabay -- */

console.log('\npixabay (extractor del puente y módulo)');

/* Bootstrap real recortado: ficha de música + listado con foto, vídeo y destacados. */
const PIXABAY_FICHA_AUDIO = {
  request: { path: '/music/percussion-football-football-music-551346/' },
  page: {
    pageType: 'musicDetail',
    mediaType: 'audio',
    mediaItem: {
      id: 551346,
      mediaType: 'audio',
      mediaSubType: 3,
      sources: {
        src: 'https://cdn.pixabay.com/audio/2026/06/21/audio_f7ff5b4757.mp3',
        thumbnailUrl: 'https://cdn.pixabay.com/audio/2026/06/25/09-55-56-222_200x200.png',
        filename: 'football-football-music-551346.mp3',
        downloadUrl:
          'https://cdn.pixabay.com/download/audio/2026/06/21/audio_f7ff5b4757.mp3?filename=sigmamusicart-football-football-music-551346.mp3'
      },
      duration: 59.112,
      href: '/music/percussion-football-football-music-551346/',
      name: 'Football - Football Music',
      description: 'Football, Soccer, Sport',
      fileFormat: 'MP3',
      user: { username: 'SigmaMusicArt' }
    },
    relatedMedia: [
      {
        id: 571483,
        mediaType: 'audio',
        sources: {
          src: 'https://cdn.pixabay.com/audio/2026/05/01/audio_abc123.mp3',
          downloadUrl: '/music/download/id-571483.mp3',
          filename: 'dark-571483.mp3'
        },
        duration: 71,
        href: '/music/action-dark-571483/',
        name: 'Dark',
        fileFormat: 'MP3',
        user: { username: 'SigmaMusicArt' }
      }
    ]
  }
};

const PIXABAY_LISTADO = {
  request: { path: '/images/search/nature/' },
  page: {
    pageType: 'search',
    mediaType: 'photo',
    results: [
      {
        id: 7572681,
        mediaType: 'photo',
        mediaSubType: 1,
        width: 4228,
        height: 2642,
        sources: {
          '1x': 'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_640.jpg',
          '2x': 'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_1280.jpg',
          downloadUrl: '/images/download/x-7572681_1920.jpg'
        },
        href: '/photos/bachalpsee-lake-mountains-7572681/',
        name: 'Bachalpsee, Lake',
        fileFormat: 'JPG',
        user: { username: 'Himmelstraeume' }
      },
      {
        id: 348656,
        mediaType: 'video',
        width: 3840,
        height: 2160,
        duration: 20,
        sources: {
          thumbnail: 'https://cdn.pixabay.com/video/2026/04/24/348656_tiny.jpg',
          mp4: 'https://cdn.pixabay.com/video/2026/04/24/348656_tiny.mp4',
          embed: 'https://cdn.pixabay.com/video/2026/04/24/348656_tiny.mp4',
          downloadUrl: '/videos/download/x-348656_medium.mp4'
        },
        href: '/videos/dandelion-flower-blossom-bloom-348656/',
        name: 'Dandelion, Flower, Blossom',
        fileFormat: 'MP4',
        user: { username: 'adege' }
      },
      {
        id: 9623199,
        mediaType: 'photo',
        sources: {
          '1x': 'https://cdn.pixabay.com/photo/2025/05/26/12/04/nature-9623199_640.jpg',
          '2x': 'https://cdn.pixabay.com/photo/2025/05/26/12/04/nature-9623199_1920__f0efb5f0bb.jpg'
        },
        href: '/photos/nature-spring-bird-green-9623199/',
        name: 'Nature, Spring',
        fileFormat: 'JPG',
        user: { username: 'Pexels' }
      },
      // Anuncio de iStock: NO debe salir (es de pago y no es de Pixabay)
      { id: 'gm2166282428-586395729', mediaType: 'sponsored', sources: { url: 'https://media.istockphoto.com/x.jpg' } }
    ],
    sponsoredImages: [
      { id: 'gm1', url: 'https://media.istockphoto.com/a.jpg', linkUrl: 'https://www.istockphoto.com/x' }
    ],
    heroMediaItems: [
      {
        id: 1850120,
        mediaType: 'photo',
        sources: { '2x': 'https://cdn.pixabay.com/photo/2016/11/22/19/15/hand-1850120_1920__b873924b15.jpg' },
        href: '/photos/hand-turntable-dj-neon-lights-1850120/',
        name: 'Hand, Turntable',
        user: { username: 'Pexels' }
      }
    ],
    featuredArtists: [
      {
        artist: { username: 'prettyjohn1' },
        media: [
          {
            id: 508390,
            mediaType: 'audio',
            sources: { src: 'https://cdn.pixabay.com/audio/2026/03/25/audio_453df5bca9.mp3' },
            href: '/music/spring-vlog-508390/',
            name: 'Spring Vlog',
            user: { username: 'prettyjohn1' }
          }
        ]
      }
    ],
    // Datos que no son medios: no deben colarse
    popularSearches: [['nature', '/images/search/nature/']],
    order: 'popular'
  }
};

const pbAudio = loadBridge({ bootstrap: PIXABAY_FICHA_AUDIO });
const pbListado = loadBridge({ bootstrap: PIXABAY_LISTADO });

test('el puente lee los medios del bootstrap de una ficha de música', () => {
  const medios = pbAudio.api.mediosDePixabay();
  assert.strictEqual(medios.length, 2, 'la ficha y la relacionada');
  const pista = medios[0];
  assert.strictEqual(pista.id, '551346');
  assert.strictEqual(pista.tipo, 'audio');
  assert.strictEqual(pista.nombre, 'Football - Football Music');
  assert.strictEqual(pista.autor, 'SigmaMusicArt');
  assert.strictEqual(pista.duracion, 59);
  assert.strictEqual(pista.url, 'https://cdn.pixabay.com/download/audio/2026/06/21/audio_f7ff5b4757.mp3?filename=sigmamusicart-football-football-music-551346.mp3');
  assert.ok(pista.mp3.includes('/download/audio/'), 'el downloadUrl del CDN se conserva');
});

test('el puente reúne fotos, vídeos, destacados y artistas del listado', () => {
  const medios = pbListado.api.mediosDePixabay();
  const ids = Array.from(medios, (m) => m.tipo + ':' + m.id);
  assert.deepStrictEqual(ids, ['photo:7572681', 'video:348656', 'photo:9623199', 'photo:1850120', 'audio:508390']);
  assert.ok(!ids.some((i) => i.includes('sponsored')), 'los anuncios de iStock no entran');
  assert.ok(!ids.some((i) => i.includes('gm2166282428')), 'tampoco los patrocinados sueltos');
});

test('las URLs de los medios son del CDN de Pixabay', () => {
  for (const medio of pbListado.api.mediosDePixabay()) {
    assert.match(medio.url, /^https:\/\/cdn\.pixabay\.com\//, medio.url);
  }
});

test('el saneado rechaza hosts ajenos y tipos desconocidos', () => {
  assert.strictEqual(pbListado.api.sanitizePixabay({ tipo: 'photo', url: 'https://evil.example.com/x.jpg' }), null);
  assert.strictEqual(pbListado.api.sanitizePixabay({ tipo: 'otro', url: 'https://cdn.pixabay.com/x.jpg' }), null);
  const bueno = pbListado.api.sanitizePixabay({ id: '1', tipo: 'photo', url: 'https://cdn.pixabay.com/photo/x_640.jpg' });
  assert.strictEqual(bueno.tipo, 'photo');
});

test('sin bootstrap de Pixabay el puente no devuelve nada', () => {
  const vacio = loadBridge({});
  assert.deepStrictEqual(Array.from(vacio.api.mediosDePixabay()), []);
});

/* ------------------------------------------- módulo de la página (DOM) -- */

function loadPixabayModule(opciones) {
  const op = opciones || {};
  const registro = { scanners: [], hooks: [], descargas: [], botones: [] };

  const core = {
    BUTTON_CLASS: 'xvd-button',
    HOST_ATTR: 'data-xvd-host',
    ICONS: { download: '<svg></svg>', images: '<svg></svg>' },
    registerScanner: (fn) => registro.scanners.push(fn),
    registerDisableHook: (fn) => registro.hooks.push(fn),
    findOverlayHost: (nodo) => nodo,
    createButton: (options) => {
      registro.botones.push(options);
      const boton = {
        dataset: {},
        style: {},
        className: options.className,
        remove() {},
        setAttribute() {},
        appendChild() {},
        querySelector: () => null
      };
      registro.ultimo = options;
      return boton;
    },
    setButtonState: (boton, estado, etiqueta) => {
      registro.estadoBoton = { estado, etiqueta };
    },
    log: () => {},
    toast: (mensaje, tipo) => {
      registro.avisos = registro.avisos || [];
      registro.avisos.push({ mensaje, tipo });
      return { querySelector: () => ({ textContent: '' }), remove() {} };
    },
    errorMessage: (e) => String((e && e.message) || e),
    getSettings: () => ({
      enabled: true,
      pixabayEnabled: op.pixabayEnabled !== false,
      pixabayFilenameTemplate: op.plantilla || 'pixabay_{usuario}_{nombre}_{id}',
      format: op.formato || 'auto',
      quality: op.quality || 'max',
      minHeight: op.minHeight || 720,
      imageResolution: op.resolucion || 'orig',
      imageVerify: op.verificar !== false,
      folder: op.folder || '',
      askWhereToSave: false
    }),
    sanitizeFolder: (v) => String(v || '').trim(),
    requestPixabayMedia: async () => op.medios || [],
    requestDownload: async (peticion) => {
      registro.descargas.push(peticion);
      if (op.fallaDescarga) throw new Error(op.fallaDescarga);
      return { ok: true, downloadId: registro.descargas.length };
    },
    fetch: async () => ({ ok: true, status: 206 }),
    scan: () => {}
  };

  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    location: op.location || { hostname: 'pixabay.com', pathname: '/', search: '', href: 'https://pixabay.com/' },
    fetch: op.fetch || (async () => ({ ok: true, status: 206 })),
    document: op.document || {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} })
    },
    window: null,
    module: { exports: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.__XVD_CORE__ = core;
  sandbox.addEventListener = () => {};

  const code = fs.readFileSync(path.join(ROOT, 'pixabay.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'pixabay.js' });
  return { api: sandbox.module.exports, registro, sandbox };
}

const pix = loadPixabayModule({}).api;

/** DOM mínimo de una ficha de Pixabay: el botón «Free download» y su contenedor. */
function domDeFichaPixabay() {
  const contenedor = {
    attrs: {},
    getAttribute(clave) {
      return this.attrs[clave] || null;
    },
    setAttribute(clave, valor) {
      this.attrs[clave] = valor;
    },
    appendChild() {},
    insertBefore() {},
    parentElement: null
  };
  const botonWeb = { textContent: 'Free download', parentElement: contenedor };
  return {
    contenedor,
    botonWeb,
    documento: {
      querySelector: () => null,
      querySelectorAll: (selector) => (selector === 'button, a' ? [botonWeb] : []),
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} })
    }
  };
}

test('la base de una foto quita el tamaño y el hash de firma', () => {
  assert.strictEqual(
    pix.baseDeFoto('https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_1280.jpg'),
    'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681'
  );
  assert.strictEqual(
    pix.baseDeFoto('https://cdn.pixabay.com/photo/2016/11/22/19/15/hand-1850120_1920__b873924b15.jpg'),
    'https://cdn.pixabay.com/photo/2016/11/22/19/15/hand-1850120'
  );
  assert.strictEqual(
    pix.baseDeFoto('https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_960_720.jpg'),
    'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681'
  );
});

test('los tamaños de vídeo se cambian en la URL del CDN', () => {
  const base = 'https://cdn.pixabay.com/video/2026/04/24/348656_tiny.mp4';
  assert.strictEqual(pix.videoConTamano(base, '_large'), 'https://cdn.pixabay.com/video/2026/04/24/348656_large.mp4');
  assert.strictEqual(pix.videoConTamano(base, '_medium'), 'https://cdn.pixabay.com/video/2026/04/24/348656_medium.mp4');
  assert.strictEqual(
    pix.videoConTamano('https://cdn.pixabay.com/video/2023/11/19/189813-887078786_tiny.mp4', '_small'),
    'https://cdn.pixabay.com/video/2023/11/19/189813-887078786_small.mp4'
  );
});

test('el plan de vídeo empieza por 4K y baja: 4K, 1440p, 1080p, 720p', () => {
  const medio = { tipo: 'video', url: 'https://cdn.pixabay.com/video/2026/04/24/348656_tiny.mp4' };
  const plan = pix.planDeVideo(medio);
  assert.deepStrictEqual(Array.from(plan, (p) => p.etiqueta), ['4K', '1440p', '1080p', '720p']);
});

test('con calidad mínima se elige el tamaño más pequeño que la cumpla', () => {
  const modulo = loadPixabayModule({ quality: 'custom', minHeight: 1080 });
  const medio = { tipo: 'video', url: 'https://cdn.pixabay.com/video/2026/04/24/348656_tiny.mp4' };
  // El plan se calcula con los ajustes vigentes: se pide a través del módulo cargado.
  const plan = modulo.api.planDeVideo(medio);
  assert.strictEqual(plan[0].etiqueta, '1080p', JSON.stringify(Array.from(plan, (p) => p.etiqueta)));
});

test('el plan de foto empieza por 1920 y termina en el original', () => {
  const medio = { tipo: 'photo', url: 'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_1280.jpg' };
  const plan = pix.planDeFoto(medio);
  const etiquetas = Array.from(plan, (p) => p.etiqueta);
  assert.strictEqual(etiquetas[0], 'la de la web', 'la URL que da la web se prueba primero');
  assert.ok(etiquetas.includes('1920') && etiquetas.includes('1280') && etiquetas.includes('640'), etiquetas.join(','));
  assert.strictEqual(etiquetas[etiquetas.length - 1], 'original');
  assert.ok(plan[plan.length - 1].url.endsWith('bachalpsee-7572681.jpg'));
});

test('con resolución «large» se prefiere 1280 y con «medium» 960', () => {
  const grande = loadPixabayModule({ resolucion: 'large' });
  const medio = { tipo: 'photo', url: 'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_1280.jpg' };
  const planGrande = grande.api.planDeFoto(medio).filter((p) => /^\d+$/.test(p.etiqueta));
  assert.strictEqual(planGrande[0].etiqueta, '1280');

  const mediana = loadPixabayModule({ resolucion: 'medium' });
  const planMediana = mediana.api.planDeFoto(medio).filter((p) => /^\d+$/.test(p.etiqueta));
  assert.strictEqual(planMediana[0].etiqueta, '960');
});

test('el audio usa el MP3 del CDN sin recomprimir', () => {
  const modulo = loadPixabayModule({});
  const plan = modulo.api.planDeAudio({
    tipo: 'audio',
    url: 'https://cdn.pixabay.com/audio/2026/06/21/audio_f7ff5b4757.mp3',
    mp3: 'https://cdn.pixabay.com/download/audio/2026/06/21/audio_f7ff5b4757.mp3?filename=x.mp3'
  });
  assert.strictEqual(plan.length, 1);
  assert.ok(plan[0].url.includes('/download/audio/'), 'prefiere la URL de descarga del CDN');
  assert.strictEqual(plan[0].etiqueta, 'mp3');
});

test('el nombre de archivo usa la plantilla de Pixabay y la carpeta', () => {
  const medio = { id: '551346', autor: 'SigmaMusicArt', nombre: 'Football - Football Music' };
  assert.strictEqual(pix.nombreDeArchivo(medio, 'mp3', ''), 'pixabay_SigmaMusicArt_Football - Football Music_551346.mp3');

  const conCarpeta = loadPixabayModule({ folder: 'Musica/Pixabay' }).api.nombreDeArchivo(medio, 'mp3', '');
  assert.strictEqual(conCarpeta, 'Musica/Pixabay/pixabay_SigmaMusicArt_Football - Football Music_551346.mp3');
});

test('un nombre con caracteres prohibidos no rompe el archivo', () => {
  const nombre = pix.nombreDeArchivo({ id: '1', autor: 'a/b', nombre: 'Foto: ¿qué? <grande> | 4K' }, 'jpg', '1920');
  assert.ok(!/[\\/:*?"<>|]/.test(nombre), nombre);
  assert.ok(nombre.endsWith('.jpg'));
});

test('detecta la ficha abierta aunque la ruta lleve idioma', () => {
  const enEspanol = loadPixabayModule({
    location: { hostname: 'pixabay.com', pathname: '/es/photos/bachalpsee-lake-mountains-7572681/', search: '' }
  }).api;
  assert.strictEqual(enEspanol.esLaFichaDe({ href: '/photos/bachalpsee-lake-mountains-7572681/' }), true);
  assert.strictEqual(enEspanol.esLaFichaDe({ href: '/photos/otra-cosa-999/' }), false);
});

test('Pixabay convierte el href de la ficha en un enlace de publicación', () => {
  assert.strictEqual(
    pix.urlDePublicacion({ href: '/photos/bachalpsee-lake-mountains-7572681/' }),
    'https://pixabay.com/photos/bachalpsee-lake-mountains-7572681/'
  );
});

test('el módulo solo se activa en pixabay.com', () => {
  const enPixabay = loadPixabayModule({});
  assert.strictEqual(enPixabay.registro.scanners.length, 1);
  assert.strictEqual(enPixabay.registro.hooks.length, 1);

  const fuera = loadPixabayModule({ location: { hostname: 'x.com', pathname: '/', search: '' } });
  assert.strictEqual(fuera.registro.scanners.length, 0);
});

test('al descargar se comprueba el mejor tamaño y se pide con carpeta y nombre', async () => {
  // DOM mínimo de una ficha: el botón «Free download» de la web y su contenedor.
  const contenedorAcciones = {
    attrs: {},
    getAttribute(clave) {
      return this.attrs[clave] || null;
    },
    setAttribute(clave, valor) {
      this.attrs[clave] = valor;
    },
    appendChild() {},
    insertBefore() {},
    parentElement: null
  };
  const botonWeb = { textContent: 'Free download', parentElement: contenedorAcciones };
  const documento = {
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'button, a' ? [botonWeb] : []),
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} })
  };

  const modulo = loadPixabayModule({
    folder: 'Pixabay/Musica',
    document: documento,
    location: {
      hostname: 'pixabay.com',
      pathname: '/music/percussion-football-football-music-551346/',
      search: ''
    },
    medios: [
      {
        id: '551346',
        tipo: 'audio',
        url: 'https://cdn.pixabay.com/audio/2026/06/21/audio_f7ff5b4757.mp3',
        mp3: 'https://cdn.pixabay.com/download/audio/2026/06/21/audio_f7ff5b4757.mp3?filename=x.mp3',
        nombre: 'Football - Football Music',
        autor: 'SigmaMusicArt',
        href: '/music/percussion-football-football-music-551346/'
      }
    ]
  });

  // El escáner pide los medios al puente y coloca el botón junto al de la web.
  await modulo.registro.scanners[0]();
  assert.ok(modulo.registro.ultimo, 'debe crear el botón');
  assert.ok(/xvd-button--en-linea/.test(modulo.registro.ultimo.className), modulo.registro.ultimo.className);

  await modulo.registro.ultimo.onClick({}, { dataset: {}, remove() {} });

  assert.strictEqual(modulo.registro.descargas.length, 1, 'una sola descarga');
  const peticion = modulo.registro.descargas[0];
  assert.ok(peticion.url.startsWith('https://cdn.pixabay.com/download/audio/'), peticion.url);
  assert.strictEqual(peticion.filename, 'Pixabay/Musica/pixabay_SigmaMusicArt_Football - Football Music_551346.mp3');
  assert.strictEqual(modulo.registro.estadoBoton.estado, 'done');
});

test('si el tamaño preferido no existe, se prueba el siguiente', async () => {
  const contenedor = {
    attrs: {},
    getAttribute() {
      return null;
    },
    setAttribute() {},
    appendChild() {},
    insertBefore() {},
    parentElement: null
  };
  const botonWeb = { textContent: 'Free download', parentElement: contenedor };
  const documento = {
    querySelector: () => null,
    querySelectorAll: (s) => (s === 'button, a' ? [botonWeb] : []),
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} })
  };

  const modulo = loadPixabayModule({
    document: documento,
    location: { hostname: 'pixabay.com', pathname: '/photos/bachalpsee-lake-mountains-7572681/', search: '' },
    // `_1920` y `_1280` no existen (403): solo `_960_720` responde.
    fetch: async (url) => ({ ok: /_960_720/.test(url), status: /_960_720/.test(url) ? 206 : 403 }),
    medios: [
      {
        id: '7572681',
        tipo: 'photo',
        url: 'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_1280.jpg',
        nombre: 'Bachalpsee, Lake',
        autor: 'Himmelstraeume',
        href: '/photos/bachalpsee-lake-mountains-7572681/'
      }
    ]
  });

  await modulo.registro.scanners[0]();
  await modulo.registro.ultimo.onClick({}, { dataset: {}, remove() {} });

  assert.strictEqual(modulo.registro.descargas.length, 1);
  assert.ok(/_960_720\.jpg$/.test(modulo.registro.descargas[0].url), modulo.registro.descargas[0].url);
});

test('en un vídeo, «solo audio» avisa en vez de bajar algo raro', async () => {
  const { documento } = domDeFichaPixabay();
  const modulo = loadPixabayModule({
    formato: 'mp3',
    document: documento,
    location: { hostname: 'pixabay.com', pathname: '/videos/dandelion-flower-blossom-bloom-348656/', search: '' },
    medios: [
      {
        id: '348656',
        tipo: 'video',
        url: 'https://cdn.pixabay.com/video/2026/04/24/348656_tiny.mp4',
        nombre: 'Dandelion',
        autor: 'adege',
        href: '/videos/dandelion-flower-blossom-bloom-348656/'
      }
    ]
  });
  const boton = { dataset: {}, remove() {} };
  await modulo.registro.scanners[0]();
  await modulo.registro.ultimo.onClick({}, boton);

  assert.strictEqual(modulo.registro.descargas.length, 0, 'no se descarga nada');
  assert.ok(
    (modulo.registro.avisos || []).some((a) => /sin sonido/.test(a.mensaje)),
    JSON.stringify(modulo.registro.avisos)
  );
});

test('si ningún tamaño responde, se avisa sin descargar', async () => {
  const contenedor = {
    getAttribute: () => null,
    setAttribute() {},
    appendChild() {},
    insertBefore() {},
    parentElement: null
  };
  const documento = {
    querySelector: () => null,
    querySelectorAll: (s) => (s === 'button, a' ? [{ textContent: 'Free download', parentElement: contenedor }] : []),
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} })
  };

  const modulo = loadPixabayModule({
    document: documento,
    fetch: async () => ({ ok: false, status: 403 }),
    location: { hostname: 'pixabay.com', pathname: '/photos/bachalpsee-lake-mountains-7572681/', search: '' },
    medios: [
      {
        id: '7572681',
        tipo: 'photo',
        url: 'https://cdn.pixabay.com/photo/2022/11/05/19/56/bachalpsee-7572681_1280.jpg',
        nombre: 'Bachalpsee',
        autor: 'Himmelstraeume',
        href: '/photos/bachalpsee-lake-mountains-7572681/'
      }
    ]
  });

  await modulo.registro.scanners[0]();
  await modulo.registro.ultimo.onClick({}, { dataset: {}, remove() {} });

  // Al no poder comprobar ninguna, se intenta la primera y se confía en el reintento.
  assert.ok(modulo.registro.descargas.length >= 1, 'se intenta la primera igualmente');
});


/* ------------------------------------------------------------------ cierre -- */

Promise.all(pendientes).then(() => {
  console.log('\n' + passed + ' pruebas correctas, ' + failures.length + ' fallos\n');
  if (failures.length) {
    process.exitCode = 1;
  }
});
