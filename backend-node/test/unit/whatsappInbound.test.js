// Step 16d: reading Meta's webhook: the signature, the verify secret, and which inbound messages count as STOP or START.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WHATSAPP_MAX_MESSAGES_PER_REQUEST, extractWhatsAppReplies, sameSecret, verifyMetaSignature } from '../../src/messaging/whatsappInbound.js';

const SECRET = 'meta-app-secret';
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const payload = (messages, phoneNumberId = '1001') => ({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, messages } }] }] });
const text = (from, body) => ({ from, id: 'wamid.1', type: 'text', text: { body } });

describe('Meta webhook signature', () => {
  const raw = Buffer.from('{"a":1}');
  it('accepts the exact bytes signed with the app secret', () => assert.equal(verifyMetaSignature(SECRET, raw, sign(raw)), true));
  it('rejects other bytes, another secret, a missing or malformed header, and no secret or body', () => {
    assert.equal(verifyMetaSignature(SECRET, Buffer.from('{"a":2}'), sign(raw)), false);
    assert.equal(verifyMetaSignature(SECRET, raw, sign(raw, 'other')), false);
    assert.equal(verifyMetaSignature(SECRET, raw, undefined), false);
    assert.equal(verifyMetaSignature(SECRET, raw, 'sha256=zz'), false);
    assert.equal(verifyMetaSignature(SECRET, raw, sign(raw).replace('sha256=', '')), false);
    assert.equal(verifyMetaSignature('', raw, sign(raw)), false);
    assert.equal(verifyMetaSignature(SECRET, undefined, sign(raw)), false);
    assert.equal(verifyMetaSignature(SECRET, '{"a":1}', sign(raw)), false);
  });
  it('compares secrets in constant time for any lengths', () => {
    assert.equal(sameSecret('token', 'token'), true);
    assert.equal(sameSecret('token', 'tokens'), false);
    assert.equal(sameSecret('token', undefined), false);
  });
});

describe('inbound WhatsApp replies', () => {
  it('reads STOP and START from text, ignoring case, spaces and punctuation at the ends, with a + added to the number', () => {
    const found = extractWhatsAppReplies(payload([text('2348000000001', 'STOP'), text('2348000000002', '  stop. '), text('2348000000003', 'Start!'), text('2348000000004', 'unsubscribe')]));
    assert.deepEqual(found, [
      { keyword: 'stop', address: '+2348000000001' }, { keyword: 'stop', address: '+2348000000002' },
      { keyword: 'start', address: '+2348000000003' }, { keyword: 'stop', address: '+2348000000004' },
    ]);
  });
  it('reads a tapped button (payload, or title) and an interactive reply', () => {
    const found = extractWhatsAppReplies(payload([
      { from: '2348000000001', type: 'button', button: { payload: 'STOP', text: 'Stop messages' } },
      { from: '2348000000002', type: 'button', button: { text: 'Stop' } },
      { from: '2348000000003', type: 'interactive', interactive: { button_reply: { id: 'x', title: 'UNSUBSCRIBE' } } },
    ]));
    assert.deepEqual(found.map((f) => f.keyword), ['stop', 'stop', 'stop']);
  });
  it('ignores a message that merely contains a keyword, other message types, and a bad number', () => {
    assert.deepEqual(extractWhatsAppReplies(payload([
      text('2348000000001', 'please stop calling me'), text('2348000000001', 'STOP ALL'), text('2348000000001', ''),
      { from: '2348000000001', type: 'image', image: { id: 'i' } }, text('12', 'STOP'), text('', 'STOP'),
    ])), []);
  });
  it('ignores delivery statuses and every malformed shape without throwing', () => {
    for (const bad of [null, undefined, 'x', 5, {}, { entry: 'x' }, { entry: [null] }, { entry: [{ changes: [{}] }] }, { entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] }, { entry: [{ changes: [{ value: { messages: 'x' } }] }] }]) {
      assert.deepEqual(extractWhatsAppReplies(bad), []);
    }
  });
  it('only reads messages sent to our own number when one is configured', () => {
    const body = payload([text('2348000000001', 'STOP')], '9999');
    assert.deepEqual(extractWhatsAppReplies(body, { phoneNumberId: '1001' }), []);
    assert.equal(extractWhatsAppReplies(body, { phoneNumberId: '9999' }).length, 1);
    assert.equal(extractWhatsAppReplies(body).length, 1);
  });
  it('reads at most 100 messages from one request', () => {
    const many = payload(Array.from({ length: 150 }, (_, i) => text(`23480000${String(i).padStart(5, '0')}`, 'STOP')));
    assert.equal(extractWhatsAppReplies(many).length, WHATSAPP_MAX_MESSAGES_PER_REQUEST);
  });
});
