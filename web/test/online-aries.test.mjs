// The lobby protocol's framing (web/server/online/aries.mjs):
//   node --test web/test/online-aries.test.mjs
// Header layout, values written as the game's own TagField encoder writes them
// (SPEED2.EXE 0x741A50: %xx for control bytes, DEL and = " : % ^, quotes
// around a value with a space), round trips through the reader, both field
// separators, messages split across and packed into stream chunks, the size
// limit, and the secrets: PASS, REGKEY and PSES are never decoded (their value
// is null), and the trace's redaction shows none of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, encodeValue, encodeFields, FrameReader, parseFields, fieldMap, redactBody, HDR, SECRET_KEYS }
  from '../server/online/aries.mjs';

test('header: kind, code, big-endian length with the NUL-terminated body', () => {
  const f = encodeFrame('auth', 0, [['NAME', 'Bob'], ['ADDR', '10.77.0.3']]);
  assert.equal(f.toString('latin1', 0, 4), 'auth');
  assert.deepEqual([...f.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(f.readUInt32BE(8), f.length);
  assert.equal(f.toString('latin1', HDR), 'NAME=Bob\nADDR=10.77.0.3\n\0');
  const e = encodeFrame('auth', 'pass', []);
  assert.equal(e.toString('latin1', 4, 8), 'pass');
  assert.equal(e.length, HDR + 1);
  assert.equal(encodeFrame('news', 'new7', 'X=1').toString('latin1', 4, 8), 'new7');
  assert.throws(() => encodeFrame('toolong', 0, []));
  assert.throws(() => encodeFields([['BAD KEY', 1]]));
});

test('values as the game writes them', () => {
  assert.equal(encodeValue('plain'), 'plain');
  assert.equal(encodeValue('two words'), '"two words"');
  assert.equal(encodeValue('a=b'), 'a%3db');
  assert.equal(encodeValue('q"u:o%t^e'), 'q%22u%3ao%25t%5ee');
  assert.equal(encodeValue('tab\there\nnl'), 'tab%09here%0anl');
  assert.equal(encodeValue('\x7f'), '%7f');
  assert.equal(encodeValue(1234), '1234');
  assert.equal(encodeValue('Ä'), '\xc4');                          // latin1 bytes >= 0x80 stay as they are
});

test('round trip through the reader, both separators, quotes, escapes', () => {
  const fields = [['NAME', 'two words'], ['TEXT', 'hi = "you": 100% ^^'], ['N', '7'], ['EMPTY', '']];
  for (const sep of ['\n', '\t']) {
    const f = encodeFrame('mesg', 0, fields, sep);
    const [m] = new FrameReader().push(f);
    assert.equal(m.kind, 'mesg'); assert.equal(m.code, '');
    assert.deepEqual(parseFields(m.body), fields);
  }
  // what the client itself sends: spaces between fields, a word without "=" skipped, text after the NUL ignored
  const body = Buffer.from('NAME=x  junk PERS="a b"\tLKEY=k\0NAME=after', 'latin1');
  assert.deepEqual(parseFields(body), [['NAME', 'x'], ['PERS', 'a b'], ['LKEY', 'k']]);
  // keys are found case-insensitively, the first one wins (as the client's own search)
  const m = fieldMap(Buffer.from('name=a\nNAME=b\n\0'));
  assert.equal(m.get('NAME'), 'a');
});

test('stream: split and packed messages, the size limit', () => {
  const a = encodeFrame('addr', 0, [['ADDR', '10.77.0.5'], ['PORT', '50000']]);
  const b = encodeFrame('skey', 0, [['SKEY', '$37940faf2a8d1381a3b7d0d2f570e6a7']]);
  const all = Buffer.concat([a, b]);
  for (let cut = 1; cut < all.length; cut += 3) {
    const r = new FrameReader();
    const got = [...r.push(all.subarray(0, cut)), ...r.push(all.subarray(cut))];
    assert.deepEqual(got.map(x => x.kind), ['addr', 'skey'], `cut at ${cut}`);
    assert.equal(r.pending, 0);
  }
  const r = new FrameReader(64);
  const big = encodeFrame('mesg', 0, [['TEXT', 'x'.repeat(100)]]);
  assert.deepEqual(r.push(big), []);
  assert.match(r.error, /at most 64/);
  assert.deepEqual(r.push(a), [], 'nothing after a bad length');
  const tiny = Buffer.alloc(12); tiny.write('xxxx'); tiny.writeUInt32BE(4, 8);
  const r2 = new FrameReader(); r2.push(tiny); assert.ok(r2.error);
});

test('secrets: never decoded, never in the trace', () => {
  const pw = 'CANARY-PASSWORD-123';
  const body = encodeFields([['NAME', 'Bob'], ['PASS', pw], ['TOS', '1'], ['REGKEY', 'ABCD-EFGH'], ['PSES', '0123abcd'],
    ['PASSWORD', 'gamepw']]) + '\0';
  const f = parseFields(Buffer.from(body, 'latin1'));
  assert.deepEqual(f.map(([k]) => k), ['NAME', 'PASS', 'TOS', 'REGKEY', 'PSES', 'PASSWORD']);
  for (const [k, v] of f) if (SECRET_KEYS.includes(k)) assert.equal(v, null, k);
  assert.equal(fieldMap(Buffer.from(body)).get('PASS'), null);
  const quoted = Buffer.from(`NAME=a PASS="${pw} x" REGKEY=${pw}\0`, 'latin1');
  assert.ok(parseFields(quoted).every(([k, v]) => k === 'NAME' || v === null));
  const line = redactBody(Buffer.from(body, 'latin1'));
  assert.ok(!line.includes(pw) && !line.includes('ABCD') && !line.includes('0123abcd') && !line.includes('gamepw'), line);
  assert.match(line, /PASS=<redacted>/); assert.match(line, /NAME="Bob"/);
});
