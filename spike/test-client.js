'use strict';

// Prueba end-to-end del cliente publico: firma -> WS en Node -> eventos.
// Uso: npm run spike:client -- <username_tiktok>

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

const { app } = require('electron');
const { TikTokLiveClient } = require('../src/client');

// La ventana de firma (BrowserWindow invisible) se crea y destruye durante
// connect(). Sin esto, Electron cierra TODA la app apenas se queda sin
// ventanas (comportamiento default de window-all-closed) — matando el
// proceso antes de que el WS llegue a conectar. En la app real esto no pasa
// porque la ventana principal de TikLiveTTS sigue abierta.
app.on('window-all-closed', () => {});

const username = process.argv[2];
if (!username) {
  console.error('Uso: npm run spike:client -- <username_tiktok>');
  process.exit(1);
}

async function main() {
  const hardTimeout = setTimeout(() => {
    console.error('SAFETY TIMEOUT: nada resolvio en 60s, forzando salida.');
    process.exit(2);
  }, 60_000);
  hardTimeout.unref?.();

  await app.whenReady();
  console.log('app.whenReady() OK.');
  console.log(`Conectando a ${username}...`);
  const client = new TikTokLiveClient(username);

  client.on('chat', (d) => console.log('CHAT', d));
  client.on('gift', (d) => console.log('GIFT', d));
  client.on('like', (d) => console.log('LIKE', d));
  client.on('member', (d) => console.log('MEMBER', d));
  client.on('follow', (d) => console.log('FOLLOW', d));
  client.on('share', (d) => console.log('SHARE', d));
  client.on('roomUserSeq', (d) => console.log('ROOM_USER_SEQ', d));
  client.on('disconnected', () => console.log('DISCONNECTED'));
  client.on('error', (err) => console.error('ERROR', err.message));

  console.log('llamando a client.connect()...');
  const { roomInfo } = await client.connect();
  clearTimeout(hardTimeout);
  console.log('client.connect() resolvio.');
  console.log('Conectado. followerCount:', roomInfo && roomInfo.owner && roomInfo.owner.follow_info && roomInfo.owner.follow_info.follower_count);

  setTimeout(() => {
    console.log('Fin de la prueba, desconectando.');
    client.disconnect();
    app.quit();
  }, 90_000);
}

main().catch((err) => {
  console.error('Fallo la prueba:', err);
  process.exit(1);
});
