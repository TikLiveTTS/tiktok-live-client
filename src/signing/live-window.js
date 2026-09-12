'use strict';

const { EventEmitter } = require('events');
const { BrowserWindow, session } = require('electron');
const { decodeWsFrame } = require('../decode/decode-ws-frame');

const WS_URL_PATTERN = /webcast-ws\.tiktok\.com\/webcast\/im\/ws_proxy/;
const ROOM_ENTER_PATTERN = /webcast\/room\/enter\//;
const CHECK_ALIVE_PATTERN = /webcast\/room\/check_alive\//;
const SESSION_PARTITION = 'persist:tiktok-live-client';
const EMPTY_BODY_MAX_ATTEMPTS = 3;
const EMPTY_BODY_RETRY_DELAY_MS = 500;

class SigningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SigningError';
    this.code = 'SIGNING_FAILED';
  }
}

// roomInfo.status === 2 es "en vivo" (unico valor confirmado contra una
// captura real, ver spike/captures/). Cualquier otro valor con un body bien
// formado se trata como "no esta en vivo" de verdad — no se distingue "nunca
// empezo" de "ya termino" porque no hay una captura real del caso offline
// para separar los codigos con confianza; ambos casos son "expected" para el
// consumidor (mismo texto que ya reconoce ERRORES_CONEXION_ESPERADOS en
// TikLiveTTS).
//
// `emptyBody: true` marca el caso distinto: el body de room/enter vino VACIO
// (no un JSON de TikTok, nada) — visto en produccion (proceso Electron con
// Express/WS server corriendo al lado) contra canales confirmados en vivo en
// ese mismo instante, mientras un proceso Electron standalone con el mismo
// codigo conectaba bien. No es una respuesta real de "no en vivo" de TikTok,
// parece una falla transitoria de Network.getResponseBody bajo carga del
// proceso principal — `connect()` reintenta unicamente para este caso.
class NotLiveError extends Error {
  constructor(username, { emptyBody = false } = {}) {
    super(`The requested user isn't online :(`);
    this.name = 'NotLiveError';
    this.code = 'NOT_LIVE';
    this.username = username;
    this.emptyBody = emptyBody;
  }
}

// Camino probado (ver README#hallazgos-del-spike): una BrowserWindow
// invisible navega al live con una sesion anonima propia y se queda VIVA
// todo el tiempo de la conexion. TikTok mismo hace el signing, abre el WS y
// manda el protocolo interno completo (heartbeat, enter_room, acks) — este
// modulo solo escucha, via CDP, los frames que ya llegaron correctamente
// firmados y autenticados, y los decodifica. No arma ni firma nada propio.
class LiveWindow extends EventEmitter {
  constructor(username) {
    super();
    this.username = username;
    this.win = null;
    this.dbg = null;
  }

  // Reintenta SOLO el caso "body vacio" (ver NotLiveError#emptyBody) con una
  // ventana nueva — un `status !== 2` con datos reales de TikTok se respeta
  // a la primera, sin retraso, porque ahi confiamos en la respuesta.
  async connect(opts = {}) {
    for (let attempt = 1; attempt <= EMPTY_BODY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this._connectOnce(opts);
      } catch (err) {
        const lastAttempt = attempt === EMPTY_BODY_MAX_ATTEMPTS;
        if (!(err instanceof NotLiveError) || !err.emptyBody || lastAttempt) throw err;
        await new Promise((r) => setTimeout(r, EMPTY_BODY_RETRY_DELAY_MS));
      }
    }
    return undefined; // inalcanzable, el loop siempre retorna o lanza
  }

  async _connectOnce({ timeoutMs = 30000 } = {}) {
    const spikeSession = session.fromPartition(SESSION_PARTITION);
    this.win = new BrowserWindow({ show: false, webPreferences: { session: spikeSession, backgroundThrottling: false } });
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

    const roomInfo = await new Promise((resolve, reject) => {
      let resolved = false;
      const pendingRoomEnter = new Map();

      const timer = setTimeout(() => {
        if (!resolved) reject(new SigningError(`Timeout (${timeoutMs}ms) esperando la firma de ${this.username}`));
      }, timeoutMs);

      this.dbg.on('message', (_event, method, params) => {
        if (method === 'Network.responseReceived' && ROOM_ENTER_PATTERN.test(params.response.url || '')) {
          pendingRoomEnter.set(params.requestId, true);
          return;
        }
        if (method === 'Network.responseReceived' && CHECK_ALIVE_PATTERN.test(params.response.url || '')) {
          pendingCheckAlive.set(params.requestId, true);
          return;
        }
        if (method === 'Network.loadingFinished' && pendingCheckAlive.has(params.requestId)) {
          pendingCheckAlive.delete(params.requestId);
          if (streamEnded) return;
          this.dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((res) => {
              if (streamEnded) return;
              let alive = true;
              try {
                const body = JSON.parse(res.body);
                const entry = Array.isArray(body.data) ? body.data[0] : body.data;
                if (entry && entry.alive === false) alive = false;
              } catch (_) { /* shape inesperado: se ignora, no se asume fin de directo */ }
              if (!alive) {
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
              let data = null;
              try {
                data = JSON.parse(res.body).data;
              } catch (_) { /* data queda null, se trata como offline abajo */ }

              if (!data || data.status !== 2) {
                resolved = true;
                clearTimeout(timer);
                if (this.win && !this.win.isDestroyed()) this.win.destroy();
                reject(new NotLiveError(this.username, { emptyBody: !res.body }));
                return;
              }

              resolved = true;
              clearTimeout(timer);
              resolve(data);
            })
            .catch(() => { /* best-effort */ });
          return;
        }

        // A partir de aca, frames reales del WS de TikTok — la conexion, el
        // signing y todo el protocolo interno ya los resolvio la pagina.
        if (method === 'Network.webSocketCreated' && WS_URL_PATTERN.test(params.url)) {
          return;
        }
        if (method === 'Network.webSocketFrameReceived') {
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
          for (const msg of decoded) this.emit('message', msg);
        }
      });

      this.win.loadURL(`https://www.tiktok.com/@${this.username}/live`).catch(reject);
    });

    this.win.webContents.on('destroyed', () => this.emit('close'));
    return { roomInfo };
  }

  disconnect() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { LiveWindow, SigningError, NotLiveError };
