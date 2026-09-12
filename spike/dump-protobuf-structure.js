'use strict';

// Spike descartable: vuelca la estructura tag/wiretype de un .bin capturado
// por inspect-body.js, SIN esquema (protobuf es autodescriptivo a nivel de
// tag/wiretype, no a nivel de nombre de campo). Uso:
//   node spike/dump-protobuf-structure.js spike/captures/<archivo>.bin

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node spike/dump-protobuf-structure.js <archivo.bin>');
  process.exit(1);
}
const buf = fs.readFileSync(file);

function readVarint(b, off) {
  let result = 0n;
  let shift = 0n;
  let o = off;
  for (;;) {
    const byte = b[o++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, o];
}

function printableRatio(b) {
  if (b.length === 0) return 0;
  let printable = 0;
  for (const c of b) if (c >= 0x20 && c <= 0x7e) printable++;
  return printable / b.length;
}

function dump(b, indent, depth) {
  if (depth > 6) return;
  let off = 0;
  while (off < b.length) {
    const start = off;
    let tag;
    [tag, off] = readVarint(b, off);
    const fieldNumber = tag >> 3n;
    const wireType = Number(tag & 7n);
    const pad = '  '.repeat(indent);

    if (wireType === 0) {
      let val;
      [val, off] = readVarint(b, off);
      console.log(`${pad}field ${fieldNumber} (varint) = ${val}`);
    } else if (wireType === 1) {
      console.log(`${pad}field ${fieldNumber} (64-bit fixed)`);
      off += 8;
    } else if (wireType === 5) {
      console.log(`${pad}field ${fieldNumber} (32-bit fixed)`);
      off += 4;
    } else if (wireType === 2) {
      let len;
      [len, off] = readVarint(b, off);
      const lenNum = Number(len);
      const sub = b.subarray(off, off + lenNum);
      off += lenNum;
      const asText = printableRatio(sub) > 0.85 ? sub.toString('utf8') : null;
      if (asText && asText.length < 80) {
        console.log(`${pad}field ${fieldNumber} (bytes, len ${lenNum}) = "${asText}"`);
      } else {
        console.log(`${pad}field ${fieldNumber} (bytes, len ${lenNum}) -> intentando sub-mensaje:`);
        try {
          dump(sub, indent + 1, depth + 1);
        } catch (_) {
          console.log(`${pad}  (no parseable como sub-mensaje, primeros 24 bytes hex: ${sub.subarray(0, 24).toString('hex')})`);
        }
      }
    } else {
      console.log(`${pad}wireType desconocido ${wireType} en offset ${start}, abortando este nivel`);
      return;
    }
  }
}

console.log(`Archivo: ${file} (${buf.length} bytes)\n`);
dump(buf, 0, 0);
