'use strict';

// Clasifica el body crudo de room/enter, separado de Electron/CDP a proposito
// para poder testearlo con Node puro (ver test/classify-room-enter.test.js).
//
// Unico valor de status confirmado contra captura real: 2 = en vivo (ver
// README#protocolo-de-red, spike/captures/). Un `data.status` definido pero
// distinto de 2 se reporta como "no en vivo" (mismo comportamiento historico,
// nunca causo un bug demostrado) pero con `confirmed:false` porque no hay una
// captura real de ese caso — no se presenta como certeza que no tenemos.
//
// Un body vacio, invalido, con forma inesperada, o con un status_code de
// error de TikTok (ej. 4003110, visto sin data.status) NUNCA se clasifican
// como "no en vivo": son "unknown", motivo aparte, para no repetir el bug que
// origino este archivo (ver Docu 2/handoff-sesion-tiktok-2026-09-13.md en el
// repo consumidor).
const LIVE_STATUS_VALUE = 2;

function classifyRoomEnterBody(rawBody) {
  if (!rawBody) return { kind: 'unknown', reason: 'empty_body' };

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    return { kind: 'unknown', reason: 'invalid_json', causeMessage: err.message };
  }

  const data = parsed && parsed.data;
  if (data && typeof data.status === 'number') {
    if (data.status === LIVE_STATUS_VALUE) return { kind: 'live', data };
    return { kind: 'not_live', data, confirmed: false };
  }

  if (parsed && typeof parsed.status_code === 'number' && parsed.status_code !== 0) {
    return { kind: 'unknown', reason: 'tiktok_status_code', tiktokStatusCode: parsed.status_code };
  }

  return { kind: 'unknown', reason: 'unexpected_shape' };
}

module.exports = { classifyRoomEnterBody, LIVE_STATUS_VALUE };
