# @tiklivetts/tiktok-live-client

Cliente de TikTok LIVE (chat, gifts, likes, follows, viewer count) para usar
dentro de la app Electron [TikLiveTTS](https://github.com/iKhunsa/tiktok-tts).
Reemplaza a `tiktok-live-connector` + Eulerstream: en vez de pagar un servicio
externo que resuelve la firma anti-bot de TikTok, este paquete la resuelve
localmente con un Chromium invisible (el que ya trae Electron) y abre la
conexión WebSocket al webcast directamente en Node.

Cada usuario de TikLiveTTS corre su propia instancia — no hay ningún servidor
centralizado nuestro en el medio.

## Por qué existe

TikTok exige parámetros firmados (`X-Bogus`, `msToken`, `signature`) para
aceptar una conexión al WebSocket del chat de un live. Ese cálculo lo hace un
JS ofuscado que corre en el navegador de tiktok.com. Eulerstream resuelve esto
con una granja de navegadores headless propia y lo cobra por uso.

Este paquete resuelve lo mismo con el Chromium que Electron ya trae: una
`BrowserWindow` invisible navega tiktok.com y ejecuta el JS real de TikTok, lo
que genera naturalmente parámetros firmados legítimos.

**Arquitectura actual (`TikTokLiveClient`, `src/client.js` +
`src/signing/live-window.js`):** SÍ hay un WebSocket real
(`wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/...`) que empuja
chat/gifts/likes/members en vivo — el primer spike no lo vio porque
`session.webRequest` de Electron no intercepta WebSockets, hacía falta el
protocolo CDP (`webContents.debugger`) para verlo.

La `BrowserWindow` invisible **se queda viva todo el tiempo que dure la
conexión** y hace ella misma todo el trabajo pesado: resuelve la firma,
abre el WS, y maneja el protocolo interno completo de TikTok (heartbeat
cada 10s, un frame `im_enter_room` de "entrar a la sala", acks por cada
mensaje recibido). `LiveWindow` solo escucha, vía CDP, los frames que la
página ya recibió correctamente autenticados, y los decodifica — nunca
arma ni firma un request propio. Es el camino **probado y funcionando**
(validado en vivo contra 3 lives distintos, ver "Estado").

**Camino alternativo, INCOMPLETO** (`src/signing/get-signed-ws-info.js` +
`src/ws/webcast-socket.js`): capturar la URL firmada UNA vez y que Node
abra su propia conexión WS con el paquete `ws`, sin mantener el Chromium
vivo. Se llegó a conectar (agregando headers `Origin`/`User-Agent` que
Node no manda solo, más un frame `im_enter_room` reconstruido a mano), pero
el servidor nunca empezó a empujar mensajes reales — falta al menos un paso
más del protocolo interno (posiblemente el mecanismo de acks) que no se
terminó de reversar. Documentado tal cual quedó, no se borra porque casi
funciona y puede retomarse con otra sesión de captura.

## Aislamiento de proceso

`TikTokLiveClient#connect()` (`src/client.js`) **no crea la `BrowserWindow`
en el proceso que la llama** — lanza un proceso Electron aparte
(`src/signing/worker-entry.js`, via `child_process.spawn(process.execPath, ...)`)
dedicado a esa sola conexión, y se comunica con él por IPC. `LiveWindow`
(`src/signing/live-window.js`) sigue siendo la implementación real de la
firma+WS; el worker solo la corre aislada.

**Por qué:** validado en producción contra TikLiveTTS — corriendo
`LiveWindow` en el mismo proceso que un servidor Express + WS server +
hooks globales (uiohook-napi), TikTok rechazaba la firma con `403` y
`X-Bogus`/`msToken` con valores placeholder (`X-Bogus=1`, `msToken` vacío)
de forma consistente y reproducible, incluso con sesión/`device_id` recién
creado — o sea, no era rate-limit ni sesión marcada, era específicamente
"este proceso Electron generó una firma inválida". El mismo código,
corriendo en un proceso Electron standalone sin nada más alrededor, firmó
bien el 100% de las veces. No se identificó la causa exacta dentro de
Chromium/V8 (se descartaron por prueba: cache del Service Worker, timers
throttleados por ventana en background, uiohook-napi) — el fix fue aislar
el proceso, no perseguir el porqué exacto.

**Contrato para la app consumidora:** en dev, `electron <script>` ya
arranca `worker-entry.js` directo por `argv`, no hace falta nada extra. En
un build **empaquetado**, `process.execPath` es el exe de la app, que
siempre carga su propio entrypoint sin importar el `argv` — por eso
`client.js` además pasa `TIKLIVETTS_WORKER_SCRIPT` por variable de entorno,
y el entrypoint de la app consumidora tiene que chequearla ANTES de su
bootstrap normal:

```js
// main.js, primera linea util, antes de cualquier otro require con side-effects
if (process.env.TIKLIVETTS_WORKER_SCRIPT) {
  require(process.env.TIKLIVETTS_WORKER_SCRIPT);
  return;
}
```

Sin este chequeo, cada intento de conexión a TikTok abriría una segunda
instancia completa de la app empaquetada en vez del worker aislado.

## Requisito de entorno

**Necesita un proceso Electron vivo durante TODA la conexión**, no solo al
arrancar — la `BrowserWindow` invisible del worker se queda corriendo
(silenciada con `setAudioMuted(true)`, nunca se escucha el audio del live).
A diferencia de `tiktok-live-connector`, este paquete **no funciona en Node
puro**; necesita poder lanzar un proceso Electron completo (`process.execPath`
tiene que resolver a un binario de Electron o a una app empaquetada con él).

## Sesión

Nunca pide ni usa las credenciales de la cuenta real del streamer. Ver el chat
de un live público no requiere estar logeado como su dueño — el paquete usa
una sesión anónima de TikTok, persistida en disco entre reinicios (para no
parecer un "dispositivo nuevo" en cada arranque, lo que aumentaría el riesgo
de fricción anti-bot). Esa sesión vive en su propia partition de Electron,
separada de cualquier sesión que la app principal use para otra cosa.

## API pública

```js
const { TikTokLiveClient } = require('@tiklivetts/tiktok-live-client');

const client = new TikTokLiveClient(username);

const { roomInfo } = await client.connect(); // resuelve al conectar, rechaza si falla
// roomInfo: shape crudo de TikTok (owner.followInfo.followerCount, etc.) —
// mismo shape que ya consume TikLiveTTS hoy (features/overlay/state/extract-follower-count.js).

client.on('chat', (data) => { /* ... */ });
client.on('gift', (data) => { /* ... */ });
client.on('like', (data) => { /* ... */ });
client.on('member', (data) => { /* ... */ });   // alguien entra a la sala
client.on('follow', (data) => { /* ... */ });
client.on('share', (data) => { /* ... */ });
client.on('roomUserSeq', ({ viewerCount }) => { /* ... */ }); // viewer count en vivo
client.on('disconnected', () => { /* ... */ }); // la ventana se cerro/murio
client.on('error', (err) => { /* err es un Error real, con .message y .stack */ });
client.on('streamEnd', () => { /* el streamer corto el directo */ });

client.disconnect();
client.removeAllListeners();
```

Diseñado como paridad 1:1 con el subset de `WebcastPushConnection` que hoy
consume `features/canales/tiktok/connect-tiktok-channel.js` en TikLiveTTS, para
que integrarlo sea cambiar el `require` y no el resto del dominio.

### Shape de cada evento

Todos los payloads son objetos planos (no instancias de clase), con al menos
estos campos (los que hoy lee TikLiveTTS — no se agregan campos extra
"por si sirven después"):

Todos los eventos con datos de usuario incluyen `isFanClubMember` (boolean),
para poder: (a) tratar a un fan club member como "ya sigue" sin depender del
evento `follow` (muchos fans viejos nunca disparan un follow nuevo), y (b)
filtrar el TTS para leer solo chat de miembros del club de fans si se quiere.

- **`chat`**: `{ comment, nickname, uniqueId, msgId, createTime, isFanClubMember }`
  - `comment` vacío o solo espacios → el emisor NO dispara el evento (mismo
    filtro que ya aplica TikLiveTTS, para no duplicar el guard en el consumidor).
  - `msgId` es el id de mensaje del server (string), único por mensaje — se
    usa para deduplicar. `'0'` cuenta como "sin id" en el consumidor actual.
- **`gift`**: `{ giftId, giftName, diamondCount, groupCount, nickname, uniqueId, isFanClubMember }`
  - `groupCount` es el conteo ACUMULADO del combo actual (no un delta) —
    diamantes totales gastados hasta ahora = `diamondCount * groupCount`.
  - **No hay un `repeatEnd` limpio** (ver "Hallazgos" abajo) — el emisor
    dispara `gift` en cada actualización del combo con el `groupCount` más
    alto visto hasta el momento; el consumidor decide si solo le interesa la
    última actualización antes de un gap de tiempo, o si prefiere mostrar el
    total actualizándose en vivo.
- **`like`**: `{ uniqueId, nickname, likeCount, isFanClubMember }`
- **`member`**: `{ uniqueId, nickname, isFanClubMember }` — alguien entra a la sala.
- **`follow`**: `{ uniqueId, nickname }`
- **`share`**: `{ uniqueId, nickname }`
- **`roomUserSeq`**: `{ viewerCount }` — cantidad de viewers en vivo, empuja
  actualizaciones periódicas (no es polling propio, es lo que ya manda
  TikTok por el WS).
- **`error`**: instancia de `Error` (con `.message` siempre no-vacío y
  `.stack`) — nunca un objeto plano `{info, exception}` como hace
  `tiktok-live-connector`. Es un contrato más simple y el `readTikTokError`
  actual de TikLiveTTS ya soporta `Error` instances sin cambios.
- **`disconnected`**: sin payload. La ventana invisible se cerró/murió — no
  hay reconexión automática todavía (ver "Preguntas abiertas"), la política
  de reintento tiene que vivir en TikLiveTTS por ahora.
- **`streamEnd`**: sin payload. El streamer cortó el directo. Se detecta
  escuchando (vía CDP, mismo mecanismo que `room/enter/`) las respuestas de
  `webcast/room/check_alive/` — el endpoint que la propia página de TikTok ya
  pollea cada ~6s — y disparando cuando el primer elemento de `data` trae
  `alive: false`. Ese shape (`{ data: [{ alive, ... }] }`) no está validado
  contra una captura propia de un directo terminando (no hay ninguna
  committeada en el repo), solo es consistente con lo documentado por otros
  proyectos que reversaron esta misma API — falla en modo seguro: si TikTok
  cambia el shape, `alive` nunca pasa a `false` y el evento simplemente no
  dispara (mismo comportamiento que antes de este cambio). Después de emitir
  `streamEnd`, `LiveWindow` llama a su propio `disconnect()` — el
  `disconnected` que sigue inmediatamente es normal, no hace falta manejarlo
  aparte.

### Manejo de fallas de signing

Si la extracción de firma falla (TikTok cambió su JS, la ventana no pudo
navegar, timeout, etc.), `connect()` rechaza con un `Error` tipado
(`err.code === 'SIGNING_FAILED'`) con `.message` describiendo la causa. No
lanza excepciones sin capturar — todo error observable sale por `error` o por
el rechazo de la promesa de `connect()`, para que TikLiveTTS lo pueda loguear
a GlitchTip igual que hace con sus otros canales.

Si la sala no está en vivo (nunca empezó o ya terminó), `connect()` rechaza
con un `NotLiveError` (`err.code === 'NOT_LIVE'`, `err.message === "The
requested user isn't online :("`). Se detecta leyendo `roomInfo.status` de la
respuesta de `room/enter/` — `status === 2` es el único valor confirmado
como "en vivo" contra una captura real; cualquier otro valor (o un body que
no parsea) se trata como no-en-vivo. No distingue "nunca empezó" de "ya
terminó" porque no hay una captura real del caso offline para separar los
códigos con confianza — el texto del mensaje es intencionalmente igual al que
usaba `tiktok-live-connector`, para que el filtro de errores esperados que ya
tiene TikLiveTTS (`ERRORES_CONEXION_ESPERADOS` en `electron-shell/glitchtip.js`)
lo reconozca sin cambios.

## Versionado y publicación

Se publica a GitHub Packages (registro privado de la org `TikLiveTTS`, ver
`publishConfig` en `package.json`). El gatillo típico de un bump de versión es
que TikTok rotó algo en su JS de firma y hubo que ajustar la extracción — no
hay un calendario de release fijo, es reactivo a roturas.

```bash
npm version patch   # o minor/major según el cambio
npm publish
```

## Protocolo de red (confirmado con capturas reales de un live activo)

```
POST webcast/room/enter/         → JSON (92KB), estado inicial de la sala (roomInfo)
GET  webcast/room/check_alive/   → JSON chico, heartbeat cada ~6s
GET  webcast/im/fetch/           → protobuf (Response), catch-up UNA sola vez al entrar
wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/...  → WebSocket real, push en vivo
```

El WS manda cada mensaje envuelto en un `PushFrame` (`seqId` incremental,
`logId`, headers tipo `{compress_type: gzip}`, y el `payload` real). El
`payload` viaja **gzip-eado** (magic bytes `1f8b` confirmados) — hay que
descomprimirlo antes de parsear. Una vez descomprimido, tiene el mismo shape
`Response` que el body de `im/fetch`: una lista de `Message{method, payload}`,
donde `method` es un string legible (`"WebcastChatMessage"`,
`"WebcastLikeMessage"`, `"WebcastMemberMessage"`, ...) y `payload` es a su vez
otro mensaje protobuf anidado, específico de ese tipo.

Pipeline completo implementado en `src/decode/decode-ws-frame.js`:
`PushFrame` → gunzip → `Response` → `Message[]` → decoder específico por
`method` (`src/proto/webcast.proto`). Validado contra bytes reales en
`test/decode-ws-frame.test.js` (fixture committeada en `test/fixtures/`, no
un mock).

### Campos validados contra capturas reales

- **`Common`** (compartido por todos los tipos): `method`(1), `msgId`(2),
  `roomId`(3), `createTime`(4), `isShown`(6), `logId`(12).
- **`User`** (compartido por Chat/Like/Member): `userIdNumeric`(1),
  `nickname`(3) — confirmado con nombres reales con espacios/emoji
  ("Thapa Binaya", "Yunℹ️sh") —, `uniqueId`(38), `secUid`(46).
- **`WebcastLikeMessage`**: `common`(1), `count`(2), `total`(3), `user`(5).
  Alta confianza — validado con un evento real (`count=2`, `total=564948`).
- **`WebcastMemberMessage`**: `common`(1), `user`(2). Alta confianza.
- **`WebcastChatMessage`**: `common`(1), `user`(2), `comment`(3). **Confianza
  ALTA** — confirmado con 10 mensajes reales de un live distinto
  (`vanba676`), incluyendo texto largo y con diacríticos vietnamitas
  (`"ăn quả suốt này không thèm phở Việt ạ bà nội"`, 44 caracteres) sin
  ningún truncamiento ni corrupción de UTF-8. Fixture en
  `test/fixtures/ws-frame-chat-vietnamese.bin`.
- **`WebcastGiftMessage`**: `common`(1), `giftId`(2), `groupCount`(5),
  `user`(7), `gift`(15 → `GiftStruct{describe(2), diamondCount(11), name(16)}`).
  **Confianza ALTA en giftId/name/diamondCount/user/groupCount** — validado
  enviando 3 regalos de precio distinto (Rose=1 diamante, Welcome Dallah=1,
  Heart Me=4 — coincide con que Rose cuesta 1 diamante, dato público
  conocido, lo que permitió aislar `diamondCount` entre varios campos
  candidatos con valor `1` ambiguo) **y un combo real** (Rosa en tap
  múltiple): `groupCount` sube `1→4→7→10→10` — es un conteo ACUMULADO del
  combo, no un delta, y el último valor se repite una vez más como "sello"
  final. **No hay un booleano `repeatEnd` limpio y aislado** como el que usa
  hoy TikLiveTTS — el mensaje final se distingue porque 3 campos de delta
  internos quedan en 0/ausentes, pero en la práctica alcanza con quedarse
  con el `groupCount` más alto visto por combo (userId+giftId) sin esperar
  una señal explícita de fin.
- **`WebcastSocialMessage`** (follow y share comparten el mismo tipo de
  mensaje): `common`(1), `user`(2). El discriminador real entre follow/share
  es `common.displayText.key` (`"pm_main_follow_message_viewer_2"` vs
  `"pm_mt_guidance_share"`), no un campo numérico — validado con un follow y
  un share reales. Alta confianza.
- **`WebcastRoomUserSeqMessage`**: `common`(1), `viewerCount`(3). Alta
  confianza — coincide exacto con el contador "Viewers · N" visible en la
  UI de TikTok al momento de la captura (`viewerCount=2` con 2 viewers en
  pantalla).
- **Club de fans** (`User.badges`, campo 64, repetido): un usuario tiene una
  entrada cuyo `detail.asset.iconPath` contiene `"fans_badge_icon"` si y
  solo si es miembro del club de fans del streamer — validado comparando,
  en el mismo live y mismo momento, un mensaje de un miembro real contra
  uno de un no-miembro (el no-miembro puede tener OTROS badges, ej. de
  nivel, pero nunca ese ícono). Helper en
  `src/decode/is-fan-club-member.js#isFanClubMember(user)`.

## Verificación de conteo de likes

Sumando los deltas de `count` de 8 actualizaciones reales de `WebcastLikeMessage`
mientras se mantuvo apretado el botón de like (`15+10+15+15+15+15+15+11 = 111`)
contra el cambio real en `total` de la sala en ese mismo lapso (`142−31 = 111`):
**coinciden exacto**. El conteo por evento y el acumulado de sala son
consistentes, sin pérdida ni duplicación.

## Preguntas abiertas

1. **Reconexión**: qué pasa cuando el WS cae — todavía no implementado en
   `LiveWindow` (hoy solo emite `disconnected` cuando la ventana se destruye).
2. **Camino Node-WS incompleto** — ver "Por qué existe" arriba. Falta un
   paso del protocolo (probablemente acks) para que sea viable sin mantener
   el Chromium vivo.
3. **Nivel del club de fans** — se detecta membresía (`isFanClubMember`),
   pero no se decodificó el nivel/rango dentro del club (visto en la UI como
   badge "No.1" de top contribuyente, que podría ser algo distinto al nivel
   del club en sí). No es parte del pedido original (solo se necesitaba
   distinguir miembro/no-miembro), así que no se investigó más.
4. **`streamEnd` vía `check_alive` sin validar contra una captura propia** —
   el shape `{ data: [{ alive, ... }] }` es consistente con lo documentado
   por otros proyectos que reversaron esta API, pero nunca se capturó tráfico
   real de un directo terminando con este repo. Si algún día se corre
   `spike:ws` mientras un streamer corta, conviene confirmar el shape real y,
   si hace falta, ajustar el parseo en `live-window.js`.
5. **`NotLiveError` no distingue "nunca empezó" de "ya terminó"** — mismo
   motivo que el punto anterior: sin una captura real del caso offline no se
   puede mapear con confianza qué otros valores toma `roomInfo.status` aparte
   de `2` (en vivo).

## Estado

- [x] Esqueleto del repo + contrato de API documentado.
- [x] Spike: ventana invisible navega a un live real, confirma protocolo de
      red completo (`spike/inspect-signing.js`, `spike/inspect-body.js`,
      `spike/inspect-ws.js`, `spike/dump-protobuf-structure.js`).
- [x] Decoder protobuf (`src/decode/`, `src/proto/webcast.proto`) validado
      contra bytes reales para Common/User/Like/Member/Chat/Gift (incl.
      combo)/Social/RoomUserSeq (viewer count) — confianza alta en los 8.
- [x] Detección de club de fans (`isFanClubMember`), validada con un
      miembro real y un no-miembro real en el mismo live.
- [x] Verificación matemática del conteo de likes (deltas suman exacto
      contra el total de sala).
- [x] Clase pública `TikTokLiveClient` (`src/client.js` +
      `src/signing/live-window.js`) — **funcionando end-to-end contra lives
      reales**: chat, gift, like, member, follow, share, roomUserSeq e
      `isFanClubMember`, todo validado en vivo (`npm run spike:client -- <usuario>`).
- [ ] Reconexión con backoff cuando el WS cae.
- [ ] Camino alternativo Node-WS puro (sin mantener el Chromium vivo) —
      incompleto, ver "Por qué existe".
- [x] Publicación inicial a GitHub Packages (`0.1.0`, registro privado de `TikLiveTTS`).
- [x] Detección de sala offline (`NotLiveError`, via `roomInfo.status`) y de
      fin de directo (`streamEnd`, via polling de `check_alive`) — ninguna de
      las dos validada contra una captura real del caso offline/fin, ver
      "Preguntas abiertas" #4 y #5.
