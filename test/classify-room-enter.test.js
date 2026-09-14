'use strict';

// Pruebas deterministas del clasificador puro (sin CDP/Electron) — cubre los
// casos listados en el pedido de correccion (ver
// Docu 2/handoff-sesion-tiktok-2026-09-13.md en el repo consumidor):
// en vivo, no en vivo, body vacio, JSON invalido, status_code de error de
// TikTok (4003110, visto en produccion sin data.status), y forma inesperada.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyRoomEnterBody } = require('../src/signing/classify-room-enter');

// 1. En vivo — contra una captura REAL de room/enter (no un mock), la unica
// forma confirmada de "en vivo" en este repo (ver README#protocolo-de-red).
const liveCapture = fs.readFileSync(
  path.join(__dirname, '..', 'spike', 'captures', '1789220301790-room-enter-32836.274.bin'),
  'utf8'
);
const liveResult = classifyRoomEnterBody(liveCapture);
assert.strictEqual(liveResult.kind, 'live', 'captura real deberia clasificar como live');
assert.strictEqual(liveResult.data.status, 2);

// 2. No en vivo (status definido, distinto de 2) — sin evidencia real de este
// caso, se preserva el comportamiento historico pero marcado no confirmado.
const notLiveResult = classifyRoomEnterBody(JSON.stringify({ data: { status: 4 }, status_code: 0 }));
assert.strictEqual(notLiveResult.kind, 'not_live');
assert.strictEqual(notLiveResult.confirmed, false, 'no hay captura real que confirme un status != 2 especifico');

// 3. Body vacio — retryable en LiveWindow (EMPTY_BODY_MAX_ATTEMPTS).
const emptyResult = classifyRoomEnterBody('');
assert.deepStrictEqual(emptyResult, { kind: 'unknown', reason: 'empty_body' });

// 4. JSON invalido / truncado.
const invalidJsonResult = classifyRoomEnterBody('{"data":{"stat');
assert.strictEqual(invalidJsonResult.kind, 'unknown');
assert.strictEqual(invalidJsonResult.reason, 'invalid_json');
assert.ok(invalidJsonResult.causeMessage, 'deberia conservar el motivo del parseo');

// 5. status_code de error de TikTok sin data.status — el caso real capturado
// en la sesion de diagnostico (2026-09-14) contra un canal reportado en
// vivo. Esto NUNCA debe convertirse en "no en vivo" (era el bug real).
const statusCodeBody = JSON.stringify({ data: { prompts: '' }, extra: { now: 1789405841173 }, status_code: 4003110 });
const statusCodeResult = classifyRoomEnterBody(statusCodeBody);
assert.strictEqual(statusCodeResult.kind, 'unknown');
assert.strictEqual(statusCodeResult.reason, 'tiktok_status_code');
assert.strictEqual(statusCodeResult.tiktokStatusCode, 4003110);

// 6. Forma completamente inesperada (ni data.status ni status_code de error).
const unexpectedResult = classifyRoomEnterBody(JSON.stringify({ foo: 'bar' }));
assert.strictEqual(unexpectedResult.kind, 'unknown');
assert.strictEqual(unexpectedResult.reason, 'unexpected_shape');

// 7. status_code:0 sin data.status tampoco es un error de TikTok (0 = sin
// error) — cae en forma inesperada, no en tiktok_status_code.
const zeroStatusCodeResult = classifyRoomEnterBody(JSON.stringify({ status_code: 0 }));
assert.strictEqual(zeroStatusCodeResult.kind, 'unknown');
assert.strictEqual(zeroStatusCodeResult.reason, 'unexpected_shape');

console.log('OK — classifyRoomEnterBody: live/not_live/empty_body/invalid_json/tiktok_status_code/unexpected_shape');
