'use strict';

const { EventEmitter } = require('events');
const { LiveWindow, SigningError } = require('./signing/live-window');
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

    const { roomInfo } = await this.liveWindow.connect();
    return { roomInfo };
  }

  disconnect() {
    if (this.liveWindow) this.liveWindow.disconnect();
  }
}

module.exports = { TikTokLiveClient, SigningError };
