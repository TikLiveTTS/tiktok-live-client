'use strict';

const { EventEmitter } = require('events');
const { BrowserWindow, screen, session } = require('electron');
const { decodeWsFrame } = require('../decode/decode-ws-frame');
const { classifyRoomEnterBody } = require('./classify-room-enter');
const { classifyCheckAliveBody } = require('./classify-check-alive');
const { isTikTokLoginUrl } = require('../session/is-login-url');
const { createRoomGuard } = require('./room-guard');
const { DEFAULT_SESSION_PARTITION } = require('../session/tiktok-session');

const WS_URL_PATTERN = /webcast-ws\.tiktok\.com\/webcast\/im\/ws_proxy/;
const ROOM_ENTER_PATTERN = /webcast\/room\/enter\//;
const CHECK_ALIVE_PATTERN = /webcast\/room\/check_alive\//;
const EMPTY_BODY_MAX_ATTEMPTS = 3;
const EMPTY_BODY_RETRY_DELAY_MS = 500;
// EXPERIMENTO (a pedido explicito, ver handoff de continuidad de conexion):
// ante un cuerpo vacio de room/enter (el unico caso "sin info" real — no hay
// dato alguno, a diferencia de un status_code o un JSON invalido, que si
// traen algo), en vez de destruir la ventana al instante se la revela por
// este tiempo antes de cerrarla. Hipotesis a comprobar: el throttling de una
// ventana en segundo plano (show:false) podria ser parte de por que la
// firma/anti-bot de TikTok a veces no llega a completar a tiempo.
const AMBIGUOUS_REVEAL_MS = 5000;

class SigningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SigningError';
    this.code = 'SIGNING_FAILED';
  }
}

// roomInfo.status === 2 es "en vivo" (unico valor confirmado contra una
// captura real, ver spike/captures/). Un data.status definido pero distinto
// de 2 se sigue reportando como "no esta en vivo" (mismo texto que reconoce
// ERRORES_CONEXION_ESPERADOS en TikLiveTTS) — pero `confirmed` queda en
// `false` porque nunca se capturo una respuesta offline real que lo
// confirme (ver README, pregunta abierta #5). No se distingue "nunca
// empezo" de "ya termino" por el mismo motivo.
//
// IMPORTANTE: esto ya NO cubre body vacio, JSON invalido, forma inesperada
// ni un status_code de error de TikTok sin data.status (ej. 4003110) — esos
// casos son `LiveStatusUnknownError` (ver mas abajo), no "confirmado
// offline". Ese era el bug real: una comprobacion que fallo (no pudimos
// saber si esta en vivo) se mostraba igual que un offline confirmado.
class NotLiveError extends Error {
  constructor(username, { confirmed = false } = {}) {
    super(`The requested user isn't online :(`);
    this.name = 'NotLiveError';
    this.code = 'NOT_LIVE';
    this.username = username;
    this.confirmed = confirmed;
  }
}

// Cubre toda comprobacion de estado que NO pudo completarse con confianza:
// body vacio (retryable, ver EMPTY_BODY_MAX_ATTEMPTS abajo), JSON invalido,
// forma inesperada, un status_code de error de TikTok (se conserva en
// `tiktokStatusCode`, ej. 4003110 — visto sin `data.status`, nunca
// verificado que significa realmente, no se presenta como diagnostico
// confirmado), o un fallo al pedir el body via CDP (se conserva en
// `causeMessage`, antes se silenciaba con un catch vacio).
class LiveStatusUnknownError extends Error {
  constructor(username, reason, { tiktokStatusCode, causeMessage } = {}) {
    super(`No se pudo comprobar si ${username} esta en vivo (${reason})`);
    this.name = 'LiveStatusUnknownError';
    this.code = 'LIVE_STATUS_UNKNOWN';
    this.username = username;
    this.reason = reason; // 'empty_body' | 'invalid_json' | 'unexpected_shape' | 'tiktok_status_code' | 'body_fetch_failed'
    if (tiktokStatusCode !== undefined) this.tiktokStatusCode = tiktokStatusCode;
    if (causeMessage) this.causeMessage = causeMessage;
  }
}

