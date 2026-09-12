'use strict';

// Spike descartable: NO es parte de la API publica del paquete.
// Uso: npm run spike:signing -- <username_tiktok_sin_arroba>
//
// Abre una BrowserWindow invisible sobre una sesion anonima dedicada, navega
// al live publico de <username> y loguea que requests salientes llevan
// parametros de firma anti-bot (X-Bogus, msToken, signature, etc). El
// objetivo es descubrir EN QUE request(s) reales viven esos parametros antes
// de escribir el extractor definitivo — no lo asumimos, lo observamos.

const { app, BrowserWindow, session } = require('electron');

const username = process.argv[2];
if (!username) {
  console.error('Uso: npm run spike:signing -- <username_tiktok>');
  process.exit(1);
}

// Nombres de query params / headers que pueden llevar la firma. Lista amplia
// a proposito (spike, no produccion): mejor loguear de mas y descartar a ojo
// que loguear de menos y perder el request que importaba.
const SIGNING_PATTERN = /bogus|mstoken|signature|gnarly|khronos|web_?id|odin_?id|device_?id|verify_fp|s_v_web_id|_signature/i;

function extractMatches(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (_) {
    return [];
  }
  const matches = [];
  for (const [key, value] of url.searchParams) {
    if (SIGNING_PATTERN.test(key)) matches.push({ where: 'query', key, value });
  }
  return matches;
}

function logIfInteresting(details) {
  const queryMatches = extractMatches(details.url);
  const headerMatches = [];
  const headers = details.requestHeaders || {};
  for (const key of Object.keys(headers)) {
    if (SIGNING_PATTERN.test(key)) headerMatches.push({ where: 'header', key, value: headers[key] });
  }
  const matches = [...queryMatches, ...headerMatches];
  if (matches.length === 0) return;

  console.log('\n=== Request con params de firma ===');
  console.log(details.method, details.url.split('?')[0]);
  for (const m of matches) {
    console.log(`  [${m.where}] ${m.key} = ${String(m.value).slice(0, 120)}`);
  }
}

async function main() {
  await app.whenReady();

  // Sesion anonima dedicada al spike, separada de cualquier otra sesion de
  // Electron en la maquina — nunca la cuenta real del streamer.
  const spikeSession = session.fromPartition('persist:tiktok-live-client-spike');

  spikeSession.webRequest.onBeforeSendHeaders({ urls: ['*://*.tiktok.com/*'] }, (details, callback) => {
    logIfInteresting(details);
    callback({ requestHeaders: details.requestHeaders });
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: spikeSession },
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`did-fail-load: ${code} ${desc} (${url})`);
  });
  win.webContents.on('did-navigate', (_e, url) => {
    console.log(`did-navigate: ${url}`);
  });

  const liveUrl = `https://www.tiktok.com/@${username}/live`;
  console.log(`Navegando a ${liveUrl} (sesion anonima persist:tiktok-live-client-spike)...`);
  await win.loadURL(liveUrl);

  // ponytail: timeout fijo de captura, no un mecanismo de "hasta que aparezca
  // la firma" — este script es para MIRAR trafico manualmente, no para que
  // el extractor definitivo dependa de este timing.
  const CAPTURE_MS = 45_000;
  console.log(`Capturando trafico durante ${CAPTURE_MS / 1000}s...`);
  setTimeout(() => {
    console.log('Fin de captura.');
    app.quit();
  }, CAPTURE_MS);
}

main().catch((err) => {
  console.error('Spike fallo:', err);
  process.exit(1);
});
