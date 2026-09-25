'use strict';

const { BrowserWindow, session } = require('electron');

// Misma particion que usa la ventana invisible de LiveWindow por defecto —
// la ventana VISIBLE de login la comparte a proposito: lo que el usuario
// autentique aca (cookies de TikTok) es exactamente lo que la ventana
// invisible reusa en el proximo connect(). Un consumidor que quiera aislar
// sesiones (ej. una por cuenta de la app) pasa su propio `partition` a los
// tres helpers de abajo Y a `new TikTokLiveClient(username, { partition })`.
const DEFAULT_SESSION_PARTITION = 'persist:tiktok-live-client';
const SESSION_COOKIE = 'sessionid';
const LOGIN_URL = 'https://www.tiktok.com/login';
// Tras ver el `sessionid` se espera un poco antes de cerrar: TikTok setea
// varias cookies en la misma respuesta de login (sid_tt, sid_guard, ...) y
// cerrar en el primer evento podria cortar las que llegan justo despues.
const CLOSE_AFTER_LOGIN_MS = 1500;

function isTikTokDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'tiktok.com' || d.endsWith('.tiktok.com');
}

/** true si la particion tiene una cookie de sesion de TikTok vigente (Chromium ya descarta las vencidas). */
async function hasTikTokSession(partition = DEFAULT_SESSION_PARTITION) {
  const cookies = await session.fromPartition(partition).cookies.get({ name: SESSION_COOKIE });
  return cookies.some((c) => c.value && isTikTokDomain(c.domain));
}

// Una sola ventana de login por particion: un segundo pedido mientras sigue
// abierta la trae al frente y devuelve la misma promesa.
const openLogins = new Map(); // partition -> { win, promise }

/**
 * Abre una ventana VISIBLE con el login normal de TikTok. El paquete nunca ve
 * ni guarda la contrasena: TikTok autentica dentro de Chromium como en
 * cualquier navegador, y lo unico que queda son sus propias cookies en la
 * particion persistente. Resuelve `{ loggedIn: true }` en cuanto aparece la
 * cookie `sessionid` (y cierra la ventana), o `{ loggedIn }` segun el estado
 * real de la particion si el usuario la cierra a mano. Nunca rechaza.
 */
function openTikTokLoginWindow({ partition = DEFAULT_SESSION_PARTITION } = {}) {
  const existing = openLogins.get(partition);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return existing.promise;
  }

  const ses = session.fromPartition(partition);
  const win = new BrowserWindow({
    width: 480, height: 760, title: 'TikTok', autoHideMenuBar: true,
    webPreferences: { session: ses },
  });

  const promise = new Promise((resolve) => {
    let done = false;
    let closeTimer = null;
    const finish = (loggedIn) => {
      if (done) return;
      done = true;
      clearTimeout(closeTimer);
      ses.cookies.removeListener('changed', onCookie);
      openLogins.delete(partition);
      if (!win.isDestroyed()) win.destroy();
      resolve({ loggedIn });
    };
    const onCookie = (_event, cookie, _cause, removed) => {
      if (removed || closeTimer || cookie.name !== SESSION_COOKIE || !cookie.value || !isTikTokDomain(cookie.domain)) return;
      closeTimer = setTimeout(() => finish(true), CLOSE_AFTER_LOGIN_MS);
    };
    ses.cookies.on('changed', onCookie);
    win.on('closed', () => {
      if (done) return;
      hasTikTokSession(partition).then(finish, () => finish(false));
    });
    win.loadURL(LOGIN_URL).catch(() => { /* la ventana queda abierta; el usuario puede reintentar o cerrarla */ });
  });

  openLogins.set(partition, { win, promise });
  return promise;
}

/**
 * Logout: borra SOLO el almacenamiento de esa particion (cookies, localStorage,
 * IndexedDB, cache) — nunca la sesion por defecto de Electron ni otras
 * particiones de la app consumidora.
 */
async function clearTikTokSession(partition = DEFAULT_SESSION_PARTITION) {
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
}

module.exports = { DEFAULT_SESSION_PARTITION, hasTikTokSession, openTikTokLoginWindow, clearTikTokSession };
