# Descargador de medios para X (Twitter)

Extensión de Chrome bajo **Manifest V3** que añade un botón flotante **«Descargar»** sobre los
**videos** y las **imágenes** publicados en X (Twitter), permitiendo guardarlos en la **máxima
calidad o resolución disponible** y en el **formato configurable** por el usuario.

Toda la interfaz (botones, avisos y popup de opciones) está **en español**.

---

## Índice

1. [Características](#características)
2. [Instalación en modo desarrollador](#instalación-en-modo-desarrollador)
3. [Uso](#uso)
4. [Opciones del popup](#opciones-del-popup)
5. [Arquitectura y archivos](#arquitectura-y-archivos)
6. [Cómo obtiene la URL del video](#cómo-obtiene-la-url-del-video)
7. [Cómo obtiene la imagen en máxima resolución](#cómo-obtiene-la-imagen-en-máxima-resolución)
8. [Permisos y privacidad](#permisos-y-privacidad)
9. [Limitaciones conocidas](#limitaciones-conocidas)
10. [Solución de problemas](#solución-de-problemas)
11. [Desarrollo](#desarrollo)
12. [Criterios de aceptación](#criterios-de-aceptación)

---

## Características

### Videos

- **Detección automática** de videos en el timeline, perfiles, tweets individuales, respuestas,
  citas y en el visor ampliado (modal). Funciona con el scroll infinito y la navegación SPA.
- **Selección de la máxima calidad** entre todas las variantes del manifiesto del video,
  comparando resolución y bitrate.
- **Formato configurable**: `Auto`, `MP4` (por defecto), `WebM` y `M4A / audio`.
- **Calidad máxima o personalizada** (nunca por debajo de 2160p, 1440p, 1080p, 720p, 480p o 360p).
- **Reintentos automáticos**: si una variante falla (red, CDN, disco), se reintenta con la
  siguiente calidad inferior.
- **Modo avanzado HLS**: si un video no expone ningún archivo MP4 directo, puede reconstruirse el
  stream uniendo sus segmentos en memoria (opcional, desactivado por defecto).

### Imágenes

- **Detección automática** de imágenes sueltas, **galerías de 2 a 4**, imágenes dentro de citas y
  respuestas, **tarjetas de enlace** (`card_img`, incluidas las de fondo CSS) y el visor ampliado.
- **Máxima resolución por defecto**: se reescribe el parámetro `name=` de la URL de
  `pbs.twimg.com` para pedir `orig` (archivo original sin recomprimir).
- **Resolución configurable**: `orig`, `4096x4096`, `large` o `medium`.
- **Respaldo automático en cascada**: `orig → 4096x4096 → large → medium` si la resolución pedida
  no está disponible, con aviso en español.
- **Formato configurable**: `Auto` (respeta JPG/PNG/WEBP/GIF), `JPG`, `PNG` o `WEBP`. La conversión
  la realiza el propio CDN de X mediante el parámetro `format=`.
- **Botón individual** en cada imagen con indicador de progreso (spinner → check).
- **Contador de galería** (`1/4`, `2/4`…) en la esquina superior izquierda de cada imagen.
- **Botón «Descargar todas»** en galerías, que descarga secuencialmente todas las imágenes del
  tweet con nombres indexados: `tweet_[id]_img1.jpg`, `tweet_[id]_img2.jpg`…
- **Deduplicación de URLs**: nunca se descarga dos veces la misma imagen (ni dentro de un lote ni
  entre el timeline y el visor ampliado).
- **Comprobación de disponibilidad** previa a la descarga para no guardar una página de error en
  lugar de la imagen.

### Comunes

- **Botones flotantes** con el estilo visual de X, que no bloquean ni modifican los controles
  nativos ni la reproducción, y **no interfieren con el lightbox** (en el visor ampliado el botón
  se desplaza a la esquina inferior derecha para no tapar los controles de X).
- **Carpeta de destino** configurable dentro de *Descargas* y opción de preguntar cada vez.
- **Plantillas de nombre de archivo** independientes para videos e imágenes.
- **Interruptor on/off** general y otro específico para las imágenes.
- **Avisos en español** dentro de la propia página: progreso, éxito y errores claros.

---

## Instalación en modo desarrollador

1. Descarga o copia esta carpeta completa (`x-video-downloader`) a tu equipo.
2. Abre Chrome y ve a `chrome://extensions/`.
3. Activa el **Modo de desarrollador** (interruptor de la esquina superior derecha).
4. Pulsa **«Cargar descomprimida»** (*Load unpacked*).
5. Selecciona la carpeta `x-video-downloader` (la que contiene `manifest.json`).
6. La extensión aparecerá en la lista. Fija su icono en la barra con el botón de la pieza de
   puzle si quieres tener el popup a mano.
7. Abre o **recarga** `https://x.com/` (las pestañas abiertas antes de instalar no tienen los
   content scripts; el popup intenta inyectarlos, pero una recarga es lo más fiable).

> Navegadores compatibles: Chrome 102 o superior, Edge, Brave y cualquier derivado de Chromium con
> soporte de Manifest V3. En Firefox MV3 el service worker es parcialmente distinto y no está
> garantizado.

### Actualizar desde la versión 1.x (solo videos)

Al ser la versión **2.0.0** se añade `images.js` y el permiso de host de `pbs.twimg.com`. Tras
sustituir los archivos, pulsa **↻ (Actualizar)** en `chrome://extensions/` y **recarga** las
pestañas de X para que se inyecte el nuevo módulo.

---

## Uso

### Descargar un video

1. Entra en `https://x.com/` y localiza cualquier tweet con video.
2. Verás un botón **«Descargar»** en la esquina superior derecha del reproductor.
3. Haz clic: el botón pasa a **«Preparando…»** mientras se resuelve la mejor variante y luego
   muestra **«Descargando»**.
4. Aparecerá un aviso: `Descarga iniciada: X Videos/usuario_1234567890_1080p.mp4`.

### Descargar una imagen

1. Localiza un tweet con imágenes. Cada imagen muestra el botón **«Descargar»**.
2. En galerías verás además el contador (`1/4`, `2/4`…) y, abajo a la derecha, el botón
   **«Descargar todas (4)»**.
3. Al terminar, el botón muestra un **check verde** («Descargada») y el aviso
   `Descarga iniciada: X Videos/tweet_1234567890_img1.jpg`.

Las descargas se gestionan con la API `chrome.downloads`, así que puedes verlas, pausarlas o
cancelarlas en `chrome://downloads/` (o con el botón **«Abrir carpeta»** del popup).

---

## Opciones del popup

Haz clic en el icono de la extensión para abrir el panel, organizado en **tres pestañas**:
**Videos**, **Imágenes** y **General**. Todos los cambios se guardan automáticamente
(verás «Guardado ✓») y se aplican al instante en las pestañas abiertas.

### Pestaña Videos

| Opción | Valores | Descripción |
| --- | --- | --- |
| **Formato de video** | `Auto`, `MP4`, `WebM`, `M4A` | `Auto` = mejor variante disponible. `MP4` es el valor por defecto. |
| **Calidad de video** | `Máxima disponible`, `Personalizada` | `Personalizada` usa la altura mínima elegida. |
| **Altura mínima** | 2160p, 1440p, 1080p, 720p, 480p, 360p | Solo se aplica con la calidad personalizada. |
| **Reintentar con calidad inferior si falla** | casilla | Respaldo automático ante errores de descarga. |
| **Si no hay pista de audio (M4A)** | `Descargar el MP4 completo` / `Cancelar y avisar` | X casi nunca publica audio separado. |
| **Reconstruir streams HLS** | casilla | Modo avanzado: une los segmentos del stream en memoria. |
| **Nombre del archivo de video** | plantilla | Variables: `{usuario}` `{id}` `{tweet}` `{fecha}` `{calidad}` `{bitrate}` `{ext}`. |

### Pestaña Imágenes

| Opción | Valores | Descripción |
| --- | --- | --- |
| **Activar los botones en imágenes** | casilla | Desactívalo para descargar únicamente videos. |
| **Resolución de imagen** | `orig` (máxima), `4096×4096`, `large`, `medium` | Valor enviado al parámetro `name=` del CDN de X. |
| **Formato de imagen** | `Auto`, `JPG`, `PNG`, `WEBP` | `Auto` respeta el formato original; el resto se convierte en el CDN. |
| **Botón «Descargar todas» en galerías** | casilla | Descarga secuencialmente las 2-4 imágenes del tweet. |
| **Usar resolución alternativa si orig falla** | casilla | Cadena `orig → 4096×4096 → large → medium`. |
| **Comprobar disponibilidad antes de descargar** | casilla | Evita guardar una página de error en lugar de la imagen. |
| **Botón de imagen compacto (solo icono)** | casilla | Más discreto en galerías pequeñas. |
| **Nombre del archivo de imagen** | plantilla | Variables: `{id}` `{tweet}` `{usuario}` `{fecha}` `{indice}` `{total}` `{resolucion}` `{ext}`. Por defecto `tweet_[id]_img1.jpg`. |

### Pestaña General

| Opción | Descripción |
| --- | --- |
| **Subcarpeta dentro de Descargas** | Por defecto `X Videos`. Vacío = raíz de Descargas. |
| **Preguntar dónde guardar cada vez** | Activa el diálogo «Guardar como» de Chrome (`saveAs`). |
| **Mostrar avisos en la página** | Notificaciones flotantes dentro de X. |
| **Mostrar los botones solo al pasar el ratón** | Interfaz más discreta sobre videos e imágenes. |
| **Estado** | Número de reproductores e imágenes detectados en la pestaña activa. |

El **interruptor general** (cabecera del popup) activa o desactiva toda la extensión y retira los
botones al instante.

---

## Arquitectura y archivos

```
x-video-downloader/
├── manifest.json        Manifest V3: permisos, service worker, content scripts, popup
├── content.js           NÚCLEO compartido + módulo de VIDEO
│                        (__XVD_CORE__: ajustes, avisos, botones, observadores, mensajería)
├── images.js            Módulo de IMÁGENES (se carga después de content.js)
├── background.js        Service worker: valida, ejecuta y vigila las descargas
├── popup.html           Popup con pestañas Videos | Imágenes | General
├── popup.js             Lógica del popup (chrome.storage.sync)
├── styles.css           Estilos: botones, contadores, avisos y popup (una sola hoja)
├── icons/
│   ├── icon16.png       Icono de barra
│   ├── icon48.png       Icono de gestión de extensiones
│   └── icon128.png      Icono de instalación / Chrome Web Store
├── tools/
│   ├── make-icons.js    Generador de iconos sin dependencias (opcional)
│   ├── test.js          Pruebas de la lógica pura (43 comprobaciones)
│   └── check-popup.js   Comprobación de coherencia popup.html ↔ popup.js
└── README.md            Este documento
```

> **Sobre los iconos:** la funcionalidad de imágenes no necesita archivos de icono nuevos. Los
> distintivos que pide la especificación **son elementos de la propia página**, creados en tiempo de
> ejecución por `images.js`: el contador de galería (`.xvd-badge`, `1/4`, `2/4`…), el icono de pila de
> imágenes del botón «Descargar todas» (SVG en línea) y los indicadores de estado del botón
> (spinner, check verde y aviso rojo), definidos en `styles.css`.

### Núcleo compartido y módulos
`content.js` se ejecuta antes que `images.js` (el orden del array `js` del manifiesto importa) y
publica una API interna en `window.__XVD_CORE__`, dentro del mundo aislado de la extensión:

| Miembro | Función |
| --- | --- |
| `getSettings()` | Ajustes vigentes (cargados de `chrome.storage.sync`). |
| `registerScanner(fn)` | Registra el escaneo de un módulo; el `MutationObserver` los ejecuta todos con antirrebote. |
| `registerDisableHook(fn)` | Limpieza del módulo cuando cambian los ajustes o se desactiva la extensión. |
| `createButton(opts)` / `setButtonState(...)` | Fábrica de botones superpuestos y estados (reposo, spinner, check, error). |
| `findOverlayHost(el)` / `getTweetContext(el)` | Anclaje del botón y contexto del tweet (usuario, id, fecha). |
| `requestDownload(opts)` | Envía `XVD_DOWNLOAD` al service worker y registra el respaldo `onInterrupted`. |
| `toast(...)` / `sendMessage(...)` / `sleep(...)` | Avisos en español y mensajería interna. |

Así, video e imágenes no comparten lógica de negocio pero sí toda la infraestructura.

### Flujo de mensajería

```
                 chrome.runtime.sendMessage                    chrome.downloads.download
 [content.js]  ─────────────────────────────▶ [background.js] ─────────────────────────▶ Chrome
 [images.js]   ◀──── XVD_DOWNLOAD_EVENT ─────┘
                (complete / interrupted → respaldo: menor calidad o resolución alternativa)

 [popup.js] ── chrome.storage.sync ──▶ content.js + images.js (chrome.storage.onChanged)
            └─ XVD_PING ─────────────▶ { videos, images }  (contadores de la pestaña)
```

- **content.js / images.js** nunca descargan directamente: resuelven la URL y delegan.
- **background.js** es la única parte que toca `chrome.downloads` y traduce los errores al español.
- **popup.js** escribe en `chrome.storage.sync`; los módulos reaccionan sin recargar.

---

## Cómo obtiene la URL del video

Los videos de X se reproducen por *streaming* (MSE), por lo que el atributo `src` del `<video>` es
un `blob:` inutilizable. La extensión aplica una **cascada de estrategias** hasta encontrar el
manifiesto de variantes:

1. **Props de React (fibras).** Recorrido acotado de `__reactProps$…` / `__reactFiber$…` del propio
   `<video>`, de sus contenedores y del `<article>` del tweet buscando `video_info.variants`.
2. **Estado global.** `window.__INITIAL_STATE__`, `__NEXT_DATA__`, `__APOLLO_STATE__`,
   `__PRELOADED_STATE__` (compatibilidad con estructuras heredadas de Twitter).
3. **Árbol global de React** vía `__REACT_DEVTOOLS_GLOBAL_HOOK__`, con tope de nodos.
4. **Peticiones de red.** Entradas de `performance.getEntriesByType('resource')` filtradas por el
   id del video (obtenido del `poster`), descarga y análisis del `.m3u8` (`BANDWIDTH`, `RESOLUTION`,
   `CODECS`).
5. **`<video>` / `<source>`.** Último recurso: `currentSrc`, `src` y los `<source>` hijos.

**Identificación del video correcto.** El id se extrae del póster
(`pbs.twimg.com/amplify_video_thumb/<id>/…`) y se cruza con los candidatos; la resolución se repite
en el momento del clic, nunca al pintar el botón.

**Selección de calidad.** Orden por `altura × 1e7 + bitrate`, filtrado por el `content_type` del
formato pedido y por la altura mínima si la calidad es personalizada. La lista ordenada se conserva
para el respaldo de menor calidad.

---

## Cómo obtiene la imagen en máxima resolución

X sirve cada imagen desde `pbs.twimg.com` con dos parámetros en la URL:

```
https://pbs.twimg.com/media/GHxyzabc123?format=jpg&name=small
                                             ▲            ▲
                                             │            └── tamaño servido
                                             └── formato de salida
```

La extensión **no** vuelve a comprimir nada: reescribe la propia URL y deja que el CDN de X haga el
trabajo.

| Parámetro | Valores usados | Efecto |
| --- | --- | --- |
| `name` | `orig`, `4096x4096`, `large`, `medium` | Tamaño entregado. `orig` es el archivo original sin recomprimir. |
| `format` | `jpg`, `png`, `webp` (solo si el formato no es `Auto`) | Conversión de formato en el servidor de X. |

**Detección.** Se consideran imágenes de tweet las URLs de `pbs.twimg.com` cuya ruta contiene
`/media/` o `/card_img/`. Quedan **excluidas** las fotos de perfil, las cabeceras, los emojis
(`abs.twimg.com`) y las miniaturas de video (`tweet_video_thumb`, `amplify_video_thumb`,
`ext_tw_video_thumb`), que son competencia del módulo de video. Para las tarjetas de enlace también
se leen las imágenes aplicadas como `background-image`.

**Galerías.** A partir de cada imagen se asciende por el DOM hasta encontrar el contenedor del
grupo, deteniéndose en el `<article>` del tweet y nunca agrupando más de 4 celdas
(`[data-testid="tweetPhoto"]`), que es el máximo que publica X. Con ese grupo se calculan el
contador (`2/4`) y el botón «Descargar todas».

**Respaldo en cascada.** Si `imageFallback` está activo, cada descarga lleva asociada la lista
`orig → 4096x4096 → large → medium`. La cadena se usa de dos formas:

1. **Antes de descargar**, si `imageVerify` está activo: se comprueba con un `Image()` precargado
   que la resolución existe (con caché de 5 minutos) y se baja al primer candidato disponible,
   avisando con `No se pudo descargar en resolución máxima, usando resolución alternativa.`
2. **Si Chrome interrumpe la descarga** (404, 403, red…), el service worker avisa al content script
   y este reintenta con la siguiente resolución de la cadena.

**Deduplicación.** La clave es la ruta de la imagen (`/media/<id>`), con lo que la misma foto vista
en el timeline, en una cita y en el visor ampliado cuenta como una sola. Dentro de un lote
(«Descargar todas») se descarta cualquier repetida, y entre descargas se aplica una ventana de 8
segundos por combinación de imagen + resolución + formato.

**Nombres.** La plantilla por defecto es `tweet_{id}_img{indice}`, de modo que una galería produce
`tweet_1234567890_img1.jpg`, `tweet_1234567890_img2.jpg`, etc.

---

## Permisos y privacidad

| Permiso | Para qué se usa |
| --- | --- |
| `downloads` | Ejecutar y vigilar la descarga con `chrome.downloads.download`. |
| `storage` | Guardar las preferencias (`chrome.storage.sync`, respaldo local y de sesión). |
| `activeTab` | Inyectar los content scripts bajo demanda si la pestaña ya estaba abierta. |
| `scripting` | Reinyectar `content.js`/`images.js`/`styles.css` en pestañas de X abiertas antes de instalar. |
| `host_permissions` | `*://*.x.com/*`, `*://*.twitter.com/*` y `*://pbs.twimg.com/*` (este último solo para comprobar la disponibilidad de la resolución pedida). |

- **No** se recopila, envía ni analiza ningún dato. No hay servidores propios ni telemetría.
- **No** se solicitan permisos amplios (`<all_urls>`, `webRequest`, `tabs`, `cookies`…).
- Los archivos se descargan directamente desde el CDN de X (`video.twimg.com`, `pbs.twimg.com`);
  la extensión no actúa como intermediario.

---

## Limitaciones conocidas

### Videos

- **M4A / audio extraído.** X casi siempre publica un único MP4 con audio y vídeo multiplexados, sin
  pista de audio independiente. Extraer el audio requeriría recodificar; la extensión **no** incluye
  un transcodificador, así que avisa y descarga el MP4 completo (o cancela, según la opción).
- **WebM.** Solo está disponible si X publica esa variante (habitual en códecs VP9/AV1). Si no
  existe, se avisa y se entrega MP4; **no** se reconvierte.
- **Streams HLS.** Cuando un video solo se sirve como HLS no hay archivo único descargable. El
  *modo avanzado* une los segmentos en memoria (límites: 4000 segmentos y ~700 MB; falla si el
  stream está cifrado con AES-128). Con segmentos CMAF se obtiene un MP4 fragmentado; con MPEG-TS,
  un `.ts` reproducible en VLC/mpv.
- **Calidades por encima de 1080p.** X suele limitar la reproducción pública a 720p/1080p; la
  extensión ofrece lo que el manifiesto contenga realmente.

### Imágenes

- **Resolución real.** `orig` entrega el archivo tal y como se subió (puede ser 1200×675 o
  4096×4096, según el tweet). No hay «superresolución»: si X no tiene más píxeles, no hay más.
- **Conversión de formato.** El CDN de X acepta `format=jpg|png|webp`. Convertir a **PNG** una foto
  suele multiplicar el tamaño del archivo sin ganar calidad; el popup y los avisos lo advierten.
- **GIF.** Los GIF animados de X se publican casi siempre como video (MP4) y los cubre el módulo de
  video. Si una imagen llega con `format=gif`, se avisa: se descarga como `.gif` (o convertida, con
  pérdida de animación, si se eligió JPG/PNG/WEBP).
- **Galerías con cita.** Si un tweet con imágenes cita a su vez otro tweet con imágenes y entre
  ambos suman 4 o menos, el agrupador puede contarlos como una sola galería. Es un caso poco
  frecuente; el botón individual de cada imagen siempre descarga la imagen correcta.
- **Imágenes con restricción de edad o de cuenta protegida.** Si X no entrega la imagen a la
  página, no hay nada que descargar.

### Generales

- **Cambios de X.** El código usa selectores y rutas resilientes, pero una reescritura profunda del
  frontend puede requerir ajustes.

---

## Solución de problemas

| Síntoma | Causa probable y solución |
| --- | --- |
| No aparece ningún botón | Recarga la pestaña de X. Comprueba el interruptor general y, en imágenes, «Activar los botones en imágenes». |
| «No se pudo obtener el video en la calidad solicitada» | El manifiesto aún no está cargado: reproduce el video un segundo y reinténtalo (ya se reintenta 3 veces). |
| «No se pudo obtener la imagen en la máxima resolución» | La imagen todavía no tenía `src` al hacer clic: espera a que termine de cargar. |
| «No se pudo descargar en resolución máxima, usando resolución alternativa» | `orig` no existe para esa imagen; se está descargando `4096x4096`, `large` o `medium`. |
| «No se pudo descargar la imagen: ninguna resolución está disponible» | El CDN no sirve la imagen (borrada, privada o bloqueada). |
| Se descarga una página de error en lugar de la imagen | Desactiva «Comprobar disponibilidad antes de descargar» y vuelve a activarla, o reintenta: el respaldo de resolución debería corregirlo. |
| El botón tapa la imagen en el visor ampliado | El botón ya se coloca abajo a la derecha dentro del lightbox; si aun así molesta, activa «Botón de imagen compacto» o «Mostrar los botones solo al pasar el ratón». |
| «Descargar todas» no aparece | La galería no se ha reconocido como tal (1 imagen) o el botón está desactivado en el popup. |
| El archivo se guarda sin subcarpeta | Chrome crea la carpeta indicada; los caracteres inválidos se sustituyen por `_`. |
| La descarga se corta a mitad | La extensión reintenta con la siguiente calidad o resolución. Revisa la conexión. |

Los mensajes de error del service worker se traducen desde los códigos de `chrome.downloads`
(`NETWORK_FAILED`, `SERVER_FORBIDDEN`, `FILE_NO_SPACE`, `USER_CANCELED`, …).

---

## Desarrollo

- No hay build, ni dependencias, ni transpilación: se carga la carpeta tal cual.
- Regenerar los iconos (Node 18+):

  ```bash
  node tools/make-icons.js
  ```

- Comprobar la sintaxis de los scripts:

  ```bash
  node --check content.js && node --check images.js && node --check background.js && node --check popup.js
  ```

- Ejecutar las pruebas (Node 18+, sin dependencias):

  ```bash
  node tools/test.js        # 43 pruebas: variantes, calidad, nombres, HLS, imágenes
  node tools/check-popup.js # coherencia popup.html ↔ popup.js y pestañas
  ```

  `tools/test.js` carga `content.js` e `images.js` en contextos aislados con stubs del navegador y
  valida la selección de la máxima calidad y resolución, los respaldos de formato, la reescritura de
  `name=`/`format=`, la cadena de degradación, la deduplicación de URLs, el saneado de rutas
  (`../../etc/passwd` → `etc/passwd`), los nombres indexados de galería y el análisis de manifiestos
  HLS (incluidos streams cifrados y segmentos CMAF).

- Depuración:
  - **Content scripts:** consola de la página de X (F12) → contexto de la extensión.
  - **Service worker:** `chrome://extensions/` → *Descargador de medios para X* → «service worker».
  - **Popup:** clic derecho sobre el popup → *Inspeccionar*.

---

## Criterios de aceptación

### Videos

| Criterio | Estado |
| --- | --- |
| El botón aparece en todos los videos visibles y en los nuevos (scroll infinito) | ✅ `MutationObserver` + `ResizeObserver` + barridos programados |
| La descarga se realiza en máxima calidad por defecto | ✅ ordenación por resolución y bitrate |
| El formato elegido en el popup se respeta en cada descarga | ✅ `content_type` filtrado + respaldo avisado |
| No interfiere con la reproducción ni con los controles nativos | ✅ el `<video>` nunca se modifica |
| Reintentos y respaldo de menor calidad | ✅ 3 intentos de resolución + respaldo encadenado |

### Imágenes

| Criterio | Estado |
| --- | --- |
| Botón visible en todas las imágenes (individuales y en galería) | ✅ detección por `pbs.twimg.com/media`, `card_img` y `[data-testid="tweetPhoto"]` |
| Descarga en resolución máxima por defecto (`orig`) | ✅ reescritura de `name=` |
| Opción «Descargar todas» funciona en galerías | ✅ descarga secuencial con índice y progreso |
| Formato y resolución respetan la configuración del popup | ✅ `format=` + `name=` en la misma URL |
| No interfiere con la visualización del lightbox de X | ✅ botón desplazado abajo a la derecha en el visor |
| Compatible con scroll infinito sin recargar | ✅ mismo observador que en videos |
| Respaldo si `orig` no está disponible | ✅ cascada `orig → 4096x4096 → large → medium` con aviso |
| Deduplicación de URLs | ✅ por ruta de imagen + lote + ventana antiduplicados |
| Mensajes de error claros en español | ✅ avisos en página y tabla de traducción en el service worker |

### Generales

| Criterio | Estado |
| --- | --- |
| Permisos mínimos | ✅ `downloads`, `storage`, `activeTab`, `scripting` + hosts de X y `pbs.twimg.com` |
| Interfaz íntegramente en español | ✅ botones, avisos y popup con pestañas |
| Arquitectura modular (video ≠ imágenes) | ✅ `content.js` (núcleo + video) e `images.js` (imágenes) sobre `__XVD_CORE__` |

---

## Licencia

Uso personal y educativo. Respeta los términos de servicio de X y los derechos de autor del
contenido que descargues: descarga únicamente material propio o con permiso explícito.
