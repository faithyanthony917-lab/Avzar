import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOLERANCE_MS, parseSecret, sign, verify } from '../../src/email/svix.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const SECRET = `whsec_${KEY.toString('base64')}`;
const NOW = 1_800_000_000_000;
const ts = (offsetSeconds = 0) => String(Math.floor(NOW / 1000) + offsetSeconds);
const BODY = '{"type":"email.delivered","data":{"email_id":"em_1"}}';

describe('svix secret', () => {
  it('parses whsec_ + base64 of at least 16 bytes', () => {
    assert.deepEqual(parseSecret(SECRET), KEY);
    assert.deepEqual(parseSecret(`  ${SECRET} `), KEY);
  });
  it('rejects anything else', () => {
    for (const bad of ['', null, undefined, 'abc', KEY.toString('base64'), 'whsec_', 'whsec_!!!!', `whsec_${Buffer.from('short').toString('base64')}`]) {
      assert.equal(parseSecret(bad), null, String(bad));
    }
  });
});

describe('svix verify', () => {
  const signed = (id = 'msg_1', timestamp = ts(), body = BODY) => ({ id, timestamp, header: `v1,${sign(KEY, id, timestamp, body)}`, body });
  it('accepts a valid fresh signature (string or Buffer body)', () => {
    const s = signed();
    assert.equal(verify(KEY, s.id, s.timestamp, s.header, s.body, NOW), true);
    assert.equal(verify(KEY, s.id, s.timestamp, s.header, Buffer.from(s.body), NOW), true);
  });
  it('accepts when one of several signatures is valid and ignores other versions', () => {
    const s = signed();
    assert.equal(verify(KEY, s.id, s.timestamp, `v1,AAAA v2,${sign(KEY, s.id, s.timestamp, s.body)} ${s.header}`, s.body, NOW), true);
    assert.equal(verify(KEY, s.id, s.timestamp, `v2,${sign(KEY, s.id, s.timestamp, s.body)}`, s.body, NOW), false);
  });
  it('rejects a wrong key, a tampered body, a tampered id and a malformed header', () => {
    const s = signed();
    assert.equal(verify(Buffer.from('ffffffffffffffffffffffffffffffff'), s.id, s.timestamp, s.header, s.body, NOW), false);
    assert.equal(verify(KEY, s.id, s.timestamp, s.header, `${s.body} `, NOW), false);
    assert.equal(verify(KEY, 'msg_2', s.timestamp, s.header, s.body, NOW), false);
    assert.equal(verify(KEY, s.id, s.timestamp, 'garbage', s.body, NOW), false);
    assert.equal(verify(KEY, s.id, s.timestamp, '', s.body, NOW), false);
  });
  it('rejects a stale or future timestamp (replay) and a non-numeric one', () => {
    const old = signed('msg_1', ts(-(DEFAULT_TOLERANCE_MS / 1000) - 1));
    assert.equal(verify(KEY, old.id, old.timestamp, old.header, old.body, NOW), false);
    const future = signed('msg_1', ts(DEFAULT_TOLERANCE_MS / 1000 + 1));
    assert.equal(verify(KEY, future.id, future.timestamp, future.header, future.body, NOW), false);
    const edge = signed('msg_1', ts(-(DEFAULT_TOLERANCE_MS / 1000)));
    assert.equal(verify(KEY, edge.id, edge.timestamp, edge.header, edge.body, NOW), true);
    assert.equal(verify(KEY, 'msg_1', '12abc', 'v1,AAAA', BODY, NOW), false);
    assert.equal(verify(KEY, 'msg_1', '-5', 'v1,AAAA', BODY, NOW), false);
  });
  it('rejects missing or oversize inputs', () => {
    assert.equal(verify(KEY, undefined, ts(), 'v1,AAAA', BODY, NOW), false);
    assert.equal(verify(KEY, 'm'.repeat(201), ts(), 'v1,AAAA', BODY, NOW), false);
    assert.equal(verify(KEY, 'm', ts(), `v1,${'A'.repeat(2001)}`, BODY, NOW), false);
  });
});
