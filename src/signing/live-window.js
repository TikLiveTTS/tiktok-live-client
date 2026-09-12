'use strict';

const { EventEmitter } = require('events');
const { BrowserWindow, session } = require('electron');
const { decodeWsFrame } = require('../decode/decode-ws-frame');

const WS_URL_PATTERN = /webcast-ws\.tiktok\.com\/webcast\/im\/ws_proxy/;
const ROOM_ENTER_PATTERN = /webcast\/room\/enter\//;
const SESSION_PARTITION = 'persist:tiktok-live-client';

class SigningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SigningError';
    this.code = 'SIGNING_FAILED';
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
        if (method === 'Network.loadingFinished' && pendingRoomEnter.has(params.requestId)) {
          pendingRoomEnter.delete(params.requestId);
          this.dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((res) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              try {
                resolve(JSON.parse(res.body).data);
              } catch (_) {
                resolve(null);
              }
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

module.exports = { LiveWindow, SigningError };
