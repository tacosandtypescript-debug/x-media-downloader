/**
 * Comprobación estática del popup: todo id usado por popup.js debe existir en
 * popup.html y los grupos de radios deben estar completos.
 * Uso:  node tools/check-popup.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

// Las pestañas y los paneles se referencian por construcción ("tab-" + nombre).
const structural = /^(tab|panel)-(videos|imagenes|general)$/;
const missing = [...jsIds].filter((id) => !htmlIds.has(id));
const unused = [...htmlIds].filter((id) => !jsIds.has(id) && id !== 'section-format' && !structural.test(id));

const radioValues = {
  format: [...html.matchAll(/name="format" value="([^"]+)"/g)].map((m) => m[1]),
  quality: [...html.matchAll(/name="quality" value="([^"]+)"/g)].map((m) => m[1]),
  imageFormat: [...html.matchAll(/name="imageFormat" value="([^"]+)"/g)].map((m) => m[1])
};

let ok = true;

if (missing.length) {
  ok = false;
  console.log('✗ Faltan en popup.html los ids: ' + missing.join(', '));
} else {
  console.log('✓ Todos los ids usados por popup.js existen en popup.html (' + jsIds.size + ')');
}

// Las tres pestañas de la interfaz unificada deben existir.
const tabs = ['videos', 'imagenes', 'general'];
const missingTabs = tabs.filter((tab) => !htmlIds.has('tab-' + tab) || !htmlIds.has('panel-' + tab));
ok = ok && missingTabs.length === 0;
console.log(
  (missingTabs.length === 0 ? '✓ ' : '✗ ') +
    'Pestañas Videos | Imágenes | General: ' +
    (missingTabs.length ? 'faltan ' + missingTabs.join(', ') : 'completas')
);

const imageFields = [
  'imagesEnabled',
  'imageResolution',
  'galleryButton',
  'compactImageButton',
  'imageFallback',
  'imageVerify',
  'imageFilenameTemplate'
];
const missingImageFields = imageFields.filter((id) => !htmlIds.has(id));
ok = ok && missingImageFields.length === 0;
console.log(
  (missingImageFields.length === 0 ? '✓ ' : '✗ ') +
    'Ajustes de imagen en el popup: ' +
    (missingImageFields.length ? 'faltan ' + missingImageFields.join(', ') : imageFields.length + ' campos')
);

for (const [group, values] of Object.entries(radioValues)) {
  const expected =
    group === 'format' ? ['auto', 'mp4', 'webm', 'm4a'] : group === 'quality' ? ['max', 'custom'] : ['auto', 'jpg', 'png', 'webp'];
  const complete = expected.every((v) => values.includes(v));
  ok = ok && complete;
  console.log((complete ? '✓ ' : '✗ ') + 'Radios "' + group + '": ' + values.join(', '));
}

// El select de resolución debe ofrecer las cuatro opciones pedidas.
const resolutions = [...html.matchAll(/id="imageResolution"[\s\S]*?<\/select>/g)]
  .map((block) => [...block[0].matchAll(/value="([^"]+)"/g)].map((m) => m[1]))
  .flat();
const expectedResolutions = ['orig', '4096x4096', 'large', 'medium'];
const resolutionsOk = expectedResolutions.every((r) => resolutions.includes(r));
ok = ok && resolutionsOk;
console.log((resolutionsOk ? '✓ ' : '✗ ') + 'Resoluciones de imagen: ' + resolutions.join(', '));

if (unused.length) {
  console.log('· Ids del HTML no referenciados por popup.js: ' + unused.join(', '));
}

// El popup debe estar íntegramente en español: se buscan restos en inglés.
const englishLeaks = ['Settings', 'Download', 'Save', 'Quality', 'Format', 'Enabled', 'Cancel', 'Reset'];
const leaks = englishLeaks.filter((w) => new RegExp('>' + w + '<|"' + w + '"').test(html));
if (leaks.length) {
  ok = false;
  console.log('✗ Texto en inglés detectado en popup.html: ' + leaks.join(', '));
} else {
  console.log('✓ No se detectan textos de interfaz en inglés');
}

// --- Equilibrio de etiquetas: cada apertura debe tener su cierre ------------
const structuralTags = ['html', 'head', 'body', 'header', 'nav', 'main', 'section', 'div', 'p', 'span', 'label', 'button', 'select', 'details', 'summary', 'h1', 'h2', 'small', 'code'];
const voidTags = new Set(['input', 'br', 'img', 'meta', 'link']);
const tagProblems = [];

for (const tag of structuralTags) {
  const open = (html.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) || []).length;
  const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  if (open !== close) tagProblems.push(tag + ': ' + open + ' abiertas / ' + close + ' cerradas');
}

if (tagProblems.length) {
  ok = false;
  console.log('✗ Etiquetas desequilibradas → ' + tagProblems.join(' | '));
} else {
  console.log('✓ Estructura HTML equilibrada (' + structuralTags.length + ' tipos de etiqueta revisados)');
}

// Los paneles deben estar ocultos por defecto salvo el de videos.
const hiddenPanels = [...html.matchAll(/<section class="xvd-panel"[^>]*>/g)].map((m) => m[0]);
const panelsWithoutHidden = hiddenPanels.filter(
  (tag) => !tag.includes('panel-videos') && !tag.includes('hidden')
);
if (panelsWithoutHidden.length) {
  ok = false;
  console.log('✗ Paneles no ocultos inicialmente: ' + panelsWithoutHidden.length);
} else {
  console.log('✓ Paneles de pestañas: solo "Videos" visible al abrir el popup');
}

// El popup necesita folders.js cargado ANTES que popup.js.
const posFolders = html.indexOf('folders.js');
const posPopup = html.indexOf('popup.js');
const ordenOk = posFolders !== -1 && posFolders < posPopup;
ok = ok && ordenOk;
console.log((ordenOk ? '✓ ' : '✗ ') + 'folders.js se carga antes que popup.js');

process.exitCode = ok ? 0 : 1;
