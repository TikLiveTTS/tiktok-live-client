'use strict';

// Identidad de la sala escuchada, separado de Electron/CDP para testearlo con
// Node puro (ver test/room-guard.test.js).
//
// Por que existe: la pagina de TikTok puede pasar SOLA a otro directo dentro
// de la misma ventana (autoplay al "siguiente LIVE" cuando termina el actual,
// o por su propia logica de feed) sin cerrar la ventana ni recargar. Antes se
// reenviaba cualquier frame de cualquier ws_proxy de la ventana: el TTS
// empezaba a leer el chat de otro streamer sin 'close' ni 'streamEnd', y el
// check_alive de la sala nueva (alive=true) mantenia contento al watchdog.
// Caso real: log de usuario 2026-09-25 01:04:00, rafaga de mensajes de
// desconocidos en el mismo ms sin ningun evento de conexion en el medio.
//
// Fuentes de room id usadas (ambas confirmadas, sin shape asumido):
// - `room_id=` en la URL del ws_proxy (ver src/ws/webcast-socket.js)
// - `common.roomId` de cada mensaje decodificado (test/decode-ws-frame.test.js)
// Se evita a proposito el room_id del JSON de check_alive/room/enter: ids de
// ~19 digitos pierden precision con JSON.parse.

/** Ids de sala en el query (`room_id=` o `room_ids=a,b`), o null si no hay. */
function urlRoomIds(url) {
  const match = /[?&]room_ids?=([^&#]+)/.exec(url || '');
  if (!match) return null;
  const ids = decodeURIComponent(match[1]).split(',').filter((id) => /^\d+$/.test(id));
  return ids.length ? ids : null;
}

function messageRoomId(msg) {
  const roomId = msg && msg.data && msg.data.common && msg.data.common.roomId;
  return roomId && String(roomId) !== '0' ? String(roomId) : null;
}

// La primera sala vista (WS o mensaje) queda fijada para toda la conexion.
// Todo lo que no trae room id pasa (fail-open, mismo comportamiento previo).
function createRoomGuard() {
  let roomId = null;
  return {
    get roomId() { return roomId; },
    /** WS nuevo de la pagina. Devuelve el id de la sala nueva si es OTRA sala, si no null. */
    onWebSocket(url) {
      const ids = urlRoomIds(url);
      const wsRoom = ids && ids[0];
      if (!wsRoom) return null;
      if (!roomId) { roomId = wsRoom; return null; }
      return wsRoom === roomId ? null : wsRoom;
    },
    acceptsMessage(msg) {
      const msgRoom = messageRoomId(msg);
      if (!msgRoom) return true;
      if (!roomId) roomId = msgRoom;
      return msgRoom === roomId;
    },
    /** Un check_alive que pregunta explicitamente por otras salas no habla de la nuestra. */
    acceptsCheckAlive(url) {
      const ids = urlRoomIds(url);
      return !roomId || !ids || ids.includes(roomId);
    },
  };
}

module.exports = { urlRoomIds, messageRoomId, createRoomGuard };
