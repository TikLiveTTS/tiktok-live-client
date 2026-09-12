'use strict';

// Validado comparando dos usuarios reales en el mismo live/momento: el que
// SI es miembro del club de fans tiene una entrada en badges[] cuyo icono
// contiene "fans_badge_icon"; el que no, no la tiene (aunque puede tener
// otros badges, ej. de nivel). Ver webcast.proto#Badge.
function isFanClubMember(user) {
  if (!user || !Array.isArray(user.badges)) return false;
  return user.badges.some((b) => {
    const iconPath = b && b.detail && b.detail.asset && b.detail.asset.iconPath;
    return typeof iconPath === 'string' && iconPath.includes('fans_badge_icon');
  });
}

module.exports = { isFanClubMember };
