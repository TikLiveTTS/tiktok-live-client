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

**Arquitectura confirmada tras varias rondas de spike (ver "Hallazgos"
abajo):** SÍ hay un WebSocket real (`wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/...`)
que empuja chat/gifts/likes/members en vivo — el primer spike no lo vio
porque `session.webRequest` de Electron no intercepta WebSockets, hacía
falta el protocolo CDP (`webContents.debugger`) para verlo. A diferencia de
`im/fetch` (que usa una firma atada al querystring completo, no reusable),
la URL del WS lleva su firma (`X-Bogus`) sobre parámetros de conexión
estables (room_id, device info) — **no** sobre un cursor que cambia en cada
mensaje. Eso significa que la ventana invisible solo necesita vivir lo
suficiente para generar esa URL firmada UNA vez; a partir de ahí Node abre
y mantiene su propia conexión WebSocket con el paquete `ws`, maneja el
heartbeat (cada 10s, visto en la propia URL) y decodifica los frames
entrantes con su propio parser protobuf (`src/decode/`, ver abajo) — sin
mantener el Chromium invisible corriendo todo el tiempo de la conexión.

## Requisito de entorno

**Necesita un proceso Electron vivo.** La extracción de firma depende de
`BrowserWindow`, que solo existe dentro de Electron. A diferencia de
`tiktok-live-connector`, este paquete **no funciona en Node puro** ni en un
script standalone sin Electron.

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

const client = new TikTokLiveClient(username, {
  requestPollingIntervalMs: 2000, // sin uso por ahora, reservado para paridad de opciones
});

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
client.on('disconnected', () => { /* ... */ }); // conexion caida, transitoria
client.on('streamEnd', () => { /* ... */ });    // el directo termino de verdad
client.on('error', (err) => { /* err es un Error real, con .message y .stack */ });

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
- **`disconnected`**: sin payload. Conexión caída, se espera reintento con
  backoff por parte de quien orquesta (igual que hoy: la política de
  reconexión vive en TikLiveTTS, no en este paquete).
- **`streamEnd`**: sin payload. El directo terminó de verdad — no reintentar.

### Manejo de fallas de signing

Si la extracción de firma falla (TikTok cambió su JS, la ventana no pudo
navegar, timeout, etc.), `connect()` rechaza con un `Error` tipado
(`err.code === 'SIGNING_FAILED'`) con `.message` describiendo la causa. No
lanza excepciones sin capturar — todo error observable sale por `error` o por
el rechazo de la promesa de `connect()`, para que TikLiveTTS lo pueda loguear
a GlitchTip igual que hace con sus otros canales.

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

1. **TTL real de la URL firmada del WS** — cuánto se puede reconectar
   reusando la misma sesión/URL antes de necesitar que la ventana invisible
   genere una nueva.
2. **Reconexión**: qué pasa cuando el WS cae (heartbeat_duration=10000 visto
   en la URL sugiere que hay que mandar pings) — todavía no implementado.
3. **Nivel del club de fans** — se detecta membresía (`isFanClubMember`),
   pero no se decodificó el nivel/rango dentro del club (visto en la UI como
   badge "No.1" de top contribuyente, que podría ser algo distinto al nivel
   del club en sí). No es parte del pedido original (solo se necesitaba
   distinguir miembro/no-miembro), así que no se investigó más.

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
- [ ] Cliente WS en Node (`ws`) que reusa la URL firmada capturada, maneja
      heartbeat y reconexión con backoff.
- [ ] Clase pública `TikTokLiveClient` (API documentada arriba) que orquesta
      todo: ventana invisible → URL firmada → WS en Node → eventos —
      incluir `viewerCount` y `isFanClubMember` en el contrato público.
- [ ] Publicación inicial a GitHub Packages.
