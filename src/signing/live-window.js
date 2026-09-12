'use strict';

const { EventEmitter } = require('events');
const { BrowserWindow, session } = require('electron');
const { decodeWsFrame } = require('../decode/decode-ws-frame');

const WS_URL_PATTERN = /webcast-ws\.tiktok\.com\/webcast\/im\/ws_proxy/;
const ROOM_ENTER_PATTERN = /webcast\/room\/enter\//;
const CHECK_ALIVE_PATTERN = /webcast\/room\/check_alive\//;
const SESSION_PARTITION = 'persist:tiktok-live-client';

class SigningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SigningError';
    this.code = 'SIGNING_FAILED';
  }
}

// roomInfo.status === 2 es "en vivo" (unico valor confirmado contra una
// captura real, ver spike/captures/). Cualquier otro valor (o un body que no
// parsea) se trata como "no esta en vivo" — no se distingue "nunca empezo" de
// "ya termino" porque no hay una captura real del caso offline para separar
// los codigos con confianza; ambos casos son "expected" para el consumidor
// (mismo texto que ya reconoce ERRORES_CONEXION_ESPERADOS en TikLiveTTS).
class NotLiveError extends Error {
  constructor(username) {
    super(`The requested user isn't online :(`);
    this.name = 'NotLiveError';
    this.code = 'NOT_LIVE';
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
  constructor(username) {
    super();
    this.username = username;
    this.win = null;
    this.dbg = null;
  }

  async connect({ timeoutMs = 30000 } = {}) {
    const spikeSession = session.fromPartition(SESSION_PARTITION);
    this.win = new BrowserWindow({ show: false, webPreferences: { session: spikeSession } });
    // La pagina real de TikTok reproduce el video/audio del live — invisible
    // no significa muda. Sin esto el usuario escucharia el live de fondo.
    this.win.webContents.setAudioMuted(true);

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
                reject(new NotLiveError(this.username));
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
