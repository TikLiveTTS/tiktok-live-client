'use strict';

// Smoke test basado en assert: corre el pipeline completo (PushFrame ->
// gunzip -> Response -> mensaje tipado) contra frames REALES capturados de
// un live en vivo (spike/captures/, ver README#hallazgos-del-spike). No es
// un mock — si el decoder rompe con el formato real de TikTok, esto falla.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decodeWsFrame } = require('../src/decode/decode-ws-frame');
const { isFanClubMember } = require('../src/decode/is-fan-club-member');

// Fixture committeada: frame 9 de una captura real (npm run spike:ws) contra
// un live activo — contiene un WebcastLikeMessage real seguido de un
// WebcastMemberMessage real. Ver README#hallazgos-del-spike.
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'ws-frame-like-member.bin'));
const decoded = decodeWsFrame(fixture);

assert.strictEqual(decoded.length, 2, `esperaba 2 mensajes en el frame, vino ${decoded.length}`);

const [likeMsg, memberMsg] = decoded;

assert.strictEqual(likeMsg.method, 'WebcastLikeMessage');
assert.ok(likeMsg.data, 'LikeMessage no decodifico data');
assert.ok(likeMsg.data.common, 'LikeMessage sin common');
assert.ok(likeMsg.data.common.roomId, 'LikeMessage.common.roomId vacio');
assert.ok(Number(likeMsg.data.count) > 0, 'LikeMessage.count deberia ser > 0');
assert.ok(likeMsg.data.user, 'LikeMessage sin user');
assert.ok(likeMsg.data.user.uniqueId, 'LikeMessage.user.uniqueId vacio');
assert.ok(likeMsg.data.user.nickname, 'LikeMessage.user.nickname vacio');

assert.strictEqual(memberMsg.method, 'WebcastMemberMessage');
assert.ok(memberMsg.data.user.uniqueId, 'MemberMessage.user.uniqueId vacio');

console.log('OK — decodeWsFrame contra captura real:');
console.log('  like:', { uniqueId: likeMsg.data.user.uniqueId, nickname: likeMsg.data.user.nickname, count: likeMsg.data.count, total: likeMsg.data.total });
console.log('  member:', { uniqueId: memberMsg.data.user.uniqueId, nickname: memberMsg.data.user.nickname });

// Fixture committeada: frame real con un WebcastChatMessage largo, en
// vietnamita, con tildes/diacriticos — confirma que el campo `comment` no
// se trunca ni corrompe con texto UTF-8 no trivial (a diferencia del primer
// fixture, que solo tenia un comentario de 5 bytes). Ver README.
const chatFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'ws-frame-chat-vietnamese.bin'));
const chatDecoded = decodeWsFrame(chatFixture);
const chatMsg = chatDecoded.find((m) => m.method === 'WebcastChatMessage');

assert.ok(chatMsg, 'no se encontro WebcastChatMessage en el fixture');
assert.strictEqual(chatMsg.data.user.uniqueId, 'k.sang.tin.thng', 'uniqueId no coincide con la captura real');
assert.strictEqual(
  chatMsg.data.comment,
  'ăn quả suốt này không thèm phở Việt ạ bà nội',
  'el comentario no coincide exacto con lo capturado — posible truncamiento/corrupcion de UTF-8'
);

console.log('  chat:', { uniqueId: chatMsg.data.user.uniqueId, comment: chatMsg.data.comment });

// Fixtures de gift reales: 2 regalos de precio distinto (Rose=1 diamante,
// Heart Me=4), enviados por la misma cuenta de prueba. Confirman
// giftId/name/diamondCount — ver README para el detalle de como se aislo
// diamondCount comparando precios conocidos.
for (const [file, expected] of [
  ['ws-frame-gift-rose.bin', { giftId: '5655', name: 'Rose', diamondCount: '1' }],
  ['ws-frame-gift-heartme.bin', { giftId: '7934', name: 'Heart Me', diamondCount: '4' }],
]) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', file));
  const giftMsg = decodeWsFrame(buf).find((m) => m.method === 'WebcastGiftMessage');
  assert.ok(giftMsg, `no se encontro WebcastGiftMessage en ${file}`);
  assert.strictEqual(giftMsg.data.giftId, expected.giftId, `${file}: giftId no coincide`);
  assert.strictEqual(giftMsg.data.gift.name, expected.name, `${file}: gift.name no coincide`);
  assert.strictEqual(giftMsg.data.gift.diamondCount, expected.diamondCount, `${file}: gift.diamondCount no coincide`);
  assert.ok(giftMsg.data.user.uniqueId, `${file}: sin user.uniqueId`);
  console.log(`  gift (${file}):`, { name: giftMsg.data.gift.name, diamondCount: giftMsg.data.gift.diamondCount, uniqueId: giftMsg.data.user.uniqueId });
}

// Fixtures de follow y share: mismo tipo de mensaje (WebcastSocialMessage),
// distinguidos por el `kind` derivado del key interno del toast.
for (const [file, expectedKind] of [
  ['ws-frame-social-follow.bin', 'follow'],
  ['ws-frame-social-share.bin', 'share'],
]) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', file));
  const socialMsg = decodeWsFrame(buf).find((m) => m.method === 'WebcastSocialMessage');
  assert.ok(socialMsg, `no se encontro WebcastSocialMessage en ${file}`);
  assert.strictEqual(socialMsg.data.kind, expectedKind, `${file}: kind no coincide`);
  assert.ok(socialMsg.data.user.uniqueId, `${file}: sin user.uniqueId`);
  console.log(`  social (${file}):`, { kind: socialMsg.data.kind, uniqueId: socialMsg.data.user.uniqueId });
}

// Fixtures de club de fans: mismo live, mismo momento — un mensaje de un
// usuario que ES miembro del club de fans y otro de uno que NO lo es.
// Confirma isFanClubMember() contra ambos casos reales, no solo el positivo.
for (const [file, expected] of [
  ['ws-frame-chat-fan.bin', { uniqueId: 'lu15.le0n', isFan: true }],
  ['ws-frame-chat-nonfan.bin', { uniqueId: 'ikhunsa_tiklivetts', isFan: false }],
]) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', file));
  const msg = decodeWsFrame(buf).find((m) => m.method === 'WebcastChatMessage');
  assert.ok(msg, `no se encontro WebcastChatMessage en ${file}`);
  assert.strictEqual(msg.data.user.uniqueId, expected.uniqueId, `${file}: uniqueId no coincide`);
  assert.strictEqual(isFanClubMember(msg.data.user), expected.isFan, `${file}: isFanClubMember no coincide`);
  console.log(`  fanClub (${file}):`, { uniqueId: msg.data.user.uniqueId, isFan: isFanClubMember(msg.data.user) });
}

// Fixture de viewer count: coincide exacto con "Viewers · 2" visto en pantalla
// al momento de la captura.
const seqBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'ws-frame-roomuserseq.bin'));
const seqMsg = decodeWsFrame(seqBuf).find((m) => m.method === 'WebcastRoomUserSeqMessage');
assert.ok(seqMsg, 'no se encontro WebcastRoomUserSeqMessage en el fixture');
assert.strictEqual(seqMsg.data.viewerCount, '2', 'viewerCount no coincide con lo visto en pantalla');
console.log('  viewerCount:', seqMsg.data.viewerCount);
