'use strict';

const { BrowserWindow, session } = require('electron');

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

// Navega al live con una BrowserWindow invisible (sesion anonima, propia,
// separada de cualquier otra sesion de Electron) y captura, via CDP, la URL
// firmada del WebSocket real de TikTok + el JSON de roomInfo + las cookies
// de la sesion. La ventana se cierra apenas se tiene todo — no queda viva.
async function getSignedWsInfo(username, { timeoutMs = 30000 } = {}) {
  const spikeSession = session.fromPartition(SESSION_PARTITION);
  const win = new BrowserWindow({ show: false, webPreferences: { session: spikeSession } });

  try {
    // Bug conocido de Electron (electron/electron#14810): sendCommand no
    // resuelve hasta que la ventana tiene algo cargado.
    await win.loadURL('about:blank');
    const dbg = win.webContents.debugger;
    dbg.attach();
    await dbg.sendCommand('Network.enable');

    const result = await new Promise((resolve, reject) => {
      let wsUrl = null;
      let roomInfo = null;
      const pendingRoomEnter = new Map();

      const timer = setTimeout(() => {
        reject(new SigningError(`Timeout (${timeoutMs}ms) esperando la firma de ${username}`));
      }, timeoutMs);

      const finishIfReady = () => {
        if (wsUrl && roomInfo) {
          clearTimeout(timer);
          resolve({ wsUrl, roomInfo });
        }
      };

      dbg.on('message', (_event, method, params) => {
        if (method === 'Network.webSocketCreated' && WS_URL_PATTERN.test(params.url)) {
          wsUrl = params.url;
          finishIfReady();
          return;
        }
        if (method === 'Network.responseReceived' && ROOM_ENTER_PATTERN.test(params.response.url || '')) {
          pendingRoomEnter.set(params.requestId, true);
          return;
        }
        if (method === 'Network.loadingFinished' && pendingRoomEnter.has(params.requestId)) {
          pendingRoomEnter.delete(params.requestId);
          dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((res) => {
              try {
                roomInfo = JSON.parse(res.body).data;
              } catch (_) { /* si no parsea, seguimos sin roomInfo */ }
              finishIfReady();
            })
            .catch(() => { /* best-effort */ });
        }
      });

      win.loadURL(`https://www.tiktok.com/@${username}/live`).catch(reject);
    });

    const cookies = await spikeSession.cookies.get({ domain: 'tiktok.com' });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return { wsUrl: result.wsUrl, roomInfo: result.roomInfo, cookieHeader };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { getSignedWsInfo, SigningError };
