'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { spawn } = require('child_process');
const { SigningError, NotLiveError } = require('./signing/live-window');

const WORKER_SCRIPT = path.join(__dirname, 'signing', 'worker-entry.js');
const CONTROL_TYPES = new Set(['connected', 'connect-error', 'error', 'close', 'streamEnd']);

function reviveError(payload) {
  const Ctor = payload.code === 'NOT_LIVE' ? NotLiveError : payload.code === 'SIGNING_FAILED' ? SigningError : Error;
  const err = Ctor === NotLiveError
    ? new NotLiveError(payload.username, { emptyBody: payload.emptyBody })
    : new Ctor(payload.message);
  err.message = payload.message;
  if (payload.stack) err.stack = payload.stack;
  return err;
}

// Ver README#aislamiento-de-proceso: la firma anti-bot de TikTok corre en un
// proceso Electron DEDICADO (worker-entry.js), lanzado con el mismo binario
// que ya esta corriendo (process.execPath) — nunca en el proceso principal
// de la app consumidora. Se detecto en produccion que compartir proceso con
// un servidor Express/WS y otros hooks globales hace que TikTok rechace la
// firma (403, X-Bogus placeholder) de forma consistente, mientras que un
// proceso Electron dedicado sin otra carga alrededor firma bien siempre.
//
// Apps empaquetadas: process.execPath es el propio exe de la app, que carga
// su entrypoint normal sin importar el argv. Por eso ademas del argv se pasa
// TIKLIVETTS_WORKER_SCRIPT por env — el entrypoint de la app consumidora
// tiene que chequearlo ANTES de su bootstrap normal y hacer
// `require(process.env.TIKLIVETTS_WORKER_SCRIPT)` si esta presente (ver
// ejemplo en el README). En dev, `electron <script>` ya arranca el script
// directo por argv y el env var no hace falta, pero se manda igual por si
// el empaquetado friend usa otro mecanismo de arranque.
class TikTokLiveClient extends EventEmitter {
  constructor(username) {
    super();
    this.username = username;
    this.child = null;
  }

  async connect() {
    this.child = spawn(process.execPath, [WORKER_SCRIPT, this.username], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, TIKLIVETTS_WORKER_SCRIPT: WORKER_SCRIPT },
    });

    return new Promise((resolve, reject) => {
      let settled = false;

      this.child.on('message', (msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'connected') {
          settled = true;
          resolve({ roomInfo: msg.payload.roomInfo });
          return;
        }
        if (msg.type === 'connect-error') {
          settled = true;
          reject(reviveError(msg.payload));
          return;
        }
        if (msg.type === 'error') {
          this.emit('error', reviveError(msg.payload));
          return;
        }
        if (msg.type === 'close') {
          this.emit('disconnected');
          return;
        }
        if (msg.type === 'streamEnd') {
          this.emit('streamEnd');
          return;
        }
        if (!CONTROL_TYPES.has(msg.type)) this.emit(msg.type, msg.payload);
      });

      this.child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        reject(new Error(`El proceso de firma de TikTok termino inesperadamente (code ${code})`));
      });

      this.child.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  disconnect() {
    if (!this.child || this.child.killed) return;
    try {
      this.child.send('disconnect');
    } catch (_) { /* el pipe ya pudo haberse cerrado */ }
    // best-effort: si el hijo no cierra solo (ver worker-entry.js#disconnect),
    // no dejarlo huerfano.
    setTimeout(() => {
      if (this.child && !this.child.killed) this.child.kill();
    }, 2000).unref();
  }
}

module.exports = { TikTokLiveClient, SigningError, NotLiveError };
