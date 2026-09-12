'use strict';

const path = require('path');
const zlib = require('zlib');
const protobuf = require('protobufjs');

const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'webcast.proto'));
const PushFrame = root.lookupType('tiktoklive.PushFrame');
const Response = root.lookupType('tiktoklive.Response');

const DECODERS = {
  WebcastChatMessage: root.lookupType('tiktoklive.WebcastChatMessage'),
  WebcastLikeMessage: root.lookupType('tiktoklive.WebcastLikeMessage'),
  WebcastMemberMessage: root.lookupType('tiktoklive.WebcastMemberMessage'),
  WebcastSocialMessage: root.lookupType('tiktoklive.WebcastSocialMessage'),
  WebcastGiftMessage: root.lookupType('tiktoklive.WebcastGiftMessage'),
  WebcastRoomUserSeqMessage: root.lookupType('tiktoklive.WebcastRoomUserSeqMessage'),
};

// WebcastSocialMessage cubre tanto follow como share — el unico
// discriminador real (validado contra capturas) es el key interno del
// toast, no un campo numerico separado.
function socialMessageKind(displayTextKey) {
  if (!displayTextKey) return null;
  if (displayTextKey.includes('follow')) return 'follow';
  if (displayTextKey.includes('share')) return 'share';
  return null;
}

function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function decodeMessage(method, payload) {
  const Type = DECODERS[method];
  if (!Type) return { method, data: null, raw: payload };
  const data = Type.toObject(Type.decode(payload), { longs: String });
  if (method === 'WebcastSocialMessage') {
    data.kind = socialMessageKind(data.common && data.common.displayText && data.common.displayText.key);
  }
  return { method, data };
}

// Decodifica un frame binario crudo tal cual llega del WS (WebSocket.Frame
// payloadData en Electron/CDP, o el mensaje 'message' de un ws.WebSocket en
// Node) — PushFrame -> (gunzip si aplica) -> Response -> lista de mensajes
// tipados (o {raw} si el tipo todavia no tiene decoder, ver webcast.proto).
function decodeWsFrame(buf) {
  const frame = PushFrame.decode(buf);
  const payload = isGzip(frame.payload) ? zlib.gunzipSync(frame.payload) : frame.payload;
  const response = Response.decode(payload);
  return response.messages.map((m) => decodeMessage(m.method, m.payload));
}

// Decodifica el body de GET webcast/im/fetch/ — mismo shape que Response,
// pero SIN el envoltorio PushFrame (no viaja por WS, es un fetch HTTP normal).
function decodeImFetchBody(buf) {
  const response = Response.decode(buf);
  return response.messages.map((m) => decodeMessage(m.method, m.payload));
}

module.exports = { decodeWsFrame, decodeImFetchBody, decodeMessage };
