'use strict';

// Clasificador puro de check_alive (sin CDP/Electron): solo un booleano
// explicito cuenta; todo lo demas es null (ni streamEnd ni senal de salud).

const assert = require('assert');
const { classifyCheckAliveBody } = require('../src/signing/classify-check-alive');

assert.strictEqual(classifyCheckAliveBody('{"data":[{"alive":true,"room_id":1}]}'), true);
assert.strictEqual(classifyCheckAliveBody('{"data":{"alive":true}}'), true);
assert.strictEqual(classifyCheckAliveBody('{"data":[{"alive":false}]}'), false);
assert.strictEqual(classifyCheckAliveBody(''), null);
assert.strictEqual(classifyCheckAliveBody('no-json'), null);
assert.strictEqual(classifyCheckAliveBody('{"data":[]}'), null);
assert.strictEqual(classifyCheckAliveBody('{"data":[{"alive":1}]}'), null);
assert.strictEqual(classifyCheckAliveBody('null'), null);

console.log('classify-check-alive: OK');
