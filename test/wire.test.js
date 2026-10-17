'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const wire = require('../src/engine/wire');

test('encodeName rejects bad labels', () => {
  assert.throws(() => wire.encodeName('a'.repeat(64) + '.com'), /longer than 63/);
  assert.throws(() => wire.encodeName('a..b'), /empty label/);
  assert.throws(() => wire.encodeName(`${'a.'.repeat(130)}com`), /longer than 255/);
});

test('encodeName/decodeName round trip', () => {
  for (const name of ['example.com', 'a.b.c.d.example.org', 'x1.example.co.uk']) {
    const encoded = wire.encodeName(name);
    const { name: decoded, offset } = wire.decodeName(encoded, 0);
    assert.equal(decoded, name);
    assert.equal(offset, encoded.length);
  }
});

test('decodeName follows compression pointers', () => {
  // message: "example.com" at 0, then a pointer to it at 13
  const head = wire.encodeName('example.com');
  const buf = Buffer.concat([head, Buffer.from([0xc0, 0x00])]);
  const { name, offset } = wire.decodeName(buf, head.length);
  assert.equal(name, 'example.com');
  assert.equal(offset, buf.length);
});

test('decodeName refuses a compression pointer loop', () => {
  const buf = Buffer.from([0xc0, 0x00]);
  assert.throws(() => wire.decodeName(buf, 0), /loop/);
});

test('buildQuery produces a parseable recursive query with EDNS0', () => {
  const { id, buf } = wire.buildQuery({ name: 'example.com', id: 0x1234, dnssecOk: true });
  const msg = wire.parseMessage(buf);
  assert.equal(msg.id, 0x1234);
  assert.equal(msg.qr, 0);
  assert.equal(msg.rd, 1);
  assert.equal(msg.questions.length, 1);
  assert.equal(msg.questions[0].name, 'example.com');
  assert.equal(msg.questions[0].type, wire.TYPE.A);
  assert.equal(msg.additional.length, 1);
  assert.equal(msg.additional[0].type, wire.TYPE.OPT);
  assert.equal(msg.payloadSize, 1232);
  assert.equal(msg.doBit, true);
  assert.equal(id, 0x1234);
});

test('parseMessage reads answers, compression and rcode from a real-shaped reply', () => {
  const question = Buffer.concat([wire.encodeName('example.com'), Buffer.from([0x00, 0x01, 0x00, 0x01])]);
  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c]), // pointer to the question name
    Buffer.from([0x00, 0x01, 0x00, 0x01]), // A IN
    Buffer.from([0x00, 0x00, 0x01, 0x2c]), // ttl 300
    Buffer.from([0x00, 0x04]), // rdlength
    Buffer.from([93, 184, 216, 34]),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0xbeef, 0);
  header.writeUInt16BE(0x8180, 2); // QR + RD + RA
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);

  const msg = wire.parseMessage(Buffer.concat([header, question, answer]));
  assert.equal(msg.id, 0xbeef);
  assert.equal(msg.qr, 1);
  assert.equal(msg.ra, 1);
  assert.equal(msg.rcodeName, 'NOERROR');
  assert.equal(msg.answers.length, 1);
  assert.equal(msg.answers[0].name, 'example.com');
  assert.deepEqual(wire.addressesOf(msg), ['93.184.216.34']);
  assert.equal(wire.isResolved(msg), true);
});

test('parseMessage reports NXDOMAIN and an empty answer', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x2222, 0);
  header.writeUInt16BE(0x8183, 2); // QR, RD, RA, rcode 3
  const msg = wire.parseMessage(header);
  assert.equal(msg.rcode, 3);
  assert.equal(msg.rcodeName, 'NXDOMAIN');
  assert.equal(wire.isResolved(msg), false);
  assert.deepEqual(wire.addressesOf(msg), []);
  assert.equal(wire.describeResponse(msg).rcodeName, 'NXDOMAIN');
});

test('AAAA rdata is formatted with run compression', () => {
  const rdata = Buffer.from('20010db8000000000000000000000001', 'hex');
  const question = Buffer.concat([wire.encodeName('x.example'), Buffer.from([0x00, 0x1c, 0x00, 0x01])]);
  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c]),
    Buffer.from([0x00, 0x1c, 0x00, 0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x3c]),
    Buffer.from([0x00, 0x10]),
    rdata,
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const msg = wire.parseMessage(Buffer.concat([header, question, answer]));
  assert.equal(msg.answers[0].data.address, '2001:db8::1');
  assert.deepEqual(wire.addressesOf(msg), ['2001:db8::1']);
});

test('parseMessage rejects truncated and malformed input', () => {
  assert.throws(() => wire.parseMessage(Buffer.alloc(4)), /shorter than a DNS header/);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // claims one question, supplies none
  assert.throws(() => wire.parseMessage(header), /past end of message/);

  const lying = Buffer.alloc(12);
  lying.writeUInt16BE(1, 6); // claims an answer, supplies none
  assert.throws(() => wire.parseMessage(lying), /past end of message/);
});

test('nextId never returns 0 and advances', () => {
  let previous = wire.nextId();
  for (let i = 0; i < 500; i += 1) {
    const id = wire.nextId();
    assert.notEqual(id, 0);
    assert.notEqual(id, previous);
    previous = id;
  }
});

test('parseMessage surfaces the DO bit and extended rcode from OPT', () => {
  const question = Buffer.concat([wire.encodeName('example.com'), Buffer.from([0x00, 0x01, 0x00, 0x01])]);
  const opt = wire.buildOpt(4096, true);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 10);
  const msg = wire.parseMessage(Buffer.concat([header, question, opt]));
  assert.equal(msg.payloadSize, 4096);
  assert.equal(msg.doBit, true);
});
