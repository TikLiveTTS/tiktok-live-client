'use strict';

// Spike descartable: NO es parte de la API publica del paquete.
// Uso: npm run spike:body -- <username_tiktok_sin_arroba>
//
// A diferencia de inspect-signing.js (que solo ve URLs/headers via
// webRequest), este spike usa el protocolo CDP de Electron
// (webContents.debugger) para leer el BODY real de las respuestas de
// im/fetch / room/enter / check_alive — necesario para poder inspeccionar
// el protobuf antes de escribir el decoder definitivo.

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const username = process.argv[2];
if (!username) {
  console.error('Uso: npm run spike:body -- <username_tiktok>');
  process.exit(1);
}

const INTERESTING = /webcast\/(room\/enter|im\/fetch|room\/check_alive)\//;
const OUT_DIR = path.join(__dirname, 'captures');

function saveBody(label, requestId, body, base64Encoded) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const buf = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
  const file = path.join(OUT_DIR, `${Date.now()}-${label}-${requestId}.bin`);
  fs.writeFileSync(file, buf);
  console.log(`  -> guardado ${file} (${buf.length} bytes, primeros 32 en hex: ${buf.slice(0, 32).toString('hex')})`);
}

async function main() {
  console.log('esperando app.whenReady()...');
  await app.whenReady();
  console.log('app lista.');

  const spikeSession = session.fromPartition('persist:tiktok-live-client-spike-body');
  const win = new BrowserWindow({ show: false, webPreferences: { session: spikeSession } });

  // Bug conocido de Electron (electron/electron#14810): sendCommand no
  // resuelve hasta que la ventana tiene ALGO cargado. Cargar about:blank
  // primero antes de attach/enable evita el cuelgue.
  await win.loadURL('about:blank');

  const dbg = win.webContents.debugger;
  console.log('attach debugger...');
  dbg.attach();
  console.log('debugger atachado.');

  const pending = new Map(); // requestId -> label

  dbg.on('message', (_event, method, params) => {
    if (method === 'Network.webSocketCreated') {
      console.log(`\n<< WebSocket creado: ${params.url}`);
      return;
    }
    if (method === 'Network.webSocketFrameReceived') {
      const data = params.response && params.response.payloadData;
      console.log(`\n<< WS frame recibido (${data ? data.length : 0} bytes)`);
      return;
    }
    if (method === 'Network.responseReceived') {
      const url = params.response && params.response.url;
      if (url && INTERESTING.test(url)) {
        const label = url.match(INTERESTING)[1].replace(/\//g, '-');
        pending.set(params.requestId, label);
        if (label !== 'room-check_alive') {
          console.log(`\n<- response ${label}: status=${params.response.status} mimeType=${params.response.mimeType}`);
        }
      }
      return;
    }
    if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
      const label = pending.get(params.requestId);
      pending.delete(params.requestId);
      if (label === 'room-check_alive') return; // ruido: ya validado, no aporta mas
      dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
        .then((result) => {
          console.log(`\n=== body de ${label} (requestId ${params.requestId}) ===`);
          saveBody(label, params.requestId, result.body, result.base64Encoded);
        })
        .catch((err) => {
          console.error(`No se pudo leer el body de ${label} (${params.requestId}):`, err.message);
        });
    }
  });

  console.log('sendCommand Network.enable...');
  await dbg.sendCommand('Network.enable');
  console.log('Network.enable OK.');

  const liveUrl = `https://www.tiktok.com/@${username}/live`;
  console.log(`Navegando a ${liveUrl}...`);
  console.log(`Bodies capturados se guardan en ${OUT_DIR}`);
  await win.loadURL(liveUrl);

  const CAPTURE_MS = 60_000;
  console.log(`Capturando durante ${CAPTURE_MS / 1000}s...`);
  setTimeout(() => {
    console.log('Fin de captura.');
    app.quit();
  }, CAPTURE_MS);
}

main().catch((err) => {
  console.error('Spike fallo:', err);
  process.exit(1);
});
