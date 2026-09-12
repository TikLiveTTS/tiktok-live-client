'use strict';

// Entry point de un proceso Electron DEDICADO a una sola conexion de
// LiveWindow — ver README#aislamiento-de-proceso para el porque. Se lanza
// via `spawn(process.execPath, [__filename, username], {stdio:[...,'ipc']})`
// desde client.js. Reenvia cada evento de LiveWindow al proceso padre por
// IPC ya traducido al contrato publico (chat/gift/like/...), asi el padre
// no necesita duplicar el mapeo de decode/.

const { app } = require('electron');
const { LiveWindow } = require('./live-window');
const { isFanClubMember } = require('../decode/is-fan-club-member');

const username = process.argv[2];

function send(type, payload) {
  if (process.connected) process.send({ type, payload });
}

function serializeError(err) {
  return { name: err.name, message: err.message, stack: err.stack, code: err.code, emptyBody: err.emptyBody };
}

// Mismo mapeo que antes vivia en client.js#toPublicPayload — se mueve aca
// porque el padre ya no ve los frames crudos, solo el evento publico final.
function toPublicPayload(method, data) {
  const user = data.user || {};
  const base = { uniqueId: user.uniqueId || null, nickname: user.nickname || null };

  switch (method) {
    case 'WebcastChatMessage':
      return ['chat', { ...base, comment: data.comment, msgId: data.common && data.common.msgId, createTime: data.common && data.common.createTime, isFanClubMember: isFanClubMember(user) }];
    case 'WebcastGiftMessage':
      return ['gift', { ...base, giftId: data.giftId, giftName: data.gift && data.gift.name, diamondCount: data.gift && data.gift.diamondCount, groupCount: data.groupCount, isFanClubMember: isFanClubMember(user) }];
    case 'WebcastLikeMessage':
      return ['like', { ...base, likeCount: data.count, isFanClubMember: isFanClubMember(user) }];
    case 'WebcastMemberMessage':
      return ['member', { ...base, isFanClubMember: isFanClubMember(user) }];
    case 'WebcastSocialMessage':
      return data.kind ? [data.kind, base] : null;
    case 'WebcastRoomUserSeqMessage':
      return ['roomUserSeq', { viewerCount: data.viewerCount }];
    default:
      return null;
  }
}

async function main() {
  if (!username) {
    send('connect-error', { message: 'Falta el username como argv[2]' });
    app.exit(1);
    return;
  }

  await app.whenReady();
  const win = new LiveWindow(username);

  win.on('message', ({ method, data }) => {
    if (!data) return;
    const mapped = toPublicPayload(method, data);
    if (mapped) send(mapped[0], mapped[1]);
  });
  win.on('error', (err) => send('error', serializeError(err)));
  win.on('close', () => { send('close'); app.quit(); });
  win.on('streamEnd', () => send('streamEnd'));

  process.on('message', (msg) => {
    if (msg === 'disconnect') win.disconnect();
  });
  // Si el padre muere/mata el pipe sin mandar 'disconnect' explicito
  // (crash, kill -9), no dejar la BrowserWindow/proceso huerfano.
  process.on('disconnect', () => { win.disconnect(); app.quit(); });

  try {
    const { roomInfo } = await win.connect();
    send('connected', { roomInfo });
  } catch (err) {
    send('connect-error', serializeError(err));
    app.quit();
  }
}

main().catch((err) => {
  send('connect-error', serializeError(err));
  app.exit(1);
});
