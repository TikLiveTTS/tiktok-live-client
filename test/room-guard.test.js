'use strict';

const assert = require('assert');
const { urlRoomIds, createRoomGuard } = require('../src/signing/room-guard');

const ROOM_A = '7419000000000000001';
const ROOM_B = '7419000000000000002';
const wsUrl = (room) => `wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/?aid=1988&room_id=${room}&device_id=1`;
const msg = (room) => ({ method: 'WebcastChatMessage', data: { common: { roomId: room }, comment: 'hola' } });

assert.deepStrictEqual(urlRoomIds(wsUrl(ROOM_A)), [ROOM_A]);
assert.deepStrictEqual(urlRoomIds(`https://x/check_alive/?room_ids=${ROOM_A}%2C${ROOM_B}`), [ROOM_A, ROOM_B]);
assert.strictEqual(urlRoomIds('https://x/?aid=1'), null);

// Caso real del bug: la pagina salta a otro directo (WS nuevo de otra sala).
{
  const g = createRoomGuard();
  assert.strictEqual(g.onWebSocket(wsUrl(ROOM_A)), null, 'el primer WS fija la sala');
  assert.strictEqual(g.onWebSocket(wsUrl(ROOM_A)), null, 'reconexion del WS a la MISMA sala no es cambio');
  assert.strictEqual(g.onWebSocket(wsUrl(ROOM_B)), ROOM_B, 'WS de otra sala = cambio de sala');
}

// Mismo WS reusado: los mensajes de otra sala nunca pasan.
{
  const g = createRoomGuard();
  g.onWebSocket(wsUrl(ROOM_A));
  assert.strictEqual(g.acceptsMessage(msg(ROOM_A)), true);
  assert.strictEqual(g.acceptsMessage(msg(ROOM_B)), false);
  assert.strictEqual(g.acceptsMessage({ method: 'X', data: null }), true, 'sin roomId pasa (fail-open)');
}

// Sin room_id en la URL del WS, el primer mensaje fija la sala.
{
  const g = createRoomGuard();
  assert.strictEqual(g.onWebSocket('wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/?aid=1'), null);
  assert.strictEqual(g.acceptsMessage(msg(ROOM_A)), true);
  assert.strictEqual(g.acceptsMessage(msg(ROOM_B)), false);
}

// check_alive de otra sala no cuenta como salud ni como fin de directo.
{
  const g = createRoomGuard();
  assert.strictEqual(g.acceptsCheckAlive(`https://x/check_alive/?room_ids=${ROOM_B}`), true, 'sin sala fijada todavia: comportamiento previo');
  g.onWebSocket(wsUrl(ROOM_A));
  assert.strictEqual(g.acceptsCheckAlive(`https://x/check_alive/?room_ids=${ROOM_A}`), true);
  assert.strictEqual(g.acceptsCheckAlive(`https://x/check_alive/?room_ids=${ROOM_B}`), false);
  assert.strictEqual(g.acceptsCheckAlive('https://x/check_alive/?aid=1988'), true, 'sin room_ids en la URL: comportamiento previo');
}

console.log('OK — room-guard: WS/mensajes/check_alive de otra sala detectados y filtrados');
