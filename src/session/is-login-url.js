'use strict';

// Pura (sin Electron) para poder testearla bajo `node` plano. TikTok manda a
// /login cuando exige sesion para ver un live (ej.
// https://www.tiktok.com/login?hide_close_btn=1&is_modal=0&redirect_url=...,
// visto en produccion, GlitchTip #77). Se mira el host y el PATH, nunca un
// substring de la URL entera: `redirect_url=` de cualquier otra pagina puede
// traer "/login" encodeado y no es un pedido de login.
function isTikTokLoginUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return false;
  return parsed.pathname === '/login' || parsed.pathname.startsWith('/login/');
}

module.exports = { isTikTokLoginUrl };
