'use strict';

// Clasifica el body crudo de webcast/room/check_alive/, separado de
// Electron/CDP para testearlo con Node puro (ver
// test/classify-check-alive.test.js). Shape asumido `{ data: [{ alive }] }`
// (o `data` objeto) — no validado contra una captura propia, ver
// README#preguntas-abiertas.
//
// Solo un booleano explicito cuenta: `true` = TikTok confirma que el directo
// sigue (senal de salud positiva), `false` = fin de directo. Cualquier otra
// cosa es `null` (desconocido): nunca dispara streamEnd NI cuenta como salud,
// para que un cambio de shape no enmascare una conexion muerta.
function classifyCheckAliveBody(rawBody) {
  try {
    const body = JSON.parse(rawBody);
    const entry = Array.isArray(body.data) ? body.data[0] : body.data;
    if (entry && typeof entry.alive === 'boolean') return entry.alive;
  } catch (_) { /* shape inesperado */ }
  return null;
}

module.exports = { classifyCheckAliveBody };
