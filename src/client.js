'use strict';

const { EventEmitter } = require('events');
const { LiveWindow, SigningError, NotLiveError, LiveStatusUnknownError } = require('./signing/live-window');
const { isFanClubMember } = require('./decode/is-fan-club-member');

// Mapea cada tipo de mensaje decodificado (ver src/decode/decode-ws-frame.js)
// al shape publico documentado en el README — nunca se emite el objeto
// protobuf crudo, solo los campos que TikLiveTTS necesita.
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

// Ver README#arquitectura: la ventana invisible (LiveWindow) hace todo el
// trabajo pesado (signing, WS, protocolo interno de TikTok) — este cliente
// solo traduce los mensajes ya decodificados al contrato publico.
//
// ponytail: se probo aislar esto en un proceso Electron dedicado
// (spawn(process.execPath, ...) + IPC) para separar la firma del proceso
// principal de la app consumidora. Funcionaba siempre en dev, pero en un
// build empaquetado real el proceso hijo (segunda instancia del mismo exe)
// moria consistentemente ~2-3s despues de navegar a la URL real de TikTok,
// sin crashear (sin render-process-gone, sin excepcion, exit code 0) y sin
// rastro en los logs de Windows — no se identifico la causa exacta pese a
// varias rondas de diagnostico (CDP, IPC, backgroundThrottling, etc.). Se
// revirtio a correr LiveWindow directo en el proceso del caller: es el
// camino ya validado en produccion real (ver historial de commits). Si en
// el futuro se reintenta el aislamiento de proceso, arrancar confirmando
// primero que un build empaquetado real (no `npm run electron` en dev)
// sobrevive una conexion contra un live real.
class TikTokLiveClient extends EventEmitter {
  constructor(username) {
    super();
    this.username = username;
    this.liveWindow = null;
  }

  async connect() {
    this.liveWindow = new LiveWindow(this.username);

    this.liveWindow.on('message', ({ method, data }) => {
      if (!data) return;
      const mapped = toPublicPayload(method, data);
      if (mapped) this.emit(mapped[0], mapped[1]);
    });
    this.liveWindow.on('error', (err) => this.emit('error', err));
    this.liveWindow.on('close', () => this.emit('disconnected'));
    // El streamer corto el directo (check_alive dejo de reportar alive=true).
    // LiveWindow ya llama a su propio disconnect() despues de emitir esto —
    // el 'close'/'disconnected' que sigue es un no-op para quien ya limpio
    // su estado en 'streamEnd' (mismo contrato que tiktok-live-connector).
    this.liveWindow.on('streamEnd', () => this.emit('streamEnd'));

    const { roomInfo } = await this.liveWindow.connect();
    return { roomInfo };
  }

  disconnect() {
    if (this.liveWindow) this.liveWindow.disconnect();
  }
}

module.exports = { TikTokLiveClient, SigningError, NotLiveError, LiveStatusUnknownError };