// TikTok redirigio la navegacion del live a /login: exige una sesion
// autenticada para ver este live. NO es un fallo tecnico (no se arregla solo
// reintentando) ni un "no esta en vivo" — el consumidor tiene que pedirle al
// usuario que inicie sesion (openTikTokLoginWindow, misma particion) y recien
// ahi volver a conectar. Se detecta por la NAVEGACION real del frame
// principal (did-start-navigation / will-redirect), no por el ERR_ABORTED
// (-3) crudo con el que rechaza loadURL cuando la pagina se va a /login: ese
// codigo tambien aparece por otras razones tecnicas (GlitchTip #77 lo dejaba
// caer como error generico sin `code`). El mensaje es estable y en ingles a
// proposito, igual que NotLiveError: TikLiveTTS lo matchea para no reportarlo
// como issue.
class AuthRequiredError extends Error {
  constructor(username) {
    super(`TikTok requires login to open @${username}/live`);
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
    this.username = username;
  }
}

// Camino probado (ver README#hallazgos-del-spike): una BrowserWindow
// invisible navega al live con una sesion anonima propia y se queda VIVA
// todo el tiempo de la conexion. TikTok mismo hace el signing, abre el WS y
// manda el protocolo interno completo (heartbeat, enter_room, acks) — este
// modulo solo escucha, via CDP, los frames que ya llegaron correctamente
// firmados y autenticados, y los decodifica. No arma ni firma nada propio.
class LiveWindow extends EventEmitter {
  constructor(username, { partition = DEFAULT_SESSION_PARTITION } = {}) {
    super();
    this.username = username;
    this.partition = partition;
    this.win = null;
    this.dbg = null;
  }

