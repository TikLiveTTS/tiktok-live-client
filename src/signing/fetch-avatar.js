'use strict';

const { BrowserWindow, session } = require('electron');
const { DEFAULT_SESSION_PARTITION } = require('../session/tiktok-session');

// TikTok no manda la foto de perfil en los frames WS de like/follow/share/
// gift (confirmado contra los fixtures de test/fixtures/, ninguno trae una
// URL) ni en un fetch HTTP plano a /@usuario (anti-bot devuelve "Please
// wait..." sin JS real, igual que /live). Unica via confirmada: una
// BrowserWindow invisible que cargue la pagina real del perfil (mismo patron
// que LiveWindow) y lea el avatar ya resuelto por el JS de TikTok, desde el
// DOM (og:image) o window.SIGI_STATE.
const CACHE_TTL_MS = 60 * 60 * 1000; // el avatar no cambia tan seguido, y da tiempo de sobra para una sesion de stream
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_WINDOWS = 2; // nada de abrir decenas de ventanas si entra una rafaga de follows/gifts juntos

const cache = new Map(); // uniqueId -> { url, expiresAt }
const pending = new Map(); // uniqueId -> Promise<string|null>
let activeWindows = 0;
const queue = [];

function getCached(uniqueId) {
  const hit = cache.get(uniqueId);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(uniqueId);
    return undefined;
  }
  return hit.url;
}

function runNextQueued() {
  if (activeWindows >= MAX_CONCURRENT_WINDOWS) return;
  const next = queue.shift();
  if (!next) return;
  activeWindows += 1;
  next().finally(() => {
    activeWindows -= 1;
    runNextQueued();
  });
}

function enqueue(task) {
  return new Promise((resolve) => {
    queue.push(() => task().then(resolve, () => resolve(null)));
    runNextQueued();
  });
}

const EXTRACT_AVATAR_SCRIPT = `
(function () {
  try {
    var meta = document.querySelector('meta[property="og:image"]');
    if (meta && meta.content) return meta.content;
  } catch (e) {}
  try {
    var state = window.SIGI_STATE;
    var users = state && state.UserModule && state.UserModule.users;
    if (users) {
      var user = Object.values(users)[0];
      if (user) return user.avatarLarger || user.avatarMedium || user.avatarThumb || null;
    }
  } catch (e) {}
  return null;
})();
`;

async function openProfileAndExtract(uniqueId, partition) {
  const win = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    width: 60,
    height: 60,
    webPreferences: { session: session.fromPartition(partition), backgroundThrottling: false },
  });
  try {
    await Promise.race([
      win.loadURL(`https://www.tiktok.com/@${uniqueId}`),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    const url = await win.webContents.executeJavaScript(EXTRACT_AVATAR_SCRIPT);
    return typeof url === 'string' && url ? url : null;
  } catch {
    return null;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Resuelve la foto de perfil de un usuario de TikTok por uniqueId.
 * Nunca rechaza: ante timeout, error de red o anti-bot, resuelve null.
 */
function fetchAvatarUrl(uniqueId, { partition = DEFAULT_SESSION_PARTITION } = {}) {
  if (!uniqueId) return Promise.resolve(null);

  const cached = getCached(uniqueId);
  if (cached !== undefined) return Promise.resolve(cached);

  const inFlight = pending.get(uniqueId);
  if (inFlight) return inFlight;

  const promise = enqueue(() => openProfileAndExtract(uniqueId, partition))
    .then((url) => {
      cache.set(uniqueId, { url, expiresAt: Date.now() + CACHE_TTL_MS });
      return url;
    })
    .finally(() => pending.delete(uniqueId));

  pending.set(uniqueId, promise);
  return promise;
}

module.exports = { fetchAvatarUrl };
