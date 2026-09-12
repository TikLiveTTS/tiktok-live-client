'use strict';

// Spike descartable: NO es parte de la API publica del paquete.
// Uso: npm run spike:ws -- <username_tiktok_sin_arroba>
//
// Captura la URL COMPLETA (a archivo, para no truncar en consola) del
// WebSocket real que usa TikTok para push de chat/gifts/likes, sus headers
// de handshake (incluye cookies), y guarda los primeros N frames crudos a
// disco para inspeccionar el protobuf de mensaje individual (a diferencia
// del batch de im/fetch).

// Red de seguridad: es un spike exploratorio, un error inesperado no debe
// colgar la ventana esperando que alguien cierre el dialogo de Electron.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (no fatal, spike sigue):', err.message);
});

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { decodeWsFrame } = require('../src/decode/decode-ws-frame');

const username = process.argv[2];
if (!username) {
  console.error('Uso: npm run spike:ws -- <username_tiktok>');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'captures');
fs.mkdirSync(OUT_DIR, { recursive: true });

let frameCount = 0;
const MAX_FRAMES_TO_SAVE = 60;

async function main() {
  await app.whenReady();
  const spikeSession = session.fromPartition('persist:tiktok-live-client-spike-body');
  const win = new BrowserWindow({ show: false, webPreferences: { session: spikeSession } });
  await win.loadURL('about:blank');

  const dbg = win.webContents.debugger;
  dbg.attach();

  dbg.on('message', (_event, method, params) => {
    if (method === 'Network.webSocketCreated') {
      const file = path.join(OUT_DIR, `ws-created-${Date.now()}.txt`);
      fs.writeFileSync(file, params.url);
      console.log(`WS creado, URL completa guardada en: ${file}`);
      return;
    }
    if (method === 'Network.webSocketWillSendHandshakeRequest') {
      const file = path.join(OUT_DIR, `ws-handshake-request-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(params, null, 2));
      console.log(`Handshake request guardado: ${file}`);
      return;
    }
    if (method === 'Network.webSocketHandshakeResponseReceived') {
      const file = path.join(OUT_DIR, `ws-handshake-response-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(params, null, 2));
      console.log(`Handshake response guardado: ${file} (status ${params.response.status})`);
      return;
    }
    if (method === 'Network.webSocketFrameSent') {
      const { payloadData, opcode } = params.response;
      const buf = opcode === 2 ? Buffer.from(payloadData, 'base64') : Buffer.from(payloadData, 'utf8');
      const file = path.join(OUT_DIR, `ws-frame-SENT-${Date.now()}.bin`);
      fs.writeFileSync(file, buf);
      console.log(`\n>> ENVIADO por el navegador: ${file} (${buf.length} bytes, opcode ${opcode}, hex: ${buf.toString('hex')})`);
      return;
    }
    if (method === 'Network.webSocketFrameReceived') {
      if (frameCount >= MAX_FRAMES_TO_SAVE) return;
      frameCount++;
      const { payloadData, opcode } = params.response;
      // CDP: payloadData viene base64 para frames binarios (opcode 2).
      const buf = opcode === 2 ? Buffer.from(payloadData, 'base64') : Buffer.from(payloadData, 'utf8');
      const file = path.join(OUT_DIR, `ws-frame-${frameCount}-${Date.now()}.bin`);
      fs.writeFileSync(file, buf);
      try {
        const decoded = decodeWsFrame(buf);
        for (const m of decoded) {
          if (m.method === 'WebcastChatMessage' && m.data) {
            console.log(`\n>>> CHAT: [${m.data.user.uniqueId}] "${m.data.comment}"`);
          } else if (m.method && m.method !== 'WebcastLikeMessage' && m.method !== 'WebcastMemberMessage' && m.method !== 'WebcastRoomUserSeqMessage') {
            console.log(`\n>>> TIPO NUEVO VISTO: ${m.method} (frame ${frameCount}) — investigar`);
          }
        }
      } catch (err) {
        console.log(`  (no se pudo decodificar frame ${frameCount}: ${err.message})`);
      }
      console.log(`Frame ${frameCount} guardado: ${file} (${buf.length} bytes, opcode ${opcode})`);
      return;
    }
  });

  await dbg.sendCommand('Network.enable');

  const liveUrl = `https://www.tiktok.com/@${username}/live`;
  console.log(`Navegando a ${liveUrl}...`);
  await win.loadURL(liveUrl);

  const CAPTURE_MS = 40_000;
  console.log(`Capturando durante ${CAPTURE_MS / 1000}s (hasta ${MAX_FRAMES_TO_SAVE} frames)...`);
  setTimeout(async () => {
    const cookies = await spikeSession.cookies.get({ domain: 'tiktok.com' });
    fs.writeFileSync(path.join(OUT_DIR, 'cookies.json'), JSON.stringify(cookies, null, 2));
    console.log(`Cookies guardadas (${cookies.length}).`);
    console.log('Fin de captura.');
    app.quit();
  }, CAPTURE_MS);
}

main().catch((err) => {
  console.error('Spike fallo:', err);
  process.exit(1);
});
