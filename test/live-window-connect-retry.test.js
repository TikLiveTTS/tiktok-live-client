'use strict';

// Prueba deterministica del loop de reintento de LiveWindow#connect(), sin
// Electron real: se reemplaza _connectOnce por un stub controlado (bajo
// `node` plano, `require('electron')` resuelve a un string, no al modulo —
// BrowserWindow/session quedan `undefined` a nivel de modulo pero eso no
// rompe nada porque connect() nunca los toca directamente, solo
// _connectOnce lo hace, y aca se reemplaza entero).
//
// Cubre el pedido: "comprobar que el reintento acotado por cuerpo vacio
// sigue funcionando correctamente" y que NINGUN otro tipo de error dispara
// un reintento general.

const assert = require('assert');
const { LiveWindow, NotLiveError, LiveStatusUnknownError, SigningError, AuthRequiredError } = require('../src/signing/live-window');

async function run() {
  // 1. Reintenta solo ante LiveStatusUnknownError('empty_body'), hasta 3
  // intentos totales, y despues propaga el error tal cual (mismo `code`,
  // mismo `reason`) — nunca lo convierte en un NotLiveError.
  {
    const win = new LiveWindow('canal_test');
    let calls = 0;
    win._connectOnce = async () => {
      calls++;
      throw new LiveStatusUnknownError('canal_test', 'empty_body');
    };
    let thrown = null;
    try {
      await win.connect();
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(calls, 3, `deberia intentar 3 veces ante body vacio persistente, intento ${calls}`);
    assert.ok(thrown instanceof LiveStatusUnknownError, 'deberia propagar LiveStatusUnknownError, no convertirlo en NotLiveError');
    assert.strictEqual(thrown.reason, 'empty_body');
    assert.strictEqual(thrown.code, 'LIVE_STATUS_UNKNOWN');
  }

  // 2. Se recupera si un reintento posterior sí trae un body valido.
  {
    const win = new LiveWindow('canal_test');
    let calls = 0;
    win._connectOnce = async () => {
      calls++;
      if (calls < 2) throw new LiveStatusUnknownError('canal_test', 'empty_body');
      return { roomInfo: { status: 2 } };
    };
    const result = await win.connect();
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.roomInfo.status, 2);
  }

  // 3. NotLiveError (no en vivo, con o sin `confirmed`) NUNCA reintenta —
  // se respeta a la primera, sin reintento general.
  {
    const win = new LiveWindow('canal_test');
    let calls = 0;
    win._connectOnce = async () => {
      calls++;
      throw new NotLiveError('canal_test', { confirmed: false });
    };
    let thrown = null;
    try {
      await win.connect();
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(calls, 1, 'NotLiveError no deberia reintentar');
    assert.ok(thrown instanceof NotLiveError);
  }

  // 4. Otros reason de LiveStatusUnknownError (invalid_json, unexpected_shape,
  // tiktok_status_code, body_fetch_failed) tampoco reintentan — "no agregar
  // reintentos generales" fuera del caso body vacio.
  for (const reason of ['invalid_json', 'unexpected_shape', 'tiktok_status_code', 'body_fetch_failed']) {
    const win = new LiveWindow('canal_test');
    let calls = 0;
    win._connectOnce = async () => {
      calls++;
      throw new LiveStatusUnknownError('canal_test', reason, { tiktokStatusCode: 4003110 });
    };
    let thrown = null;
    try {
      await win.connect();
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(calls, 1, `reason:${reason} no deberia reintentar`);
    assert.strictEqual(thrown.reason, reason);
  }

  // 5. Un SigningError (timeout / navegacion fallida) tampoco reintenta.
  {
    const win = new LiveWindow('canal_test');
    let calls = 0;
    win._connectOnce = async () => {
      calls++;
      throw new SigningError('Timeout esperando la firma');
    };
    let thrown = null;
    try {
      await win.connect();
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(calls, 1);
    assert.ok(thrown instanceof SigningError);
  }

  // 6. AuthRequiredError (TikTok redirigio a /login) tampoco reintenta —
  // reintentar no lo resuelve, hace falta que el usuario inicie sesion.
  {
    const win = new LiveWindow('canal_test');
    let calls = 0;
    win._connectOnce = async () => {
      calls++;
      throw new AuthRequiredError('canal_test');
    };
    let thrown = null;
    try {
      await win.connect();
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(calls, 1, 'AuthRequiredError no deberia reintentar');
    assert.ok(thrown instanceof AuthRequiredError);
    assert.strictEqual(thrown.code, 'AUTH_REQUIRED');
    assert.strictEqual(thrown.username, 'canal_test');
  }

  console.log('OK — LiveWindow#connect(): reintento acotado a empty_body (3 intentos), resto se respeta a la primera');
}

run().catch((err) => {
  console.error('FALLO:', err);
  process.exit(1);
});
