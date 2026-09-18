# Descargador de medios para X (Twitter)

Extensión de Chrome bajo **Manifest V3** que añade un botón flotante **«Descargar»** sobre los
**videos** y las **imágenes** publicados en X (Twitter), **Instagram**, **Facebook** y **YouTube**,
permitiendo guardarlos en la **máxima calidad o resolución disponible** y en el **formato
configurable** por el usuario (MP4, WebM, M4A o MP3), con **carpetas de destino** y plantillas de
nombre.

Toda la interfaz (botones, avisos y popup de opciones) está **en español**.

> X, Instagram y Facebook se descargan dentro de la extensión. **YouTube va aparte**: YouTube dejó de
> entregar archivos descargables al navegador (usa SABR y firma las URLs), así que esa descarga la
> hace **yt-dlp** mediante un pequeño servicio local que se instala una vez. Ver
> [YouTube](#youtube-a-través-de-yt-dlp).

---

## Índice

1. [Características](#características)
2. [Instalación en modo desarrollador](#instalación-en-modo-desarrollador)
3. [Uso](#uso)
4. [Opciones del popup](#opciones-del-popup)
5. [Arquitectura y archivos](#arquitectura-y-archivos)
6. [Cómo obtiene la URL del video](#cómo-obtiene-la-url-del-video)
7. [Cómo obtiene la imagen en máxima resolución](#cómo-obtiene-la-imagen-en-máxima-resolución)
8. [YouTube y el servicio de yt-dlp](#youtube-a-través-de-yt-dlp)
9. [Permisos y privacidad](#permisos-y-privacidad)
10. [Limitaciones conocidas](#limitaciones-conocidas)
11. [Solución de problemas](#solución-de-problemas)
12. [Desarrollo](#desarrollo)
13. [Criterios de aceptación](#criterios-de-aceptación)

---

## Características

### Videos

- **Detección automática** de videos en el timeline, perfiles, tweets individuales, respuestas,
  citas y en el visor ampliado (modal). Funciona con el scroll infinito y la navegación SPA.
- **Selección de la máxima calidad** entre todas las variantes del manifiesto del video,
  comparando resolución y bitrate.
- **Formato configurable**: `Auto`, `MP4` (por defecto), `WebM`, `M4A` y `MP3`.
- **Solo audio de verdad** (`M4A` y `MP3`): X publica la pista AAC suelta en su stream HLS
  (32, 64 y **128 kbps**), así que la extensión la une sin recomprimir → unos **370 KB en vez de
  40 MB**. Con `MP3` además la convierte en tu equipo (lado a lado, la calidad la manda el MP3).
- **Calidad máxima o personalizada** (nunca por debajo de 2160p, 1440p, 1080p, 720p, 480p o 360p).
- **Reintentos automáticos**: si una variante falla (red, CDN, disco), se reintenta con la
  siguiente calidad inferior.
- **Modo avanzado HLS**: si un video no expone ningún archivo MP4 directo, puede reconstruirse el
  stream uniendo sus segmentos en memoria (opcional, desactivado por defecto).

### Imágenes de X

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

### Facebook

- **Vídeos, reels, watch y fotos**, con botón en cada medio.
- **Se elige la mejor pista CON audio**: `playable_url_quality_hd` (MP4 progresivo con el audio
  dentro) antes que la versión ligera, y **nunca** un trozo del DASH (`bytestart`/`byteend`).
- **Solo audio M4A de verdad**: el manifiesto DASH de Facebook sí trae la **pista de audio suelta**,
  así que se descarga tal cual, **sin recomprimir** (a diferencia de Instagram).
- **Solo audio MP3**: se decodifica esa pista (o el MP4) y se recodifica en tu equipo.
- **Respaldo público**: si los datos internos no aparecen (páginas públicas sin sesión), se usa el
  MP4 de `<meta property="og:video">`, avisando de que la calidad es menor (suele ser 360p).
- **Las URLs se usan tal cual**: van firmadas (`oh=` / `oe=`) y caducan.
- **Rescate si el CDN rechaza la descarga** (403): se reintenta bajando los bytes desde la página.

**Límite honesto:** Facebook sirve el vídeo **con audio** como máximo en 720p. Las resoluciones
mayores (1080p+) solo existen en el DASH con **audio y vídeo separados**, y unirlos requiere
remultiplexar (un muxer o ffmpeg), que la extensión no incluye. Para el audio eso no es problema
(se coge la pista suelta), pero para vídeo 1080p con sonido habría que añadir ese paso.

**Igual que en Instagram:** Facebook exige sesión para casi todo, así que **esta parte la pruebas tú**;
si algo falla, popup → **General** → **Copiar informe** y me lo pasas.

### YouTube (a través de yt-dlp)

- **Vídeos, Shorts y el minirreproductor no** (los Shorts llevan el botón a la izquierda para no
  tapar la columna de acciones).
- **Máxima calidad de verdad**: hasta 4K con imagen y sonido, no el 720p de los MP4 progresivos.
- **M4A original** (pista AAC de YouTube, **sin recomprimir**) y **MP3** recodificado con ffmpeg.
- **Códec a elegir**: H.264 (se ve en cualquier reproductor, opción por defecto) o lo mejor que
  ofrezca YouTube aunque sea VP9/AV1.
- **Cookies de Chrome** como opción, para vídeos con restricción de edad o cuando YouTube pide
  iniciar sesión.
- **Progreso en directo** sobre el propio vídeo: porcentaje, tamaño, velocidad y tiempo restante, y
  los avisos de yt-dlp traducidos al español (403 → «actualiza yt-dlp», «pide iniciar sesión» → activa
  las cookies, etc.).

**Cómo funciona (y por qué así).** La extensión **no descarga YouTube**: le pasa el trabajo a
**yt-dlp**, que se instala una sola vez en tu equipo con `Instalar yt-dlp para X media.cmd`. El motivo
está medido contra YouTube real (septiembre de 2026):

- El reproductor web ya **no recibe URLs de archivo**. Usa **SABR** (`serverAbrStreamingUrl`, con
  respuestas `application/vnd.yt-ump`) y los formatos adaptativos llegan **sin `url` y sin
  `signatureCipher`**; el único progresivo (itag 18) llega **cifrado**.
- Reutilizar las URLs que pide el reproductor **no sirve**: la de SABR contesta `sabr.malformed` (31
  bytes) o **403** si se le añaden `itag=`/`range=`, y la ruta `/videoplayback/<itag>` también da 403.
- Los clientes de Innertube (ANDROID/IOS/WEB) contestan **400 / UNPLAYABLE**: exigen la versión de
  cliente y el *po_token* actuales, que cambian cada pocas semanas.

Descifrar firmas e implementar UMP/SABR dentro de una extensión es, literalmente, reescribir yt-dlp
(por eso yt-dlp se actualiza casi a diario). Así que se usa yt-dlp: la extensión solo pone el botón,
recoge tus ajustes y **lanza y muestra** la descarga.

**El servicio local** es un *host de mensajería nativa* de Chrome: un ejecutable de 24 KB
(`native/ytdlp-host.cs`, compilado por el instalador) que Chrome arranca únicamente cuando pulsas
«Descargar» y que termina al acabar. **No abre puertos, no deja procesos en segundo plano y no pide
permisos de administrador**: el instalador escribe el manifiesto en `%LOCALAPPDATA%\XVD-YTDLP` y lo
registra en tu usuario (Chrome, Chromium y Edge).

> **Aviso honesto:** descargar vídeos de YouTube va contra sus [términos de servicio](https://www.youtube.com/t/terms)
> salvo que el contenido sea tuyo o tengas permiso. Esta función es para eso: tus vídeos, material
> con licencia libre o descargas que YouTube permite. Por el mismo motivo, una extensión así no
> pasaría la revisión de la Chrome Web Store.

### Comunes

- **Botones flotantes** con el estilo visual de X, que no bloquean ni modifican los controles
  nativos ni la reproducción, y **no interfieren con el lightbox** (en el visor ampliado el botón
  se desplaza a la esquina inferior derecha para no tapar los controles de X).
- **Organización por carpetas**: elige o crea la carpeta de destino desde el popup y todo lo que
  descargues se guarda ahí. Ver «Organización por carpetas» más abajo.
- **Plantillas de nombre de archivo** independientes para X (vídeo e imagen), Instagram, Facebook y
  YouTube.
- **Interruptor on/off** general y otros por sitio (imágenes, Instagram, Facebook, YouTube).
- **Avisos en español** dentro de la propia página: progreso, éxito y errores claros.

---

## Organización por carpetas

En el popup, pestaña **General**, la primera tarjeta es **«Carpeta de destino»**:

```
📁 Descargas/IRONMOUSE Torneo          ← dónde se guardará todo, siempre visible
Carpeta nueva (se crea al descargar):  [ IRONMOUSE Torneo ]
[ Crear carpeta ]   [ Usar la predeterminada ]
Se creará: Descargas/IRONMOUSE Torneo
```

- **Campo para escribir el nombre** de una carpeta nueva. Permite anidar con `/`:
  `Extension/Fortnite`.
- **Lista de carpetas ya usadas**: el campo es un desplegable, así que puedes elegir una anterior; al
  seleccionarla se aplica sola.
- **Botón «Crear carpeta»** que la registra y la deja como destino de las descargas.
- **El destino actual se ve siempre** arriba, con la ruta completa dentro de Descargas.
- **«Usar la predeterminada»** vuelve a `Descargas` sin subcarpeta.
- **Se recuerda** la última carpeta (en `chrome.storage.sync`, así que sobrevive al cierre del
  navegador) y puedes cambiarla cuando quieras.
- **Sirve para todo**: vídeo, imágenes, carruseles y audio, en X, Instagram y Facebook.
- **Sin duplicados**: `Fortnite`, `fortnite ` y `FORTNITE` son la misma carpeta: se reutiliza la que
  ya existe y se avisa en lugar de crear otra.
- **Nombre saneado**: los caracteres que Windows y Chrome no admiten (`\ / : * ? " < > |`) pasan a
  `_`, se quitan puntos y espacios finales y **nunca se puede salir de Descargas**
  (`../../etc/passwd` → `etc/passwd`).
- **La carpeta se crea sola**, sin permisos de escritura ni carpetas a mano: Chrome crea la
  subcarpeta la primera vez que descarga, porque la ruta viaja en la propiedad `filename`:

  ```js
  chrome.downloads.download({ url, filename: 'IRONMOUSE Torneo/imagen_01.jpg' });
  chrome.downloads.download({ url, filename: 'IRONMOUSE Torneo/video_01.mp4'  });
  ```

  Es la forma que documenta Chrome: rutas **relativas** dentro de la carpeta de Descargas permitida
  por el navegador. La extensión nunca pide acceso al sistema de archivos.

### Instagram

- **Publicaciones con foto, carruseles (varias fotos o vídeos) y Reels**, con botón en cada elemento
  y **contador de posición** (`1/3`, `2/3`…).
- **La mejor versión disponible**: para los vídeos se elige la mayor de `video_versions`
  (p. ej. 1080×1920 frente a 720×1280) y para las fotos el mayor de `image_versions2.candidates`.
- **Las URLs se usan tal cual**: Instagram las firma (`oh=` / `oe=`) y caducan, así que **no se
  reescriben** (a diferencia de `pbs.twimg.com`, donde sí se cambia el tamaño pedido).
- **Solo audio en MP3**: el MP4 de Instagram lleva el audio dentro, así que se descarga, se
  decodifica y se recodifica a MP3. Con `M4A` se avisa y se entrega el MP4 (IG no publica la pista
  de audio por separado).
- **Rescate si el CDN rechaza la descarga** (403 por cookies o *referer*): se reintenta bajando los
  bytes desde la propia página, que sí las tiene, y se guardan igual que los demás.
- **Los módulos están separados por sitio**: `instagram.js` solo actúa en instagram.com,
  `content.js`/`images.js` solo en X. Así no aparecen botones de un sitio en el otro.

**Lo que necesitas saber:** Instagram exige sesión, así que esta parte **la tienes que probar tú**;
yo no puedo entrar en tu cuenta. Si algo falla, abre el popup → **General** → **Copiar informe** y
me lo pasas: el registro dice exactamente qué encontró el puente y por qué se eligió cada URL.
Descargar contenido ajeno puede ir contra las condiciones de Instagram; automatizar mucho puede
limitar la cuenta.

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
8. **Solo para YouTube**: ejecuta una vez **`Instalar yt-dlp para X media.cmd`** (doble clic). Compila
   e instala el servicio local de descargas. No hace falta para X, Instagram ni Facebook, y no
   necesita permisos de administrador.

> Navegadores compatibles: Chrome 102 o superior, Edge, Brave y cualquier derivado de Chromium con
> soporte de Manifest V3. En Firefox MV3 el service worker es parcialmente distinto y no está
> garantizado.

### Actualizar desde la versión 1.x (solo videos)

Al ser la versión **2.0.0** se añade `images.js` y el permiso de host de `pbs.twimg.com`. Tras
sustituir los archivos, pulsa **↻ (Actualizar)** en `chrome://extensions/` y **recarga** las
pestañas de X para que se inyecte el nuevo módulo.

### Actualizar a la versión 2.1.x (importante: arregla la descarga de video)

La 2.1.0 incorpora `page-bridge.js`, el puente en el mundo MAIN que arregla la extracción del
manifiesto del video, y añade el **registro de diagnóstico**. Si notabas que el botón aparecía pero
la descarga no arrancaba, esta es tu actualización. La 2.1.1 solo mejora el registro (tamaño,
duración y ruta del archivo descargado).

1. Sustituye los archivos (o `git pull` si clonaste el repositorio).
2. En `chrome://extensions/`, pulsa **↻ (Actualizar)** y comprueba que la versión muestra **2.1.x**.
3. **Recarga todas las pestañas de X**: el puente se inyecta al cargar la página, así que una pestaña
   abierta antes de actualizar no lo tendrá.
4. Abre el popup → pestaña **General** → el resumen del diagnóstico debe indicar **`puente activo ✓`**.

---

## Actualizar la extensión (botón «Actualizar X media»)

Actualizar una extensión desempaquetada necesita **dos pasos**, y no es una limitación de esta
extensión sino de Chrome:

> **Chrome prohíbe que una extensión lea o escriba sus propios archivos.** Puede recargarse (el botón
> ↻ de `chrome://extensions`), pero no puede descargar y sustituir su propio código: si pudiera, sería
> un vector de ataque evidente. Tampoco sirve `chrome.runtime.reload()` desde el popup: en las
> pruebas deja la extensión sin volver, así que **no se usa**.

El flujo es este:

1. **Doble clic en `Actualizar X media`** (escritorio). Descarga la última versión desde GitHub,
   sustituye los archivos de la carpeta de la extensión y abre `chrome://extensions`.
2. **Pulsa ↻ (Actualizar)** en la tarjeta «Descargador de medios para X». Las pestañas de X abiertas
   **se recargan solas** para aplicar el código nuevo (lo hace el *vigilante de contexto* de
   `content.js`, que detecta que la extensión se recargó).

La extensión te avisa cuando hay algo pendiente, sin que tengas que acordarte:

- **Insignia `NEW`** en el icono de la barra de herramientas.
- En el popup, pestaña **General** → **Versión y actualización**: compara la versión *en marcha* con
  la que hay *en disco* y, si hay una nueva, lo dice y el botón **«Actualizar extensión»** abre
  `chrome://extensions` para que pulses ↻.

El script `actualizar.ps1` también se puede ejecutar a mano:

```powershell
powershell -ExecutionPolicy Bypass -File actualizar.ps1 -Destino "C:\ruta\a\la\extension"
```

Y si prefieres hacerlo a mano, siempre vale lo de siempre: copiar los archivos y pulsar ↻.

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
| **Formato de video** | `Auto`, `MP4`, `WebM`, `M4A`, `MP3` | `Auto` = mejor variante disponible. `MP4` es el valor por defecto. `M4A`/`MP3` descargan **solo el audio**. |
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
├── images.js            Módulo de IMÁGENES de X (se carga después de content.js)
├── instagram.js         Módulo de INSTAGRAM (fotos, carruseles, reels)
├── facebook.js          Módulo de FACEBOOK (vídeo, reels, fotos y audio del DASH)
├── youtube.js           Módulo de YOUTUBE (delega la descarga en yt-dlp)
├── background.js        Service worker: descargas, registro y puente con el host nativo
├── popup.html           Popup con pestañas Videos | Imágenes | General
├── popup.js             Lógica del popup (chrome.storage.sync)
├── styles.css           Estilos: botones, contadores, avisos y popup (una sola hoja)
├── folders.js           Saneado y memoria de carpetas de destino (compartido con el popup)
├── instalar-ytdlp.ps1   Instalador del servicio de yt-dlp (solo YouTube)
├── Instalar yt-dlp para X media.cmd   Lanzador del instalador (doble clic)
├── native/
│   └── ytdlp-host.cs    Host de mensajería nativa: ejecuta yt-dlp y cuenta el progreso
├── icons/
│   ├── icon16.png       Icono de barra
│   ├── icon48.png       Icono de gestión de extensiones
│   └── icon128.png      Icono de instalación / Chrome Web Store
├── tools/
│   ├── make-icons.js    Generador de iconos sin dependencias (opcional)
│   ├── test.js          Pruebas de la lógica pura (94 comprobaciones)
│   ├── check-popup.js   Comprobación de coherencia popup.html ↔ popup.js
│   ├── test-host.js     Prueba del host nativo sin Chrome (protocolo y descargas reales)
│   ├── e2e-test.py      Prueba end-to-end de X, Instagram y Facebook (66 comprobaciones)
│   ├── e2e-youtube.py   Prueba end-to-end de YouTube con red real y ffprobe (23 comprobaciones)
│   ├── build-audio-test.js  Une la pista de audio de un HLS a un M4A (para pruebas)
│   └── fixtures/
│       └── tweet-video-2100475914182107353.json   Tweet real usado como fixture
├── vendor/
│   ├── lamejs.iife.js       Codificador MP3 (lamejs 1.2.7, LGPL) — solo para M4A→MP3
│   └── lamejs.LICENSE.txt   Licencia de la librería
└── README.md            Este documento
```

> **Licencia de terceros:** `vendor/lamejs.iife.js` es [lamejs](https://github.com/breezystack/lamejs)
> 1.2.7, bajo **LGPL**. Se incluye sin modificar junto a su licencia. Solo interviene cuando pides
> MP3; si no lo usas, puedes borrar la carpeta `vendor/` y la extensión sigue funcionando (el resto
> del audio es unión de segmentos, sin dependencias).

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
| `log(level, area, msg, detail)` | Registro de diagnóstico compartido (ver más abajo). |
| `toast(...)` / `sendMessage(...)` / `sleep(...)` | Avisos en español y mensajería interna. |

`page-bridge.js` va aparte porque **debe ejecutarse en el mundo de la página**, no en el aislado.

### Flujo de mensajería

```
                 chrome.runtime.sendMessage                    chrome.downloads.download
 [content.js]  ─────────────────────────────▶ [background.js] ─────────────────────────▶ Chrome
 [images.js]   ◀──── XVD_DOWNLOAD_EVENT ─────┘
                (complete / interrupted → respaldo: menor calidad o resolución alternativa)

 [content.js] ── window.postMessage ──▶ [page-bridge.js]  (mundo MAIN: fibras de React)
 [popup.js] ── chrome.storage.sync ──▶ content.js + images.js (chrome.storage.onChanged)
            ├─ XVD_PING ─────────────▶ { videos, images, bridge }  (estado de la pestaña)
            └─ chrome.storage.session ◀── XVD_LOG  (registro de diagnóstico)
```

- **content.js / images.js** nunca descargan directamente: resuelven la URL y delegan.
- **background.js** es la única parte que toca `chrome.downloads` y traduce los errores al español.
- **popup.js** escribe en `chrome.storage.sync`; los módulos reaccionan sin recargar.

---

## Cómo obtiene la URL del video

Los videos de X se reproducen por *streaming* (MSE), así que el `src` del `<video>` es un `blob:`
inutilizable. El manifiesto con las calidades reales vive en las **props de React** de la página o
en su **estado global**, y ahí está el detalle importante:

> **Un content script no puede leer eso.** Chrome ejecuta los content scripts en un *mundo aislado*:
> comparten el DOM, pero **no** los globales de JavaScript ni las propiedades añadidas a los nodos.
> Comprobado en un navegador real:
>
> | | Mundo aislado (content script) | Mundo MAIN (página) |
> | --- | --- | --- |
> | Atributo DOM (`poster`) | ✅ | ✅ |
> | `nodo.__reactFiber$…` | ❌ | ✅ |
> | `window.__INITIAL_STATE__` | ❌ | ✅ |
> | `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` | ❌ | ✅ |

Por eso la extensión incluye **`page-bridge.js`**, declarado en el manifiesto con `"world": "MAIN"`
(lo inyecta Chrome, así que la CSP de x.com no lo bloquea). El content script le pide el manifiesto
por `window.postMessage` y el puente responde con las entidades multimedia.

```
content.js (mundo aislado)                    page-bridge.js (mundo MAIN)
   │  {kind:'request', mediaId, poster}          │
   ├──────────── window.postMessage ────────────▶│
   │                                             │  recorre fibras de React,
   │                                             │  props y estado global
   │  {kind:'response', media:[…]}               │
   ◀─────────────────────────────────────────────┤
```

**Cascada de estrategias** (el puente cubre las tres primeras):

1. **Props de React (fibras).** `__reactProps$…` / `__reactFiber$…` del propio `<video>`, de sus
   contenedores y del `<article>` del tweet. Es la vía fiable y la primera que se intenta.
2. **Estado global.** `window.__INITIAL_STATE__`, `__NEXT_DATA__`, `__APOLLO_STATE__`,
   `__PRELOADED_STATE__` (compatibilidad con estructuras heredadas de Twitter).
3. **Árbol global de React** vía `__REACT_DEVTOOLS_GLOBAL_HOOK__`, con tope de nodos.
4. **Peticiones de red.** Entradas de `performance.getEntriesByType('resource')`, que sí funcionan
   en el mundo aislado: se filtran por el id del video, se descarga el `.m3u8` y se leen
   `BANDWIDTH`, `RESOLUTION` y `CODECS`.
5. **`<video>` / `<source>`.** Último recurso: `currentSrc`, `src` y los `<source>` hijos.

**Identificación del video correcto.** El id se extrae del póster
(`pbs.twimg.com/amplify_video_thumb/<id>/…`) y se cruza con los candidatos; el puente busca
justamente el `<video>` cuyo `poster` coincide. Así, en un tweet con cita (dos videos) o en un
timeline con varios, nunca se descarga el equivocado. La resolución se repite en el momento del
clic, nunca al pintar el botón.

**Selección de calidad.** Orden por `altura × 1e7 + bitrate`, filtrado por el `content_type` del
formato pedido y por la altura mínima si la calidad es personalizada. La lista ordenada se conserva
para el respaldo de menor calidad.

---

## Solo audio (M4A y MP3)

En X, los MP4 que publica la API llevan vídeo y audio juntos, pero **el stream HLS sí trae la pista
de audio suelta**. Comprobado sobre el manifiesto real de un video:

```
#EXT-X-MEDIA:GROUP-ID="audio-32000", TYPE=AUDIO, URI="…/pl/mp4a/32000/….m3u8"
#EXT-X-MEDIA:GROUP-ID="audio-64000", TYPE=AUDIO, URI="…/pl/mp4a/64000/….m3u8"
#EXT-X-MEDIA:GROUP-ID="audio-128000", TYPE=AUDIO, URI="…/pl/mp4a/128000/….m3u8"

478x270 → audio-32000      1276x720  → audio-128000
638x360 → audio-64000      1914x1080 → audio-128000
```

Esa playlist de 128 kbps es fMP4 (`#EXT-X-MAP` + 8 segmentos `.m4s`), sin cifrar y de **366 KB**
frente a los 40 MB del vídeo 4K.

- **M4A**: se une el segmento inicial con los segmentos y se guarda tal cual. **Sin recomprimir**: es
  exactamente el AAC que publica X.
- **MP3**: se decodifica ese M4A (`OfflineAudioContext.decodeAudioData`) y se recodifica con
  **lamejs** dentro del navegador. Medido: **1,2 s** para 23 s de audio. Como es una recodificación,
  la calidad baja un poco; si quieres el original, usa M4A.

**Dónde se hace cada cosa** (y por qué):

| Paso | Dónde | Motivo |
| --- | --- | --- |
| Elegir la pista y unir los segmentos | content script | Tiene acceso a la red de la página y a Web Audio. |
| Recodificar a MP3 | content script | `lamejs` se inyecta en la pestaña solo cuando hace falta (165 KB, no 25 MB de ffmpeg). |
| Crear el archivo | documento offscreen | Hay que fabricar un Blob en memoria y darle una URL descargable. |
| Lanzar la descarga | service worker | Es quien tiene `chrome.downloads` y el seguimiento (carpeta, avisos, registro). |

> Dos cosas que cuestan un rato averiguar y quedan documentadas en el código:
> 1. `chrome.runtime.sendMessage` **serializa a JSON**, no usa *structured clone*: un `ArrayBuffer`
>    llega como `{}`. Por eso el audio viaja en trozos codificados en base64.
> 2. En un documento offscreen **no existen `chrome.storage` ni `chrome.downloads`**. Llamar a
>    `chrome.downloads.onChanged.addListener` allí lanza, aborta el archivo entero y los mensajes
>    fallan con *«Receiving end does not exist»*. El offscreen solo usa `chrome.runtime` y el DOM.

---

La extensión lleva un **registro de diagnóstico** pensado exactamente para esto. Cada paso relevante
(barrido del DOM, estrategias probadas, respuesta del puente, variante elegida, despacho a
`chrome.downloads`, interrupciones y reintentos) se anota en tres sitios:

1. La **consola de la página** (F12), con el prefijo `[XVD]`; la del service worker usa `[XVD:sw]`.
2. El popup: **General → Registro de diagnóstico**, en vivo, con un resumen arriba (versión, medios
   detectados y, sobre todo, **si el puente del mundo MAIN responde**).
3. Un botón **«Copiar informe»** que genera un texto listo para pegar en un informe de error:

```
# Informe de diagnóstico · Descargador de medios para X
versión extensión : 2.1.1
fecha             : 2026-09-18T04:05:15.825Z
navegador         : Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/153.0.0.0 Safari/537.36
pestaña           : https://x.com/i/history
videos / imágenes : 2 / 7
puente MAIN       : activo
22:04:45.561  INFO  video       Clic en «Descargar»  {"idPoster":"2100475372890472448","puente":"activo"}
22:04:45.580  INFO  resolucion  Respuesta del puente del mundo de la página  {"medios":2,"variantes":12,"ms":19}
22:04:45.581  INFO  video       Variante elegida  {"resolucion":"2160p","bitrate":25128000}
22:04:46.049  INFO  descarga    chrome.downloads.download despachado  {"id":1,"archivo":"X Videos/…_2160p.mp4"}
22:04:50.441  INFO  descarga    Descarga completada  {"tamañoMB":39.5,"segundos":4.4,"ruta":"C:\\Users\\…\\X Videos\\…"}
```

Cómo leerlo:

| Señal en el registro | Significado |
| --- | --- |
| `puente MAIN: SIN RESPUESTA` | `page-bridge.js` no se cargó: **recarga la pestaña** de X o reinstala la extensión. |
| `puente: primer uso en esta pestaña` | Normal en la primera descarga: el puente aún no había respondido. La línea siguiente lo confirma. |
| `Respuesta del puente … {"medios":0}` | El puente funciona pero X cambió su estructura: sus props ya no traen el manifiesto. |
| `Ninguna estrategia encontró el manifiesto` | Ni fibras, ni estado, ni red, ni `src` directo: el video no está disponible para la página. |
| `No se pudo identificar el video entre los candidatos` | Hay varios videos y el póster aún no estaba: reproduce el video y reinténtalo. |
| `Descarga interrumpida … codigo: SERVER_FORBIDDEN` | El CDN de X rechazó la descarga (red, antivirus o bloqueo). |
| `codigo: FILE_ACCESS_DENIED` / `FILE_NO_SPACE` | Problema de carpeta de destino o de disco. |
| Estrategia de red con `medios: 1` y error de HLS | El video solo se sirve como stream: activa el modo avanzado HLS. |

Cuando una descarga termina bien, el registro incluye el **tamaño real**, los **segundos** que tardó y la
**ruta en disco**; el aviso de la página muestra el tamaño: `Descarga completada: X Videos/…_2160p.mp4 (39,5 MB)`.

El registro se guarda en `chrome.storage.session` (memoria de la sesión, máximo 400 entradas) y
**nunca se envía a ningún servidor**. El botón «Borrar» lo vacía.

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
| `nativeMessaging` | **Solo YouTube**: hablar con el servicio local de yt-dlp (`native/ytdlp-host.cs`) para lanzar la descarga y recibir el progreso. Sin ese servicio instalado no se usa para nada. |
| `host_permissions` | X (`x.com`, `twitter.com`, `pbs.twimg.com`), Instagram (`instagram.com`, `cdninstagram.com`) y Facebook (`facebook.com`, `fb.watch`). `fbcdn.net` lo comparten IG y FB. **YouTube no está**: no se hace ninguna petición desde la extensión, solo se le pasa la URL a yt-dlp. |

- **No** se recopila, envía ni analiza ningún dato. No hay servidores propios ni telemetría.
- **No** se solicitan permisos amplios (`<all_urls>`, `webRequest`, `tabs`, `cookies`…).
- Los archivos de X, Instagram y Facebook se descargan directamente desde su CDN; la extensión no
  actúa como intermediario.
- El servicio de yt-dlp (solo YouTube) se ejecuta en tu equipo, con tus ajustes, y escribe en tu
  carpeta de Descargas: **nada sale a ningún servidor que no sea el propio YouTube**. Se instala en
  `%LOCALAPPDATA%\XVD-YTDLP` y se puede quitar con `Instalar yt-dlp para X media.cmd quitar`.

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

### YouTube

- **Necesita yt-dlp instalado** (una vez, con `Instalar yt-dlp para X media.cmd`). Sin él, el popup lo
  dice y el botón avisa en vez de fallar en silencio.
- **Mantenlo actualizado.** YouTube cambia a menudo y yt-dlp se actualiza casi cada semana: si algo
  falla con un **403**, pulsa «Actualizar yt-dlp» en el popup (o vuelve a ejecutar el instalador).
- **MP3 y unir imagen con sonido necesitan ffmpeg.** Para M4A no hace falta.
- **Vídeos privados, solo para miembros, o con bloqueo regional:** no se pueden descargar (yt-dlp
  tampoco puede). Con restricción de edad o «confirma que no eres un robot», activa **«Usar las
  cookies de Chrome»** en el popup.
- **Listas de reproducción:** se descarga **solo el vídeo abierto** (`--no-playlist`), a propósito.
- **Vídeos en directo:** yt-dlp los graba mientras se emiten, pero desde el botón se comporta como una
  descarga normal; si es un directo en curso puede tardar o fallar.
- **Es la única parte que sale del navegador:** el resto de sitios se descargan dentro de la extensión.

---

## Solución de problemas

| Síntoma | Causa probable y solución |
| --- | --- |
| No aparece ningún botón | Recarga la pestaña de X. Comprueba el interruptor general y, en imágenes, «Activar los botones en imágenes». |
| «No se pudo obtener el video en la calidad solicitada» | El manifiesto aún no está cargado: reproduce el video un segundo y reinténtalo (ya se reintenta 3 veces). |
| «No se pudo obtener la imagen en la máxima resolución» | La imagen todavía no tenía `src` al hacer clic: espera a que termine de cargar. |
| «No se pudo descargar en resolución máxima, usando resolución alternativa» | `orig` no existe para esa imagen; se está descargando `4096x4096`, `large` o `medium`. |
| «No se pudo descargar la imagen: ninguna resolución está disponible» | El CDN no sirve la imagen (borrada, privada o bloqueada). |
| «Se descarga una página de error en lugar de la imagen» | Desactiva «Comprobar disponibilidad antes de descargar» y vuelve a activarla, o reintenta: el respaldo de resolución debería corregirlo. |
| Al pedir solo audio avisa de que no hay pista independiente | Ese video no publica pista suelta (pasa en videos muy antiguos o subidos sin audio separado). Usa MP4; el archivo incluye el audio. |
| El MP3 tarda unos segundos | Es normal: la conversión va a ~1,2 s por cada 23 s de audio. El aviso de la página muestra el progreso. |
| El MP3 suena peor que el M4A | Es una recodificación con pérdida. Si quieres el audio original de X, usa M4A. |
| El botón tapa la imagen en el visor ampliado | El botón ya se coloca abajo a la derecha dentro del lightbox; si aun así molesta, activa «Botón de imagen compacto» o «Mostrar los botones solo al pasar el ratón». |
| «Descargar todas» no aparece | La galería no se ha reconocido como tal (1 imagen) o el botón está desactivado en el popup. |
| El archivo se guarda sin subcarpeta | Chrome crea la carpeta indicada; los caracteres inválidos se sustituyen por `_`. |
| La descarga se corta a mitad | La extensión reintenta con la siguiente calidad o resolución. Revisa la conexión. |
| YouTube: «El servicio de yt-dlp no está instalado» | Ejecuta una vez `Instalar yt-dlp para X media.cmd` y recarga la extensión (↻ en `chrome://extensions/`). |
| YouTube: «HTTP 403» al descargar | yt-dlp desactualizado. Popup → **General** → «Actualizar yt-dlp». |
| YouTube: «pide iniciar sesión para comprobar que no eres un robot» | Activa **«YouTube: usar las cookies de Chrome»** en el popup y reinténtalo. |
| YouTube: el MP3 o el vídeo unido fallan | Falta **ffmpeg**. Se instala con `winget install Gyan.FFmpeg` (el popup lo indica). |
| YouTube: «no se encuentra yt-dlp» tras instalarlo | El instalador lo dice también: usa `winget install yt-dlp.yt-dlp` y vuelve a ejecutarlo. |
| YouTube: la descarga tarda mucho | Un 4K con audio ronda los 200 MB. Baja la calidad en el popup (pestaña **Videos** → calidad mínima) o usa M4A para solo audio. |

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
  node --check content.js && node --check images.js && node --check page-bridge.js \
    && node --check background.js && node --check popup.js
  ```

- Ejecutar las pruebas (Node 18+, sin dependencias):

  ```bash
  node tools/test.js        # 94 pruebas: variantes, calidad, nombres, HLS, imágenes, puente, carpetas y YouTube
  node tools/check-popup.js # coherencia popup.html ↔ popup.js, pestañas y estructura HTML
  ```

  `tools/test.js` carga `content.js`, `images.js`, `page-bridge.js`, `folders.js` y `youtube.js` en
  contextos aislados con stubs del navegador y valida la selección de la máxima calidad y resolución,
  los respaldos de formato, la reescritura de `name=`/`format=`, la cadena de degradación, la
  deduplicación de URLs, el saneado de rutas (`../../etc/passwd` → `etc/passwd`), los nombres indexados
  de galería, el análisis de manifiestos HLS (streams cifrados y segmentos CMAF) y la extracción desde
  las props de React, con los datos reales del tweet `2100475914182107353` (variante máxima 3828×2160).
  Además comprueba el módulo de YouTube: id del vídeo, URL canónica, colocación del botón en Shorts,
  traducción de la plantilla de nombre al formato de yt-dlp y la orden exacta que recibe el host.

- Probar el servicio de yt-dlp sin Chrome (protocolo de mensajería nativa y descargas reales):

  ```bash
  node tools/test-host.js estado          # ¿está instalado? versión, ffmpeg, carpeta
  node tools/test-host.js m4a             # descarga real y comprobación con ffprobe
  node tools/test-host.js mp4 <id> 1080   # vídeo a 1080p (imagen + sonido)
  node tools/test-host.js mp3
  node tools/test-host.js carpeta         # el saneado nunca sale de Descargas
  node tools/test-host.js actualizar
  ```

- Prueba end-to-end en un navegador de verdad (requiere Python 3.9+ y Playwright):

  ```bash
  pip install playwright && playwright install chromium
  python tools/e2e-test.py            # X, Instagram y Facebook (sin ventana)
  python tools/e2e-test.py --headed   # viendo el navegador
  python tools/e2e-youtube.py         # YouTube real + host nativo + ffprobe
  ```

  `e2e-test.py` lanza su propio Chromium con la extensión cargada y un **perfil temporal** (no toca tu
  Chrome, tus ajustes ni tus descargas), sirve una página que imita el DOM de X para el tweet real del
  fixture, pulsa los botones y comprueba las 24 aserciones: inyección de botones y contadores, pestañas
  del popup, guardado de ajustes, elección de la variante 3828×2160 y **descarga real desde el CDN de
  X** (~40 MB), cadena de degradación de imágenes (`orig → 4096x4096 → large → medium`), lote de
  «Descargar todas» con nombres indexados, avisos en español, no interferencia con el lightbox y el
  panel de diagnóstico. Deja capturas en `%TEMP%\xvd-e2e\shots`.

  `e2e-youtube.py` va **contra YouTube de verdad** (23 comprobaciones): comprueba que el popup ve el
  servicio de yt-dlp, pulsa el botón sobre un vídeo real y verifica con **ffprobe** que el MP4 trae
  imagen H.264 y sonido AAC, que el M4A es solo audio AAC, que el MP3 es MPEG válido, que todo cae en
  la carpeta elegida y con la plantilla de nombre, que el registro no tiene errores y que en Shorts el
  botón se coloca a la izquierda. Borra los archivos que descarga.

  > Nota: las descargas que lanza `chrome.downloads` **no** pasan por el interceptor de Playwright,
  > así que el vídeo se descarga de verdad desde X. Las imágenes usan rutas de prueba (`XVDTESTIMG…`)
  > que no existen en el CDN: eso permite verificar la cascada de resolución viendo cómo el servidor
  > devuelve `SERVER_BAD_CONTENT` y la extensión prueba la siguiente calidad.

- Depuración:
  - **Registro de diagnóstico:** popup → *General* → «Registro de diagnóstico» (o la consola con `[XVD]`).
  - **Content scripts:** consola de la página de X (F12) → contexto de la extensión.
  - **Service worker:** `chrome://extensions/` → *Descargador de medios para X* → «service worker».
  - **Popup:** clic derecho sobre el popup → *Inspeccionar*.

---

## Criterios de aceptación

### Videos

| Criterio | Estado |
| --- | --- |
| El botón aparece en todos los videos visibles y en los nuevos (scroll infinito) | ✅ `MutationObserver` + `ResizeObserver` + barridos programados |
| La descarga se realiza en máxima calidad por defecto | ✅ **verificado end-to-end**: el tweet de prueba descarga la variante 3828×2160 (4K, 25 Mbps) real, ~40 MB |
| El formato elegido en el popup se respeta en cada descarga | ✅ `content_type` filtrado + respaldo avisado |
| No interfiere con la reproducción ni con los controles nativos | ✅ el `<video>` nunca se modifica; verificado que el clic no se propaga |
| Reintentos y respaldo de menor calidad | ✅ 3 intentos de resolución + respaldo encadenado |
| El manifiesto se lee aunque el content script viva en un mundo aislado | ✅ `page-bridge.js` en el mundo MAIN (probado contra las fibras de React) |
| Solo audio (`M4A`) sin recomprimir | ✅ **verificado end-to-end**: 373 KB uniendo la pista AAC de 128 kbps del HLS (frente a 40 MB del vídeo) |
| Solo audio en `MP3` | ✅ **verificado end-to-end**: 368 KB, cabecera MPEG válida, 1,2 s de conversión para 23 s de audio |

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
| Permisos mínimos | ✅ `downloads`, `storage`, `activeTab`, `scripting`, `nativeMessaging` (solo YouTube) + hosts de X, Instagram y Facebook |
| Interfaz íntegramente en español | ✅ botones, avisos y popup con pestañas |
| Arquitectura modular (video ≠ imágenes) | ✅ `content.js` (núcleo + video) e `images.js` (imágenes) sobre `__XVD_CORE__` |

### YouTube

| Criterio | Estado |
| --- | --- |
| El botón aparece en vídeos y Shorts | ✅ **verificado end-to-end** en youtube.com real (y en Shorts, colocado a la izquierda) |
| Máxima calidad de verdad, con imagen y sonido | ✅ **verificado end-to-end con ffprobe**: MP4 1280×720 H.264 + AAC en el ajuste de 720p, hasta 4K si no se limita |
| Solo audio M4A sin recomprimir | ✅ **verificado con ffprobe**: pista AAC original (3,3 MB frente a 29 MB del vídeo) |
| Solo audio MP3 | ✅ **verificado con ffprobe**: audio MPEG válido, recodificado por ffmpeg |
| La carpeta y la plantilla del popup se respetan | ✅ **verificado end-to-end**: `Descargas/XVD Pruebas E2E/youtube_<canal>_<título>_<id>.mp4` |
| Progreso visible y errores en español | ✅ porcentaje, tamaño, velocidad y ETA en la página; 403 / cookies / ffmpeg traducidos |
| Sin permisos de administrador ni puertos abiertos | ✅ host de mensajería nativa registrado solo en el usuario; Chrome lo arranca y termina por descarga |
| El saneado de carpetas no permite salir de Descargas | ✅ probado en el propio host (`../fuera`, `C:\Windows` → dentro de Descargas) |
| No inventa: si no hay yt-dlp, lo dice y explica cómo instalarlo | ✅ aviso en el popup y en la página, sin fallar en silencio |

---

## Licencia

Uso personal y educativo. Respeta los términos de servicio de X y los derechos de autor del
contenido que descargues: descarga únicamente material propio o con permiso explícito.
