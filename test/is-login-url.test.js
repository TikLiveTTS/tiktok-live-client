'use strict';

// isTikTokLoginUrl decide si una navegacion del live es un pedido de login
// (AuthRequiredError) — un falso positivo pausaria la conexion de un live
// publico, un falso negativo vuelve al error generico de GlitchTip #77.

const assert = require('assert');
const { isTikTokLoginUrl } = require('../src/session/is-login-url');

// URL real vista en produccion (GlitchTip #77).
assert.strictEqual(isTikTokLoginUrl('https://www.tiktok.com/login?hide_close_btn=1&is_modal=0&redirect_url=https%3A%2F%2Fwww.tiktok.com%2F%40yxaraujo._01%2Flive'), true);
assert.strictEqual(isTikTokLoginUrl('https://www.tiktok.com/login/phone-or-email'), true);
assert.strictEqual(isTikTokLoginUrl('https://tiktok.com/login'), true);

assert.strictEqual(isTikTokLoginUrl('https://www.tiktok.com/@ana/live'), false);
assert.strictEqual(isTikTokLoginUrl('https://www.tiktok.com/@ana/live?redirect_url=%2Flogin'), false, '"/login" en la query no es un pedido de login');
assert.strictEqual(isTikTokLoginUrl('https://www.tiktok.com/@login/live'), false, 'un usuario llamado "login" no es la pagina de login');
assert.strictEqual(isTikTokLoginUrl('https://www.tiktok.com/loginx'), false);
assert.strictEqual(isTikTokLoginUrl('https://evil-tiktok.com/login'), false);
assert.strictEqual(isTikTokLoginUrl('about:blank'), false);
assert.strictEqual(isTikTokLoginUrl(undefined), false);
assert.strictEqual(isTikTokLoginUrl('no es url'), false);

console.log('OK — isTikTokLoginUrl: solo /login de tiktok.com, nunca query ni otros hosts');