  // Reintenta SOLO el caso "body vacio" (LiveStatusUnknownError con
  // reason:'empty_body') con una ventana nueva — cualquier otro resultado
  // (en vivo, no en vivo, JSON invalido, status_code de error, fallo de CDP)
  // se respeta a la primera, sin reintento general.
  async connect(opts = {}) {
    for (let attempt = 1; attempt <= EMPTY_BODY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this._connectOnce(opts);
      } catch (err) {
        // Todo intento fallido cierra SU ventana (timeout y reject de loadURL
        // no la cerraban: quedaba viva con la pagina de TikTok corriendo hasta
        // el proximo intento del consumidor, y podia seguir reenviando frames).
        this.disconnect();
        const lastAttempt = attempt === EMPTY_BODY_MAX_ATTEMPTS;
        const isRetryableEmptyBody = err instanceof LiveStatusUnknownError && err.reason === 'empty_body';
        if (!isRetryableEmptyBody || lastAttempt) throw err;
        await new Promise((r) => setTimeout(r, EMPTY_BODY_RETRY_DELAY_MS));
      }
    }
    return undefined; // inalcanzable, el loop siempre retorna o lanza
  }

  async _connectOnce({ timeoutMs = 30000 } = {}) {
    const spikeSession = session.fromPartition(this.partition);
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    this.win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 60, height: 60, x: width - 70, y: height - 70, webPreferences: { session: spikeSession, backgroundThrottling: false } });
    // La pagina real de TikTok reproduce el video/audio del live — invisible
    // no significa muda. Sin esto el usuario escucharia el live de fondo.
    this.win.webContents.setAudioMuted(true);
    // Ventana invisible (show:false) = "background" para Chromium, que
    // throttlea sus timers/rAF por defecto. El JS anti-bot de TikTok hace
    // checks sensibles a timing — se descarta explicitamente por las dudas,
    // aunque el aislamiento de proceso (ver README) fue lo que realmente
    // arreglo el problema real (403 con X-Bogus/msToken invalidos).
    this.win.webContents.setBackgroundThrottling(false);

    // Bug conocido de Electron (electron/electron#14810): sendCommand no
    // resuelve hasta que la ventana tiene algo cargado.
    await this.win.loadURL('about:blank');
    this.dbg = this.win.webContents.debugger;
    this.dbg.attach();
    await this.dbg.sendCommand('Network.enable');

    // TikTok mismo pollea este endpoint cada ~6s durante toda la sesion (ver
    // README#protocolo-de-red) — se escucha via CDP igual que room/enter en
    // vez de reversar el protobuf del WS (no hay ninguna captura de un
    // WebcastControlMessage de fin de directo en el repo). Shape asumido
    // `{ data: [{ alive: bool, ... }] }`, consistente con otros proyectos que
    // reversaron esta misma API — no validado contra una captura propia. Fail
    // safe: si el shape no matchea, `alive` queda true y esto nunca dispara
    // (mismo comportamiento que antes de este cambio, sin regresion).
    let streamEnded = false;
    const pendingCheckAlive = new Map();
    // Ver room-guard.js: la pagina puede saltar sola a otro directo.
    const roomGuard = createRoomGuard();
    let roomChanged = false;

    const roomInfo = await new Promise((resolve, reject) => {
      let resolved = false;
      const pendingRoomEnter = new Map();

      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; reject(new SigningError(`Timeout (${timeoutMs}ms) esperando la firma de ${this.username}`)); }
      }, timeoutMs);

      // La pagina abrio el WS de OTRA sala: ya no es el directo pedido. Antes
      // de conectar es un intento fallido mas; despues, una desconexion real
      // ('roomChanged' + 'close') para que el consumidor vuelva a entrar a
      // /@username/live en vez de leer en silencio el chat equivocado.
      const onRoomChanged = (newRoomId) => {
        if (roomChanged) return;
        roomChanged = true;
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          this.disconnect();
          reject(new SigningError(`La pagina de ${this.username} cambio de sala (${newRoomId}) antes de conectar`));
          return;
        }
        this.emit('roomChanged', { roomId: roomGuard.roomId, newRoomId });
        this.disconnect();
      };

      // Pedido de login de TikTok (ver AuthRequiredError arriba). Electron 41
      // pasa un objeto `details` y ademas los argumentos posicionales viejos
      // (url, isInPlace, isMainFrame) — se aceptan ambos. Solo el frame
      // principal: un iframe interno a /login no es la pagina del live.
      const onNavigation = (details, urlArg, _isInPlace, isMainFrameArg) => {
        const url = (details && details.url) || urlArg;
        const isMainFrame = details && details.isMainFrame !== undefined ? details.isMainFrame : isMainFrameArg;
        if (resolved || isMainFrame === false || !isTikTokLoginUrl(url)) return;
        resolved = true;
        clearTimeout(timer);
        if (this.win && !this.win.isDestroyed()) this.win.destroy();
        reject(new AuthRequiredError(this.username));
      };
      this.win.webContents.on('did-start-navigation', onNavigation);
      this.win.webContents.on('will-redirect', onNavigation);

      this.dbg.on('message', (_event, method, params) => {
        if (method === 'Network.responseReceived' && ROOM_ENTER_PATTERN.test(params.response.url || '')) {
          pendingRoomEnter.set(params.requestId, true);
          return;
        }
        if (method === 'Network.responseReceived' && CHECK_ALIVE_PATTERN.test(params.response.url || '')) {
          if (!roomGuard.acceptsCheckAlive(params.response.url)) return;
          pendingCheckAlive.set(params.requestId, true);
          return;
        }
        if (method === 'Network.loadingFinished' && pendingCheckAlive.has(params.requestId)) {
          pendingCheckAlive.delete(params.requestId);
          if (streamEnded) return;
          this.dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((res) => {
              if (streamEnded) return;
              const alive = classifyCheckAliveBody(res.body);
              // Senal positiva periodica (~6s): la pagina sigue viva y TikTok
              // confirma que el directo continua, haya chat o no.
              if (alive === true) this.emit('checkAlive');
              if (alive === false) {
                streamEnded = true;
                this.emit('streamEnd');
                this.disconnect();
              }
            })
            .catch(() => { /* best-effort */ });
          return;
        }
        if (method === 'Network.loadingFinished' && pendingRoomEnter.has(params.requestId)) {
          pendingRoomEnter.delete(params.requestId);
          this.dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((res) => {
              if (resolved) return;
              const result = classifyRoomEnterBody(res.body);

              if (result.kind === 'live') {
                resolved = true;
                clearTimeout(timer);
                resolve(result.data);
                return;
              }

              resolved = true;
              clearTimeout(timer);

              if (result.kind === 'not_live') {
                if (this.win && !this.win.isDestroyed()) this.win.destroy();
                reject(new NotLiveError(this.username, { confirmed: result.confirmed }));
                return;
              }

              // result.kind === 'unknown': no pudimos comprobar, no es un
              // offline confirmado (ver LiveStatusUnknownError arriba).
              const unknownErr = new LiveStatusUnknownError(this.username, result.reason, {
                tiktokStatusCode: result.tiktokStatusCode,
                causeMessage: result.causeMessage,
              });

              // Ver AMBIGUOUS_REVEAL_MS arriba — solo "sin info" real (cuerpo
              // vacio), coincide con el reintento interno ya existente
              // (EMPTY_BODY_MAX_ATTEMPTS). Otros "unknown" (JSON invalido,
              // status_code de TikTok, forma inesperada) cierran como antes,
              // sin reintento interno, asi que no aplica revelarlos aca.
              if (result.reason === 'empty_body' && this.win && !this.win.isDestroyed()) {
                this.win.showInactive();
                setTimeout(() => {
                  if (this.win && !this.win.isDestroyed()) this.win.destroy();
                  reject(unknownErr);
                }, AMBIGUOUS_REVEAL_MS);
                return;
              }

              if (this.win && !this.win.isDestroyed()) this.win.destroy();
              reject(unknownErr);
            })
            // Antes silenciado (`.catch(() => {})`): un fallo real de CDP al
            // pedir el body (ej. "No resource with given identifier found",
            // tipico cuando el body ya fue evictado del buffer) dejaba la
            // promesa colgada hasta el timeout de 30s sin decir por que.
            .catch((err) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              if (this.win && !this.win.isDestroyed()) this.win.destroy();
              reject(new LiveStatusUnknownError(this.username, 'body_fetch_failed', { causeMessage: err.message }));
            });
          return;
        }

        // A partir de aca, frames reales del WS de TikTok — la conexion, el
        // signing y todo el protocolo interno ya los resolvio la pagina.
        if (method === 'Network.webSocketCreated' && WS_URL_PATTERN.test(params.url)) {
          const newRoomId = roomGuard.onWebSocket(params.url);
          if (newRoomId) onRoomChanged(newRoomId);
          return;
        }
        if (method === 'Network.webSocketFrameReceived') {
          if (roomChanged) return;
          const { payloadData, opcode } = params.response;
          if (opcode !== 2) return; // solo frames binarios (protobuf)
          const buf = Buffer.from(payloadData, 'base64');
          let decoded;
          try {
            decoded = decodeWsFrame(buf);
          } catch (err) {
            this.emit('error', new Error(`Frame WS no decodificable: ${err.message}`));
            return;
          }
          // Un mensaje de otra sala nunca se reenvia (ni cuenta como salud:
          // si la pagina cambio de sala reusando el WS, el watchdog del
          // consumidor deja de recibir senales y reconecta).
          for (const msg of decoded) {
            if (roomGuard.acceptsMessage(msg)) this.emit('message', msg);
          }
        }
      });

      // Red de seguridad por si el reject de loadURL (ERR_ABORTED hacia
      // /login) llega antes que el evento de navegacion: se mira la URL del
      // error, nunca solo el codigo -3.
      this.win.loadURL(`https://www.tiktok.com/@${this.username}/live`).catch((err) => {
        if (!resolved && (isTikTokLoginUrl(err && err.url) || /https:\/\/www\.tiktok\.com\/login[?/]/.test((err && err.message) || ''))) {
          onNavigation({ url: 'https://www.tiktok.com/login', isMainFrame: true });
          return;
        }
        reject(err);
      });
    });

    this.win.webContents.on('destroyed', () => this.emit('close'));
    return { roomInfo };
  }

  disconnect() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { LiveWindow, SigningError, NotLiveError, LiveStatusUnknownError, AuthRequiredError };
