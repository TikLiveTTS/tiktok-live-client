'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');
const { decodeWsFrame } = require('../decode/decode-ws-frame');
const { urlRoomIds } = require('../signing/room-guard');

const root = protobuf.loadSync(path.join(__dirname, '..', 'proto', 'webcast.proto'));
const PushFrame = root.lookupType('tiktoklive.PushFrame');
const HeartbeatPayload = root.lookupType('tiktoklive.HeartbeatPayload');
const ClientInfoFrame = root.lookupType('tiktoklive.ClientInfoFrame');
const EnterRoomPayload = root.lookupType('tiktoklive.EnterRoomPayload');

const HEARTBEAT_MS = 10000;

function buildHeartbeatFrame() {
  const payload = HeartbeatPayload.encode({ timestamp: Date.now() }).finish();
  return PushFrame.encode({ payloadEncoding: 'pb', payloadType: 'hb', payload }).finish();
}

// Se manda UNA vez al conectar, antes del primer heartbeat — ver
// webcast.proto#ClientInfoFrame para el detalle de por que existe.
function buildClientInfoFrame(deviceId) {
  const payload = ClientInfoFrame.encode({
    info: { unknown1: 2, unknown2: '0', deviceId, timestamp: Date.now() },
    categories: [0, 1, 2].map((category) => ({ unknown1: 3, category })),
  }).finish();
  return PushFrame.encode({ seqId: 1, logId: Date.now(), service: 33554513, method: 2, payloadType: '2', payload }).finish();
}

function extractDeviceId(wsUrl) {
  const match = wsUrl.match(/[?&]device_id=(\d+)/);
  return match ? match[1] : null;
}

function extractRoomId(wsUrl) {
  const ids = urlRoomIds(wsUrl);
  return ids ? ids[0] : null;
}

// La declaracion real de "entrar a la sala" — ver webcast.proto#EnterRoomPayload.
// Sin esto el heartbeat mantiene la conexion viva pero el server nunca
// empieza a empujar mensajes (validado contra un live real con actividad).
function buildEnterRoomFrame(roomId) {
  const now = Date.now();
  const connId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const payload = EnterRoomPayload.encode({
    connId,
    unknown4: 12,
    role: 'audience',
    sessionKey: `${now}_${roomId}_1_1_${now}_0`,
    unknown7: 0,
    unknown9: '0',
    unknown10: 0,
  }).finish();
  return PushFrame.encode({ payloadEncoding: 'pb', payloadType: 'im_enter_room', payload }).finish();
}

// Conexion WS real al webcast de TikTok, ya con la URL firmada (ver
// src/signing/get-signed-ws-info.js). Maneja el heartbeat que exige el
// servidor (cada 10s, sin eso el server cierra la conexion) y emite un
// evento 'message' por cada mensaje ya decodificado (ver decode-ws-frame.js).
class WebcastSocket extends EventEmitter {
  constructor(wsUrl, cookieHeader) {
    super();
    this.wsUrl = wsUrl;
    this.cookieHeader = cookieHeader;
    this.ws = null;
    this.heartbeatTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Node/ws no manda estos headers solo — TikTok valida Origin (y
      // probablemente el User-Agent) en el handshake. Sin ellos el server
      // responde 200 normal en vez de aceptar el upgrade (confirmado).
      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          Cookie: this.cookieHeader,
          Origin: 'https://www.tiktok.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.216 Electron/41.10.7 Safari/537.36',
        },
      });
      this.ws.binaryType = 'nodebuffer';

      this.ws.once('open', () => {
        const deviceId = extractDeviceId(this.wsUrl);
        if (deviceId) this.ws.send(buildClientInfoFrame(deviceId));
        const roomId = extractRoomId(this.wsUrl);
        if (roomId) this.ws.send(buildEnterRoomFrame(roomId));
        this.heartbeatTimer = setInterval(() => {
          if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buildHeartbeatFrame());
        }, HEARTBEAT_MS);
        resolve();
      });

      this.ws.once('error', (err) => {
        if (this.ws.readyState !== WebSocket.OPEN) reject(err);
        else this.emit('error', err);
      });

      this.ws.on('message', (data) => {
        let decoded;
        try {
          decoded = decodeWsFrame(data);
        } catch (err) {
          this.emit('error', new Error(`Frame WS no decodificable: ${err.message}`));
          return;
        }
        for (const msg of decoded) this.emit('message', msg);
      });

      this.ws.on('close', (code, reason) => {
        clearInterval(this.heartbeatTimer);
        this.emit('close', { code, reason: reason ? reason.toString() : '' });
      });
    });
  }

  disconnect() {
    clearInterval(this.heartbeatTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    }
  }
}

module.exports = { WebcastSocket };
